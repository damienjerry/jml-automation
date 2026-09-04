import { describe, expect, it } from 'vitest'

import {
  deleteUser,
  getUser,
  listUsers,
  resolveUserId,
  suspendUser,
} from '../../src/connectors/google/directory.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import { assertionClaims, directoryUser, googleCtx } from '../fixtures/google/harness.ts'

describe('google directory reads', () => {
  it('returns the account when the directory has one', async () => {
    const { ctx } = googleCtx([
      { method: 'GET', match: '/users/jane.doe', respond: { status: 200, body: directoryUser() } },
    ])

    expect(await getUser(ctx, 'jane.doe@example.com')).toEqual({
      id: '100000000000000000001',
      email: 'jane.doe@example.com',
      displayName: 'Jane Doe',
      suspended: false,
      rawState: 'active',
    })
  })

  it('returns null on a 404, because most people have no account to find', async () => {
    const { ctx } = googleCtx([{ method: 'GET', match: '/users/', respond: { status: 404, body: {} } }])

    expect(await getUser(ctx, 'john.doe@example.com')).toBeNull()
  })

  it('throws on any other failure, so an outage is never read as absence', async () => {
    const { ctx } = googleCtx([{ method: 'GET', match: '/users/', respond: { status: 503, body: {} } }])

    await expect(getUser(ctx, 'jane.doe@example.com')).rejects.toThrow('503')
  })

  it('resolves an account id with the read-only scope', async () => {
    const { ctx, http } = googleCtx([
      { method: 'GET', match: '/users/', respond: { status: 200, body: directoryUser() } },
    ])

    expect(await resolveUserId(ctx, 'jane.doe@example.com')).toBe('100000000000000000001')
    expect(assertionClaims(http.tokenRequests()[0]!).scope).toBe(GOOGLE_SCOPES.directoryUserReadonly)
  })
})

describe('google suspend', () => {
  it('is verified only after the account reads back suspended', async () => {
    const { ctx, http } = googleCtx([
      { method: 'PUT', match: '/users/', respond: { status: 200, body: directoryUser() } },
      {
        method: 'GET',
        match: '/users/',
        respond: { status: 200, body: directoryUser({ suspended: true }) },
      },
    ])

    const outcome = await suspendUser(ctx, 'jane.doe@example.com')

    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(http.apiRequests().map((r) => r.method)).toEqual(['PUT', 'GET'])
  })

  it('refuses to claim success when the write was accepted and nothing changed', async () => {
    const { ctx } = googleCtx([
      { method: 'PUT', match: '/users/', respond: { status: 200, body: directoryUser() } },
      {
        method: 'GET',
        match: '/users/',
        respond: { status: 200, body: directoryUser({ suspended: false }) },
      },
    ])

    const outcome = await suspendUser(ctx, 'jane.doe@example.com')

    expect(outcome.ok).toBe(false)
    expect(outcome.verified).toBe(false)
    expect(outcome.error).toContain('still active')
  })

  it('reports an absent account as already absent, not as suspended', async () => {
    const { ctx } = googleCtx([
      { method: 'PUT', match: '/users/', respond: { status: 404, body: {} } },
    ])

    expect(await suspendUser(ctx, 'john.doe@example.com')).toMatchObject({
      ok: true,
      verified: true,
      alreadyAbsent: true,
    })
  })

  it('marks a rate limit retryable and a refusal not', async () => {
    const limited = googleCtx([
      { method: 'PUT', match: '/users/', respond: { status: 429, body: {} } },
    ])
    const refused = googleCtx([
      { method: 'PUT', match: '/users/', respond: { status: 403, body: {} } },
    ])

    expect((await suspendUser(limited.ctx, 'jane.doe@example.com')).retryable).toBe(true)
    expect((await suspendUser(refused.ctx, 'jane.doe@example.com')).retryable).toBe(false)
  })
})

describe('google delete', () => {
  it('is verified when the read-back 404s', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/users/', respond: { status: 204, body: {} } },
      { method: 'GET', match: '/users/', respond: { status: 404, body: {} } },
    ])

    const outcome = await deleteUser(ctx, 'jane.doe@example.com')
    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(outcome.alreadyAbsent).toBeUndefined()
  })

  it('refuses to claim success while the account is still there', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/users/', respond: { status: 200, body: {} } },
      { method: 'GET', match: '/users/', respond: { status: 200, body: directoryUser() } },
    ])

    expect(await deleteUser(ctx, 'jane.doe@example.com')).toMatchObject({
      ok: false,
      verified: false,
      retryable: true,
    })
  })

  it('reports an unreadable read-back as unverified rather than done', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/users/', respond: { status: 204, body: {} } },
      { method: 'GET', match: '/users/', respond: { status: 500, body: {} } },
    ])

    expect(await deleteUser(ctx, 'jane.doe@example.com')).toMatchObject({
      ok: false,
      verified: false,
    })
  })
})

describe('google account listing', () => {
  it('lists by customer, so a secondary domain is not silently omitted', async () => {
    const { ctx, http } = googleCtx([
      {
        method: 'GET',
        match: '/users?',
        respond: [
          {
            status: 200,
            body: { users: [directoryUser()], nextPageToken: 'page-2' },
          },
          {
            status: 200,
            body: {
              users: [directoryUser({ primaryEmail: 'john.doe@legacy.example.com' })],
            },
          },
        ],
      },
    ])

    const listed = await listUsers(ctx)

    expect(listed.complete).toBe(true)
    expect(listed.users.map((u) => u.email)).toEqual([
      'jane.doe@example.com',
      'john.doe@legacy.example.com',
    ])
    // The Admin SDK literal, not a domain: a domain-scoped list omits every
    // account on a secondary domain and says nothing about it.
    for (const request of http.apiRequests()) {
      expect(request.query).toMatchObject({ customer: 'my_customer' })
    }
    expect(http.apiRequests()[1]!.query).toMatchObject({ pageToken: 'page-2' })
  })

  it('reports a list that ran out of pages as incomplete', async () => {
    const { ctx } = googleCtx([
      {
        method: 'GET',
        match: '/users?',
        respond: { status: 200, body: { users: [directoryUser()], nextPageToken: 'more' } },
      },
    ])

    const listed = await listUsers(ctx, { maxPages: 2 })
    expect(listed.complete).toBe(false)
    expect(listed.users).toHaveLength(2)
  })
})
