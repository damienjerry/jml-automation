/**
 * Doubles for the notifier and audit-sink tests.
 *
 * The sinks and notifiers take the narrow `post` slice of the shared HTTP
 * client, so a test can script replies without a network and still assert on
 * what went out: the URL, the authorisation header built from a secret handle,
 * and the exact body.
 */

import type { HttpResponse } from '../../src/core/http.ts'
import type { SecretHandle } from '../../src/config/secrets.ts'

export interface SentRequest {
  url: string
  body: unknown
  headers: Record<string, string>
  label?: string
  retryOn5xx?: boolean
}

export interface ScriptedReply {
  status: number
  /** The raw body, as the client would return it. */
  body: string
  /** Thrown instead of answering, standing in for a timeout. */
  throws?: Error
}

/** A `post` that records every call and answers from `reply`. */
export function poster(
  sent: SentRequest[],
  reply: (request: SentRequest, hit: number) => ScriptedReply,
) {
  return {
    post: async (
      url: string,
      body?: unknown,
      req?: { headers?: Record<string, string>; label?: string; retryOn5xx?: boolean },
    ): Promise<HttpResponse> => {
      const request: SentRequest = {
        url,
        body,
        headers: req?.headers ?? {},
        ...(req?.label ? { label: req.label } : {}),
        ...(req?.retryOn5xx === undefined ? {} : { retryOn5xx: req.retryOn5xx }),
      }
      sent.push(request)
      const scripted = reply(request, sent.length)
      if (scripted.throws) throw scripted.throws
      return response(scripted.status, scripted.body)
    },
  }
}

export function response(status: number, body: string): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {},
    body,
    json<T = unknown>(): T | null {
      try {
        return JSON.parse(body) as T
      } catch {
        return null
      }
    },
    attempts: 1,
  }
}

/** A handle that behaves like a resolved secret: the value is only in `use`. */
export function fakeSecret(value: string, ref = 'env:EXAMPLE_SECRET'): SecretHandle {
  return {
    ref,
    length: value.length,
    use<T>(fn: (v: string) => T): T {
      return fn(value)
    },
    toString: () => '[redacted]',
    toJSON: () => '[redacted]',
  }
}
