/**
 * Prevents: a first run against a full HR history creating every historic
 * leaver as a fresh termination, and the offboarding engine then starting on
 * accounts that were closed years ago.
 *
 * What happened. A people database was migrated and the tombstone rows for
 * people who had already left were pruned. The next HR read included leavers,
 * as an HR read does, and the sync created a row for each of them. Every one
 * derived to "terminated", every one had an empty Day-0 marker, and the run
 * that followed treated several hundred closed accounts as brand new
 * departures. The schedules had to be turned off by hand.
 *
 * The fix is one line in the sync, and it is the most important line in the
 * package: a row is never CREATED with the derived status terminated. A leaver
 * who has no row never had one, so there is nothing to offboard and no account
 * work is owed. The store's other defences (no delete method, the tombstone
 * invariant counter) protect rows that exist; this one protects against rows
 * that never should.
 */

import { describe, expect, it } from 'vitest'
import { createDomainMap } from '../../src/core/domain.ts'
import { createIdentityRules } from '../../src/core/identity.ts'
import { runSync } from '../../src/engine/sync.ts'
import type { HrisPerson, HrisSnapshot } from '../../src/hris/types.ts'
import { DAY0_SELECTION } from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'

const domain = createDomainMap({ primaryDomain: 'example.com' })
const identity = createIdentityRules(domain, ['\\+(exit|leaver)@'])
const TODAY = '2026-03-10'

function person(prefix: string, index: number, extra: Partial<HrisPerson> = {}): HrisPerson {
  const id = `${prefix}-${String(index).padStart(4, '0')}`
  return {
    hrisId: id,
    primaryEmail: `${id}@example.com`,
    displayName: `${prefix === 'gone' ? 'Former' : 'Current'} Person ${index}`,
    startDate: '2021-02-01',
    terminationDate: null,
    ...extra,
  }
}

/** 250 people who left years ago, 40 who are still here. A normal HR export. */
const WHOLE_HISTORY: HrisSnapshot = {
  all: [
    ...Array.from({ length: 250 }, (_, i) => person('gone', i, { terminationDate: '2022-11-30' })),
    ...Array.from({ length: 40 }, (_, i) => person('here', i)),
  ],
  activeIds: new Set(Array.from({ length: 40 }, (_, i) => `here-${String(i).padStart(4, '0')}`)),
  fetchedAt: `${TODAY}T08:00:00.000Z`,
  complete: true,
}

async function sync(store: MemoryPeopleStore, snapshot: HrisSnapshot) {
  return runSync({
    snapshot,
    people: store,
    today: TODAY,
    identity,
    // Below real headcount on purpose: the employed set is checked against
    // this floor too, so a floor equal to the staff list would refuse the run
    // the first time somebody left.
    minPlausibleHeadcount: 30,
    terminationLookbackDays: 60,
  })
}

describe('a first sync against a whole HR history', () => {
  it('creates the employed and not one leaver', async () => {
    const store = new MemoryPeopleStore()
    const report = await sync(store, WHOLE_HISTORY)

    expect(report.counts.created).toBe(40)
    expect(report.counts.skipped_historic_leaver).toBe(250)
    expect(await store.countExact({ status: ['terminated'] })).toBe(0)
    // The number that decides whether accounts get suspended.
    expect(await store.countExact(DAY0_SELECTION)).toBe(0)
  })

  it('names the skipped rows in its report rather than dropping them silently', async () => {
    // Over-suppression is silent, so every skip is counted and carries a
    // reason. A run that quietly did nothing looks exactly like a healthy one.
    const store = new MemoryPeopleStore()
    const report = await sync(store, WHOLE_HISTORY)
    const skipped = report.rows.filter((row) => row.action === 'skipped_historic_leaver')

    expect(skipped).toHaveLength(250)
    expect(skipped[0]?.reason).toContain('never created as terminated')
  })

  it('still records a leaver who was employed when the toolkit first saw them', async () => {
    // The rule must not swallow the case the toolkit exists for. Somebody with
    // a row, who then leaves, does become terminated.
    const store = new MemoryPeopleStore()
    await sync(store, WHOLE_HISTORY)

    const leaving = 'here-0000'
    const nextDay: HrisSnapshot = {
      ...WHOLE_HISTORY,
      all: WHOLE_HISTORY.all.map((record) =>
        record.hrisId === leaving ? { ...record, terminationDate: '2026-03-09' } : record,
      ),
      activeIds: new Set([...WHOLE_HISTORY.activeIds].filter((id) => id !== leaving)),
    }
    const report = await sync(store, nextDay)

    expect(report.counts.status_changed).toBe(1)
    expect((await store.get(leaving))?.status).toBe('terminated')
    expect(await store.countExact(DAY0_SELECTION)).toBe(1)
  })
})
