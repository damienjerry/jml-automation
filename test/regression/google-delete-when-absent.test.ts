/**
 * Failure this prevents: a 404 from the Google delete was recorded as a
 * successful deletion. Keeping the run idempotent that way is right, but the
 * audit then could not tell "this run deleted the account" from "there was
 * nothing there", and the deletion ran even for people the record said had no
 * Google account at all. A year later there was no way to answer what had
 * actually happened to a given mailbox.
 *
 * The 404 tolerance stays, because a retried run must not fail. What changes is
 * the reporting: an absent account is `alreadyAbsent`, never a plain success,
 * and the state is confirmed by reading the account back either way.
 */

import { describe, expect, it } from 'vitest'

import { deleteUser } from '../../src/connectors/google/directory.ts'
import { revokeLicence } from '../../src/connectors/google/licensing.ts'
import { directoryUser, googleCtx } from '../fixtures/google/harness.ts'

describe('deleting an account that is already gone', () => {
  it('is idempotent, and says it was already absent', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/users/', respond: { status: 404, body: {} } },
      { method: 'GET', match: '/users/', respond: { status: 404, body: {} } },
    ])

    const outcome = await deleteUser(ctx, 'john.doe@example.com')

    expect(outcome).toMatchObject({ ok: true, verified: true, alreadyAbsent: true })
  })

  it('does not claim it was already absent when this run did the deleting', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/users/', respond: { status: 204, body: {} } },
      { method: 'GET', match: '/users/', respond: { status: 404, body: {} } },
    ])

    const outcome = await deleteUser(ctx, 'jane.doe@example.com')

    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(outcome.alreadyAbsent).toBeUndefined()
  })

  it('never reports a deletion that did not happen', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/users/', respond: { status: 200, body: {} } },
      { method: 'GET', match: '/users/', respond: { status: 200, body: directoryUser() } },
    ])

    expect(await deleteUser(ctx, 'jane.doe@example.com')).toMatchObject({
      ok: false,
      verified: false,
    })
  })
})

describe('revoking a licence that is already released', () => {
  it('is idempotent, and says it was already absent', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/sku/', respond: { status: 404, body: {} } },
    ])

    const outcome = await revokeLicence(
      ctx,
      'john.doe@example.com',
      'Google-Apps',
      'example-standard-sku',
    )

    expect(outcome).toMatchObject({ ok: true, verified: true, alreadyAbsent: true })
    expect(outcome.detail).toMatchObject({ reason: 'no_such_assignment' })
  })

  it('reports a seat this run released as done rather than already absent', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/sku/', respond: { status: 204, body: {} } },
      { method: 'GET', match: '/sku/', respond: { status: 404, body: {} } },
    ])

    const outcome = await revokeLicence(
      ctx,
      'jane.doe@example.com',
      'Google-Apps',
      'example-standard-sku',
    )

    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(outcome.alreadyAbsent).toBeUndefined()
  })
})
