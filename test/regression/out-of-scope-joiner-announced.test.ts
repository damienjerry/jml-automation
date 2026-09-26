/**
 * Every HR record was announced as a joiner, including people who never get a
 * work account.
 *
 * The HR system holds frontline staff, seasonal workers and contractors on their own kit
 * alongside the people IT provisions for. Treating each of them as a joiner
 * announced accounts that would never be created and, once activation exists,
 * would try to activate them. The HR system already knows who is in scope; the
 * toolkit has to read it, and to lean towards "in scope" when it cannot.
 */
import { describe, expect, it } from 'vitest'
import { runDetect } from '../../src/engine/detect.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { storedPerson, TODAY } from '../helpers/sync-harness.ts'

function store(): MemoryPeopleStore {
  return new MemoryPeopleStore({
    seed: [
      storedPerson({ hrisId: 'hr-office', displayName: 'Ada Stone', primaryEmail: 'ada.stone@example.com', status: 'hired', startDate: '2026-03-16', inScope: true }),
      storedPerson({ hrisId: 'hr-driver', displayName: 'Ida Novak', primaryEmail: 'ida.novak@example.com', status: 'hired', startDate: '2026-03-16', inScope: false }),
      storedPerson({ hrisId: 'hr-unknown', displayName: 'Lee Park', primaryEmail: 'lee.park@example.com', status: 'hired', startDate: '2026-03-16', inScope: null }),
      storedPerson({ hrisId: 'hr-driver-leaver', displayName: 'Sam Rivera', primaryEmail: 'sam.rivera@example.com', status: 'terminated', terminationDate: '2026-03-09', inScope: false }),
    ],
  })
}

describe('joiners the HR system says IT does not provision for', () => {
  it('are counted but never announced', async () => {
    const report = await runDetect({ people: store(), today: TODAY, terminationLookbackDays: 60 })
    const joiners = report.events.filter((e) => e.kind === 'joiner').map((e) => e.hrisId)

    expect(joiners).toContain('hr-office')
    expect(joiners).not.toContain('hr-driver')
    expect(report.counts.joinerOutOfScope).toBe(1)
    expect(report.summary).toContain('not needing IT accounts: 1')
  })

  it('still announces somebody whose scope the HR system did not say', async () => {
    const report = await runDetect({ people: store(), today: TODAY, terminationLookbackDays: 60 })
    expect(report.events.filter((e) => e.kind === 'joiner').map((e) => e.hrisId)).toContain('hr-unknown')
  })

  // Scope decides whether accounts are CREATED. It says nothing about accounts
  // that already exist from before the flag was set, so a leaver stays in the
  // leaver set and the engine's own lookups decide what there is to close.
  it('do not stop the same person being reported as a leaver', async () => {
    const report = await runDetect({ people: store(), today: TODAY, terminationLookbackDays: 60 })
    expect(report.events.find((e) => e.hrisId === 'hr-driver-leaver')?.kind).toBe('leaver')
  })
})
