/**
 * Failure this prevents: every selection in the original engine read a single
 * page of a hundred rows and used the default page size of the store it was
 * querying. Once the record count passed that, everybody after the first page
 * stopped being processed. Nothing errored, no count looked wrong in isolation,
 * and the people affected were simply never offboarded.
 *
 * A thousand rows is the point of the number below: a test with fifty rows
 * passes while the defect is present.
 */

import { describe, expect, it } from 'vitest'
import type { Person } from '../../src/core/types.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { SqlitePeopleStore } from '../../src/store/sqlite/store.ts'
import type { PeopleStore } from '../../src/store/types.ts'

const SIZE = 1200

function person(index: number): Person {
  const id = `hris-${String(index).padStart(5, '0')}`
  return {
    hrisId: id,
    status: index % 3 === 0 ? 'terminated' : 'active',
    primaryEmail: `${id}@example.com`,
    aliasEmails: [],
    displayName: `Person ${index}`,
    hold: false,
    externalIds: {},
    offboarding: null,
  }
}

async function fill(store: PeopleStore): Promise<void> {
  await store.init()
  for (let index = 0; index < SIZE; index += 1) await store.upsert(person(index))
}

describe.each([
  ['memory', () => new MemoryPeopleStore() as PeopleStore],
  ['sqlite', () => new SqlitePeopleStore({ path: ':memory:' }) as PeopleStore],
])('a selection over %s rows (%s)', (_name, create) => {
  it('returns every row, and a filtered selection returns every match', async () => {
    const store = create()
    await fill(store)

    const all = await store.list()
    expect(all).toHaveLength(SIZE)
    // The last row is the one that goes missing when only the first page is
    // read, so assert on it by name rather than on the length alone.
    expect(all.at(-1)?.hrisId).toBe('hris-01199')

    const leavers = await store.list({ status: ['terminated'] })
    const expectedLeavers = Math.ceil(SIZE / 3)
    expect(leavers).toHaveLength(expectedLeavers)
    expect(await store.countExact({ status: ['terminated'] })).toBe(expectedLeavers)
    expect(leavers.at(-1)?.hrisId).toBe('hris-01197')

    // A cap exists, but only when the caller asks for one.
    expect(await store.list({ status: ['terminated'], limit: 100 })).toHaveLength(100)
    await store.close()
  })
})
