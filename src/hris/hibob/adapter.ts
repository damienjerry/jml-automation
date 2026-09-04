/**
 * The reference HR adapter, against HiBob's People API.
 *
 * SCOPE OF THE CREDENTIAL: read only. Everything this toolkit does with the HR
 * system is `POST /v1/people/search`, including inactive people. It never
 * writes a field, a table or a document back, and no feature is planned that
 * would. The private automation this was extracted from did write custom
 * fields, but that was a separate asset-tracking tool and is not part of this
 * toolkit; do not grant this service user write permission on its behalf.
 *
 * Four rules here exist because the original got them wrong:
 *
 *  - Page until a short page. The original had a `while (hasMore)` loop that
 *    set `hasMore = false` after the first call, so it read one page and
 *    treated everybody past it as absent from the HR system.
 *  - Never parse a locale-formatted date. See `toIsoDate` in fields.ts.
 *  - Build the employed set from a second call with `showInactive: false`,
 *    rather than from a lifecycle status string on each record. A lifecycle
 *    label means different things in different tenants and in different
 *    configurations of the same tenant; absence from the employed set is the
 *    thing the whole leaver path keys on, so it is read directly.
 *  - Refuse a snapshot that is too small. A truncated read looks exactly like
 *    a company where everybody left, and acting on that suspends the staff.
 */

import { Buffer } from 'node:buffer'
import {
  HrisImplausible,
  HrisIncomplete,
  type ConnectionCheck,
  type HrisAdapter,
  type HrisPerson,
  type HrisSnapshot,
} from '../types.ts'
import { readPerson, requestFields, resolveFieldMap, type HiBobFieldMap, type HiBobFieldOverrides } from './fields.ts'

/**
 * The slice of the shared HTTP client this adapter uses.
 *
 * Declared as the narrowest shape that does the job, and satisfied by the
 * client in src/core/http.ts, so a test can hand the adapter a recorded
 * response without building a real client. That client returns a non-2xx
 * response rather than throwing, which is why the status can reach the error
 * message below: a rejected read that surfaces as a bare network error costs
 * hours to diagnose.
 */
export interface HrisHttpRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
  /** Short name for logs. Never the URL, which can carry a credential. */
  label?: string
}

export interface HrisHttpResponse {
  status: number
  /** The parsed body, or null when the response was not JSON. */
  json<T = unknown>(): T | null
  /** The raw body, already redacted by the client. Used for an excerpt only. */
  body?: string
}

export interface HrisHttpClient {
  request(req: HrisHttpRequest): Promise<HrisHttpResponse>
}

/** The read side of a SecretHandle: the value is only visible inside `use`. */
export interface SecretLike {
  use<T>(fn: (value: string) => T): T
}

export interface HiBobAdapterOptions {
  http: HrisHttpClient
  /** The HiBob service user id. A secret, so it arrives as a handle. */
  serviceUserId: SecretLike
  serviceToken: SecretLike
  /** Default `https://api.hibob.com/v1`. */
  baseUrl?: string
  /** Records per request. Also the paging step. */
  pageSize?: number
  /**
   * The smallest believable number of people. No default: an adopter states
   * their own floor, and it should sit well below real headcount so that only
   * a broken read trips it.
   */
  minPlausibleHeadcount: number
  fields?: HiBobFieldOverrides
  /** A stop so a server that ignores paging cannot loop for ever. */
  maxPages?: number
}

const DEFAULT_BASE_URL = 'https://api.hibob.com/v1'
const DEFAULT_PAGE_SIZE = 200
const DEFAULT_MAX_PAGES = 200

export class HiBobAdapter implements HrisAdapter {
  readonly name = 'hibob'

  private readonly http: HrisHttpClient
  private readonly serviceUserId: SecretLike
  private readonly serviceToken: SecretLike
  private readonly baseUrl: string
  private readonly pageSize: number
  private readonly maxPages: number
  private readonly minPlausibleHeadcount: number
  private readonly fields: HiBobFieldMap

  constructor(options: HiBobAdapterOptions) {
    const floor = options.minPlausibleHeadcount
    if (!Number.isInteger(floor) || floor < 1) {
      throw new Error(
        'hris.minPlausibleHeadcount must be a positive whole number. It is the floor below which a snapshot is treated as a broken read rather than as everybody having left.',
      )
    }
    this.http = options.http
    this.serviceUserId = options.serviceUserId
    this.serviceToken = options.serviceToken
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
    this.minPlausibleHeadcount = floor
    this.fields = resolveFieldMap(options.fields)
  }

  async fetchAll(): Promise<HrisSnapshot> {
    const everybody = await this.readAll(true)
    const employed = await this.readAll(false)

    // Both floors are checked, and the employed one matters more: a truncated
    // read of the employed set does not merely hide people, it manufactures
    // leavers out of people who are still here.
    this.assertPlausible(everybody.length, 'the full people read')
    this.assertPlausible(employed.length, 'the employed-only read')

    const activeIds = new Set(employed.map((p) => p.hrisId))

    return {
      all: everybody,
      activeIds,
      fetchedAt: new Date().toISOString(),
      // Every path that could not read all of the pages threw, so a snapshot
      // that exists here was read in full. The flag stays on the type as a
      // second check for a caller that did not write this adapter.
      complete: true,
    }
  }

  async testConnection(): Promise<ConnectionCheck> {
    const docsAnchor = 'docs/credentials.md#hibob'
    let employedOnly: ProbeResult
    try {
      employedOnly = await this.probe(false)
    } catch (error) {
      return {
        ok: false,
        detail: `Could not reach ${this.baseUrl}/people/search: ${messageOf(error)}`,
        remediation: 'Check the base URL and that this machine can reach the HR system.',
        docsAnchor,
      }
    }

    if (!employedOnly.ok) {
      return {
        ok: false,
        detail: `Reading employed people returned HTTP ${employedOnly.status}.`,
        remediation:
          employedOnly.status === 401 || employedOnly.status === 403
            ? 'The service user id or token is wrong, or the service user has no People read permission. This toolkit needs read only.'
            : 'The HR system rejected the people search. Check the field map against the tenant.',
        docsAnchor,
      }
    }

    let everybody: ProbeResult
    try {
      everybody = await this.probe(true)
    } catch (error) {
      // A check that throws is a check nobody can read the result of, so both
      // probes answer rather than propagate.
      return {
        ok: false,
        detail: `Employed people are readable, but the inactive read failed: ${messageOf(error)}`,
        remediation: 'Retry, then check the base URL and the service user permissions.',
        docsAnchor,
      }
    }
    if (!everybody.ok) {
      return {
        ok: false,
        detail: `Employed people are readable, but reading inactive people returned HTTP ${everybody.status}.`,
        remediation:
          'The service user must be allowed to read inactive people. Without them a leaver is missing from the snapshot altogether, so nobody is ever offboarded.',
        docsAnchor,
      }
    }

    const parts = [
      `read people: yes (${employedOnly.count} employed, ${everybody.count} including leavers, first page only)`,
      'this credential is used read only: the toolkit never writes to the HR system',
    ]
    if (everybody.count <= employedOnly.count && everybody.count < this.pageSize) {
      // Not a failure: a young company may genuinely have no leavers. It is
      // said out loud because the alternative explanation, a credential that
      // is filtered to employed people, produces a pipeline that quietly
      // offboards nobody.
      parts.push(
        'no inactive people came back, so either there are none or this credential cannot see them; check one known leaver before arming anything',
      )
    }
    return { ok: true, detail: parts.join('; '), docsAnchor }
  }

  /** Read every page for one value of `showInactive`. */
  private async readAll(showInactive: boolean): Promise<HrisPerson[]> {
    const scope = showInactive ? 'the full people read' : 'the employed-only read'
    const seen = new Set<string>()
    const people: HrisPerson[] = []

    for (let page = 0; page < this.maxPages; page++) {
      const records = await this.search({
        showInactive,
        limit: this.pageSize,
        offset: page * this.pageSize,
      })

      let fresh = 0
      for (const record of records) {
        const person = readPerson(record, this.fields)
        if (seen.has(person.hrisId)) continue
        seen.add(person.hrisId)
        people.push(person)
        fresh++
      }

      // A short page is the end of the data. This is the only condition that
      // finishes the read, because a count is the one thing the response is
      // trusted for.
      if (records.length < this.pageSize) return people

      // A page bigger than the limit means the server ignored the paging
      // parameters and returned the lot, which is a complete read by accident.
      if (records.length > this.pageSize) return people

      if (fresh === 0) {
        throw new HrisIncomplete(
          `${scope} returned the same records again at offset ${page * this.pageSize}, so the HR system is ignoring the paging parameters and there is no way to tell whether more people exist. Raise hris.hibob.pageSize above your headcount.`,
        )
      }
    }

    throw new HrisIncomplete(
      `${scope} did not finish within ${this.maxPages} pages. Refusing a partial snapshot: acting on one would treat everybody past the last page as having left.`,
    )
  }

  private async search(page: { showInactive: boolean; limit: number; offset: number }): Promise<unknown[]> {
    const response = await this.get(page)
    if (response.status < 200 || response.status >= 300) {
      throw new HrisIncomplete(
        `HiBob /people/search returned HTTP ${response.status}: ${excerpt(response.body)}. Refusing to sync from a partial read.`,
      )
    }
    return recordsOf(response.json())
  }

  /** One page, used by the connection check, where a failure is the answer. */
  private async probe(showInactive: boolean): Promise<ProbeResult> {
    const response = await this.get({ showInactive, limit: this.pageSize, offset: 0 })
    const ok = response.status >= 200 && response.status < 300
    let count = 0
    if (ok) {
      try {
        count = recordsOf(response.json()).length
      } catch {
        return { ok: false, status: response.status, count: 0 }
      }
    }
    return { ok, status: response.status, count }
  }

  private async get(page: { showInactive: boolean; limit: number; offset: number }): Promise<HrisHttpResponse> {
    return await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/people/search`,
      label: 'hris.people.search',
      headers: {
        Authorization: this.basicAuth(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: {
        showInactive: page.showInactive,
        limit: page.limit,
        offset: page.offset,
        fields: requestFields(this.fields),
        // `humanReadable` is deliberately absent. Asking for it returns dates
        // formatted for a person, and a date formatted for a person cannot be
        // read back without knowing which locale wrote it.
      },
    })
  }

  /**
   * The Basic header is built for each request and held no longer than the
   * call. It is credential material in its own right, so it is never logged
   * and never put into an error message.
   */
  private basicAuth(): string {
    return this.serviceUserId.use((id) =>
      this.serviceToken.use((pass) => 'Basic ' + Buffer.from(id + ':' + pass).toString('base64')),
    )
  }

  private assertPlausible(received: number, scope: string): void {
    if (received >= this.minPlausibleHeadcount) return
    throw new HrisImplausible(
      `${scope} returned ${received} people, below the stated floor of ${this.minPlausibleHeadcount}. A truncated read looks exactly like a company where everybody left, so nothing is written.`,
      { received, floor: this.minPlausibleHeadcount },
    )
  }
}

interface ProbeResult {
  ok: boolean
  status: number
  count: number
}

function recordsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (body !== null && typeof body === 'object') {
    const employees = (body as Record<string, unknown>)['employees']
    if (Array.isArray(employees)) return employees
  }
  throw new HrisIncomplete(
    'HiBob /people/search did not return an employees array. Refusing to treat an unreadable response as an empty company.',
  )
}

/**
 * A short piece of a response body for an error message.
 *
 * Truncated on purpose: the body of a rejected request can echo what was sent.
 * The client redacts known secret values before handing the body over, and
 * keeping the excerpt short keeps the rest of it out of a log as well.
 */
function excerpt(body: string | undefined): string {
  if (body === undefined) return '(no body)'
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return '(empty body)'
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
