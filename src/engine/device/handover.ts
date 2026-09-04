/**
 * The handover: the leaver keeps the machine and our agents come off it.
 *
 * This is the only disposition that deletes anything, so the order is fixed and
 * it is the reverse of what the automation this was ported from did:
 *
 *   1. uninstall the agents on the machine,
 *   2. read the receipt back from the result DETAIL endpoint,
 *   3. confirm the machine has actually gone quiet,
 *   4. and only then delete the provider record.
 *
 * The ancestor of this code deleted the record after a blind two-minute sleep,
 * with no evidence the uninstall had happened. Twice that left a machine in
 * somebody's hands still shipping telemetry, with no command channel left to
 * stop it, and the only remaining remedy was dropping its data at the
 * collector. Anything short of a complete receipt plus a quiet machine
 * therefore leaves the device enrolled, deletes nothing, and tells a person.
 *
 * Two smaller rules, both scar tissue. A result row existing means the machine
 * COLLECTED the command; only an exit code together with a response time means
 * it finished, and a collected install that never returned once read as a
 * success for a week. And the receipt must account for every agent in config:
 * a receipt that names none of them is not a pass, it is an unanswered
 * question.
 */

import type { JmlConfig } from '../../config/schema.ts'
import type { BoundDevice } from '../../core/types.ts'
import { failed, verified as verifiedOutcome } from '../../core/result.ts'
import { AssociationLeak, CommandRefused } from '../../connectors/jumpcloud/commands.ts'
import type { CommandReceipt } from '../../connectors/types.ts'
import {
  CANARY_RUNBOOK,
  DeviceScriptError,
  describe,
  loadScriptManifest,
  loadScriptTemplate,
  type DeviceDeps,
  type DevicePreflight,
  type DispositionRequest,
  type ScriptManifest,
  type StepContext,
  type TriggerOs,
} from './preflight.ts'

export type AgentState = 'yes' | 'no' | 'absent'

/** The fixed receipt protocol. The last line of the script output. */
export const RECEIPT_PREFIX = 'AGENTS_REMOVED'

export interface AgentsReceipt {
  /** The line the states were read from, for the audit detail. */
  line: string | null
  agents: Record<string, AgentState>
  /** True only when every configured agent is accounted for as gone or absent. */
  complete: boolean
  /** Configured agents the receipt did not mention at all. */
  missing: string[]
  /** Agents the receipt says are still installed. */
  remaining: string[]
  /** Tokens that were not `name=yes|no|absent`. */
  invalid: string[]
}

export interface HandoverResult {
  receipt: CommandReceipt | null
  agents: AgentsReceipt | null
  recordDeleted: boolean
  /** True for anything short of a proven removal. The safe direction. */
  leftEnrolled: boolean
}

/**
 * Read the agent states out of the script output.
 *
 * The LAST matching line wins, because a script may echo progress before its
 * receipt and an earlier line could be a partial state. Anything that is not
 * `name=yes|no|absent` is recorded as invalid and never read as a pass: a
 * malformed receipt is an unknown, and an unknown must not delete a record.
 */
export function parseAgentsReceipt(output: string | null, expected: readonly string[]): AgentsReceipt {
  const agents: Record<string, AgentState> = {}
  const invalid: string[] = []
  let line: string | null = null

  for (const raw of (output ?? '').split(/\r?\n/)) {
    const text = raw.trim()
    if (text.startsWith(RECEIPT_PREFIX + ' ')) line = text
  }

  if (line) {
    for (const token of line.slice(RECEIPT_PREFIX.length).trim().split(/\s+/)) {
      if (token === '') continue
      const at = token.lastIndexOf('=')
      const name = at > 0 ? token.slice(0, at) : ''
      const state = at > 0 ? token.slice(at + 1).toLowerCase() : ''
      if (!name || (state !== 'yes' && state !== 'no' && state !== 'absent')) {
        invalid.push(token)
        continue
      }
      agents[name] = state
    }
  }

  const missing = expected.filter((name) => agents[name] === undefined)
  const remaining = expected.filter((name) => agents[name] === 'no')
  // An empty expectation cannot be satisfied by an empty receipt: with no
  // agents configured there is nothing to prove, so this is never complete.
  const complete = expected.length > 0 && missing.length === 0 && remaining.length === 0 && invalid.length === 0
  return { line, agents, complete, missing, remaining, invalid }
}

export interface QuietResult {
  quiet: boolean
  detail: string
  observedFor: number
}

/**
 * Confirm the machine has stopped talking to the provider.
 *
 * An uninstalled agent stops updating the last-contact time, so silence for a
 * few minutes is the one piece of evidence available that does not come from
 * the script that claims to have done the work. Every failure direction here
 * reports "not quiet": an unreadable device, a record that vanished mid-check,
 * or contact after the uninstall all leave the machine enrolled rather than
 * letting a deletion through on a partial read.
 */
export async function confirmAgentQuiet(
  deps: DeviceDeps,
  systemId: string,
  opts: { quietMinutes: number; pollMs: number },
): Promise<QuietResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const windowMs = opts.quietMinutes * 60_000
  const startedAt = deps.clock.now().getTime()

  let baseline: BoundDevice | null
  try {
    baseline = await deps.devices.getDevice(systemId)
  } catch (err) {
    return { quiet: false, detail: 'the device could not be read: ' + describe(err), observedFor: 0 }
  }
  if (!baseline) {
    return { quiet: false, detail: 'the device record was already gone before the quiet check', observedFor: 0 }
  }
  const was = baseline.lastContact

  for (;;) {
    const elapsed = deps.clock.now().getTime() - startedAt
    if (elapsed >= windowMs) {
      return {
        quiet: true,
        detail: 'last contact was unchanged for ' + opts.quietMinutes + ' minute(s) after the uninstall',
        observedFor: elapsed,
      }
    }
    await sleep(Math.min(opts.pollMs, windowMs - elapsed))
    let now: BoundDevice | null
    try {
      now = await deps.devices.getDevice(systemId)
    } catch (err) {
      return {
        quiet: false,
        detail: 'the device could not be re-read during the quiet check: ' + describe(err),
        observedFor: deps.clock.now().getTime() - startedAt,
      }
    }
    if (!now) {
      return {
        quiet: false,
        detail: 'the device record disappeared during the quiet check, so the removal is unproven',
        observedFor: deps.clock.now().getTime() - startedAt,
      }
    }
    if (now.lastContact !== was) {
      return {
        quiet: false,
        detail: 'the machine contacted the provider again after the uninstall, so an agent is still running',
        observedFor: deps.clock.now().getTime() - startedAt,
      }
    }
  }
}

/**
 * Run the handover.
 *
 * Returns rather than throws on every failure, because the caller has a report
 * to finish and a person to tell. The one thing this function will not do is
 * reach the delete without both a complete receipt and a quiet machine.
 */
export async function handover(
  deps: DeviceDeps,
  req: DispositionRequest,
  plan: DevicePreflight,
  ctx: StepContext,
): Promise<HandoverResult> {
  const cfg = deps.config
  const command = plan.command
  if (!command) {
    ctx.record('uninstall', 'no uninstall command was resolved for ' + plan.displayName, {
      state: 'failed',
      verified: false,
      attempts: 0,
      error: 'a handover needs an uninstall command; see ' + CANARY_RUNBOOK,
    })
    return { receipt: null, agents: null, recordDeleted: false, leftEnrolled: true }
  }

  // Held on an object rather than in a plain local: the assignment happens
  // inside the step callback, and a local would still read as null to the
  // compiler afterwards.
  const box: { receipt: CommandReceipt | null } = { receipt: null }
  const label =
    'fire ' + command.name + ' on ' + plan.displayName + ' by attaching one association and detaching it afterwards'

  const fired = await ctx.run(
    'uninstall',
    'device.uninstallAgents',
    label,
    async () => {
      try {
        box.receipt = await deps.commands.runOnOneDevice({
          commandId: command.id,
          systemId: plan.systemId,
          holdMs: cfg.devices.receipt.holdMs,
          timeoutMs: cfg.devices.receipt.timeoutMs,
        })
      } catch (err) {
        if (err instanceof AssociationLeak) {
          // Surfaced as a warning on the receipt rather than swallowed: a
          // command left attached to a machine is a standing hazard that
          // outlives this run, and the next unrelated firing hits that device.
          ctx.warnings.push(
            'the uninstall command may still be attached to ' +
              plan.displayName +
              '; detach it before anything else fires that command: ' +
              err.message,
          )
          return failed('the association could not be proven detached: ' + err.message, { retryable: false })
        }
        if (err instanceof CommandRefused) {
          return failed('the command was refused before firing: ' + err.refusal, { retryable: false })
        }
        return failed('the uninstall could not be run: ' + describe(err), { retryable: true })
      }
      const got = box.receipt
      for (const warning of got.warnings ?? []) ctx.warnings.push(warning)
      if (!got.received) {
        return failed('no result arrived inside the timeout, which is never a success', { retryable: true })
      }
      if (!got.completed) {
        return failed(
          'the machine collected the command and did not finish it: a result row is collection, not execution',
          { retryable: true },
        )
      }
      return verifiedOutcome({ exitCode: got.exitCode })
    },
    { commandId: command.id },
  )

  const settled = box.receipt
  if (!fired.ok || !fired.verified || !settled) {
    return { receipt: settled, agents: null, recordDeleted: false, leftEnrolled: true }
  }

  const agents = parseAgentsReceipt(settled.output, plan.agentsExpected)
  await ctx.run(
    'receipt',
    'device.readReceipt',
    'account for every configured agent on ' + plan.displayName,
    async () =>
      agents.complete
        ? verifiedOutcome({ agents: agents.agents })
        : failed(receiptShortfall(agents), { retryable: false, detail: { agents: agents.agents } }),
    { expected: plan.agentsExpected },
  )
  if (!agents.complete) {
    return { receipt: settled, agents, recordDeleted: false, leftEnrolled: true }
  }

  const quiet = await confirmAgentQuiet(deps, plan.systemId, {
    quietMinutes: cfg.devices.agentQuietMinutes,
    pollMs: cfg.devices.receipt.pollMs,
  })
  ctx.record('agent_quiet', 'watch ' + plan.displayName + ' for silence before deleting its record', {
    state: quiet.quiet ? 'done' : 'failed',
    verified: quiet.quiet,
    attempts: 1,
    at: deps.clock.nowIso(),
    ...(quiet.quiet ? {} : { error: quiet.detail }),
  })
  if (!quiet.quiet) {
    return { receipt: settled, agents, recordDeleted: false, leftEnrolled: true }
  }

  const deleted = await ctx.run(
    'delete_record',
    'device.deleteDevice',
    'delete the provider record for ' + plan.displayName + ', which also destroys any escrowed recovery key',
    () => deps.devices.deleteDevice(plan.systemId),
    { acknowledgedFdeKeyLoss: req.acknowledgeFdeKeyLoss === true },
  )
  const recordDeleted = deleted.ok && deleted.verified
  return { receipt: settled, agents, recordDeleted, leftEnrolled: !recordDeleted }
}

function receiptShortfall(agents: AgentsReceipt): string {
  const parts: string[] = []
  if (!agents.line) parts.push('the script printed no ' + RECEIPT_PREFIX + ' line')
  if (agents.missing.length > 0) parts.push('not accounted for: ' + agents.missing.join(', '))
  if (agents.remaining.length > 0) parts.push('still installed: ' + agents.remaining.join(', '))
  if (agents.invalid.length > 0) parts.push(agents.invalid.length + ' unreadable token(s) in the receipt')
  return 'the removal receipt is incomplete, so nothing was deleted (' + parts.join('; ') + ')'
}

/** Where the removal command for the agent itself is filled in during a canary. */
export interface SelfUninstall {
  command: string
  args: string[]
  /** The delay that keeps the uninstall from killing its own runner. */
  delaySeconds: number
}

export interface RenderedScript {
  os: TriggerOs
  file: string
  body: string
  provenOnHardware: boolean
}

/**
 * Fill a shipped script template in from config.
 *
 * The scripts carry no product names of their own. Every service, uninstall
 * display name, launchd label and path comes from config.devices.agents, so an
 * adopter changes what is removed by editing YAML rather than by editing
 * PowerShell. The ancestor of these scripts matched product names with a bare
 * substring regular expression, which matched an unrelated product, so the
 * rendered names are compared exactly by the scripts themselves.
 */
export function renderUninstallScript(opts: {
  os: TriggerOs
  agents: JmlConfig['devices']['agents']
  selfUninstall?: SelfUninstall | null
  manifest?: ScriptManifest
}): RenderedScript {
  const manifest = opts.manifest ?? loadScriptManifest()
  const entry = manifest.scripts.find((s) => s.os === opts.os)
  if (!entry) throw new DeviceScriptError('no uninstall script ships for ' + opts.os)
  for (const agent of opts.agents) checkReceiptName(agent.name)

  const template = loadScriptTemplate(entry.file)
  const body =
    opts.os === 'windows'
      ? template
          .replace('__AGENTS_JSON__', windowsAgentsJson(opts.agents))
          .replace('__SELF_UNINSTALL_JSON__', selfUninstallJson(opts.selfUninstall ?? null))
      : template
          .replace('__AGENT_SPEC__', darwinAgentSpec(opts.agents))
          .replace('__SELF_UNINSTALL_SPEC__', selfUninstallSpec(opts.selfUninstall ?? null))

  if (body.includes('__AGENTS_JSON__') || body.includes('__AGENT_SPEC__')) {
    // The substitution failing silently would ship a script that removes
    // nothing and reports it, which is the shape of failure this whole package
    // exists to avoid.
    throw new DeviceScriptError('the ' + opts.os + ' script still contains a placeholder after rendering')
  }
  return { os: opts.os, file: entry.file, body, provenOnHardware: entry.provenOnHardware }
}

/**
 * The receipt is a whitespace-separated list of `name=state`, so a name
 * carrying a space or an equals sign would make it unparseable and the
 * handover would refuse to delete anything for a reason nobody could see.
 */
function checkReceiptName(name: string): void {
  if (name === '' || /[\s=|]/.test(name)) {
    throw new DeviceScriptError(
      'the agent name ' + JSON.stringify(name) + ' cannot appear in a receipt: no spaces, equals signs or bars',
    )
  }
}

function windowsAgentsJson(agents: JmlConfig['devices']['agents']): string {
  const shaped = agents.map((agent) => ({
    name: agent.name,
    services: agent.windows.services,
    uninstallDisplayNames: agent.windows.uninstallDisplayNames,
    paths: agent.windows.paths,
  }))
  const json = JSON.stringify(shaped, null, 2)
  // The template embeds this in a single-quoted here-string, whose terminator
  // is a newline followed by '@.
  if (/\n'@/.test(json)) throw new DeviceScriptError('agent configuration would terminate the script here-string')
  return json
}

function selfUninstallJson(self: SelfUninstall | null): string {
  if (!self) return JSON.stringify({ enabled: false }, null, 2)
  return JSON.stringify(
    { enabled: true, command: self.command, args: self.args, delaySeconds: self.delaySeconds },
    null,
    2,
  )
}

/**
 * The macOS spec is bar-separated records rather than JSON.
 *
 * A shell script cannot parse JSON without a tool that may not be installed,
 * and a handover script that depends on one fails on exactly the machine
 * nobody can reach. Records are read with the shell's own field splitting.
 */
function darwinAgentSpec(agents: JmlConfig['devices']['agents']): string {
  const lines: string[] = []
  for (const agent of agents) {
    lines.push('agent|' + agent.name)
    for (const value of agent.darwin.launchdLabels) lines.push('label|' + checkRecordValue(value))
    for (const value of agent.darwin.paths) lines.push('path|' + checkRecordValue(value))
  }
  return lines.join('\n')
}

function selfUninstallSpec(self: SelfUninstall | null): string {
  if (!self) return 'enabled|no'
  const lines = ['enabled|yes', 'command|' + checkRecordValue(self.command), 'delay|' + String(self.delaySeconds)]
  for (const arg of self.args) lines.push('arg|' + checkRecordValue(arg))
  return lines.join('\n')
}

function checkRecordValue(value: string): string {
  if (value.includes('|') || /[\r\n]/.test(value)) {
    throw new DeviceScriptError('a device path or label may not contain a bar or a newline: ' + JSON.stringify(value))
  }
  return value
}
