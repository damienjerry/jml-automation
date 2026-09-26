/**
 * Opening a Notion store added properties to the database, on every command.
 *
 * `init()` ran whenever a store was opened, `jml doctor` and every dry run
 * included, and it added any mapped property the database lacked. So the
 * first read-only check against somebody's existing database changed that
 * database's schema, and a dry run was not in fact free of writes. Found by
 * an outside review before publishing. Opening a store now only reads the
 * schema; a missing property is read as empty and blocks every write until
 * `jml store migrate --armed` adds it.
 */
import { describe, expect, it } from 'vitest'
import { NotionClient } from '../../src/store/notion/client.ts'
import { NotionPeopleStore } from '../../src/store/notion/store.ts'
import { samplePerson } from '../../src/store/conformance.ts'
import { FakeNotion } from '../helpers/fake-notion.ts'

function open(fake: FakeNotion): NotionPeopleStore {
  const client = new NotionClient({ http: fake.http(), token: { use: (fn) => fn('notion-token-not-real') } })
  return new NotionPeopleStore({ client, databaseId: fake.database.id })
}

describe('opening a Notion store', () => {
  it('reads the schema and writes nothing to the database', async () => {
    const fake = new FakeNotion()
    const store = open(fake)
    await store.init()
    await store.countExact()
    await store.list()
    expect(fake.requests.filter((r) => r.method !== 'GET' && !/\/query$/.test(r.path))).toEqual([])
    expect(Object.keys(fake.database.properties)).toEqual(['Name'])
  })

  it('refuses a write while mapped properties are missing, and names the command that adds them', async () => {
    const store = open(new FakeNotion())
    await store.init()
    await expect(store.upsert(samplePerson({ hrisId: 'hr-1' }))).rejects.toThrow(/jml store migrate --armed/)
    expect(store.writes).toBe(0)
  })

  it('writes normally once migrated', async () => {
    const store = open(new FakeNotion())
    await store.init()
    await store.ensureSchema()
    await store.upsert(samplePerson({ hrisId: 'hr-1' }))
    expect(await store.countExact()).toBe(1)
  })
})
