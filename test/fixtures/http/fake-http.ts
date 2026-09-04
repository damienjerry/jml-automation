/**
 * A scripted HTTP client for connector tests.
 *
 * Routes are matched in the order they were added, so a test can put a
 * specific case in front of a general one. Every request is recorded, which is
 * how the tests assert on things a return value cannot show: that a trigger
 * body never carries a systems array, that a command definition is never
 * written to, and that a detach really was attempted.
 */

import type {
  HttpLike,
  HttpRequest,
  HttpResponse,
  SecretLike,
} from '../../../src/connectors/jumpcloud/client.ts'

export interface Route {
  method: HttpRequest['method']
  /** Matched against the path and query of the request URL. */
  match: string | RegExp
  /** Either a fixed reply, or a function of the request and the call count. */
  reply: Reply | ((req: HttpRequest, hit: number) => Reply)
}

export interface Reply {
  status: number
  /** The parsed body the real client would hand over. */
  body?: unknown
  /** Raw text, for a body that is not JSON. */
  text?: string
  /** Thrown instead of answering, standing in for a transport failure. */
  throws?: Error
}

/**
 * Wrap a parsed body the way the shared client does: text plus a `json()`
 * accessor that returns null rather than throwing.
 */
function asResponse(reply: Reply): HttpResponse {
  const text = reply.text ?? (reply.body === undefined || reply.body === null ? '' : JSON.stringify(reply.body))
  return {
    status: reply.status,
    body: text,
    json<T>(): T | null {
      try {
        return JSON.parse(text) as T
      } catch {
        return null
      }
    },
  }
}

export class FakeHttp implements HttpLike {
  readonly requests: HttpRequest[] = []
  private readonly routes: (Route & { hits: number })[] = []

  on(method: HttpRequest['method'], match: string | RegExp, reply: Route['reply']): this {
    this.routes.push({ method, match, reply, hits: 0 })
    return this
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req)
    const target = pathAndQuery(req.url)
    for (const route of this.routes) {
      if (route.method !== req.method) continue
      const hit = typeof route.match === 'string' ? target.startsWith(route.match) : route.match.test(target)
      if (!hit) continue
      route.hits += 1
      const reply = typeof route.reply === 'function' ? route.reply(req, route.hits) : route.reply
      if (reply.throws) throw reply.throws
      return asResponse(reply)
    }
    throw new Error(`no fake route for ${req.method} ${target}`)
  }

  /** Requests whose path and query contain this fragment. */
  sent(fragment: string): HttpRequest[] {
    return this.requests.filter((r) => pathAndQuery(r.url).includes(fragment))
  }

  count(method: HttpRequest['method'], fragment: string): number {
    return this.requests.filter((r) => r.method === method && pathAndQuery(r.url).includes(fragment)).length
  }
}

function pathAndQuery(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

/** A credential handle that behaves like the real one: it will not print itself. */
export function fakeSecret(value = 'test-key-value'): SecretLike & { toString(): string; toJSON(): string } {
  return {
    use<T>(fn: (v: string) => T): T {
      return fn(value)
    },
    toString: () => '[redacted]',
    toJSON: () => '[redacted]',
  }
}

/**
 * A clock and a sleep that move together.
 *
 * The command primitive holds an association for two minutes by default, so a
 * test that used a real timer would take two minutes or would have to lower the
 * hold below the value the code is meant to enforce.
 */
export function fakeTime(startMs = Date.parse('2026-01-05T09:00:00.000Z')) {
  let nowMs = startMs
  const slept: number[] = []
  return {
    slept,
    now: () => nowMs,
    sleep: async (ms: number) => {
      slept.push(ms)
      nowMs += ms
    },
    advance: (ms: number) => {
      nowMs += ms
    },
    /** Total time the caller waited, which is what a hold has to satisfy. */
    total: () => slept.reduce((a, b) => a + b, 0),
  }
}
