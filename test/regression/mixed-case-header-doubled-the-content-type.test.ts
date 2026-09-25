/**
 * The HR system answered 415 to every people search on the first run against
 * a real tenant.
 *
 * The adapter set `Content-Type: application/json`; the HTTP client applied
 * its own `content-type` default beside it, because a plain object treats the
 * two spellings as different keys. fetch folds them into one header whose value
 * is `application/json, application/json`, which the HR system rejects as an
 * unsupported media type. Every test had passed, because the adapter tests
 * drive a fake HTTP layer that never merges headers. The client now folds
 * header names to lower case before applying any default, so a caller's
 * spelling can never produce a second copy of the same header.
 */
import { describe, expect, it } from 'vitest'
import { createHttpClient } from '../../src/core/http.ts'

function capture() {
  const seen: Headers[] = []
  const http = createHttpClient({
    fetchImpl: async (_url, init) => {
      seen.push(new Headers(init?.headers as Record<string, string>))
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
    maxRetries: 0,
  })
  return { http, seen }
}

describe('a caller spelling a header in mixed case', () => {
  it('sends exactly one content-type for a JSON body', async () => {
    const { http, seen } = capture()
    await http.request({
      method: 'POST',
      url: 'https://hr.example.com/v1/people/search',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: { showInactive: false },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.get('content-type')).toBe('application/json')
    expect(seen[0]?.get('accept')).toBe('application/json')
  })

  it('keeps a caller-supplied content type rather than replacing it with the default', async () => {
    const { http, seen } = capture()
    await http.request({
      method: 'POST',
      url: 'https://api.example.com/v1/things',
      headers: { 'Content-Type': 'application/vnd.example+json' },
      body: { a: 1 },
    })
    expect(seen[0]?.get('content-type')).toBe('application/vnd.example+json')
  })
})
