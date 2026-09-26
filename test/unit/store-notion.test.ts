import { describe, expect, it } from 'vitest'
import { describePeopleStoreConformance, samplePerson } from '../../src/store/conformance.ts'
import { NotionClient } from '../../src/store/notion/client.ts'
import { NotionPeopleStore } from '../../src/store/notion/store.ts'
import { PROPERTY_TYPES, resolvePropertyMap, resolveStatusValues, type NotionPropertyMap } from '../../src/store/notion/schema.ts'
import { FakeNotion } from '../helpers/fake-notion.ts'

/**
 * Give a fake database every mapped property it lacks, as `jml store migrate
 * --armed` would. Opening a store never adds them itself, so the tests that
 * exercise reads and writes start from a migrated database.
 */
function provision(fake: FakeNotion): FakeNotion {
  const map = resolvePropertyMap()
  const statuses = resolveStatusValues()
  for (const key of Object.keys(map) as (keyof NotionPropertyMap)[]) {
    const name = map[key]
    if (fake.database.properties[name]) continue
    const type = PROPERTY_TYPES[key][0]!
    fake.database.properties[name] = type === 'select' ? { type, select: { options: Object.values(statuses).map((n) => ({ name: n })) } } : { type }
  }
  return fake
}

function make(fake = new FakeNotion()) {
  provision(fake)
  const client = new NotionClient({ http: fake.http(), token: { use: (fn) => fn('notion-token-not-real') } })
  return { fake, store: new NotionPeopleStore({ client, databaseId: fake.database.id }) }
}

describePeopleStoreConformance({
  name: 'notion (fake API)',
  create: async () => make().store,
  writes: (store) => (store as NotionPeopleStore).writes,
  // Twelve hundred rows is twelve pages of a hundred. Kept, because paging is
  // the thing this adapter exists to get right.
  largeListSize: 1200,
})

describe('the Notion store on its own', () => {
  it('adds the mapped properties a database lacks only through ensureSchema, and nothing else', async () => {
    const fake = new FakeNotion()
    const client = new NotionClient({ http: fake.http(), token: { use: (fn) => fn('notion-token-not-real') } })
    const store = new NotionPeopleStore({ client, databaseId: fake.database.id })
    await store.init()
    expect(store.missingProperties()).toContain('JML State')
    expect(await store.ensureSchema()).toContain('JML State')
    const names = Object.keys(fake.database.properties).sort()
    expect(names).toContain('JML State')
    expect(names).toContain('Offboarding Hold')
    expect(fake.database.properties['Status']?.type).toBe('select')
    expect(fake.database.properties['Status']?.select?.options.map((o) => o.name)).toEqual(['Hired', 'Active', 'Terminated', 'Offboarding', 'Departed'])
    expect(store.missingProperties()).toEqual([])
    // Nothing left to add, and a second open touches the schema no further.
    const before = fake.requests.length
    expect(await store.ensureSchema()).toEqual([])
    await store.init()
    expect(fake.requests.slice(before).filter((r) => r.method === 'PATCH')).toEqual([])
  })

  it('refuses a mapped property that exists with the wrong type rather than retyping it', async () => {
    const fake = new FakeNotion('db-people', { Name: { type: 'title' }, Status: { type: 'rich_text' } })
    const { store } = make(fake)
    await expect(store.init()).rejects.toThrow(/wrong type/)
  })

  it('honours the hold checkbox and the status a human set in Notion over the JSON', async () => {
    const { fake, store } = make()
    await store.init()
    await store.upsert(samplePerson({ hrisId: 'hr-1', status: 'active' }))
    const page = [...fake.pages.values()][0]!
    page.properties['Offboarding Hold'] = { checkbox: true }
    page.properties['Status'] = { select: { name: 'Terminated' } }
    const row = await store.get('hr-1')
    expect(row?.hold).toBe(true)
    expect(row?.status).toBe('terminated')
  })

  it('keeps the structured state through a round trip, split across rich-text chunks', async () => {
    const { store } = make()
    await store.init()
    const long = 'x'.repeat(5000)
    await store.upsert(samplePerson({ hrisId: 'hr-2', aliasEmails: ['old@example.com'], externalIds: { jumpcloudUserId: 'jc-9', googleUserId: 'g-1' }, note: long }))
    const row = await store.get('hr-2')
    expect(row?.aliasEmails).toEqual(['old@example.com'])
    expect(row?.externalIds).toEqual({ jumpcloudUserId: 'jc-9', googleUserId: 'g-1' })
    expect(row?.note).toBe(long)
  })

  it('pages the database query and survives a rate limit', async () => {
    const { fake, store } = make()
    await store.init()
    for (let i = 0; i < 250; i += 1) await store.upsert(samplePerson({ hrisId: `hr-${String(i).padStart(4, '0')}` }))
    fake.rateLimitOnce = true
    const rows = await store.list()
    expect(rows).toHaveLength(250)
    const queries = fake.requests.filter((r) => r.path.endsWith('/query') && r.method === 'POST')
    expect(queries.length).toBeGreaterThanOrEqual(3)
  })

  it('sends the status and hold parts of a filter to Notion and applies the rest itself', async () => {
    const { fake, store } = make()
    await store.init()
    await store.upsert(samplePerson({ hrisId: 'hr-a', status: 'terminated' }))
    await store.upsert(samplePerson({ hrisId: 'hr-b', status: 'active' }))
    fake.requests.length = 0
    const rows = await store.list({ status: ['terminated'], excludeHeld: true, suspendedAt: 'empty' })
    expect(rows.map((r) => r.hrisId)).toEqual(['hr-a'])
    const sent = fake.requests.find((r) => r.path.endsWith('/query'))?.body as { filter?: { and?: unknown[] } }
    expect(JSON.stringify(sent.filter)).toContain('Terminated')
    expect(JSON.stringify(sent.filter)).toContain('Offboarding Hold')
    expect(JSON.stringify(sent.filter)).not.toContain('suspended')
  })
})

/** A database laid out the way most existing ones are: departments and roles as select options. */
function selectTypedFake(): FakeNotion {
  return new FakeNotion('db-people', {
    Name: { type: 'title' },
    Department: { type: 'select', select: { options: [{ name: 'Operations' }] } },
    Role: { type: 'select', select: { options: [] } },
    Source: { type: 'select', select: { options: [] } },
    Manager: { type: 'email' },
  })
}

describePeopleStoreConformance({
  name: 'notion (fake API, select-typed department, role and source)',
  create: async () => make(selectTypedFake()).store,
  writes: (store) => (store as NotionPeopleStore).writes,
  largeListSize: 150,
})

describe('select-typed and email-typed columns', () => {
  it('are accepted by init, written in their own shape and read back as text', async () => {
    const { fake, store } = make(selectTypedFake())
    await store.init()
    expect(fake.database.properties['Department']?.type).toBe('select')
    await store.upsert(samplePerson({ hrisId: 'hr-1', department: 'Finance', jobTitle: 'Analyst', source: 'hris', managerEmail: 'jane.doe@example.com' }))
    const page = [...fake.pages.values()][0]!
    expect(page.properties['Department']).toEqual({ select: { name: 'Finance' } })
    expect(page.properties['Role']).toEqual({ select: { name: 'Analyst' } })
    expect(page.properties['Manager']).toEqual({ email: 'jane.doe@example.com' })
    const read = await store.get('hr-1')
    expect(read?.department).toBe('Finance')
    expect(read?.jobTitle).toBe('Analyst')
    expect(read?.managerEmail).toBe('jane.doe@example.com')
  })

  it('still refuses a type nothing here can read or write', async () => {
    const fake = new FakeNotion('db-people', { Name: { type: 'title' }, Department: { type: 'number' } })
    const { store } = make(fake)
    await expect(store.init()).rejects.toThrow(/"Department" is number, needs rich_text or select/)
  })
})

describe('a read-only store', () => {
  it('reads and counts, refuses every write, and never adds a property', async () => {
    const fake = new FakeNotion()
    const writer = make(fake).store
    await writer.init()
    await writer.upsert(samplePerson({ hrisId: 'hr-1' }))

    // The database now lacks a mapped property, as one owned by somebody else would.
    delete fake.database.properties['Notes']
    const before = Object.keys(fake.database.properties).sort()

    const client = new NotionClient({ http: fake.http(), token: { use: (fn) => fn('notion-token-not-real') } })
    const reader = new NotionPeopleStore({ client, databaseId: fake.database.id, readOnly: true })
    await reader.init()
    expect(Object.keys(fake.database.properties).sort()).toEqual(before)

    expect(await reader.countExact()).toBe(1)
    expect((await reader.get('hr-1'))?.note).toBeNull()
    await expect(reader.upsert(samplePerson({ hrisId: 'hr-2' }))).rejects.toThrow(/readOnly/)
    await expect(reader.patch('hr-1', { note: 'x' })).rejects.toThrow(/readOnly/)
    expect(reader.writes).toBe(0)
    expect(await reader.countExact()).toBe(1)
  })
})
