/**
 * Prevents: a day-0 marker written from a suspension that never happened.
 *
 * The provider accepted the write, ignored the part that mattered and answered
 * 200. An earlier design wrote its progress marker anyway,
 * so the record said the account was suspended while the account was still
 * usable, and the row was never selected again because the marker was set.
 *
 * Two rules together stop it. A leg is only `done` when a read-back saw the
 * change, and the day-0 marker is only written when the suspension leg is
 * verified. The connector half of this is covered by day0-unverified-200; this
 * file is the engine half.
 */

import { describe, expect, it } from 'vitest'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { IDP_USER_ID, LEAVER_ID, harness, suspendedPersonFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }

describe('a suspension that was accepted and changed nothing', () => {
  it('writes no day-0 marker, does not move the row, and is not ok', async () => {
    const h = harness({ armed: true })
    h.providers.fault('idp.suspendUser', { kind: 'unverified' })

    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('terminated')
    expect(row?.offboarding?.suspendedAt).toBeNull()
    expect(row?.offboarding?.legs?.suspend_idp).toMatchObject({ state: 'failed', verified: false, attempts: 1 })
    expect(report.counts.day0 ?? 0).toBe(0)
    expect(report.ok).toBe(false)
  })

  it('is selected again on the next run, and finishes once the read-back agrees', async () => {
    const h = harness({ armed: true })
    h.providers.fault('idp.suspendUser', { kind: 'unverified', times: 1 })

    await runLeaverEngine(h.deps, RUN)
    const second = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })

    const row = await h.store.get(LEAVER_ID)
    expect(second.counts.day0).toBe(1)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.suspendedAt).toBeTruthy()
    // The attempt counter carries across runs, which is what eventually parks
    // a leg that keeps failing rather than retrying it for ever.
    expect(row?.offboarding?.legs?.suspend_idp?.attempts).toBe(2)
    expect(h.providers.idpAccount(IDP_USER_ID)?.suspended).toBe(true)
  })

  it('applies to a deletion too: an unverified delete leaves the row open', async () => {
    // Same rule at the other end. The row is only a tombstone when both
    // deletions were read back as gone; anything less is retried, because a
    // row marked departed is never looked at again.
    const due = '2026-02-24'
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(due, {
          offboarding: {
            suspendedAt: due,
            legs: {},
            transferredAt: '2026-03-01T08:00:00.000Z',
            transferRecipient: 'john.doe@example.com',
          },
        }),
      ],
      seed: {
        idp: [{ id: IDP_USER_ID, email: 'jane.doe@example.com', suspended: true }],
        google: [{ id: 'goog-leaver-1', email: 'jane.doe@example.com', suspended: true }],
      },
    })
    h.providers.fault('idp.deleteUser', { kind: 'unverified' })

    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.departedAt).toBeFalsy()
    expect(row?.offboarding?.legs?.delete_idp).toMatchObject({ state: 'failed', verified: false })
    expect(report.ok).toBe(false)
  })

  it('does not tell the manager that offboarding started', async () => {
    // A manager note naming a suspension that did not happen is worse than
    // silence: it is evidence somebody would act on.
    const h = harness({ armed: true })
    h.providers.fault('idp.suspendUser', { kind: 'unverified' })

    await runLeaverEngine(h.deps, RUN)
    expect(h.notifier.sent.filter((n) => n.kind === 'leaver.day0')).toHaveLength(0)
  })
})
