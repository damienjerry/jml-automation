/**
 * Failure this prevents: tombstone rows were removed by a data migration, the
 * next HR sync read a full history and saw several hundred historic leavers as
 * brand new terminations, and the offboarding engine started suspending
 * accounts that had been closed for years.
 *
 * Three separate defences are checked here, in the order they would fire.
 * Defence one, the interface offering no way to delete a row, is checked by
 * the conformance suite. Defence two, the store-level invariant on the
 * tombstone count, is checked below. Defence three is the sync's own refusal
 * to create a row whose derived status is terminated, checked at the end of
 * this file: even with the invariant counter cleared, a pruned tombstone
 * cannot come back as a leaver waiting to be offboarded.
 */

import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HrisPerson, HrisSnapshot } from '../../src/hris/types.ts'
import {
  bootstrapTombstones,
  checkDepartedInvariant,
  DAY0_SELECTION,
  DEPARTED_COUNTER,
} from '../../src/store/bootstrap.ts'
import { SqlitePeopleStore } from '../../src/store/sqlite/store.ts'
import { SqliteStateStore } from '../../src/store/state-sqlite.ts'
import { createDomainMap } from '../../src/core/domain.ts'
import { createIdentityRules } from '../../src/core/identity.ts'
import { runSync } from '../../src/engine/sync.ts'

function leaver(index: number): HrisPerson {
  const id = `hris-${String(index).padStart(4, '0')}`
  return {
    hrisId: id,
    primaryEmail: `${id}@example.com`,
    displayName: `Person ${index}`,
    terminationDate: '2021-06-30',
  }
}

const HISTORY: HrisSnapshot = {
  all: Array.from({ length: 300 }, (_, index) => leaver(index)),
  activeIds: new Set<string>(),
  fetchedAt: '2026-03-31T09:00:00.000Z',
  complete: true,
}

describe('tombstones removed outside the toolkit', () => {
  it('aborts the run instead of treating 300 historic leavers as new', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jml-refire-'))
    const path = join(directory, 'jml.sqlite')
    try {
      const people = new SqlitePeopleStore({ path })
      await people.init()
      const state = new SqliteStateStore({ path: join(directory, 'state.sqlite') })
      await state.init()

      await bootstrapTombstones({ people, snapshot: HISTORY, today: '2026-03-31' })
      expect(await checkDepartedInvariant(people, state)).toMatchObject({ ok: true, current: 300 })
      expect(await people.countExact(DAY0_SELECTION)).toBe(0)
      await people.close()

      // The store cannot do this to itself. This is a migration, a script or a
      // person with a SQL prompt, which is exactly how it happened.
      const raw = new DatabaseSync(path)
      raw.exec("DELETE FROM people WHERE status = 'departed'")
      raw.close()

      const reopened = new SqlitePeopleStore({ path })
      await reopened.init()
      expect(await reopened.countExact({ status: ['departed'] })).toBe(0)

      const invariant = await checkDepartedInvariant(reopened, state)
      expect(invariant.ok).toBe(false)
      expect(invariant.previous).toBe(300)
      expect(invariant.current).toBe(0)
      // The message has to be enough to act on without reading the code.
      expect(invariant.reason).toContain('300')

      // The baseline stays high. Recording the lower number would make the
      // next run treat the loss as normal and carry on.
      expect(await state.getCounter(DEPARTED_COUNTER)).toBe(300)

      await reopened.close()
      await state.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('still holds when the same history is re-imported after the loss', async () => {
    const people = new SqlitePeopleStore({ path: ':memory:' })
    await people.init()

    // Re-running the bootstrap is the recovery path, and it must land the rows
    // back as tombstones rather than as leavers waiting to be offboarded.
    const report = await bootstrapTombstones({ people, snapshot: HISTORY, today: '2026-03-31' })
    expect(report.tombstoned).toBe(300)
    expect(report.day0SelectionAfter).toBe(0)
    await people.close()
  })
})

// ---------------------------------------------------------------------------
// Defence three: the sync itself
// ---------------------------------------------------------------------------

/**
 * The same history with somebody still employed.
 *
 * `HISTORY` above has an empty employed set, which the sync refuses outright
 * as a truncated read, so the re-fire case needs a snapshot that is plausible
 * on its face. That is the point: the accident happened on a snapshot that
 * looked completely normal.
 */
const HISTORY_WITH_STAFF: HrisSnapshot = {
  all: [
    ...HISTORY.all,
    ...Array.from({ length: 20 }, (_, index) => ({
      hrisId: `emp-${String(index).padStart(4, '0')}`,
      primaryEmail: `emp-${String(index).padStart(4, '0')}@example.com`,
      displayName: `Employee ${index}`,
      startDate: '2023-04-03',
      terminationDate: null,
    })),
  ],
  activeIds: new Set(Array.from({ length: 20 }, (_, index) => `emp-${String(index).padStart(4, '0')}`)),
  fetchedAt: '2026-03-31T09:00:00.000Z',
  complete: true,
}

describe('a sync run against a store whose tombstones are gone', () => {
  it('creates nobody, because a row is never created as terminated', async () => {
    const people = new SqlitePeopleStore({ path: ':memory:' })
    await people.init()
    const domain = createDomainMap({ primaryDomain: 'example.com' })

    // Nothing is seeded: this is the store immediately after the migration
    // that removed every tombstone, and every historic leaver therefore looks
    // brand new to a sync that joins on the HR system alone.
    const report = await runSync({
      snapshot: HISTORY_WITH_STAFF,
      people,
      today: '2026-03-31',
      identity: createIdentityRules(domain, ['\\+(exit|leaver)@']),
      minPlausibleHeadcount: 20,
      terminationLookbackDays: 60,
    })

    expect(report.counts.skipped_historic_leaver).toBe(300)
    expect(report.counts.created).toBe(20)
    // The set that matters: nobody is selectable for offboarding.
    expect(await people.countExact(DAY0_SELECTION)).toBe(0)
    expect(await people.countExact({ status: ['terminated'] })).toBe(0)
    await people.close()
  })
})
