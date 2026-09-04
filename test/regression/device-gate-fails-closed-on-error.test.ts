/**
 * Prevents: an account deleted because the device list could not be read.
 *
 * The automation this was ported from wrapped its bound-device lookup in a
 * catch that logged and carried on. Any provider error therefore produced an
 * empty list, an empty list means "nothing to block on", and one failed read
 * deleted the account. That destroys the only management channel to the
 * machine and takes its escrowed disk-encryption key with it: the laptop
 * carries on running, unmanaged, with nothing left to reach it.
 *
 * Here every failure path blocks. The only thing that opens the gate is a
 * successful read of zero devices.
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
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
const due = deleteCutoff(TODAY, leaverConfig())

function readyToDelete() {
  return suspendedPersonFixture(due, {
    offboarding: {
      suspendedAt: due,
      legs: {},
      transferredAt: `${TODAY}T08:00:00.000Z`,
      transferRecipient: MANAGER_EMAIL,
    },
  })
}

function deletableHarness() {
  return harness({
    armed: true,
    people: [readyToDelete()],
    seed: {
      idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
      google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
    },
  })
}

describe('a bound-device read that failed', () => {
  it('blocks the deletion instead of reading as no devices', async () => {
    const h = deletableHarness()
    h.providers.fault('devices.listBoundDevices', { kind: 'gate_error' })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.blocked).toBe(1)
    expect(report.counts.day7 ?? 0).toBe(0)
    expect(report.ok).toBe(false)
    expect(h.calls.some((c) => c.startsWith('idp.deleteUser'))).toBe(false)
    expect(h.calls.some((c) => c.startsWith('google.deleteUser'))).toBe(false)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.deleteBlockedReason).toBe('gate_error')
    // Both accounts are still there, which is the whole point.
    expect(h.providers.idpAccount(IDP_USER_ID)).toBeDefined()
    expect(h.providers.googleAccount(LEAVER_EMAIL)).toBeDefined()
  })

  it('blocks on any shape of failure, not only the one the gate knows about', async () => {
    for (const kind of ['gate_error', 'throw'] as const) {
      const h = deletableHarness()
      h.providers.fault('devices.listBoundDevices', { kind })
      const report = await runLeaverEngine(h.deps, RUN)
      expect(report.counts.blocked, kind).toBe(1)
      expect(h.calls.some((c) => c.startsWith('idp.deleteUser')), kind).toBe(false)
    }
  })

  it('deletes once the read succeeds and comes back empty', async () => {
    const h = deletableHarness()
    h.providers.fault('devices.listBoundDevices', { kind: 'gate_error', times: 1 })

    const blocked = await runLeaverEngine(h.deps, RUN)
    expect(blocked.counts.blocked).toBe(1)

    const cleared = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })
    expect(cleared.counts.day7).toBe(1)
    expect((await h.store.get(LEAVER_ID))?.status).toBe('departed')
  })

  it('evaluates the gate for real in a dry run, since the gate writes nothing', async () => {
    const h = deletableHarness()
    h.providers.fault('devices.listBoundDevices', { kind: 'gate_error' })
    const report = await runLeaverEngine(h.deps, { ...RUN, dryRun: true })

    expect(report.counts.blocked).toBe(1)
    expect(report.people[0]?.blockedReason).toBe('gate_error')
    // Reported without writing anything, so a rehearsal tells an adopter what
    // today would really do.
    expect((await h.store.get(LEAVER_ID))?.offboarding?.deleteBlockedReason).toBeUndefined()
  })
})
