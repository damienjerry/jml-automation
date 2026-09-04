/**
 * Prevents: a destructive leg running after an earlier leg said stop.
 *
 * Two defects with one shape, both found by tracing a real day-7 run.
 *
 * The identity deletion carries a preflight: if the provider says the account
 * is NOT suspended, the account is either usable again because somebody
 * restored it, or it is the wrong account on this row. Neither is something to
 * delete, so the leg refuses and asks for the row to be parked for a human.
 *
 * The phase then carried on and deleted the Google account. The leg loop
 * stopped only for a hold, and a park was read after every leg in the phase
 * had already run, so the refusal was recorded and disregarded in the same
 * breath. A guard whose conclusion is "do not delete this person" has to stop
 * the deletion of that person, not only the half of it that noticed.
 *
 * The Google deletion also had no suspension preflight of its own. An adopter
 * can arm `delete` without arming `google_suspend`, which leaves a working
 * mailbox to be deleted on day 7 with nothing having ever closed it. The
 * reasoning written on the identity guard applies to Google word for word, so
 * it is enforced on both.
 *
 * Failure direction matters here more than usual: a mailbox is the one thing
 * in this sequence that cannot be restored from anywhere else once the
 * provider's own retention window passes.
 */

import { describe, expect, it } from 'vitest'
import { addDays } from '../../src/core/clock.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { LEAVER_EMAIL, LEAVER_ID, TODAY, defaultSeed, harness, suspendedPersonFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
/** Suspended eight days ago, so the seven-day deletion day has passed. */
const SUSPENDED = addDays(TODAY, -8)

/** A row that every deletion gate opens for: transferred, no machine bound. */
function dueForDeletion() {
  return suspendedPersonFixture(SUSPENDED, {
    terminationDate: addDays(TODAY, -9),
    offboarding: {
      suspendedAt: SUSPENDED,
      transferredAt: SUSPENDED,
      legs: { suspend_idp: { state: 'done', verified: true, attempts: 1, at: `${SUSPENDED}T09:00:00.000Z` } },
    },
  })
}

/**
 * The provider state a person is really in on day 7: both accounts suspended
 * by the earlier phases, and no machine bound, so the device gate is not what
 * is under test here.
 */
function seedAfterDay0(): ReturnType<typeof defaultSeed> {
  const seed = defaultSeed()
  return {
    ...seed,
    devices: [],
    idp: (seed.idp ?? []).map((a) => ({ ...a, suspended: true })),
    google: (seed.google ?? []).map((a) => ({ ...a, suspended: true })),
  }
}

describe('an identity account that is no longer suspended', () => {
  it('deletes neither account, and parks the row', async () => {
    const seed = seedAfterDay0()
    // Somebody restored the account after day 0. This is what the preflight
    // is looking for.
    seed.idp = [{ id: 'usr-leaver-1', email: LEAVER_EMAIL, displayName: 'Jane Doe', devices: [], suspended: false }]
    const h = harness({ people: [dueForDeletion()], seed, armed: true })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('idp.deleteUser'))).toEqual([])
    expect(h.calls.filter((c) => c.startsWith('google.deleteUser'))).toEqual([])

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.reviewReason).toBe('reinstated_after_day0')
    expect(report.counts.parked).toBe(1)
  })

  it('records the refusal on the row rather than only in the report', async () => {
    const seed = seedAfterDay0()
    seed.idp = [{ id: 'usr-leaver-1', email: LEAVER_EMAIL, displayName: 'Jane Doe', devices: [], suspended: false }]
    const h = harness({ people: [dueForDeletion()], seed, armed: true })

    await runLeaverEngine(h.deps, RUN)

    const legs = (await h.store.get(LEAVER_ID))?.offboarding?.legs ?? {}
    expect(legs.delete_idp).toMatchObject({ state: 'failed', verified: false })
    // The Google leg never ran, so it must not be recorded as anything done.
    expect(legs.delete_google?.state).not.toBe('done')
  })
})

describe('a Google account that was never suspended', () => {
  it('is not deleted, even when the identity account was suspended correctly', async () => {
    const seed = seedAfterDay0()
    // The identity half went through day 0. The mailbox never did: an adopter
    // can arm `delete` and leave `google_suspend` out of armedActions.
    seed.google = [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, licences: [], suspended: false }]
    const h = harness({ people: [dueForDeletion()], seed, armed: true })

    await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('google.deleteUser'))).toEqual([])
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).not.toBe('departed')
    expect(row?.reviewReason).toBe('reinstated_after_day0')
  })

  it('does not stop a PROTECTIVE leg that follows a park', async () => {
    // The narrow version of this rule matters as much as the rule. On day 6
    // the hand-over parks when nobody can be found to take the files, and the
    // Google suspension after it must still run: closing access is the safe
    // direction, and the files stay put until a person names a recipient.
    // Stopping the whole phase there would leave a parked leaver's mailbox
    // open for as long as the row waited for somebody to look at it.
    const transferDay = addDays(TODAY, -6)
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(transferDay, {
          managerEmail: null,
          terminationDate: addDays(TODAY, -7),
          offboarding: { suspendedAt: transferDay, transferredAt: null, legs: {} },
        }),
      ],
      seed: { idp: [{ id: 'usr-leaver-1', email: LEAVER_EMAIL, suspended: true }], google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL }] },
    })

    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.reviewReason).toBe('no_transfer_recipient')
    expect(row?.offboarding?.legs?.suspend_google).toMatchObject({ verified: true })
  })

  it('still deletes both when both accounts really are suspended', async () => {
    // The guard must not become a reason nothing ever completes.
    const h = harness({ people: [dueForDeletion()], seed: seedAfterDay0(), armed: true })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('idp.deleteUser')).length).toBe(1)
    expect(h.calls.filter((c) => c.startsWith('google.deleteUser')).length).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('departed')
    expect(report.counts.day7).toBe(1)
  })
})
