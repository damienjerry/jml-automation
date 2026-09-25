/**
 * Working-day arithmetic for the activation lead time.
 *
 * A starter's temporary password has to reach their manager before the first
 * morning, so activation happens a few working days ahead. Weekends never
 * count. Public holidays are data the adopter supplies, because the toolkit
 * must not depend on somebody else's calendar endpoint answering on the
 * morning a starter arrives.
 */

import { addDays, weekdayOf, type IsoDate } from '../../core/clock.ts'

export function isWorkingDay(date: IsoDate, holidays: ReadonlySet<string>): boolean {
  const day = weekdayOf(date)
  return day !== 'saturday' && day !== 'sunday' && !holidays.has(date)
}

/** The date `count` working days after `from`. Zero returns `from` itself. */
export function addWorkingDays(from: IsoDate, count: number, holidays: ReadonlySet<string>): IsoDate {
  let cursor = from
  let left = count
  while (left > 0) {
    cursor = addDays(cursor, 1)
    if (isWorkingDay(cursor, holidays)) left -= 1
  }
  return cursor
}
