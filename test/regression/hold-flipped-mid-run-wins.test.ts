/**
 * Prevents: a hold set during a run being ignored by that run.
 *
 * Hold is the human kill switch. In the automation this was ported from it was
 * honoured in the query that selected people and then not looked at again, so
 * a run that had already selected somebody carried on through every step after
 * the flag went on. The person setting it watched the offboarding continue.
 *
 * So the row is re-read immediately before each person, before each leg and
 * again before the status write. A selection made minutes ago is not evidence
 * about now.
 */

import { describe, expect, it } from 'vitest'
import type { Outcome } from '../../src/core/types.ts'
import type { IdentityConnector } from '../../src/connectors/types.ts'
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

/**
 * Somebody sets the hold flag while the run is between two legs.
 *
 * Hooked onto the suspension because that is the first leg: everything after
 * it has to notice.
 */
function holdDuring(inner: IdentityConnector, onSuspend: () => Promise<void>): IdentityConnector {
  return {
    name: inner.name,
    findUser: (opts) => inner.findUser(opts),
    suspendUser: async (id: string): Promise<Outcome> => {
      const outcome = await inner.suspendUser(id)
      await onSuspend()
      return outcome
    },
    deleteUser: (id: string) => inner.deleteUser(id),
    testConnection: () => inner.testConnection(),
  }
}

describe('a hold set while the run is in flight', () => {
  it('stops the remaining day-0 legs', async () => {
    const h = harness({ armed: true })
    const deps = {
      ...h.deps,
      idp: holdDuring(h.deps.idp, async () => {
        await h.store.patch(LEAVER_ID, { hold: true, holdReason: 'stop, this looks wrong' })
      }),
    }

    await runLeaverEngine(deps, RUN)

    expect(h.calls).not.toContain('google.setVacationResponder(jane.doe@example.com)')
    expect(h.calls.some((c) => c.startsWith('google.revokeLicence'))).toBe(false)
  })

  it('does not write the day-0 marker, so nothing moves on', async () => {
    // Suspension is the safe direction and the leg that already ran stands.
    // The marker does not: writing it would move the row on while somebody has
    // asked for the automation to stop.
    const h = harness({ armed: true })
    const deps = {
      ...h.deps,
      idp: holdDuring(h.deps.idp, async () => {
        await h.store.patch(LEAVER_ID, { hold: true })
      }),
    }

    const report = await runLeaverEngine(deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('terminated')
    expect(row?.offboarding?.suspendedAt).toBeNull()
    expect(report.counts.day0 ?? 0).toBe(0)
    expect(report.counts.held).toBe(1)
  })

  it('is honoured in the selection on the next run, so nothing is retried', async () => {
    const h = harness({ armed: true, people: [personFixture({ hold: true, holdReason: 'held' })] })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.people).toEqual([])
    expect(report.counts.selectedDay0).toBe(0)
    expect(h.calls).toEqual([])
  })

  it('stops a deletion between the two delete legs', async () => {
    const due = deleteCutoff(TODAY, leaverConfig())
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(due, {
          offboarding: {
            suspendedAt: due,
            legs: {},
            transferredAt: `${TODAY}T08:00:00.000Z`,
            transferRecipient: MANAGER_EMAIL,
          },
        }),
      ],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    const deps = {
      ...h.deps,
      idp: {
        ...h.deps.idp,
        deleteUser: async (id: string): Promise<Outcome> => {
          const outcome = await h.deps.idp.deleteUser(id)
          await h.store.patch(LEAVER_ID, { hold: true })
          return outcome
        },
      },
    }

    const report = await runLeaverEngine(deps, RUN)

    // The Google account is untouched and the row is not a tombstone, so a
    // person can still decide what happens next.
    expect(h.providers.googleAccount(LEAVER_EMAIL)).toBeDefined()
    expect((await h.store.get(LEAVER_ID))?.status).toBe('offboarding')
    expect(report.counts.day7 ?? 0).toBe(0)
    expect(report.counts.held).toBe(1)
  })
})
