/**
 * Reconciling an HR snapshot into the people store.
 *
 * This is the only writer of `hired`, `active` and `terminated`, and every
 * later step acts on what it decided. Almost every rule below is here because
 * an earlier design lost one of them and a real account was
 * created, revived or suspended as a result.
 *
 * The four that matter most, in the order they fire:
 *
 *  - A snapshot that is incomplete or below the plausibility floor aborts with
 *    zero writes. A truncated HR read looks exactly like a company where
 *    everybody left.
 *  - A row is NEVER created with the derived status `terminated`. Without that
 *    line, the first run against a full HR history creates every historic
 *    leaver as a fresh termination and the engine starts offboarding accounts
 *    that were closed years ago. That happened, to several hundred rows.
 *  - Rows the engine owns (`offboarding`, `departed`) keep their status
 *    whatever the HR system now says. Their names and dates are still patched,
 *    because a tombstone with a stale manager is still useful evidence.
 *  - The join is on the HR id first and the address second. An address change
 *    on a known HR id moves the old address into `aliasEmails` and keeps ONE
 *    row with its provider account ids intact. A second row for a known HR id
 *    once inherited an employed colleague's account ids and suspended them.
 */

import { daysBetween, SystemClock } from '../core/clock.ts'
import type { Clock, IsoDate } from '../core/clock.ts'
import { isPreservedBySync } from '../core/transitions.ts'
import type { TransitionEvent } from '../core/transitions.ts'
import { claimedByLivePerson, classifyEmailChange, matchPerson } from '../core/identity.ts'
import type { IdentityRules } from '../core/identity.ts'
import { nullLogger } from '../core/logger.ts'
import type { Logger } from '../core/logger.ts'
import type { Actor, LifecycleStatus, Person, ReviewReason } from '../core/types.ts'
import { leaveDateOf } from '../hris/leave-date.ts'
import { deriveHrisStatus, ISO_DATE } from '../hris/status.ts'
import type { HrisDerivedStatus } from '../hris/status.ts'
import { HrisImplausible, HrisIncomplete } from '../hris/types.ts'
import type { HrisPerson, HrisSnapshot } from '../hris/types.ts'
import type { PeopleStore } from '../store/types.ts'
import { mergeHrisFields } from '../store/transitions-guard.ts'
import type { AuditSink } from '../audit/types.ts'
import { renderNotification } from '../notify/fanout.ts'
import type { Notifier } from '../notify/types.ts'

/** Re-exported: the derivation moved to the HR layer so the bootstrap shares it. */
export { deriveHrisStatus }
export type { HrisDerivedStatus }

/** What the sync did with one HR record. */
export type SyncAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'status_changed'
  /** Status left alone because the engine owns the row; fields still patched. */
  | 'preserved'
  /** Given a review reason, so nothing automatic will act on it. */
  | 'parked'
  /** Frozen by the sync itself, awaiting a person. */
  | 'auto_held'
  /** A human froze the row, so the sync did not touch it at all. */
  | 'held'
  /** The old identity was closed because the HR id now names somebody else. */
  | 'tombstoned'
  /** Deliberately not created: the derived status was terminated. */
  | 'skipped_historic_leaver'
  | 'skipped_no_email'
  /** The store refused the write, or the record could not be resolved safely. */
  | 'refused'

export interface SyncRow {
  hrisId: string
  /** Display name, never an address: this ends up in logs and reports. */
  label: string
  action: SyncAction
  /** One sentence, printed as-is in the dry-run diff table. */
  reason: string
  statusBefore: LifecycleStatus | null
  statusAfter: LifecycleStatus | null
  changedFields: string[]
  reviewReason?: ReviewReason | null
}

/** One counter per action, plus the two the run summary reads directly. */
export type SyncCounts = Record<SyncAction, number> & {
  scanned: number
  /** Stored rows the snapshot said nothing about. Never read as a departure. */
  storedNotInSnapshot: number
}

export interface SyncReport {
  ok: boolean
  dryRun: boolean
  today: IsoDate
  fetchedAt: string
  counts: SyncCounts
  rows: SyncRow[]
  /** People the HR system reports as employed again after Day 0. */
  reinstated: string[]
  warnings: string[]
  errors: string[]
}

export interface SyncOptions {
  snapshot: HrisSnapshot
  people: PeopleStore
  /** Today in the organisation's own zone. The caller owns the clock. */
  today: IsoDate
  identity: IdentityRules
  /**
   * The same floor the adapter uses, re-checked here as defence in depth.
   *
   * It is checked against the employed set as well as the whole snapshot, so
   * state it comfortably below real headcount: a floor equal to the staff list
   * refuses the run the first time one person leaves.
   */
  minPlausibleHeadcount: number
  terminationLookbackDays: number
  /** Plan and report, write nothing. */
  dryRun?: boolean
  logger?: Logger
  /** Optional: each status write is recorded as an intent/outcome pair. */
  audit?: AuditSink
  runId?: string
  actor?: Actor
  /** Optional: told once when somebody is reinstated after Day 0. */
  notifier?: Notifier
  source?: string
  clock?: Clock
}

/** True when a leaving date is missing, unparseable, or older than the lookback. */
export function terminationOutsideLookback(
  terminationDate: string | null | undefined,
  today: IsoDate,
  lookbackDays: number,
): boolean {
  if (isBlank(terminationDate) || !ISO_DATE.test(String(terminationDate))) return true
  return daysBetween(String(terminationDate), today) > lookbackDays
}

/**
 * Fields the sync may patch on a row whose status the engine owns.
 *
 * Deliberately no address, no aliases and no start date. An address change on
 * a closed row must not reopen the question of who that row is, and on a
 * tombstone the answer can only ever be "the person who left".
 */
const PRESERVED_ROW_FIELDS = [
  'displayName',
  'firstName',
  'lastName',
  'department',
  'jobTitle',
  'site',
  'managerEmail',
  'personalEmail',
  'terminationDate',
  'lastWorkingDay',
  'inScope',
] as const satisfies readonly (keyof Person)[]

const EVENT_FOR: Record<HrisDerivedStatus, TransitionEvent> = {
  hired: 'hris.hired',
  active: 'hris.active',
  terminated: 'hris.terminated',
}

const ACTIONS: readonly SyncAction[] = [
  'created',
  'updated',
  'unchanged',
  'status_changed',
  'preserved',
  'parked',
  'auto_held',
  'held',
  'tombstoned',
  'skipped_historic_leaver',
  'skipped_no_email',
  'refused',
]

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runSync(options: SyncOptions): Promise<SyncReport> {
  const { snapshot, people, today } = options
  const logger = options.logger ?? nullLogger()
  const dryRun = options.dryRun === true
  const report: SyncReport = {
    ok: true,
    dryRun,
    today,
    fetchedAt: snapshot.fetchedAt,
    counts: zeroCounts(),
    rows: [],
    reinstated: [],
    warnings: [...(snapshot.warnings ?? [])],
    errors: [],
  }

  assertSnapshotUsable(snapshot, options.minPlausibleHeadcount)

  const stored = await people.list()
  const byId = new Map(stored.map((person) => [person.hrisId, person]))
  const seen = new Set<string>()
  const ctx: RunContext = { ...options, dryRun, source: options.source ?? 'hris', logger, report, stored }

  for (const record of snapshot.all) {
    report.counts.scanned += 1
    if (seen.has(record.hrisId)) {
      report.warnings.push(`The HR snapshot lists ${record.hrisId} more than once; only the first record was used.`)
      continue
    }
    seen.add(record.hrisId)

    const desired = deriveHrisStatus(record, snapshot.activeIds, today)
    const current = byId.get(record.hrisId) ?? null
    const base: RowBase = {
      hrisId: record.hrisId,
      label: current?.displayName || record.displayName,
      statusBefore: current?.status ?? null,
      changedFields: [],
    }
    try {
      recordRow(report, current ? await syncExisting(ctx, record, current, desired) : await syncNew(ctx, record, desired, base))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report.ok = false
      report.errors.push(`${record.hrisId}: ${message}`)
      recordRow(report, row(base, 'refused', current?.status ?? null, message))
    }
  }

  for (const person of stored) {
    if (seen.has(person.hrisId)) continue
    report.counts.storedNotInSnapshot += 1
    // Absence from a snapshot is NOT a departure. Only absence from the
    // employed set of a snapshot that does contain the person is, and a row
    // the HR system has stopped mentioning at all needs a human, not a guess.
    report.warnings.push(
      `${person.hrisId} (${person.displayName}) is in the store with status ${person.status} but absent from the HR snapshot entirely, so it was left exactly as it is.`,
    )
  }

  logger.info('hris sync finished', { dryRun, counts: report.counts, warnings: report.warnings.length })
  return report
}

/**
 * Refuse a snapshot nothing should be written from.
 *
 * Both checks run before a single row is read, so an abort really does mean
 * zero writes rather than "we stopped when we noticed".
 */
function assertSnapshotUsable(snapshot: HrisSnapshot, floor: number): void {
  if (!snapshot.complete) {
    throw new HrisIncomplete(
      'Refusing to sync an incomplete HR snapshot. Everybody missing from it would look like a leaver on this run.',
    )
  }
  if (snapshot.all.length < floor) {
    throw new HrisImplausible(
      `The HR snapshot holds ${snapshot.all.length} people, below the stated floor of ${floor}. Nothing is written from a snapshot that small.`,
      { received: snapshot.all.length, floor },
    )
  }
  if (snapshot.activeIds.size < floor) {
    // The employed set is usually a second read, so it can be truncated on its
    // own while the full list looks healthy. Reading that as "everybody left"
    // is the most expensive mistake this toolkit could make.
    throw new HrisImplausible(
      `The HR snapshot reports ${snapshot.activeIds.size} employed people, below the stated floor of ${floor}. A truncated employed read looks exactly like a company where everybody left.`,
      { received: snapshot.activeIds.size, floor },
    )
  }
}

interface RunContext extends SyncOptions {
  dryRun: boolean
  source: string
  logger: Logger
  report: SyncReport
  stored: readonly Person[]
}

type RowBase = Pick<SyncRow, 'hrisId' | 'label' | 'statusBefore'> & { changedFields: string[] }

function row(
  base: RowBase,
  action: SyncAction,
  statusAfter: LifecycleStatus | null,
  reason: string,
  extra: { reviewReason?: ReviewReason | null; changedFields?: string[] } = {},
): SyncRow {
  return {
    ...base,
    action,
    statusAfter,
    reason,
    reviewReason: extra.reviewReason ?? null,
    changedFields: extra.changedFields ?? base.changedFields,
  }
}

function zeroCounts(): SyncCounts {
  const counts = { scanned: 0, storedNotInSnapshot: 0 } as SyncCounts
  for (const action of ACTIONS) counts[action] = 0
  return counts
}

function recordRow(report: SyncReport, entry: SyncRow): void {
  report.rows.push(entry)
  report.counts[entry.action] += 1
}

// ---------------------------------------------------------------------------
// One person at a time
// ---------------------------------------------------------------------------

/** A person the store has never seen. */
async function syncNew(
  ctx: RunContext,
  record: HrisPerson,
  desired: HrisDerivedStatus,
  base: RowBase,
): Promise<SyncRow> {
  // THE line. A leaver who has no row never had one, so there is nothing to
  // offboard and no account work is owed. Creating the row would schedule
  // exactly that work for every leaver in the organisation's history.
  if (desired === 'terminated') {
    return row(
      base,
      'skipped_historic_leaver',
      null,
      'Not in the HR employed set and not in the store, so this is a historic leaver. A row is never created as terminated: that is what stops a whole HR history being offboarded on the first run.',
    )
  }
  if (isBlank(record.primaryEmail)) {
    return row(
      base,
      'skipped_no_email',
      null,
      'The HR record carries no work address, so nothing could be resolved for this person in any provider. Fix the HR record and the row is created on the next run.',
    )
  }

  const match = matchPerson(ctx.stored, { hrisId: record.hrisId, email: record.primaryEmail }, ctx.identity.domain)
  if (match.ambiguous.length > 0) {
    const ids = match.ambiguous.map((p) => p.hrisId).join(', ')
    ctx.report.warnings.push(
      `${record.hrisId} was not created: ${match.ambiguous.length} stored rows already hold that address (${ids}). Resolve the duplicate in the HR system.`,
    )
    return row(base, 'refused', null, `More than one stored row claims this address (${ids}), and picking one of them is how a write lands on the wrong person.`)
  }

  let reviewReason: ReviewReason | null = null
  let reason = `New ${desired} row from the HR system.`
  if (match.person && (match.person.status === 'hired' || match.person.status === 'active')) {
    // Two employed rows sharing one address is a data fault, and it is the
    // shape that hands one person's provider account to another person's row.
    reviewReason = 'identity_claimed_by_live_person'
    reason = `Created and parked: ${match.person.hrisId} is employed and already holds this address, so a person has to tell the two records apart first.`
    ctx.report.warnings.push(`${record.hrisId} (${record.displayName}) was created parked: employed row ${match.person.hrisId} already holds that address.`)
  } else if (match.person) {
    ctx.report.warnings.push(
      `${record.hrisId} is a new HR id reusing the address of ${match.person.hrisId} (status ${match.person.status}), which is what a rehire looks like. The old row keeps its own history.`,
    )
  }

  if (ctx.dryRun) return row(base, 'created', desired, reason, { reviewReason, changedFields: ['*created*'] })

  const incoming = toPerson(record, desired, ctx.source)
  incoming.reviewReason = reviewReason
  const result = await ctx.people.upsert(incoming)
  return row(base, 'created', result.person.status, reason, { reviewReason, changedFields: result.changedFields })
}

/** A person the store already holds. */
async function syncExisting(
  ctx: RunContext,
  record: HrisPerson,
  current: Person,
  desired: HrisDerivedStatus,
): Promise<SyncRow> {
  const base: RowBase = {
    hrisId: record.hrisId,
    label: current.displayName || record.displayName,
    statusBefore: current.status,
    changedFields: [],
  }

  // A held row is frozen against the sync as well as against the engine. The
  // flag exists so one person can be taken out of the automation completely,
  // and a sync that kept patching them would keep changing the evidence
  // somebody was in the middle of reading.
  if (current.hold) {
    return row(
      base,
      'held',
      current.status,
      `Held by a person${current.holdReason ? ` (${current.holdReason})` : ''}, so the sync left the row completely alone.`,
      { reviewReason: current.reviewReason },
    )
  }

  if (isPreservedBySync(current.status)) return preserveRow(ctx, record, current, desired, base)

  // A row can hold the Day-0 marker while its status is still `terminated`,
  // when the Day-0 status write itself failed. Reviving that row would make
  // the suspension run a second time.
  if (desired !== 'terminated' && current.offboarding?.suspendedAt) {
    return autoHold(ctx, record, current, base, 'suspension has already run for this row')
  }

  const change = classifyEmailChange({
    previousEmail: current.primaryEmail,
    newEmail: record.primaryEmail ?? '',
    hasTerminationDate: !isBlank(record.terminationDate) || !isBlank(current.terminationDate),
    rules: ctx.identity,
  })
  if (change.kind === 'new_identity') {
    const tombstoned = await roleChangeTombstone(ctx, record, current, desired, base)
    if (tombstoned) return tombstoned
  }

  // The alias path: one row, the old address kept. `mergeHrisFields` does the
  // move, diffs before writing and never lets a blank incoming value erase a
  // populated stored one, so an unchanged sync writes nothing.
  const incoming = toPerson(record, current.status, ctx.source)
  const planned = mergeHrisFields(current, incoming, 'plan')
  let changedFields = planned.changedFields
  if (planned.changed && !ctx.dryRun) changedFields = (await ctx.people.upsert(incoming)).changedFields
  base.changedFields = changedFields

  if (desired !== current.status) return statusChange(ctx, record, current, desired, base)

  const parked = await parkLateTermination(ctx, record, current, base)
  if (parked) return parked
  return row(
    base,
    changedFields.length > 0 ? 'updated' : 'unchanged',
    current.status,
    changedFields.length > 0
      ? `HR fields changed: ${changedFields.join(', ')}.`
      : 'Nothing the HR system owns has changed, so nothing was written.',
    { reviewReason: current.reviewReason },
  )
}

/** A row the engine owns: patch the descriptive fields, never the status. */
async function preserveRow(
  ctx: RunContext,
  record: HrisPerson,
  current: Person,
  desired: HrisDerivedStatus,
  base: RowBase,
): Promise<SyncRow> {
  if (desired !== 'terminated' && current.status === 'offboarding') {
    return autoHold(ctx, record, current, base, 'the HR system reports this person as employed again')
  }
  if (desired !== 'terminated' && current.status === 'departed') {
    // Terminal, and nothing may move a row out of it, so this is reported
    // rather than acted on: an employed person with a tombstone needs a new HR
    // record, and somebody has to decide that.
    ctx.report.warnings.push(
      `${current.hrisId} (${current.displayName}) is tombstoned but the HR system now reports them as employed. The tombstone is terminal, so they need a new HR record.`,
    )
  }

  const patch = preservedRowPatch(current, record)
  const fields = Object.keys(patch)
  if (fields.length > 0 && !ctx.dryRun) await ctx.people.patch(current.hrisId, patch)
  return row(
    base,
    'preserved',
    current.status,
    fields.length > 0
      ? `Status ${current.status} is the engine's to change, so only HR fields were patched: ${fields.join(', ')}.`
      : `Status ${current.status} is the engine's to change, and no HR field differed.`,
    { reviewReason: current.reviewReason, changedFields: fields },
  )
}

/**
 * Freeze a row rather than reviving it.
 *
 * Reinstating somebody whose access has already been suspended is a decision
 * for a person: the accounts may be deleted, the files may already have been
 * handed to somebody else, and a sync cannot know which. So the row keeps its
 * status, gains a hold, and is announced once.
 */
async function autoHold(
  ctx: RunContext,
  record: HrisPerson,
  current: Person,
  base: RowBase,
  why: string,
): Promise<SyncRow> {
  const reason = `Reinstated after Day 0: ${why}, so the row was frozen for review instead of revived. Restoring access is a human action.`
  ctx.report.reinstated.push(current.hrisId)
  if (!ctx.dryRun) {
    // The protective write happens first and does not depend on a chat API
    // being reachable. A failed notification makes the run not ok, which is
    // reported; an unfrozen row would be acted on.
    await ctx.people.patch(current.hrisId, { hold: true, holdReason: reason, reviewReason: 'reinstated_after_day0' })
    await notifyReinstated(ctx, record, current, reason)
  }
  return row(base, 'auto_held', current.status, reason, {
    reviewReason: 'reinstated_after_day0',
    changedFields: ['hold', 'holdReason', 'reviewReason'],
  })
}

/**
 * Say it once.
 *
 * No change gate is needed: the hold written above is the idempotency key,
 * because the next run skips a held row before it reaches this decision.
 */
async function notifyReinstated(ctx: RunContext, record: HrisPerson, current: Person, reason: string): Promise<void> {
  if (!ctx.notifier) return
  const name = current.displayName || record.displayName
  const result = await ctx.notifier.send({
    kind: 'leaver.parked',
    subject: `Reinstated after offboarding started: ${name}`,
    body: renderNotification('parked', {
      personName: name,
      personEmail: current.primaryEmail,
      reviewReason: 'reinstated_after_day0',
      hrisId: current.hrisId,
      terminationDate: current.terminationDate ?? 'none held',
      reviewHint: reason,
    }),
    audience: 'it',
    detail: { hrisId: current.hrisId, reviewReason: 'reinstated_after_day0' },
  })
  if (result.delivered) return
  ctx.report.ok = false
  ctx.report.warnings.push(
    `${current.hrisId} was frozen as reinstated but the notification was not delivered (${result.error ?? 'no reason given'}). The row is safe; nobody has been told.`,
  )
}

/**
 * The same HR id now names a different person.
 *
 * Rare and dangerous, so it needs all of: the address is not another form of
 * the one we hold, it matches no exit-rename pattern, the person carries no
 * leaving date, the HR system still reports them employed, and no employed row
 * holds the new address. Anything less is an alias, because an alias recorded
 * in error leaves one row a human can correct, while a second identity
 * recorded in error hands out somebody else's account.
 *
 * Returns null when the case does not apply and the caller should take the
 * alias path instead.
 */
async function roleChangeTombstone(
  ctx: RunContext,
  record: HrisPerson,
  current: Person,
  desired: HrisDerivedStatus,
  base: RowBase,
): Promise<SyncRow | null> {
  if (desired === 'terminated' || current.status !== 'active') {
    ctx.report.warnings.push(
      `${record.hrisId} (${current.displayName}) has a changed address with status ${current.status}, so it was kept as one row with the old address as an alias rather than treated as a new person.`,
    )
    return null
  }

  // The shared implementation, so the sync and the engine cannot hold two
  // opinions about who counts as employed.
  const claimant = claimedByLivePerson(record.primaryEmail ?? '', ctx.stored, ctx.identity.domain, {
    exceptHrisId: record.hrisId,
  })
  if (claimant) {
    if (!ctx.dryRun) await ctx.people.patch(current.hrisId, { reviewReason: 'identity_claimed_by_live_person' })
    return row(
      base,
      'parked',
      current.status,
      `The incoming address is already held by employed row ${claimant.hrisId}, so this is a data fault rather than a new identity.`,
      { reviewReason: 'identity_claimed_by_live_person', changedFields: ['reviewReason'] },
    )
  }

  const note =
    `HR id reused: the address changed to one that is not an alias, matches no exit-rename pattern and carries no leaving date, so this row was closed on ${ctx.today}. ` +
    `The new identity needs its own HR record, because one HR id can only ever be one row here.`
  if (!ctx.dryRun) {
    const result = await ctx.people.transition({
      hrisId: current.hrisId,
      expectFrom: 'active',
      event: 'sync.role_change_tombstone',
      owner: 'sync',
      reason: note,
    })
    if (!result.ok) {
      ctx.report.ok = false
      ctx.report.errors.push(`${current.hrisId}: the store refused the role-change tombstone (${result.reason}).`)
      return row(base, 'refused', current.status, result.reason)
    }
  }
  ctx.report.warnings.push(`${current.hrisId} was tombstoned as a reused HR id. ${note}`)
  return row(base, 'tombstoned', 'departed', note, { changedFields: ['status', 'note'] })
}

/**
 * A row that is already terminated and was never parked.
 *
 * The lookback check belongs on the transition into `terminated`; this is the
 * same check applied to a row that arrived there before the rule existed, or
 * through an import. It only ever sets the reason and never clears it, so the
 * next run writes nothing.
 */
async function parkLateTermination(
  ctx: RunContext,
  record: HrisPerson,
  current: Person,
  base: RowBase,
): Promise<SyncRow | null> {
  if (current.status !== 'terminated' || current.reviewReason || current.offboarding?.suspendedAt) return null
  const date = leaveDateOf(record) ?? leaveDateOf(current)
  if (!terminationOutsideLookback(date, ctx.today, ctx.terminationLookbackDays)) return null

  if (!ctx.dryRun) await ctx.people.patch(current.hrisId, { reviewReason: 'termination_older_than_lookback' })
  return row(base, 'parked', 'terminated', lookbackReason(date, ctx.terminationLookbackDays), {
    reviewReason: 'termination_older_than_lookback',
    changedFields: [...base.changedFields, 'reviewReason'],
  })
}

function lookbackReason(date: string | null | undefined, lookbackDays: number): string {
  return isBlank(date)
    ? 'Terminated with no leaving date held by the HR system, so it may be historic. Parked rather than offboarded, and left as terminated so the row still protects its own identifiers.'
    : `Terminated with a leaving date of ${String(date)}, older than the ${lookbackDays}-day lookback, so it may be historic. Parked rather than offboarded.`
}

async function statusChange(
  ctx: RunContext,
  record: HrisPerson,
  current: Person,
  desired: HrisDerivedStatus,
  base: RowBase,
): Promise<SyncRow> {
  const event = EVENT_FOR[desired]
  const patch: Partial<Person> = {}
  let reviewReason: ReviewReason | null = current.reviewReason ?? null
  let reason = `HR status moved from ${current.status} to ${desired}.`

  if (desired === 'terminated') {
    const date = leaveDateOf(record) ?? leaveDateOf(current)
    if (terminationOutsideLookback(date, ctx.today, ctx.terminationLookbackDays)) {
      // The status stays truthful. Parking it as active instead would let a
      // leaver go on shielding their own identifiers from the engine's
      // identity check, which is the opposite of what a park is for.
      reviewReason = 'termination_older_than_lookback'
      patch.reviewReason = reviewReason
      reason = `${reason} ${lookbackReason(date, ctx.terminationLookbackDays)}`
    }
  }

  if (ctx.dryRun) return row(base, 'status_changed', desired, reason, { reviewReason })

  if ((await auditStatusWrite(ctx, current, desired, event, 'intent')) === 'refused') {
    return row(base, 'refused', current.status, 'The audit sink would not accept the intent row, so the status was not written.')
  }
  const result = await ctx.people.transition({
    hrisId: current.hrisId,
    expectFrom: current.status,
    event,
    owner: 'sync',
    patch,
  })
  await auditStatusWrite(ctx, current, desired, event, 'outcome', result.ok)

  if (!result.ok) {
    ctx.report.ok = false
    ctx.report.errors.push(`${current.hrisId}: the store refused ${event} (${result.refusal}: ${result.reason}).`)
    return row(base, 'refused', current.status, result.reason)
  }
  ctx.logger.info('lifecycle status changed', { hrisId: current.hrisId, from: current.status, to: desired, reviewReason })
  return row(base, 'status_changed', desired, reason, { reviewReason })
}

/**
 * Record a status write, before and after.
 *
 * An intent row that cannot be persisted stops the write. That is the audit
 * contract: the log has to be able to describe a change that was started and
 * whose result was never learned.
 */
async function auditStatusWrite(
  ctx: RunContext,
  current: Person,
  desired: HrisDerivedStatus,
  event: TransitionEvent,
  phase: 'intent' | 'outcome',
  ok?: boolean,
): Promise<'written' | 'refused' | 'no_sink'> {
  if (!ctx.audit) return 'no_sink'
  try {
    await ctx.audit.append({
      at: (ctx.clock ?? new SystemClock()).nowIso(),
      runId: ctx.runId ?? 'sync',
      phase,
      actor: ctx.actor ?? { kind: 'system', id: 'system:sync' },
      action: `sync.transition.${event}`,
      subject: { kind: 'person', id: current.hrisId, label: current.displayName },
      dryRun: ctx.dryRun,
      // A store transition is a compare-and-set that returns the written row,
      // so the store's own answer is the read-back.
      ...(phase === 'outcome' ? { ok: ok === true, verified: ok === true } : {}),
      detail: { from: current.status, to: desired },
    })
    return 'written'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.report.ok = false
    ctx.report.errors.push(`${current.hrisId}: audit ${phase} row could not be written (${message}).`)
    return 'refused'
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  return false
}

/** Build the record the store merges. Status is used only when creating. */
function toPerson(record: HrisPerson, status: LifecycleStatus, source: string): Person {
  return {
    hrisId: record.hrisId,
    status,
    primaryEmail: record.primaryEmail ?? '',
    aliasEmails: [],
    displayName: record.displayName,
    firstName: record.firstName ?? null,
    lastName: record.lastName ?? null,
    department: record.department ?? null,
    jobTitle: record.jobTitle ?? null,
    site: record.site ?? null,
    managerEmail: record.managerEmail ?? null,
    personalEmail: record.personalEmail ?? null,
    startDate: record.startDate ?? null,
    terminationDate: record.terminationDate ?? null,
    lastWorkingDay: record.lastWorkingDay ?? null,
    inScope: record.inScope ?? null,
    hold: false,
    holdReason: null,
    reviewReason: null,
    externalIds: {},
    googleAccountPresent: null,
    offboarding: null,
    note: null,
    source,
  }
}

/** Non-blank HR values that differ from what is stored. Blanks never erase. */
function preservedRowPatch(stored: Person, record: HrisPerson): Partial<Person> {
  const incoming = toPerson(record, stored.status, stored.source ?? 'hris')
  const patch: Record<string, unknown> = {}
  for (const field of PRESERVED_ROW_FIELDS) {
    const next = incoming[field]
    if (isBlank(next) || next === stored[field]) continue
    patch[field] = next
  }
  return patch as Partial<Person>
}
