/**
 * Test doubles for the HR adapter: a recording HTTP client and a fake secret.
 *
 * Shared rather than copied so a regression test and a unit test cannot
 * disagree about how the HR system is supposed to behave.
 */

import type {
  HrisHttpClient,
  HrisHttpRequest,
  HrisHttpResponse,
  SecretLike,
} from '../../src/hris/hibob/adapter.ts'

export interface FakeResponse {
  status: number
  /** The parsed body the client would hand over. */
  body: unknown
}

export type FakeHandler = (req: HrisHttpRequest, callIndex: number) => FakeResponse | Promise<FakeResponse>

/**
 * Wrap a parsed body the way the real client does: a redacted string plus a
 * `json()` accessor that returns null rather than throwing.
 */
function asResponse(fake: FakeResponse): HrisHttpResponse {
  const text = typeof fake.body === 'string' ? fake.body : JSON.stringify(fake.body)
  return {
    status: fake.status,
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

export class FakeHttp implements HrisHttpClient {
  readonly requests: HrisHttpRequest[] = []

  constructor(private readonly handler: FakeHandler) {}

  async request(req: HrisHttpRequest): Promise<HrisHttpResponse> {
    const index = this.requests.length
    this.requests.push(req)
    return asResponse(await this.handler(req, index))
  }

  /** The parsed body of one request, for asserting what was actually sent. */
  bodyOf(index: number): Record<string, unknown> {
    const req = this.requests[index]
    if (!req || req.body === null || typeof req.body !== 'object') {
      throw new Error(`request ${index} had no object body`)
    }
    return req.body as Record<string, unknown>
  }
}

export interface PagingOptions {
  /** Records returned when showInactive is true. */
  all: unknown[]
  /** Records returned when showInactive is false. */
  employed: unknown[]
  /** Ignore the offset, as a server without paging support would. */
  ignoreOffset?: boolean
  /** Ignore the limit and return everything on the first call. */
  ignoreLimit?: boolean
}

/**
 * A server that really pages, so the adapter's stop condition is exercised
 * rather than asserted.
 */
export function pagingHttp(options: PagingOptions): FakeHttp {
  return new FakeHttp((req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const source = body['showInactive'] === true ? options.all : options.employed
    const limit = typeof body['limit'] === 'number' ? body['limit'] : source.length
    const offset = options.ignoreOffset ? 0 : typeof body['offset'] === 'number' ? body['offset'] : 0
    const page = options.ignoreLimit ? source : source.slice(offset, offset + limit)
    return { status: 200, body: { employees: page } }
  })
}

/** A stand-in for SecretHandle: the value is only readable inside `use`. */
export function fakeSecret(value: string): SecretLike {
  return {
    use<T>(fn: (raw: string) => T): T {
      return fn(value)
    },
  }
}
