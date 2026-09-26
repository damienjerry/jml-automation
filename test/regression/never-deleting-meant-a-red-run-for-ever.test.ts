/**
 * Keeping leavers' accounts, instead of deleting them, had no supported shape.
 *
 * The staged arming lets an adopter leave `delete` out of armedActions, and
 * plenty should: an organisation under a retention duty, or one that archives
 * mailboxes by hand, may never want this tool to delete an account. Leaving it
 * unarmed was the only way to say so, and the engine read it as unfinished
 * work. Every armed run past a leaver's deletion day re-read their devices,
 * recorded the deletion as not armed, and ended `ok=false` with exit 1, for
 * every such leaver, for ever. A run that is red every day teaches whoever
 * reads it to stop reading it, which is the worst thing a safety tool can do.
 *
 * `leaver.deletion: never` is now the policy. Day 7 is not scheduled, the
 * report counts the retained leavers, and arming `delete` alongside it is a
 * configuration error rather than a quiet contradiction.
 */
import { describe, expect, it } from 'vitest'
import { addDays } from '../../src/core/clock.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { LEAVER_ID, TODAY, defaultSeed, harness, leaverConfig, suspendedPersonFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
const SUSPENDED = addDays(TODAY, -8)
const EVERYTHING_BUT_DELETE = ['suspend', 'autoreply', 'licence', 'transfer', 'google_suspend']

function pastDeletionDay() {
  return suspendedPersonFixture(SUSPENDED, {
    terminationDate: addDays(TODAY, -9),
    offboarding: { suspendedAt: SUSPENDED, transferredAt: SUSPENDED, legs: {} },
  })
}

function seed() {
  const s = defaultSeed()
  return { ...s, devices: [], idp: (s.idp ?? []).map((a) => ({ ...a, suspended: true })), google: (s.google ?? []).map((a) => ({ ...a, suspended: true })) }
}

describe('a policy of never deleting accounts', () => {
  it('without the policy, an unarmed deletion turns every run red', async () => {
    const h = harness({ people: [pastDeletionDay()], seed: seed(), armed: EVERYTHING_BUT_DELETE })
    const report = await runLeaverEngine(h.deps, RUN)
    expect(report.ok).toBe(false)
  })

  it('with it, the leaver is kept, counted, and nothing is read or deleted', async () => {
    const h = harness({ people: [pastDeletionDay()], seed: seed(), armed: EVERYTHING_BUT_DELETE, config: { leaver: { deletion: 'never' } } })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.ok).toBe(true)
    expect(report.counts.retained).toBe(1)
    expect(report.counts.day7).toBe(0)
    expect(h.calls.filter((c) => /delete|device/i.test(c))).toEqual([])
    expect((await h.store.get(LEAVER_ID))?.status).toBe('offboarding')
  })

  it('refuses to load alongside an armed deletion', () => {
    expect(() => leaverConfig({ leaver: { deletion: 'never' } }, ['suspend', 'delete'])).toThrow(/deletion is never/)
  })
})
