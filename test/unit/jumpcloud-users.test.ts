import { describe, expect, it } from 'vitest'
import { JumpCloudClient } from '../../src/connectors/jumpcloud/client.ts'
import { JumpCloudUsers, toProviderUser } from '../../src/connectors/jumpcloud/users.ts'
import { AmbiguousMatch } from '../../src/connectors/types.ts'
import { FakeHttp, fakeSecret } from '../fixtures/http/fake-http.ts'

function users(http: FakeHttp) {
  return new JumpCloudUsers(new JumpCloudClient({ http, apiKey: fakeSecret() }))
}

const ACTIVE = { _id: 'usr-1', email: 'jane.doe@example.com', displayname: 'Jane Doe', state: 'ACTIVATED' }

describe('findUser resolves the stored id first', () => {
  it('uses the stored id when its address is one the person owns', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers/usr-1', { status: 200, body: ACTIVE })
    const found = await users(http).findUser({ storedId: 'usr-1', email: 'jane.doe@example.com' })
    expect(found?.id).toBe('usr-1')
    expect(http.count('GET', '/systemusers?')).toBe(0)
  })

  it('accepts an alias address, so a rename is not a different person', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers/usr-1', { status: 200, body: ACTIVE })
    const found = await users(http).findUser({
      storedId: 'usr-1',
      email: 'jane.doe@legacy.example.com',
      aliases: ['jane.doe@example.com'],
    })
    expect(found?.id).toBe('usr-1')
  })

  it('normalises case and surrounding space before comparing addresses', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers/usr-1', {
      status: 200,
      body: { ...ACTIVE, email: 'Jane.Doe@Example.com' },
    })
    const found = await users(http).findUser({ storedId: 'usr-1', email: '  jane.doe@example.com ' })
    expect(found?.id).toBe('usr-1')
  })

  it('ignores a stored id whose account belongs to somebody else', async () => {
    // The stored id points at a live colleague's account, which is how an
    // exit-rename incident wrote to the wrong person. The address lookup
    // decides instead, and here it finds nothing.
    const http = new FakeHttp()
      .on('GET', '/api/systemusers/usr-9', {
        status: 200,
        body: { _id: 'usr-9', email: 'john.doe@example.com', state: 'ACTIVATED' },
      })
      .on('GET', '/api/systemusers?', { status: 200, body: { results: [] } })
    const found = await users(http).findUser({ storedId: 'usr-9', email: 'jane.doe@example.com' })
    expect(found).toBeNull()
  })

  it('falls back to the address when the stored id is gone', async () => {
    const http = new FakeHttp()
      .on('GET', '/api/systemusers/usr-old', { status: 404, body: null })
      .on('GET', '/api/systemusers?', { status: 200, body: { results: [ACTIVE] } })
    const found = await users(http).findUser({ storedId: 'usr-old', email: 'jane.doe@example.com' })
    expect(found?.id).toBe('usr-1')
  })

  it('throws rather than guessing when two accounts share an address', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers?', {
      status: 200,
      body: {
        results: [ACTIVE, { _id: 'usr-2', email: 'jane.doe@example.com', state: 'ACTIVATED' }],
      },
    })
    const err = await users(http)
      .findUser({ email: 'jane.doe@example.com' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AmbiguousMatch)
    expect((err as AmbiguousMatch).matches).toHaveLength(2)
  })

  it('asks for two rows, so a second match cannot hide behind a limit of one', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers?', { status: 200, body: { results: [] } })
    await users(http).findUser({ email: 'jane.doe@example.com' })
    expect(http.sent('limit=2').length).toBeGreaterThan(0)
  })

  it('surfaces a failed read instead of reporting no account', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers/usr-1', { status: 500, text: 'boom' })
    await expect(users(http).findUser({ storedId: 'usr-1', email: 'jane.doe@example.com' })).rejects.toMatchObject({
      status: 500,
    })
  })
})

describe('suspendUser', () => {
  it('is verified only when the read-back agrees', async () => {
    const http = new FakeHttp()
      .on('PUT', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 200, body: { ...ACTIVE, suspended: true, state: 'SUSPENDED' } })
    const outcome = await users(http).suspendUser('usr-1')
    expect(outcome).toMatchObject({ ok: true, verified: true })
  })

  it('reports a missing account as already absent, not as work done', async () => {
    const http = new FakeHttp().on('PUT', '/api/systemusers/usr-1', { status: 404, body: null })
    const outcome = await users(http).suspendUser('usr-1')
    expect(outcome).toMatchObject({ ok: true, verified: true, alreadyAbsent: true })
  })

  it('reports a rejected write with the status and whether to retry', async () => {
    const http = new FakeHttp().on('PUT', '/api/systemusers/usr-1', { status: 429, text: 'slow down' })
    const outcome = await users(http).suspendUser('usr-1')
    expect(outcome).toMatchObject({ ok: false, verified: false, retryable: true })
  })

  it('fails when the account cannot be read back at all', async () => {
    const http = new FakeHttp()
      .on('PUT', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 404, body: null })
    const outcome = await users(http).suspendUser('usr-1')
    expect(outcome).toMatchObject({ ok: false, verified: false, retryable: true })
  })
})

describe('deleteUser', () => {
  it('is verified only when the account has stopped being readable', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systemusers/usr-1', { status: 204, body: null })
      .on('GET', '/api/systemusers/usr-1', { status: 404, body: null })
    expect(await users(http).deleteUser('usr-1')).toMatchObject({ ok: true, verified: true })
  })

  it('treats an already-deleted account as already absent', async () => {
    const http = new FakeHttp().on('DELETE', '/api/systemusers/usr-1', { status: 404, body: null })
    expect(await users(http).deleteUser('usr-1')).toMatchObject({ verified: true, alreadyAbsent: true })
  })

  it('refuses to call a delete verified while the account still reads back', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 200, body: ACTIVE })
    expect(await users(http).deleteUser('usr-1')).toMatchObject({ ok: false, verified: false })
  })

  it('does not claim success when the read-back itself failed', async () => {
    const http = new FakeHttp()
      .on('DELETE', '/api/systemusers/usr-1', { status: 200, body: {} })
      .on('GET', '/api/systemusers/usr-1', { status: 500, text: 'boom' })
    expect(await users(http).deleteUser('usr-1')).toMatchObject({ ok: false, verified: false, retryable: true })
  })

  it('reports a rejected delete', async () => {
    const http = new FakeHttp().on('DELETE', '/api/systemusers/usr-1', { status: 403, text: 'read only' })
    expect(await users(http).deleteUser('usr-1')).toMatchObject({ ok: false, retryable: false })
  })
})

describe('what doctor needs', () => {
  it('names the host it read, so a wrong host is obvious', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 200, body: { results: [ACTIVE] } })
    const check = await users(http).testConnection()
    expect(check.ok).toBe(true)
    expect(check.detail).toContain('console')
  })

  it('points a 404 at the host rather than at the key', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 404, body: null })
    const check = await users(http).testConnection()
    expect(check.ok).toBe(false)
    expect(check.remediation).toContain('console host')
  })

  it('points a 401 at the key', async () => {
    const http = new FakeHttp().on('GET', '/api/systemusers', { status: 401, body: null })
    expect((await users(http).testConnection()).remediation).toContain('API key')
  })

  it('detects a read-only key from a refused write, without changing anything', async () => {
    const http = new FakeHttp().on('PUT', '/api/systemusers/', { status: 403, body: null })
    const probe = await users(http).probeKeyRole()
    expect(probe.role).toBe('reader')
    expect(http.requests.at(0)?.body).toEqual({})
  })

  it('detects a writing key from a not-found id', async () => {
    const http = new FakeHttp().on('PUT', '/api/systemusers/', { status: 404, body: null })
    expect((await users(http).probeKeyRole()).role).toBe('writer')
  })

  it('says unknown rather than guessing when the probe is inconclusive', async () => {
    const http = new FakeHttp().on('PUT', '/api/systemusers/', { status: 500, body: null })
    expect((await users(http).probeKeyRole()).role).toBe('unknown')
  })
})

describe('mapping a provider record', () => {
  it('rejects a record with no id or no address', () => {
    expect(toProviderUser({ email: 'jane.doe@example.com' })).toBeNull()
    expect(toProviderUser({ _id: 'usr-1' })).toBeNull()
    expect(toProviderUser(null)).toBeNull()
  })

  it('reports not suspended when the two fields disagree', () => {
    const user = toProviderUser({ _id: 'usr-1', email: 'jane.doe@example.com', suspended: true, state: 'ACTIVATED' })
    expect(user?.suspended).toBe(false)
  })

  it('trusts the boolean when there is no state string', () => {
    const user = toProviderUser({ _id: 'usr-1', email: 'jane.doe@example.com', suspended: true })
    expect(user?.suspended).toBe(true)
    expect(user?.rawState).toBeNull()
  })
})
