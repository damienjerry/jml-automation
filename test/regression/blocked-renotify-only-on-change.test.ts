/**
 * Prevents: the same blocked leaver being announced on every scheduled run.
 *
 * An earlier design re-evaluated its blocked deletions three
 * times a day and posted the same list each time, because it had no notion of
 * a change. The channel stopped being read, so the day the list actually
 * changed looked exactly like the two hundred days before it. It also never
 * cleared the note when the blockage resolved.
 *
 * The gate here is keyed on the SET of machines plus the reason, committed
 * only after the note is delivered, and the blocked fields are cleared in the
 * same write that closes the row.
 */

import { describe, expect, it } from 'vitest'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { deleteCutoff } from '../../src/engine/leaver/select.ts'
import {
  DEVICE_ID,
  IDP_USER_ID,
  LEAVER_EMAIL,
  LEAVER_ID,
  MANAGER_EMAIL,
  NEXT_RERAISE_DAY,
  TODAY,
  CapturingNotifier,
  harness,
  leaverConfig,
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
const due = deleteCutoff(TODAY, leaverConfig())

/** The three runs a day the original schedule made. */
const RUNS_PER_DAY = ['run-a', 'run-b', 'run-c']

function blockedHarness(opts: { notifier?: CapturingNotifier } = {}) {
  return harness({
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
      idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true, devices: [DEVICE_ID] }],
      google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      devices: [
        { id: DEVICE_ID, displayName: 'Field laptop 1' },
        { id: 'sys-laptop-2', displayName: 'Field laptop 2' },
      ],
    },
    ...(opts.notifier ? { notifier: opts.notifier } : {}),
  })
}

function blockedNotes(h: ReturnType<typeof blockedHarness>): number {
  return h.notifier.sent.filter((n) => n.kind === 'leaver.blocked').length
}

describe('a leaver blocked by the same machine every run', () => {
  it('is announced once, not three times a day', async () => {
    const h = blockedHarness()
    for (const runId of RUNS_PER_DAY) await runLeaverEngine(h.deps, { ...RUN, runId })

    expect(blockedNotes(h)).toBe(1)
    // The gate itself is still evaluated every run: the check is live, only
    // the announcement is change-only.
    expect(h.calls.filter((c) => c.startsWith('devices.listBoundDevices'))).toHaveLength(3)
  })

  it('is re-raised once on the configured weekday, not on every run of it', async () => {
    // A weekday test is true for every run of that weekday. The earlier
    // attempt at this fix produced a day of half-hourly posts.
    const h = blockedHarness()
    await runLeaverEngine(h.deps, RUN)
    for (const runId of RUNS_PER_DAY) {
      h.clock.set(`${NEXT_RERAISE_DAY}T09:00:00.000Z`)
      await runLeaverEngine(h.deps, { ...RUN, runId })
    }
    expect(blockedNotes(h)).toBe(2)
  })

  it('is announced again the moment the machine set changes', async () => {
    const h = blockedHarness()
    await runLeaverEngine(h.deps, RUN)
    h.providers.bind(IDP_USER_ID, 'sys-laptop-2')
    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })

    expect(blockedNotes(h)).toBe(2)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.boundDevices?.map((d) => d.id).sort()).toEqual([DEVICE_ID, 'sys-laptop-2'])
  })

  it('announces again when a delivery failed, rather than going quiet', async () => {
    // The fingerprint is committed only after delivery. Recording it at
    // decision time would mean a failed post silenced the next run as well,
    // and the problem would then never be reported.
    const failing = new CapturingNotifier(false)
    const h = blockedHarness({ notifier: failing })

    await runLeaverEngine(h.deps, RUN)
    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })

    expect(blockedNotes(h)).toBe(2)
  })

  it('clears the blocked fields in the same write that closes the row', async () => {
    const h = blockedHarness()
    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.offboarding?.deleteBlockedReason).toBe('devices_bound')

    // Somebody hands the machine back, which is what the device disposition
    // step does.
    await h.providers.devices.unbindUser(IDP_USER_ID, DEVICE_ID)
    const cleared = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })

    expect(cleared.counts.day7).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('departed')
    expect(row?.offboarding?.deleteBlockedReason).toBeNull()
    expect(row?.offboarding?.boundDevices).toEqual([])
    expect(row?.offboarding?.blockedFingerprint).toBeNull()
  })

  it('does not record a fingerprint during a dry run', async () => {
    // Otherwise a rehearsal would silence the first real notification.
    const h = blockedHarness()
    await runLeaverEngine(h.deps, { ...RUN, dryRun: true })
    await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })

    expect(blockedNotes(h)).toBe(2)
  })
})
