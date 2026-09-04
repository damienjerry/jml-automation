import { describe, expect, it } from 'vitest'
import { createDomainMap } from '../../src/core/domain.ts'
import { nullLogger } from '../../src/core/logger.ts'
import type { BoundDevice, Person } from '../../src/core/types.ts'
import { createFakeProviders } from '../../src/connectors/fake.ts'
import {
  blockedFingerprint,
  describeDevices,
  deviceLabel,
  evaluateAckGate,
  evaluateDeleteGate,
  evaluateDeviceGate,
  evaluateIdentityGate,
  evaluateTransferGate,
  resolveProviderAccounts,
  type IdpResolution,
} from '../../src/engine/leaver/gate.ts'
import {
  DEVICE_ID,
  IDP_USER_ID,
  LEAVER_EMAIL,
  MANAGER_EMAIL,
  TODAY,
  defaultSeed,
  leaverConfig,
  personFixture,
} from '../fixtures/leaver/harness.ts'

const domain = createDomainMap({ primaryDomain: 'example.com', aliasDomains: ['example.org'] })
const cfg = leaverConfig()
const FOUND: IdpResolution = { kind: 'found', user: { id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true } }

function device(overrides: Partial<BoundDevice> = {}): BoundDevice {
  return {
    id: DEVICE_ID,
    displayName: 'Field laptop 1',
    osFamily: 'windows',
    serial: 'SERIAL0001',
    lastContact: `${TODAY}T08:00:00.000Z`,
    fdeKeyPresent: true,
    ...overrides,
  }
}

describe('the hand-over gate', () => {
  it('is shut until the provider reports the transfer complete', () => {
    const gate = evaluateTransferGate(personFixture({ status: 'offboarding' }), cfg)
    expect(gate).toMatchObject({ open: false, reason: 'transfer_incomplete' })
  })

  it('opens on a completed transfer, on a human override, and when there is no Google account', () => {
    const done = personFixture({ offboarding: { suspendedAt: TODAY, legs: {}, transferredAt: `${TODAY}T08:00:00.000Z` } })
    expect(evaluateTransferGate(done, cfg).open).toBe(true)

    const waived = personFixture({ offboarding: { suspendedAt: TODAY, legs: {}, transferOverride: 'IT accepted' } })
    expect(evaluateTransferGate(waived, cfg).open).toBe(true)

    expect(evaluateTransferGate(personFixture({ googleAccountPresent: false }), cfg).open).toBe(true)
  })

  it('opens when nothing permanent is being deleted anyway', () => {
    const noDelete = leaverConfig({ leaver: { deleteGoogleUser: false } })
    expect(evaluateTransferGate(personFixture(), noDelete).open).toBe(true)
    const notRequired = leaverConfig({ leaver: { requireTransferBeforeDelete: false } })
    expect(evaluateTransferGate(personFixture(), notRequired).open).toBe(true)
  })
})

describe('the identity gate', () => {
  const leaver = personFixture({ externalIds: { jumpcloudUserId: IDP_USER_ID } })

  it('opens when nobody employed claims the account or the address', () => {
    expect(evaluateIdentityGate(leaver, [], domain).open).toBe(true)
  })

  it('shuts when an employed row holds the same provider account id', () => {
    const colleague: Person = personFixture({
      hrisId: 'hris-live',
      status: 'active',
      primaryEmail: 'someone.else@example.com',
      displayName: 'John Doe',
    })
    const gate = evaluateIdentityGate(leaver, [colleague], domain)
    expect(gate).toMatchObject({ open: false, reason: 'identity_mismatch', park: 'identity_claimed_by_live_person' })
    if (!gate.open) expect(gate.detail).toContain('John Doe')
  })

  it('shuts when an employed row holds the same address on another domain we own', () => {
    const colleague = personFixture({
      hrisId: 'hris-live',
      status: 'active',
      primaryEmail: 'jane.doe@example.org',
      externalIds: {},
    })
    expect(evaluateIdentityGate(leaver, [colleague], domain).open).toBe(false)
  })

  it('still protects a live row that is on hold', () => {
    // Hold stops the automation acting on that person. It must not stop them
    // being protected from another row's offboarding.
    const held = personFixture({ hrisId: 'hris-live', status: 'active', hold: true })
    expect(evaluateIdentityGate(leaver, [held], domain).open).toBe(false)
  })

  it('does not treat the row being offboarded as a claim on itself', () => {
    expect(evaluateIdentityGate(leaver, [leaver], domain).open).toBe(true)
  })
})

describe('the device gate', () => {
  it('opens on a successful read of no devices', async () => {
    const providers = createFakeProviders({ idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }] })
    const gate = await evaluateDeviceGate({ person: personFixture(), idp: FOUND, devices: providers.devices })
    expect(gate.open).toBe(true)
  })

  it('shuts, names the machine and carries it, when one is bound', async () => {
    const providers = createFakeProviders({
      idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, devices: [DEVICE_ID] }],
      devices: [{ id: DEVICE_ID, displayName: 'Field laptop 1' }],
    })
    const gate = await evaluateDeviceGate({ person: personFixture(), idp: FOUND, devices: providers.devices })
    expect(gate).toMatchObject({ open: false, reason: 'devices_bound' })
    if (!gate.open) {
      expect(gate.devices?.map((d) => d.id)).toEqual([DEVICE_ID])
      expect(gate.detail).toContain('Field laptop 1')
    }
  })

  it('shuts on a read that failed, and never returns an empty list instead', async () => {
    const providers = createFakeProviders(defaultSeed()).fault('devices.listBoundDevices', { kind: 'gate_error' })
    const gate = await evaluateDeviceGate({
      person: personFixture(),
      idp: FOUND,
      devices: providers.devices,
      logger: nullLogger(),
    })
    expect(gate).toMatchObject({ open: false, reason: 'gate_error' })
  })

  it('shuts when the account itself could not be read', async () => {
    const providers = createFakeProviders(defaultSeed())
    const gate = await evaluateDeviceGate({
      person: personFixture(),
      idp: { kind: 'unreadable', detail: 'the provider answered 500' },
      devices: providers.devices,
    })
    expect(gate).toMatchObject({ open: false, reason: 'gate_error' })
  })

  it('opens when there is no account, because nothing can be bound to it', async () => {
    const providers = createFakeProviders({})
    const gate = await evaluateDeviceGate({ person: personFixture(), idp: { kind: 'absent' }, devices: providers.devices })
    expect(gate.open).toBe(true)
  })
})

describe('the acknowledgement gate', () => {
  it('is open by default, so the shipped behaviour needs nobody at a keyboard', () => {
    expect(evaluateAckGate(personFixture(), cfg).open).toBe(true)
  })

  it('shuts until a person is recorded against it', () => {
    const needsAck = leaverConfig({ leaver: { requireOperatorAck: true } })
    expect(evaluateAckGate(personFixture(), needsAck)).toMatchObject({ open: false, reason: 'awaiting_ack' })
    const acked = personFixture({
      offboarding: { suspendedAt: TODAY, legs: {}, operatorAck: { by: 'john.doe@example.com', at: `${TODAY}T10:00:00.000Z` } },
    })
    expect(evaluateAckGate(acked, needsAck).open).toBe(true)
  })
})

describe('the gates together', () => {
  it('report the cheapest closed gate first, so no network call is made for a row already blocked', async () => {
    const providers = createFakeProviders(defaultSeed()).fault('devices.listBoundDevices', { kind: 'gate_error' })
    const gate = await evaluateDeleteGate({
      person: personFixture({ status: 'offboarding' }),
      idp: FOUND,
      devices: providers.devices,
      cfg,
      live: [],
      domain,
    })
    expect(gate).toMatchObject({ open: false, reason: 'transfer_incomplete' })
    expect(providers.calls).toEqual([])
  })

  it('opens only when every gate is open', async () => {
    const providers = createFakeProviders({ idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }] })
    const ready = personFixture({
      status: 'offboarding',
      offboarding: { suspendedAt: TODAY, legs: {}, transferredAt: `${TODAY}T08:00:00.000Z` },
    })
    const gate = await evaluateDeleteGate({ person: ready, idp: FOUND, devices: providers.devices, cfg, live: [], domain })
    expect(gate.open).toBe(true)
  })
})

describe('the blocked fingerprint', () => {
  it('changes with the machine set and not with anything else', () => {
    const one = blockedFingerprint('devices_bound', [device()])
    const same = blockedFingerprint('devices_bound', [device({ lastContact: `${TODAY}T23:00:00.000Z` })])
    const two = blockedFingerprint('devices_bound', [device(), device({ id: 'sys-laptop-2' })])
    // Last contact moves on every run; if it entered the fingerprint the
    // "notify on change" rule would fire every run, which is the defect.
    expect(same).toBe(one)
    expect(two).not.toBe(one)
    expect(blockedFingerprint('gate_error')).not.toBe(blockedFingerprint('devices_bound'))
  })

  it('does not depend on the order the machines came back in', () => {
    const a = blockedFingerprint('devices_bound', [device(), device({ id: 'sys-laptop-2' })])
    const b = blockedFingerprint('devices_bound', [device({ id: 'sys-laptop-2' }), device()])
    expect(a).toBe(b)
  })
})

describe('naming a machine', () => {
  it('prefers the display name, then the serial, and only then the raw id', () => {
    expect(deviceLabel(device())).toBe('Field laptop 1')
    expect(deviceLabel(device({ displayName: null }))).toBe('serial SERIAL0001')
    expect(deviceLabel(device({ displayName: null, serial: null }))).toBe(DEVICE_ID)
  })

  it('describes each machine on its own line with what an operator needs', () => {
    const text = describeDevices([device()])
    expect(text).toContain('Field laptop 1')
    expect(text).toContain('windows')
    expect(text).toContain('SERIAL0001')
  })
})

describe('resolving the provider accounts', () => {
  it('keeps absent and unreadable apart', async () => {
    const present = createFakeProviders(defaultSeed())
    expect(await resolveProviderAccounts(present.identity, present.google, personFixture())).toMatchObject({
      idp: { kind: 'found' },
      googleAccount: { kind: 'found' },
      ambiguous: false,
    })

    const missing = createFakeProviders({})
    expect(await resolveProviderAccounts(missing.identity, missing.google, personFixture())).toMatchObject({
      idp: { kind: 'absent' },
      googleAccount: { kind: 'absent' },
    })

    const broken = createFakeProviders(defaultSeed())
      .fault('idp.findUser', { kind: 'error' })
      .fault('google.getUser', { kind: 'error' })
    const resolved = await resolveProviderAccounts(broken.identity, broken.google, personFixture())
    expect(resolved.idp.kind).toBe('unreadable')
    expect(resolved.googleAccount.kind).toBe('unreadable')
  })

  it('reports an ambiguous match separately, rather than picking one', async () => {
    const twins = createFakeProviders({
      idp: [
        { id: 'usr-a', email: LEAVER_EMAIL },
        { id: 'usr-b', email: LEAVER_EMAIL },
      ],
    })
    const resolved = await resolveProviderAccounts(twins.identity, twins.google, personFixture({ externalIds: {} }))
    expect(resolved.ambiguous).toBe(true)
    expect(resolved.idp.kind).toBe('unreadable')
  })

  it('ignores a stored id whose account carries another person address', async () => {
    // Ids get copied between rows by exactly the accident this protects
    // against, so an id is only evidence while the account still carries an
    // address this person owns.
    const drifted = createFakeProviders({ idp: [{ id: IDP_USER_ID, email: MANAGER_EMAIL }] })
    const resolved = await resolveProviderAccounts(drifted.identity, drifted.google, personFixture())
    expect(resolved.idp.kind).toBe('absent')
  })
})
