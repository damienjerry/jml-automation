/**
 * Failure this prevents: destroying an escrowed disk-encryption recovery key
 * as a side effect of tidying up a device record.
 *
 * Deleting a device record deletes the recovery key the provider holds for that
 * machine. In the estate this was ported from that mattered twice: a leaver's
 * laptop was about to be handed over with its key still escrowed and nowhere
 * else, and encrypted machines were found unlocking without
 * authentication while the provider's own "encrypted, key present" field said
 * everything was fine.
 *
 * So a handover on a machine whose key the provider holds is refused until the
 * caller says, explicitly, that losing the key is understood. And a machine
 * whose key state the provider does NOT report is treated the same way,
 * because an unknown is not a no: that same field has meant something other
 * than it appears to more than once.
 *
 * The acknowledgement is recorded on the delete's audit row, so the decision
 * is attributable afterwards.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { deviceFixture, harness, PROVEN_MANIFEST, request } from '../fixtures/device/harness.ts'

const HANDOVER = { disposition: 'handover' as const, dryRun: false, canariedSystemId: 'sys-canary' }

describe('a machine whose recovery key the provider holds', () => {
  it('refuses the handover with no acknowledgement', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      devices: { device: deviceFixture({ fdeKeyPresent: true }) },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(report.final).toBe('refused')
    const refusal = report.preflight.refusals.find((r) => r.code === 'fde_acknowledgement_required')
    expect(refusal?.detail).toContain('deleting the record destroys it')
    expect(h.commands.fired).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
  })

  it('proceeds once the loss is acknowledged, and records who acknowledged it', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      devices: { device: deviceFixture({ fdeKeyPresent: true }) },
    })
    const report = await runDeviceDisposition(
      h.deps,
      request({ ...HANDOVER, acknowledgeFdeKeyLoss: true }),
    )

    expect(report.recordDeleted).toBe(true)
    const intent = h.audit.events.find((e) => e.action === 'device.deleteDevice' && e.phase === 'intent')
    expect(intent?.detail).toMatchObject({ acknowledgedFdeKeyLoss: true })
    expect(intent?.actor).toEqual({ kind: 'system', id: 'system:device-step' })
  })
})

describe('a machine whose key state is unknown', () => {
  it('is treated as if the key were held, because an unknown is not a no', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      devices: { device: deviceFixture({ fdeKeyPresent: null }) },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    const refusal = report.preflight.refusals.find((r) => r.code === 'fde_acknowledgement_required')
    expect(refusal?.detail).toContain('did not say whether it holds')
    expect(h.commands.fired).toEqual([])
  })
})

describe('a machine with no escrowed key', () => {
  it('needs no acknowledgement, because there is nothing to lose', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      devices: { device: deviceFixture({ fdeKeyPresent: false }) },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.preflight.refusals).toEqual([])
    expect(report.recordDeleted).toBe(true)
  })
})

describe('the dispositions that keep the record', () => {
  it('need no acknowledgement at all, because the key stays escrowed', async () => {
    // This is why returning a device to the spares account is the default: the
    // machine stays enrolled, managed, and with its recovery key intact.
    const h = harness({ armed: true, devices: { device: deviceFixture({ fdeKeyPresent: true }) } })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.preflight.refusals).toEqual([])
    expect(report.gateAfter.clears).toBe(true)
    expect(h.devices.recordExists()).toBe(true)
  })
})
