/**
 * Prevents: a standing problem being re-announced on every scheduled run.
 *
 * The automation this replaces re-evaluated its blocked leavers three times a
 * day and posted the same list each time, because it had no notion of a
 * change. Two hundred identical posts trained everybody to skip the channel,
 * so the day the list actually changed looked like all the others.
 *
 * Two earlier attempts at a fix are also pinned here, because both looked
 * correct and neither worked:
 *
 *  - keying the gate on the rendered message, which carried today's date and
 *    so changed every day;
 *  - keying the weekly reminder on the weekday alone, which is true for every
 *    run of that weekday, so the fix produced a day of half-hourly posts.
 */

import { describe, expect, it } from 'vitest'
import { createChangeGate, fingerprintOf } from '../../src/core/gate.ts'
import { FakeClock } from '../../src/core/clock.ts'
import { nullLogger } from '../../src/core/logger.ts'
import { fakeStateStore } from '../unit/fake-state-store.ts'

const ZONE = 'Europe/London'

/** The three runs a day the original schedule made. */
const RUNS_PER_DAY = ['T08:45:00Z', 'T14:45:00Z', 'T17:45:00Z']

function harness(startInstant: string) {
  const state = fakeStateStore()
  const clock = new FakeClock(startInstant)
  const gate = createChangeGate({
    subject: 'leaver.blocked',
    state,
    clock,
    timezone: ZONE,
    weeklyReraiseDay: 'monday',
    logger: nullLogger(),
  })
  const announced: string[] = []
  const run = async (items: string[]): Promise<void> => {
    const decision = await gate.evaluate(items)
    if (decision.announce) announced.push(decision.reason)
    // Committed only after a successful notification, which is what the
    // engine does.
    await gate.commit(decision)
  }
  return { clock, run, announced }
}

describe('a blocked leaver whose device set never changes', () => {
  it('is announced once, not on every run for a week', async () => {
    // Start on a Tuesday so the weekly re-raise is not in the way.
    const { clock, run, announced } = harness('2026-09-01T08:45:00Z')
    for (let day = 0; day < 6; day += 1) {
      for (const time of RUNS_PER_DAY) {
        clock.set('2026-09-0' + String(1 + day) + time)
        await run(['device-alpha', 'device-beta'])
      }
    }
    // 18 runs. One announcement on first sight, plus the single Monday
    // re-raise on 7 September... which is outside this window, so exactly one.
    expect(announced).toEqual(['first_sight'])
  })

  it('is announced again the moment the device set changes', async () => {
    const { clock, run, announced } = harness('2026-09-01T08:45:00Z')
    await run(['device-alpha', 'device-beta'])
    clock.set('2026-09-01T14:45:00Z')
    await run(['device-alpha'])
    expect(announced).toEqual(['first_sight', 'changed'])
  })

  it('is re-raised once on the configured weekday, not on every run of it', async () => {
    const { clock, run, announced } = harness('2026-09-04T08:45:00Z')
    await run(['device-alpha'])
    for (const time of RUNS_PER_DAY) {
      clock.set('2026-09-07' + time)
      await run(['device-alpha'])
    }
    expect(announced).toEqual(['first_sight', 'weekly_reraise'])
  })

  it('is not re-announced because the report was rendered on a different date', async () => {
    // The fingerprint is over the set, so today's date cannot enter it.
    expect(fingerprintOf(['device-alpha'])).toBe(fingerprintOf(['device-alpha']))
    const withDate = ['device-alpha', 'reported 2026-09-01']
    const nextDay = ['device-alpha', 'reported 2026-09-02']
    // Stated the other way round as well: had the date been part of the
    // reported set, the gate would have fired daily and been just as wrong.
    expect(fingerprintOf(withDate)).not.toBe(fingerprintOf(nextDay))
  })

  it('goes silent when the problem clears, and says nothing about the clearing', async () => {
    const { clock, run, announced } = harness('2026-09-01T08:45:00Z')
    await run(['device-alpha'])
    clock.set('2026-09-02T08:45:00Z')
    await run([])
    clock.set('2026-09-03T08:45:00Z')
    await run([])
    expect(announced).toEqual(['first_sight'])
  })
})
