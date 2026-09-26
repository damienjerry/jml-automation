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
import { authorisedRequest, type GoogleCtx } from './auth.ts'
import { GOOGLE_SCOPES } from './scopes.ts'

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
  if (!before.ok) return failure('listing the Google account third-party grants', before.status)
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

  const after = await listTokenClients(ctx, email)
  if (!after.ok) {
    return {
      ok: false,
      verified: false,
      error: `the Google account grants could not be read back after revoking them (status ${after.status})`,
      retryable: true,
    }
  }
  const remaining = after.clients.length
  return {
    ok: remaining === 0,
    verified: remaining === 0,
    ...(remaining === 0 ? {} : { error: `${remaining} third-party grant(s) are still in place after revoking` }),
    detail: { sessionsReset: 'requested', grantsRevoked: before.clients.length - failed, grantsRemaining: remaining },
    ...(remaining === 0 ? {} : { retryable: true }),
  }
}

async function listTokenClients(ctx: GoogleCtx, email: string): Promise<{ ok: boolean; status: number; clients: string[] }> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: `${userUrl(email)}/tokens`,
    scope: GOOGLE_SCOPES.directoryUserSecurity,
    subject: ctx.cfg.adminEmail,
    label: 'google directory list tokens',
  })
  if (!response.ok) return { ok: false, status: response.status, clients: [] }
  const items = response.json<TokenListBody>()?.items ?? []
  const clients = items.map((item) => item.clientId).filter((id): id is string => typeof id === 'string' && id.length > 0)
  return { ok: true, status: response.status, clients }
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
    const page = response.json<DirectoryListBody>() ?? {}
    for (const body of page.users ?? []) users.push(toProviderUser(body))
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
