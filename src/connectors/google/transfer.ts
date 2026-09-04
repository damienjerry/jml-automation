/**
 * Handing the leaver's files to somebody who still works here.
 *
 * Four things about this API catch people out, and all four are handled here.
 *
 * It takes user ids, not addresses, so both people are resolved first. It
 * needs an application id, which is a long numeric string that differs between
 * tenancies, so it is resolved from the applications list rather than
 * hard-coded: a copied id from somebody else's tenancy is accepted and
 * transfers nothing. The transfer is asynchronous, so an accepted insert is
 * not a completed hand-over and only a polled `completed` may be recorded as
 * such. And an insert is not idempotent, so a run that dies between insert and
 * writing the id down would start a second transfer on its next attempt.
 *
 * The caller must persist `transferId`. This module also looks for an existing
 * transfer for the same person before inserting, which covers the case where
 * the id was lost anyway, but that is a second line of defence and not a
 * substitute for storing it.
 */

import type { Outcome } from '../../core/types.ts'
import { authorisedRequest, type GoogleCtx } from './auth.ts'
import { resolveUserId } from './directory.ts'
import { GOOGLE_SCOPES } from './scopes.ts'

const TRANSFER_BASE = 'https://admin.googleapis.com/admin/datatransfer/v1'
const DEFAULT_DRIVE_APPLICATION_NAME = 'Drive and Docs'

/** What the provider says about a transfer. */
export type TransferState = 'inProgress' | 'completed' | 'failed' | 'unknown'

interface ApplicationBody {
  id?: string
  name?: string
}

interface ApplicationListBody {
  applications?: ApplicationBody[]
  nextPageToken?: string
}

interface TransferBody {
  id?: string
  oldOwnerUserId?: string
  newOwnerUserId?: string
  overallTransferStatusCode?: string
  requestTime?: string
}

interface TransferListBody {
  dataTransfers?: TransferBody[]
  nextPageToken?: string
}

/**
 * The Drive application's id in this tenancy.
 *
 * Matched on the application name from the provider's own list. The name is
 * configurable because Google has renamed these before, and an adopter should
 * be able to correct it without a release.
 */
export async function resolveDriveApplicationId(ctx: GoogleCtx): Promise<string | null> {
  const wanted = (ctx.cfg.driveApplicationName ?? DEFAULT_DRIVE_APPLICATION_NAME).toLowerCase()
  let cursor: string | undefined
  let pages = 0

  do {
    const response = await authorisedRequest(ctx, {
      method: 'GET',
      url: `${TRANSFER_BASE}/applications`,
      scope: GOOGLE_SCOPES.dataTransfer,
      subject: ctx.cfg.adminEmail,
      query: { maxResults: 100, ...(cursor ? { pageToken: cursor } : {}) },
      label: 'google transfer applications',
    })
    if (!response.ok) {
      throw new Error(`listing transfer applications failed with status ${response.status}`)
    }
    const page = response.json<ApplicationListBody>() ?? {}
    for (const app of page.applications ?? []) {
      const name = (app.name ?? '').toLowerCase()
      if (name === wanted || name.includes(wanted)) return app.id ?? null
    }
    cursor = page.nextPageToken
    pages += 1
  } while (cursor && pages < 20)

  return null
}

/**
 * An unfinished or finished transfer already recorded for this person.
 *
 * Used before inserting, so an interrupted run resumes rather than starting a
 * second copy of the same hand-over.
 */
export async function findExistingTransfer(
  ctx: GoogleCtx,
  oldOwnerUserId: string,
): Promise<{ transferId: string; state: TransferState } | null> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: `${TRANSFER_BASE}/transfers`,
    scope: GOOGLE_SCOPES.dataTransfer,
    subject: ctx.cfg.adminEmail,
    query: { oldOwnerUserId, maxResults: 20 },
    label: 'google transfer list',
  })
  if (response.status === 404) return null
  if (!response.ok) {
    // Not knowing is not the same as there being none. Inserting on a failed
    // read is how a second transfer starts, so the caller is told to retry.
    throw new Error(`listing existing transfers failed with status ${response.status}`)
  }
  const transfers = response.json<TransferListBody>()?.dataTransfers ?? []
  const usable = transfers.find((t) => {
    const state = toState(t.overallTransferStatusCode)
    return typeof t.id === 'string' && t.id.length > 0 && state !== 'failed'
  })
  if (!usable?.id) return null
  return { transferId: usable.id, state: toState(usable.overallTransferStatusCode) }
}

/**
 * Start, or resume, the hand-over.
 *
 * `verified` is true only when the provider reports the transfer completed,
 * which on a real mailbox is minutes to hours later. An accepted insert is
 * reported as ok with verified false, and the caller polls.
 */
export async function transferDrive(
  ctx: GoogleCtx,
  fromEmail: string,
  toEmail: string,
): Promise<Outcome & { transferId?: string }> {
  const fromId = await resolveUserId(ctx, fromEmail)
  if (!fromId) {
    return {
      ok: false,
      verified: false,
      error: 'the leaver has no Google account, so there is nothing to transfer',
      alreadyAbsent: true,
    }
  }
  const toId = await resolveUserId(ctx, toEmail)
  if (!toId) {
    // Suspending and later deleting the account without a recipient destroys
    // the files. The engine parks the row instead; this must not be a soft
    // "transfer skipped".
    return {
      ok: false,
      verified: false,
      error: 'the hand-over recipient has no Google account, so no transfer was started',
      detail: { recipient: toEmail },
    }
  }

  const existing = await findExistingTransfer(ctx, fromId)
  if (existing) {
    return {
      ok: true,
      verified: existing.state === 'completed',
      transferId: existing.transferId,
      detail: { state: existing.state, reused: true },
    }
  }

  const applicationId = await resolveDriveApplicationId(ctx)
  if (!applicationId) {
    return {
      ok: false,
      verified: false,
      error: 'the Drive application was not found in the data-transfer application list',
      detail: { lookedFor: ctx.cfg.driveApplicationName ?? DEFAULT_DRIVE_APPLICATION_NAME },
    }
  }

  const insert = await authorisedRequest(ctx, {
    method: 'POST',
    url: `${TRANSFER_BASE}/transfers`,
    scope: GOOGLE_SCOPES.dataTransfer,
    subject: ctx.cfg.adminEmail,
    label: 'google transfer insert',
    // Never retried automatically: a repeated insert is a second transfer, and
    // a 5xx after the insert landed is indistinguishable from one before it.
    retryOn5xx: false,
    json: {
      oldOwnerUserId: fromId,
      newOwnerUserId: toId,
      applicationDataTransfers: [
        {
          applicationId,
          applicationTransferParams: [
            { key: 'PRIVACY_LEVEL', value: ctx.cfg.transferPrivacyLevels },
          ],
        },
      ],
    },
  })
  if (!insert.ok) {
    return {
      ok: false,
      verified: false,
      error: `starting the Drive transfer failed with status ${insert.status}`,
      retryable: insert.status === 429 || insert.status >= 500,
    }
  }

  const transferId = insert.json<TransferBody>()?.id
  if (typeof transferId !== 'string' || transferId.length === 0) {
    // Without an id there is nothing to poll and nothing to persist, and a
    // later run would insert again. Reported as a failure on purpose.
    return {
      ok: false,
      verified: false,
      error: 'Google accepted the transfer and returned no transfer id',
      retryable: true,
    }
  }

  const state = await getTransferStatus(ctx, transferId)
  return {
    ok: true,
    verified: state.state === 'completed',
    transferId,
    detail: { state: state.state, applicationId, privacyLevels: ctx.cfg.transferPrivacyLevels },
  }
}

/** Poll one transfer. `done` means it will not change again by itself. */
export async function getTransferStatus(
  ctx: GoogleCtx,
  transferId: string,
): Promise<{ state: TransferState; done: boolean }> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: `${TRANSFER_BASE}/transfers/${encodeURIComponent(transferId)}`,
    scope: GOOGLE_SCOPES.dataTransfer,
    subject: ctx.cfg.adminEmail,
    label: 'google transfer status',
  })
  if (!response.ok) {
    // Unknown is not done. A caller that treats an unreadable transfer as
    // finished would let the deletion gate open on a hand-over that failed.
    return { state: 'unknown', done: false }
  }
  const state = toState(response.json<TransferBody>()?.overallTransferStatusCode)
  return { state, done: state === 'completed' || state === 'failed' }
}

function toState(code: string | undefined): TransferState {
  switch ((code ?? '').toLowerCase()) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'inprogress':
    case 'pending':
      return 'inProgress'
    default:
      return 'unknown'
  }
}
