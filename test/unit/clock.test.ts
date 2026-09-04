import { describe, expect, it } from 'vitest'
import { addDays, assertIsoDate, dateInZone, daysBetween, FakeClock, isBefore, SystemClock, weekdayOf } from '../../src/core/clock.ts'

describe('dateInZone', () => {
  it('reads the calendar date in the named zone', () => {
    expect(dateInZone(new Date('2026-07-01T12:00:00Z'), 'Europe/London')).toBe('2026-07-01')
    expect(dateInZone(new Date('2026-07-01T12:00:00Z'), 'America/New_York')).toBe('2026-07-01')
    expect(dateInZone(new Date('2026-07-01T02:00:00Z'), 'America/New_York')).toBe('2026-06-30')
  })

  it('names the zone when it is not a real one', () => {
    expect(() => dateInZone(new Date(), 'Europe/Nowhere')).toThrow(/must be an IANA name/)
  })
})

describe('addDays', () => {
  it('crosses a month, a year and a leap day', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('is unaffected by a daylight saving transition', () => {
    // Adding 86,400,000 milliseconds to a local timestamp is the other way to
    // write this, and it is wrong on the two days a year the offset moves.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29')
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25')
  })
})

describe('daysBetween and comparison', () => {
  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-09-01', '2026-09-08')).toBe(7)
    expect(daysBetween('2026-09-08', '2026-09-01')).toBe(-7)
    expect(daysBetween('2026-09-08', '2026-09-08')).toBe(0)
  })

  it('counts across a daylight saving boundary without losing an hour', () => {
    expect(daysBetween('2026-03-28', '2026-04-04')).toBe(7)
  })

  it('orders dates as strings, which ISO dates allow', () => {
    expect(isBefore('2026-09-01', '2026-09-02')).toBe(true)
    expect(isBefore('2026-09-02', '2026-09-01')).toBe(false)
  })

  it('rejects anything that is not an ISO calendar date', () => {
    expect(() => assertIsoDate('01/09/2026')).toThrow()
    expect(() => addDays('2026-9-1', 1)).toThrow()
  })
})

describe('weekdayOf', () => {
  it('names the weekday of a date', () => {
    expect(weekdayOf('2026-09-07')).toBe('monday')
    expect(weekdayOf('2026-09-13')).toBe('sunday')
  })
})

describe('FakeClock', () => {
  it('is fixed until it is moved', () => {
    const clock = new FakeClock('2026-09-04T09:00:00Z')
    expect(clock.today('Europe/London')).toBe('2026-09-04')
    clock.advanceDays(3)
    expect(clock.today('Europe/London')).toBe('2026-09-07')
    clock.set('2027-01-01T00:00:00Z')
    expect(clock.today('Europe/London')).toBe('2027-01-01')
  })

  it('hands out copies, so a caller cannot move it by mutating a Date', () => {
    const clock = new FakeClock('2026-09-04T09:00:00Z')
    clock.now().setUTCFullYear(1999)
    expect(clock.today('Europe/London')).toBe('2026-09-04')
  })
})

describe('SystemClock', () => {
  it('agrees with itself', () => {
    const clock = new SystemClock()
    expect(clock.today('UTC')).toBe(clock.nowIso().slice(0, 10))
  })
})
