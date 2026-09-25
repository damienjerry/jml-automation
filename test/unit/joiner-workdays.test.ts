import { describe, expect, it } from 'vitest'
import { addWorkingDays, isWorkingDay } from '../../src/engine/joiner/workdays.ts'

describe('working days', () => {
  const none = new Set<string>()
  it('skips weekends', () => {
    // 2026-01-15 is a Thursday. Three working days on is Tuesday the 20th.
    expect(addWorkingDays('2026-01-15', 3, none)).toBe('2026-01-20')
  })
  it('skips supplied holidays', () => {
    expect(addWorkingDays('2026-01-15', 3, new Set(['2026-01-19']))).toBe('2026-01-21')
    expect(isWorkingDay('2026-01-19', new Set(['2026-01-19']))).toBe(false)
  })
  it('returns the same day for zero', () => {
    expect(addWorkingDays('2026-01-17', 0, none)).toBe('2026-01-17')
  })
})
