/**
 * A leaver's Google account stayed a working identity for six days.
 *
 * Day 0 removes the licence, so Gmail and Drive go. The account itself is
 * only suspended on day 6, after the files are handed over, and until then it
 * is still an identity: "Sign in with Google" into other apps keeps working,
 * and so does every grant already given to a third-party app. Nothing ended
 * those. The day-0 sign-out now does, when `google_signout` is armed.
 *
 * It is the one day-0 step whose failure must not hold the others back: the
 * identity provider suspension is what closes the door, so a refused sign-out
 * is reported and the row still moves to offboarding.
 */
import { describe, expect, it } from 'vitest'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { LEAVER_EMAIL, LEAVER_ID, defaultSeed, harness } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
const DAY0 = ['suspend', 'autoreply', 'licence']

describe('the day-0 Google sign-out', () => {
  it('signs the account out when armed', async () => {
    const h = harness({ armed: [...DAY0, 'google_signout'] })
    await runLeaverEngine(h.deps, RUN)
    expect(h.calls).toContain(`google.signOutUser(${LEAVER_EMAIL})`)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.legs?.['signout_google']).toMatchObject({ state: 'done', verified: true })
  })

  it('leaves sessions alone and says so when not armed', async () => {
    const h = harness({ armed: DAY0 })
    await runLeaverEngine(h.deps, RUN)
    expect(h.calls.filter((c) => c.startsWith('google.signOutUser'))).toEqual([])
    expect((await h.store.get(LEAVER_ID))?.offboarding?.legs?.['signout_google']?.state).toBe('not_armed')
  })

  it('does nothing for a person with no Google account', async () => {
    const seed = { ...defaultSeed(), google: [] }
    const h = harness({ seed, armed: [...DAY0, 'google_signout'] })
    await runLeaverEngine(h.deps, RUN)
    expect(h.calls.filter((c) => c.startsWith('google.signOutUser'))).toEqual([])
    expect((await h.store.get(LEAVER_ID))?.offboarding?.legs?.['signout_google']?.state).toBe('not_applicable')
  })

  it('a refused sign-out is a failed step, and the row still moves on', async () => {
    const h = harness({ armed: [...DAY0, 'google_signout'] })
    h.providers.fault('google.signOutUser', { kind: 'error', message: 'refused with status 403' })
    const report = await runLeaverEngine(h.deps, RUN)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.legs?.['signout_google']?.state).toBe('failed')
    expect(report.counts.failedLegs).toBe(1)
  })
})
