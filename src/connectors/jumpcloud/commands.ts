/**
 * Running a script on exactly one machine.
 *
 * This is the most dangerous code in the toolkit, and all of it is scar tissue.
 * The provider's trigger endpoint fires the command on EVERY association the
 * command currently holds, and it IGNORES any list of targets in the request
 * body. Sending `{ systems: [...] }` is accepted, answers 200, and does
 * nothing to narrow the blast radius: that is why targeting by request body
 * was a silent no-op for months while the logs said the pushes had landed.
 *
 * So "run this on one device" is really a sequence, and every step is there
 * because skipping it caused an incident:
 *
 *  1. Refuse a command bound to a device group. A trigger fires on every
 *     member, so a group-attached uninstaller strips the whole fleet. One
 *     seven-device push produced fourteen results this way.
 *  2. Refuse a command that already holds associations belonging to somebody
 *     else. Firing would run the script on their machine as collateral, and on
 *     an uninstaller that is not a warning, it is an outage.
 *  3. Refuse a command whose launch type is not a trigger. It cannot be fired,
 *     and the endpoint reports success anyway.
 *  4. Attach the one device, then READ THE ATTACHMENT BACK. A 200 is not an
 *     effect.
 *  5. Fire, then hold the attachment for the configured time. Detaching
 *     immediately loses the work for a machine that was not connected at that
 *     instant, which is how pushes reported as delivered were never run.
 *  6. Detach in a `finally`, then assert the association count is back to
 *     zero. A thrown read-back or a timeout between attach and detach once
 *     left an uninstaller bound to somebody's laptop, and it took collateral
 *     runs daily for over a week before anyone noticed.
 *
 * This file never issues PUT /api/commands. A partial write to a command
 * definition answers 200 and resets every field it did not carry to a default,
 * which quietly changes the command's type and launch mode and disarms it.
 */

import { GateError, type CommandReceipt, type CommandTargeting } from '../types.ts'
import { isRetryableStatus, preview, type JumpCloudClient } from './client.ts'

/** The empirically established minimum attach time. Below this, work is lost. */
export const RECOMMENDED_HOLD_MS = 120_000

/**
 * How far before our own firing time a result row may sit and still count.
 *
 * Deliberately small. Provider and caller clocks drift by seconds, so a strict
 * comparison drops a genuine receipt; a generous window instead inherits the
 * receipt of an earlier run on the same machine and reports old work as new.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5_000

/**
 * Two commands answer to the same trigger name.
 *
 * A separate error rather than the shared AmbiguousMatch, whose match list is
 * shaped for accounts. Firing on a guess is not an option here: one of the two
 * could be an uninstaller.
 */
export class DuplicateTrigger extends Error {
  readonly code = 'duplicate_command_trigger'
  readonly trigger: string
  readonly matches: { id: string; name: string }[]
  constructor(trigger: string, matches: { id: string; name: string }[]) {
    super(`more than one command carries the trigger name provided`)
    this.trigger = trigger
    this.matches = matches
  }
}

/** A refusal before anything was fired. Nothing has been attached. */
export class CommandRefused extends Error {
  readonly code = 'command_refused'
  readonly refusal: string
  readonly detail?: string
  constructor(refusal: string, message: string, detail?: string) {
    super(message)
    this.refusal = refusal
    this.detail = detail
  }
}

/**
 * The association could not be proved detached.
 *
 * Thrown rather than returned, and thrown even when the run itself succeeded,
 * because a command left attached to a machine is a standing hazard that
 * outlives this run: anything that fires the command later hits that device.
 * Losing the receipt is the lesser harm.
 */
export class AssociationLeak extends Error {
  readonly code = 'association_leak'
  readonly commandId: string
  readonly systemId: string
  constructor(message: string, commandId: string, systemId: string) {
    super(message)
    this.commandId = commandId
    this.systemId = systemId
  }
}

export interface JumpCloudCommand {
  id: string
  name: string
  launchType: string
  /** The name the trigger endpoint is addressed by. Null means unfireable. */
  trigger: string | null
  commandType: string | null
}

export interface JumpCloudCommandsOptions {
  client: JumpCloudClient
  /** Injected so a test does not wait two minutes for a hold. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  /** Called the moment a leak is detected, so it is reported even on a throw. */
  onLeak?: (leak: { commandId: string; systemId: string; reason: string }) => void
}

export class JumpCloudCommands implements CommandTargeting {
  private readonly client: JumpCloudClient
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly pollMs: number
  private readonly onLeak: JumpCloudCommandsOptions['onLeak']

  constructor(opts: JumpCloudCommandsOptions) {
    this.client = opts.client
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = opts.now ?? (() => Date.now())
    this.pollMs = opts.pollMs ?? 15_000
    this.onLeak = opts.onLeak
  }

  /**
   * Find the command an adopter named in their config.
   *
   * Two commands sharing a trigger name is ambiguous rather than a matter of
   * preference: the wrong one could be an uninstaller. It throws.
   */
  async resolveCommand(trigger: string): Promise<JumpCloudCommand | null> {
    const rows = await this.client.listV1('/commands')
    const matches = rows.map(toCommand).filter((c): c is JumpCloudCommand => c !== null && c.trigger === trigger)
    const distinct = new Map(matches.map((c) => [c.id, c]))
    if (distinct.size > 1) {
      throw new DuplicateTrigger(
        trigger,
        [...distinct.values()].map((c) => ({ id: c.id, name: c.name })),
      )
    }
    const [only] = distinct.values()
    return only ?? null
  }

  /** Every refusal, evaluated read-only. This is what a dry run prints. */
  async preflightCommand(commandId: string): Promise<{ ok: boolean; refusal?: string; detail?: string }> {
    const command = await this.readCommand(commandId)
    if (!command) {
      return { ok: false, refusal: 'command_not_found', detail: 'no command with that id' }
    }
    const refusal = await this.refusalFor(command)
    return refusal ? { ok: false, ...refusal } : { ok: true }
  }

  async runOnOneDevice(opts: {
    commandId: string
    systemId: string
    holdMs: number
    timeoutMs: number
  }): Promise<CommandReceipt> {
    const command = await this.readCommand(opts.commandId)
    if (!command) {
      throw new CommandRefused('command_not_found', 'no command with that id')
    }
    const refusal = await this.refusalFor(command)
    if (refusal) {
      throw new CommandRefused(refusal.refusal, `refusing to fire ${command.name}: ${refusal.refusal}`, refusal.detail)
    }
    const triggerName = command.trigger
    if (!triggerName) {
      throw new CommandRefused('no_trigger_name', 'the command has no trigger name, so it cannot be fired')
    }

    await this.attach(opts.commandId, opts.systemId)

    // From here the association exists, so every exit path must go through the
    // detach below. Nothing between these lines may return early.
    let leak: string | null = null
    let receipt: CommandReceipt = { completed: false, exitCode: null, output: null, received: false }
    try {
      const attached = await this.attachedSystemIds(opts.commandId)
      if (!attached.includes(opts.systemId)) {
        throw new GateError('the association was accepted and did not persist, so nothing was fired')
      }
      const firedAt = this.now()
      await this.fire(triggerName)
      receipt = await this.awaitReceipt({
        commandId: opts.commandId,
        systemId: opts.systemId,
        firedAt,
        holdMs: opts.holdMs,
        timeoutMs: opts.timeoutMs,
      })
    } finally {
      leak = await this.detach(opts.commandId, opts.systemId)
      if (leak) {
        // Reported here rather than after the try, so the leak is still
        // announced when the work above threw.
        this.onLeak?.({ commandId: opts.commandId, systemId: opts.systemId, reason: leak })
      }
    }

    if (leak) {
      throw new AssociationLeak(
        `the command is still attached after the run: ${leak}`,
        opts.commandId,
        opts.systemId,
      )
    }
    return receipt
  }

  /** Read one command definition. Absent is null; an unreadable answer throws. */
  async readCommand(commandId: string): Promise<JumpCloudCommand | null> {
    const res = await this.client.call('GET', `/commands/${encodeURIComponent(commandId)}`)
    if (res.status === 404) return null
    if (res.status < 200 || res.status >= 300) {
      throw new GateError(`reading the command answered ${res.status}: ${preview(res)}`)
    }
    return toCommand(res.json())
  }

  /**
   * The refusals, in the order that keeps the cheapest read first.
   *
   * A read that fails throws rather than returning ok, because a refusal we
   * could not evaluate is not an absence of danger.
   */
  private async refusalFor(command: JumpCloudCommand): Promise<{ refusal: string; detail: string } | null> {
    if (command.launchType !== 'trigger') {
      return {
        refusal: 'not_a_trigger',
        detail: `launch type is ${command.launchType || 'unset'}, so the trigger endpoint cannot reach it`,
      }
    }

    const groups = await this.associations(command.id, 'system_group')
    if (groups.length > 0) {
      return {
        refusal: 'group_bound',
        detail: `the command is bound to ${groups.length} device group(s); a trigger fires on every member`,
      }
    }

    const systems = await this.associations(command.id, 'system')
    if (systems.length > 0) {
      return {
        refusal: 'collateral_associations',
        detail: `the command already holds ${systems.length} device association(s) that this run did not create`,
      }
    }
    return null
  }

  private async attach(commandId: string, systemId: string): Promise<void> {
    const res = await this.client.call('POST', `/v2/commands/${encodeURIComponent(commandId)}/associations`, {
      body: { op: 'add', type: 'system', id: systemId },
    })
    if (res.status < 200 || res.status >= 300) {
      throw new GateError(`attaching the device answered ${res.status}: ${preview(res)}`)
    }
  }

  /**
   * Fire the command.
   *
   * The body is empty on purpose. A `systems` array here is ignored by the
   * provider, so including one would suggest a targeting that does not exist.
   * The only success signal is a non-empty `triggered` list: the endpoint
   * answers 200 for a command it could not dispatch.
   */
  private async fire(triggerName: string): Promise<void> {
    const res = await this.client.call('POST', `/command/trigger/${encodeURIComponent(triggerName)}`, {
      body: {},
      // Never retried: a repeat runs the script on the machine a second time,
      // which is not a harmless duplicate on an uninstaller.
      repeatable: false,
    })
    if (res.status < 200 || res.status >= 300) {
      throw new GateError(`the trigger answered ${res.status}: ${preview(res)}`)
    }
    const triggered = res.json<{ triggered?: unknown }>()?.triggered
    if (!Array.isArray(triggered) || triggered.length === 0) {
      throw new GateError('the trigger answered 200 and dispatched nothing')
    }
  }

  /**
   * Detach, then prove it. Returns a reason when the machine may still be
   * attached, and never throws: it runs in a `finally`.
   */
  private async detach(commandId: string, systemId: string): Promise<string | null> {
    try {
      const res = await this.client.call('POST', `/v2/commands/${encodeURIComponent(commandId)}/associations`, {
        body: { op: 'remove', type: 'system', id: systemId },
      })
      if (res.status < 200 || res.status >= 300) {
        return `the detach answered ${res.status}${isRetryableStatus(res.status) ? ' (retryable)' : ''}`
      }
      const attached = await this.attachedSystemIds(commandId)
      if (attached.includes(systemId)) return 'the device is still listed as attached'
      if (attached.length > 0) {
        return `${attached.length} other association(s) appeared during the run`
      }
      return null
    } catch (err) {
      return `the detach could not be confirmed: ${err instanceof Error ? err.message : 'unreadable error'}`
    }
  }

  private async attachedSystemIds(commandId: string): Promise<string[]> {
    const rows = await this.associations(commandId, 'system')
    const ids: string[] = []
    for (const row of rows) {
      const id = associationTargetId(row)
      if (id) ids.push(id)
    }
    return ids
  }

  private async associations(commandId: string, targets: 'system' | 'system_group'): Promise<unknown[]> {
    try {
      return await this.client.listV2(`/v2/commands/${encodeURIComponent(commandId)}/associations`, { targets })
    } catch (err) {
      throw new GateError(
        `the command's ${targets} associations could not be read: ${
          err instanceof Error ? err.message : 'unreadable error'
        }`,
      )
    }
  }

  /**
   * Wait for a receipt, holding the attachment for at least the configured time.
   *
   * The hold is a minimum attach duration rather than a delay before polling:
   * a machine that is asleep when the trigger fires picks the command up when
   * it wakes, and detaching before then throws the work away.
   */
  private async awaitReceipt(opts: {
    commandId: string
    systemId: string
    firedAt: number
    holdMs: number
    timeoutMs: number
  }): Promise<CommandReceipt> {
    let receipt: CommandReceipt = { completed: false, exitCode: null, output: null, received: false }

    for (;;) {
      const found = await this.findReceipt(opts.commandId, opts.systemId, opts.firedAt)
      if (found) receipt = found
      if (receipt.completed) break
      const elapsed = this.now() - opts.firedAt
      if (elapsed >= opts.timeoutMs) break
      await this.sleep(Math.min(this.pollMs, Math.max(opts.timeoutMs - elapsed, 0)))
    }

    const held = this.now() - opts.firedAt
    if (held < opts.holdMs) await this.sleep(opts.holdMs - held)
    return receipt
  }

  /**
   * Find this run's result row and read it from the detail endpoint.
   *
   * Three parts of the match are all necessary. The command id, because a
   * result payload from an unrelated command on the same machine was once
   * reported as this run's success. The system id, because the newest row wins
   * otherwise. And a time at or after firing, because the same command may
   * have run on this machine before.
   *
   * The detail endpoint is not an optimisation: the list endpoint truncates
   * output, and has reported a zero exit code for a row whose detail said the
   * exit code was null.
   */
  private async findReceipt(commandId: string, systemId: string, firedAt: number): Promise<CommandReceipt | null> {
    const res = await this.client.call('GET', '/commandresults', {
      query: { sort: '-requestTime', limit: 50 },
    })
    if (res.status < 200 || res.status >= 300) {
      throw new GateError(`polling for a command result answered ${res.status}`)
    }
    const rows = resultRows(res.json())
    const floor = firedAt - CLOCK_SKEW_TOLERANCE_MS

    for (const row of rows) {
      if (str(row['workflowId']) !== commandId) continue
      if (str(row['systemId']) !== systemId) continue
      const requestTime = time(row['requestTime'])
      if (requestTime === null || requestTime < floor) continue
      const id = str(row['_id']) ?? str(row['id'])
      if (!id) continue
      return this.readReceiptDetail(id)
    }
    return null
  }

  private async readReceiptDetail(resultId: string): Promise<CommandReceipt> {
    const res = await this.client.call('GET', `/commandresults/${encodeURIComponent(resultId)}`)
    if (res.status < 200 || res.status >= 300) {
      throw new GateError(`reading the command result answered ${res.status}`)
    }
    const body = (res.json<Record<string, unknown>>() ?? {}) as Record<string, unknown>
    const response = (body['response'] ?? {}) as Record<string, unknown>
    const data = (response['data'] ?? {}) as Record<string, unknown>
    const exitCode = typeof data['exitCode'] === 'number' ? data['exitCode'] : null
    const output = typeof data['output'] === 'string' ? data['output'] : null
    const responseTime = time(body['responseTime'])

    return {
      received: true,
      // A row existing means the machine collected the command. It says
      // nothing about the script finishing: a collected install that never
      // returned read as a success for a week. Both fields must be present.
      completed: exitCode !== null && responseTime !== null,
      exitCode,
      output,
    }
  }
}

/** Map a command definition onto the shape this connector reasons about. */
export function toCommand(raw: unknown): JumpCloudCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = str(record['_id']) ?? str(record['id'])
  if (!id) return null
  return {
    id,
    name: str(record['name']) ?? id,
    launchType: str(record['launchType']) ?? '',
    trigger: str(record['trigger']),
    commandType: str(record['commandType']),
  }
}

/** The associated object's id, which this endpoint nests under `to`. */
function associationTargetId(element: unknown): string | null {
  if (!element || typeof element !== 'object') return null
  const record = element as Record<string, unknown>
  const to = record['to']
  if (to && typeof to === 'object') {
    const nested = str((to as Record<string, unknown>)['id']) ?? str((to as Record<string, unknown>)['_id'])
    if (nested) return nested
  }
  return str(record['id']) ?? str(record['_id'])
}

function resultRows(body: unknown): Record<string, unknown>[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['results'])
      ? ((body as { results: unknown[] }).results)
      : []
  return raw.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function time(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}
