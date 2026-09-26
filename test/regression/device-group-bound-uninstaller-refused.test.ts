/**
 * Failure this prevents: a handover for one leaver stripping the agents off
 * the whole fleet.
 *
 * A trigger fires on every association the command holds, and it ignores any
 * list of targets in the request body. In the estate this was ported from an
 * installer had been left attached to a whole device group, so a push aimed
 * at a handful of machines produced twice as many results as targets and
 * nobody noticed until the counts were compared. Another command carried
 * dozens of stale device associations. On an installer that is a puzzle; on an uninstaller it is an
 * outage.
 *
 * The connector refuses these itself, and there is a regression test for that.
 * This one asserts the DISPOSITION refuses too, before it fires anything, so a
 * dangerously bound command is reported to the operator as a refusal with a
 * reason rather than becoming an exception in the middle of a run.
 *
 * The same rule covers a command that already holds somebody else's machine
 * (collateral), and one that cannot be fired by trigger at all.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { deviceConfig, harness, PROVEN_MANIFEST, request } from '../fixtures/device/harness.ts'

const HANDOVER = {
  disposition: 'handover' as const,
  acknowledgeFdeKeyLoss: true,
  dryRun: false,
  canariedSystemId: 'sys-canary',
}

describe('a command bound to a device group', () => {
  it('is refused before anything is attached or fired', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: {
        refusal: {
          refusal: 'group_bound',
          detail: 'the command is bound to 1 device group(s); a trigger fires on every member',
        },
      },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))

    expect(report.final).toBe('refused')
    expect(report.preflight.refusals.map((r) => r.code)).toEqual(['group_bound'])
    expect(h.commands.fired).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
  })

  it('carries the reason through to the operator rather than a bare failure', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: { refusal: { refusal: 'group_bound', detail: 'a trigger fires on every member' } },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.gateAfter.detail).toContain('a trigger fires on every member')
    expect(h.notifier?.sent[0]?.body).toContain('a trigger fires on every member')
  })

  it('cannot be allowed by configuration', () => {
    // Not a setting. The schema pins it to a literal true, so an adopter
    // cannot switch off the check that keeps one uninstall from becoming a
    // fleet-wide one.
    expect(deviceConfig().devices.forbidGroupBoundCommands).toBe(true)
  })
})

describe("a command that already holds somebody else's machine", () => {
  it('is refused, because firing would uninstall their agents as collateral', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: {
        refusal: {
          refusal: 'collateral_associations',
          detail: 'the command already holds 3 device association(s) that this run did not create',
        },
      },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.preflight.refusals.map((r) => r.code)).toEqual(['collateral_associations'])
    expect(h.commands.fired).toEqual([])
  })
})

describe('a command that cannot be fired by trigger', () => {
  it('is refused rather than fired hopefully', async () => {
    // The trigger endpoint answers 200 for a command it cannot dispatch, so
    // firing one of these looks exactly like success and does nothing.
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: { refusal: { refusal: 'not_a_trigger', detail: 'launch type is manual' } },
    })
    const report = await runDeviceDisposition(h.deps, request(HANDOVER))
    expect(report.preflight.refusals.map((r) => r.code)).toEqual(['not_a_trigger'])
    expect(h.commands.fired).toEqual([])
  })
})
