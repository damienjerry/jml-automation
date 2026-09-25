/**
 * A leaver's access stayed open between their last day in and the day their
 * contract ended.
 *
 * The HR system keeps somebody on the employed list until the contract ends,
 * and holds the last working day in a separate field. The sync keyed on the
 * employed list alone, so somebody whose last shift was on the Wednesday kept a
 * working laptop and mailbox until the Friday, and longer where notice was
 * served away from work. Offboarding must start the day after the last working
 * day, while the HR system still reports the person as employed.
 */
import { describe, expect, it } from 'vitest'
import { deriveHrisStatus, runSync } from '../../src/engine/sync.ts'
import { ANCHOR, harness, hrisPerson, snapshot } from '../helpers/sync-harness.ts'

const LEAVER = hrisPerson({
  hrisId: 'hr-leaver',
  primaryEmail: 'jane.doe@example.com',
  startDate: '2024-01-08',
  terminationDate: '2026-03-31',
  lastWorkingDay: '2026-03-27',
})

describe('a leaver still on the employed list', () => {
  it('is active on the last working day itself, so they can hand over', () => {
    expect(deriveHrisStatus(LEAVER, new Set([LEAVER.hrisId, ANCHOR.hrisId]), '2026-03-27')).toBe('active')
  })

  it('is terminated the day after the last working day, before the contract ends', () => {
    expect(deriveHrisStatus(LEAVER, new Set([LEAVER.hrisId, ANCHOR.hrisId]), '2026-03-28')).toBe('terminated')
  })

  it('still becomes terminated at the contract end when no last working day is held', () => {
    const contractOnly = hrisPerson({ ...LEAVER, lastWorkingDay: null })
    const employed = new Set([contractOnly.hrisId, ANCHOR.hrisId])
    expect(deriveHrisStatus(contractOnly, employed, '2026-03-31')).toBe('active')
    expect(deriveHrisStatus(contractOnly, employed, '2026-04-01')).toBe('terminated')
  })

  it('moves the stored row to terminated through the sync, ready for day 0', async () => {
    const h = harness()
    const snap = snapshot([LEAVER, ANCHOR])

    await runSync(h.options(snap, { today: '2026-03-27' }))
    expect((await h.store.get(LEAVER.hrisId))?.status).toBe('active')

    await runSync(h.options(snap, { today: '2026-03-28' }))
    const row = await h.store.get(LEAVER.hrisId)
    expect(row?.status).toBe('terminated')
    expect(row?.lastWorkingDay).toBe('2026-03-27')
    // Inside the lookback, so it is a real leaver and not parked as historic.
    expect(row?.reviewReason ?? null).toBeNull()
  })
})
