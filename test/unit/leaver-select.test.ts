import { describe, expect, it } from 'vitest'
import { addDays } from '../../src/core/clock.ts'
import type { Person } from '../../src/core/types.ts'
import {
  deleteCutoff,
  loadDay0Candidates,
  loadDay6Candidates,
  loadDay7Candidates,
  loadLiveClaims,
  selectDay0,
  selectDay6,
  selectDay7,
  terminationCutoff,
  transferCutoff,
} from '../../src/engine/leaver/select.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { leaverConfig, personFixture, suspendedPersonFixture, TODAY } from '../fixtures/leaver/harness.ts'

const cfg = leaverConfig()

function ids(people: readonly Person[]): string[] {
  return people.map((p) => p.hrisId)
}

describe('day-0 selection', () => {
  it('selects a terminated row with a recent leaving date and no marker', () => {
    expect(ids(selectDay0([personFixture()], TODAY, cfg))).toEqual(['hris-0001'])
  })

  it('never selects a row that already carries the day-0 marker', () => {
    // The marker is the idempotency key, and it is the only thing that held
    // back a hundred historic leavers when a migration made them look new.
    const done = personFixture({ offboarding: { suspendedAt: TODAY, legs: {} } })
    expect(selectDay0([done], TODAY, cfg)).toEqual([])
  })

  it('never selects a held or a parked row', () => {
    const held = personFixture({ hrisId: 'hris-held', hold: true })
    const parked = personFixture({ hrisId: 'hris-parked', reviewReason: 'termination_older_than_lookback' })
    expect(selectDay0([held, parked], TODAY, cfg)).toEqual([])
  })

  it('never selects a leaving date older than the lookback', () => {
    const stale = personFixture({ terminationDate: addDays(TODAY, -cfg.leaver.terminationLookbackDays - 1) })
    expect(selectDay0([stale], TODAY, cfg)).toEqual([])
    const edge = personFixture({ terminationDate: terminationCutoff(TODAY, cfg) })
    expect(ids(selectDay0([edge], TODAY, cfg))).toEqual(['hris-0001'])
  })

  it('never selects a row with no leaving date at all', () => {
    // A row with no date cannot be aged, so acting on it is the same as acting
    // on a record nobody has looked at in years.
    expect(selectDay0([personFixture({ terminationDate: null })], TODAY, cfg)).toEqual([])
  })

  it('only selects rows in terminated', () => {
    for (const status of ['hired', 'active', 'offboarding', 'departed'] as const) {
      expect(selectDay0([personFixture({ status })], TODAY, cfg)).toEqual([])
    }
  })
})

describe('day-6 selection', () => {
  const due = transferCutoff(TODAY, cfg)

  it('selects on or before the hand-over day, so a missed run still runs', () => {
    const onTheDay = suspendedPersonFixture(due)
    const late = suspendedPersonFixture(addDays(due, -3), { hrisId: 'hris-late' })
    expect(ids(selectDay6([onTheDay, late], TODAY, cfg)).sort()).toEqual(['hris-0001', 'hris-late'])
  })

  it('does not select a row whose hand-over already completed', () => {
    const done = suspendedPersonFixture(due, {
      offboarding: { suspendedAt: due, legs: {}, transferredAt: `${TODAY}T08:00:00.000Z` },
    })
    expect(selectDay6([done], TODAY, cfg)).toEqual([])
  })

  it('does not select a row where a person waived the hand-over', () => {
    const waived = suspendedPersonFixture(due, {
      offboarding: { suspendedAt: due, legs: {}, transferOverride: 'IT accepted: no recipient' },
    })
    expect(selectDay6([waived], TODAY, cfg)).toEqual([])
  })

  it('does not select a row with no day-0 marker at all', () => {
    // Without the marker there is no day to count from, so day 6 means
    // nothing for that row and day 0 is what it needs.
    const noMarker = personFixture({ status: 'offboarding', offboarding: { suspendedAt: null, legs: {} } })
    expect(selectDay6([noMarker], TODAY, cfg)).toEqual([])
    expect(selectDay7([noMarker], TODAY, cfg)).toEqual([])
  })

  it('does not select a held or parked row on the later days either', () => {
    const held = suspendedPersonFixture(due, { hrisId: 'hris-held', hold: true })
    const parked = suspendedPersonFixture(due, { hrisId: 'hris-parked', reviewReason: 'max_leg_attempts' })
    expect(selectDay6([held, parked], TODAY, cfg)).toEqual([])
    expect(selectDay7([held, parked], TODAY, cfg)).toEqual([])
  })

  it('does not select before the hand-over day', () => {
    expect(selectDay6([suspendedPersonFixture(addDays(due, 1))], TODAY, cfg)).toEqual([])
  })
})

describe('day-7 selection', () => {
  const due = deleteCutoff(TODAY, cfg)

  it('re-selects a blocked row every run, because the gate is evaluated live', () => {
    const blocked = suspendedPersonFixture(due, {
      offboarding: { suspendedAt: due, legs: {}, deleteBlockedReason: 'devices_bound', boundDevices: [] },
    })
    expect(ids(selectDay7([blocked], TODAY, cfg))).toEqual(['hris-0001'])
  })

  it('does not select before the deletion day, and does select on or after it', () => {
    expect(selectDay7([suspendedPersonFixture(addDays(due, 1))], TODAY, cfg)).toEqual([])
    expect(ids(selectDay7([suspendedPersonFixture(addDays(due, -30))], TODAY, cfg))).toEqual(['hris-0001'])
  })
})

describe('the store-backed selections', () => {
  it('agree with the pure ones and exclude held and parked rows in the query', async () => {
    const store = new MemoryPeopleStore({
      seed: [
        personFixture(),
        personFixture({ hrisId: 'hris-held', hold: true }),
        suspendedPersonFixture(transferCutoff(TODAY, cfg), { hrisId: 'hris-day6' }),
        suspendedPersonFixture(deleteCutoff(TODAY, cfg), { hrisId: 'hris-day7' }),
      ],
    })
    expect(ids(await loadDay0Candidates(store, TODAY, cfg))).toEqual(['hris-0001'])
    expect(ids(await loadDay6Candidates(store, TODAY, cfg)).sort()).toEqual(['hris-day6', 'hris-day7'])
    expect(ids(await loadDay7Candidates(store, TODAY, cfg))).toEqual(['hris-day7'])
  })

  it('includes a HELD live row in the identity claims', async () => {
    // Hold stops the automation acting on that person. It must not stop them
    // being protected from somebody else's offboarding, which is the exact
    // case hold gets reached for.
    const store = new MemoryPeopleStore({
      seed: [personFixture({ hrisId: 'hris-live', status: 'active', hold: true }), personFixture()],
    })
    expect(ids(await loadLiveClaims(store))).toEqual(['hris-live'])
  })
})
