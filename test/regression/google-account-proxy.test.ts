/**
 * Failure this prevents: whether a person had a Google account was inferred
 * from them having an account in the identity provider. The two are not the
 * same set. People with no mailbox were treated as having one, and the
 * offboarding steps that only make sense for a mailbox ran against nothing,
 * reporting failures nobody could act on. In the other direction, a person
 * whose identity-provider record had already been removed looked like they had
 * no Google account, and their live mailbox was left alone.
 *
 * Google presence is read from the Google directory, from this connector, and
 * from nowhere else. A 404 is the answer "no account", and any other failure is
 * an error rather than an absence.
 */

import { describe, expect, it } from 'vitest'

import { getUser } from '../../src/connectors/google/directory.ts'
import { directoryUser, googleCtx } from '../fixtures/google/harness.ts'

describe('Google presence comes from Google', () => {
  it('reads a present account as present', async () => {
    const { ctx } = googleCtx([
      { method: 'GET', match: '/users/', respond: { status: 200, body: directoryUser() } },
    ])

    const found = await getUser(ctx, 'jane.doe@example.com')

    expect(found).not.toBeNull()
    expect(found!.email).toBe('jane.doe@example.com')
  })

  it('reads an absent account as absent, not as an error', async () => {
    const { ctx } = googleCtx([
      { method: 'GET', match: '/users/', respond: { status: 404, body: {} } },
    ])

    expect(await getUser(ctx, 'john.doe@example.com')).toBeNull()
  })

  it('reports a failed read as a failure, so absence is never assumed', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const { ctx } = googleCtx([
        { method: 'GET', match: '/users/', respond: { status, body: {} } },
      ])

      await expect(getUser(ctx, 'jane.doe@example.com')).rejects.toThrow(String(status))
    }
  })

  it('reports a suspended account as present and suspended', async () => {
    const { ctx } = googleCtx([
      {
        method: 'GET',
        match: '/users/',
        respond: { status: 200, body: directoryUser({ suspended: true }) },
      },
    ])

    const found = await getUser(ctx, 'jane.doe@example.com')

    // A suspended mailbox still exists, still holds files and still holds a
    // seat, so it must not read as absent.
    expect(found).not.toBeNull()
    expect(found!.suspended).toBe(true)
  })
})
