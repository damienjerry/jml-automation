/**
 * Failure this prevents: the HR read paged only once.
 *
 * An earlier design had a `while (hasMore)` loop that set
 * `hasMore = false` after the first call and never used the offset. It read
 * one page of people and reported success. Everybody past that page was
 * absent from the snapshot, which is the same signal as having left, so the
 * moment a downstream step trusted the snapshot it would have offboarded
 * people who were still employed.
 *
 * Two rules keep it dead: the read only finishes on a short page, and a read
 * that cannot page throws rather than returning what it managed to collect.
 */

import { describe, expect, it } from 'vitest'
import { HiBobAdapter } from '../../src/hris/hibob/adapter.ts'
import { FixtureHrisAdapter } from '../../src/hris/fixture.ts'
import { HrisIncomplete } from '../../src/hris/types.ts'
import { fakeSecret, pagingHttp } from '../helpers/hibob-http.ts'

const PEOPLE = Array.from({ length: 250 }, (_, i) => ({
  id: `r-4${String(i).padStart(3, '0')}`,
  email: `person${i}@example.com`,
  displayName: `Person ${i}`,
  work: { startDate: '2024-01-08' },
  internal: {},
}))

function adapter(http: ReturnType<typeof pagingHttp>) {
  return new HiBobAdapter({
    http,
    serviceUserId: fakeSecret('service-user'),
    serviceToken: fakeSecret('service-secret'),
    pageSize: 100,
    minPlausibleHeadcount: 200,
  })
}

describe('a paged HR read', () => {
  it('returns everybody, not the first page', async () => {
    const http = pagingHttp({ all: PEOPLE, employed: PEOPLE })
    const snapshot = await adapter(http).fetchAll()

    expect(snapshot.all).toHaveLength(250)
    expect(snapshot.activeIds.size).toBe(250)
    // The last person in the list is the one a single-call read would lose.
    expect(snapshot.all.at(-1)?.hrisId).toBe('r-4249')
  })

  it('throws instead of returning one page when the server ignores paging', async () => {
    const http = pagingHttp({ all: PEOPLE, employed: PEOPLE, ignoreOffset: true })
    const error = await adapter(http).fetchAll().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisIncomplete)
    // The message has to name the fix, because the symptom of this bug is a
    // sync that looks perfectly healthy.
    expect((error as Error).message).toContain('pageSize')
  })

  it('refuses a snapshot a file has declared partial', async () => {
    const fixture = new FixtureHrisAdapter({ path: 'test/fixtures/hris/truncated.json' })

    await expect(fixture.fetchAll()).rejects.toBeInstanceOf(HrisIncomplete)
  })
})
