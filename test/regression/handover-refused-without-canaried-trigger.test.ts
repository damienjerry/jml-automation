/**
 * Failure this prevents: running an uninstall script nobody has ever watched
 * work, on somebody's laptop.
 *
 * The scripts this package ships were ported from automation where the
 * equivalent scripts were written, deployed as device commands, and never
 * executed on anything. Their service names, uninstall strings and launchd
 * labels were inferred rather than read off a machine, and two audits recorded
 * that fact without it ever changing.
 *
 * Two independent brakes therefore stand in front of a handover, and both are
 * asserted here:
 *
 *  - `devices.uninstallTriggers` defaults to null for every platform, so a
 *    fresh install cannot run a handover at all. Nobody inherits a fleet-wide
 *    uninstaller they did not create.
 *  - a script whose manifest says provenOnHardware: false cannot be EXECUTED
 *    without naming the machine it was canaried on. Planning is always allowed;
 *    firing is not.
 *
 * Both refusals name the runbook, because a refusal that does not say what to
 * do next gets worked around rather than followed.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { loadScriptManifest } from '../../src/engine/device/preflight.ts'
import { harness, PROVEN_MANIFEST, request } from '../fixtures/device/harness.ts'

const RUNBOOK = 'docs/runbooks/canary-a-device-script.md'
const HANDOVER = { disposition: 'handover' as const, acknowledgeFdeKeyLoss: true }

describe('no configured trigger', () => {
  it('refuses a handover on a platform with no uninstall command, and names the runbook', async () => {
    const h = harness({
      armed: true,
      config: { devices: { uninstallTriggers: { windows: null, darwin: null, linux: null } } },
      manifest: PROVEN_MANIFEST,
    })
    const report = await runDeviceDisposition(h.deps, request({ ...HANDOVER, dryRun: false }))

    expect(report.final).toBe('refused')
    const refusal = report.preflight.refusals.find((r) => r.code === 'no_uninstall_trigger')
    expect(refusal?.detail).toContain(RUNBOOK)
    expect(h.commands.fired).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
  })
})

describe('an unproven script', () => {
  it('ships marked unproven, in the manifest, for every platform', () => {
    // Stated in three places: here, in each script header, and in the runbook.
    const manifest = loadScriptManifest()
    expect(manifest.provenOnHardware).toBe(false)
    expect(manifest.scripts.every((s) => s.provenOnHardware === false)).toBe(true)
  })

  it('can be planned freely', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.final).toBe('planned')
    expect(report.warnings.join(' ')).toContain('never been run on real hardware')
    expect(h.commands.fired).toEqual([])
  })

  it('cannot be executed without naming the machine it was canaried on', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ ...HANDOVER, dryRun: false }))

    expect(report.final).toBe('refused')
    const refusal = report.preflight.refusals.find((r) => r.code === 'unproven_script_needs_canary')
    expect(refusal?.detail).toContain(RUNBOOK)
    expect(h.commands.fired).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
  })

  it('runs once the operator says which machine they proved it on', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(
      h.deps,
      request({ ...HANDOVER, dryRun: false, canariedSystemId: 'sys-canary' }),
    )
    expect(report.preflight.refusals).toEqual([])
    expect(h.commands.fired).toHaveLength(1)
  })

  it('records the canary claim in the audit log, so the override is not invisible', async () => {
    const h = harness({ armed: true })
    await runDeviceDisposition(
      h.deps,
      request({ ...HANDOVER, dryRun: false, canariedSystemId: 'sys-canary' }),
    )
    const rows = h.audit.events.filter((e) => e.action === 'device.preflight')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows[0]?.detail)).toContain('never been run on real hardware')
  })
})
