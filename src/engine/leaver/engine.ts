/**
 * The leaver engine: day 0 suspends, day 6 hands the files over, day 7
 * deletes.
 *
 * This is the most dangerous code in the toolkit, so almost every line of it
 * is a refusal. The ones that matter most, in the order they fire:
 *
 *  - The circuit breaker counts day-0 candidates BEFORE any write and aborts
 *    the whole run when there are too many. A sudden crowd of leavers is a
 *    data fault far more often than a redundancy round, and the incident this
 *    exists for suspended several hundred historic accounts in one run because
 *    their tombstones had been removed by a migration.
 *  - The row is re-read from the store immediately before each person and
 *    before each leg, so a hold flipped while the run is in flight still wins.
 *    A filter alone cannot protect a row whose flag changes mid-run.
 *  - The identity gate refuses to act on an account or address that somebody
 *    who still works here claims, and it ignores their hold flag: hold stops
 *    the automation acting on that person, not on their behalf.
 *  - The day-0 marker is written only when the suspension was read back. The
 *    automation this replaces wrote its progress marker even when every leg
 *    had failed, so a broken run looked finished and was never retried.
 *  - Nothing is marked departed on an unverified delete.
 *
 * A person's phases are processed in day order within one run, so a hand-over
 * that was missed yesterday happens before today's deletion gate is
 * evaluated. The previous arrangement relied on separate schedules running in
 * the right order, which is a race rather than an ordering.
 */

import type { ArmedAction } from '../../config/schema.ts'
import type { Actor, LegName, LegRecord, Person, PersonRunResult, ReviewReason, RunReport } from '../../core/types.ts'
import type { OffboardingRecord } from '../../core/types.ts'
import {
  blockedFingerprint,
  evaluateDeleteGate,
  evaluateIdentityGate,
  resolveProviderAccounts,
  type GateResult,
  type IdpResolution,
} from './gate.ts'
import { DAY0_LEGS, DAY6_LEGS, DAY7_LEGS, type LeaverDeps, type LegContext, type LegResult } from './legs.ts'
import { notifyBlocked, notifyDay0, notifyDay6, notifyDay7, notifyParked, notifyRunAborted, runAuditCtx } from './notify.ts'
import { loadDay0Candidates, loadDay6Candidates, loadDay7Candidates, loadLiveClaims } from './select.ts'

export type Phase = 'day0' | 'day6' | 'day7'

export interface LeaverRunOptions {
  /** Plans and reports without touching a provider. The CLI default. */
  dryRun: boolean
  actor: Actor
  runId: string
  /** One person, for `jml leaver run --email ...`. */
  only?: { hrisId?: string; email?: string }
  phases?: readonly Phase[]
  /**
   * Raises the circuit breaker for this run only.
   *
   * Requires a human actor, and the override is audited with their name. A
   * bulk day is a decision somebody makes and signs for, not a configuration
   * value that quietly grows.
   */
  allowBulk?: number
}

const ALL_PHASES: readonly Phase[] = ['day0', 'day6', 'day7']

/** Legs whose repeated failure parks a row. */
const PROVIDER_LEGS: readonly LegName[] = [
  'suspend_idp',
  'set_autoreply',
  'revoke_licence',
  'transfer_drive',
  'suspend_google',
  'delete_idp',
  'delete_google',
]

/**
 * Increment one count.
 *
 * The report's counts are an open map so a later phase can add its own, which
 * means every read is optional. One helper keeps that from spreading.
 */
function bump(report: RunReport, counter: string): void {
  report.counts[counter] = (report.counts[counter] ?? 0) + 1
}

/** The offboarding record as it stands, ready to be extended. */
function offboardingBase(person: Person): OffboardingRecord {
  return { suspendedAt: null, legs: {}, ...(person.offboarding ?? {}) }
}

interface RunState {
  report: RunReport
  live: Person[]
  today: string
  notificationsFailed: number
}

export async function runLeaverEngine(deps: LeaverDeps, opts: LeaverRunOptions): Promise<RunReport> {
  const today = deps.clock.today(deps.cfg.org.timezone)
  const report: RunReport = {
    runId: opts.runId,
    kind: 'leaver',
    startedAt: deps.clock.nowIso(),
    finishedAt: deps.clock.nowIso(),
    dryRun: opts.dryRun,
    ok: true,
    counts: { selectedDay0: 0, day0: 0, day6: 0, day7: 0, blocked: 0, parked: 0, held: 0, phantom: 0, failedLegs: 0 },
    people: [],
    warnings: [],
    errors: [],
  }
  const state: RunState = { report, live: await loadLiveClaims(deps.store), today, notificationsFailed: 0 }
  const phases = opts.phases ?? ALL_PHASES

  const day0 = only(await loadDay0Candidates(deps.store, today, deps.cfg), opts)
  report.counts.selectedDay0 = day0.length

  const breaker = await checkCircuitBreaker(deps, opts, day0)
  if (breaker) {
    // Everything stops, including the later phases. A count this far out means
    // the picture is wrong, and the safe response to a wrong picture is to
    // touch nothing at all.
    report.aborted = breaker
    report.ok = false
    report.errors.push(String(breaker.detail?.['reason'] ?? breaker.reason))
    report.finishedAt = deps.clock.nowIso()
    // One notification, naming the count. The breaker firing silently would
    // look exactly like a quiet day.
    await announceAbort(deps, opts, report)
    return report
  }

  try {
    if (phases.includes('day0')) {
      for (const person of day0) await runPerson(deps, opts, state, person, 'day0')
    }
    if (phases.includes('day6')) {
      for (const person of only(await loadDay6Candidates(deps.store, today, deps.cfg), opts)) {
        await runPerson(deps, opts, state, person, 'day6')
      }
    }
    if (phases.includes('day7')) {
      for (const person of only(await loadDay7Candidates(deps.store, today, deps.cfg), opts)) {
        await runPerson(deps, opts, state, person, 'day7')
      }
    }
  } catch (err) {
    // An unwritable audit log arrives here, thrown out of the leg that could
    // not record its intent. It stops the whole run rather than one person:
    // without the log there is no record of what a destructive step did, and
    // the remaining people would be acted on unrecorded too.
    const audit = isAuditFailure(err)
    report.ok = false
    report.errors.push(err instanceof Error ? err.message : String(err))
    report.aborted = { reason: audit ? 'audit_unavailable' : 'store_unavailable', detail: {} }
    report.finishedAt = deps.clock.nowIso()
    deps.logger.error('the leaver engine stopped part-way', { runId: opts.runId, audit, err })
    await announceAbort(deps, opts, report)
    return report
  }

  report.counts.notificationsFailed = state.notificationsFailed
  if (state.notificationsFailed > 0) report.ok = false
  if ((report.counts.failedLegs ?? 0) > 0) report.ok = false
  report.finishedAt = deps.clock.nowIso()
  return report
}

/**
 * Tell somebody the run refused to continue.
 *
 * Wrapped, because the notifier records its own audit rows and an unwritable
 * log is one of the reasons a run aborts. When even this cannot be sent, the
 * returned report is the only carrier left, which is why it is complete before
 * anything is sent.
 */
async function announceAbort(deps: LeaverDeps, opts: LeaverRunOptions, report: RunReport): Promise<void> {
  try {
    const told = await notifyRunAborted(deps, runAuditCtx(opts.runId, opts.actor, opts.dryRun), report)
    if (!told.delivered) {
      report.counts.notificationsFailed = 1
      report.warnings.push(...told.reasons)
    }
  } catch (err) {
    report.warnings.push(`the abort could not be announced: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function only(people: readonly Person[], opts: LeaverRunOptions): Person[] {
  if (!opts.only) return [...people]
  const wantedId = opts.only.hrisId
  const wantedEmail = opts.only.email?.trim().toLowerCase()
  return people.filter((person) => {
    if (wantedId && person.hrisId === wantedId) return true
    if (!wantedEmail) return false
    return [person.primaryEmail, ...(person.aliasEmails ?? [])].map((a) => a.toLowerCase()).includes(wantedEmail)
  })
}

/**
 * The count check, before any write.
 *
 * It fires in a dry run too, on purpose. A rehearsal is exactly when an
 * adopter wants to be told that today's selection is forty people rather than
 * two, and a breaker that only fires when armed cannot tell them.
 */
async function checkCircuitBreaker(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  candidates: readonly Person[],
): Promise<NonNullable<RunReport['aborted']> | null> {
  const configured = deps.cfg.leaver.maxDay0PerRun
  const limit = opts.allowBulk ?? configured

  if (opts.allowBulk !== undefined && opts.actor.kind !== 'human') {
    const detail = { configured, requested: opts.allowBulk, actor: opts.actor.id }
    await deps.audit.append({
      at: deps.clock.nowIso(),
      runId: opts.runId,
      phase: 'outcome',
      actor: opts.actor,
      action: 'run.abort',
      subject: { kind: 'run', id: opts.runId },
      dryRun: opts.dryRun,
      ok: false,
      detail: { reason: 'circuit_breaker_override_needs_a_person', ...detail },
    })
    return { reason: 'circuit_breaker', detail }
  }

  if (opts.allowBulk !== undefined) {
    // The override is recorded with the person who asked for it, so a bulk day
    // is answerable afterwards.
    await deps.audit.append({
      at: deps.clock.nowIso(),
      runId: opts.runId,
      phase: 'intent',
      actor: opts.actor,
      action: 'run.circuit_breaker_override',
      subject: { kind: 'run', id: opts.runId },
      dryRun: opts.dryRun,
      detail: { configured, raisedTo: opts.allowBulk, by: opts.actor.id },
    })
  }

  if (candidates.length <= limit) return null

  const detail = {
    reason: `${candidates.length} day-0 candidates exceeds the limit of ${limit}, so the run refused to touch anything`,
    candidates: candidates.length,
    limit,
    // The first few ids, so somebody can look at the actual rows. Ten, not
    // all of them: a summary nobody can read is a summary nobody reads.
    firstTen: candidates.slice(0, 10).map((p) => p.hrisId),
  }
  await deps.audit.append({
    at: deps.clock.nowIso(),
    runId: opts.runId,
    phase: 'outcome',
    actor: opts.actor,
    action: 'run.abort',
    subject: { kind: 'run', id: opts.runId },
    dryRun: opts.dryRun,
    ok: false,
    detail: { circuitBreaker: true, ...detail },
  })
  deps.logger.error('the circuit breaker aborted the run before any write', detail)
  return { reason: 'circuit_breaker', detail }
}

async function park(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  person: Person,
  reason: ReviewReason,
  hint: string,
): Promise<void> {
  if (!opts.dryRun) await deps.store.patch(person.hrisId, { reviewReason: reason, note: hint })
  const notified = await notifyParked(deps, auditCtx(person, opts), reason, hint)
  if (!notified.delivered) state.notificationsFailed += 1
  bump(state.report, 'parked')
  deps.logger.warn('a row was parked for review', { hrisId: person.hrisId, reviewReason: reason })
}

function auditCtx(person: Person, opts: LeaverRunOptions) {
  return { person, runId: opts.runId, actor: opts.actor, dryRun: opts.dryRun }
}

function personResult(person: Person, phase: PersonRunResult['phase']): PersonRunResult {
  return {
    hrisId: person.hrisId,
    displayName: person.displayName || person.primaryEmail,
    phase,
    legs: {},
    statusBefore: person.status,
    statusAfter: person.status,
    notes: [],
  }
}

/** One person, one phase. Everything is re-read here, nothing is trusted. */
async function runPerson(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  selected: Person,
  phase: Phase,
): Promise<void> {
  // Re-read rather than using the selected copy. The selection may be seconds
  // or minutes old by the time a long run reaches this row.
  const person = await deps.store.get(selected.hrisId)
  if (!person) {
    state.report.warnings.push(`${selected.hrisId} was selected and then could not be read, so it was skipped`)
    return
  }
  const outcome = personResult(person, phase)

  if (person.hold) {
    outcome.phase = 'skipped'
    outcome.notes?.push(`on hold: ${person.holdReason ?? 'no reason recorded'}`)
    bump(state.report, 'held')
    state.report.people.push(outcome)
    return
  }
  if (person.reviewReason) {
    outcome.phase = 'parked'
    outcome.reviewReason = person.reviewReason
    outcome.notes?.push('parked for review, so no automatic action was taken')
    bump(state.report, 'parked')
    state.report.people.push(outcome)
    return
  }

  // Before anything is touched: does anybody who still works here claim this
  // account or this address?
  const identity = evaluateIdentityGate(person, state.live, deps.domain)
  if (!identity.open) {
    outcome.phase = 'parked'
    outcome.reviewReason = identity.park ?? 'identity_mismatch'
    outcome.notes?.push(identity.detail)
    await park(deps, opts, state, person, identity.park ?? 'identity_mismatch', identity.detail)
    state.report.people.push(outcome)
    return
  }

  const resolved = await resolveProviderAccounts(deps.idp, deps.google, person)
  if (resolved.ambiguous) {
    outcome.phase = 'parked'
    outcome.reviewReason = 'ambiguous_provider_match'
    const hint = 'more than one provider account matched this person, so nothing was touched'
    outcome.notes?.push(hint)
    await park(deps, opts, state, person, 'ambiguous_provider_match', hint)
    state.report.people.push(outcome)
    return
  }
  await recordAccountPresence(deps, opts, person, resolved)
  // Re-read, because what the directories just told us is now on the row and
  // the gates read it from there. Working from the copy taken before that
  // write would evaluate today's gate against yesterday's facts.
  const current = (await deps.store.get(person.hrisId)) ?? person

  if (phase === 'day0') await runDay0(deps, opts, state, current, resolved, outcome)
  else if (phase === 'day6') await runDay6(deps, opts, state, current, resolved, outcome)
  else await runDay7(deps, opts, state, current, resolved, outcome)

  state.report.people.push(outcome)
}

/**
 * Write what the directories actually said.
 *
 * `googleAccountPresent` is read from the Google directory and never inferred
 * from the identity provider. The automation this replaces used "has an
 * identity provider account" as a proxy, and it was wrong in both directions.
 */
async function recordAccountPresence(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  person: Person,
  resolved: { idp: IdpResolution; googleAccount: IdpResolution },
): Promise<void> {
  if (opts.dryRun) return
  const patch: Partial<Person> = {}
  if (resolved.googleAccount.kind !== 'unreadable') {
    patch.googleAccountPresent = resolved.googleAccount.kind === 'found'
  }
  const ids: Record<string, string> = {}
  if (resolved.idp.kind === 'found') ids['jumpcloudUserId'] = resolved.idp.user.id
  if (resolved.googleAccount.kind === 'found') ids['googleUserId'] = resolved.googleAccount.user.id
  if (Object.keys(ids).length > 0) patch.externalIds = { ...person.externalIds, ...ids }
  if (Object.keys(patch).length > 0) await deps.store.patch(person.hrisId, patch)
}

function legContext(
  person: Person,
  opts: LeaverRunOptions,
  resolved: { idp: IdpResolution; googleAccount: IdpResolution },
  today: string,
): LegContext {
  return {
    person,
    idp: resolved.idp,
    googleAccount: resolved.googleAccount,
    runId: opts.runId,
    actor: opts.actor,
    dryRun: opts.dryRun,
    today,
  }
}

/**
 * Run a phase's legs, re-reading the hold flag before each one.
 *
 * Each leg is caught independently. One provider being down must not stop the
 * others: a leaver whose licence could not be released should still have their
 * account closed.
 *
 * A leg that asks for the row to be PARKED stops every DESTRUCTIVE leg after
 * it. A park is not a failed step; it is a leg reporting that the picture is
 * wrong. The identity deletion parks when the provider says the account is no
 * longer suspended, meaning somebody restored it or the wrong account is on
 * this row. The phase used to carry on and delete the Google account anyway,
 * because the park was only read after every leg had finished, so the refusal
 * and the deletion of that person's mailbox happened in the same run.
 *
 * Only destructive legs are stopped, and that distinction is the whole point.
 * On day 6 the hand-over parks when nobody can be found to take the files, and
 * the Google suspension that follows must still run: closing access is the
 * protective direction, and the files stay where they are until a person names
 * a recipient. Stopping the phase outright there would leave a parked leaver's
 * mailbox open for as long as the row waited for somebody to look at it.
 *
 * A hold is different again and stops everything, destructive or not, because
 * a hold is somebody asking for the automation to leave the row alone.
 */
async function runLegs(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  person: Person,
  resolved: { idp: IdpResolution; googleAccount: IdpResolution },
  today: string,
  legs: readonly (typeof DAY0_LEGS)[number][],
  outcome: PersonRunResult,
): Promise<LegResult[]> {
  const results: LegResult[] = []
  let current = person
  let parked = false
  for (const leg of legs) {
    const fresh = await deps.store.get(person.hrisId)
    if (!fresh || fresh.hold) {
      outcome.notes?.push(`stopped before ${leg.name}: the row is now on hold`)
      break
    }
    if (parked && DESTRUCTIVE_ACTIONS.includes(leg.action)) {
      // Said out loud, so the reason a leg is missing from the record is not
      // left to be inferred from its absence.
      outcome.notes?.push(`${leg.name} was not attempted: an earlier step parked the row for review`)
      continue
    }
    current = fresh
    const ctx = legContext(current, opts, resolved, today)
    try {
      const legResult = await leg.run(deps, ctx)
      results.push(legResult)
      if (legResult.park) parked = true
    } catch (err) {
      // An audit failure lands here and is rethrown: a step whose intent could
      // not be recorded must stop the run rather than continue unrecorded.
      if (isAuditFailure(err)) throw err
      const message = err instanceof Error ? err.message : String(err)
      results.push({
        name: leg.name,
        record: { state: 'failed', verified: false, attempts: (current.offboarding?.legs?.[leg.name]?.attempts ?? 0) + 1, at: deps.clock.nowIso(), error: message },
        note: `${leg.name} threw: ${message}`,
      })
    }
  }
  return results
}

/**
 * The actions that destroy something a person cannot get back.
 *
 * Deliberately narrow. A suspension is reversible and protective, so it is not
 * on this list and still runs after a park; a deletion is neither.
 */
const DESTRUCTIVE_ACTIONS: readonly ArmedAction[] = ['delete']

function isAuditFailure(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'audit_unavailable'
}

/**
 * The row as it stands right now, or null when it must be left alone.
 *
 * Called again immediately before a status write. A hold set while the run was
 * in flight has to win over the selection that was made minutes earlier, and
 * the write is the last moment it can.
 */
async function stillActionable(deps: LeaverDeps, hrisId: string): Promise<Person | null> {
  const fresh = await deps.store.get(hrisId)
  if (!fresh || fresh.hold) return null
  return fresh
}

function legRecords(results: readonly LegResult[]): Partial<Record<LegName, LegRecord>> {
  const out: Partial<Record<LegName, LegRecord>> = {}
  for (const leg of results) out[leg.name] = leg.record
  return out
}

function evidenceOf(results: readonly LegResult[]): Partial<OffboardingRecord> {
  const patch: Partial<OffboardingRecord> = {}
  for (const leg of results) {
    if (leg.evidence?.transferId) patch.transferId = leg.evidence.transferId
    if (leg.evidence?.transferRecipient) patch.transferRecipient = leg.evidence.transferRecipient
    if (leg.evidence?.transferredAt) patch.transferredAt = leg.evidence.transferredAt
  }
  return patch
}

function verifiedDone(record: LegRecord | undefined): boolean {
  return record?.verified === true && (record.state === 'done' || record.state === 'already_absent')
}

/** Day 0. The marker is the last thing written, and only if the door closed. */
async function runDay0(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  person: Person,
  resolved: { idp: IdpResolution; googleAccount: IdpResolution },
  outcome: PersonRunResult,
): Promise<void> {
  const bothMissing = resolved.idp.kind !== 'found' && resolved.googleAccount.kind !== 'found'
  if (bothMissing) {
    const unreadable = resolved.idp.kind === 'unreadable' || resolved.googleAccount.kind === 'unreadable'
    if (unreadable) {
      // A failed read is not evidence of an absent account, and treating it as
      // one would tombstone a real leaver as having had nothing to offboard.
      const hint = 'neither provider could confirm an account, and at least one lookup failed, so nothing was touched'
      outcome.phase = 'parked'
      outcome.reviewReason = 'identity_mismatch'
      outcome.notes?.push(hint)
      await park(deps, opts, state, person, 'identity_mismatch', hint)
      return
    }
    // The phantom path: both lookups succeeded and found nothing. There is
    // nothing to suspend, so the row is closed without touching a provider.
    // This is also the landing zone a mistaken identity is defused into by
    // clearing the account ids on the bad row.
    const note = 'no account exists in either provider, so there was nothing to offboard'
    deps.logger.warn('phantom leaver: no accounts anywhere, closing the row without touching anything', {
      hrisId: person.hrisId,
    })
    outcome.phase = 'skipped'
    outcome.notes?.push(note)
    bump(state.report, 'phantom')
    outcome.statusAfter = 'departed'
    if (opts.dryRun) {
      outcome.notes?.push('dry run: the row would be closed as departed')
      outcome.statusAfter = person.status
      return
    }
    const moved = await deps.store.transition({
      hrisId: person.hrisId,
      expectFrom: person.status,
      event: 'engine.phantom_departed',
      owner: 'engine',
      reason: note,
      patch: { offboarding: { ...offboardingBase(person), suspendedAt: state.today, departedAt: state.today } },
    })
    if (!moved.ok) {
      state.report.errors.push(`could not close ${person.hrisId} as a phantom: ${moved.reason}`)
      outcome.statusAfter = person.status
    }
    return
  }

  const results = await runLegs(deps, opts, person, resolved, state.today, DAY0_LEGS, outcome)
  outcome.legs = legRecords(results)
  for (const leg of results) if (leg.record.state === 'failed') bump(state.report, 'failedLegs')

  const suspended = results.find((leg) => leg.name === 'suspend_idp')
  const doorClosed = verifiedDone(suspended?.record)

  if (opts.dryRun) {
    outcome.statusAfter = 'offboarding'
    outcome.notes?.push('dry run: nothing was written; this is what the row would become')
    for (const leg of results) outcome.notes?.push(leg.note)
    await notifyIfDelivered(state, () => notifyDay0(deps, auditCtx(person, opts), results, state.today))
    return
  }

  // Legs are recorded whatever happened, so a failure accumulates attempts and
  // is retried, and so a person can see what was tried.
  await deps.store.patch(person.hrisId, {
    offboarding: { ...offboardingBase(person), legs: legRecords(results), ...evidenceOf(results) },
  })

  if (!doorClosed) {
    // No marker, so this row is selected again next run. The automation this
    // replaces wrote the marker regardless and never retried, which is how an
    // account stayed usable while the record said it was suspended.
    state.report.ok = false
    outcome.notes?.push('the day-0 marker was NOT written because the suspension was not confirmed; this row is retried next run')
    for (const leg of results) outcome.notes?.push(leg.note)
    await parkIfExhausted(deps, opts, state, person, results)
    return
  }

  if (!(await stillActionable(deps, person.hrisId))) {
    // Suspending is the safe direction, so the leg that already ran stands.
    // The marker does not: writing it would move the row on while somebody
    // has asked for the automation to stop touching it.
    outcome.phase = 'skipped'
    outcome.notes?.push('the row went on hold during the run, so the day-0 marker was not written')
    bump(state.report, 'held')
    return
  }

  const moved = await deps.store.transition({
    hrisId: person.hrisId,
    expectFrom: person.status,
    event: 'engine.day0_suspended',
    owner: 'engine',
    reason: 'day 0: access suspended',
    patch: { offboarding: { ...offboardingBase(person), suspendedAt: state.today, legs: legRecords(results) } },
  })
  if (!moved.ok) {
    state.report.ok = false
    state.report.errors.push(`${person.hrisId} was suspended but the row could not be moved to offboarding: ${moved.reason}`)
    outcome.notes?.push('the account was suspended and the row could not be updated; day 0 runs again next time, which is safe because every leg is idempotent')
    return
  }
  outcome.statusAfter = moved.person.status
  bump(state.report, 'day0')
  for (const leg of results) outcome.notes?.push(leg.note)
  await notifyIfDelivered(state, () => notifyDay0(deps, auditCtx(moved.person, opts), results, state.today))
  await parkIfExhausted(deps, opts, state, moved.person, results)
}

/** Day 6: hand the files over, then close the Google account. No status moves. */
async function runDay6(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  person: Person,
  resolved: { idp: IdpResolution; googleAccount: IdpResolution },
  outcome: PersonRunResult,
): Promise<void> {
  const results = await runLegs(deps, opts, person, resolved, state.today, DAY6_LEGS, outcome)
  outcome.legs = legRecords(results)
  for (const leg of results) {
    if (leg.record.state === 'failed') bump(state.report, 'failedLegs')
    outcome.notes?.push(leg.note)
  }
  const evidence = evidenceOf(results)

  if (!opts.dryRun) {
    await deps.store.patch(person.hrisId, {
      offboarding: { ...offboardingBase(person), legs: legRecords(results), ...evidence },
    })
  }
  bump(state.report, 'day6')

  const transfer = results.find((leg) => leg.name === 'transfer_drive')
  const parkReason = results.find((leg) => leg.park)?.park
  if (parkReason) {
    outcome.reviewReason = parkReason
    outcome.phase = 'parked'
    await park(deps, opts, state, person, parkReason, transfer?.note ?? 'a step needs a person to decide')
  }

  // Told once, when the hand-over reaches a terminal state. A note on every
  // run while a transfer is still copying is the noise this toolkit exists to
  // stop.
  const settled = transfer && (transfer.record.state === 'done' || transfer.record.state === 'already_absent' || transfer.record.state === 'failed')
  if (settled || parkReason) {
    const fresh = (await deps.store.get(person.hrisId)) ?? person
    await notifyIfDelivered(state, () => notifyDay6(deps, auditCtx(fresh, opts), results, state.today))
  }
  await parkIfExhausted(deps, opts, state, person, results)
}

/** Day 7: every gate, then the deletes, then the tombstone. */
async function runDay7(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  person: Person,
  resolved: { idp: IdpResolution; googleAccount: IdpResolution },
  outcome: PersonRunResult,
): Promise<void> {
  const gate = await evaluateDeleteGate({
    person,
    idp: resolved.idp,
    devices: deps.devices,
    cfg: deps.cfg,
    live: state.live,
    domain: deps.domain,
    logger: deps.logger,
  })

  if (!gate.open) {
    await recordBlocked(deps, opts, state, person, gate, outcome)
    return
  }

  const results = await runLegs(deps, opts, person, resolved, state.today, DAY7_LEGS, outcome)
  outcome.legs = legRecords(results)
  for (const leg of results) {
    if (leg.record.state === 'failed') bump(state.report, 'failedLegs')
    outcome.notes?.push(leg.note)
  }

  if (!opts.dryRun) {
    // Recorded before anything else is decided, so a refusal still leaves the
    // evidence of what was tried on the row.
    await deps.store.patch(person.hrisId, {
      offboarding: { ...offboardingBase(person), legs: legRecords(results) },
    })
  }

  const parked = results.find((leg) => leg.park)
  if (parked?.park) {
    outcome.phase = 'parked'
    outcome.reviewReason = parked.park
    await park(deps, opts, state, person, parked.park, parked.note)
    return
  }

  // Every applicable delete must be verified. A leg that is merely "not
  // armed", pending or failed leaves the row in offboarding: marking somebody
  // departed on an unverified delete is how a silent no-op passed for a
  // completed offboarding.
  const applicable = results.filter((leg) => leg.record.state !== 'not_applicable')
  const allVerified = applicable.length > 0 && applicable.every((leg) => verifiedDone(leg.record))

  if (opts.dryRun) {
    outcome.statusAfter = allVerified ? 'departed' : person.status
    outcome.notes?.push('dry run: nothing was deleted and nothing was written')
    return
  }

  if (!allVerified) {
    state.report.ok = false
    outcome.notes?.push('the row stays in offboarding: at least one deletion was not confirmed')
    await parkIfExhausted(deps, opts, state, person, results)
    return
  }

  if (!(await stillActionable(deps, person.hrisId))) {
    outcome.phase = 'skipped'
    outcome.notes?.push('the row went on hold during the run, so it was not marked departed')
    bump(state.report, 'held')
    return
  }

  const moved = await deps.store.transition({
    hrisId: person.hrisId,
    expectFrom: person.status,
    event: 'engine.day7_departed',
    owner: 'engine',
    reason: 'day 7: accounts deleted and confirmed gone',
    patch: {
      offboarding: {
        ...offboardingBase(person),
        legs: legRecords(results),
        departedAt: state.today,
        // Cleared in the same write that closes the row, so a resolved
        // blockage cannot be left behind looking current.
        deleteBlockedReason: null,
        boundDevices: [],
        blockedFingerprint: null,
      },
    },
  })
  if (!moved.ok) {
    state.report.ok = false
    state.report.errors.push(`${person.hrisId} was deleted but could not be marked departed: ${moved.reason}`)
    return
  }
  outcome.statusAfter = moved.person.status
  bump(state.report, 'day7')
  await notifyIfDelivered(state, () => notifyDay7(deps, auditCtx(moved.person, opts), results))
}

async function recordBlocked(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  person: Person,
  gate: Extract<GateResult, { open: false }>,
  outcome: PersonRunResult,
): Promise<void> {
  outcome.phase = 'blocked'
  outcome.blockedReason = gate.reason
  outcome.notes?.push(gate.detail)
  bump(state.report, 'blocked')
  if (gate.reason === 'gate_error') state.report.ok = false

  const devices = gate.devices ?? []
  if (!opts.dryRun) {
    await deps.store.patch(person.hrisId, {
      offboarding: {
        ...offboardingBase(person),
        deleteBlockedReason: gate.reason,
        boundDevices: devices,
        blockedFingerprint: blockedFingerprint(gate.reason, devices),
      },
    })
  }
  if (gate.park) {
    outcome.reviewReason = gate.park
    await park(deps, opts, state, person, gate.park, gate.detail)
    return
  }
  await notifyIfDelivered(state, () => notifyBlocked(deps, auditCtx(person, opts), gate))
}

/**
 * A leg that has failed too often stops being retried.
 *
 * Retrying for ever with nobody watching is how a broken step becomes
 * permanent, so the row parks and somebody is told once. The count is on the
 * leg record, so it accumulates across runs rather than resetting each time.
 */
async function parkIfExhausted(
  deps: LeaverDeps,
  opts: LeaverRunOptions,
  state: RunState,
  person: Person,
  results: readonly LegResult[],
): Promise<void> {
  const limit = deps.cfg.leaver.maxAttemptsPerLeg
  const exhausted = results.filter(
    (leg) => PROVIDER_LEGS.includes(leg.name) && leg.record.state === 'failed' && leg.record.attempts >= limit,
  )
  if (exhausted.length === 0) return
  const hint = `${exhausted.map((leg) => leg.name).join(', ')} failed ${limit} times, so this row is parked for review`
  await park(deps, opts, state, person, 'max_leg_attempts', hint)
}

async function notifyIfDelivered(
  state: RunState,
  send: () => Promise<{ delivered: boolean; reasons: string[] }>,
): Promise<void> {
  const report = await send()
  if (!report.delivered) {
    state.notificationsFailed += 1
    state.report.warnings.push(...report.reasons)
  }
}
