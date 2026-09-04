import { describe, expect, it } from 'vitest'
import { createHttpClient, httpErrorFrom, HttpError, retryableStatus, safeUrl } from '../../src/core/http.ts'
import { redactor, REDACTED } from '../../src/config/redact.ts'

/** A fetch stand-in that replays scripted responses and records the calls. */
function scripted(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []
  let index = 0
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    // Cloned because a Response body can only be read once, and a retry test
    // asks for the same scripted response twice.
    return (next as Response).clone()
  }
  return { calls, fetchImpl }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function client(responses: (Response | Error)[], overrides: Record<string, unknown> = {}) {
  const { calls, fetchImpl } = scripted(responses)
  const waits: number[] = []
  const http = createHttpClient({
    fetchImpl,
    sleep: async (ms) => void waits.push(ms),
    random: () => 0.5,
    maxRetries: 2,
    ...overrides,
  })
  return { http, calls, waits }
}

describe('non-2xx responses', () => {
  it('returns the status and the body instead of throwing', async () => {
    // The whole reason this module exists: the helper it replaces threw on any
    // non-2xx and lost the body, so a 401 naming the missing authorisation was
    // diagnosed as a network fault for hours.
    const { http } = client([json(401, { error: 'unauthorized_client', error_description: 'not authorised for this scope' })])
    const res = await http.get('https://api.example.com/v1/users')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(401)
    expect(res.json<{ error: string }>()?.error).toBe('unauthorized_client')
    expect(res.body).toContain('not authorised for this scope')
  })

  it('does not retry a 401, so a credential problem surfaces as one', async () => {
    const { http, calls } = client([json(401, {})], { maxRetries: 3 })
    const res = await http.get('https://api.example.com/v1/users')
    expect(res.attempts).toBe(1)
    expect(calls).toHaveLength(1)
    expect(retryableStatus(401, true)).toBe(false)
    expect(retryableStatus(403, true)).toBe(false)
  })

  it('treats a 3xx as not ok, because a redirect is not success', async () => {
    const { http } = client([new Response(null, { status: 302, headers: { location: '/v2/users' } })])
    expect((await http.get('https://api.example.com/v1/users')).ok).toBe(false)
  })

  it('returns null from json() on a body that is not JSON', async () => {
    const { http } = client([new Response('<html>gateway</html>', { status: 502 })])
    const res = await http.get('https://api.example.com/v1/users', { maxRetries: 0 })
    expect(res.json()).toBeNull()
  })
})

describe('retries', () => {
  it('honours Retry-After in seconds on a 429', async () => {
    const { http, waits } = client([json(429, { error: 'rate limited' }, { 'retry-after': '7' }), json(200, { ok: true })])
    const res = await http.get('https://api.example.com/v1/users')
    expect(res.status).toBe(200)
    expect(res.attempts).toBe(2)
    expect(waits).toEqual([7000])
  })

  it('honours Retry-After given as a date', async () => {
    const at = new Date(Date.now() + 5000).toUTCString()
    const { http, waits } = client([json(429, {}, { 'retry-after': at }), json(200, {})])
    await http.get('https://api.example.com/v1/users')
    expect(waits[0]).toBeGreaterThan(3000)
    expect(waits[0]).toBeLessThanOrEqual(5000)
  })

  it('caps a Retry-After that would park the run', async () => {
    const { http, waits } = client([json(429, {}, { 'retry-after': '3600' }), json(200, {})], { maxRetryDelayMs: 2000 })
    await http.get('https://api.example.com/v1/users')
    expect(waits).toEqual([2000])
  })

  it('backs off on a 5xx and gives up with the body intact', async () => {
    const { http, waits } = client([json(503, { error: 'upstream down' })])
    const res = await http.get('https://api.example.com/v1/users')
    expect(res.status).toBe(503)
    expect(res.attempts).toBe(3)
    expect(waits).toHaveLength(2)
    expect(res.body).toContain('upstream down')
  })

  it('does not retry a 5xx when the caller says the request is not safe to repeat', async () => {
    // Suspending an account twice is harmless. Starting a file transfer twice
    // creates two transfers.
    const { http } = client([json(500, {})])
    const res = await http.post('https://api.example.com/v1/transfers', { from: 'a' }, { retryOn5xx: false })
    expect(res.attempts).toBe(1)
  })

  it('retries a transport failure, then throws because there is no response to return', async () => {
    const { http, waits } = client([new Error('ECONNRESET')])
    const err = await http.get('https://api.example.com/v1/users').catch((e) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(0)
    expect(err.detail.retryable).toBe(true)
    expect(waits).toHaveLength(2)
  })

  it('reports each retry so a slow run is explicable', async () => {
    const seen: string[] = []
    const { fetchImpl } = scripted([json(429, {}), json(200, {})])
    const http = createHttpClient({
      fetchImpl,
      sleep: async () => undefined,
      onRetry: (info) => seen.push(info.reason),
    })
    await http.get('https://api.example.com/v1/users')
    expect(seen).toEqual(['status 429'])
  })
})

describe('request shaping', () => {
  it('sends an object as JSON and a string as given', async () => {
    const { fetchImpl, calls } = scripted([json(200, {}), json(200, {})])
    const http = createHttpClient({ fetchImpl })
    await http.post('https://api.example.com/v1/a', { name: 'x' })
    await http.put('https://api.example.com/v1/b', 'raw-body')
    expect(calls[0]?.init.body).toBe('{"name":"x"}')
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(calls[1]?.init.body).toBe('raw-body')
  })

  it('appends a query string and drops absent values', async () => {
    const { fetchImpl, calls } = scripted([json(200, {})])
    const http = createHttpClient({ fetchImpl })
    await http.get('https://api.example.com/v1/users', { query: { limit: 100, skip: 0, filter: undefined, active: null } })
    expect(calls[0]?.url).toBe('https://api.example.com/v1/users?limit=100&skip=0')
  })

  it('never returns a set-cookie or authorization header to a caller who may log it', async () => {
    const { http } = client([new Response('{}', { status: 200, headers: { 'set-cookie': 'session=abc', 'x-limit': '10' } })])
    const res = await http.get('https://api.example.com/v1/users')
    expect(res.headers['x-limit']).toBe('10')
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('errors are safe to log', () => {
  it('redacts a registered credential echoed in a body', async () => {
    redactor.register('echoed-credential-value')
    const { http } = client([json(400, { message: 'bad key: echoed-credential-value' })])
    const res = await http.get('https://api.example.com/v1/users', { maxRetries: 0 })
    expect(res.body).not.toContain('echoed-credential-value')
    expect(res.body).toContain(REDACTED)
  })

  it('truncates a long body in the error it builds', () => {
    const res = { ok: false, status: 500, body: 'x'.repeat(5000), attempts: 1 }
    const err = httpErrorFrom(res, 'https://api.example.com/v1/users', 'list users')
    expect(err.detail.body?.length).toBeLessThan(2200)
    expect(err.message).toContain('[truncated]')
  })

  it('drops the query string, because a URL can itself be a credential', () => {
    expect(safeUrl('https://ping.example.com/hooks/abc?token=xyz')).toBe('https://ping.example.com/hooks/abc?[redacted]')
    expect(safeUrl('https://api.example.com/v1/users')).toBe('https://api.example.com/v1/users')
  })
})
