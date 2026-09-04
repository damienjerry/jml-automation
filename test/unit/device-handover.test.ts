import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { confirmAgentQuiet, parseAgentsReceipt } from '../../src/engine/device/handover.ts'
import { planDeviceDisposition } from '../../src/engine/device/preflight.ts'
import { deviceFixture, harness, PROVEN_MANIFEST, request, SYSTEM_ID } from '../fixtures/device/harness.ts'

const HANDOVER = {
  disposition: 'handover' as const,
  dryRun: false,
  acknowledgeFdeKeyLoss: true,
  canariedSystemId: 'sys-canary',
}

function handoverHarness(opts: Parameters<typeof harness>[0] = {}) {
  return harness({ armed: true, manifest: PROVEN_MANIFEST, ...opts })
}

describe('parseAgentsReceipt', () => {
  it('reads every configured agent out of the last receipt line', () => {
    const receipt = parseAgentsReceipt(
      'starting\nAGENTS_REMOVED telemetry=no\nAGENTS_REMOVED telemetry=yes inventory=absent',
      ['telemetry', 'inventory'],
    )
    expect(receipt.agents).toEqual({ telemetry: 'yes', inventory: 'absent' })
    expect(receipt.complete).toBe(true)
  })

  it('is not complete when an agent is still installed', () => {
    const receipt = parseAgentsReceipt('AGENTS_REMOVED telemetry=no inventory=yes', ['telemetry', 'inventory'])
    expect(receipt.remaining).toEqual(['telemetry'])
    expect(receipt.complete).toBe(false)
  })

  it('is not complete when an agent is not mentioned at all', () => {
    const receipt = parseAgentsReceipt('AGENTS_REMOVED telemetry=yes', ['telemetry', 'inventory'])
    expect(receipt.missing).toEqual(['inventory'])
    expect(receipt.complete).toBe(false)
  })

  it('is not complete when there is no receipt line', () => {
    const receipt = parseAgentsReceipt('the script printed something else entirely', ['telemetry'])
    expect(receipt.line).toBeNull()
    expect(receipt.complete).toBe(false)
  })

  it('treats an unreadable token as an unknown, never as a pass', () => {
    const receipt = parseAgentsReceipt('AGENTS_REMOVED telemetry=probably inventory=absent', [
      'telemetry',
      'inventory',
    ])
    expect(receipt.invalid).toEqual(['telemetry=probably'])
    expect(receipt.complete).toBe(false)
  })

  it('is never complete when nothing was expected, so an empty receipt cannot pass', () => {
    expect(parseAgentsReceipt('AGENTS_REMOVED ', []).complete).toBe(false)
    expect(parseAgentsReceipt(null, []).complete).toBe(false)
  })

  it('accepts a state in any case, because scripts differ', () => {
    expect(parseAgentsReceipt('AGENTS_REMOVED telemetry=YES', ['telemetry']).complete).toBe(true)
  })
})

describe('confirmAgentQuiet', () => {
  it('is quiet when last contact does not move for the whole window', async () => {
    const h = handoverHarness()
    const quiet = await confirmAgentQuiet(h.deps, SYSTEM_ID, { quietMinutes: 10, pollMs: 60_000 })
    expect(quiet.quiet).toBe(true)
    expect(quiet.observedFor).toBeGreaterThanOrEqual(600_000)
  })

  it('is not quiet when the machine contacts the provider again', async () => {
    // Whatever the receipt said, something is still running.
    const h = handoverHarness({
      devices: { contactSequence: ['2026-03-02T09:00:00.000Z', '2026-03-02T09:02:00.000Z'] },
    })
    const quiet = await confirmAgentQuiet(h.deps, SYSTEM_ID, { quietMinutes: 10, pollMs: 60_000 })
    expect(quiet.quiet).toBe(false)
    expect(quiet.detail).toContain('contacted the provider again')
  })

  it('is not quiet when the device cannot be read', async () => {
    const h = handoverHarness()
    h.deps.devices.getDevice = async () => {
      throw new Error('the provider answered 503')
    }
    expect((await confirmAgentQuiet(h.deps, SYSTEM_ID, { quietMinutes: 1, pollMs: 1000 })).quiet).toBe(false)
  })

  it('is not quiet when the record disappears mid-check', async () => {
    const h = handoverHarness()
    let reads = 0
    h.deps.devices.getDevice = async () => {
      reads += 1
      return reads === 1 ? deviceFixture() : null
    }
    const quiet = await confirmAgentQuiet(h.deps, SYSTEM_ID, { quietMinutes: 1, pollMs: 1000 })
    expect(quiet.quiet).toBe(false)
    expect(quiet.detail).toContain('disappeared')
  })
})

describe('the handover sequence', () => {
  it('fires the command, reads the receipt, waits for silence, then deletes the record', async () => {
    const h = handoverHarness()
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.steps.map((s) => s.step)).toEqual([
      'preflight',
      'uninstall',
      'receipt',
      'agent_quiet',
      'delete_record',
    ])
    expect(report.recordDeleted).toBe(true)
    expect(report.leftEnrolled).toBe(false)
    expect(report.gateAfter).toMatchObject({ clears: true, reason: 'record_deleted' })
    expect(h.devices.recordExists()).toBe(false)
  })

  it('holds the association for the configured time rather than detaching at once', async () => {
    const h = handoverHarness()
    await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(h.commands.fired).toEqual(['cmd-uninstall-1:' + SYSTEM_ID + ':hold=120000'])
  })

  it('leaves the machine enrolled when the record delete cannot be confirmed', async () => {
    const h = handoverHarness({ devices: { deleteFails: true } })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.recordDeleted).toBe(false)
    expect(report.leftEnrolled).toBe(true)
    expect(report.final).toBe('left_enrolled')
  })

  it('leaves the machine enrolled when the command was refused at firing time', async () => {
    const h = handoverHarness({ commands: { throws: new Error('the trigger answered 200 and dispatched nothing') } })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(h.devices.calls.filter((c) => c.startsWith('deleteDevice'))).toEqual([])
    expect(report.ok).toBe(false)
  })

  it('reports the disk-encryption acknowledgement on the delete row', async () => {
    const h = handoverHarness({ devices: { device: deviceFixture({ fdeKeyPresent: true }) } })
    await runDeviceDisposition(h.deps, request(HANDOVER))
    const row = h.audit.events.find((e) => e.action === 'device.deleteDevice' && e.phase === 'intent')
    expect(row?.detail).toMatchObject({ acknowledgedFdeKeyLoss: true })
  })

  it('warns in the plan that the shipped script is unproven, even in a dry run', async () => {
    const h = harness({ armed: true })
    const plan = await planDeviceDisposition(
      h.deps,
      request({ disposition: 'handover', acknowledgeFdeKeyLoss: true }),
    )
    expect(plan.scriptProvenOnHardware).toBe(false)
    expect(plan.warnings.join(' ')).toContain('never been run on real hardware')
  })
})
