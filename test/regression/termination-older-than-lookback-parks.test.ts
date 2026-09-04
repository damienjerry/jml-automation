/**
 * Prevents: a stale leaving date being treated as a fresh departure.
 *
 * What happened. Neither the status flip nor the offboarding selection had any
 * cutoff on the leaving date, so any row that arrived at "terminated" was a
 * candidate for suspension regardless of whether the person left last week or
 * three years ago. That is the mechanism behind two separate leaks, one of a
 * few accounts and one of several hundred.
 *
 * The rule: entering terminated with a leaving date that is missing, or older
 * than the configured lookback, still writes terminated, and sets
 * reviewReason termination_older_than_lookback so nothing automatic acts on the
 * row.
 *
 * Why the status stays truthful rather than being parked as active: any row in
 * hired or active claims its own identifiers, and the engine refuses to act on
 * an identifier an employed row claims. Parking a leaver as active would let
 * them go on shielding their own account from the very check that protects
 * everybody else's.
 */

import { describe, expect, it } from 'vitest'
import { runSync } from '../../src/engine/sync.ts'
import { DAY0_SELECTION } from '../../src/store/bootstrap.ts'
import { ANCHOR, harness, hrisPerson, snapshot, storedPerson } from '../helpers/sync-harness.ts'

/** Today is 2026-03-10 in the harness, and the lookback is 60 days. */
async function leaves(terminationDate: string | null) {
  const h = harness([storedPerson()])
  const report = await runSync(
    h.options(snapshot([hrisPerson({ terminationDate }), ANCHOR], [ANCHOR.hrisId])),
  )
  return { report, person: await h.store.get('hr-001'), store: h.store }
}

describe('a leaver whose date is outside the lookback', () => {
  it('becomes terminated and parked, not active and not selectable', async () => {
    const { report, person, store } = await leaves('2024-11-30')

    expect(person?.status).toBe('terminated')
    expect(person?.reviewReason).toBe('termination_older_than_lookback')
    expect(await store.countExact(DAY0_SELECTION)).toBe(0)
    // The reason has to be readable without opening the code: somebody has to
    // decide whether this is historic or a genuinely late record.
    expect(report.rows[0]?.reason).toContain('60-day lookback')
  })

  it('is parked the same way when the HR system holds no date at all', async () => {
    const { person } = await leaves(null)

    expect(person?.status).toBe('terminated')
    expect(person?.reviewReason).toBe('termination_older_than_lookback')
  })

  it('is not parked when the date is recent, or the toolkit would never do anything', async () => {
    const { person, store } = await leaves('2026-03-09')

    expect(person?.status).toBe('terminated')
    expect(person?.reviewReason ?? null).toBeNull()
    expect(await store.countExact(DAY0_SELECTION)).toBe(1)
  })

  it('parks a row that was already terminated and never given a reason', async () => {
    // An import, or a row that arrived before the rule existed. The check is
    // applied on every run while the row is unsuspended, so a gap in history
    // does not become a gap in the guard.
    const h = harness([storedPerson({ status: 'terminated', terminationDate: '2023-01-31' })])
    const report = await runSync(
      h.options(snapshot([hrisPerson({ terminationDate: '2023-01-31' }), ANCHOR], [ANCHOR.hrisId])),
    )

    expect(report.counts.parked).toBe(1)
    expect((await h.store.get('hr-001'))?.reviewReason).toBe('termination_older_than_lookback')
  })

  it('writes the reason once and nothing on the run after', async () => {
    const h = harness([storedPerson({ status: 'terminated', terminationDate: '2023-01-31' })])
    const snap = snapshot([hrisPerson({ terminationDate: '2023-01-31' }), ANCHOR], [ANCHOR.hrisId])
    await runSync(h.options(snap))
    const afterFirst = h.store.writes
    await runSync(h.options(snap))

    expect(h.store.writes).toBe(afterFirst)
  })

  it('never clears a reason a person has to clear themselves', async () => {
    const h = harness([
      storedPerson({ status: 'terminated', terminationDate: '2026-03-09', reviewReason: 'identity_mismatch' }),
    ])
    await runSync(h.options(snapshot([hrisPerson({ terminationDate: '2026-03-09' }), ANCHOR], [ANCHOR.hrisId])))

    expect((await h.store.get('hr-001'))?.reviewReason).toBe('identity_mismatch')
  })
})
