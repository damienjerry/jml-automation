/**
 * Prevents: a leaver's row suspending a colleague who still works here.
 *
 * The HR system renamed a leaver's address on the way out. The sync saw an
 * unfamiliar address, decided it was a new person, created a row, and that row
 * inherited the provider account ids belonging to somebody who was still
 * employed. When the leaving date passed, the engine suspended the live
 * account. Somebody reached for the hold flag on the live row to contain it,
 * which did nothing, because the check that mattered did not exist.
 *
 * So: before any provider call, the engine refuses to act on an account id or
 * an address that a hired-or-active row claims, and that check ignores the
 * hold flag on those rows entirely.
 */

import { describe, expect, it } from 'vitest'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { deleteCutoff } from '../../src/engine/leaver/select.ts'
import {
  IDP_USER_ID,
  LEAVER_EMAIL,
  LEAVER_ID,
  MANAGER_EMAIL,
  TODAY,
  harness,
  leaverConfig,
  personFixture,
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }

/** The live colleague whose account id ended up on the leaver's row. */
function colleague(overrides = {}) {
  return personFixture({
    hrisId: 'hris-live',
    status: 'active',
    primaryEmail: 'john.doe@example.com',
    displayName: 'John Doe',
    terminationDate: null,
    externalIds: { jumpcloudUserId: IDP_USER_ID },
    ...overrides,
  })
}

describe('a leaver row carrying an employed person account id', () => {
  it('parks instead of suspending, and touches no provider', async () => {
    const h = harness({
      armed: true,
      people: [personFixture(), colleague()],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [] },
    })

    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('terminated')
    expect(row?.reviewReason).toBe('identity_claimed_by_live_person')
    expect(row?.offboarding?.suspendedAt).toBeNull()
    expect(h.calls).toEqual([])
    expect(report.counts.parked).toBe(1)
    expect(report.counts.day0 ?? 0).toBe(0)
  })

  it('names the colleague, so the person reading the alert can see the collision', async () => {
    const h = harness({
      armed: true,
      people: [personFixture(), colleague()],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [] },
    })
    await runLeaverEngine(h.deps, RUN)

    expect(h.notifier.kinds()).toContain('leaver.parked')
    expect(h.notifier.bodies()).toContain('John Doe')
    expect(h.notifier.bodies()).toContain('identity_claimed_by_live_person')
  })

  it('still protects a colleague whose own row is on hold', async () => {
    // This is the case that failed. Hold freezes automation FOR that person;
    // it must not stop them being protected FROM another row's offboarding.
    const h = harness({
      armed: true,
      people: [personFixture(), colleague({ hold: true, holdReason: 'do not touch, see the incident' })],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [] },
    })

    await runLeaverEngine(h.deps, RUN)

    expect((await h.store.get(LEAVER_ID))?.reviewReason).toBe('identity_claimed_by_live_person')
    expect(h.calls).toEqual([])
  })

  it('parks on a shared address as well as a shared account id', async () => {
    const h = harness({
      armed: true,
      people: [
        personFixture(),
        personFixture({ hrisId: 'hris-live', status: 'active', externalIds: {}, terminationDate: null }),
      ],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [] },
    })
    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.reviewReason).toBe('identity_claimed_by_live_person')
  })

  it('refuses to delete on the same grounds, not only to suspend', async () => {
    const due = deleteCutoff(TODAY, leaverConfig())
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(due, {
          offboarding: { suspendedAt: due, legs: {}, transferredAt: `${TODAY}T08:00:00.000Z`, transferRecipient: MANAGER_EMAIL },
        }),
        colleague(),
      ],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day7 ?? 0).toBe(0)
    expect(h.calls).toEqual([])
    expect(h.providers.idpAccount(IDP_USER_ID)).toBeDefined()
    expect((await h.store.get(LEAVER_ID))?.status).toBe('offboarding')
  })

  it('does not park when the claimant has themselves left', async () => {
    // A departed row claims nothing: it is a tombstone, not a person with
    // access.
    const h = harness({
      armed: true,
      people: [personFixture(), colleague({ status: 'departed' })],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [] },
    })
    const report = await runLeaverEngine(h.deps, RUN)
    expect(report.counts.day0).toBe(1)
  })
})
