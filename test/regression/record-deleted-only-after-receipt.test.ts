/**
 * Failure this prevents: deleting a device record on hope, and stranding the
 * machine.
 *
 * The handover in the automation this was ported from fired the uninstall
 * command, slept a blind two minutes, and deleted the device record. Its own
 * docstring promised a last-contact check that was never implemented. When the
 * uninstall had not in fact run, the record went anyway, and with it went the
 * only channel that could reach the machine and the escrowed disk-encryption
 * key. One laptop went on reporting telemetry for weeks afterwards.
 *
 * The order is therefore fixed, and this test asserts the order itself rather
 * than the end state: uninstall, receipt, silence, and only then the delete.
 * Every one of the first three failing has to stop the fourth.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { harness, PROVEN_MANIFEST, request, SYSTEM_ID } from '../fixtures/device/harness.ts'

const HANDOVER = {
  disposition: 'handover' as const,
  acknowledgeFdeKeyLoss: true,
  dryRun: false,
  canariedSystemId: 'sys-canary',
}

describe('the order of a handover', () => {
  it('deletes the record last, after the receipt and after silence', async () => {
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(report.steps.map((s) => s.step)).toEqual([
      'preflight',
      'uninstall',
      'receipt',
      'agent_quiet',
      'delete_record',
    ])
    // The audit log tells the same story, in the same order, with an intent
      // row before each call.
    expect(h.audit.trail()).toEqual([
      'outcome device.preflight',
      'intent device.uninstallAgents',
      'outcome device.uninstallAgents',
      'intent device.readReceipt',
      'outcome device.readReceipt',
      'intent device.deleteDevice',
      'outcome device.deleteDevice',
    ])
    expect(report.recordDeleted).toBe(true)
  })

  it('waits for the machine to go quiet rather than sleeping a fixed spell', async () => {
    // Silence is the one piece of evidence that does not come from the script
    // claiming to have done the work.
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST })
    await runDeviceDisposition(h.deps, request(HANDOVER))
    const waited = h.slept.reduce((a, b) => a + b, 0)
    expect(waited).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('does not delete the record when the machine speaks again after the uninstall', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      devices: {
        // Three values because the pre-flight reads the device once before the
        // quiet check takes its baseline: the machine reports the same time
        // twice and then speaks again.
        contactSequence: ['2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z', '2026-03-02T09:05:00.000Z'],
      },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(h.devices.calls.filter((c) => c.startsWith('deleteDevice'))).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
    expect(report.leftEnrolled).toBe(true)
    expect(report.final).toBe('left_enrolled')
    expect(report.steps.find((s) => s.step === 'agent_quiet')?.leg.error).toContain('an agent is still running')
  })

  it('leaves the block in place when the record was not deleted', async () => {
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST, devices: { deleteFails: true } })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.gateAfter).toMatchObject({ clears: false, reason: 'still_bound' })
  })

  it('reports the delete as verified only from a read-back', async () => {
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    const del = report.steps.find((s) => s.step === 'delete_record')
    expect(del?.leg).toMatchObject({ state: 'done', verified: true })
    expect(h.devices.calls).toContain('deleteDevice:' + SYSTEM_ID)
  })
})
