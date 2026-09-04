/**
 * The JumpCloud API client: two API generations, one set of habits.
 *
 * Three things here are not obvious and each one cost somebody a day.
 *
 * The base URL. Some organisations answer only on the console host, and the
 * other documented host then returns 404 for every request no matter how
 * valid the key is. That failure looks exactly like a network fault or a dead
 * credential, so the console host is the default and the override exists for
 * organisations whose tenant answers elsewhere. If every call 404s, change
 * this before you rotate anything.
 *
 * Paging. Both generations page with limit and skip, and neither tells you
 * reliably that you have reached the end: the only honest signal is a page
 * shorter than the limit. Code that reads one page and stops looks like it
 * works until the organisation grows past that page, and then it silently
 * misses people. A truncated read is treated as an error rather than as a
 * short list, because "nobody matched" and "we stopped looking" must not be
 * the same value.
 *
 * Id shapes. The two version-2 endpoints this toolkit needs disagree about
 * where the id of an associated object lives: one puts it at the top level,
 * the other nests it under `to`. Reading the wrong one yields null, which is
 * indistinguishable from "nothing is bound" - and "nothing is bound" is the
 * answer that lets a leaver's account be deleted while they still hold the
 * machine. So both shapes are accepted everywhere.
 */

import { retryableStatus } from '../../core/http.ts'

/** The default host. Overridable, see the note above. */
export const JUMPCLOUD_DEFAULT_BASE_URL = 'https://console.jumpcloud.com/api'

/** Vendor page ceiling: a limit above this is rejected by the associations endpoints. */
export const JUMPCLOUD_MAX_PAGE_SIZE = 100

/**
 * The subset of the shared HTTP client this connector uses.
 *
 * Declared structurally, and deliberately narrow, so the connector can be
 * handed the real client from src/core/http.ts or a scripted fake in a test
 * without either knowing about the other. The shape matches that client, so a
 * real one satisfies this port as it stands.
 *
 * The contract that matters: a non-2xx response is returned, never thrown, so
 * the status and the body are both available. Losing a response body to a
 * thrown error is how a missing authorisation once read as a network fault for
 * hours.
 */
export interface HttpLike {
  request(req: HttpRequest): Promise<HttpResponse>
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: Record<string, unknown>
  timeoutMs?: number
  /** Off for a call that must not be repeated. See `fire` in commands.ts. */
  retryOn5xx?: boolean
  maxRetries?: number
  /** Short name for logs. Never the URL, which can carry a filter or a token. */
  label?: string
}

export interface HttpResponse {
  status: number
  /** The body as text, already redacted by the shared client. */
  body: string
  /** Parsed body, or null when it is not JSON. Never throws. */
  json<T = unknown>(): T | null
}

/**
 * A credential that will not print itself.
 *
 * Structural for the same reason as HttpLike: the config package owns the real
 * handle. The value is only ever read inside `use`, so it has no name in this
 * module's scope that a log line or an error could pick up.
 */
export interface SecretLike {
  use<T>(fn: (value: string) => T): T
}

/** A non-2xx response from the provider, with enough detail to act on. */
export class JumpCloudApiError extends Error {
  readonly code = 'jumpcloud_api_error'
  readonly status: number
  /** First few hundred characters only: a body can carry an echoed key. */
  readonly bodyPreview: string
  readonly retryable: boolean
  constructor(message: string, status: number, bodyPreview: string, retryable: boolean) {
    super(message)
    this.status = status
    this.bodyPreview = bodyPreview
    this.retryable = retryable
  }
}

/**
 * A list read stopped before the end.
 *
 * Separate from JumpCloudApiError because the caller must not treat the rows
 * it did receive as the whole answer. Every gate in this toolkit that reads a
 * list is deciding whether something exists, and a partial list can only
 * answer that question in the dangerous direction.
 */
export class JumpCloudTruncated extends Error {
  readonly code = 'jumpcloud_truncated'
  readonly received: number
  constructor(message: string, received: number) {
    super(message)
    this.received = received
  }
}

/**
 * Whether a failed call is worth another attempt.
 *
 * Delegated to the shared client's policy so the connector and the transport
 * cannot disagree: rate limits and server errors yes, a credential refusal no.
 * Retrying a 401 turns a clear failure into a slow one that still does nothing.
 */
export function isRetryableStatus(status: number): boolean {
  return retryableStatus(status, true)
}

/**
 * The id of an associated object, wherever this endpoint happens to put it.
 *
 * See the id-shape note at the top of the file. Returns null only when the
 * element genuinely carries no id, which callers must treat as unreadable
 * rather than as empty.
 */
export function associationId(element: unknown): string | null {
  if (!element || typeof element !== 'object') return null
  const record = element as Record<string, unknown>
  const direct = record['id'] ?? record['_id']
  if (typeof direct === 'string' && direct.length > 0) return direct
  const to = record['to']
  if (to && typeof to === 'object') {
    const nested = (to as Record<string, unknown>)['id'] ?? (to as Record<string, unknown>)['_id']
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

/**
 * Whether an association is a single hop, meaning the object is bound directly
 * rather than through a group.
 *
 * The endpoint reports effective access, so a person in a group that grants a
 * machine appears alongside somebody who actually holds it. Membership of a
 * group is not custody of a laptop, and the two must not be counted together:
 * the gate that blocks a deletion on bound devices would otherwise block for
 * ever on a group binding nobody can clear. When `paths` is absent the
 * association is treated as direct, which is what the endpoint that lists only
 * direct bindings returns.
 */
export function isDirectAssociation(element: unknown): boolean {
  if (!element || typeof element !== 'object') return false
  const paths = (element as Record<string, unknown>)['paths']
  if (!Array.isArray(paths)) return true
  if (paths.length === 0) return true
  return paths.some((path) => Array.isArray(path) && path.length <= 1)
}

export interface JumpCloudClientOptions {
  http: HttpLike
  apiKey: SecretLike
  /** Defaults to the console host. See the note at the top of the file. */
  baseUrl?: string
  timeoutMs?: number
  /** Refuses to page further than this, rather than looping for ever. */
  maxPages?: number
}

export type QueryParams = Record<string, string | number | undefined>

export class JumpCloudClient {
  readonly baseUrl: string
  private readonly http: HttpLike
  private readonly apiKey: SecretLike
  private readonly timeoutMs: number
  private readonly maxPages: number

  constructor(opts: JumpCloudClientOptions) {
    this.http = opts.http
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? JUMPCLOUD_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.maxPages = opts.maxPages ?? 200
  }

  /**
   * One request. Returns the response whatever the status, so a caller can
   * treat 404 as "absent" without catching anything.
   */
  async call(
    method: HttpRequest['method'],
    path: string,
    opts: { query?: QueryParams; body?: Record<string, unknown>; repeatable?: boolean } = {},
  ): Promise<HttpResponse> {
    const url = this.url(path, opts.query)
    // A call that is not safe to repeat is not retried at all: firing a script
    // twice on somebody's machine is not a harmless duplicate.
    const repeatable = opts.repeatable !== false
    // The credential is read here and nowhere else, so it never lives in a
    // variable this module could later interpolate into a message.
    return this.apiKey.use((value) =>
      this.http.request({
        method,
        url,
        headers: {
          'x-api-key': value,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(opts.body === undefined ? {} : { body: opts.body }),
        timeoutMs: this.timeoutMs,
        label: `jumpcloud ${method} ${path}`,
        ...(repeatable ? {} : { retryOn5xx: false, maxRetries: 0 }),
      }),
    )
  }

  /** Like `call`, but a non-2xx becomes a JumpCloudApiError carrying the status. */
  async expectOk(
    method: HttpRequest['method'],
    path: string,
    opts: { query?: QueryParams; body?: Record<string, unknown> } = {},
  ): Promise<HttpResponse> {
    const res = await this.call(method, path, opts)
    if (res.status < 200 || res.status >= 300) {
      throw new JumpCloudApiError(
        `${method} ${path} answered ${res.status}`,
        res.status,
        preview(res),
        isRetryableStatus(res.status),
      )
    }
    return res
  }

  /**
   * Page a version-1 list endpoint, which wraps its rows in `results`.
   *
   * Pages until a page shorter than the limit, which is the only end-of-list
   * signal either generation gives.
   */
  async listV1<T = unknown>(path: string, query: QueryParams = {}, limit = JUMPCLOUD_MAX_PAGE_SIZE): Promise<T[]> {
    return this.page<T>(path, query, limit, (body) => {
      if (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['results'])) {
        return (body as { results: T[] }).results
      }
      if (Array.isArray(body)) return body as T[]
      return null
    })
  }

  /** Page a version-2 list endpoint, which returns a bare array. */
  async listV2<T = unknown>(path: string, query: QueryParams = {}, limit = JUMPCLOUD_MAX_PAGE_SIZE): Promise<T[]> {
    return this.page<T>(path, query, limit, (body) => (Array.isArray(body) ? (body as T[]) : null))
  }

  private async page<T>(
    path: string,
    query: QueryParams,
    limit: number,
    rows: (body: unknown) => T[] | null,
  ): Promise<T[]> {
    const out: T[] = []
    let skip = 0
    for (let pageNo = 0; pageNo < this.maxPages; pageNo += 1) {
      const res = await this.expectOk('GET', path, { query: { ...query, limit, skip } })
      const batch = rows(res.json())
      if (batch === null) {
        throw new JumpCloudTruncated(`GET ${path} returned a body that is not a list`, out.length)
      }
      out.push(...batch)
      // A short page is the end. A full page means there may be more, even
      // when the row count happens to match a total the endpoint reported.
      if (batch.length < limit) return out
      skip += batch.length
    }
    throw new JumpCloudTruncated(
      `GET ${path} did not reach a short page within ${this.maxPages} pages, so the list is partial`,
      out.length,
    )
  }

  private url(path: string, query?: QueryParams): string {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(key, String(value))
    }
    const qs = search.toString()
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`
  }
}

/**
 * A short excerpt of an error body.
 *
 * The shared client has already redacted the body, so this is only about
 * length: a provider error can run to kilobytes and it ends up in an audit row.
 */
export function preview(res: HttpResponse): string {
  return res.body.length > 400 ? `${res.body.slice(0, 400)}...` : res.body
}
