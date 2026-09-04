/**
 * Test harness for the Google connector.
 *
 * Nothing here reaches the network. The service account key is an RSA keypair
 * generated in memory when the first test asks for one, so no key material is
 * ever committed and the signing path is still exercised for real.
 */

import { generateKeyPairSync } from 'node:crypto'

import {
  createGoogleAuth,
  type GoogleConnectorConfig,
  type GoogleCtx,
} from '../../../src/connectors/google/auth.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/core/http.ts'

/**
 * One recorded call.
 *
 * The fields mirror the shared HttpRequest, with `query` kept separate the way
 * the client takes it so a test can assert on a parameter without parsing a
 * URL.
 */
export interface FakeRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  timeoutMs?: number
  retryOn5xx?: boolean
  label?: string
  /** The parsed JSON body, for a test asserting what was sent. */
  json?: unknown
  /** The parsed form body of a token exchange. */
  form?: Record<string, string>
}

/** What a rule answers with. Turned into the shared HttpResponse shape. */
export interface FakeResponse<T = unknown> {
  status: number
  body: T
}

export interface Rule {
  method?: string
  /** Substring, pattern, or predicate over the URL. */
  match: string | RegExp | ((url: string) => boolean)
  /** One response, a queue consumed in order (the last repeats), or a function. */
  respond:
    | FakeResponse
    | FakeResponse[]
    | ((req: FakeRequest, hit: number) => FakeResponse | Promise<FakeResponse>)
}

let cachedKeyPair: { privateKey: string } | null = null

function keyPair(): { privateKey: string } {
  if (!cachedKeyPair) {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    cachedKeyPair = { privateKey }
  }
  return cachedKeyPair
}

/** A service account key file, built at runtime so nothing is stored. */
export function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  const pair = keyPair()
  return JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: 'aaaaaaaaaaaa',
    client_email: 'service.account@example.com',
    client_id: '000000000000000000001',
    token_uri: 'https://oauth2.googleapis.com/token',
    private_key: pair.privateKey,
    ...overrides,
  })
}

/** The smallest thing that satisfies the SecretHandle contract. */
export function fakeSecret(value: string, ref = 'env:GOOGLE_SERVICE_ACCOUNT_JSON') {
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

export interface FakeHttp extends HttpClient {
  requests: FakeRequest[]
  tokenRequests(): FakeRequest[]
  apiRequests(): FakeRequest[]
}

/**
 * A fake of the shared HTTP client.
 *
 * It answers from rules and records what it was asked, and it never throws on
 * a non-2xx, because that is the contract the real client keeps.
 */
export function fakeHttp(rules: Rule[]): FakeHttp {
  const requests: FakeRequest[] = []
  const hits = new Map<Rule, number>()

  async function request(req: HttpRequest): Promise<HttpResponse> {
    const recorded: FakeRequest = {
      ...req,
      ...(typeof req.body === 'string'
        ? { form: Object.fromEntries(new URLSearchParams(req.body)) }
        : req.body === undefined
          ? {}
          : { json: req.body }),
    }
    requests.push(recorded)

    for (const rule of rules) {
      if (rule.method && rule.method !== req.method) continue
      if (!urlMatches(rule.match, urlWithQuery(req))) continue
      const hit = (hits.get(rule) ?? 0) + 1
      hits.set(rule, hit)
      const answer =
        typeof rule.respond === 'function'
          ? await rule.respond(recorded, hit)
          : Array.isArray(rule.respond)
            ? (rule.respond[Math.min(hit - 1, rule.respond.length - 1)] as FakeResponse)
            : rule.respond
      return toHttpResponse(answer)
    }
    throw new Error(`no fake rule for ${req.method} ${urlWithQuery(req)}`)
  }

  return {
    requests,
    tokenRequests: () => requests.filter((r) => r.url.includes('oauth2.googleapis.com')),
    apiRequests: () => requests.filter((r) => !r.url.includes('oauth2.googleapis.com')),
    request,
    get: (url, req) => request({ ...req, method: 'GET', url }),
    post: (url, body, req) => request({ ...req, method: 'POST', url, body }),
    put: (url, body, req) => request({ ...req, method: 'PUT', url, body }),
    patch: (url, body, req) => request({ ...req, method: 'PATCH', url, body }),
    delete: (url, req) => request({ ...req, method: 'DELETE', url }),
  }
}

function toHttpResponse(answer: FakeResponse): HttpResponse {
  const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? null)
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    headers: {},
    body: text,
    attempts: 1,
    json<T>(): T | null {
      try {
        return JSON.parse(text) as T
      } catch {
        return null
      }
    },
  }
}

/** The URL a rule matches against, query string included. */
export function urlWithQuery(req: { url: string; query?: HttpRequest['query'] }): string {
  if (!req.query) return req.url
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(req.query)) {
    if (value !== undefined && value !== null) params.set(name, String(value))
  }
  const query = params.toString()
  return query ? `${req.url}?${query}` : req.url
}

function urlMatches(match: Rule['match'], url: string): boolean {
  if (typeof match === 'function') return match(url)
  if (match instanceof RegExp) return match.test(url)
  return url.includes(match)
}

/** Grants a token for every scope asked for. */
export function grantAllTokens(): Rule {
  return {
    method: 'POST',
    match: 'oauth2.googleapis.com',
    respond: () => ({
      status: 200,
      body: { access_token: 'fake-granted-value', expires_in: 3600 },
    }),
  }
}

/** Refuses tokens for the named scopes and grants the rest. */
export function refuseScopes(refused: string[]): Rule {
  return {
    method: 'POST',
    match: 'oauth2.googleapis.com',
    respond: (req) => {
      const scope = assertionClaims(req).scope as string
      if (refused.includes(scope)) {
        return { status: 401, body: { error: 'unauthorized_client' } }
      }
      return { status: 200, body: { access_token: 'fake-granted-value', expires_in: 3600 } }
    },
  }
}

/** Decode the claims of a token request's assertion, for assertions in tests. */
export function assertionClaims(req: FakeRequest): Record<string, unknown> {
  const assertion = req.form?.assertion
  if (!assertion) throw new Error('that request carried no assertion')
  const parts = assertion.split('.')
  if (parts.length !== 3) throw new Error('that assertion is not a three-part JWT')
  return JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'))
}

export function assertionHeader(req: FakeRequest): Record<string, unknown> {
  const assertion = req.form?.assertion as string
  const parts = assertion.split('.')
  return JSON.parse(Buffer.from(parts[0] as string, 'base64url').toString('utf8'))
}

/** Every scope requested, in order, one entry per token request. */
export function requestedScopes(http: FakeHttp): string[] {
  return http.tokenRequests().map((req) => String(assertionClaims(req).scope))
}

/** A configuration with placeholder addresses only. */
export function testConfig(overrides: Partial<GoogleConnectorConfig> = {}): GoogleConnectorConfig {
  return {
    serviceAccountJson: fakeSecret(serviceAccountJson()),
    adminEmail: 'admin@example.com',
    senderMailbox: 'it.notifications@example.com',
    bcc: ['it.inbox@example.com'],
    customer: 'my_customer',
    licenceProductIds: ['Google-Apps'],
    transferPrivacyLevels: ['PRIVATE', 'SHARED'],
    ...overrides,
  }
}

/** A directory user body, as the Admin SDK returns it. */
export function directoryUser(overrides: Record<string, unknown> = {}) {
  return {
    id: '100000000000000000001',
    primaryEmail: 'jane.doe@example.com',
    name: { fullName: 'Jane Doe' },
    suspended: false,
    orgUnitPath: '/',
    aliases: [],
    ...overrides,
  }
}

/**
 * A connector context wired to a fake transport.
 *
 * A blanket token grant is appended behind the caller's rules, so a test that
 * only cares about an API call need not describe the OAuth exchange, while a
 * test about a refused scope can pass its own token rule and have it win.
 */
export function googleCtx(rules: Rule[], cfgOverrides: Partial<GoogleConnectorConfig> = {}) {
  const cfg = testConfig(cfgOverrides)
  const http = fakeHttp([...rules, grantAllTokens()])
  const auth = createGoogleAuth(cfg.serviceAccountJson, { http })
  const ctx: GoogleCtx = { cfg, http, auth }
  return { cfg, http, auth, ctx }
}
