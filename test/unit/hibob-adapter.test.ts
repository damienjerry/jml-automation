import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHttpClient } from '../../src/core/http.ts'
import { HiBobAdapter, type HrisHttpClient } from '../../src/hris/hibob/adapter.ts'
import { HrisImplausible, HrisIncomplete } from '../../src/hris/types.ts'
import { FakeHttp, fakeSecret, pagingHttp } from '../helpers/hibob-http.ts'

const RECORDED = JSON.parse(readFileSync('test/fixtures/hris/hibob-people-search.json', 'utf8')) as {
  employees: unknown[]
}

function adapter(http: FakeHttp, overrides: { pageSize?: number; floor?: number; maxPages?: number } = {}) {
  return new HiBobAdapter({
    http,
    serviceUserId: fakeSecret('service-user'),
    serviceToken: fakeSecret('service-secret'),
    pageSize: overrides.pageSize ?? 200,
    minPlausibleHeadcount: overrides.floor ?? 1,
    maxPages: overrides.maxPages ?? 200,
  })
}

/** A minimal record, so a test can be about one field. */
function record(fields: Record<string, unknown>): Record<string, unknown> {
  return { id: 'r-9000', email: 'jane.doe@example.com', displayName: 'Jane Doe', ...fields }
}

describe('reading the recorded people search', () => {
  it('maps every canonical field, including the awkward shapes', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees.slice(0, 2) })
    const snapshot = await adapter(http).fetchAll()

    expect(snapshot.all).toHaveLength(5)
    expect(snapshot.complete).toBe(true)

    const jane = snapshot.all[0]
    expect(jane).toMatchObject({
      hrisId: 'r-2001',
      // Addresses arrive in whatever case the HR system holds them in. A
      // capital letter must not be able to look like a second person.
      primaryEmail: 'jane.doe@example.com',
      displayName: 'Jane Doe',
      department: 'Technology',
      jobTitle: 'IT Manager',
      site: 'Head Office',
      startDate: '2019-05-06',
      managerEmail: null,
      terminationDate: null,
    })

    // The leaving date lives only in the employment table, and that table came
    // back as a single-element list.
    expect(snapshot.all[1]).toMatchObject({
      hrisId: 'r-2002',
      terminationDate: '2026-01-09',
      managerEmail: 'jane.doe@example.com',
    })
  })

  it('keeps a person with no work mailbox instead of dropping them', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees })
    const snapshot = await adapter(http).fetchAll()
    const nameless = snapshot.all.find((p) => p.hrisId === '2003')

    // Dropping this person would be indistinguishable from them leaving.
    expect(nameless).toBeDefined()
    expect(nameless?.primaryEmail).toBe('')
    expect(nameless?.displayName).toBe('Morgan Vale')
  })

  it('falls back through the termination paths in order', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees })
    const snapshot = await adapter(http).fetchAll()

    // The first path held whitespace, so the second answered. An ISO date-time
    // is reduced to the date every decision actually uses.
    expect(snapshot.all.find((p) => p.hrisId === 'r-2005')?.terminationDate).toBe('2025-08-29')
    // Where both paths agree the first one still wins, so remapping the order
    // in config changes which field is authoritative.
    expect(snapshot.all.find((p) => p.hrisId === 'r-2004')?.terminationDate).toBe('2026-01-12')
  })

  it('builds the employed set from the second call, not from a status word', async () => {
    const http = pagingHttp({
      all: RECORDED.employees,
      employed: [RECORDED.employees[0], RECORDED.employees[2]],
    })
    const snapshot = await adapter(http).fetchAll()

    expect([...snapshot.activeIds].sort()).toEqual(['2003', 'r-2001'])
    expect(http.bodyOf(0)['showInactive']).toBe(true)
    expect(http.bodyOf(1)['showInactive']).toBe(false)
  })

  it('never asks for human-readable output and names the fields it wants', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees })
    await adapter(http).fetchAll()
    const body = http.bodyOf(0)

    expect(Object.keys(body)).not.toContain('humanReadable')
    expect(body['fields']).toContain('internal.terminationDate')
    expect(body['fields']).toContain('employment.terminationDate')
  })

  it('sends Basic auth without putting the credential anywhere else', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees })
    await adapter(http).fetchAll()
    const header = http.requests[0]?.headers?.['Authorization'] ?? ''

    expect(header.startsWith('Basic ')).toBe(true)
    expect(JSON.stringify(http.bodyOf(0))).not.toContain('service-secret')
  })
})

describe('wiring', () => {
  it('takes the shared HTTP client with no shim in between', () => {
    // A compile-time check as much as a runtime one. The client hands over a
    // redacted body string plus a json() accessor, and an adapter that read
    // the string as though it were an object would find no people at all,
    // which reads downstream as an empty company.
    const client: HrisHttpClient = createHttpClient()

    expect(typeof client.request).toBe('function')
  })
})

describe('paging', () => {
  const many = Array.from({ length: 7 }, (_, i) => record({ id: `r-30${i}`, email: `p${i}@example.com` }))

  it('reads every page until a short one', async () => {
    const http = pagingHttp({ all: many, employed: many })
    const snapshot = await adapter(http, { pageSize: 3 }).fetchAll()

    expect(snapshot.all).toHaveLength(7)
    // Three pages of three, three, one for each of the two reads.
    expect(http.requests).toHaveLength(6)
    expect(http.bodyOf(1)['offset']).toBe(3)
  })

  it('treats a page that exceeds the limit as an unpaged answer', async () => {
    const http = pagingHttp({ all: many, employed: many, ignoreLimit: true })
    const snapshot = await adapter(http, { pageSize: 3 }).fetchAll()

    expect(snapshot.all).toHaveLength(7)
    expect(http.requests).toHaveLength(2)
  })

  it('refuses to guess when the server ignores the offset', async () => {
    const http = pagingHttp({ all: many, employed: many, ignoreOffset: true })

    await expect(adapter(http, { pageSize: 3 }).fetchAll()).rejects.toBeInstanceOf(HrisIncomplete)
  })

  it('stops at the page cap rather than returning what it managed to read', async () => {
    const endless = new FakeHttp(() => ({
      status: 200,
      body: { employees: [record({ id: `r-${Math.random()}` })] },
    }))

    await expect(adapter(endless, { pageSize: 1, maxPages: 3 }).fetchAll()).rejects.toBeInstanceOf(HrisIncomplete)
  })
})

describe('a response that cannot be trusted', () => {
  it('names the status when the HR system rejects the read', async () => {
    const http = new FakeHttp(() => ({ status: 401, body: { error: 'unauthorised' } }))
    const error = await adapter(http).fetchAll().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisIncomplete)
    // A rejected read that surfaces as a bare network error costs hours, so
    // the status is in the message.
    expect((error as Error).message).toContain('401')
  })

  it('refuses a body with no employees array rather than reading it as an empty company', async () => {
    const http = new FakeHttp(() => ({ status: 200, body: { message: 'ok' } }))

    await expect(adapter(http).fetchAll()).rejects.toBeInstanceOf(HrisIncomplete)
  })

  it('refuses a record with no id', async () => {
    const http = new FakeHttp(() => ({ status: 200, body: { employees: [{ email: 'jane.doe@example.com' }] } }))
    const error = await adapter(http).fetchAll().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisIncomplete)
    expect((error as Error).message).toContain('root.id')
  })
})

describe('the headcount floor', () => {
  it('aborts when the full read is below the floor', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees })
    const error = await adapter(http, { floor: 50 }).fetchAll().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisImplausible)
    expect((error as HrisImplausible).detail).toEqual({ received: 5, floor: 50 })
  })

  it('aborts when the employed read comes back empty', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: [] })
    const error = await adapter(http, { floor: 3 }).fetchAll().catch((e: unknown) => e)

    // Everybody having left on the same day is not a thing that happens; a
    // truncated read of the employed set is.
    expect(error).toBeInstanceOf(HrisImplausible)
    expect((error as HrisImplausible).detail.received).toBe(0)
  })
})

describe('testConnection reports what the credential can do', () => {
  it('says both reads work and that nothing is ever written', async () => {
    const http = pagingHttp({ all: RECORDED.employees, employed: RECORDED.employees.slice(0, 2) })
    const check = await adapter(http).testConnection()

    expect(check.ok).toBe(true)
    expect(check.detail).toContain('2 employed')
    expect(check.detail).toContain('5 including leavers')
    expect(check.detail).toContain('read only')
  })

  it('points at the permission when the people read is refused', async () => {
    const http = new FakeHttp(() => ({ status: 403, body: { error: 'forbidden' } }))
    const check = await adapter(http).testConnection()

    expect(check.ok).toBe(false)
    expect(check.remediation).toContain('People read')
    expect(check.docsAnchor).toBe('docs/credentials.md#hibob')
  })

  it('fails when inactive people cannot be read, because leavers then vanish', async () => {
    const http = new FakeHttp((req) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      if (body['showInactive'] === true) return { status: 403, body: { error: 'forbidden' } }
      return { status: 200, body: { employees: RECORDED.employees.slice(0, 2) } }
    })
    const check = await adapter(http).testConnection()

    expect(check.ok).toBe(false)
    expect(check.remediation).toContain('inactive people')
  })

  it('says so when no leaver is visible, because that reads as a healthy fleet', async () => {
    const http = pagingHttp({ all: RECORDED.employees.slice(0, 2), employed: RECORDED.employees.slice(0, 2) })
    const check = await adapter(http).testConnection()

    expect(check.ok).toBe(true)
    expect(check.detail).toContain('cannot see them')
  })

  it('reports an unreachable host as a failure rather than throwing', async () => {
    const http = new FakeHttp(() => {
      throw new Error('connect ECONNREFUSED')
    })
    const check = await adapter(http).testConnection()

    expect(check.ok).toBe(false)
    expect(check.detail).toContain('ECONNREFUSED')
  })

  it('answers rather than throwing when only the second probe fails', async () => {
    const http = new FakeHttp((req) => {
      const body = (req.body ?? {}) as Record<string, unknown>
      if (body['showInactive'] === true) throw new Error('socket hang up')
      return { status: 200, body: { employees: RECORDED.employees.slice(0, 2) } }
    })
    const check = await adapter(http).testConnection()

    expect(check.ok).toBe(false)
    expect(check.detail).toContain('socket hang up')
  })
})
