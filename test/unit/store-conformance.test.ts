/**
 * The shared conformance suite, run against both stores that ship today.
 *
 * Any future adapter (a Notion database, a spreadsheet) adds one file exactly
 * like this one. If a rule holds here it holds for every store, which is the
 * only way several adapters can be trusted with the same accounts.
 */

import { describePeopleStoreConformance } from '../../src/store/conformance.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { SqlitePeopleStore } from '../../src/store/sqlite/store.ts'
import type { PeopleStore } from '../../src/store/types.ts'

describePeopleStoreConformance({
  name: 'memory',
  create: async () => new MemoryPeopleStore(),
  writes: (store: PeopleStore) => (store as MemoryPeopleStore).writes,
})

describePeopleStoreConformance({
  name: 'sqlite',
  create: async () => new SqlitePeopleStore({ path: ':memory:' }),
  writes: (store: PeopleStore) => (store as SqlitePeopleStore).writes,
})
