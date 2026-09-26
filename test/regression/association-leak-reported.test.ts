/**
 * Failure this prevents: leaving an uninstall command attached to somebody's
 * machine, silently.
 *
 * A trigger fires on every association a command holds, so a device left
 * attached after a run gets swept up by the next firing of that command,
 * whoever asked for it and whatever it was for. In the estate this was ported
 * from that happened repeatedly: a foreground timeout between the attach and
 * the detach left machines bound, and a laptop was restarted repeatedly by a
 * scheduled job that had nothing to do with it.
 *
 * The connector detaches in a `finally`, re-reads the associations, and throws
 * when the machine may still be attached. It throws deliberately, even when
 * the work itself succeeded, because a standing attachment outlives the run.
 *
 * This test is about what the DISPOSITION does with that throw. The leak has to
 * reach a person as a warning naming the machine, the run must not be reported
 * as ok, and nothing may be deleted: a leak means the state of the attachment
 * is unknown, and a delete on top of an unknown is exactly the shape of
 * failure this package exists to prevent.
 */

import { describe, expect, it } from 'vitest'
import { AssociationLeak } from '../../src/connectors/jumpcloud/commands.ts'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { COMMAND_ID, harness, PROVEN_MANIFEST, request, SYSTEM_ID } from '../fixtures/device/harness.ts'

const HANDOVER = {
  disposition: 'handover' as const,
  acknowledgeFdeKeyLoss: true,
  dryRun: false,
  canariedSystemId: 'sys-canary',
}

function leakingHarness() {
  return harness({
    armed: true,
    manifest: PROVEN_MANIFEST,
    commands: {
      throws: new AssociationLeak(
        'the command is still attached after the run: the device is still listed as attached',
        COMMAND_ID,
        SYSTEM_ID,
      ),
    },
  })
}

describe('an association that could not be proven detached', () => {
  it('is reported as a warning that names the machine and says what to do', async () => {
    const h = leakingHarness()
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    const warning = report.warnings.find((w) => w.includes('still be attached'))
    expect(warning).toContain('Field laptop 1')
    expect(warning).toContain('before anything else fires that command')
  })

  it('makes the run not ok, so a schedule cannot pass over it', async () => {
    const h = leakingHarness()
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.ok).toBe(false)
    expect(report.final).toBe('left_enrolled')
  })

  it('deletes nothing, because the state of the run is now unknown', async () => {
    const h = leakingHarness()
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(h.devices.calls.filter((c) => c.startsWith('deleteDevice'))).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
    expect(report.recordDeleted).toBe(false)
    expect(report.leftEnrolled).toBe(true)
  })

  it('reaches the person reading the report, not just the log', async () => {
    const h = leakingHarness()
    await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(h.notifier?.sent[0]?.body).toContain('still be attached')
  })

  it('is recorded in the audit log against the machine', async () => {
    const h = leakingHarness()
    await runDeviceDisposition(h.deps, request(HANDOVER))
    const outcome = h.audit.events.find((e) => e.action === 'device.uninstallAgents' && e.phase === 'outcome')
    expect(outcome?.ok).toBe(false)
    expect(JSON.stringify(outcome?.detail)).toContain('could not be proven detached')
    expect(outcome?.subject).toMatchObject({ kind: 'device', id: SYSTEM_ID })
  })

  it('carries a warning the connector reported on a successful receipt too', async () => {
    // A leak found while the work itself succeeded is still a hazard, so a
    // receipt carrying warnings has them folded into the report rather than
    // dropped because the exit code was zero.
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: {
        receipt: {
          received: true,
          completed: true,
          exitCode: 0,
          output: 'AGENTS_REMOVED telemetry=yes inventory=absent',
          warnings: ['the detach answered 502 (retryable)'],
        },
      },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.warnings).toContain('the detach answered 502 (retryable)')
  })
})
