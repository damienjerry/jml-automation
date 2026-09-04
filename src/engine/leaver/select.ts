/**
 * Who the leaver engine acts on today.
 *
 * The selections are pure functions over rows, and the store queries that feed
 * them are thin. That split is deliberate: the question "would this person be
 * suspended today" has to be answerable in a test, at any date, without a
 * database, because it is the question every incident in this family turned on.
 *
 * Four rules are encoded here rather than left to the caller.
 *
 *  - A row that already carries the day-0 marker is never selected for day 0
 *    again. The marker is the idempotency key, and it is the single field that
 *    held back a hundred-odd historic leavers when a migration made them all
 *    look new.
 *  - A leaving date older than the configured lookback is not selected at all.
 *    A stale record is the usual cause of a sudden crowd of leavers.
 *  - Day 6 and day 7 select on or before their day, never on the day exactly.
 *    Keying on "the day is exactly six days ago" means a missed run silently
 *    skips the hand-over, and the deletion then arrives anyway.
 *  - Held and parked rows are excluded from everything. Both are how a person
 *    stops the automation touching somebody, so both have to be honoured in
 *    the query as well as in the loop.
 */

import { addDays } from '../../core/clock.ts'
import type { JmlConfig } from '../../config/schema.ts'
import type { Person } from '../../core/types.ts'
import { DAY0_SELECTION } from '../../store/bootstrap.ts'
import type { PeopleStore } from '../../store/types.ts'

/** Statuses that mean somebody still works here, and so claims their accounts. */
const LIVE_STATUSES = ['hired', 'active'] as const

/** The date part of a stored marker, so a date and a timestamp compare alike. */
function day(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.slice(0, 10)
}

function isActionable(person: Person): boolean {
  return !person.hold && !person.reviewReason
}

/** The earliest leaving date the engine will act on. */
export function terminationCutoff(today: string, cfg: JmlConfig): string {
  return addDays(today, -cfg.leaver.terminationLookbackDays)
}

/** Suspension dates on or before this are due their hand-over. */
export function transferCutoff(today: string, cfg: JmlConfig): string {
  return addDays(today, -cfg.leaver.transferDay)
}

/** Suspension dates on or before this are due deletion. */
export function deleteCutoff(today: string, cfg: JmlConfig): string {
  return addDays(today, -cfg.leaver.deleteDay)
}

/**
 * Day 0: suspend today.
 *
 * The termination date is required, not merely checked against the lookback.
 * A terminated row with no date at all cannot be aged, and acting on one is
 * indistinguishable from acting on a record nobody has looked at for years.
 */
export function selectDay0(people: readonly Person[], today: string, cfg: JmlConfig): Person[] {
  const cutoff = terminationCutoff(today, cfg)
  return people.filter((person) => {
    if (person.status !== 'terminated') return false
    if (!isActionable(person)) return false
    if (day(person.offboarding?.suspendedAt) !== null) return false
    const leaving = day(person.terminationDate)
    return leaving !== null && leaving >= cutoff
  })
}

/** Day 6: hand the files over, then close the Google account. */
export function selectDay6(people: readonly Person[], today: string, cfg: JmlConfig): Person[] {
  const cutoff = transferCutoff(today, cfg)
  return people.filter((person) => {
    if (person.status !== 'offboarding') return false
    if (!isActionable(person)) return false
    const suspended = day(person.offboarding?.suspendedAt)
    if (suspended === null || suspended > cutoff) return false
    if (day(person.offboarding?.transferredAt) !== null) return false
    // An override is a person saying the hand-over is not going to happen.
    // Re-selecting the row would start a transfer they decided against.
    return !person.offboarding?.transferOverride
  })
}

/**
 * Day 7: delete.
 *
 * Blocked rows are selected again every run on purpose. The gate is evaluated
 * live against the provider, so yesterday's blockage is not evidence about
 * today, and a row that has quietly become deletable must not wait for
 * somebody to notice. What is change-only is the notification, not the check.
 */
export function selectDay7(people: readonly Person[], today: string, cfg: JmlConfig): Person[] {
  const cutoff = deleteCutoff(today, cfg)
  return people.filter((person) => {
    if (person.status !== 'offboarding') return false
    if (!isActionable(person)) return false
    const suspended = day(person.offboarding?.suspendedAt)
    return suspended !== null && suspended <= cutoff
  })
}

/**
 * Day-0 candidates from the store.
 *
 * The filter is the shared `DAY0_SELECTION` rather than a second copy of the
 * same conditions, so the engine, `jml store verify` and the bootstrap check
 * cannot drift into three slightly different ideas of the same set. The
 * lookback is applied afterwards because it is a date comparison the store
 * filter does not express.
 */
export async function loadDay0Candidates(store: PeopleStore, today: string, cfg: JmlConfig): Promise<Person[]> {
  const rows = await store.list(DAY0_SELECTION)
  return selectDay0(rows, today, cfg)
}

export async function loadDay6Candidates(store: PeopleStore, today: string, cfg: JmlConfig): Promise<Person[]> {
  const rows = await store.list({
    status: ['offboarding'],
    excludeHeld: true,
    parked: false,
    suspendedOnOrBefore: transferCutoff(today, cfg),
  })
  return selectDay6(rows, today, cfg)
}

export async function loadDay7Candidates(store: PeopleStore, today: string, cfg: JmlConfig): Promise<Person[]> {
  const rows = await store.list({
    status: ['offboarding'],
    excludeHeld: true,
    parked: false,
    suspendedOnOrBefore: deleteCutoff(today, cfg),
  })
  return selectDay7(rows, today, cfg)
}

/**
 * Everybody who still works here, for the identity-protection check.
 *
 * Held rows are included, and that is not an oversight. Hold stops the
 * automation acting on the person it is set on; it must not stop that person's
 * account and address being protected from somebody else's offboarding. The
 * incident behind this is a leaver's row inheriting a live colleague's account
 * id, and the colleague's row being held was what somebody had reached for as
 * the emergency stop.
 */
export async function loadLiveClaims(store: PeopleStore): Promise<Person[]> {
  return store.list({ status: [...LIVE_STATUSES] })
}
