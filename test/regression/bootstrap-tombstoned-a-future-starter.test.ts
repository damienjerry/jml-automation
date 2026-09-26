/**
 * A bootstrap against a real HR tenant tombstoned every person who had not
 * started yet.
 *
 * The HR system keeps a starter off the employed list until their first day,
 * and the bootstrap read "not on the employed list" as "historic leaver". The
 * very next sync then warned that each of them was tombstoned while the HR
 * system reported them as employed, and a tombstone is terminal, so the only
 * remedy on offer was a new HR record for somebody who had done nothing wrong.
 * The bootstrap now applies the same derivation as the sync, under which a
 * future start date is read before the employed set.
 */
import { describe, expect, it } from 'vitest'
import type { HrisPerson, HrisSnapshot } from '../../src/hris/types.ts'
import { deriveHrisStatus } from '../../src/hris/status.ts'
import { bootstrapTombstones } from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'

const TODAY = '2026-03-10'

const LEFT_LONG_AGO: HrisPerson = {
  hrisId: 'hr-left',
  primaryEmail: 'jane.doe@example.com',
  displayName: 'Jane Doe',
  startDate: '2019-04-01',
  terminationDate: '2021-06-30',
}

const STARTS_MONDAY: HrisPerson = {
  hrisId: 'hr-starter',
  primaryEmail: 'john.doe@example.com',
  displayName: 'John Doe',
  startDate: '2026-03-16',
  terminationDate: null,
}

const EMPLOYED: HrisPerson = {
  hrisId: 'hr-anchor',
  primaryEmail: 'ann.other@example.com',
  displayName: 'Ann Other',
  startDate: '2020-06-01',
  terminationDate: null,
}

/** As the HR system serves it: the starter is off the employed list. */
function snapshot(): HrisSnapshot {
  return {
    all: [LEFT_LONG_AGO, STARTS_MONDAY, EMPLOYED],
    activeIds: new Set([EMPLOYED.hrisId]),
    fetchedAt: `${TODAY}T08:00:00.000Z`,
    complete: true,
  }
}

describe('a starter who has not started yet', () => {
  it('is hired, not terminated, under the shared derivation', () => {
    expect(deriveHrisStatus(STARTS_MONDAY, snapshot().activeIds, TODAY)).toBe('hired')
  })

  it('is left alone by the bootstrap and counted as such', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    const report = await bootstrapTombstones({ people, snapshot: snapshot(), today: TODAY })

    expect(report.skippedHired).toBe(1)
    expect(report.inactive).toBe(1)
    expect(report.tombstoned).toBe(1)
    expect(report.skippedActive).toBe(1)
    expect(await people.get(STARTS_MONDAY.hrisId)).toBeNull()
    expect((await people.get(LEFT_LONG_AGO.hrisId))?.status).toBe('departed')
    expect(report.warnings).toEqual([])
  })

  it('is tombstoned like anybody else once the start date has passed and they are not employed', async () => {
    // Somebody who never turned up: the start date is behind us and the HR
    // system does not list them as employed. That is a leaver.
    const people = new MemoryPeopleStore()
    await people.init()
    const report = await bootstrapTombstones({ people, snapshot: snapshot(), today: '2026-03-23' })
    expect(report.skippedHired).toBe(0)
    expect(report.tombstoned).toBe(2)
  })
})
