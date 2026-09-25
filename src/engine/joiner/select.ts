/**
 * Who is due for activation today.
 *
 * Pure functions over the rows, like the leaver selection, so the rule can be
 * read and tested without a provider in sight.
 */

import type { IsoDate } from '../../core/clock.ts'
import type { Person } from '../../core/types.ts'
import { addWorkingDays } from './workdays.ts'

export interface JoinerSelectionOptions {
  today: IsoDate
  leadWorkingDays: number
  holidays: ReadonlySet<string>
}

export type JoinerSkipReason =
  | 'not_employed'
  | 'held'
  | 'parked'
  | 'already_activated'
  | 'refused'
  | 'out_of_scope'
  | 'no_start_date'
  | 'starts_later'
  | 'no_address'

/** Why a row is not a candidate today, or null when it is. */
export function joinerSkipReason(person: Person, opts: JoinerSelectionOptions): JoinerSkipReason | null {
  if (person.status !== 'hired' && person.status !== 'active') return 'not_employed'
  if (person.hold) return 'held'
  if (person.reviewReason) return 'parked'
  if (person.activation?.activatedAt) return 'already_activated'
  if (person.activation?.refusedReason) return 'refused'
  // Only an explicit no excludes. Unknown reads as in scope; see HrisPerson.
  if (person.inScope === false) return 'out_of_scope'
  if (!person.primaryEmail) return 'no_address'
  if (!person.startDate) return 'no_start_date'
  const horizon = addWorkingDays(opts.today, opts.leadWorkingDays, opts.holidays)
  if (person.startDate > horizon) return 'starts_later'
  return null
}

export function selectJoiners(people: readonly Person[], opts: JoinerSelectionOptions): Person[] {
  return people
    .filter((person) => joinerSkipReason(person, opts) === null)
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.hrisId.localeCompare(b.hrisId))
}
