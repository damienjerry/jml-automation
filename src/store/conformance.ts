/**
 * The suite every people store must pass.
 *
 * It ships as part of the library rather than as a test file so that an
 * adapter written by somebody else, for a system this project has never seen,
 * can be held to exactly the same behaviour in one line:
 *
 *     describePeopleStoreConformance({ name: 'my-adapter', create: () => ... })
 *
 * That matters because the guarantees below are the ones an account depends
 * on. An adapter that quietly loses a tombstone, or that reads one page of a
 * selection, does not fail loudly. It fails by offboarding somebody who left
 * years ago, or by never offboarding somebody at all, and neither shows up
 * until afterwards.
 *
 * It imports vitest, which is a development dependency: nothing in the running
 * toolkit imports this module, only an adapter's test file does.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Person } from '../core/types.ts'
import type { PeopleStore } from './types.ts'
import { StoreWriteRefused } from './transitions-guard.ts'

export interface PeopleStoreUnderTest {
  /** Appears in the test names, so a failure names the adapter. */
  name: string
  create(): Promise<PeopleStore>
  /**
   * Total writes performed so far, when the adapter can report it. The suite
   * uses it to prove that an unchanged sync writes nothing at all, which is a
   * claim a comment cannot make credible.
   */
  writes?(store: PeopleStore): number
  /**
   * How many rows the pagination case inserts. The default is deliberately
   * over a thousand: the engine this replaces read a single hundred-row page
   * and silently ignored everybody after it, so anything below a few hundred
   * would pass while reproducing the bug.
   */
  largeListSize?: number
}

/** A complete person, so a test only states the field it cares about. */
export function samplePerson(overrides: Partial<Person> = {}): Person {
  return {
    hrisId: 'hris-0001',
    status: 'active',
    primaryEmail: 'jane.doe@example.com',
    aliasEmails: [],
    displayName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    department: 'Operations',
    jobTitle: 'Analyst',
    site: 'Head office',
    managerEmail: 'john.doe@example.com',
    startDate: '2024-01-08',
    terminationDate: null,
    hold: false,
    holdReason: null,
    reviewReason: null,
    externalIds: {},
    googleAccountPresent: null,
    offboarding: null,
    note: null,
    source: 'fixture',
    ...overrides,
  }
}

/** Every method name reachable on the instance, including inherited ones. */
function methodNames(store: PeopleStore): string[] {
  const names = new Set<string>()
  let cursor: object | null = store
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) names.add(name)
    cursor = Object.getPrototypeOf(cursor) as object | null
  }
  return [...names]
}

export function describePeopleStoreConformance(target: PeopleStoreUnderTest): void {
  const size = target.largeListSize ?? 1200

  describe(`PeopleStore conformance: ${target.name}`, () => {
    let store: PeopleStore

    beforeEach(async () => {
      store = await target.create()
      await store.init()
    })

    const writes = (): number | null => (target.writes ? target.writes(store) : null)

    describe('what the interface refuses to offer', () => {
      it('exposes no way to delete or prune a row', () => {
        // Tombstones are the only thing that stops a historic leaver being
        // offboarded a second time, and the incident that taught that lesson
        // was a migration which removed them. An interface that cannot delete
        // is a stronger guarantee than a warning in a document.
        const forbidden = methodNames(store).filter((name) =>
          /^(delete|prune|remove|purge|drop|truncate|clear|reset)/i.test(name),
        )
        expect(forbidden).toEqual([])
      })

      it('reports its own capabilities so callers can adapt', () => {
        expect(typeof store.capabilities.singleWriterOnly).toBe('boolean')
        expect(typeof store.capabilities.exactCounts).toBe('boolean')
      })

      it('can be initialised twice without complaint', async () => {
        await expect(store.init()).resolves.toBeUndefined()
      })
    })

    describe('creating and reading a person', () => {
      it('creates a row and reads it back', async () => {
        const result = await store.upsert(samplePerson())
        expect(result.created).toBe(true)
        expect(result.changed).toBe(true)
        const stored = await store.get('hris-0001')
        expect(stored?.displayName).toBe('Jane Doe')
        expect(stored?.status).toBe('active')
      })

      it('normalises the address and defaults a blank name to it', async () => {
        await store.upsert(samplePerson({ primaryEmail: 'Jane.Doe@Example.com', displayName: '  ' }))
        const stored = await store.get('hris-0001')
        expect(stored?.primaryEmail).toBe('jane.doe@example.com')
        // A row is never dropped for a missing name: a leaver nobody can label
        // is still a leaver somebody has to offboard.
        expect(stored?.displayName).toBe('jane.doe@example.com')
      })

      it('refuses a row with no HR id and a row with no address', async () => {
        await expect(store.upsert(samplePerson({ hrisId: '' }))).rejects.toThrow(StoreWriteRefused)
        await expect(store.upsert(samplePerson({ primaryEmail: '' }))).rejects.toThrow(StoreWriteRefused)
      })

      it('returns null rather than throwing for somebody who is not there', async () => {
        expect(await store.get('hris-absent')).toBeNull()
      })
    })

    describe('a second identical sync', () => {
      it('performs no writes at all', async () => {
        await store.upsert(samplePerson())
        const stored = await store.get('hris-0001')
        const before = writes()

        const again = await store.upsert(samplePerson())
        expect(again.created).toBe(false)
        expect(again.changed).toBe(false)
        expect(again.changedFields).toEqual([])
        // The stored timestamp is the observable proof for an adapter that
        // cannot report a write count.
        expect((await store.get('hris-0001'))?.updatedAt).toBe(stored?.updatedAt)
        if (before !== null) expect(writes()).toBe(before)
      })

      it('never erases a populated field with a blank incoming one', async () => {
        await store.upsert(samplePerson({ department: 'Operations' }))
        const before = writes()

        for (const blank of ['', '   ', null, undefined]) {
          const result = await store.upsert(samplePerson({ department: blank as string | null }))
          expect(result.changed).toBe(false)
        }
        expect((await store.get('hris-0001'))?.department).toBe('Operations')
        // A hand-entered value survives a sync that has nothing to say about
        // it. The alternative wipes whatever the HR system does not carry.
        if (before !== null) expect(writes()).toBe(before)
      })

      it('records a real field change, and only that field', async () => {
        await store.upsert(samplePerson())
        const result = await store.upsert(samplePerson({ department: 'Engineering' }))
        expect(result.changed).toBe(true)
        expect(result.changedFields).toEqual(['department'])
      })

      it('keeps a previous address as an alias when the primary changes', async () => {
        await store.upsert(samplePerson())
        await store.upsert(samplePerson({ primaryEmail: 'jane.doe@legacy.example.com' }))
        const stored = await store.get('hris-0001')
        expect(stored?.primaryEmail).toBe('jane.doe@legacy.example.com')
        expect(stored?.aliasEmails).toContain('jane.doe@example.com')
        // A renamed person is the same person. Losing the old address is how a
        // later lookup misses them, or matches somebody else entirely.
        expect(await store.findByEmail('jane.doe@example.com')).toHaveLength(1)
      })

      it('does not change status, whatever the incoming record says', async () => {
        await store.upsert(samplePerson())
        await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'active',
          event: 'hris.terminated',
          owner: 'sync',
        })
        await store.upsert(samplePerson({ status: 'active', department: 'Engineering' }))
        expect((await store.get('hris-0001'))?.status).toBe('terminated')
      })
    })

    describe('status changes', () => {
      beforeEach(async () => {
        await store.upsert(samplePerson())
      })

      it('allows a transition the table permits for that owner', async () => {
        const result = await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'active',
          event: 'hris.terminated',
          owner: 'sync',
          patch: { terminationDate: '2026-03-31' },
        })
        expect(result.ok).toBe(true)
        const stored = await store.get('hris-0001')
        expect(stored?.status).toBe('terminated')
        // The patch lands in the same write as the status, so a crash cannot
        // leave a leaver with no leaving date.
        expect(stored?.terminationDate).toBe('2026-03-31')
      })

      it('refuses an owner the table does not grant that edge', async () => {
        await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
        const result = await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'terminated',
          event: 'engine.day0_suspended',
          owner: 'sync',
        })
        expect(result).toMatchObject({ ok: false, refusal: 'owner_forbidden' })
        expect((await store.get('hris-0001'))?.status).toBe('terminated')
      })

      it('refuses an edge that does not exist', async () => {
        const result = await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'active',
          event: 'engine.day7_departed',
          owner: 'engine',
        })
        expect(result).toMatchObject({ ok: false, refusal: 'illegal_transition' })
      })

      it('refuses a write based on a stale read', async () => {
        await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
        // Two runs overlapped and this one is holding what it read before the
        // other moved the row.
        const result = await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'active',
          event: 'hris.terminated',
          owner: 'sync',
        })
        expect(result).toMatchObject({ ok: false, refusal: 'stale_status' })
      })

      it('refuses everything once a row is a tombstone', async () => {
        await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
        await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'terminated',
          event: 'human.tombstone',
          owner: 'human',
        })
        expect((await store.get('hris-0001'))?.status).toBe('departed')

        for (const owner of ['sync', 'engine', 'human'] as const) {
          const result = await store.transition({
            hrisId: 'hris-0001',
            expectFrom: 'departed',
            event: 'hris.active',
            owner,
          })
          expect(result.ok).toBe(false)
        }
      })

      it('never creates a row, and says so as a refusal not a crash', async () => {
        const result = await store.transition({
          hrisId: 'hris-absent',
          expectFrom: 'terminated',
          event: 'engine.day0_suspended',
          owner: 'engine',
        })
        expect(result).toMatchObject({ ok: false, refusal: 'stale_status' })
        expect(await store.get('hris-absent')).toBeNull()
      })
    })

    describe('the Day-0 marker and the offboarding record', () => {
      beforeEach(async () => {
        await store.upsert(samplePerson())
        await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
        await store.transition({
          hrisId: 'hris-0001',
          expectFrom: 'terminated',
          event: 'engine.day0_suspended',
          owner: 'engine',
          patch: {
            offboarding: {
              suspendedAt: '2026-03-31',
              legs: { suspend_idp: { state: 'done', verified: true, attempts: 1 } },
            },
          },
        })
      })

      it('can never be cleared once written', async () => {
        // Clearing it makes an already-suspended person selectable again, and
        // the whole Day-0 stage runs a second time.
        await expect(
          store.patch('hris-0001', { offboarding: { suspendedAt: null, legs: {} } }),
        ).rejects.toThrow(StoreWriteRefused)
        await expect(store.patch('hris-0001', { offboarding: null })).rejects.toThrow(StoreWriteRefused)
        expect((await store.get('hris-0001'))?.offboarding?.suspendedAt).toBe('2026-03-31')
      })

      it('keeps the legs a later step does not mention', async () => {
        await store.patch('hris-0001', {
          offboarding: {
            suspendedAt: '2026-03-31',
            legs: { revoke_licence: { state: 'done', verified: true, attempts: 1 } },
          },
        })
        const legs = (await store.get('hris-0001'))?.offboarding?.legs
        // A step that writes only its own result must not carry a stale copy
        // of its siblings, or the record of what already succeeded is lost.
        expect(legs?.suspend_idp?.state).toBe('done')
        expect(legs?.revoke_licence?.state).toBe('done')
      })

      it('refuses a patch that tries to set the status directly', async () => {
        await expect(store.patch('hris-0001', { status: 'departed' })).rejects.toThrow(StoreWriteRefused)
        expect((await store.get('hris-0001'))?.status).toBe('offboarding')
      })

      it('lets a patch clear an account id, to defuse a mistaken identity', async () => {
        await store.patch('hris-0001', { externalIds: { jumpcloudUserId: 'jc-user-1' } })
        await store.patch('hris-0001', { externalIds: { jumpcloudUserId: null } })
        expect((await store.get('hris-0001'))?.externalIds.jumpcloudUserId).toBeNull()
      })

      it('does not hand out a reference a caller can mutate', async () => {
        const stored = await store.get('hris-0001')
        if (stored?.offboarding) stored.offboarding.suspendedAt = null
        expect((await store.get('hris-0001'))?.offboarding?.suspendedAt).toBe('2026-03-31')
      })
    })

    describe('finding somebody by address', () => {
      it('matches the primary and every alias, ignoring case', async () => {
        await store.upsert(
          samplePerson({ aliasEmails: ['Jane.Doe@legacy.example.com', 'jane.doe+exit@example.com'] }),
        )
        expect(await store.findByEmail('JANE.DOE@EXAMPLE.COM')).toHaveLength(1)
        expect(await store.findByEmail('jane.doe@legacy.example.com')).toHaveLength(1)
        expect(await store.findByEmail('jane.doe+exit@example.com')).toHaveLength(1)
      })

      it('returns every claimant when two rows hold the same address', async () => {
        await store.upsert(samplePerson())
        await store.upsert(
          samplePerson({ hrisId: 'hris-0002', primaryEmail: 'john.doe@example.com', aliasEmails: ['jane.doe@example.com'] }),
        )
        // The caller has to see both. Taking the first match is how a write
        // lands on the wrong person's account.
        expect(await store.findByEmail('jane.doe@example.com')).toHaveLength(2)
      })

      it('does not match an address that merely contains the one asked for', async () => {
        await store.upsert(samplePerson({ primaryEmail: 'jane.doerr@example.com' }))
        expect(await store.findByEmail('jane.doe@example.com')).toEqual([])
      })
    })

    describe('selection', () => {
      it(`returns all ${size} rows, with no page limit of its own`, async () => {
        for (let index = 0; index < size; index += 1) {
          const id = `hris-${String(index).padStart(5, '0')}`
          await store.upsert(samplePerson({ hrisId: id, primaryEmail: `${id}@example.com` }))
        }
        const all = await store.list()
        expect(all).toHaveLength(size)
        expect(await store.countExact()).toBe(size)
        // An exact count, not an estimate: the pipeline aborts when the
        // tombstone count drops, so an approximation is worse than nothing.
        expect(await store.countExact({ status: ['active'] })).toBe(size)
        expect(await store.list({ limit: 10 })).toHaveLength(10)
      })

      it('filters on status, hold, parked and the Day-0 marker', async () => {
        await store.upsert(samplePerson({ hrisId: 'hris-active' }))
        await store.upsert(samplePerson({ hrisId: 'hris-leaver', primaryEmail: 'leaver@example.com' }))
        await store.upsert(samplePerson({ hrisId: 'hris-held', primaryEmail: 'held@example.com' }))
        await store.upsert(samplePerson({ hrisId: 'hris-parked', primaryEmail: 'parked@example.com' }))

        for (const id of ['hris-leaver', 'hris-held', 'hris-parked']) {
          await store.transition({ hrisId: id, expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
        }
        await store.patch('hris-held', { hold: true, holdReason: 'Waiting for a person to look' })
        await store.patch('hris-parked', { reviewReason: 'termination_older_than_lookback' })

        const selected = await store.list({
          status: ['terminated'],
          excludeHeld: true,
          parked: false,
          suspendedAt: 'empty',
        })
        expect(selected.map((person) => person.hrisId)).toEqual(['hris-leaver'])
        expect(await store.countExact({ parked: true })).toBe(1)
        expect(await store.countExact({ status: ['terminated'] })).toBe(3)
      })

      it('filters on the Day-0 date and on a stored account id', async () => {
        await store.upsert(samplePerson({ hrisId: 'hris-day0' }))
        await store.transition({ hrisId: 'hris-day0', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
        await store.transition({
          hrisId: 'hris-day0',
          expectFrom: 'terminated',
          event: 'engine.day0_suspended',
          owner: 'engine',
          patch: {
            offboarding: { suspendedAt: '2026-03-25', legs: {} },
            externalIds: { googleUserId: 'google-1' },
          },
        })

        expect(await store.countExact({ suspendedAt: 'set' })).toBe(1)
        expect(await store.countExact({ suspendedOn: '2026-03-25' })).toBe(1)
        expect(await store.countExact({ suspendedOn: '2026-03-26' })).toBe(0)
        expect(await store.countExact({ suspendedOnOrBefore: '2026-03-31' })).toBe(1)
        expect(await store.countExact({ suspendedOnOrBefore: '2026-03-24' })).toBe(0)
        expect(await store.countExact({ hasExternalId: 'googleUserId' })).toBe(1)
        expect(await store.countExact({ hasExternalId: 'jumpcloudUserId' })).toBe(0)
      })
    })
  })
}
