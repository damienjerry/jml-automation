/**
 * The two mail jobs: the leaver's auto-reply, and telling a human what
 * happened.
 *
 * They impersonate different people, and that is the whole difficulty.
 *
 * The auto-reply is a setting inside the leaver's own mailbox. Only a token
 * minted with the leaver as the subject can write it, so the delegation must
 * cover gmail.settings.basic for ordinary staff and not merely for an
 * administrator.
 *
 * Outbound notifications are sent AS the configured sender mailbox, with that
 * mailbox as the delegation subject. This is the least portable part of the
 * whole toolkit and it is worth reading twice: under domain-wide delegation
 * Gmail ignores mailbox delegation for the sending identity. The automation
 * this was ported from minted a token for the administrator and then posted to
 * a shared mailbox path, which worked only because that administrator was
 * effectively that mailbox. "Share the mailbox with the admin" does not make
 * it work. If the address in `mail.senderMailbox` is not a mailbox the service
 * account may impersonate, the send fails, and the fix is either to impersonate
 * the mailbox properly or to send as the administrator's own address.
 */

import type { Outcome } from '../../core/types.ts'
import { authorisedRequest, GoogleAuthError, type GoogleCtx } from './auth.ts'
import { GOOGLE_SCOPES } from './scopes.ts'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1'
/** The mailbox of whoever the token impersonates. */
const SELF_MAILBOX_PATH = 'users/me'

interface VacationBody {
  enableAutoReply?: boolean
  responseSubject?: string
  responseBodyHtml?: string
}

interface SendResultBody {
  id?: string
  threadId?: string
}

/**
 * Set the leaver's holiday responder, then read it back.
 *
 * Without this, mail to a departed colleague is accepted silently and then
 * disappears when the account is deleted, so the sender never learns that
 * nobody read it.
 */
export async function setVacationResponder(
  ctx: GoogleCtx,
  email: string,
  subject: string,
  bodyHtml: string,
): Promise<Outcome> {
  const url = `${GMAIL_BASE}/${SELF_MAILBOX_PATH}/settings/vacation`
  const payload = {
    enableAutoReply: true,
    responseSubject: subject,
    responseBodyHtml: bodyHtml,
    // Anyone who writes to this address should get the reply, including people
    // outside the organisation, who are the ones most likely not to know.
    restrictToContacts: false,
    restrictToDomain: false,
  }

  try {
    const write = await authorisedRequest(ctx, {
      method: 'PUT',
      url,
      scope: GOOGLE_SCOPES.gmailSettingsBasic,
      subject: email,
      json: payload,
      label: 'gmail set vacation',
    })
    if (!write.ok) {
      return {
        ok: false,
        verified: false,
        error: `setting the auto-reply failed with status ${write.status}`,
        retryable: write.status === 429 || write.status >= 500,
      }
    }

    const after = await authorisedRequest(ctx, {
      method: 'GET',
      url,
      scope: GOOGLE_SCOPES.gmailSettingsBasic,
      subject: email,
      label: 'gmail read vacation',
    })
    if (!after.ok) {
      return {
        ok: false,
        verified: false,
        error: `the auto-reply could not be read back (status ${after.status})`,
        retryable: true,
      }
    }
    const enabled = after.json<VacationBody>()?.enableAutoReply === true
    return {
      ok: enabled,
      verified: enabled,
      ...(enabled ? {} : { error: 'Gmail accepted the setting and the auto-reply is still off' }),
      detail: { enableAutoReply: enabled },
    }
  } catch (err) {
    return impersonationOutcome(err, email)
  }
}

/**
 * Send one message as the configured sender mailbox.
 *
 * `verified` is true when Gmail returns the created message id. There is no
 * second read that proves the message was delivered, and this deliberately
 * does not claim one: the id is the provider confirming it accepted and stored
 * the message, nothing more.
 */
export async function sendMail(
  ctx: GoogleCtx,
  opts: { to: string[]; subject: string; body: string },
): Promise<Outcome> {
  const from = ctx.cfg.senderMailbox
  const recipients = opts.to.filter((address) => address.length > 0)
  if (recipients.length === 0) {
    return { ok: false, verified: false, error: 'no recipient was given, so nothing was sent' }
  }

  const raw = buildMime({
    from,
    to: recipients,
    bcc: ctx.cfg.bcc ?? [],
    subject: opts.subject,
    body: opts.body,
  })

  try {
    const response = await authorisedRequest(ctx, {
      method: 'POST',
      url: `${GMAIL_BASE}/users/${encodeURIComponent(from)}/messages/send`,
      scope: GOOGLE_SCOPES.gmailSend,
      // The sender mailbox, not the administrator. See the note at the top.
      subject: from,
      json: { raw },
      label: 'gmail send',
      // A repeated send is a duplicate message in somebody's inbox, so a 5xx
      // is reported rather than tried again.
      retryOn5xx: false,
    })
    if (!response.ok) {
      return {
        ok: false,
        verified: false,
        error: `sending mail failed with status ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
        detail: { from, recipients: recipients.length },
      }
    }
    const messageId = response.json<SendResultBody>()?.id
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return {
        ok: false,
        verified: false,
        error: 'Gmail accepted the message and returned no message id',
        retryable: true,
      }
    }
    return { ok: true, verified: true, detail: { messageId, recipients: recipients.length } }
  } catch (err) {
    return impersonationOutcome(err, from)
  }
}

/**
 * An RFC 5322 message, base64url encoded the way Gmail wants it.
 *
 * Kept deliberately plain: a text body with no attachments needs no MIME
 * multipart, and the fewer moving parts in a message the toolkit sends
 * automatically, the fewer ways it lands in a spam folder.
 */
export function buildMime(msg: {
  from: string
  to: string[]
  bcc: string[]
  subject: string
  body: string
}): string {
  const headers = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(', ')}`,
    ...(msg.bcc.length > 0 ? [`Bcc: ${msg.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ]
  const message = `${headers.join('\r\n')}\r\n\r\n${normaliseBody(msg.body)}`
  return Buffer.from(message, 'utf8').toString('base64url')
}

/**
 * RFC 2047 encode a header only when it needs it.
 *
 * A name with an accent in it is common, and an unencoded one arrives as
 * mojibake in some clients.
 */
function encodeHeader(value: string): string {
  const plain = value.replace(/[\r\n]+/g, ' ').trim()
  if (!/[^\x20-\x7e]/.test(plain)) return plain
  return `=?UTF-8?B?${Buffer.from(plain, 'utf8').toString('base64')}?=`
}

/** Bare newlines in a message body break some receivers. */
function normaliseBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
}

/**
 * Turn a refused impersonation into a leg outcome rather than an exception.
 *
 * The two refusals mean opposite things and want different remediation, so
 * they are separated here rather than reported as one "auth failed". A missing
 * scope is a console change; a mailbox that cannot be impersonated is usually a
 * group or an alias, which has no mailbox to act as at all.
 */
function impersonationOutcome(err: unknown, subject: string): Outcome {
  if (!(err instanceof GoogleAuthError)) throw err
  const oauthError = err.detail.error ?? 'unknown'
  const scopeMissing = oauthError === 'unauthorized_client'
  return {
    ok: false,
    verified: false,
    error: scopeMissing
      ? 'the Gmail scope is not delegated for this service account'
      : `the mailbox could not be impersonated (${oauthError})`,
    retryable: false,
    detail: {
      subject,
      oauthError,
      remediation: err.detail.remediation,
    },
  }
}
