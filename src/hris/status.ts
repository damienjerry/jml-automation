/**
 * The status an HR record implies, on its own.
 *
 * Lives in the HR layer rather than the engine because two callers need the
 * same answer: the sync, which moves rows, and the bootstrap, which decides
 * who is a historic leaver. When the bootstrap had its own idea (absent from
 * the employed list means left) it tombstoned every starter who had not
 * started yet, because the HR system keeps them off the employed list until
 * their first day. The next sync then reported each of them as employed with a
 * terminal tombstone, and the only remedy was a new HR record.
 */

import type { IsoDate } from '../core/clock.ts'
import { leaveDateOf } from './leave-date.ts'
import type { HrisPerson } from './types.ts'

/** The three statuses an HR snapshot can imply on its own. */
export type HrisDerivedStatus = 'hired' | 'active' | 'terminated'

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Employment comes from the snapshot's employed set, never from a status word
 * on the record: a lifecycle label means different things in different HR
 * systems, and absence from the employed list is the one signal that travels.
 * The one exception is a start date in the future, which is read before the
 * employed set because HR systems leave a person off that set until they
 * start.
 */
export function deriveHrisStatus(record: HrisPerson, activeIds: ReadonlySet<string>, today: IsoDate): HrisDerivedStatus {
  const start = record.startDate
  if (start && ISO_DATE.test(start) && start > today) return 'hired'
  if (!activeIds.has(record.hrisId)) return 'terminated'
  // Still on the employed list, but past the day they were last in. HR
  // systems keep somebody employed until the contract ends; access should not
  // wait for that. Offboarding starts the day AFTER the leave date, so on the
  // day itself the person is still active and can hand over.
  const leave = leaveDateOf(record)
  if (leave !== null && today > leave) return 'terminated'
  return 'active'
}
