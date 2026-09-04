import { describe, expect, it } from 'vitest'
import { runDeviceDisposition, previewDeviceDisposition } from '../../src/engine/device/disposition.ts'
import {
  harness,
  request,
  LEAVER_USER_ID,
  MemoryAuditSink,
  NEW_OWNER_EMAIL,
  NEW_OWNER_USER_ID,
  POOL_USER_ID,
  PROVEN_MANIFEST,
  SYSTEM_ID,
} from '../fixtures/device/harness.ts'

describe('dry run', () => {
  it('is the default even when the caller says nothing', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request())
    expect(report.dryRun).toBe(true)
    expect(report.final).toBe('planned')
    expect(h.devices.calls.filter((c) => c.startsWith('unbindUser'))).toEqual([])
  })

  it('names the exact machine and the exact association it would create', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ disposition: 'reassign', rebindToEmail: NEW_OWNER_EMAIL }))
    expect(report.plannedWrites.join('\n')).toContain('association add: user ' + NEW_OWNER_USER_ID)
    expect(report.plannedWrites.join('\n')).toContain('association remove: user ' + LEAVER_USER_ID)
    expect(report.plannedWrites.join('\n')).toContain(SYSTEM_ID)
    expect(report.displayName).toBe('Field laptop 1')
  })

  it('names the command association a handover would create', async () => {
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST })
    const report = await runDeviceDisposition(
      h.deps,
      request({ disposition: 'handover', acknowledgeFdeKeyLoss: true }),
    )
    const written = report.plannedWrites.join('\n')
    expect(written).toContain('association add: system ' + SYSTEM_ID)
    expect(written).toContain('removed in a finally and asserted back to zero')
    expect(written).toContain('uninstall receipt required for: telemetry, inventory')
    expect(h.commands.fired).toEqual([])
  })

  it('is forced when config has not armed the action, and says why', async () => {
    const h = harness({ armed: false })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.dryRun).toBe(true)
    expect(report.preflight.notArmedReason).toBe('config.mode is dry-run')
    expect(report.warnings.join(' ')).toContain('nothing was written because')
  })
})

describe('return_to_pool', () => {
  it('unbinds the leaver, binds the spares account, and clears the gate', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.ok).toBe(true)
    expect(report.gateAfter).toMatchObject({ clears: true, reason: 'rebound_to_pool' })
    expect(h.devices.ownerIds()).toEqual([POOL_USER_ID])
    // The machine stays enrolled and its record stays: this is the disposition
    // that clears the block at no risk to the machine.
    expect(report.recordDeleted).toBe(false)
    expect(h.devices.recordExists()).toBe(true)
  })

  it('clears the gate even when the spares account cannot be resolved', async () => {
    const h = harness({ armed: true })
    h.deps.identity = { async findUser() { return null } }
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.gateAfter).toMatchObject({ clears: true, reason: 'unbound' })
    expect(report.warnings.join(' ')).toContain('spares account in config could not be resolved')
  })

  it('does not clear the gate when the write is accepted and changes nothing', async () => {
    // A provider answering 200 while ignoring the part of the body that
    // mattered is the single most repeated failure this toolkit guards against.
    const h = harness({ armed: true, devices: { writesChangeNothing: true } })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.ok).toBe(false)
    expect(report.gateAfter).toMatchObject({ clears: false, reason: 'still_bound' })
  })

  it('reports the gate as blocked when the bindings cannot be re-read', async () => {
    const h = harness({ armed: true, devices: { ownerReadThrowsAfter: 1 } })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.gateAfter).toMatchObject({ clears: false, reason: 'unreadable' })
  })
})

describe('reassign', () => {
  it('binds the new owner before removing the old one, so the machine is never unowned', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(
      h.deps,
      request({ disposition: 'reassign', dryRun: false, rebindToEmail: NEW_OWNER_EMAIL }),
    )
    const writes = h.devices.calls.filter((c) => c.startsWith('bindUser') || c.startsWith('unbindUser'))
    expect(writes).toEqual(['bindUser:' + NEW_OWNER_USER_ID + ':' + SYSTEM_ID, 'unbindUser:' + LEAVER_USER_ID + ':' + SYSTEM_ID])
    expect(report.gateAfter).toMatchObject({ clears: true, reason: 'bound_to_new_owner' })
  })

  it('leaves the old binding in place when the new owner cannot be confirmed', async () => {
    const h = harness({ armed: true, devices: { writesChangeNothing: true } })
    const report = await runDeviceDisposition(
      h.deps,
      request({ disposition: 'reassign', dryRun: false, rebindToEmail: NEW_OWNER_EMAIL }),
    )
    expect(h.devices.calls.filter((c) => c.startsWith('unbindUser'))).toEqual([])
    expect(report.gateAfter.clears).toBe(false)
  })

  it('is refused with no new owner at all', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ disposition: 'reassign', dryRun: false }))
    expect(report.final).toBe('refused')
    expect(report.preflight.refusals.map((r) => r.code)).toContain('no_rebind_target')
  })
})

describe('the audit trail', () => {
  it('writes an intent row before every write and an outcome row after it', async () => {
    const h = harness({ armed: true })
    await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(h.audit.trail()).toEqual([
      'outcome device.preflight',
      'intent device.unbindUser',
      'outcome device.unbindUser',
      'intent device.bindUser',
      'outcome device.bindUser',
    ])
    expect(h.audit.events.every((e) => e.subject.kind === 'device' && e.subject.id === SYSTEM_ID)).toBe(true)
  })

  it('performs no provider call when the intent row cannot be written', async () => {
    const h = harness({ armed: true, audit: new MemoryAuditSink('intent') })
    await expect(runDeviceDisposition(h.deps, request({ dryRun: false }))).rejects.toThrow('refused a intent row')
    expect(h.devices.calls.filter((c) => c.startsWith('unbindUser'))).toEqual([])
  })

  it('records a dry run as a dry run', async () => {
    const h = harness({ armed: true })
    await runDeviceDisposition(h.deps, request())
    expect(h.audit.events.every((e) => e.dryRun)).toBe(true)
  })
})

describe('the report', () => {
  it('tells somebody, and is not ok when the message was not delivered', async () => {
    const h = harness({ armed: true })
    h.deps.notifier = {
      name: 'fake',
      async send() {
        return { delivered: false, channel: 'fake', error: 'ok:false in the body' }
      },
      async testConnection() {
        return { ok: true, detail: 'fake' }
      },
    }
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.notified).toBe(false)
    expect(report.ok).toBe(false)
    expect(report.warnings.join(' ')).toContain('was not delivered')
  })

  it('renders the gate verdict into the message', async () => {
    const h = harness({ armed: true })
    const report = await runDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(report.notified).toBe(true)
    const sent = h.notifier?.sent[0]
    expect(sent?.kind).toBe('device.report')
    expect(sent?.body).toContain('Deletion gate after this run: clear')
    expect(sent?.body).toContain('Field laptop 1')
  })
})

describe('preview', () => {
  it('reads the plan and writes nothing', async () => {
    const h = harness({ armed: true })
    const plan = await previewDeviceDisposition(h.deps, request({ dryRun: false }))
    expect(plan.refusals).toEqual([])
    expect(plan.unbindUserId).toBe(LEAVER_USER_ID)
    expect(h.devices.calls.some((c) => c.startsWith('unbindUser') || c.startsWith('bindUser'))).toBe(false)
    expect(h.audit.events).toEqual([])
  })
})
