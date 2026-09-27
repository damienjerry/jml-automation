import { describe, expect, it } from 'vitest'
import { JumpCloudClient } from '../../src/connectors/jumpcloud/client.ts'
import { JumpCloudDevices, osFamilyOf, toBoundDevice } from '../../src/connectors/jumpcloud/devices.ts'
import { GateError } from '../../src/connectors/types.ts'
import { FakeHttp, fakeSecret } from '../fixtures/http/fake-http.ts'

function devices(http: FakeHttp) {
  return new JumpCloudDevices(new JumpCloudClient({ http, apiKey: fakeSecret() }))
}

const LAPTOP = {
  _id: 'sys-1',
  displayName: 'laptop-01',
  hostname: 'laptop-01',
  os: 'Windows 11 Pro',
  serialNumber: 'SER1234',
  lastContact: '2026-01-05T08:00:00.000Z',
  fde: { keyPresent: true, active: true },
}

describe('listBoundDevices counts custody, not access', () => {
  it('returns a machine the person is directly bound to', async () => {
    const http = new FakeHttp()
      .on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ id: 'sys-1' }] })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [{ to: { id: 'usr-1' }, paths: [[{}]] }] })
      .on('GET', '/api/systems/sys-1', { status: 200, body: LAPTOP })

    const bound = await devices(http).listBoundDevices('usr-1')
    expect(bound).toHaveLength(1)
    expect(bound.at(0)).toMatchObject({ id: 'sys-1', displayName: 'laptop-01', osFamily: 'windows' })
  })

  it('drops a machine reachable only through a group', async () => {
    // A person in a group that grants a machine appears on the effective list.
    // Counting that blocks a deletion for ever, because unbinding the person
    // cannot clear a binding they never had.
    const http = new FakeHttp()
      .on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ id: 'sys-1' }] })
      .on('GET', '/api/v2/systems/sys-1/associations', {
        status: 200,
        body: [{ to: { id: 'usr-1' }, paths: [[{ type: 'user_group' }, { type: 'system_group' }]] }],
      })

    expect(await devices(http).listBoundDevices('usr-1')).toEqual([])
  })

  it('drops a machine whose direct owner is somebody else', async () => {
    const http = new FakeHttp()
      .on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ id: 'sys-1' }] })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [{ to: { id: 'usr-2' } }] })

    expect(await devices(http).listBoundDevices('usr-1')).toEqual([])
  })

  it('returns an empty list only when every read succeeded', async () => {
    const http = new FakeHttp().on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [] })
    expect(await devices(http).listBoundDevices('usr-1')).toEqual([])
  })
})

describe('the gate fails closed', () => {
  it('throws when the first list cannot be read', async () => {
    const http = new FakeHttp().on('GET', '/api/v2/users/usr-1/systems', { status: 500, text: 'boom' })
    await expect(devices(http).listBoundDevices('usr-1')).rejects.toBeInstanceOf(GateError)
  })

  it('throws when the transport fails, rather than reporting no devices', async () => {
    const http = new FakeHttp().on('GET', '/api/v2/users/usr-1/systems', {
      status: 0,
      throws: new Error('socket hang up'),
    })
    await expect(devices(http).listBoundDevices('usr-1')).rejects.toBeInstanceOf(GateError)
  })

  it('throws when the direct-binding read fails for one candidate', async () => {
    const http = new FakeHttp()
      .on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ id: 'sys-1' }] })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 403, text: 'no' })
    await expect(devices(http).listBoundDevices('usr-1')).rejects.toBeInstanceOf(GateError)
  })

  it('throws when an association carries no readable id', async () => {
    const http = new FakeHttp().on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ to: {} }] })
    await expect(devices(http).listBoundDevices('usr-1')).rejects.toBeInstanceOf(GateError)
  })

  it('throws when a bound machine has vanished between the two reads', async () => {
    const http = new FakeHttp()
      .on('GET', '/api/v2/users/usr-1/systems', { status: 200, body: [{ id: 'sys-1' }] })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [{ to: { id: 'usr-1' } }] })
      .on('GET', '/api/systems/sys-1', { status: 404, body: null })
    await expect(devices(http).listBoundDevices('usr-1')).rejects.toBeInstanceOf(GateError)
  })
})

describe('unbind and bind, each proved by a read-back', () => {
  it('unbinds and confirms the person is no longer an owner', async () => {
    const http = new FakeHttp()
      .on('POST', '/api/v2/systems/sys-1/associations', { status: 204, body: null })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [] })
    const outcome = await devices(http).unbindUser('usr-1', 'sys-1')
    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(http.requests.at(0)?.body).toEqual({ op: 'remove', type: 'user', id: 'usr-1' })
  })

  it('refuses to call an unbind verified when the binding is still there', async () => {
    const http = new FakeHttp()
      .on('POST', '/api/v2/systems/sys-1/associations', { status: 200, body: null })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [{ to: { id: 'usr-1' } }] })
    expect(await devices(http).unbindUser('usr-1', 'sys-1')).toMatchObject({ ok: false, verified: false })
  })

  it('treats a missing association on a remove as already absent', async () => {
    const http = new FakeHttp().on('POST', '/api/v2/systems/sys-1/associations', { status: 404, body: null })
    expect(await devices(http).unbindUser('usr-1', 'sys-1')).toMatchObject({ verified: true, alreadyAbsent: true })
  })

  it('binds the next owner and confirms it took', async () => {
    const http = new FakeHttp()
      .on('POST', '/api/v2/systems/sys-1/associations', { status: 204, body: null })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [{ to: { id: 'usr-pool' } }] })
    expect(await devices(http).bindUser('usr-pool', 'sys-1')).toMatchObject({ ok: true, verified: true })
  })

  it('does not treat a 404 on an add as success', async () => {
    const http = new FakeHttp().on('POST', '/api/v2/systems/sys-1/associations', { status: 404, body: null })
    expect(await devices(http).bindUser('usr-pool', 'sys-1')).toMatchObject({ ok: false, verified: false })
  })

  it('reports unverified when the write was accepted but cannot be read back', async () => {
    const http = new FakeHttp()
      .on('POST', '/api/v2/systems/sys-1/associations', { status: 204, body: null })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 500, text: 'boom' })
    expect(await devices(http).unbindUser('usr-1', 'sys-1')).toMatchObject({ ok: false, verified: false })
  })

  it('reports the status of a rejected write', async () => {
    const http = new FakeHttp().on('POST', '/api/v2/systems/sys-1/associations', { status: 403, text: 'read only' })
    expect(await devices(http).unbindUser('usr-1', 'sys-1')).toMatchObject({ ok: false, retryable: false })
  })
})

describe('getDevice reports what an operator has to decide with', () => {
  it('names the machine, its family, its last contact and its escrowed key', async () => {
    const http = new FakeHttp().on('GET', '/api/systems/sys-1', { status: 200, body: LAPTOP })
    expect(await devices(http).getDevice('sys-1')).toEqual({
      id: 'sys-1',
      displayName: 'laptop-01',
      osFamily: 'windows',
      serial: 'SER1234',
      lastContact: '2026-01-05T08:00:00.000Z',
      fdeKeyPresent: true,
    })
  })

  it('is null for a machine that is not there', async () => {
    const http = new FakeHttp().on('GET', '/api/systems/sys-1', { status: 404, body: null })
    expect(await devices(http).getDevice('sys-1')).toBeNull()
  })

  it('throws on an unreadable answer, because a gate reads this', async () => {
    const http = new FakeHttp().on('GET', '/api/systems/sys-1', { status: 500, text: 'boom' })
    await expect(devices(http).getDevice('sys-1')).rejects.toBeInstanceOf(GateError)
  })

  it('says nothing about a recovery key it was not told about', () => {
    expect(toBoundDevice({ _id: 'sys-2', hostname: 'laptop-02' })?.fdeKeyPresent).toBeNull()
    expect(toBoundDevice({ _id: 'sys-2', hostname: 'laptop-02', fde: {} })?.fdeKeyPresent).toBeNull()
  })

  it('falls back to the hostname for a name, and never invents one', () => {
    expect(toBoundDevice({ _id: 'sys-2', hostname: 'laptop-02' })?.displayName).toBe('laptop-02')
    expect(toBoundDevice({ _id: 'sys-2' })?.displayName).toBeNull()
    expect(toBoundDevice({ hostname: 'laptop-02' })).toBeNull()
  })

  it('classifies an operating system explicitly, and refuses to guess', () => {
    expect(osFamilyOf({ osFamily: 'darwin' })).toBe('macos')
    expect(osFamilyOf({ os: 'macOS 15.7' })).toBe('macos')
    expect(osFamilyOf({ os: 'Ubuntu 24.04' })).toBe('linux')
    expect(osFamilyOf({ os: 'Windows 11 Pro' })).toBe('windows')
    // Anything unrecognised must not fall through to a default: sending a
    // Windows uninstaller to a machine that is not Windows is a real defect
    // from an earlier design.
    expect(osFamilyOf({ os: 'Some Appliance OS' })).toBe('unknown')
    expect(osFamilyOf({})).toBe('unknown')
  })
})

describe('deleteDevice', () => {
  it('is verified only when the record has stopped reading back', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systems/sys-1', { status: 204, body: null })
      .on('GET', '/api/systems/sys-1', { status: 404, body: null })
    expect(await devices(http).deleteDevice('sys-1')).toMatchObject({ ok: true, verified: true })
  })

  it('reports a record that is still there as unverified', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systems/sys-1', { status: 200, body: null })
      .on('GET', '/api/systems/sys-1', { status: 200, body: LAPTOP })
    expect(await devices(http).deleteDevice('sys-1')).toMatchObject({ ok: false, verified: false })
  })

  it('treats an already-gone record as already absent', async () => {
    const http = new FakeHttp().on('DELETE', '/api/systems/sys-1', { status: 404, body: null })
    expect(await devices(http).deleteDevice('sys-1')).toMatchObject({ verified: true, alreadyAbsent: true })
  })

  it('does not claim success when the read-back failed', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systems/sys-1', { status: 200, body: null })
      .on('GET', '/api/systems/sys-1', { status: 503, text: 'boom' })
    expect(await devices(http).deleteDevice('sys-1')).toMatchObject({ ok: false, verified: false })
  })

  it('reports a rejected delete with its status', async () => {
    const http = new FakeHttp().on('DELETE', '/api/systems/sys-1', { status: 429, text: 'slow down' })
    expect(await devices(http).deleteDevice('sys-1')).toMatchObject({ ok: false, retryable: true })
  })
})
