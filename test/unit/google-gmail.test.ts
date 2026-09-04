import { describe, expect, it } from 'vitest'

import { buildMime, sendMail, setVacationResponder } from '../../src/connectors/google/gmail.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import { assertionClaims, googleCtx, refuseScopes } from '../fixtures/google/harness.ts'

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8')
}

describe('the leaver auto-reply', () => {
  it('impersonates the leaver, not an administrator', async () => {
    const { ctx, http } = googleCtx([
      { method: 'PUT', match: '/settings/vacation', respond: { status: 200, body: {} } },
      {
        method: 'GET',
        match: '/settings/vacation',
        respond: { status: 200, body: { enableAutoReply: true } },
      },
    ])

    const outcome = await setVacationResponder(
      ctx,
      'jane.doe@example.com',
      'This person has left',
      '<p>Please contact the team.</p>',
    )

    expect(outcome).toMatchObject({ ok: true, verified: true })
    const claims = assertionClaims(http.tokenRequests()[0]!)
    expect(claims.sub).toBe('jane.doe@example.com')
    expect(claims.scope).toBe(GOOGLE_SCOPES.gmailSettingsBasic)
    // The mailbox path is always the impersonated identity's own.
    expect(http.apiRequests()[0]!.url).toContain('/users/me/settings/vacation')
  })

  it('sends the responder to everybody, including people outside the organisation', async () => {
    const { ctx, http } = googleCtx([
      { method: 'PUT', match: '/settings/vacation', respond: { status: 200, body: {} } },
      {
        method: 'GET',
        match: '/settings/vacation',
        respond: { status: 200, body: { enableAutoReply: true } },
      },
    ])

    await setVacationResponder(ctx, 'jane.doe@example.com', 'Subject', '<p>Body</p>')

    expect(http.apiRequests()[0]!.json).toMatchObject({
      enableAutoReply: true,
      restrictToContacts: false,
      restrictToDomain: false,
    })
  })

  it('refuses to claim success when the responder reads back off', async () => {
    const { ctx } = googleCtx([
      { method: 'PUT', match: '/settings/vacation', respond: { status: 200, body: {} } },
      {
        method: 'GET',
        match: '/settings/vacation',
        respond: { status: 200, body: { enableAutoReply: false } },
      },
    ])

    expect(
      await setVacationResponder(ctx, 'jane.doe@example.com', 'Subject', '<p>Body</p>'),
    ).toMatchObject({ ok: false, verified: false })
  })

  it('reports an unreadable read-back as unverified', async () => {
    const { ctx } = googleCtx([
      { method: 'PUT', match: '/settings/vacation', respond: { status: 200, body: {} } },
      { method: 'GET', match: '/settings/vacation', respond: { status: 500, body: {} } },
    ])

    expect(
      await setVacationResponder(ctx, 'jane.doe@example.com', 'Subject', '<p>Body</p>'),
    ).toMatchObject({ ok: false, verified: false, retryable: true })
  })

  it('turns a missing delegation into an outcome that names the remedy', async () => {
    const { ctx } = googleCtx([refuseScopes([GOOGLE_SCOPES.gmailSettingsBasic])])

    const outcome = await setVacationResponder(
      ctx,
      'jane.doe@example.com',
      'Subject',
      '<p>Body</p>',
    )

    expect(outcome).toMatchObject({ ok: false, verified: false, retryable: false })
    expect(outcome.error).toContain('not delegated')
    expect(String(outcome.detail?.remediation)).toContain('Domain-wide delegation')
  })

  it('distinguishes a mailbox that cannot be impersonated from a missing scope', async () => {
    const { ctx } = googleCtx([
      { method: 'POST', match: 'oauth2', respond: { status: 400, body: { error: 'invalid_grant' } } },
    ])

    const outcome = await setVacationResponder(
      ctx,
      'jane.doe@example.com',
      'Subject',
      '<p>Body</p>',
    )

    expect(outcome.error).toContain('could not be impersonated')
    expect(outcome.detail?.oauthError).toBe('invalid_grant')
  })
})

describe('outbound notification', () => {
  it('impersonates the sender mailbox and posts to that mailbox path', async () => {
    const { ctx, http } = googleCtx([
      {
        method: 'POST',
        match: '/messages/send',
        respond: { status: 200, body: { id: 'message-1', threadId: 'thread-1' } },
      },
    ])

    const outcome = await sendMail(ctx, {
      to: ['john.doe@example.com'],
      subject: 'Access suspended',
      body: 'One line.',
    })

    expect(outcome).toMatchObject({ ok: true, verified: true })
    const claims = assertionClaims(http.tokenRequests()[0]!)
    expect(claims.sub).toBe('it.notifications@example.com')
    expect(claims.scope).toBe(GOOGLE_SCOPES.gmailSend)
    expect(http.apiRequests()[0]!.url).toContain(
      `/users/${encodeURIComponent('it.notifications@example.com')}/messages/send`,
    )
  })

  it('blind-copies the configured addresses', async () => {
    const { ctx, http } = googleCtx([
      { method: 'POST', match: '/messages/send', respond: { status: 200, body: { id: 'm' } } },
    ])

    await sendMail(ctx, { to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' })

    const sent = decode((http.apiRequests()[0]!.json as { raw: string }).raw)
    expect(sent).toContain('From: it.notifications@example.com')
    expect(sent).toContain('To: john.doe@example.com')
    expect(sent).toContain('Bcc: it.inbox@example.com')
  })

  it('sends nothing when there is no recipient', async () => {
    const { ctx, http } = googleCtx([])

    expect(await sendMail(ctx, { to: [], subject: 'Subject', body: 'Body' })).toMatchObject({
      ok: false,
    })
    expect(http.requests).toHaveLength(0)
  })

  it('refuses to claim a send that returned no message id', async () => {
    const { ctx } = googleCtx([
      { method: 'POST', match: '/messages/send', respond: { status: 200, body: {} } },
    ])

    expect(
      await sendMail(ctx, { to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' }),
    ).toMatchObject({ ok: false, verified: false, retryable: true })
  })

  it('marks a Google-side fault retryable and a refusal not', async () => {
    const faulty = googleCtx([
      { method: 'POST', match: '/messages/send', respond: { status: 500, body: {} } },
    ])
    const refused = googleCtx([
      { method: 'POST', match: '/messages/send', respond: { status: 403, body: {} } },
    ])
    const message = { to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' }

    expect((await sendMail(faulty.ctx, message)).retryable).toBe(true)
    expect((await sendMail(refused.ctx, message)).retryable).toBe(false)
  })
})

describe('the message itself', () => {
  it('uses network line endings and a plain body', () => {
    const raw = buildMime({
      from: 'it.notifications@example.com',
      to: ['john.doe@example.com'],
      bcc: [],
      subject: 'Access suspended',
      body: 'First line.\nSecond line.',
    })

    const message = decode(raw)
    expect(message).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(message).toContain('First line.\r\nSecond line.')
    expect(message).not.toContain('Bcc:')
    // Headers end with one blank line, or the body becomes a header.
    expect(message).toContain('charset="UTF-8"\r\n\r\nFirst line.')
  })

  it('encodes a subject that is not plain ASCII', () => {
    const raw = buildMime({
      from: 'it.notifications@example.com',
      to: ['john.doe@example.com'],
      bcc: [],
      subject: 'Accès suspendu',
      body: 'Body',
    })

    expect(decode(raw)).toContain('Subject: =?UTF-8?B?')
  })

  it('strips newlines out of a subject, so a header cannot be injected', () => {
    const raw = buildMime({
      from: 'it.notifications@example.com',
      to: ['john.doe@example.com'],
      bcc: [],
      subject: 'Access\r\nBcc: someone.else@example.com',
      body: 'Body',
    })

    const message = decode(raw)
    expect(message).toContain('Subject: Access Bcc: someone.else@example.com')
    expect(message.split('\r\n').filter((line) => line.startsWith('Bcc:'))).toHaveLength(0)
  })
})
