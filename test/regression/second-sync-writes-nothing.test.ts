/**
 * Prevents: a sync that writes every field on every run.
 *
 * It looks harmless, and it is not. Three things broke because of it. Values a
 * person had entered by hand were erased, because the HR system carried
 * nothing for those fields and a blank was written over them. Every run looked
 * like a change, so the change-only alerting downstream fired constantly and
 * was muted, which is how a channel stops being read. And the audit log filled
 * with rows describing writes that changed nothing, so it stopped being a
 * record of anything.
 *
 * The claim being tested is narrow and checkable: given the same snapshot
 * twice, the second run performs ZERO writes. The store counts its own writes,
 * so this is a measurement rather than an impression.
 */

import { describe, expect, it } from 'vitest'
import { runSync } from '../../src/engine/sync.ts'
import { ANCHOR, harness, hrisPerson, snapshot, storedPerson } from '../helpers/sync-harness.ts'

/** One of each row the sync has to handle, in one fixture. */
const SEED = [
  storedPerson({ hrisId: 'hr-active' }),
  storedPerson({ hrisId: 'hr-starting', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone', status: 'hired', startDate: '2026-03-01' }),
  storedPerson({ hrisId: 'hr-leaving', primaryEmail: 'kit.marlowe@example.com', displayName: 'Kit Marlowe', terminationDate: '2026-03-09' }),
  storedPerson({ hrisId: 'hr-stale', primaryEmail: 'lee.nakamura@example.com', displayName: 'Lee Nakamura', terminationDate: '2023-08-29' }),
  storedPerson({
    hrisId: 'hr-offboarding',
    primaryEmail: 'robin.ellis@example.com',
    displayName: 'Robin Ellis',
    status: 'offboarding',
    terminationDate: '2026-03-01',
    offboarding: { suspendedAt: '2026-03-02', legs: {} },
  }),
  storedPerson({ hrisId: 'hr-gone', primaryEmail: 'max.iqbal@example.com', displayName: 'Max Iqbal', status: 'departed', terminationDate: '2025-11-30' }),
  storedPerson({ hrisId: 'hr-held', primaryEmail: 'jo.fenn@example.com', displayName: 'Jo Fenn', hold: true, holdReason: 'kit not returned' }),
]

const SNAPSHOT = snapshot(
  [
    hrisPerson({ hrisId: 'hr-active' }),
    hrisPerson({ hrisId: 'hr-starting', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone', startDate: '2026-03-01' }),
    hrisPerson({ hrisId: 'hr-leaving', primaryEmail: 'kit.marlowe@example.com', displayName: 'Kit Marlowe', terminationDate: '2026-03-09' }),
    hrisPerson({ hrisId: 'hr-stale', primaryEmail: 'lee.nakamura@example.com', displayName: 'Lee Nakamura', terminationDate: '2023-08-29' }),
    hrisPerson({ hrisId: 'hr-offboarding', primaryEmail: 'robin.ellis@example.com', displayName: 'Robin Ellis', terminationDate: '2026-03-01' }),
    hrisPerson({ hrisId: 'hr-gone', primaryEmail: 'max.iqbal@example.com', displayName: 'Max Iqbal', terminationDate: '2025-11-30' }),
    hrisPerson({ hrisId: 'hr-held', primaryEmail: 'jo.fenn@example.com', displayName: 'Jo Fenn' }),
    ANCHOR,
  ],
  ['hr-active', 'hr-starting', 'hr-held', ANCHOR.hrisId],
)

describe('running the same sync twice', () => {
  it('writes nothing the second time, or the fifth', async () => {
    const h = harness(SEED)
    await runSync(h.options(SNAPSHOT))
    const afterFirst = h.store.writes
    expect(afterFirst).toBeGreaterThan(0)

    for (let run = 0; run < 4; run += 1) await runSync(h.options(SNAPSHOT))

    expect(h.store.writes).toBe(afterFirst)
  })

  it('reports the settled rows as unchanged rather than as work done', async () => {
    const h = harness(SEED)
    await runSync(h.options(SNAPSHOT))
    const second = await runSync(h.options(SNAPSHOT))

    expect(second.counts.updated).toBe(0)
    expect(second.counts.status_changed).toBe(0)
    expect(second.counts.tombstoned).toBe(0)
    expect(second.counts.created).toBe(0)
  })

  it('never erases a hand-entered value the HR system does not hold', async () => {
    const h = harness(SEED)
    await runSync(h.options(SNAPSHOT))
    await h.store.patch('hr-active', { note: 'shared depot account, ask before offboarding' })

    const blanks = snapshot(
      [
        hrisPerson({ hrisId: 'hr-active', department: '', jobTitle: null, site: '   ', managerEmail: null }),
        ANCHOR,
      ],
      ['hr-active', ANCHOR.hrisId],
    )
    await runSync(h.options(blanks))

    const person = await h.store.get('hr-active')
    expect(person?.department).toBe('Operations')
    expect(person?.jobTitle).toBe('Analyst')
    expect(person?.site).toBe('Head office')
    expect(person?.managerEmail).toBe('john.doe@example.com')
    expect(person?.note).toBe('shared depot account, ask before offboarding')
  })

  it('does write a real change, so this is not a sync that ignores updates', async () => {
    const h = harness(SEED)
    await runSync(h.options(SNAPSHOT))
    const afterFirst = h.store.writes

    const moved = snapshot(
      SNAPSHOT.all.map((record) => (record.hrisId === 'hr-active' ? { ...record, department: 'Technology' } : record)),
      [...SNAPSHOT.activeIds],
    )
    const report = await runSync(h.options(moved))

    expect(h.store.writes).toBe(afterFirst + 1)
    expect(report.counts.updated).toBe(1)
  })
})
