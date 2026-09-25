/**
 * `jml leaver ...`: one person at a time, and the human controls.
 *
 * The four write commands here are the manual overrides, and they exist
 * because the engine refuses to guess. When it parks a row, nothing else in
 * the toolkit will touch that person until somebody decides, so there has to
 * be a way for a person to decide, and it has to be recorded.
 *
 *   hold       freeze this row against everything, including the HR sync
 *   release    clear the freeze and the parked reason
 *   ack        record that a human agrees the deletion may proceed
 *   tombstone  close the row by hand, without any account work
 *
 * Every one of them writes an audit pair naming the person who asked. A hold
 * with no reason and no author is the thing somebody finds in six months and
 * cannot act on, so the reason is required rather than optional.
 */

import { leaveDateOf, leaveDateSource } from '../../hris/leave-date.ts'
import type { AuditEvent, AuditSink } from '../../audit/types.ts'
import type { Actor, Person } from '../../core/types.ts'
import { runLeaverEngine } from '../../engine/leaver/engine.ts'
import type { LeaverDeps } from '../../engine/leaver/legs.ts'
import type { PeopleStore } from '../../store/types.ts'
import type { Clock } from '../../core/clock.ts'
import { renderRunReport } from './render.ts'
import { CliError, openRuntime, type CliIo, type Runtime } from './context.ts'
import { actorFor } from './run.ts'

export interface MarkDeps {
  store: PeopleStore
  audit: AuditSink
  clock: Clock
}

export interface MarkRequest {
  hrisId: string
  actor: Actor
  reason?: string
  note?: string
}

async function load(deps: MarkDeps, hrisId: string): Promise<Person> {
  const person = await deps.store.get(hrisId)
  if (!person) {
    throw new CliError(`no person with HR id ${hrisId}. Names are not ids: use the id the HR system owns.`, {
      exitCode: 2,
      docsAnchor: 'docs/runbooks/hold-and-release.md',
    })
  }
  return person
}

/**
 * Record a human decision as an intent and an outcome.
 *
 * The same two-row discipline as a provider call, for the same reason: the row
 * that matters is the one describing a change somebody started. A single row
 * written afterwards cannot describe a write that failed halfway.
 */
async function recorded(
  deps: MarkDeps,
  action: string,
  req: MarkRequest,
  detail: Record<string, unknown>,
  write: () => Promise<Person>,
): Promise<Person> {
  const base: Omit<AuditEvent, 'phase'> = {
    at: deps.clock.nowIso(),
    runId: 'cli-' + action + '-' + req.hrisId,
    actor: req.actor,
    action,
    subject: { kind: 'person', id: req.hrisId },
    dryRun: false,
    detail,
  }
  await deps.audit.append({ ...base, phase: 'intent' })
  try {
    const person = await write()
    await deps.audit.append({ ...base, phase: 'outcome', at: deps.clock.nowIso(), ok: true, verified: true })
    return person
  } catch (err) {
    await deps.audit.append({
      ...base,
      phase: 'outcome',
      at: deps.clock.nowIso(),
      ok: false,
      verified: false,
      detail: { ...detail, error: err instanceof Error ? err.message : String(err) },
    })
    throw err
  }
}

export async function holdPerson(deps: MarkDeps, req: MarkRequest): Promise<Person> {
  const reason = req.reason?.trim()
  if (!reason) throw new CliError('a hold needs a reason: whoever finds this row later has only that to go on', { exitCode: 2 })
  await load(deps, req.hrisId)
  return recorded(deps, 'human.hold', req, { reason }, () =>
    deps.store.patch(req.hrisId, { hold: true, holdReason: reason }),
  )
}

/**
 * Clear the freeze and the parked reason together.
 *
 * They are cleared in one write on purpose. Clearing the hold and leaving the
 * parked reason gives a row that looks released and is still excluded from
 * every selection, which is indistinguishable from the automation being
 * broken.
 */
export async function releasePerson(deps: MarkDeps, req: MarkRequest): Promise<Person> {
  const person = await load(deps, req.hrisId)
  const detail = { previousReviewReason: person.reviewReason ?? null, note: req.note ?? null }
  return recorded(deps, 'human.release', req, detail, () =>
    deps.store.patch(req.hrisId, {
      hold: false,
      holdReason: null,
      reviewReason: null,
      ...(req.note ? { note: req.note } : {}),
    }),
  )
}

/**
 * Record that a person agrees the deletion may go ahead.
 *
 * The acknowledgement is written into the offboarding record with the name of
 * whoever gave it. The existing record is carried through rather than
 * replaced, including the day-0 marker: dropping that marker would make an
 * already-suspended person selectable for day 0 again.
 */
export async function ackPerson(deps: MarkDeps, req: MarkRequest): Promise<Person> {
  const person = await load(deps, req.hrisId)
  const at = deps.clock.nowIso()
  const offboarding = person.offboarding ?? { suspendedAt: null, legs: {} }
  return recorded(deps, 'human.delete_ack', req, { note: req.note ?? null }, () =>
    deps.store.patch(req.hrisId, {
      offboarding: {
        ...offboarding,
        operatorAck: { by: req.actor.id, at, ...(req.note ? { note: req.note } : {}) },
      },
    }),
  )
}

/**
 * Close a row by hand.
 *
 * This is the answer to a historic leaver whose accounts were dealt with years
 * ago: it moves the row to the terminal state so no automation will ever
 * select it, and it touches no account. It goes through `transition()`, so the
 * table and the compare-and-set both apply and a row in the wrong state is
 * refused rather than forced.
 */
export async function tombstonePerson(deps: MarkDeps, req: MarkRequest): Promise<Person> {
  const reason = req.reason?.trim()
  if (!reason) throw new CliError('a tombstone needs a reason: it is a permanent decision about a person', { exitCode: 2 })
  const person = await load(deps, req.hrisId)
  const at = deps.clock.nowIso()
  return recorded(deps, 'human.tombstone', req, { reason, from: person.status }, async () => {
    const result = await deps.store.transition({
      hrisId: req.hrisId,
      expectFrom: person.status,
      event: 'human.tombstone',
      owner: 'human',
      reason,
      patch: {
        note: reason,
        offboarding: { ...(person.offboarding ?? { suspendedAt: null, legs: {} }), departedAt: at.slice(0, 10) },
      },
    })
    if (!result.ok) {
      throw new CliError(
        `refused: ${result.reason} A row that is already departed cannot be closed again, and one the engine ` +
          `is part-way through has to finish or be released first.`,
        { exitCode: 1, docsAnchor: 'docs/state-machine.md' },
      )
    }
    return result.person
  })
}

export function leaverDeps(rt: Runtime): LeaverDeps {
  if (!rt.providers) throw new Error('the leaver engine needs the provider connectors')
  return {
    cfg: rt.cfg,
    store: rt.store,
    state: rt.state,
    idp: rt.providers.idp,
    devices: rt.providers.devices,
    google: rt.providers.google,
    notifier: rt.notifier,
    audit: rt.audit,
    clock: rt.clock,
    logger: rt.logger,
    domain: rt.domain,
  }
}

/**
 * Who to record for a manual override.
 *
 * These four commands can only be run by a person typing them, so the actor is
 * a human by definition and the only question is what to call them. `--actor`
 * is the honest answer; the local account name is the fallback, because an
 * audit row that says only "the command line" cannot be followed up.
 */
export function markActor(opts: { actor?: string }, io: CliIo): Actor {
  const named = opts.actor?.trim()
  if (named) return { kind: 'human', id: named }
  const account = io.env.SUDO_USER ?? io.env.USER ?? io.env.LOGNAME ?? io.env.USERNAME
  return { kind: 'human', id: 'cli:' + (account && account.trim() !== '' ? account : 'unknown') }
}

export interface LeaverCommandOptions {
  configPath?: string
  action: 'run' | 'dry-run' | 'show' | 'hold' | 'release' | 'ack' | 'tombstone'
  hrisId?: string
  email?: string
  reason?: string
  note?: string
  actor?: string
  armed?: boolean
  json?: boolean
}

export async function leaverCommand(io: CliIo, opts: LeaverCommandOptions): Promise<number> {
  const needsProviders = opts.action === 'run' || opts.action === 'dry-run'
  const rt = await openRuntime({
    io,
    withProviders: needsProviders,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  })
  try {
    if (opts.action === 'run' || opts.action === 'dry-run') {
      const only = opts.hrisId || opts.email ? { ...(opts.hrisId ? { hrisId: opts.hrisId } : {}), ...(opts.email ? { email: opts.email } : {}) } : undefined
      const report = await runLeaverEngine(leaverDeps(rt), {
        dryRun: opts.action === 'dry-run' || opts.armed !== true,
        actor: actorFor(opts),
        runId: 'cli-leaver-' + rt.clock.nowIso(),
        ...(only ? { only } : {}),
      })
      io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderRunReport(report) + '\n')
      return report.ok ? 0 : 1
    }

    const marks: MarkDeps = { store: rt.store, audit: rt.audit, clock: rt.clock }
    const hrisId = await resolveId(rt, opts)
    const req: MarkRequest = {
      hrisId,
      actor: markActor(opts, io),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    }

    const person =
      opts.action === 'show'
        ? await load(marks, hrisId)
        : opts.action === 'hold'
          ? await holdPerson(marks, req)
          : opts.action === 'release'
            ? await releasePerson(marks, req)
            : opts.action === 'ack'
              ? await ackPerson(marks, req)
              : await tombstonePerson(marks, req)

    io.out(opts.json ? JSON.stringify(person, null, 2) + '\n' : renderPerson(person) + '\n')
    return 0
  } finally {
    await rt.close()
  }
}

/**
 * Find the row from whatever the caller had to hand.
 *
 * An address that matches more than one row is refused rather than resolved to
 * the first match. Taking the first result of an address lookup is how a write
 * once landed on a different person with a similar name.
 */
async function resolveId(rt: Runtime, opts: LeaverCommandOptions): Promise<string> {
  if (opts.hrisId) return opts.hrisId
  const email = opts.email?.trim().toLowerCase()
  if (!email) throw new CliError('name the person with --hris-id or --email', { exitCode: 2 })
  const matches = await rt.store.findByEmail(email)
  if (matches.length === 0) throw new CliError(`no row holds the address ${email}`, { exitCode: 2 })
  if (matches.length > 1) {
    throw new CliError(
      `${matches.length} rows hold the address ${email}: ${matches.map((p) => p.hrisId).join(', ')}. ` +
        `Name one with --hris-id.`,
      { exitCode: 2 },
    )
  }
  return (matches[0] as Person).hrisId
}

export function renderPerson(person: Person): string {
  const offboarding = person.offboarding
  const lines = [
    '',
    person.displayName + '  (' + person.hrisId + ')',
    '  status          ' + person.status,
    '  address         ' + person.primaryEmail,
    '  also known as   ' + (person.aliasEmails.length > 0 ? person.aliasEmails.join(', ') : 'nothing else recorded'),
    '  manager         ' + (person.managerEmail ?? 'none recorded'),
    '  leaving date    ' + (leaveDateOf(person) ?? 'none') + leaveDateNote(person),
    '  hold            ' + (person.hold ? 'YES: ' + (person.holdReason ?? 'no reason recorded') : 'no'),
    '  parked          ' + (person.reviewReason ?? 'no'),
    '  google account  ' +
      (person.googleAccountPresent === null || person.googleAccountPresent === undefined
        ? 'not read yet'
        : person.googleAccountPresent
          ? 'present'
          : 'absent'),
    '  provider ids    ' +
      (Object.entries(person.externalIds ?? {})
        .filter(([, id]) => typeof id === 'string' && id !== '')
        .map(([provider, id]) => provider + '=' + String(id))
        .join(' ') || 'none'),
  ]
  if (offboarding) {
    lines.push('  suspended at    ' + (offboarding.suspendedAt ?? 'not yet'))
    lines.push('  transferred     ' + (offboarding.transferredAt ?? 'not yet'))
    if (offboarding.deleteBlockedReason) lines.push('  deletion        BLOCKED: ' + offboarding.deleteBlockedReason)
    if (offboarding.operatorAck) {
      lines.push('  acknowledged    ' + offboarding.operatorAck.by + ' at ' + offboarding.operatorAck.at)
    }
    for (const [name, leg] of Object.entries(offboarding.legs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(
        '  leg ' +
          name.padEnd(15) +
          leg.state +
          (leg.verified ? ' (verified)' : '') +
          ' attempts=' +
          leg.attempts +
          (leg.error ? ' error=' + leg.error : ''),
      )
    }
    for (const device of offboarding.boundDevices ?? []) {
      lines.push('  bound device    ' + (device.displayName ?? device.id) + ' serial=' + (device.serial ?? 'unknown'))
    }
  }
  if (person.note) lines.push('  note            ' + person.note)
  return lines.join('\n')
}

/** Says which HR field decided the date, when the two the HR system holds differ. */
function leaveDateNote(person: { terminationDate?: string | null; lastWorkingDay?: string | null; startDate?: string | null }): string {
  const source = leaveDateSource(person)
  if (source === 'lastWorkingDay' && person.terminationDate && person.terminationDate !== person.lastWorkingDay) {
    return '  (last working day; contract ends ' + person.terminationDate + ')'
  }
  return ''
}
