/**
 * Prevents: date arithmetic done by cutting the time off a UTC timestamp.
 *
 * An earlier design computed "today" as `toISOString().slice(0, 10)`.
 * In a zone ahead of UTC, every moment between local midnight and the UTC
 * offset falls on the previous UTC day, so for the first hour of every summer
 * day the pipeline believed it was yesterday. Everything keyed on the day
 * count since suspension moved with it: a leaver's deletion day arrived early
 * for anybody whose offboarding started in that window.
 *
 * The date pinned below is 00:30 local time in a zone one hour ahead of UTC,
 * which is the exact case that failed.
 */

import { describe, expect, it } from 'vitest'
import { addDays, daysBetween, FakeClock } from '../../src/core/clock.ts'

const ZONE = 'Europe/London'
/** 2026-07-01T00:30 in a UTC+1 zone is 2026-06-30T23:30 in UTC. */
const JUST_AFTER_LOCAL_MIDNIGHT = '2026-06-30T23:30:00Z'

describe('today() at 00:30 in a zone ahead of UTC', () => {
  const clock = new FakeClock(JUST_AFTER_LOCAL_MIDNIGHT)

  it('is the local calendar date, not the UTC one', () => {
    expect(clock.today(ZONE)).toBe('2026-07-01')
  })

  it('is one day later than the defective calculation, which is the bug', () => {
    // Kept as a live assertion rather than a comment: this is the value the
    // old code produced, and seeing the two side by side is the point.
    expect(clock.nowIso().slice(0, 10)).toBe('2026-06-30')
    expect(clock.today(ZONE)).not.toBe(clock.nowIso().slice(0, 10))
  })

  it('does not bring a day-7 deletion forward by a day', () => {
    const suspendedAt = '2026-06-24'
    const today = clock.today(ZONE)
    expect(daysBetween(suspendedAt, today)).toBe(7)
    // The defective calculation made it 6, so the row was selected a day early
    // and every subsequent day count was out by one.
    expect(daysBetween(suspendedAt, clock.nowIso().slice(0, 10))).toBe(6)
    expect(addDays(suspendedAt, 7)).toBe(today)
  })

  it('behaves the same at 00:30 in a zone behind UTC, where the naive form happens to work', () => {
    // A test that only covers the zone where the bug bites would pass on a
    // reimplementation that had simply moved the error somewhere else.
    const behind = new FakeClock('2026-07-01T04:30:00Z')
    expect(behind.today('America/New_York')).toBe('2026-07-01')
    expect(behind.today(ZONE)).toBe('2026-07-01')
  })
})
