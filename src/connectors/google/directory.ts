/**
 * Google accounts: read one, suspend one, delete one, list them all.
 *
 * Two rules here are the whole file.
 *
 * A missing account is not an error. `getUser` answers null on a 404, because
 * "does this person have a Google account" is a question the leaver engine
 * asks about everybody, and the answer is often no. The automation this
 * replaces inferred Google presence from the identity provider instead, and
 * suspended people who had never had a Google account.
 *
 * Nothing is reported as verified until the account has been read back. The
 * ancestor of this code recorded a successful suspension from a 200 that had
 * changed nothing, so a write is only ever half of a step here.
 */

import type { Outcome } from '../../core/types.ts'
import type { MailboxState, ProviderUser } from '../types.ts'
import { randomBytes } from 'node:crypto'
import { authorisedRequest, type GoogleCtx } from './auth.ts'
import { GOOGLE_SCOPES } from './scopes.ts'
import { listField, objectBody, UnreadableResponse } from './body.ts'

const DIRECTORY_BASE = 'https://admin.googleapis.com/admin/directory/v1'

/** The fields of a directory user this toolkit reads. */
interface DirectoryUserBody {
  id?: string
  primaryEmail?: string
  name?: { fullName?: string }
  suspended?: boolean
  suspensionReason?: string
  archived?: boolean
  orgUnitPath?: string
  aliases?: string[]
  isMailboxSetup?: boolean
  lastLoginTime?: string
  isEnrolledIn2Sv?: boolean
  changePasswordAtNextLogin?: boolean
}

interface DirectoryListBody {
  users?: DirectoryUserBody[]
  nextPageToken?: string
}

/** Read one account. Null means the directory says there is no such account. */
export async function getUser(ctx: GoogleCtx, email: string): Promise<ProviderUser | null> {
  const response = await readUser(ctx, email)
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`reading the Google account failed with status ${response.status}`)
  }
  return toProviderUser(response.json<DirectoryUserBody>() ?? {})
}

/**
 * The account's Google id.
 *
 * The data-transfer API takes ids and not addresses, so this exists to resolve
 * them. It uses the read-only scope, which is the least an adopter has to grant
 * to make a hand-over work.
 */
export async function resolveUserId(ctx: GoogleCtx, email: string): Promise<string | null> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: userUrl(email),
    scope: GOOGLE_SCOPES.directoryUserReadonly,
    subject: ctx.cfg.adminEmail,
    label: 'google directory resolve id',
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`resolving a Google account id failed with status ${response.status}`)
  }
  const id = response.json<DirectoryUserBody>()?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * Suspend an account, then read it back.
 *
 * An absent account is reported as already absent rather than as done, so the
 * audit distinguishes "we suspended this" from "there was nothing to suspend".
 * The leaver engine turns that into a not-applicable leg.
 */
export async function suspendUser(ctx: GoogleCtx, email: string): Promise<Outcome> {
  const write = await authorisedRequest(ctx, {
    method: 'PUT',
    url: userUrl(email),
    scope: GOOGLE_SCOPES.directoryUser,
    subject: ctx.cfg.adminEmail,
    json: { suspended: true },
    label: 'google directory suspend',
  })
  if (write.status === 404) {
    return {
      ok: true,
      verified: true,
      alreadyAbsent: true,
      detail: { reason: 'no_google_account', email },
    }
  }
  if (!write.ok) {
    return failure('suspending the Google account', write.status)
  }

  const after = await readUser(ctx, email)
  if (!after.ok) {
    // The write looked accepted and the read did not agree. That is exactly the
    // case that used to be recorded as a success, so it is reported unverified.
    return {
      ok: false,
      verified: false,
      error: `the Google account could not be read back after suspending it (status ${after.status})`,
      retryable: true,
    }
  }
  const account = after.json<DirectoryUserBody>() ?? {}
  const suspended = account.suspended === true
  return {
    ok: suspended,
    verified: suspended,
    ...(suspended ? {} : { error: 'Google accepted the suspension and the account is still active' }),
    detail: { suspended, suspensionReason: account.suspensionReason ?? null },
  }
}

/** The raw directory record, for the activation reads. Null on a 404; throws on anything else. */
export async function readUserBody(ctx: GoogleCtx, userKey: string): Promise<DirectoryUserBody | null> {
  const response = await readUser(ctx, userKey)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`reading the Google account failed with status ${response.status}`)
  return response.json<DirectoryUserBody>() ?? {}
}

/**
 * Write a password, and optionally require a change at next sign-in, then
 * confirm the change flag from a fresh read.
 *
 * A password cannot be read back. The change flag can, and it is written in the
 * same request, so a flag that reads back set is evidence the write landed.
 */
export async function writePassword(ctx: GoogleCtx, userKey: string, password: string, label: string): Promise<Outcome> {
  const write = await authorisedRequest(ctx, {
    method: 'PUT',
    url: userUrl(userKey),
    scope: GOOGLE_SCOPES.directoryUser,
    subject: ctx.cfg.adminEmail,
    json: { password, changePasswordAtNextLogin: true },
    label,
  })
  if (write.status === 404) return { ok: false, verified: false, error: 'no such account', retryable: false, detail: { reason: 'no_such_account' } }
  if (!write.ok) return failure('setting the Google password', write.status)
  const after = await readUser(ctx, userKey)
  if (!after.ok) {
    return { ok: false, verified: false, error: `the Google account could not be read back after the password was set (status ${after.status})`, retryable: true }
  }
  const flagged = after.json<DirectoryUserBody>()?.changePasswordAtNextLogin === true
  return flagged
    ? { ok: true, verified: true, detail: { changePasswordAtNextLogin: true } }
    : { ok: false, verified: false, error: 'Google accepted the password and the account does not show a pending change', retryable: true }
}

/**
 * Close the account on day 0 when Google is the only account (no identity
 * provider in front of it).
 *
 * The account is not suspended: the day-6 hand-over is proven on an active,
 * unlicensed account, so suspension stays after it, as on the reference
 * route. Instead the password is replaced with a random one nobody holds, a
 * change is required at next sign-in, and every session is ended. The random
 * value exists only inside this call and is never logged or returned.
 */
export async function closeUser(ctx: GoogleCtx, email: string): Promise<Outcome> {
  const locked = await writePassword(ctx, email, randomBytes(24).toString('base64url'), 'google directory close')
  if (!locked.ok) {
    if (locked.detail?.['reason'] === 'no_such_account') {
      return { ok: true, verified: true, alreadyAbsent: true, detail: { reason: 'no_google_account', email } }
    }
    return locked
  }
  const signOut = await authorisedRequest(ctx, {
    method: 'POST',
    url: `${userUrl(email)}/signOut`,
    scope: GOOGLE_SCOPES.directoryUserSecurity,
    subject: ctx.cfg.adminEmail,
    label: 'google directory sign out',
  })
  if (!signOut.ok) {
    return { ...failure('signing the Google account out', signOut.status), detail: { passwordReplaced: true } }
  }
  return { ok: true, verified: true, detail: { passwordReplaced: true, changePasswordAtNextLogin: true, sessionsReset: 'requested' } }
}

interface TokenListBody {
  items?: { clientId?: string }[]
}

/**
 * End every session, revoke every third-party grant, and confirm the grants.
 *
 * Removing the licence takes away Gmail and Drive, but the account stays
 * active until it is suspended, and an active account is still an identity:
 * "Sign in with Google" into another app works, and every token already issued
 * to a third-party app keeps working. Sign-out resets the web and device
 * sessions; the token deletes revoke the grants.
 *
 * Google gives no way to read sessions back, so the sign-out is only ever
 * requested. The grants can be read, so the outcome is verified only when a
 * fresh list after the deletes comes back empty. `detail.sessionsReset` says
 * `requested` to keep the difference visible in the audit log.
 */
export async function signOutUser(ctx: GoogleCtx, email: string): Promise<Outcome> {
  const signOut = await authorisedRequest(ctx, {
    method: 'POST',
    url: `${userUrl(email)}/signOut`,
    scope: GOOGLE_SCOPES.directoryUserSecurity,
    subject: ctx.cfg.adminEmail,
    label: 'google directory sign out',
  })
  if (signOut.status === 404) {
    return { ok: true, verified: true, alreadyAbsent: true, detail: { reason: 'no_google_account', email } }
  }
  if (!signOut.ok) return failure('signing the Google account out', signOut.status)

  const before = await listTokenClients(ctx, email)
  if (!before.ok) return { ok: false, verified: false, error: before.error ?? 'the grants could not be listed', retryable: true }
  let failed = 0
  for (const clientId of before.clients) {
    const del = await authorisedRequest(ctx, {
      method: 'DELETE',
      url: `${userUrl(email)}/tokens/${encodeURIComponent(clientId)}`,
      scope: GOOGLE_SCOPES.directoryUserSecurity,
      subject: ctx.cfg.adminEmail,
      label: 'google directory revoke token',
    })
    // A 404 means the grant went between the list and the delete.
    if (!del.ok && del.status !== 404) failed += 1
  }

  // App passwords sign in to mail and calendar clients without the account
  // password, so they outlive a password change. Revoked with the grants.
  const asps = await listAspIds(ctx, email)
  if (!asps.ok) return { ok: false, verified: false, error: asps.error ?? 'the app passwords could not be listed', retryable: true }
  for (const codeId of asps.ids) {
    const del = await authorisedRequest(ctx, {
      method: 'DELETE',
      url: `${userUrl(email)}/asps/${encodeURIComponent(codeId)}`,
      scope: GOOGLE_SCOPES.directoryUserSecurity,
      subject: ctx.cfg.adminEmail,
      label: 'google directory revoke app password',
    })
    if (!del.ok && del.status !== 404) failed += 1
  }
  const aspsAfter = await listAspIds(ctx, email)

  const after = await listTokenClients(ctx, email)
  if (!after.ok || !aspsAfter.ok) {
    return {
      ok: false,
      verified: false,
      error: `the Google account grants could not be read back after revoking them: ${after.error ?? aspsAfter.error ?? 'unreadable'}`,
      retryable: true,
    }
  }
  const remaining = after.clients.length + aspsAfter.ids.length
  return {
    ok: remaining === 0,
    verified: remaining === 0,
    ...(remaining === 0 ? {} : { error: `${remaining} third-party grant(s) or app password(s) are still in place after revoking` }),
    detail: { sessionsReset: 'requested', grantsRevoked: before.clients.length + asps.ids.length - failed, grantsRemaining: remaining },
    ...(remaining === 0 ? {} : { retryable: true }),
  }
}

async function listAspIds(ctx: GoogleCtx, email: string): Promise<{ ok: boolean; status: number; ids: string[]; error?: string }> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: `${userUrl(email)}/asps`,
    scope: GOOGLE_SCOPES.directoryUserSecurity,
    subject: ctx.cfg.adminEmail,
    label: 'google directory list app passwords',
  })
  if (!response.ok) return { ok: false, status: response.status, ids: [], error: `listing app passwords failed with status ${response.status}` }
  try {
    const items = listField<{ codeId?: number | string }>(objectBody(response, 'listing app passwords'), 'items', 'listing app passwords')
    // An item with no id cannot be revoked or counted, so it is not skipped.
    if (items.some((item) => item.codeId === undefined || item.codeId === null)) throw new UnreadableResponse('listing app passwords returned an entry with no id')
    return { ok: true, status: response.status, ids: items.map((item) => String(item.codeId)) }
  } catch (err) {
    return { ok: false, status: response.status, ids: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function listTokenClients(ctx: GoogleCtx, email: string): Promise<{ ok: boolean; status: number; clients: string[]; error?: string }> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: `${userUrl(email)}/tokens`,
    scope: GOOGLE_SCOPES.directoryUserSecurity,
    subject: ctx.cfg.adminEmail,
    label: 'google directory list tokens',
  })
  if (!response.ok) return { ok: false, status: response.status, clients: [], error: `listing third-party grants failed with status ${response.status}` }
  try {
    const items = listField<{ clientId?: string }>(objectBody<TokenListBody>(response, 'listing third-party grants'), 'items', 'listing third-party grants')
    if (items.some((item) => typeof item.clientId !== 'string' || item.clientId.length === 0)) throw new UnreadableResponse('listing third-party grants returned an entry with no client id')
    return { ok: true, status: response.status, clients: items.map((item) => item.clientId as string) }
  } catch (err) {
    return { ok: false, status: response.status, clients: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Delete an account, then confirm it is gone.
 *
 * A 404 on the delete means somebody or something already removed it, which
 * makes a retried run idempotent. It is recorded as already absent, not as
 * done: an audit that cannot tell those apart cannot answer "did we delete
 * this account" a year later.
 */
export async function deleteUser(ctx: GoogleCtx, email: string): Promise<Outcome> {
  const write = await authorisedRequest(ctx, {
    method: 'DELETE',
    url: userUrl(email),
    scope: GOOGLE_SCOPES.directoryUser,
    subject: ctx.cfg.adminEmail,
    label: 'google directory delete',
  })
  const alreadyGone = write.status === 404
  if (!alreadyGone && !write.ok) {
    return failure('deleting the Google account', write.status)
  }

  const after = await readUser(ctx, email)
  if (after.status === 404) {
    return {
      ok: true,
      verified: true,
      ...(alreadyGone ? { alreadyAbsent: true } : {}),
      detail: { email, alreadyAbsent: alreadyGone },
    }
  }
  if (after.ok) {
    return {
      ok: false,
      verified: false,
      error: 'Google accepted the deletion and the account is still present',
      retryable: true,
    }
  }
  return {
    ok: false,
    verified: false,
    error: `the deletion could not be confirmed (read-back status ${after.status})`,
    retryable: true,
  }
}

/**
 * Every account in the tenancy.
 *
 * Listed by customer, never by a single domain. A domain-scoped list omits
 * every account on a secondary domain without saying so, and the accounts on
 * the older domain of an organisation that has migrated are exactly the ones a
 * leaver sweep must not miss.
 */
export async function listUsers(
  ctx: GoogleCtx,
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<{ users: ProviderUser[]; complete: boolean }> {
  const pageSize = opts.pageSize ?? 200
  const maxPages = opts.maxPages ?? 100
  const users: ProviderUser[] = []
  let cursor: string | undefined
  let pages = 0

  do {
    const response = await authorisedRequest(ctx, {
      method: 'GET',
      url: `${DIRECTORY_BASE}/users`,
      scope: GOOGLE_SCOPES.directoryUser,
      subject: ctx.cfg.adminEmail,
      query: {
        // The Admin SDK literal, so a secondary domain is included.
        customer: ctx.cfg.customer,
        maxResults: pageSize,
        ...(cursor ? { pageToken: cursor } : {}),
      },
      label: 'google directory list',
    })
    if (!response.ok) {
      throw new Error(`listing Google accounts failed with status ${response.status}`)
    }
    const page = objectBody<DirectoryListBody>(response, 'listing Google accounts')
    for (const body of listField<DirectoryUserBody>(page, 'users', 'listing Google accounts')) users.push(toProviderUser(body))
    cursor = page.nextPageToken
    pages += 1
  } while (cursor && pages < maxPages)

  // An exhausted page budget is reported rather than hidden. A truncated list
  // read as a complete one is how a sweep decides an account does not exist.
  return { users, complete: !cursor }
}

function readUser(ctx: GoogleCtx, email: string) {
  return authorisedRequest(ctx, {
    method: 'GET',
    url: userUrl(email),
    scope: GOOGLE_SCOPES.directoryUser,
    subject: ctx.cfg.adminEmail,
    label: 'google directory get',
  })
}

/**
 * The account from the provisioning side.
 *
 * `isMailboxSetup` is the field that matters: an account created through a
 * directory integration exists with no mailbox until it is licensed and
 * Workspace has finished building one. Mail sent before that bounces.
 */
export async function getMailboxState(ctx: GoogleCtx, email: string): Promise<MailboxState | null> {
  const response = await readUser(ctx, email)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`reading the Google account failed with status ${response.status}`)
  const body = response.json<DirectoryUserBody>() ?? {}
  return {
    exists: true,
    mailboxReady: body.isMailboxSetup === true,
    orgUnitPath: body.orgUnitPath ?? null,
    suspended: body.suspended === true,
  }
}

/** Move the account, then read the path back. */
export async function moveToOrgUnit(ctx: GoogleCtx, email: string, orgUnitPath: string): Promise<Outcome> {
  const write = await authorisedRequest(ctx, {
    method: 'PATCH',
    url: userUrl(email),
    scope: GOOGLE_SCOPES.directoryUser,
    subject: ctx.cfg.adminEmail,
    json: { orgUnitPath },
    label: 'google directory org unit move',
  })
  if (write.status === 404) return { ok: false, verified: false, error: 'no Google account to move', retryable: false, detail: { reason: 'no_google_account' } }
  if (!write.ok) return failure('moving the Google account', write.status)
  // Directory reads lag writes by several seconds. One immediate re-read that
  // disagrees is reported unverified so the leg retries next run rather than
  // recording a move that has not landed.
  const after = await readUser(ctx, email)
  if (!after.ok) return { ok: false, verified: false, error: `the Google account could not be read back after the move (status ${after.status})`, retryable: true }
  const landed = (after.json<DirectoryUserBody>() ?? {}).orgUnitPath === orgUnitPath
  return landed
    ? { ok: true, verified: true, detail: { orgUnitPath } }
    : { ok: false, verified: false, error: 'Google accepted the move and the account still reads the old organisational unit', retryable: true, detail: { orgUnitPath } }
}

function userUrl(email: string): string {
  return `${DIRECTORY_BASE}/users/${encodeURIComponent(email)}`
}

function toProviderUser(body: DirectoryUserBody | undefined): ProviderUser {
  return {
    id: body?.id ?? '',
    email: body?.primaryEmail ?? '',
    displayName: body?.name?.fullName ?? null,
    suspended: body?.suspended === true,
    rawState: body?.archived === true ? 'archived' : body?.suspended === true ? 'suspended' : 'active',
  }
}

function failure(what: string, status: number): Outcome {
  return {
    ok: false,
    verified: false,
    error: `${what} failed with status ${status}`,
    // A rate limit or a Google-side fault is worth another run; a refusal or a
    // bad request is not, and retrying it just fills the leg attempt counter.
    retryable: status === 429 || status >= 500,
  }
}
