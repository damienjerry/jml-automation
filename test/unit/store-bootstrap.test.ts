/**
 * `jml store bootstrap` and `jml store verify`.
 *
 * The first thing anybody does with a new store is import their whole HR
 * history as tombstones. These tests hold that command to the promise it
 * makes: after it runs, nobody historic is selectable for offboarding.
 */

import { describe, expect, it } from 'vitest'
import { HrisIncomplete, type HrisPerson, type HrisSnapshot } from '../../src/hris/types.ts'
import {
  bootstrapTombstones,
  checkDepartedInvariant,
  DAY0_SELECTION,
  DEPARTED_COUNTER,
  verifyStore,
} from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { SqliteStateStore } from '../../src/store/state-sqlite.ts'

function person(index: number, overrides: Partial<HrisPerson> = {}): HrisPerson {
  const id = `hris-${String(index).padStart(4, '0')}`
  return {
    hrisId: id,
    primaryEmail: `${id}@example.com`,
    displayName: `Person ${index}`,
    department: 'Operations',
    startDate: '2019-04-01',
    terminationDate: '2021-06-30',
    ...overrides,
  }
}

function snapshot(all: HrisPerson[], activeIds: string[] = []): HrisSnapshot {
  return { all, activeIds: new Set(activeIds), fetchedAt: '2026-03-31T09:00:00.000Z', complete: true }
}

const leavers = Array.from({ length: 300 }, (_, index) => person(index))

describe('bootstrapping a full HR history', () => {
  it('turns 300 inactive people into 300 tombstones and no offboarding cases', async () => {
    const people = new MemoryPeopleStore()
    await people.init()

    const report = await bootstrapTombstones({ people, snapshot: snapshot(leavers), today: '2026-03-31' })

    expect(report.inactive).toBe(300)
    expect(report.tombstoned).toBe(300)
    expect(report.departedAfter).toBe(300)
    // The whole point: not one of them is selectable, so arming the engine
    // straight afterwards does nothing to anybody.
    expect(report.day0SelectionAfter).toBe(0)
    expect(await people.countExact(DAY0_SELECTION)).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.warnings).toEqual([])

    const one = await people.get('hris-0000')
    expect(one?.status).toBe('departed')
    expect(one?.source).toBe('bootstrap')
    // No Day-0 marker: nothing was suspended, so nothing may claim it was.
    expect(one?.offboarding?.suspendedAt).toBeNull()
    expect(one?.offboarding?.departedAt).toBe('2026-03-31')
  })

  it('does nothing on a second run', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    await bootstrapTombstones({ people, snapshot: snapshot(leavers), today: '2026-03-31' })
    const writesAfterFirst = people.writes

    const again = await bootstrapTombstones({ people, snapshot: snapshot(leavers), today: '2026-04-01' })
    expect(again.tombstoned).toBe(0)
    expect(again.alreadyPresent).toBe(300)
    expect(again.departedAfter).toBe(300)
    expect(people.writes).toBe(writesAfterFirst)
  })

  it('leaves employed people alone', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    const all = [person(1), person(2), person(3)]

    const report = await bootstrapTombstones({
      people,
      snapshot: snapshot(all, ['hris-0002', 'hris-0003']),
      today: '2026-03-31',
    })

    expect(report.skippedActive).toBe(2)
    expect(report.tombstoned).toBe(1)
    expect(await people.get('hris-0002')).toBeNull()
  })

  it('never overwrites a row that already exists, and says which ones', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    // Somebody who left and was rehired. A bootstrap that tombstoned them
    // would be the same mistake in the opposite direction.
    await people.upsert({
      hrisId: 'hris-0001',
      status: 'active',
      primaryEmail: 'hris-0001@example.com',
      aliasEmails: [],
      displayName: 'Person 1',
      hold: false,
      externalIds: {},
      offboarding: null,
    })

    const report = await bootstrapTombstones({ people, snapshot: snapshot([person(1)]), today: '2026-03-31' })

    expect(report.tombstoned).toBe(0)
    expect(report.alreadyPresent).toBe(1)
    expect((await people.get('hris-0001'))?.status).toBe('active')
    expect(report.warnings.join(' ')).toContain('hris-0001')
  })

  it('reports an inactive person with no address instead of inventing one', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    const report = await bootstrapTombstones({
      people,
      snapshot: snapshot([person(1, { primaryEmail: '' })]),
      today: '2026-03-31',
    })

    expect(report.skippedNoEmail).toBe(1)
    expect(report.tombstoned).toBe(0)
    expect(report.warnings.join(' ')).toContain('no email address')
  })

  it('refuses an incomplete snapshot and writes nothing', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    const partial: HrisSnapshot = { ...snapshot(leavers), complete: false }

    // The people missing from a truncated read are exactly the ones who would
    // look like new leavers on the first armed run.
    await expect(bootstrapTombstones({ people, snapshot: partial })).rejects.toThrow(HrisIncomplete)
    expect(people.writes).toBe(0)
  })

  it('writes nothing in a dry run but reports the same numbers', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    const report = await bootstrapTombstones({
      people,
      snapshot: snapshot(leavers),
      today: '2026-03-31',
      dryRun: true,
    })

    expect(report.dryRun).toBe(true)
    expect(report.tombstoned).toBe(300)
    expect(report.departedAfter).toBe(0)
    expect(people.writes).toBe(0)
  })
})

describe('verifying a store before a cutover', () => {
  it('prints the exact Day-0 selection and tombstone counts', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    await bootstrapTombstones({ people, snapshot: snapshot(leavers), today: '2026-03-31' })
    await people.upsert({
      hrisId: 'hris-live',
      status: 'active',
      primaryEmail: 'jane.doe@example.com',
      aliasEmails: [],
      displayName: 'Jane Doe',
      hold: false,
      externalIds: {},
      offboarding: null,
    })

    const report = await verifyStore(people, { day0Selection: 0, departed: 300 })
    expect(report.ok).toBe(true)
    expect(report.counts).toMatchObject({ total: 301, active: 1, departed: 300, day0Selection: 0 })
    expect(report.mismatches).toEqual([])
  })

  it('warns when the store is empty, even with nothing expected', async () => {
    // A lost store, or a config pointed at the wrong path, is empty. With no
    // expectation stated it used to print a clean result.
    const people = new MemoryPeopleStore()
    await people.init()
    const report = await verifyStore(people)
    expect(report.ok).toBe(true)
    expect(report.warnings.join(' ')).toMatch(/holds no rows.*restore it from a backup/)

    await bootstrapTombstones({ people, snapshot: snapshot(leavers), today: '2026-03-31' })
    expect((await verifyStore(people)).warnings).toEqual([])
  })

  it('names each expectation it cannot meet', async () => {
    const people = new MemoryPeopleStore()
    await people.init()

    const report = await verifyStore(people, { day0Selection: 0, departed: 300 })
    expect(report.ok).toBe(false)
    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0]).toContain('expected 300')
  })

  it('counts held and parked rows separately from status', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    await people.upsert({
      hrisId: 'hris-held',
      status: 'terminated',
      primaryEmail: 'jane.doe@example.com',
      aliasEmails: [],
      displayName: 'Jane Doe',
      hold: true,
      holdReason: 'A person is looking at this',
      externalIds: {},
      offboarding: null,
    })

    const report = await verifyStore(people)
    expect(report.counts.held).toBe(1)
    expect(report.counts.terminated).toBe(1)
    // A held row is not selectable, which is what makes the flag a usable
    // stop switch for one person.
    expect(report.counts.day0Selection).toBe(0)
  })
})

describe('the tombstone invariant', () => {
  const openState = async (): Promise<SqliteStateStore> => {
    const state = new SqliteStateStore({ path: ':memory:' })
    await state.init()
    return state
  }

  it('records a baseline on a first run and accepts growth', async () => {
    const people = new MemoryPeopleStore()
    await people.init()
    const state = await openState()
    await bootstrapTombstones({ people, snapshot: snapshot(leavers), today: '2026-03-31' })

    const first = await checkDepartedInvariant(people, state)
    expect(first).toMatchObject({ ok: true, previous: null, current: 300 })
    expect(await state.getCounter(DEPARTED_COUNTER)).toBe(300)

    await bootstrapTombstones({ people, snapshot: snapshot([...leavers, person(999)]), today: '2026-04-01' })
    expect(await checkDepartedInvariant(people, state)).toMatchObject({ ok: true, previous: 300, current: 301 })
    await state.close()
  })

  it('refuses when the count has fallen, and keeps the higher baseline', async () => {
    const people = new MemoryPeopleStore({ seed: [] })
    await people.init()
    const state = await openState()
    await state.setCounter(DEPARTED_COUNTER, 300)

    const result = await checkDepartedInvariant(people, state)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('300')
    // Writing the lower number would teach the next run that the loss is
    // normal, and it would then proceed.
    expect(await state.getCounter(DEPARTED_COUNTER)).toBe(300)
    await state.close()
  })
})
