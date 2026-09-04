/**
 * Prevents: a partial HR read being reconciled as a wave of departures.
 *
 * A truncated read looks exactly like a company where everybody left. The
 * adapter refuses one, and this file asserts that the sync refuses it too,
 * because the snapshot can also reach the sync from a fixture file, a recorded
 * replay, a cached response, or an adapter somebody else wrote. A safeguard
 * that lives only in the adapter protects only the adapter's own path.
 *
 * Three refusals, and all of them happen before a single row is read, so an
 * abort really does mean zero writes rather than "it stopped when it noticed".
 */

import { describe, expect, it } from 'vitest'
import { runSync } from '../../src/engine/sync.ts'
import { HrisImplausible, HrisIncomplete } from '../../src/hris/types.ts'
import { harness, hrisPerson, snapshot, storedPerson } from '../helpers/sync-harness.ts'

/** Twelve employed people, one of whom the store already knows. */
const STAFF = Array.from({ length: 12 }, (_, index) =>
  hrisPerson({
    hrisId: `hr-${String(index).padStart(3, '0')}`,
    primaryEmail: `person-${index}@example.com`,
    displayName: `Person ${index}`,
  }),
)

function seeded() {
  return harness([storedPerson({ hrisId: 'hr-000', primaryEmail: 'person-0@example.com', displayName: 'Person 0' })])
}

describe('a snapshot the sync must not act on', () => {
  it('refuses a read the adapter marked incomplete', async () => {
    const h = seeded()
    const error = await runSync(
      h.options(snapshot(STAFF, undefined, { complete: false }), { minPlausibleHeadcount: 10 }),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisIncomplete)
    expect(h.store.writes).toBe(0)
  })

  it('refuses a snapshot below the stated headcount floor', async () => {
    const h = seeded()
    const error = await runSync(
      h.options(snapshot(STAFF.slice(0, 3)), { minPlausibleHeadcount: 10 }),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisImplausible)
    expect((error as HrisImplausible).detail).toEqual({ received: 3, floor: 10 })
    expect(h.store.writes).toBe(0)
  })

  it('refuses a full list whose employed set alone came back short', async () => {
    // The employed set is usually a second paged read, so it can be truncated
    // on its own while the full list looks perfectly healthy. This is the
    // shape that would flip an entire staff list to terminated.
    const h = seeded()
    const error = await runSync(
      h.options(snapshot(STAFF, ['hr-000', 'hr-001']), { minPlausibleHeadcount: 10 }),
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisImplausible)
    expect(h.store.writes).toBe(0)
  })

  it('leaves the status of a row it would otherwise have terminated', async () => {
    const h = seeded()
    await runSync(h.options(snapshot([], []), { minPlausibleHeadcount: 10 })).catch(() => undefined)

    expect((await h.store.get('hr-000'))?.status).toBe('active')
  })

  it('proceeds on a snapshot that is complete and plausible', async () => {
    // The refusals must not be so eager that an ordinary run cannot happen.
    const h = seeded()
    const report = await runSync(h.options(snapshot(STAFF), { minPlausibleHeadcount: 10 }))

    expect(report.counts.created).toBe(11)
    expect(report.ok).toBe(true)
  })
})
