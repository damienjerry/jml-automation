/**
 * Failure this prevents: reading "the machine picked the command up" as "the
 * script finished".
 *
 * The provider writes a result row when a device COLLECTS a command, and fills
 * in the exit code and the response time only when it completes. A weekly
 * coverage job counted any row as an execution, so an installer that a machine
 * collected and never finished was reported as a success for a week, on a
 * device that had no agent at all.
 *
 * A receipt therefore only counts as completed when it carries BOTH an exit
 * code and a response time, and the connector reports that in one field. This
 * package must not reach the record delete on anything less, and must not read
 * a timeout as success either.
 *
 * The second half of the rule is the agent receipt itself: every agent named
 * in configuration has to come back as gone or absent. A receipt that mentions
 * none of them is an unanswered question, not a pass.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { parseAgentsReceipt } from '../../src/engine/device/handover.ts'
import { harness, PROVEN_MANIFEST, request, type FakeCommandsOptions } from '../fixtures/device/harness.ts'

const HANDOVER = {
  disposition: 'handover' as const,
  acknowledgeFdeKeyLoss: true,
  dryRun: false,
  canariedSystemId: 'sys-canary',
}

function handoverHarness(receipt: FakeCommandsOptions) {
  return harness({ armed: true, manifest: PROVEN_MANIFEST, commands: receipt })
}

describe('a result row that is only a collection', () => {
  it('deletes nothing when the exit code is missing', async () => {
    const h = handoverHarness({
      receipt: { received: true, completed: false, exitCode: null, output: null },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(report.recordDeleted).toBe(false)
    expect(report.leftEnrolled).toBe(true)
    expect(h.devices.calls.filter((c) => c.startsWith('deleteDevice'))).toEqual([])
    const uninstall = report.steps.find((s) => s.step === 'uninstall')
    expect(uninstall?.leg.error).toContain('collection, not execution')
  })

  it('deletes nothing when no result arrived at all', async () => {
    const h = handoverHarness({
      receipt: { received: false, completed: false, exitCode: null, output: null },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.recordDeleted).toBe(false)
    const uninstall = report.steps.find((s) => s.step === 'uninstall')
    expect(uninstall?.leg.error).toContain('never a success')
  })

  it('never reaches the receipt or quiet steps, so no later step can pass on nothing', async () => {
    const h = handoverHarness({
      receipt: { received: true, completed: false, exitCode: null, output: 'AGENTS_REMOVED telemetry=yes' },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.steps.map((s) => s.step)).toEqual(['preflight', 'uninstall'])
  })
})

describe('an incomplete agent receipt', () => {
  it('deletes nothing when an agent is still installed', async () => {
    const h = handoverHarness({
      receipt: {
        received: true,
        completed: true,
        exitCode: 0,
        output: 'AGENTS_REMOVED telemetry=no inventory=yes',
      },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(report.recordDeleted).toBe(false)
    expect(report.agents?.remaining).toEqual(['telemetry'])
    expect(h.devices.calls.filter((c) => c.startsWith('deleteDevice'))).toEqual([])
    const receipt = report.steps.find((s) => s.step === 'receipt')
    expect(receipt?.leg.error).toContain('still installed: telemetry')
  })

  it('deletes nothing when an agent is not mentioned', async () => {
    const h = handoverHarness({
      receipt: { received: true, completed: true, exitCode: 0, output: 'AGENTS_REMOVED telemetry=yes' },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.agents?.missing).toEqual(['inventory'])
    expect(report.recordDeleted).toBe(false)
  })

  it('deletes nothing on a zero exit code with no receipt line', async () => {
    // An exit code is not evidence. The script always exits zero on purpose,
    // because the state is in the receipt.
    const h = handoverHarness({
      receipt: { received: true, completed: true, exitCode: 0, output: 'all done!' },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.recordDeleted).toBe(false)
    expect(report.steps.find((s) => s.step === 'receipt')?.leg.error).toContain('printed no AGENTS_REMOVED line')
  })

  it('cannot be satisfied by an empty expectation', () => {
    expect(parseAgentsReceipt('AGENTS_REMOVED', []).complete).toBe(false)
  })
})
