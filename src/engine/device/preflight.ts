/**
 * The read-only plan for one device, and the vocabulary the rest of this
 * package shares.
 *
 * Phase 1 blocks the day-7 deletion while a leaver still holds a machine, so it
 * has to ship the ways that block is cleared. There are four, and only three of
 * them clear anything: a device can be handed back to a spares account, given
 * to somebody else, handed over to the leaver with our agents removed, or
 * simply kept by them and left unmanaged. The last one clears nothing on
 * purpose. Deleting the provider record while the agents are still installed
 * removes the machine from our view and not from the network: it really
 * happened, and the laptop went on reporting telemetry for weeks with no
 * command channel left to reach it and its escrowed disk-encryption key gone
 * with the record.
 *
 * Everything in this file is a read. Nothing here attaches, fires or deletes.
 * That is deliberate: the plan is exactly what a dry run prints, so an operator
 * sees the refusals and the association that would be created before anything
 * can happen, rather than afterwards in a report.
 *
 * Every refusal below aborts before a single write. A refusal that could not be
 * evaluated, because a provider read failed, is also a refusal: an unreadable
 * answer is not an absence of danger, and the ancestor of this code treated a
 * failed device read as "no devices" and deleted the account.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JmlConfig } from '../../config/schema.ts'
import type { Clock } from '../../core/clock.ts'
import type { Logger } from '../../core/logger.ts'
import type { Actor, BoundDevice, LegRecord, Outcome } from '../../core/types.ts'
import type { AuditSink } from '../../audit/types.ts'
import type { Notifier } from '../../notify/types.ts'
import type { PeopleStore } from '../../store/types.ts'
import type { CommandTargeting, DeviceConnector, IdentityConnector } from '../../connectors/types.ts'
import { GateError } from '../../connectors/types.ts'
import { DuplicateTrigger } from '../../connectors/jumpcloud/commands.ts'
import { planOwnerBinding, planRebindTarget } from './unbind.ts'

/** What is being done with the machine. */
export type DeviceDisposition = 'return_to_pool' | 'reassign' | 'handover' | 'retain_unmanaged'

/** The dispositions that write to the identity provider at all. */
export const WRITING_DISPOSITIONS: readonly DeviceDisposition[] = ['return_to_pool', 'reassign', 'handover']

/** The trigger names in config are keyed by the provider's own OS words. */
export type TriggerOs = 'windows' | 'darwin' | 'linux'

export type DeviceRefusalCode =
  | 'device_not_found'
  | 'provider_unreadable'
  | 'os_unsupported'
  | 'no_uninstall_trigger'
  | 'command_not_found'
  | 'duplicate_command_trigger'
  | 'group_bound'
  | 'collateral_associations'
  | 'not_a_trigger'
  | 'command_refused'
  | 'no_agents_configured'
  | 'owner_unknown'
  | 'owner_mismatch'
  | 'ambiguous_owner'
  | 'no_rebind_target'
  | 'fde_acknowledgement_required'
  | 'unproven_script_needs_canary'
  | 'canary_is_the_target'

export interface DeviceRefusal {
  code: DeviceRefusalCode
  /** Written for the person reading it, and it names the way out. */
  detail: string
}

/** The named steps a disposition can take. Reported whether they ran or not. */
export type DeviceStepName =
  | 'preflight'
  | 'unbind'
  | 'rebind'
  | 'uninstall'
  | 'receipt'
  | 'agent_quiet'
  | 'delete_record'
  | 'report'

export interface DeviceStep {
  step: DeviceStepName
  /** Names the exact machine and, for a write, the exact association. */
  label: string
  leg: LegRecord
}

/**
 * How a step records itself.
 *
 * Passed in rather than imported, so the unbind and handover halves cannot
 * write an audit row without the orchestrator's run id and actor, and so a
 * test can watch the exact order of the rows. `run` appends the intent row
 * BEFORE the call and the outcome row after it: a single row written afterwards
 * cannot describe the case that matters most, which is a call that was made and
 * whose result was never learnt.
 */
export interface StepContext {
  run(
    step: DeviceStepName,
    action: string,
    label: string,
    call: () => Promise<Outcome>,
    detail?: Record<string, unknown>,
  ): Promise<Outcome>
  /** Record a step that deliberately did not call a provider. */
  record(step: DeviceStepName, label: string, leg: LegRecord): void
  steps: DeviceStep[]
  warnings: string[]
}

/** Read a person's own record. Only ever used to resolve an expected owner. */
export type PeopleReader = Pick<PeopleStore, 'get'>

/**
 * The provider surface this package needs.
 *
 * `listDeviceOwners` is not on the shared DeviceConnector port yet, so it is
 * required structurally here: asking who is bound to one machine is the only
 * way to tell custody from access granted through a group, and every refusal
 * about ownership depends on it.
 */
export interface DeviceOwnerReader {
  listDeviceOwners(systemId: string): Promise<string[]>
}

export type DeviceOps = DeviceConnector & DeviceOwnerReader

export interface DeviceDeps {
  config: JmlConfig
  devices: DeviceOps
  commands: CommandTargeting
  /** Resolves a spares or new-owner address to a provider account. */
  identity?: Pick<IdentityConnector, 'findUser'>
  people?: PeopleReader
  clock: Clock
  audit: AuditSink
  notifier?: Notifier
  logger?: Logger
  /** Injected so the agent-quiet window does not make a test wait ten minutes. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so a test exercises provenance rules without editing the shipped manifest. */
  scriptManifest?: ScriptManifest
}

export interface DispositionRequest {
  systemId: string
  disposition: DeviceDisposition
  actor: Actor
  runId: string
  /**
   * Defaults to TRUE everywhere. Every destructive device path in the estate
   * this was ported from that shipped dry-run first had no regressions, and
   * every one that did not had several on its first live day.
   */
  dryRun?: boolean
  /** Refuse if the machine is not bound to this person. */
  expectedOwnerHrisId?: string
  /** The binding to remove, when the caller already knows the provider id. */
  leaverUserId?: string
  rebindToUserId?: string
  rebindToEmail?: string
  /** Required for a handover: deleting the record destroys the escrowed key. */
  acknowledgeFdeKeyLoss?: boolean
  /** The machine the adopter proved the script on. Required to execute an unproven script. */
  canariedSystemId?: string
  note?: string
}

export interface DevicePreflight {
  systemId: string
  device: BoundDevice | null
  /** Never a bare id: these messages are read by somebody holding a laptop. */
  displayName: string
  osFamily: BoundDevice['osFamily']
  triggerOs: TriggerOs | null
  /** Direct bindings only. Group-derived access is not custody. */
  directOwnerIds: string[]
  /** The single binding this run would remove, or null when there is none. */
  unbindUserId: string | null
  /** The account this run would bind, for a pool return or a reassignment. */
  rebindUserId: string | null
  rebindLabel: string | null
  lastContactAgeMin: number | null
  fdeKeyPresent: boolean | null
  command: { id: string; name: string; launchType: string } | null
  /** The receipt keys the script must report back, from config.devices.agents. */
  agentsExpected: string[]
  /** Null when no script is involved in this disposition. */
  scriptProvenOnHardware: boolean | null
  warnings: string[]
  refusals: DeviceRefusal[]
  /** True when nothing will be written, whatever the caller asked for. */
  dryRun: boolean
  /** Set when config has not armed this action, which forces the dry run. */
  notArmedReason: string | null
}

export interface ScriptEntry {
  os: TriggerOs
  file: string
  receiptProtocol: string
  provenOnHardware: boolean
  canaryRunbook: string
}

export interface ScriptManifest {
  version: number
  provenOnHardware: boolean
  scripts: ScriptEntry[]
}

export class DeviceScriptError extends Error {
  readonly code = 'device_script_unavailable'
}

export const CANARY_RUNBOOK = 'docs/runbooks/canary-a-device-script.md'

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'scripts')
let manifestCache: ScriptManifest | null = null

/**
 * Read the script manifest that ships beside this module.
 *
 * The manifest is the single record of whether a script has ever been run on
 * real hardware. It says no, because in the automation this was ported from
 * these scripts were written, deployed as commands, and never executed on a
 * machine: the service names, uninstall strings and launchd labels in them are
 * inferred. Claiming otherwise anywhere would be the one defect this package
 * cannot afford.
 */
export function loadScriptManifest(): ScriptManifest {
  if (manifestCache) return manifestCache
  let text: string
  try {
    text = readFileSync(join(SCRIPTS_DIR, 'manifest.json'), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DeviceScriptError(
      'the device script manifest could not be read (' +
        message +
        '); a published build must copy src/engine/device/scripts into dist',
    )
  }
  manifestCache = JSON.parse(text) as ScriptManifest
  return manifestCache
}

export function scriptsDirectory(): string {
  return SCRIPTS_DIR
}

/** Read one shipped script template. */
export function loadScriptTemplate(file: string): string {
  try {
    return readFileSync(join(SCRIPTS_DIR, file), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DeviceScriptError('the device script ' + file + ' could not be read: ' + message)
  }
}

export function triggerOsOf(osFamily: BoundDevice['osFamily']): TriggerOs | null {
  if (osFamily === 'windows') return 'windows'
  if (osFamily === 'macos') return 'darwin'
  if (osFamily === 'linux') return 'linux'
  // Deliberately closed. Folding an unrecognised family into a default is how
  // a Windows uninstaller was once sent to a machine running Linux.
  return null
}

/**
 * Work out whether anything may really be written.
 *
 * Three independent brakes, and the loosest wins: the caller's own flag, the
 * global mode, and whether this particular action is armed. An action absent
 * from armedActions is planned and reported rather than run, so arming happens
 * one action at a time.
 */
export function resolveDryRun(
  config: JmlConfig,
  disposition: DeviceDisposition,
  requested: boolean | undefined,
): { dryRun: boolean; notArmedReason: string | null } {
  if (disposition === 'retain_unmanaged') {
    return { dryRun: true, notArmedReason: null }
  }
  const action = disposition === 'handover' ? 'device_handover' : 'device_unbind'
  const armed = config.mode === 'armed' && config.armedActions.includes(action)
  const notArmedReason = armed
    ? null
    : config.mode === 'armed'
      ? 'armedActions does not list ' + action
      : 'config.mode is ' + config.mode
  // requested defaults to true: a caller that forgot to say plans instead.
  return { dryRun: requested !== false || !armed, notArmedReason }
}

/**
 * Everything that can be known without touching the machine.
 *
 * This is the whole of the safety story. `refusals` being non-empty means the
 * caller fires nothing at all, so the order of the reads below only affects how
 * much is reported, never whether the run is safe.
 */
export async function planDeviceDisposition(
  deps: DeviceDeps,
  req: DispositionRequest,
): Promise<DevicePreflight> {
  const cfg = deps.config
  const { dryRun, notArmedReason } = resolveDryRun(cfg, req.disposition, req.dryRun)
  const warnings: string[] = []
  const refusals: DeviceRefusal[] = []

  const plan: DevicePreflight = {
    systemId: req.systemId,
    device: null,
    displayName: req.systemId,
    osFamily: 'unknown',
    triggerOs: null,
    directOwnerIds: [],
    unbindUserId: null,
    rebindUserId: null,
    rebindLabel: null,
    lastContactAgeMin: null,
    fdeKeyPresent: null,
    command: null,
    agentsExpected: cfg.devices.agents.map((a) => a.name),
    scriptProvenOnHardware: null,
    warnings,
    refusals,
    dryRun,
    notArmedReason,
  }

  let device: BoundDevice | null
  try {
    device = await deps.devices.getDevice(req.systemId)
  } catch (err) {
    refusals.push({ code: 'provider_unreadable', detail: 'the device could not be read: ' + describe(err) })
    return plan
  }
  if (!device) {
    refusals.push({
      code: 'device_not_found',
      detail: 'no device with that id, so there is nothing to dispose of and nothing to clear the gate on',
    })
    return plan
  }

  plan.device = device
  plan.displayName = device.displayName ?? device.serial ?? device.id
  plan.osFamily = device.osFamily
  plan.triggerOs = triggerOsOf(device.osFamily)
  plan.fdeKeyPresent = device.fdeKeyPresent
  plan.lastContactAgeMin = contactAgeMinutes(device.lastContact, deps.clock)

  if (device.lastContact === null) {
    warnings.push('the provider has never recorded contact with this machine, so a command may not run today')
  } else if (plan.lastContactAgeMin === null) {
    warnings.push('the provider reported a last-contact time that could not be read as a date')
  } else if (plan.lastContactAgeMin > cfg.devices.staleContactWarnMin) {
    warnings.push(
      'last contact was ' +
        plan.lastContactAgeMin +
        ' minutes ago, over the ' +
        cfg.devices.staleContactWarnMin +
        '-minute warning threshold, so a command may not run today',
    )
  }

  try {
    plan.directOwnerIds = await deps.devices.listDeviceOwners(req.systemId)
  } catch (err) {
    refusals.push({
      code: 'provider_unreadable',
      detail: 'the direct bindings on this machine could not be read: ' + describe(err),
    })
    return plan
  }
  if (plan.directOwnerIds.length > 1) {
    warnings.push(plan.directOwnerIds.length + ' people are bound directly to this machine')
  }

  await planOwnerBinding(deps, req, plan)
  await planRebindTarget(deps, req, plan)

  if (req.disposition === 'handover') {
    await planHandover(deps, req, plan)
  }

  return plan
}

/**
 * The handover refusals.
 *
 * A handover is the only disposition that deletes anything, and it is the one
 * that has never been proven on hardware, so it collects the most refusals: no
 * trigger configured for this operating system, no agents configured to prove
 * removal against, an unacknowledged disk-encryption key, an unproven script
 * with no canary, and every command-level refusal the connector already knows.
 */
async function planHandover(deps: DeviceDeps, req: DispositionRequest, plan: DevicePreflight): Promise<void> {
  const cfg = deps.config

  if (plan.fdeKeyPresent !== false && req.acknowledgeFdeKeyLoss !== true) {
    plan.refusals.push({
      code: 'fde_acknowledgement_required',
      detail:
        plan.fdeKeyPresent === true
          ? 'the provider holds this machine disk-encryption recovery key and deleting the record destroys it; re-run with the acknowledgement'
          : 'the provider did not say whether it holds this machine recovery key, so the acknowledgement is required before the record is deleted',
    })
  }

  if (plan.agentsExpected.length === 0) {
    // With no agents configured the receipt has nothing to prove, and a
    // vacuously complete receipt would let the record be deleted on hope.
    plan.refusals.push({
      code: 'no_agents_configured',
      detail: 'config.devices.agents is empty, so no receipt could prove the agents are gone',
    })
  }

  const triggerOs = plan.triggerOs
  if (!triggerOs) {
    plan.refusals.push({
      code: 'os_unsupported',
      detail: 'this machine operating system was reported as ' + plan.osFamily + ', which has no handover path',
    })
    return
  }

  const manifest = deps.scriptManifest ?? loadScriptManifest()
  const entry = manifest.scripts.find((s) => s.os === triggerOs) ?? null
  plan.scriptProvenOnHardware = entry ? entry.provenOnHardware : null
  if (entry && !entry.provenOnHardware) {
    plan.warnings.push(
      'the shipped ' + triggerOs + ' uninstall script has never been run on real hardware; see ' + CANARY_RUNBOOK,
    )
    if (!plan.dryRun && !req.canariedSystemId) {
      plan.refusals.push({
        code: 'unproven_script_needs_canary',
        detail:
          'the ' +
          triggerOs +
          ' script is marked provenOnHardware: false, so executing it needs the id of the machine you canaried it on; see ' +
          CANARY_RUNBOOK,
      })
    } else if (!plan.dryRun && req.canariedSystemId === req.systemId) {
      // Naming the target as its own canary cannot be true: the claim is that
      // the script already ran somewhere and was checked, and this machine has
      // not run it yet. The check exists less for the operator typing it by
      // hand than for an automation template that maps both fields from the
      // same expression, which satisfies a presence test silently and fires an
      // unproven uninstaller.
      plan.refusals.push({
        code: 'canary_is_the_target',
        detail:
          'the machine named as the canary is the machine this run would act on, so nothing has been proven yet; ' +
          'canary the script on a different machine first, then name that one. See ' +
          CANARY_RUNBOOK,
      })
    }
  }

  const trigger = cfg.devices.uninstallTriggers[triggerOs]
  if (!trigger) {
    // The default is null for every platform on purpose: nobody should inherit
    // a fleet-wide uninstaller they did not create and prove themselves.
    plan.refusals.push({
      code: 'no_uninstall_trigger',
      detail:
        'no uninstall command is configured for ' +
        triggerOs +
        '; create one and canary it on your own hardware first, then set devices.uninstallTriggers.' +
        triggerOs +
        '. See ' +
        CANARY_RUNBOOK,
    })
    return
  }

  let command: { id: string; name: string; launchType: string } | null
  try {
    command = await deps.commands.resolveCommand(trigger)
  } catch (err) {
    if (err instanceof DuplicateTrigger) {
      plan.refusals.push({
        code: 'duplicate_command_trigger',
        detail: 'more than one command answers to that trigger name, and one of them could be the wrong script',
      })
      return
    }
    plan.refusals.push({ code: 'provider_unreadable', detail: 'the command could not be resolved: ' + describe(err) })
    return
  }
  if (!command) {
    plan.refusals.push({
      code: 'command_not_found',
      detail: 'no command answers to the configured trigger name for ' + triggerOs,
    })
    return
  }
  plan.command = command

  try {
    const check = await deps.commands.preflightCommand(command.id)
    if (!check.ok) {
      plan.refusals.push({ code: commandRefusalCode(check.refusal), detail: check.detail ?? 'the command was refused' })
    }
  } catch (err) {
    plan.refusals.push({
      code: 'provider_unreadable',
      detail: 'the command bindings could not be read, so the blast radius is unknown: ' + describe(err),
    })
  }
}

function commandRefusalCode(refusal: string | undefined): DeviceRefusalCode {
  if (refusal === 'group_bound') return 'group_bound'
  if (refusal === 'collateral_associations') return 'collateral_associations'
  if (refusal === 'not_a_trigger') return 'not_a_trigger'
  if (refusal === 'command_not_found') return 'command_not_found'
  return 'command_refused'
}

export function contactAgeMinutes(lastContact: string | null, clock: Clock): number | null {
  if (!lastContact) return null
  const at = Date.parse(lastContact)
  if (Number.isNaN(at)) return null
  return Math.floor((clock.now().getTime() - at) / 60_000)
}

export function describe(err: unknown): string {
  if (err instanceof GateError) return err.message
  if (err instanceof Error) return err.message
  return 'an unreadable error'
}
