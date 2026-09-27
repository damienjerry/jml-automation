/**
 * Failure this prevents: a leaving date parsed out of a human-readable string.
 *
 * An earlier design asked the HR system for human-readable
 * output and then split the result on slashes, treating the first component as
 * the day. That is correct in one locale and silently wrong in others, and the
 * value decides which morning somebody loses their accounts. Worse, the same
 * code path also ran where the request had not asked for human-readable
 * output, so the two behaviours coexisted in one estate.
 *
 * The adapter now asks for machine-readable dates and treats anything that is
 * not an ISO date as a broken read of the whole snapshot. Refusing the
 * snapshot is deliberate: a date it cannot read is a systemic fault, either a
 * field map pointing at the wrong field or a request that grew a
 * human-readable flag, and neither is safe to work around one record at a time.
 */

import { describe, expect, it } from 'vitest'
import { HiBobAdapter } from '../../src/hris/hibob/adapter.ts'
import { HrisIncomplete } from '../../src/hris/types.ts'
import { toIsoDate } from '../../src/hris/hibob/fields.ts'
import { FakeHttp, fakeSecret, pagingHttp } from '../helpers/hibob-http.ts'

function adapter(http: FakeHttp) {
  return new HiBobAdapter({
    http,
    serviceUserId: fakeSecret('service-user'),
    serviceToken: fakeSecret('service-secret'),
    minPlausibleHeadcount: 1,
  })
}

const LOCALE_LEAVER = {
  id: 'r-5001',
  email: 'robin.ellis@example.com',
  displayName: 'Robin Ellis',
  work: { startDate: '2023-01-09' },
  // The ambiguous case: this is either the ninth of January or the first of
  // September, and nothing in the response says which.
  internal: { terminationDate: '09/01/2026' },
}

describe('locale-formatted dates', () => {
  it('never reach a person record', async () => {
    const http = pagingHttp({ all: [LOCALE_LEAVER], employed: [LOCALE_LEAVER] })
    const error = await adapter(http).fetchAll().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisIncomplete)
    expect((error as Error).message).toContain('internal.terminationDate')
  })

  it('are refused rather than reordered into an ISO date', () => {
    expect(() => toIsoDate('09/01/2026', 'internal.terminationDate')).toThrow(HrisIncomplete)
    expect(() => toIsoDate('9 Jan 2026', 'internal.terminationDate')).toThrow(HrisIncomplete)
    expect(() => toIsoDate('2026/01/09', 'internal.terminationDate')).toThrow(HrisIncomplete)
    // A serial number from a spreadsheet export is refused for the same
    // reason: the epoch it counts from is not stated anywhere.
    expect(() => toIsoDate(45301, 'internal.terminationDate')).toThrow(HrisIncomplete)
  })

  it('cannot be requested by the adapter in the first place', async () => {
    const http = pagingHttp({ all: [], employed: [] })
    await adapter(http).fetchAll().catch(() => undefined)

    for (const req of http.requests) {
      expect(Object.keys((req.body ?? {}) as Record<string, unknown>)).not.toContain('humanReadable')
    }
  })

  it('still accepts a real ISO value, with or without a time', () => {
    expect(toIsoDate('2026-01-09', 'x')).toBe('2026-01-09')
    expect(toIsoDate('2026-01-09T23:30:00.000Z', 'x')).toBe('2026-01-09')
    expect(toIsoDate('', 'x')).toBeNull()
    expect(toIsoDate(null, 'x')).toBeNull()
  })
})
