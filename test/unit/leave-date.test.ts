import { describe, expect, it } from 'vitest'
import { leaveDateOf, leaveDateSource } from '../../src/hris/leave-date.ts'

describe('which date ends access', () => {
  it('uses the last working day when it is before the termination date', () => {
    const p = { startDate: '2024-01-08', terminationDate: '2026-03-31', lastWorkingDay: '2026-03-27' }
    expect(leaveDateOf(p)).toBe('2026-03-27')
    expect(leaveDateSource(p)).toBe('lastWorkingDay')
  })

  it('uses the last working day when the two are the same day', () => {
    const p = { terminationDate: '2026-03-31', lastWorkingDay: '2026-03-31' }
    expect(leaveDateOf(p)).toBe('2026-03-31')
    expect(leaveDateSource(p)).toBe('lastWorkingDay')
  })

  // A last day in after the contract has ended is a data error; the contract
  // end is the safer of the two because it is the earlier one.
  it('ignores a last working day after the termination date', () => {
    const p = { terminationDate: '2026-03-31', lastWorkingDay: '2026-04-03' }
    expect(leaveDateOf(p)).toBe('2026-03-31')
    expect(leaveDateSource(p)).toBe('terminationDate')
  })

  it('falls back to the termination date when no last working day is held', () => {
    expect(leaveDateOf({ terminationDate: '2026-03-31' })).toBe('2026-03-31')
    expect(leaveDateOf({ terminationDate: '2026-03-31', lastWorkingDay: null })).toBe('2026-03-31')
  })

  it('uses the last working day alone when there is no termination date', () => {
    expect(leaveDateOf({ lastWorkingDay: '2026-03-27' })).toBe('2026-03-27')
  })

  // Somebody who left and came back keeps their old leaving date in some HR
  // systems. Reading it would offboard the rehire on their first morning.
  it('ignores a leaving date before the current start date as an earlier stint', () => {
    expect(leaveDateOf({ startDate: '2026-02-01', terminationDate: '2025-06-30' })).toBeNull()
    expect(leaveDateOf({ startDate: '2026-02-01', terminationDate: '2026-06-30', lastWorkingDay: '2025-06-30' })).toBe(
      '2026-06-30',
    )
  })

  it('returns null when nothing usable is held', () => {
    expect(leaveDateOf({})).toBeNull()
    expect(leaveDateOf({ terminationDate: '31/03/2026' })).toBeNull()
    expect(leaveDateSource({})).toBeNull()
  })
})
