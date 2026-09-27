import { describe, expect, it } from 'vitest'
import { DuplicateTrigger } from '../../src/connectors/jumpcloud/commands.ts'
import { GateError } from '../../src/connectors/types.ts'
import {
  loadScriptManifest,
  planDeviceDisposition,
  resolveDryRun,
  triggerOsOf,
} from '../../src/engine/device/preflight.ts'
import {
  deviceConfig,
  deviceFixture,
  fakePeople,
  harness,
  LEAVER_USER_ID,
  NEW_OWNER_USER_ID,
  POOL_USER_ID,
  PROVEN_MANIFEST,
  request,
} from '../fixtures/device/harness.ts'

function codes(refusals: { code: string }[]): string[] {
  return refusals.map((r) => r.code)
}

describe('operating system dispatch', () => {
  it('is explicit, and anything unrecognised has no handover path', () => {
    expect(triggerOsOf('windows')).toBe('windows')
    expect(triggerOsOf('macos')).toBe('darwin')
    expect(triggerOsOf('linux')).toBe('linux')
    // An earlier version of this code classified anything that was not a Mac as
    // Windows, and sent a Windows uninstaller to a machine running Linux.
    expect(triggerOsOf('unknown')).toBeNull()
  })

  it('refuses a handover on a machine whose operating system was not reported', async () => {
    const h = harness({
      armed: true,
      devices: { device: deviceFixture({ osFamily: 'unknown' }) },
      manifest: PROVEN_MANIFEST,
    })
    const plan = await planDeviceDisposition(
      h.deps,
      request({ disposition: 'handover', acknowledgeFdeKeyLoss: true }),
    )
    expect(codes(plan.refusals)).toContain('os_unsupported')
  })
})

describe('reading the device', () => {
  it('refuses when the device is not there', async () => {
    const h = harness({ devices: { device: null } })
    const plan = await planDeviceDisposition(h.deps, request())
    expect(codes(plan.refusals)).toEqual(['device_not_found'])
  })

  it('refuses when the device cannot be read at all', async () => {
    const h = harness()
    h.deps.devices.getDevice = async () => {
      throw new GateError('the provider answered 500')
    }
    const plan = await planDeviceDisposition(h.deps, request())
    expect(codes(plan.refusals)).toEqual(['provider_unreadable'])
  })

  it('refuses when the direct bindings cannot be read', async () => {
    // Reading an error as "nothing is bound" is how an account was deleted
    // while the machine was still out there.
    const h = harness({ devices: { ownerReadThrows: true } })
    const plan = await planDeviceDisposition(h.deps, request())
    expect(codes(plan.refusals)).toEqual(['provider_unreadable'])
  })

  it('warns when the machine has not been heard from lately', async () => {
    const h = harness({ devices: { device: deviceFixture({ lastContact: '2026-03-01T09:00:00.000Z' }) } })
    const plan = await planDeviceDisposition(h.deps, request())
    expect(plan.lastContactAgeMin).toBe(1440)
    expect(plan.warnings.join(' ')).toContain('a command may not run today')
  })

  it('warns when the machine has never been in contact', async () => {
    const h = harness({ devices: { device: deviceFixture({ lastContact: null }) } })
    const plan = await planDeviceDisposition(h.deps, request())
    expect(plan.lastContactAgeMin).toBeNull()
    expect(plan.warnings.join(' ')).toContain('never recorded contact')
  })

  it('names the machine rather than reporting an id', async () => {
    const h = harness({ devices: { device: deviceFixture({ displayName: null }) } })
    const plan = await planDeviceDisposition(h.deps, request())
    // Falls back to the serial before the id: these messages are read by
    // somebody who has to go and find the machine.
    expect(plan.displayName).toBe('SERIAL0001')
  })
})

describe('who owns the machine', () => {
  it('refuses when the machine is bound to somebody other than the person leaving', async () => {
    const h = harness({ devices: { owners: ['user-someone-else'] }, people: fakePeople({ hrisId: 'hris-1' }) })
    const plan = await planDeviceDisposition(h.deps, request({ expectedOwnerHrisId: 'hris-1' }))
    expect(codes(plan.refusals)).toEqual(['owner_mismatch'])
  })

  it('accepts the expected owner when they really hold it', async () => {
    const h = harness({ people: fakePeople({ hrisId: 'hris-1' }) })
    const plan = await planDeviceDisposition(h.deps, request({ expectedOwnerHrisId: 'hris-1' }))
    expect(plan.refusals).toEqual([])
    expect(plan.unbindUserId).toBe(LEAVER_USER_ID)
  })

  it('refuses when the expected owner has no provider account recorded', async () => {
    const h = harness({ people: fakePeople({ hrisId: 'hris-1', externalIds: {} }) })
    const plan = await planDeviceDisposition(h.deps, request({ expectedOwnerHrisId: 'hris-1' }))
    expect(codes(plan.refusals)).toEqual(['owner_unknown'])
  })

  it('refuses when an expected owner is named and there is no people store to check', async () => {
    const h = harness()
    const plan = await planDeviceDisposition(h.deps, request({ expectedOwnerHrisId: 'hris-1' }))
    expect(codes(plan.refusals)).toEqual(['owner_unknown'])
  })

  it('refuses to guess which of several bindings to remove', async () => {
    const h = harness({ devices: { owners: [LEAVER_USER_ID, 'user-other'] } })
    const plan = await planDeviceDisposition(h.deps, request())
    expect(codes(plan.refusals)).toEqual(['ambiguous_owner'])
    expect(plan.warnings.join(' ')).toContain('2 people are bound directly')
  })

  it('treats a machine with no bindings as already in the state we want', async () => {
    const h = harness({ devices: { owners: [] } })
    const plan = await planDeviceDisposition(h.deps, request())
    expect(plan.refusals).toEqual([])
    expect(plan.unbindUserId).toBeNull()
  })

  it('resolves the spares account for a pool return', async () => {
    const h = harness()
    const plan = await planDeviceDisposition(h.deps, request())
    expect(plan.rebindUserId).toBe(POOL_USER_ID)
  })

  it('resolves a named new owner for a reassignment', async () => {
    const h = harness()
    const plan = await planDeviceDisposition(
      h.deps,
      request({ disposition: 'reassign', rebindToUserId: NEW_OWNER_USER_ID }),
    )
    expect(plan.rebindUserId).toBe(NEW_OWNER_USER_ID)
    expect(plan.refusals).toEqual([])
  })
})

describe('the handover refusals', () => {
  const handover = { disposition: 'handover' as const, acknowledgeFdeKeyLoss: true, dryRun: false, canariedSystemId: 'sys-canary' }

  it('refuses when no uninstall command is configured for the platform, and names the runbook', async () => {
    const h = harness({
      armed: true,
      config: { devices: { uninstallTriggers: { windows: null, darwin: null, linux: null } } },
      manifest: PROVEN_MANIFEST,
    })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    const refusal = plan.refusals.find((r) => r.code === 'no_uninstall_trigger')
    expect(refusal?.detail).toContain('docs/runbooks/canary-a-device-script.md')
  })

  it('refuses when no command answers to the configured trigger', async () => {
    const h = harness({ armed: true, commands: { command: null }, manifest: PROVEN_MANIFEST })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    expect(codes(plan.refusals)).toContain('command_not_found')
  })

  it('refuses when two commands share the trigger name, because one could be the wrong script', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: { resolveThrows: new DuplicateTrigger('t', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]) },
    })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    expect(codes(plan.refusals)).toContain('duplicate_command_trigger')
  })

  it('refuses when the command bindings cannot be read, because the blast radius is unknown', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: { preflightThrows: new GateError('associations unreadable') },
    })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    expect(codes(plan.refusals)).toContain('provider_unreadable')
  })

  it('refuses a command that cannot be fired by trigger', async () => {
    const h = harness({
      armed: true,
      manifest: PROVEN_MANIFEST,
      commands: { refusal: { refusal: 'not_a_trigger', detail: 'launch type is manual' } },
    })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    expect(codes(plan.refusals)).toContain('not_a_trigger')
  })

  it('refuses when no agents are configured, because an empty receipt would prove nothing', async () => {
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST, config: { devices: { agents: [] } } })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    expect(codes(plan.refusals)).toContain('no_agents_configured')
  })

  it('lists the agents the receipt will have to account for', async () => {
    const h = harness({ armed: true, manifest: PROVEN_MANIFEST })
    const plan = await planDeviceDisposition(h.deps, request(handover))
    expect(plan.agentsExpected).toEqual(['telemetry', 'inventory'])
    expect(plan.refusals).toEqual([])
  })
})

describe('arming', () => {
  it('forces a dry run unless the mode is armed and the action is named', () => {
    const dryRunConfig = deviceConfig({}, false)
    expect(resolveDryRun(dryRunConfig, 'return_to_pool', false)).toMatchObject({ dryRun: true })

    const armedConfig = deviceConfig({}, true)
    expect(resolveDryRun(armedConfig, 'return_to_pool', false)).toMatchObject({ dryRun: false, notArmedReason: null })
    expect(resolveDryRun(armedConfig, 'return_to_pool', undefined)).toMatchObject({ dryRun: true })
  })

  it('never lets keeping a machine unmanaged write anything', () => {
    const armedConfig = deviceConfig({}, true)
    expect(resolveDryRun(armedConfig, 'retain_unmanaged', false)).toMatchObject({ dryRun: true })
  })
})

describe('the shipped manifest', () => {
  it('says the scripts have never run on hardware', () => {
    const manifest = loadScriptManifest()
    expect(manifest.provenOnHardware).toBe(false)
    expect(manifest.scripts.map((s) => s.os)).toEqual(['windows', 'darwin'])
    expect(manifest.scripts.every((s) => s.provenOnHardware === false)).toBe(true)
  })
})
