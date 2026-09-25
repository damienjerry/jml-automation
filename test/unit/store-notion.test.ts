import { describe, expect, it } from 'vitest'
import { describePeopleStoreConformance, samplePerson } from '../../src/store/conformance.ts'
import { NotionClient } from '../../src/store/notion/client.ts'
import { NotionPeopleStore } from '../../src/store/notion/store.ts'
import { FakeNotion } from '../helpers/fake-notion.ts'

function make(fake = new FakeNotion()) {
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
  it('adds every mapped property the database lacks, and nothing else', async () => {
    const { fake, store } = make()
    await store.init()
    const names = Object.keys(fake.database.properties).sort()
    expect(names).toContain('JML State')
    expect(names).toContain('Offboarding Hold')
    expect(fake.database.properties['Status']?.type).toBe('select')
    expect(fake.database.properties['Status']?.select?.options.map((o) => o.name)).toEqual(['Hired', 'Active', 'Terminated', 'Offboarding', 'Departed'])
    // A second init finds nothing missing and touches the schema no further.
    const before = fake.requests.length
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
