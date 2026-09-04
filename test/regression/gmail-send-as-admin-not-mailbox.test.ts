/**
 * Failure this prevents: notifications were sent by minting a token for the
 * administrator and then posting to a shared mailbox's send path. That worked
 * only because the administrator happened to be that mailbox. Under
 * domain-wide delegation Gmail ignores mailbox delegation for the sending
 * identity, so on any other tenancy the same configuration fails, and sharing
 * the mailbox with the administrator does not fix it.
 *
 * The connector impersonates the sender mailbox directly. This test pins the
 * subject, because it is the single least portable line in the toolkit and it
 * would be easy to "simplify" back to the administrator.
 */

import { describe, expect, it } from 'vitest'

import { sendMail } from '../../src/connectors/google/gmail.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import { assertionClaims, googleCtx } from '../fixtures/google/harness.ts'

const SEND_OK = {
  method: 'POST',
  match: '/messages/send',
  respond: { status: 200, body: { id: 'message-1' } },
} as const

describe('sending as the mailbox, not as the administrator', () => {
  it('impersonates the sender mailbox', async () => {
    const { ctx, http } = googleCtx([SEND_OK])

    await sendMail(ctx, { to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' })

    const claims = assertionClaims(http.tokenRequests()[0]!)
    expect(claims.sub).toBe('it.notifications@example.com')
    expect(claims.sub).not.toBe('admin@example.com')
    expect(claims.scope).toBe(GOOGLE_SCOPES.gmailSend)
  })

  it('posts to the sender mailbox path and writes the same address in From', async () => {
    const { ctx, http } = googleCtx([SEND_OK])

    await sendMail(ctx, { to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' })

    const request = http.apiRequests()[0]!
    expect(request.url).toContain(encodeURIComponent('it.notifications@example.com'))
    const sent = Buffer.from((request.json as { raw: string }).raw, 'base64url').toString('utf8')
    expect(sent).toContain('From: it.notifications@example.com')
  })

  it('follows the configured mailbox rather than a compiled-in one', async () => {
    const { ctx, http } = googleCtx([SEND_OK], {
      senderMailbox: 'people.notifications@example.com',
    })

    await sendMail(ctx, { to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' })

    expect(assertionClaims(http.tokenRequests()[0]!).sub).toBe(
      'people.notifications@example.com',
    )
  })

  it('reports a mailbox that cannot be impersonated instead of throwing out of the run', async () => {
    const { ctx } = googleCtx([
      {
        method: 'POST',
        match: 'oauth2',
        respond: { status: 400, body: { error: 'invalid_grant' } },
      },
    ])

    const outcome = await sendMail(ctx, {
      to: ['john.doe@example.com'],
      subject: 'Subject',
      body: 'Body',
    })

    // A group or an alias has no mailbox to act as. The remedy differs from a
    // missing scope, so the two are reported differently.
    expect(outcome).toMatchObject({ ok: false, verified: false, retryable: false })
    expect(outcome.error).toContain('could not be impersonated')
  })
})
