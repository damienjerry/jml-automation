import { describe, expect, it } from 'vitest'
import { createChangeGate, fingerprintOf, normaliseItems } from '../../src/core/gate.ts'
import { FakeClock } from '../../src/core/clock.ts'
import { nullLogger } from '../../src/core/logger.ts'
import { fakeStateStore } from './fake-state-store.ts'

const ZONE = 'Europe/London'
/** A Wednesday, so the weekly re-raise day is deliberately not today. */
const WEDNESDAY = '2026-09-02T09:00:00Z'
const MONDAY = '2026-09-07T09:00:00Z'

function gateOn(instant: string, weeklyReraiseDay: 'monday' | 'none' = 'monday') {
  const state = fakeStateStore()
  const clock = new FakeClock(instant)
  const gate = createChangeGate({ subject: 'leaver.blocked', state, clock, timezone: ZONE, weeklyReraiseDay, logger: nullLogger() })
  return { gate, state, clock }
}

describe('fingerprintOf', () => {
  it('is the same for the same set in a different order', () => {
    expect(fingerprintOf(['b', 'a'])).toBe(fingerprintOf(['a', 'b']))
  })

  it('ignores duplicates and blanks', () => {
    expect(fingerprintOf(['a', 'a', '  ', 'b'])).toBe(fingerprintOf(['b', 'a']))
    expect(normaliseItems([' a ', 'a', ''])).toEqual(['a'])
  })

  it('changes when a member changes', () => {
    expect(fingerprintOf(['a', 'b'])).not.toBe(fingerprintOf(['a', 'c']))
  })
})

describe('the change gate', () => {
  it('announces the first time there is something to say', async () => {
    const { gate } = gateOn(WEDNESDAY)
    const decision = await gate.evaluate(['HR-1', 'HR-2'])
    expect(decision).toMatchObject({ announce: true, reason: 'first_sight' })
  })

  it('says nothing when there is nothing to report, and does not call that suppression', async () => {
    const { gate } = gateOn(WEDNESDAY)
    expect(await gate.evaluate([])).toMatchObject({ announce: false, reason: 'nothing_to_report' })
  })

  it('stays silent while the same set persists', async () => {
    const { gate } = gateOn(WEDNESDAY)
    const first = await gate.evaluate(['HR-1'])
    await gate.commit(first)
    expect(await gate.evaluate(['HR-1'])).toMatchObject({ announce: false, reason: 'unchanged' })
  })

  it('announces when the set changes, in either direction', async () => {
    const { gate } = gateOn(WEDNESDAY)
    await gate.commit(await gate.evaluate(['HR-1']))
    const grown = await gate.evaluate(['HR-1', 'HR-2'])
    expect(grown.reason).toBe('changed')
    await gate.commit(grown)
    expect((await gate.evaluate(['HR-1'])).reason).toBe('changed')
  })

  it('goes quiet once the set empties, then speaks again when it refills', async () => {
    const { gate } = gateOn(WEDNESDAY)
    await gate.commit(await gate.evaluate(['HR-1']))
    const cleared = await gate.evaluate([])
    expect(cleared.announce).toBe(false)
    await gate.commit(cleared)
    expect((await gate.evaluate(['HR-1'])).reason).toBe('changed')
  })

  it('does not record anything until commit is called, so a failed post is retried', async () => {
    // Recording at decision time meant a notification that failed to send
    // silenced the next run as well.
    const { gate } = gateOn(WEDNESDAY)
    await gate.evaluate(['HR-1'])
    expect((await gate.evaluate(['HR-1'])).reason).toBe('first_sight')
  })

  it('re-raises a standing problem once on the configured weekday', async () => {
    const { gate, clock } = gateOn(WEDNESDAY)
    await gate.commit(await gate.evaluate(['HR-1']))
    clock.set(MONDAY)
    const reraise = await gate.evaluate(['HR-1'])
    expect(reraise).toMatchObject({ announce: true, reason: 'weekly_reraise' })
    await gate.commit(reraise)
    // A weekday test is true for every run of that weekday, so without the
    // "and we have not done it yet today" half this posted all day.
    clock.advanceMs(6 * 3_600_000)
    expect((await gate.evaluate(['HR-1'])).reason).toBe('unchanged')
  })

  it('re-raises again the following week', async () => {
    const { gate, clock } = gateOn(WEDNESDAY)
    await gate.commit(await gate.evaluate(['HR-1']))
    clock.set(MONDAY)
    await gate.commit(await gate.evaluate(['HR-1']))
    clock.advanceDays(7)
    expect((await gate.evaluate(['HR-1'])).reason).toBe('weekly_reraise')
  })

  it('never re-raises when the weekly reminder is switched off', async () => {
    const { gate, clock } = gateOn(WEDNESDAY, 'none')
    await gate.commit(await gate.evaluate(['HR-1']))
    clock.set(MONDAY)
    expect((await gate.evaluate(['HR-1'])).reason).toBe('unchanged')
  })

  it('announces when its own bookkeeping cannot be read', async () => {
    // The failure direction here is over-suppression, and over-suppression is
    // silent: a quiet channel looks exactly like a healthy estate.
    const state = fakeStateStore({ failReads: true })
    const gate = createChangeGate({
      subject: 'leaver.blocked',
      state,
      clock: new FakeClock(WEDNESDAY),
      timezone: ZONE,
      logger: nullLogger(),
    })
    const decision = await gate.evaluate(['HR-1'])
    expect(decision).toMatchObject({ announce: true, reason: 'state_unavailable' })
    // And it writes nothing, so the next readable run starts from first sight.
    await gate.commit(decision)
    expect(state.fingerprints.size).toBe(0)
  })

  it('announces again after a failed write rather than losing the notice', async () => {
    const state = fakeStateStore({ failWrites: true })
    const gate = createChangeGate({
      subject: 'leaver.blocked',
      state,
      clock: new FakeClock(WEDNESDAY),
      timezone: ZONE,
      logger: nullLogger(),
    })
    await gate.commit(await gate.evaluate(['HR-1']))
    expect((await gate.evaluate(['HR-1'])).reason).toBe('first_sight')
  })

  it("keeps one subject's history separate from another's", async () => {
    const state = fakeStateStore()
    const clock = new FakeClock(WEDNESDAY)
    const shared = { state, clock, timezone: ZONE, logger: nullLogger() } as const
    const blocked = createChangeGate({ subject: 'leaver.blocked', ...shared })
    const parked = createChangeGate({ subject: 'leaver.parked', ...shared })
    await blocked.commit(await blocked.evaluate(['HR-1']))
    expect((await parked.evaluate(['HR-1'])).reason).toBe('first_sight')
  })
})
