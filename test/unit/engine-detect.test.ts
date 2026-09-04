/**
 * The lifecycle detector.
 *
 * Two things are being checked here, and the second is the one that decays
 * quietly: that the right people are emitted, and that a standing list is
 * announced once rather than on every run.
 */

import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/core/clock.ts'
import { createChangeGate } from '../../src/core/gate.ts'
import { runDetect } from '../../src/engine/detect.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import type { Notification, NotificationResult, Notifier } from '../../src/notify/types.ts'
import { fakeStateStore } from './fake-state-store.ts'
import { storedPerson, TODAY } from '../helpers/sync-harness.ts'

const ZONE = 'Europe/London'

function notifier(delivered = true): Notifier & { sent: Notification[] } {
  const sent: Notification[] = []
  return {
    name: 'recording',
    sent,
    async send(n: Notification): Promise<NotificationResult> {
      sent.push(n)
      return delivered ? { delivered: true, channel: 'recording' } : { delivered: false, channel: 'recording', error: 'refused' }
    },
    async testConnection() {
      return { ok: true, detail: 'test double' }
    },
  }
}

function gateFor(state = fakeStateStore()) {
  return createChangeGate({
    subject: 'detect.lifecycle',
    state,
    // A Wednesday, so the weekly re-raise is not what any of these tests
    // measure.
    clock: new FakeClock(`${TODAY}T09:00:00.000Z`),
    timezone: ZONE,
    weeklyReraiseDay: 'monday',
  })
}

/** One row per case the detector has to tell apart. */
function seeded(): MemoryPeopleStore {
  return new MemoryPeopleStore({
    seed: [
      storedPerson({ hrisId: 'hr-joiner', displayName: 'Ada Stone', primaryEmail: 'ada.stone@example.com', status: 'hired', startDate: '2026-03-16' }),
      storedPerson({ hrisId: 'hr-started', displayName: 'Ida Novak', primaryEmail: 'ida.novak@example.com', status: 'active', startDate: '2026-03-09' }),
      storedPerson({ hrisId: 'hr-leaver', displayName: 'Kit Marlowe', primaryEmail: 'kit.marlowe@example.com', status: 'terminated', terminationDate: '2026-03-09' }),
      storedPerson({ hrisId: 'hr-stale', displayName: 'Lee Nakamura', primaryEmail: 'lee.nakamura@example.com', status: 'terminated', terminationDate: '2024-08-29', reviewReason: 'termination_older_than_lookback' }),
      storedPerson({ hrisId: 'hr-held', displayName: 'Robin Ellis', primaryEmail: 'robin.ellis@example.com', status: 'terminated', terminationDate: '2026-03-08', hold: true, holdReason: 'device still out' }),
      storedPerson({ hrisId: 'hr-scheduled', displayName: 'Sam Rivera', primaryEmail: 'sam.rivera@example.com', status: 'active', terminationDate: '2026-03-31' }),
      storedPerson({ hrisId: 'hr-quiet', displayName: 'Jo Fenn', primaryEmail: 'jo.fenn@example.com', status: 'active', startDate: '2019-01-07' }),
      storedPerson({ hrisId: 'hr-done', displayName: 'Max Iqbal', primaryEmail: 'max.iqbal@example.com', status: 'departed', terminationDate: '2025-11-30' }),
    ],
  })
}

async function detect(store: MemoryPeopleStore, extra: Partial<Parameters<typeof runDetect>[0]> = {}) {
  return runDetect({ people: store, today: TODAY, terminationLookbackDays: 60, ...extra })
}

describe('what the detector emits', () => {
  it('separates the leaver the engine will act on from the ones it will not', async () => {
    const report = await detect(seeded())
    const byId = new Map(report.events.map((e) => [e.hrisId, e]))

    expect(byId.get('hr-leaver')?.kind).toBe('leaver')
    expect(byId.get('hr-leaver')?.actionable).toBe(true)
    expect(byId.get('hr-stale')?.kind).toBe('potential_leaver')
    expect(byId.get('hr-held')?.kind).toBe('potential_leaver')
    expect(byId.get('hr-held')?.actionable).toBe(false)
    expect(byId.get('hr-stale')?.reason).toContain('parked')
    expect(byId.get('hr-held')?.reason).toContain('held')
  })

  it('emits joiners: those about to start and those who just did', async () => {
    const report = await detect(seeded())
    const joiners = report.events.filter((e) => e.kind === 'joiner').map((e) => e.hrisId)

    expect(joiners).toContain('hr-joiner')
    expect(joiners).toContain('hr-started')
    // Nobody who has been here for years, and nothing for a leaver.
    expect(joiners).not.toContain('hr-quiet')
    expect(joiners).not.toContain('hr-leaver')
  })

  it('drops a joiner once activation is recorded, not once a schedule has run', async () => {
    const store = seeded()
    await store.patch('hr-started', { activation: { activatedAt: '2026-03-09T10:00:00.000Z' } })
    const report = await detect(store)

    expect(report.events.filter((e) => e.kind === 'joiner').map((e) => e.hrisId)).not.toContain('hr-started')
  })

  it('gives advance notice of an employed person with a leaving date', async () => {
    const report = await detect(seeded())
    const scheduled = report.events.find((e) => e.hrisId === 'hr-scheduled')

    expect(scheduled?.kind).toBe('potential_leaver')
    expect(scheduled?.daysUntil).toBe(21)
    expect(scheduled?.actionable).toBe(false)
  })

  it('explains a stale leaving date, and a missing one, in the reason', async () => {
    // Both are potential leavers for the same underlying cause, and whoever
    // reads the summary has to be able to tell them apart without opening a
    // row.
    const store = new MemoryPeopleStore({
      seed: [
        storedPerson({ hrisId: 'hr-old', displayName: 'Ola Beck', primaryEmail: 'ola.beck@example.com', status: 'terminated', terminationDate: '2024-01-31' }),
        storedPerson({ hrisId: 'hr-undated', displayName: 'Nell Ward', primaryEmail: 'nell.ward@example.com', status: 'terminated', terminationDate: null }),
      ],
    })
    const report = await detect(store)
    const byId = new Map(report.events.map((e) => [e.hrisId, e]))

    expect(byId.get('hr-old')?.kind).toBe('potential_leaver')
    expect(byId.get('hr-old')?.reason).toContain('outside the 60-day lookback')
    expect(byId.get('hr-undated')?.reason).toContain('no leaving date')
  })

  it('reports a held row without a reason as held all the same', async () => {
    const store = new MemoryPeopleStore({
      seed: [storedPerson({ status: 'terminated', terminationDate: '2026-03-09', hold: true, holdReason: null })],
    })
    const report = await detect(store)

    expect(report.events[0]?.kind).toBe('potential_leaver')
    expect(report.events[0]?.reason).toContain('held by a person')
  })

  it('says nothing about a tombstone', async () => {
    const report = await detect(seeded())
    expect(report.events.map((e) => e.hrisId)).not.toContain('hr-done')
  })

  it('announces the dated leavers in its own summary, not only the doubtful ones', async () => {
    // The original detector reported only the cases needing a decision, so
    // "these accounts are being suspended today" never appeared anywhere.
    const report = await detect(seeded())

    expect(report.summary).toContain('Leaving today')
    expect(report.summary).toContain('Kit Marlowe')
    expect(report.summary).toContain('For review, no automatic action')
  })
})

describe('announcing once', () => {
  it('announces the first time it sees a set', async () => {
    const post = notifier()
    const report = await detect(seeded(), { gate: gateFor(), notifier: post })

    expect(report.gate?.reason).toBe('first_sight')
    expect(report.announced).toBe(true)
    expect(post.sent).toHaveLength(1)
  })

  it('says nothing on the next run when the set has not moved', async () => {
    const state = fakeStateStore()
    const post = notifier()
    await detect(seeded(), { gate: gateFor(state), notifier: post })
    const second = await detect(seeded(), { gate: gateFor(state), notifier: post })

    expect(second.gate?.reason).toBe('unchanged')
    expect(second.announced).toBe(false)
    expect(post.sent).toHaveLength(1)
  })

  it('announces again when one more person joins the set', async () => {
    const state = fakeStateStore()
    const post = notifier()
    await detect(seeded(), { gate: gateFor(state), notifier: post })

    const store = seeded()
    await store.upsert(
      storedPerson({ hrisId: 'hr-new-leaver', displayName: 'Rae Okafor', primaryEmail: 'rae.okafor@example.com', status: 'terminated', terminationDate: '2026-03-10' }),
    )
    const second = await detect(store, { gate: gateFor(state), notifier: post })

    expect(second.gate?.reason).toBe('changed')
    expect(post.sent).toHaveLength(2)
  })

  it('does not commit the gate when the notification was not delivered', async () => {
    // Recording at decision time would silence the next run as well, and a
    // silent gate looks exactly like a fixed problem.
    const state = fakeStateStore()
    const failing = notifier(false)
    const first = await detect(seeded(), { gate: gateFor(state), notifier: failing })
    expect(first.ok).toBe(false)

    const working = notifier()
    const second = await detect(seeded(), { gate: gateFor(state), notifier: working })
    expect(second.gate?.reason).toBe('first_sight')
    expect(working.sent).toHaveLength(1)
  })

  it('sends nothing at all when there is nothing to report', async () => {
    const post = notifier()
    const store = new MemoryPeopleStore({ seed: [storedPerson({ startDate: '2019-01-07' })] })
    const report = await detect(store, { gate: gateFor(), notifier: post })

    expect(report.events).toHaveLength(0)
    expect(post.sent).toHaveLength(0)
    expect(report.summary).toContain('Nothing to report')
  })

  it('announces when its own bookkeeping cannot be read', async () => {
    const post = notifier()
    const report = await detect(seeded(), { gate: gateFor(fakeStateStore({ failReads: true })), notifier: post })

    expect(report.gate?.reason).toBe('state_unavailable')
    expect(post.sent).toHaveLength(1)
  })
})
