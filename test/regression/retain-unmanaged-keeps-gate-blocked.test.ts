/**
 * Failure this prevents: closing a case by deleting the record of a machine
 * that still has our agents on it.
 *
 * A leaver kept their laptop. The device record was deleted to tidy up the
 * fleet view, which removed the machine from our sight and not from the
 * network: it carried on shipping telemetry for weeks, and because the record
 * was the only command channel, there was no way left to stop it. The remedy
 * in the end was dropping its data at the collector.
 *
 * So the disposition that says "they are keeping it and we cannot reach it"
 * writes NOTHING, and the day-7 deletion block STAYS BLOCKED. It is a report,
 * not a resolution: the case waits for a person to pick another disposition or
 * record an explicit override. A tidy fleet view is not worth an unmanaged
 * machine nobody can reach.
 */

import { describe, expect, it } from 'vitest'
import { runDeviceDisposition } from '../../src/engine/device/disposition.ts'
import { harness, LEAVER_USER_ID, request } from '../fixtures/device/harness.ts'

describe('retain_unmanaged', () => {
  it('changes nothing at the provider, even fully armed and asked to execute', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(
      h.deps,
      request({ disposition: 'retain_unmanaged', dryRun: false }),
    )

    const writes = h.devices.calls.filter(
      (c) => c.startsWith('unbindUser') || c.startsWith('bindUser') || c.startsWith('deleteDevice'),
    )
    expect(writes).toEqual([])
    expect(h.commands.fired).toEqual([])
    expect(h.devices.recordExists()).toBe(true)
    expect(h.devices.ownerIds()).toEqual([LEAVER_USER_ID])
    expect(report.recordDeleted).toBe(false)
  })

  it('leaves the deletion gate blocked and says what would clear it', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(
      h.deps,
      request({ disposition: 'retain_unmanaged', dryRun: false }),
    )

    expect(report.gateAfter.clears).toBe(false)
    expect(report.gateAfter.reason).toBe('retained_unmanaged')
    expect(report.gateAfter.detail).toContain('choose another disposition or record an explicit override')
    expect(report.leftEnrolled).toBe(true)
    expect(report.final).toBe('left_enrolled')
  })

  it('is a successful run, so it is not retried as a failure for ever', async () => {
    // The run did exactly what was asked. The block standing is the outcome,
    // not an error: an operator has to make a decision, and a run that reports
    // itself failed would be retried by a schedule instead.
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(
      h.deps,
      request({ disposition: 'retain_unmanaged', dryRun: false }),
    )
    expect(report.ok).toBe(true)
    expect(report.steps.map((s) => s.step)).toEqual(['preflight', 'report'])
  })

  it('tells somebody, because a standing block that nobody reads is not a block', async () => {
    const h = harness({ armed: true })
    await runDeviceDisposition(h.deps, request({ disposition: 'retain_unmanaged', dryRun: false }))
    expect(h.notifier?.sent[0]?.body).toContain('Deletion gate after this run: BLOCKED')
  })
})
