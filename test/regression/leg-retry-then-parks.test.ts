/**
 * Prevents two opposite mistakes about a step that keeps failing.
 *
 * An earlier design did both. A failed step was terminal: it
 * was recorded once and never tried again, so a transient provider error meant
 * an account stayed open with the record saying otherwise. And a blocked
 * deletion was re-evaluated every five minutes for ever, with nobody told, so
 * a genuinely broken case sat there for months.
 *
 * Here a failure is retried on every later run, the attempt count lives on the
 * leg record so it accumulates across runs, and at the configured limit the
 * row parks for a person and is announced once. A failing step must also not
 * stop its siblings: closing three doors of four beats closing none.
 */

import { describe, expect, it } from 'vitest'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { IDP_USER_ID, LEAVER_EMAIL, LEAVER_ID, harness, personFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }

describe('a suspension that keeps failing', () => {
  it('accumulates attempts across runs rather than resetting each time', async () => {
    const h = harness({ armed: true })
    h.providers.fault('idp.suspendUser', { kind: 'error', message: 'the directory answered 503' })

    for (let run = 1; run <= 3; run += 1) {
      await runLeaverEngine(h.deps, { ...RUN, runId: `run-${run}` })
      const row = await h.store.get(LEAVER_ID)
      expect(row?.offboarding?.legs?.suspend_idp?.attempts, `after run ${run}`).toBe(run)
      expect(row?.status).toBe('terminated')
    }
  })

  it('parks the row at the configured limit and says so once', async () => {
    const h = harness({ armed: true, config: { leaver: { maxAttemptsPerLeg: 3 } } })
    h.providers.fault('idp.suspendUser', { kind: 'error' })

    for (let run = 1; run <= 3; run += 1) await runLeaverEngine(h.deps, { ...RUN, runId: `run-${run}` })

    const row = await h.store.get(LEAVER_ID)
    expect(row?.reviewReason).toBe('max_leg_attempts')
    expect(row?.note).toContain('suspend_idp')
    expect(h.notifier.sent.filter((n) => n.kind === 'leaver.parked')).toHaveLength(1)
  })

  it('stops being retried once parked, and the run reports it', async () => {
    const h = harness({ armed: true, config: { leaver: { maxAttemptsPerLeg: 2 } } })
    h.providers.fault('idp.suspendUser', { kind: 'error' })

    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-1' })
    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })
    const callsBefore = h.calls.length

    const after = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-3' })

    // A parked row takes no automatic action, so nothing more is attempted.
    expect(h.calls.length).toBe(callsBefore)
    expect(after.counts.selectedDay0).toBe(0)
    // Parked rows are counted in the run summary, because the failure mode of
    // a safety rule is silence.
    const summary = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-4' })
    expect(summary.counts.selectedDay0).toBe(0)
  })

  it('lets the other legs run while one of them is failing', async () => {
    const h = harness({ armed: true })
    h.providers.fault('idp.suspendUser', { kind: 'error' })

    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.legs?.suspend_idp?.state).toBe('failed')
    expect(row?.offboarding?.legs?.set_autoreply).toMatchObject({ state: 'done', verified: true })
    expect(row?.offboarding?.legs?.revoke_licence).toMatchObject({ state: 'done', verified: true })
    expect(h.providers.googleAccount(LEAVER_EMAIL)?.licences).toEqual([])
  })

  it('parks immediately on a failure that retrying cannot fix', async () => {
    // A refusal on principle is not a transient error. There is nothing to
    // wait for, so the row goes to a person now rather than in six runs.
    const h = harness({
      armed: true,
      people: [personFixture({ status: 'offboarding', offboarding: { suspendedAt: '2026-02-24', legs: {} }, managerEmail: null })],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL }],
      },
    })

    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.legs?.transfer_drive?.attempts).toBe(1)
    expect(row?.reviewReason).toBe('no_transfer_recipient')
  })

  it('recovers on its own when the provider comes back', async () => {
    const h = harness({ armed: true })
    h.providers.fault('idp.suspendUser', { kind: 'error', times: 2 })

    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-1' })
    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })
    const recovered = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-3' })

    expect(recovered.counts.day0).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.legs?.suspend_idp).toMatchObject({ state: 'done', attempts: 3 })
  })
})
