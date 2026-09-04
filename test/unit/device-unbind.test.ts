import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { harness, LEAVER_USER_ID, POOL_USER_ID, request, SYSTEM_ID } from '../fixtures/device/harness.ts'

describe('removing one binding', () => {
  it('removes exactly the binding the plan named and leaves the others alone', async () => {
    // Removing every direct owner because the request did not say which one
    // would take a machine away from whoever else holds it.
    const h = harness({ armed: true, devices: { owners: [LEAVER_USER_ID, 'user-colleague'] } })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false, leaverUserId: LEAVER_USER_ID }))
    expect(h.devices.calls.filter((c) => c.startsWith('unbindUser'))).toEqual([
      'unbindUser:' + LEAVER_USER_ID + ':' + SYSTEM_ID,
    ])
    expect(h.devices.ownerIds()).toContain('user-colleague')
    expect(report.gateAfter.clears).toBe(true)
  })

  it('is idempotent: a machine with nothing bound reports already absent rather than failing', async () => {
    // An idempotent step that fails on a repeat makes an operator afraid to
    // re-run it, and the second run is exactly when they most need to.
    const h = harness({ armed: true, devices: { owners: [] } })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    const unbind = report.steps.find((s) => s.step === 'unbind')
    expect(unbind?.leg.state).toBe('already_absent')
    expect(report.ok).toBe(true)
    expect(h.devices.calls.filter((c) => c.startsWith('unbindUser'))).toEqual([])
  })

  it('still binds the spares account when there was nothing to unbind', async () => {
    const h = harness({ armed: true, devices: { owners: [] } })
    await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(h.devices.ownerIds()).toEqual([POOL_USER_ID])
  })

  it('refuses an account the machine is not actually bound to', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false, leaverUserId: 'user-not-bound' }))
    expect(report.final).toBe('refused')
    expect(report.preflight.refusals.map((r) => r.code)).toEqual(['owner_mismatch'])
  })

  it('leaves the machine enrolled and managed, whatever happens', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    // Nothing is uninstalled and no record is deleted, so the recovery key
    // stays escrowed and the machine can still be reached.
    expect(h.devices.calls.some((c) => c.startsWith('deleteDevice'))).toBe(false)
    expect(report.receipt).toBeNull()
    expect(h.devices.recordExists()).toBe(true)
  })
})
