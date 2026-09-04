/**
 * Failure this prevents: a small snapshot read as a mass departure.
 *
 * A truncated read, a filtered credential and a company where everybody left
 * on the same day all look identical downstream: a short list of people and an
 * employed set that is missing most of them. The consequence of getting it
 * wrong once is the whole staff suspended, so the adapter refuses to hand over
 * a snapshot below a floor the adopter states themselves.
 *
 * The refusal happens before anything is returned, so a caller cannot write
 * from a snapshot that was never produced.
 */

import { describe, expect, it } from 'vitest'
import { HiBobAdapter } from '../../src/hris/hibob/adapter.ts'
import { FixtureHrisAdapter } from '../../src/hris/fixture.ts'
import { HrisImplausible } from '../../src/hris/types.ts'
import { fakeSecret, pagingHttp } from '../helpers/hibob-http.ts'

const PEOPLE = Array.from({ length: 120 }, (_, i) => ({
  id: `r-6${String(i).padStart(3, '0')}`,
  email: `person${i}@example.com`,
  displayName: `Person ${i}`,
  work: { startDate: '2024-01-08' },
  internal: {},
}))

function adapter(all: unknown[], employed: unknown[], floor = 100) {
  return new HiBobAdapter({
    http: pagingHttp({ all, employed }),
    serviceUserId: fakeSecret('service-user'),
    serviceToken: fakeSecret('service-secret'),
    pageSize: 200,
    minPlausibleHeadcount: floor,
  })
}

describe('the headcount floor', () => {
  it('lets a healthy snapshot through', async () => {
    const snapshot = await adapter(PEOPLE, PEOPLE.slice(0, 110)).fetchAll()

    expect(snapshot.all).toHaveLength(120)
    expect(snapshot.activeIds.size).toBe(110)
  })

  it('aborts with no snapshot when the people read is short', async () => {
    let produced: unknown = 'nothing was produced'
    try {
      produced = await adapter(PEOPLE.slice(0, 3), PEOPLE.slice(0, 3)).fetchAll()
      expect.unreachable('a snapshot below the floor must not be returned')
    } catch (error) {
      expect(error).toBeInstanceOf(HrisImplausible)
      expect((error as HrisImplausible).detail).toEqual({ received: 3, floor: 100 })
    }
    expect(produced).toBe('nothing was produced')
  })

  it('aborts when the employed read is short but the full read is fine', async () => {
    // This is the dangerous shape: the people are all there, so a naive
    // sanity check passes, and only the employed set has been truncated. Every
    // missing person reads as a leaver.
    const error = await adapter(PEOPLE, PEOPLE.slice(0, 4)).fetchAll().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisImplausible)
    expect((error as HrisImplausible).detail.received).toBe(4)
  })

  it('refuses to be constructed without a floor worth the name', () => {
    expect(() => adapter(PEOPLE, PEOPLE, 0)).toThrow(/positive whole number/)
  })

  it('applies to a hand-written snapshot too', async () => {
    const fixture = new FixtureHrisAdapter({ path: 'test/fixtures/hris/demo.json', minPlausibleHeadcount: 100 })

    await expect(fixture.fetchAll()).rejects.toBeInstanceOf(HrisImplausible)
  })
})
