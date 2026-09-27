/**
 * Failure this prevents: leaver detection driven by a lifecycle status word.
 *
 * The HR system carries a lifecycle status on each record, and it is tempting
 * to read it. It cannot be trusted across tenants: the vocabulary is
 * configurable, the same word covers different situations in different
 * accounts, and a person can hold a status of one kind while the employed
 * report already excludes them. An earlier design established by
 * live probing that the reliable signal is absence from a second read of the
 * employed people, and that is what the adapter uses.
 *
 * The renamed-leaver case is here too. An exit rename changes the address
 * while the HR id stays the same, so the id is what the snapshot is keyed on.
 * Keying on the address once let a renamed leaver be treated as a brand new
 * person, and the new record inherited a live colleague's account ids.
 */

import { describe, expect, it } from 'vitest'
import { HiBobAdapter } from '../../src/hris/hibob/adapter.ts'
import { fakeSecret, pagingHttp } from '../helpers/hibob-http.ts'

/** Employed, and the status word agrees. */
const PLAIN = {
  id: 'r-7001',
  email: 'jane.doe@example.com',
  displayName: 'Jane Doe',
  work: { startDate: '2019-05-06' },
  internal: { lifecycleStatus: 'Employed' },
}

/** Gone from the employed report while still labelled as employed. */
const MISLABELLED = {
  id: 'r-7002',
  email: 'sam.rivera@example.com',
  displayName: 'Sam Rivera',
  work: { startDate: '2022-07-18' },
  internal: { lifecycleStatus: 'Employed', terminationDate: '2026-01-09' },
}

/** Renamed on the way out: new address, same id. */
const RENAMED = {
  id: 'r-7003',
  email: 'kit.marlowe+exit@example.com',
  displayName: 'Kit Marlowe',
  work: { startDate: '2021-09-13' },
  internal: { lifecycleStatus: 'Terminated', terminationDate: '2026-01-12' },
}

function adapter(all: unknown[], employed: unknown[]) {
  return new HiBobAdapter({
    http: pagingHttp({ all, employed }),
    serviceUserId: fakeSecret('service-user'),
    serviceToken: fakeSecret('service-secret'),
    minPlausibleHeadcount: 1,
  })
}

describe('who counts as employed', () => {
  it('comes from the employed read, whatever the status word says', async () => {
    const snapshot = await adapter([PLAIN, MISLABELLED, RENAMED], [PLAIN]).fetchAll()

    expect([...snapshot.activeIds]).toEqual(['r-7001'])
    // The mislabelled person is a leaver here, and their record still says
    // they are employed. Nothing downstream reads that word.
    expect(snapshot.activeIds.has('r-7002')).toBe(false)
  })

  it('keeps a renamed leaver on the id the HR system already had', async () => {
    const snapshot = await adapter([PLAIN, RENAMED], [PLAIN]).fetchAll()
    const renamed = snapshot.all.find((p) => p.hrisId === 'r-7003')

    expect(renamed?.primaryEmail).toBe('kit.marlowe+exit@example.com')
    expect(renamed?.terminationDate).toBe('2026-01-12')
    // One person, one id. The snapshot offers nothing that would let a
    // consumer treat the new address as a new joiner.
    expect(snapshot.all.filter((p) => p.hrisId === 'r-7003')).toHaveLength(1)
  })

  it('records the employed set as ids, never as addresses', async () => {
    const snapshot = await adapter([PLAIN, RENAMED], [PLAIN]).fetchAll()

    for (const id of snapshot.activeIds) {
      expect(id).not.toContain('@')
    }
  })
})
