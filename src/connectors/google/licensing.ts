/**
 * Paid seats: find what a person holds, then release it.
 *
 * The order matters. The automation this replaces revoked one hard-coded SKU,
 * so an account holding a second edition kept billing after its owner had
 * left, and nothing reported it. Here the SKUs come from the provider: list
 * what the account actually holds, then revoke each one.
 *
 * The other rule is about emptiness. A licence list that fails must never read
 * as "this person holds no licences", because that is indistinguishable from
 * success and it silently skips the revoke. A failed read throws.
 */

import { listField, objectBody } from './body.ts'
import type { Outcome } from '../../core/types.ts'
import { GateError } from '../types.ts'
import { authorisedRequest, type GoogleCtx } from './auth.ts'
import { GOOGLE_SCOPES } from './scopes.ts'

const LICENSING_BASE = 'https://licensing.googleapis.com/apps/licensing/v1'

export interface LicenceAssignment {
  productId: string
  skuId: string
  skuName?: string | null
}

interface AssignmentBody {
  productId?: string
  skuId?: string
  skuName?: string
  userId?: string
}

interface AssignmentListBody {
  items?: AssignmentBody[]
  nextPageToken?: string
}

/**
 * Everything this account holds, across the configured products.
 *
 * Two paths, because the licensing API has no "list one user's SKUs under a
 * product" call. When config names candidate SKUs, each is checked directly,
 * which is one cheap request per SKU. Otherwise the product's whole assignment
 * list is paged and filtered, which needs the customer id.
 */
export async function listLicences(ctx: GoogleCtx, email: string): Promise<LicenceAssignment[]> {
  const products = ctx.cfg.licenceProductIds
  if (products.length === 0) return []

  const named = ctx.cfg.licenceSkuIds ?? []
  const held: LicenceAssignment[] = []

  for (const productId of products) {
    if (named.length > 0) {
      for (const skuId of named) {
        const found = await getAssignment(ctx, productId, skuId, email)
        if (found) held.push(found)
      }
      continue
    }
    held.push(...(await listProductAssignmentsFor(ctx, productId, email)))
  }
  return held
}

/**
 * Release one seat.
 *
 * A 404 means the seat was already gone, which is what makes a retried run
 * safe. It is reported as already absent rather than as done, so the audit can
 * still answer "did this run release a licence" long after the fact.
 */
export async function revokeLicence(
  ctx: GoogleCtx,
  email: string,
  productId: string,
  skuId: string,
): Promise<Outcome> {
  const write = await authorisedRequest(ctx, {
    method: 'DELETE',
    url: assignmentUrl(productId, skuId, email),
    scope: GOOGLE_SCOPES.licensing,
    subject: ctx.cfg.adminEmail,
    label: 'google licence revoke',
  })

  if (write.status === 404) {
    return {
      ok: true,
      verified: true,
      alreadyAbsent: true,
      detail: { productId, skuId, reason: 'no_such_assignment' },
    }
  }
  if (!write.ok) {
    return {
      ok: false,
      verified: false,
      error: `revoking the licence failed with status ${write.status}`,
      retryable: write.status === 429 || write.status >= 500,
      detail: { productId, skuId },
    }
  }

  // Read back. The delete answering 2xx is the provider accepting the request,
  // which is not the same as the seat being free.
  const after = await getAssignment(ctx, productId, skuId, email)
  if (after) {
    return {
      ok: false,
      verified: false,
      error: 'Google accepted the revoke and the assignment is still present',
      retryable: true,
      detail: { productId, skuId },
    }
  }
  return { ok: true, verified: true, detail: { productId, skuId } }
}

/** One assignment, or null when the account does not hold that SKU. */
/**
 * Assign a licence.
 *
 * 412 from the provider means the seat is already held, which is the desired
 * state and is reported as alreadyAbsent (nothing for us to do) rather than
 * as work done, so the audit can tell the two apart. Read back afterwards: an
 * assignment answering 2xx has been observed to precede a 404 on the same
 * account for around ten seconds.
 */
export async function assignLicence(ctx: GoogleCtx, email: string, productId: string, skuId: string): Promise<Outcome> {
  const write = await authorisedRequest(ctx, {
    method: 'POST',
    url: `${LICENSING_BASE}/product/${encodeURIComponent(productId)}/sku/${encodeURIComponent(skuId)}/user`,
    scope: GOOGLE_SCOPES.licensing,
    subject: ctx.cfg.adminEmail,
    json: { userId: email },
    label: 'google licence assign',
  })
  if (write.status === 412) return { ok: true, verified: true, alreadyAbsent: true, detail: { productId, skuId, reason: 'already_licensed' } }
  if (write.status === 404) return { ok: false, verified: false, error: 'no Google account to license, or no such SKU', retryable: false, detail: { productId, skuId } }
  if (!write.ok) {
    return { ok: false, verified: false, error: `assigning the licence failed with status ${write.status}`, retryable: write.status === 429 || write.status >= 500, detail: { productId, skuId } }
  }
  const after = await getAssignment(ctx, productId, skuId, email)
  return after
    ? { ok: true, verified: true, detail: { productId, skuId } }
    : { ok: false, verified: false, error: 'Google accepted the assignment and it does not read back yet', retryable: true, detail: { productId, skuId } }
}

async function getAssignment(
  ctx: GoogleCtx,
  productId: string,
  skuId: string,
  email: string,
): Promise<LicenceAssignment | null> {
  const response = await authorisedRequest(ctx, {
    method: 'GET',
    url: assignmentUrl(productId, skuId, email),
    scope: GOOGLE_SCOPES.licensing,
    subject: ctx.cfg.adminEmail,
    label: 'google licence read',
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new GateError(
      `reading licence ${productId}/${skuId} failed with status ${response.status}, so it is not known whether a seat is still assigned`,
    )
  }
  const assignment = response.json<AssignmentBody>() ?? {}
  return {
    productId: assignment.productId ?? productId,
    skuId: assignment.skuId ?? skuId,
    skuName: assignment.skuName ?? null,
  }
}

/**
 * Page a product's assignments and keep this account's.
 *
 * The endpoint is customer-wide, so this is the expensive path. It exists
 * because listing what the account holds is the only way to avoid pinning one
 * edition, and an organisation that has not named its SKUs in config should
 * still get every seat released.
 */
async function listProductAssignmentsFor(
  ctx: GoogleCtx,
  productId: string,
  email: string,
): Promise<LicenceAssignment[]> {
  const customerId = ctx.cfg.licensingCustomerId
  if (!customerId) {
    throw new GateError(
      'listing licences needs either google.licenceSkuIds or google.licensingCustomerId; without one of them a held seat cannot be found, and reporting no licences would leave it billing',
    )
  }

  const wanted = email.toLowerCase()
  const held: LicenceAssignment[] = []
  let cursor: string | undefined
  let pages = 0

  do {
    const response = await authorisedRequest(ctx, {
      method: 'GET',
      url: `${LICENSING_BASE}/product/${encodeURIComponent(productId)}/users`,
      scope: GOOGLE_SCOPES.licensing,
      subject: ctx.cfg.adminEmail,
      query: { customerId, maxResults: 100, ...(cursor ? { pageToken: cursor } : {}) },
      label: 'google licence list',
    })
    if (!response.ok) {
      throw new GateError(
        `listing licences for ${productId} failed with status ${response.status}, so a held seat cannot be ruled out`,
      )
    }
    let page: AssignmentListBody
    let items: NonNullable<AssignmentListBody['items']>
    try {
      page = objectBody<AssignmentListBody>(response, `listing licences for ${productId}`)
      items = listField(page, 'items', `listing licences for ${productId}`)
    } catch (err) {
      // Unreadable is not "no seat held": that would record a paid seat as
      // already released.
      throw new GateError(`${err instanceof Error ? err.message : String(err)}, so a held seat cannot be ruled out`)
    }
    for (const item of items) {
      if ((item.userId ?? '').toLowerCase() !== wanted) continue
      held.push({
        productId: item.productId ?? productId,
        skuId: item.skuId ?? '',
        skuName: item.skuName ?? null,
      })
    }
    cursor = page.nextPageToken
    pages += 1
  } while (cursor && pages < 200)

  if (cursor) {
    // Stopping early and returning what was found would report fewer seats
    // than the account holds, and the caller has no way to tell.
    throw new GateError(
      `the licence list for ${productId} did not finish inside the page budget, so the seats this account holds are not known`,
    )
  }
  return held
}

function assignmentUrl(productId: string, skuId: string, email: string): string {
  return `${LICENSING_BASE}/product/${encodeURIComponent(productId)}/sku/${encodeURIComponent(skuId)}/user/${encodeURIComponent(email)}`
}
