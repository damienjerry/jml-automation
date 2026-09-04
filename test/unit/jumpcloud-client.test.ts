import { describe, expect, it } from 'vitest'
import {
  associationId,
  isDirectAssociation,
  isRetryableStatus,
  JumpCloudApiError,
  JumpCloudClient,
  JUMPCLOUD_DEFAULT_BASE_URL,
  JumpCloudTruncated,
  preview,
} from '../../src/connectors/jumpcloud/client.ts'
import { FakeHttp, fakeSecret } from '../fixtures/http/fake-http.ts'

function client(http: FakeHttp, baseUrl?: string, maxPages?: number) {
  return new JumpCloudClient({
    http,
    apiKey: fakeSecret(),
    ...(baseUrl ? { baseUrl } : {}),
    ...(maxPages ? { maxPages } : {}),
  })
}

describe('the client and the host it talks to', () => {
  it('defaults to the console host, because some tenants answer only there', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 200, body: { results: [] } })
    await client(http).listV1('/systemusers')
    expect(http.requests.at(0)?.url.startsWith(JUMPCLOUD_DEFAULT_BASE_URL)).toBe(true)
  })

  it('honours an overridden base URL and trims a trailing slash', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 200, body: { results: [] } })
    await client(http, 'https://example.com/api/').listV1('/systemusers')
    expect(http.requests.at(0)?.url).toBe('https://example.com/api/systemusers?limit=100&skip=0')
  })

  it('sends the key as a header and never in the URL', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 200, body: { results: [] } })
    await client(http).listV1('/systemusers')
    const req = http.requests.at(0)
    expect(req?.headers?.['x-api-key']).toBe('test-key-value')
    expect(req?.url).not.toContain('test-key-value')
  })
})

describe('paging', () => {
  it('reads a version-1 list until a page is shorter than the limit', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', (req) => {
      const skip = Number(new URL(req.url).searchParams.get('skip'))
      const page = skip === 0 ? Array.from({ length: 100 }, (_, i) => ({ _id: `usr-${i}` })) : [{ _id: 'usr-100' }]
      return { status: 200, body: { results: page } }
    })
    const rows = await client(http).listV1('/systemusers')
    expect(rows).toHaveLength(101)
    expect(http.count('GET', '/systemusers')).toBe(2)
  })

  it('reads a version-2 list, which returns a bare array', async () => {
    const http = new FakeHttp().on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ id: 'sys-1' }] })
    const rows = await client(http).listV2('/v2/users/usr-1/systems')
    expect(rows).toEqual([{ id: 'sys-1' }])
  })

  it('refuses to treat a page cap as the end of the list', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ _id: `usr-${i}` }))
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 200, body: { results: full } })
    await expect(client(http, undefined, 3).listV1('/systemusers')).rejects.toBeInstanceOf(JumpCloudTruncated)
  })

  it('refuses a body that is not a list rather than reading it as empty', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 200, body: { unexpected: true } })
    await expect(client(http).listV1('/systemusers')).rejects.toBeInstanceOf(JumpCloudTruncated)
  })

  it('surfaces the status of a failed page instead of returning what it read', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 503, text: 'upstream unavailable' })
    await expect(client(http).listV1('/systemusers')).rejects.toMatchObject({ status: 503, retryable: true })
  })
})

describe('non-2xx handling', () => {
  it('returns the response for call, so a caller can treat 404 as absent', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers/usr-1', { status: 404, body: null })
    const res = await client(http).call('GET', '/systemusers/usr-1')
    expect(res.status).toBe(404)
  })

  it('throws a typed error for expectOk, carrying a truncated body', async () => {
    const long = 'x'.repeat(900)
    const http = new FakeHttp().on('GET', '/api/systemusers/usr-1', { status: 400, text: long })
    const err = await client(http)
      .expectOk('GET', '/systemusers/usr-1')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JumpCloudApiError)
    expect((err as JumpCloudApiError).bodyPreview.length).toBeLessThan(500)
    expect((err as JumpCloudApiError).retryable).toBe(false)
  })

  it('treats rate limits and server errors as worth retrying, and 4xx as a decision', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(403)).toBe(false)
  })

  it('truncates a long error body, because it ends up in an audit row', () => {
    const json = <T,>(): T | null => null
    expect(preview({ status: 400, body: '{"error":"bad"}', json })).toBe('{"error":"bad"}')
    expect(preview({ status: 400, body: 'x'.repeat(900), json })).toHaveLength(403)
  })
})

describe('id shapes, because the two endpoints disagree', () => {
  it('reads an id at the top level or nested under to', () => {
    expect(associationId({ id: 'sys-1' })).toBe('sys-1')
    expect(associationId({ _id: 'sys-2' })).toBe('sys-2')
    expect(associationId({ to: { id: 'sys-3' } })).toBe('sys-3')
    expect(associationId({ to: { _id: 'sys-4' } })).toBe('sys-4')
  })

  it('returns null when there is genuinely no id, rather than guessing', () => {
    expect(associationId({ to: {} })).toBeNull()
    expect(associationId(null)).toBeNull()
    expect(associationId('sys-1')).toBeNull()
  })

  it('counts a single hop as direct and a longer path as group-derived', () => {
    expect(isDirectAssociation({ id: 'usr-1' })).toBe(true)
    expect(isDirectAssociation({ id: 'usr-1', paths: [] })).toBe(true)
    expect(isDirectAssociation({ id: 'usr-1', paths: [[{ type: 'user' }]] })).toBe(true)
    expect(isDirectAssociation({ id: 'usr-1', paths: [[{ type: 'user_group' }, { type: 'system_group' }]] })).toBe(
      false,
    )
    expect(isDirectAssociation(null)).toBe(false)
  })
})
