/**
 * The one HTTP client. Nothing else in the library may reach the network:
 * eslint forbids `fetch` and `node:https` everywhere but this file.
 *
 * That rule exists because of a specific, expensive failure. The automation
 * this replaces used a request helper that threw on any non-2xx and, in
 * throwing, lost the response body and the status code. A provider was
 * answering `401 unauthorized_client` with the exact missing authorisation
 * named in the body, and for hours it was diagnosed as a network fault,
 * because all the caller could see was "request failed".
 *
 * So this client does not throw on a non-2xx. It returns the status and the
 * body, and the caller decides what a 404 or a 401 means. It throws only when
 * there is genuinely no response to return: a timeout, or a transport error
 * that survived the retries.
 */

import { redact } from '../config/redact.ts'

/** How much of a body an error message carries. Enough to read, not to flood. */
const ERROR_BODY_CHARS = 2048

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url: string
  headers?: Record<string, string>
  /** An object is sent as JSON with the header set. A string is sent as-is. */
  body?: string | Record<string, unknown> | unknown[]
  query?: Record<string, string | number | boolean | undefined | null>
  timeoutMs?: number
  maxRetries?: number
  /**
   * Whether a 5xx may be retried. Default true.
   *
   * A retried request must be safe to repeat. Suspending an account twice is
   * harmless; starting a file transfer twice creates two transfers. A caller
   * making a request that is not idempotent turns this off, and the failure
   * surfaces instead of being duplicated.
   */
  retryOn5xx?: boolean
  /** Short name for logs. Never the URL, which can carry a token. */
  label?: string
}

export interface HttpResponse {
  /** True for 2xx only. A 3xx is not success, and fetch has already followed
   * the redirects it is willing to follow. */
  ok: boolean
  status: number
  headers: Record<string, string>
  /** Redacted before it is returned, so a body echoing a key is already safe. */
  body: string
  /** Parsed body, or null when it is not JSON. Never throws. */
  json<T = unknown>(): T | null
  attempts: number
}

export interface HttpErrorDetail {
  url: string
  body?: string
  attempts: number
  retryable: boolean
}

export class HttpError extends Error {
  readonly code = 'http_error'
  readonly status: number
  readonly detail: HttpErrorDetail

  constructor(status: number, message: string, detail: HttpErrorDetail) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.detail = detail
  }
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>
  get(url: string, req?: Partial<HttpRequest>): Promise<HttpResponse>
  post(url: string, body?: HttpRequest['body'], req?: Partial<HttpRequest>): Promise<HttpResponse>
  put(url: string, body?: HttpRequest['body'], req?: Partial<HttpRequest>): Promise<HttpResponse>
  patch(url: string, body?: HttpRequest['body'], req?: Partial<HttpRequest>): Promise<HttpResponse>
  delete(url: string, req?: Partial<HttpRequest>): Promise<HttpResponse>
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface HttpClientOptions {
  timeoutMs?: number
  maxRetries?: number
  /** Ceiling on any single wait, so a hostile Retry-After cannot park a run. */
  maxRetryDelayMs?: number
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Deterministic jitter for tests. */
  random?: () => number
  onRetry?: (info: { label: string; status: number | null; attempt: number; waitMs: number; reason: string }) => void
}

/** Statuses worth trying again. Note what is absent. */
export function retryableStatus(status: number, retryOn5xx: boolean): boolean {
  if (status === 429) return true
  if (status === 408) return true
  // 401 and 403 are deliberately not retried. A credential problem must
  // surface as a credential problem: retrying one turns a clear failure into a
  // slow one, and the run still ends up doing nothing.
  return retryOn5xx && status >= 500 && status <= 599
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const defaultTimeout = options.timeoutMs ?? 30_000
  const defaultRetries = options.maxRetries ?? 3
  const maxDelay = options.maxRetryDelayMs ?? 60_000
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  async function request(req: HttpRequest): Promise<HttpResponse> {
    const url = withQuery(req.url, req.query)
    const label = req.label ?? req.method + ' ' + safeUrl(url)
    const timeoutMs = req.timeoutMs ?? defaultTimeout
    const maxRetries = req.maxRetries ?? defaultRetries
    const retryOn5xx = req.retryOn5xx ?? true

    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) }
    let payload: string | undefined
    if (req.body !== undefined) {
      if (typeof req.body === 'string') {
        payload = req.body
      } else {
        payload = JSON.stringify(req.body)
        headers['content-type'] ??= 'application/json'
      }
    }

    let attempt = 0
    for (;;) {
      attempt += 1
      let response: Response
      try {
        response = await doFetch(url, {
          method: req.method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        // No response at all. Nothing to hand the caller, so this is the one
        // case that throws, and it says whether trying again could help.
        const reason = redact(err instanceof Error ? err.message : String(err))
        if (attempt <= maxRetries) {
          const waitMs = backoff(attempt, maxDelay, random)
          options.onRetry?.({ label, status: null, attempt, waitMs, reason })
          await sleep(waitMs)
          continue
        }
        throw new HttpError(0, label + ' failed with no response after ' + attempt + ' attempts: ' + reason, {
          url: safeUrl(url),
          attempts: attempt,
          retryable: true,
        })
      }

      const body = redact(await readBody(response))
      if (!response.ok && attempt <= maxRetries && retryableStatus(response.status, retryOn5xx)) {
        const waitMs = retryDelay(response, attempt, maxDelay, random)
        options.onRetry?.({ label, status: response.status, attempt, waitMs, reason: 'status ' + response.status })
        await sleep(waitMs)
        continue
      }

      return {
        ok: response.ok,
        status: response.status,
        headers: headerMap(response),
        body,
        attempts: attempt,
        json<T>(): T | null {
          try {
            return JSON.parse(body) as T
          } catch {
            return null
          }
        },
      }
    }
  }

  return {
    request,
    get: (url, req) => request({ ...req, method: 'GET', url }),
    post: (url, body, req) => request({ ...req, method: 'POST', url, body }),
    put: (url, body, req) => request({ ...req, method: 'PUT', url, body }),
    patch: (url, body, req) => request({ ...req, method: 'PATCH', url, body }),
    delete: (url, req) => request({ ...req, method: 'DELETE', url }),
  }
}

/**
 * Turn an unsuccessful response into an error, for a caller that wants one.
 *
 * The body is truncated and already redacted, and the URL has its query string
 * removed: a ping-style credential lives in a query string, and an error
 * message ends up in a log, a ticket and a chat channel.
 *
 * The parameter is the three fields this actually reads rather than a whole
 * HttpResponse, so a caller that has only a status, a body and an attempt
 * count can build the same error. A real response still satisfies it.
 */
export function httpErrorFrom(
  res: Pick<HttpResponse, 'status' | 'body' | 'attempts'>,
  url: string,
  label?: string,
): HttpError {
  const body = res.body.length > ERROR_BODY_CHARS ? res.body.slice(0, ERROR_BODY_CHARS) + '...[truncated]' : res.body
  return new HttpError(res.status, (label ?? 'request') + ' returned ' + res.status + ': ' + body, {
    url: safeUrl(url),
    body,
    attempts: res.attempts,
    retryable: retryableStatus(res.status, true),
  })
}

/** Everything after the `?` is dropped: a URL can itself be a credential. */
export function safeUrl(url: string): string {
  const question = url.indexOf('?')
  const trimmed = question < 0 ? url : url.slice(0, question) + '?[redacted]'
  return redact(trimmed)
}

function withQuery(url: string, query: HttpRequest['query']): string {
  if (!query) return url
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    params.append(k, String(v))
  }
  const qs = params.toString()
  if (qs === '') return url
  return url + (url.includes('?') ? '&' : '?') + qs
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function headerMap(response: Response): Record<string, string> {
  const out: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    // Never carry an authorization echo or a cookie into a returned object
    // that a caller may well log wholesale.
    if (name.toLowerCase() === 'set-cookie' || name.toLowerCase() === 'authorization') return
    out[name.toLowerCase()] = value
  })
  return out
}

/**
 * How long to wait before trying again.
 *
 * `Retry-After` is honoured when the provider sends one, because guessing
 * shorter is what turns a rate limit into a longer rate limit. It is still
 * capped: a header asking for an hour would otherwise hold a scheduled run
 * open past the point anything is watching it.
 */
export function retryDelay(response: Response, attempt: number, maxDelayMs: number, random: () => number): number {
  const header = response.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxDelayMs)
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), maxDelayMs)
  }
  return backoff(attempt, maxDelayMs, random)
}

function backoff(attempt: number, maxDelayMs: number, random: () => number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), maxDelayMs)
  // Jitter, so several retrying callers do not line up on the same instant.
  return Math.round(base * (0.5 + random() * 0.5))
}
