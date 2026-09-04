/**
 * Regression: a directory read that stopped after a fixed number of pages.
 *
 * The automation this was ported from fetched provider accounts as exactly two
 * hard-coded pages. Every organisation with more accounts than that silently
 * lost the rest: the missing people came back with no provider id, which made
 * them look like leavers with nothing to offboard, and the engine tombstoned
 * them without ever suspending anything.
 *
 * The rule the fix encodes: page until a page is shorter than the limit, and
 * never treat a full page as the end of the list.
 */

import { describe, expect, it } from 'vitest'
import { JumpCloudClient, JumpCloudTruncated } from '../../src/connectors/jumpcloud/client.ts'
import { FakeHttp, fakeSecret } from '../fixtures/http/fake-http.ts'

function client(http: FakeHttp, maxPages?: number) {
  return new JumpCloudClient({ http, apiKey: fakeSecret(), ...(maxPages ? { maxPages } : {}) })
}

/** A directory of `total` accounts served in pages of `limit`. */
function directory(total: number): FakeHttp {
  return new FakeHttp().on('GET', '/api/systemusers', (req) => {
    const params = new URL(req.url).searchParams
    const skip = Number(params.get('skip'))
    const limit = Number(params.get('limit'))
    const page = Array.from({ length: Math.max(Math.min(limit, total - skip), 0) }, (_, i) => ({
      _id: `usr-${skip + i}`,
      email: `person${skip + i}@example.com`,
    }))
    return { status: 200, body: { results: page } }
  })
}

describe('reading the whole directory', () => {
  it('reads every account when the directory spans several pages', async () => {
    const http = directory(250)
    const rows = await client(http).listV1<{ _id: string }>('/systemusers')
    expect(rows).toHaveLength(250)
    expect(rows.at(-1)?._id).toBe('usr-249')
    expect(http.count('GET', '/systemusers')).toBe(3)
  })

  it('asks for one more page when the last page was exactly full', async () => {
    // The dangerous case: 200 accounts in pages of 100 looks finished after two
    // reads, and the old code stopped there by construction.
    const http = directory(200)
    const rows = await client(http).listV1('/systemusers')
    expect(rows).toHaveLength(200)
    expect(http.count('GET', '/systemusers')).toBe(3)
  })

  it('refuses to return a partial list when it cannot reach the end', async () => {
    const http = directory(10_000)
    await expect(client(http, 5).listV1('/systemusers')).rejects.toBeInstanceOf(JumpCloudTruncated)
  })

  it('pages a version-2 list the same way', async () => {
    const http = new FakeHttp().on('GET', '/api/v2/users/usr-1/systems', (req) => {
      const skip = Number(new URL(req.url).searchParams.get('skip'))
      const page = skip === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: `sys-${i}` })) : [{ id: 'sys-100' }]
      return { status: 200, body: page }
    })
    expect(await client(http).listV2('/v2/users/usr-1/systems')).toHaveLength(101)
  })
})
