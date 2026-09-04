/**
 * Prevents: an unproven uninstall script firing on the strength of a claim
 * that cannot be true.
 *
 * Neither shipped uninstall script has ever been run on real machine: the
 * manifest says so, and a hand-over is refused unless the operator names the
 * machine they canaried it on. The check only tested that the field was
 * present, so naming the target itself satisfied it and the script ran.
 *
 * The claim is self-contradictory. It says the script already ran somewhere
 * and was checked afterwards, and this machine has not run it yet. The
 * realistic route in is not an operator arguing the point, it is an automation
 * template that maps both fields from the same expression, which passes a
 * presence test in silence. That is the same shape as every other defect in
 * this family: a guard that reads as present in the code and is satisfied by
 * something that means nothing.
 *
 * The toolkit still cannot verify that a canary happened. It can refuse the one
 * claim it knows to be false, which is what this does.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { loadScriptManifest, planDeviceDisposition } from '../../src/engine/device/preflight.ts'
import { SYSTEM_ID, harness, request } from '../fixtures/device/harness.ts'

const HANDOVER = { disposition: 'handover' as const, dryRun: false }
const OTHER_MACHINE = 'sys-a-machine-we-already-proved-it-on'

describe('the canary claim on an unproven script', () => {
  it('is refused when it names the machine the run would act on', async () => {
    const h = harness({ armed: true })

    const report = await runDeviceDisposition(h.deps, request({ ...HANDOVER, canariedSystemId: SYSTEM_ID }))

    expect(report.final).toBe('refused')
    expect(report.ok).toBe(false)
    expect(report.preflight.refusals.map((r) => r.code)).toContain('canary_is_the_target')
    // The point of the refusal: nothing was fired and nothing was unbound.
    expect(h.commands.fired).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
  })

  it('says why, and points at the runbook rather than at the field', async () => {
    const h = harness({ armed: true })
    const plan = await planDeviceDisposition(h.deps, request({ ...HANDOVER, canariedSystemId: SYSTEM_ID }))
    const refusal = plan.refusals.find((r) => r.code === 'canary_is_the_target')
    expect(refusal?.detail).toContain('nothing has been proven yet')
    expect(refusal?.detail).toContain('docs/runbooks/canary-a-device-script.md')
  })

  it('still accepts a different machine, so the hand-over remains possible', async () => {
    const h = harness({ armed: true })
    const plan = await planDeviceDisposition(h.deps, request({ ...HANDOVER, canariedSystemId: OTHER_MACHINE }))
    expect(plan.refusals.map((r) => r.code)).not.toContain('canary_is_the_target')
    expect(plan.refusals.map((r) => r.code)).not.toContain('unproven_script_needs_canary')
  })

  it('does not interfere with a dry run, which needs no claim at all', async () => {
    const h = harness({ armed: true })
    const plan = await planDeviceDisposition(h.deps, request({ disposition: 'handover', canariedSystemId: SYSTEM_ID }))
    expect(plan.refusals.map((r) => r.code)).not.toContain('canary_is_the_target')
    // A rehearsal is exactly where somebody should be free to see the plan.
    expect(plan.warnings.join(' ')).toContain('never been run on real hardware')
  })

  it('is only reachable while the shipped scripts are unproven, and they are', () => {
    // If a fork proves a script and flips the manifest, this whole branch stops
    // applying. That is the intended escape, and it is a statement about their
    // fleet rather than about this code.
    expect(loadScriptManifest().scripts.every((s) => s.provenOnHardware === false)).toBe(true)
  })
})
