/**
 * Regression: a 200 that changed nothing, recorded as a completed suspension.
 *
 * The provider accepts a write, ignores part of it, and answers 200. The
 * automation this was ported from wrote its day-0 marker from that response, so
 * the record said the account was suspended while the account was still usable,
 * and the row was never retried because the marker was already set.
 *
 * The rule this file protects: `verified` may only be true when a read-back saw
 * the change. Everything downstream depends on it, because the engine refuses to
 * write a status from an unverified outcome.
 */

import { describe, expect, it } from 'vitest'
import { JumpCloudClient } from '../../src/connectors/jumpcloud/client.ts'
import { JumpCloudDevices } from '../../src/connectors/jumpcloud/devices.ts'
import { JumpCloudUsers } from '../../src/connectors/jumpcloud/users.ts'
import { FakeHttp, fakeSecret } from '../fixtures/http/fake-http.ts'

function client(http: FakeHttp) {
  return new JumpCloudClient({ http, apiKey: fakeSecret() })
}

const ACTIVE = { _id: 'usr-1', email: 'jane.doe@example.com', state: 'ACTIVATED', suspended: false }

describe('a suspension is only done when the account reads back suspended', () => {
  it('is not verified when the write was accepted and the account is unchanged', async () => {
    const http = new FakeHttp()
      .on('PUT', '/api/systemusers/usr-1', { status: 200, body: { success: true } })
      .on('GET', '/api/systemusers/usr-1', { status: 200, body: ACTIVE })

    const outcome = await new JumpCloudUsers(client(http)).suspendUser('usr-1')
    expect(outcome.verified).toBe(false)
    expect(outcome.ok).toBe(false)
    expect(outcome.retryable).toBe(true)
    expect(outcome.error).toContain('changed nothing')
  })

  it('is not verified when the record contradicts itself', async () => {
    // The boolean says suspended and the state string says active. An operator
    // looking at the console would see an active account, so this cannot count.
    const http = new FakeHttp()
      .on('PUT', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 200, body: { ...ACTIVE, suspended: true } })

    expect(await new JumpCloudUsers(client(http)).suspendUser('usr-1')).toMatchObject({ verified: false })
  })

  it('is verified when both fields agree', async () => {
    const http = new FakeHttp()
      .on('PUT', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 200, body: { ...ACTIVE, suspended: true, state: 'SUSPENDED' } })

    expect(await new JumpCloudUsers(client(http)).suspendUser('usr-1')).toMatchObject({ ok: true, verified: true })
  })
})

describe('the same rule on every other write', () => {
  it('a deletion that left the account readable is not verified', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 200, body: ACTIVE })

    expect(await new JumpCloudUsers(client(http)).deleteUser('usr-1')).toMatchObject({ ok: false, verified: false })
  })

  it('an unbind that left the binding in place is not verified', async () => {
    const http = new FakeHttp()
      .on('POST', '/api/v2/systems/sys-1/associations', { status: 204, body: null })
      .on('GET', '/api/v2/systems/sys-1/associations', { status: 200, body: [{ to: { id: 'usr-1' } }] })

    expect(await new JumpCloudDevices(client(http)).unbindUser('usr-1', 'sys-1')).toMatchObject({
      ok: false,
      verified: false,
    })
  })

  it('a device record that is still readable after a delete is not verified', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systems/sys-1', { status: 200, body: {} })
      .on('GET', '/api/systems/sys-1', { status: 200, body: { _id: 'sys-1', hostname: 'laptop-01' } })

    expect(await new JumpCloudDevices(client(http)).deleteDevice('sys-1')).toMatchObject({
      ok: false,
      verified: false,
    })
  })
})
