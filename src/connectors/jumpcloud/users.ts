/**
 * Accounts in the identity provider.
 *
 * The whole point of this file is the order of the lookup. A stored provider id
 * is checked first and then the address on that account is verified against the
 * person we are acting for; only if that fails do we look the address up. Both
 * halves are load-bearing:
 *
 *  - Looking up by address alone once matched a different person during an
 *    offboarding. The HR system renamed a leaver's address on the way out, a
 *    new row inherited the real provider ids, and the automation suspended a
 *    live account.
 *  - Trusting the stored id alone is no better. Ids are copied between rows by
 *    exactly the same accident, so an id is only usable when the account it
 *    points at still carries an address this person owns.
 *
 * More than one match is never resolved by picking the first row. Taking the
 * first result of an address lookup is the specific mistake that wrote to the
 * wrong account, so ambiguity throws and the caller parks the person for a
 * human.
 */

import type { Outcome } from '../../core/types.ts'
import type { ConnectionCheck } from '../../hris/types.ts'
import { AmbiguousMatch, type IdentityConnector, type ProviderUser } from '../types.ts'
import { JumpCloudApiError, isRetryableStatus, preview, type JumpCloudClient } from './client.ts'

/** What kind of key the credential turned out to be. Reported by `jml doctor`. */
export type JumpCloudKeyRole = 'writer' | 'reader' | 'unknown'

export class JumpCloudUsers implements IdentityConnector {
  readonly name = 'jumpcloud'

  private readonly client: JumpCloudClient
  constructor(client: JumpCloudClient) {
    this.client = client
  }

  async findUser(opts: {
    storedId?: string | null
    email: string
    aliases?: string[]
  }): Promise<ProviderUser | null> {
    const owned = new Set(
      [opts.email, ...(opts.aliases ?? [])].filter((a) => typeof a === 'string' && a.length > 0).map(normalise),
    )

    if (opts.storedId) {
      const stored = await this.getById(opts.storedId)
      // A stored id whose account carries an address this person does not own
      // is not evidence about this person. Fall through to the address lookup
      // rather than writing to whatever the id points at.
      if (stored && owned.has(normalise(stored.email))) return stored
    }

    for (const address of owned) {
      const match = await this.findByAddress(address)
      if (match) return match
    }
    return null
  }

  /**
   * Suspend the account, then read it back.
   *
   * The read-back is the whole contract. This endpoint answers 200 for a write
   * it did not fully apply, and a suspension recorded from the response alone
   * is how a leaver's account stayed usable while the record said otherwise.
   *
   * A partial body is safe here, unlike on the command endpoint, because a user
   * record does not reset its unsent fields.
   */
  async suspendUser(id: string): Promise<Outcome> {
    const res = await this.client.call('PUT', `/systemusers/${encodeURIComponent(id)}`, {
      body: { suspended: true },
    })
    if (res.status === 404) {
      return { ok: true, verified: true, alreadyAbsent: true, detail: { reason: 'no_such_account' } }
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        verified: false,
        error: `suspend answered ${res.status}`,
        retryable: isRetryableStatus(res.status),
        detail: { status: res.status, body: preview(res) },
      }
    }

    const after = await this.getById(id)
    if (!after) {
      return {
        ok: false,
        verified: false,
        error: 'suspend accepted but the account could not be read back',
        retryable: true,
      }
    }
    if (!after.suspended) {
      return {
        ok: false,
        verified: false,
        error: 'suspend was accepted and changed nothing',
        retryable: true,
        detail: { readBackState: after.rawState },
      }
    }
    return { ok: true, verified: true, detail: { readBackState: after.rawState } }
  }

  /**
   * Delete the account, then confirm it is gone.
   *
   * A 404 on the delete itself means somebody else got there first, which is
   * the desired state and is recorded as such rather than as work we did.
   */
  async deleteUser(id: string): Promise<Outcome> {
    const res = await this.client.call('DELETE', `/systemusers/${encodeURIComponent(id)}`)
    if (res.status === 404) {
      return { ok: true, verified: true, alreadyAbsent: true, detail: { reason: 'no_such_account' } }
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        verified: false,
        error: `delete answered ${res.status}`,
        retryable: isRetryableStatus(res.status),
        detail: { status: res.status, body: preview(res) },
      }
    }

    const check = await this.client.call('GET', `/systemusers/${encodeURIComponent(id)}`)
    if (check.status === 404) return { ok: true, verified: true }
    if (check.status >= 200 && check.status < 300) {
      return {
        ok: false,
        verified: false,
        error: 'delete was accepted and the account is still readable',
        retryable: true,
      }
    }
    return {
      ok: false,
      verified: false,
      error: `delete could not be confirmed: read-back answered ${check.status}`,
      retryable: true,
    }
  }

  async testConnection(): Promise<ConnectionCheck> {
    const res = await this.client.call('GET', '/systemusers', { query: { limit: 1 } })
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, detail: `read the directory on ${this.client.baseUrl}` }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        detail: `the directory read answered ${res.status} on ${this.client.baseUrl}`,
        remediation: 'Check the API key. A key belonging to a deleted admin answers 401 on every path.',
        docsAnchor: 'credentials#jumpcloud',
      }
    }
    return {
      ok: false,
      detail: `the directory read answered ${res.status} on ${this.client.baseUrl}`,
      remediation:
        'Some organisations answer only on the console host. A 404 on every path is the host being wrong, not the key.',
      docsAnchor: 'credentials#jumpcloud',
    }
  }

  /**
   * Tell a writing key from a read-only one without changing anything.
   *
   * There is no read that reports the key's own role, and guessing it means an
   * adopter discovers halfway through their first armed run that the key cannot
   * suspend. So we address a write at an id that cannot exist: a read-only key
   * is refused before the record is looked for, and a writing key is told there
   * is nothing there. The body carries no fields, so even against a live record
   * this would change nothing.
   */
  async probeKeyRole(): Promise<{ role: JumpCloudKeyRole; detail: string }> {
    const impossibleId = '0'.repeat(24)
    const res = await this.client.call('PUT', `/systemusers/${impossibleId}`, { body: {} })
    if (res.status === 403 || res.status === 401) {
      return { role: 'reader', detail: `a write was refused with ${res.status}: report-only deployments are fine` }
    }
    if (res.status === 404 || res.status === 400) {
      return { role: 'writer', detail: `a write reached the directory and answered ${res.status}` }
    }
    return { role: 'unknown', detail: `the role probe answered ${res.status}` }
  }

  /** Read one account by id. Absent is null; anything else throws. */
  private async getById(id: string): Promise<ProviderUser | null> {
    const res = await this.client.call('GET', `/systemusers/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (res.status < 200 || res.status >= 300) {
      throw new JumpCloudApiError(
        `reading the account answered ${res.status}`,
        res.status,
        preview(res),
        isRetryableStatus(res.status),
      )
    }
    return toProviderUser(res.json())
  }

  /**
   * One address, filtered server-side.
   *
   * The limit is deliberately 2 rather than 1: a limit of 1 hides a second
   * match, and a hidden second match is what makes an ambiguous lookup look
   * like a clean one.
   */
  private async findByAddress(address: string): Promise<ProviderUser | null> {
    // One page on purpose: this is a question about how many accounts match,
    // not a list to walk, and two rows already answer it.
    const res = await this.client.expectOk('GET', '/systemusers', {
      query: { filter: `email:eq:${address}`, limit: 2 },
    })
    const parsed = res.json<{ results?: unknown[] }>()
    const rows = Array.isArray(parsed?.results) ? parsed.results : []
    const users = rows.map(toProviderUser).filter((u): u is ProviderUser => u !== null)
    const distinct = new Map(users.map((u) => [u.id, u]))
    if (distinct.size > 1) {
      throw new AmbiguousMatch(
        `more than one identity provider account matched one address`,
        [...distinct.values()].map((u) => ({ id: u.id, email: u.email })),
      )
    }
    // Destructured rather than indexed: taking the first row of a
    // find-by-address is the mistake this whole file is arranged to prevent,
    // and by here we have already proved there is at most one.
    const [only] = distinct.values()
    return only ?? null
  }
}

function normalise(address: string): string {
  return address.trim().toLowerCase()
}

/** Map a provider record onto the shared shape. Null when it carries no id. */
export function toProviderUser(raw: unknown): ProviderUser | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = record['_id'] ?? record['id']
  const email = record['email']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof email !== 'string') return null
  const state = record['state']
  const displayName = record['displayname'] ?? record['displayName']
  const stateSuspended = typeof state === 'string' ? state.toUpperCase() === 'SUSPENDED' : null
  return {
    id,
    email,
    displayName: typeof displayName === 'string' ? displayName : null,
    // Two fields describe the same thing: the boolean a write sets, and the
    // state string an operator sees in the console. When they disagree the
    // account is reported as not suspended, so a read-back cannot confirm a
    // suspension the console would still show as active.
    suspended: record['suspended'] === true && stateSuspended !== false,
    rawState: typeof state === 'string' ? state : null,
  }
}
