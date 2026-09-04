/**
 * Google domain-wide delegation, one scope at a time.
 *
 * A delegated token is obtained by signing a short-lived assertion with the
 * service account's private key and exchanging it at the OAuth token endpoint.
 * The assertion names the scope it wants and, optionally, the person to act as.
 *
 * The rule that shapes this file: ONE SCOPE PER TOKEN. A bundled multi-scope
 * assertion fails wholesale the moment any single scope in it is not
 * delegated, and the refusal is a bare `unauthorized_client` that names no
 * scope. That is how a partial grant once read as no delegation at all, and
 * days were spent looking for a broken key rather than one missing line in the
 * Admin console. Minting per scope costs one extra request per scope per hour
 * and turns the same failure into "this one scope is missing".
 *
 * The second mode here is the service account acting AS ITSELF, with no
 * subject. Some scopes are refused under delegation in practice, and the
 * working pattern for them is to share the individual resource with the
 * service account's own address. Both modes are the same signing code with and
 * without a `sub` claim, so they cannot drift apart.
 */

import { createSign } from 'node:crypto'

import type { SecretHandle } from '../../config/secrets.ts'
import type { HttpClient, HttpRequest, HttpResponse } from '../../core/http.ts'
import type { GoogleScope, SubjectKind } from './scopes.ts'

/** Everything the connector needs to know about one Google tenancy. */
export interface GoogleConnectorConfig {
  /** The whole service account key file, as one secret. */
  serviceAccountJson: SecretHandle
  /** Delegation subject for directory, licensing and data transfer. */
  adminEmail: string
  /**
   * The mailbox notifications are sent AS.
   *
   * This is impersonated directly, rather than sending as the administrator
   * and hoping mailbox delegation applies. See gmail.ts for why.
   */
  senderMailbox: string
  /** Blind-copied on every notification. Usually the IT inbox. */
  bcc?: string[]
  /**
   * Always the Admin SDK literal, never a single domain: listing by one domain
   * silently omits every user on a secondary domain, and an organisation that
   * has ever migrated has a secondary domain.
   */
  customer: 'my_customer'
  /** Licence products to inspect. Usually one. */
  licenceProductIds: string[]
  /**
   * SKUs to check under each product, when known.
   *
   * Left empty, the connector lists what the user actually holds. Naming SKUs
   * here is a cheaper read, not a way to pin a single edition: the revoke path
   * never assumes one SKU, because an account can hold more than one and a
   * hard-coded edition leaves the others billing.
   */
  licenceSkuIds?: string[]
  /** Customer id or primary domain, needed by the licensing list endpoints. */
  licensingCustomerId?: string
  transferPrivacyLevels: ('PRIVATE' | 'SHARED')[]
  /**
   * How the Drive application is named in the data-transfer application list.
   * Matched case-insensitively; the numeric id is resolved, never hard-coded.
   */
  driveApplicationName?: string
}

/** What every part of this connector is handed. */
export interface GoogleCtx {
  cfg: GoogleConnectorConfig
  http: HttpClient
  auth: GoogleAuth
}

export interface GoogleAuth {
  /**
   * A bearer value for exactly one scope.
   *
   * `subject` is the person to act as, or null for the service account acting
   * as itself. Cached on (scope, subject), because the same run mints for
   * several subjects and a cache keyed on the scope alone would hand one
   * person's token to another.
   */
  tokenFor(scope: GoogleScope, subject: string | null): Promise<string>
  /** Drop a cached entry, so a revoked grant is not retried for an hour. */
  invalidate(scope: GoogleScope, subject: string | null): void
  /**
   * Ask whether a scope is delegated, without calling any API.
   *
   * The token exchange itself is the authorisation check, so this changes
   * nothing in the tenancy and is safe to run against production.
   */
  probe(scope: GoogleScope, subject: string | null): Promise<ScopeProbeResult>
}

export interface ScopeProbeResult {
  ok: boolean
  /** HTTP status from the token endpoint. 200 means the scope is delegated. */
  status: number
  /** The OAuth error code only, for example `unauthorized_client`. */
  error?: string
}

/**
 * A token could not be obtained.
 *
 * Carries the scope and the subject, because those two together are the whole
 * diagnosis, and the remediation names the screen where the grant is made.
 * The body of the failed exchange is never attached verbatim.
 */
export class GoogleAuthError extends Error {
  readonly code = 'google_auth_failed'
  readonly detail: {
    scope: string
    subject: string | null
    status: number
    error?: string
    remediation: string
  }
  constructor(
    message: string,
    detail: {
      scope: string
      subject: string | null
      status: number
      error?: string
      remediation: string
    },
  ) {
    super(message)
    this.detail = detail
  }
}

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
/** Assertions are short-lived. An hour is Google's maximum. */
const ASSERTION_LIFETIME_SECONDS = 3600
/** Retire a cached token early, so a call cannot start on one about to expire. */
const EXPIRY_SKEW_MS = 60_000
const SELF_SUBJECT_CACHE_KEY = '(service account itself)'

/** The non-secret half of a service account key file. */
interface ServiceAccountIdentity {
  clientEmail: string
  tokenUrl: string
  privateKeyId: string | null
}

interface CachedToken {
  value: string
  expiresAtMs: number
}

interface TokenResponseBody {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

export interface GoogleAuthDeps {
  http: HttpClient
  /** Injected so token expiry is testable without waiting an hour. */
  now?: () => number
}

export function createGoogleAuth(
  serviceAccountJson: SecretHandle,
  deps: GoogleAuthDeps,
): GoogleAuth {
  const now = deps.now ?? (() => Date.now())
  const cache = new Map<string, CachedToken>()
  let identity: ServiceAccountIdentity | null = null

  /**
   * Read the addressing fields out of the key file.
   *
   * Only these leave the `use` callback. The private key never does: it is used
   * for signing inside the callback and is not held anywhere afterwards.
   */
  function readIdentity(): ServiceAccountIdentity {
    if (identity) return identity
    identity = serviceAccountJson.use((raw) => parseIdentity(raw, serviceAccountJson.ref))
    return identity
  }

  function mintAssertion(scope: GoogleScope, subject: string | null): string {
    const id = readIdentity()
    const issuedAt = Math.floor(now() / 1000)
    const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' }
    if (id.privateKeyId) header.kid = id.privateKeyId
    const claims: Record<string, string | number> = {
      iss: id.clientEmail,
      // One scope. A space-separated list here is the failure this file exists
      // to prevent, so nothing in this connector ever joins scopes.
      scope,
      aud: id.tokenUrl,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    }
    if (subject) claims.sub = subject
    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
    const signature = serviceAccountJson.use((raw) => {
      const parsed = JSON.parse(raw) as { private_key?: unknown }
      if (typeof parsed.private_key !== 'string') {
        throw new GoogleAuthError('service account key file has no private key', {
          scope,
          subject,
          status: 0,
          remediation: `Check ${serviceAccountJson.ref} holds the whole key file downloaded from Google Cloud.`,
        })
      }
      return createSign('RSA-SHA256').update(signingInput).sign(parsed.private_key, 'base64url')
    })
    return `${signingInput}.${signature}`
  }

  async function exchange(
    scope: GoogleScope,
    subject: string | null,
  ): Promise<{ status: number; body: TokenResponseBody }> {
    const id = readIdentity()
    // The token endpoint takes form encoding and nothing else, so the body is
    // built here and passed as a string rather than as an object the client
    // would serialise as JSON.
    const form = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: mintAssertion(scope, subject),
    })
    const response = await deps.http.request({
      method: 'POST',
      url: id.tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: 20_000,
      // The label never carries the URL or the body: this one goes in logs.
      label: 'google token exchange',
    })
    return { status: response.status, body: response.json<TokenResponseBody>() ?? {} }
  }

  return {
    async tokenFor(scope, subject) {
      const cacheKey = tokenCacheKey(scope, subject)
      const cached = cache.get(cacheKey)
      if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > now()) return cached.value

      const { status, body } = await exchange(scope, subject)
      const granted = body.access_token
      if (status !== 200 || typeof granted !== 'string' || granted.length === 0) {
        throw new GoogleAuthError('Google refused a delegated token', {
          scope,
          subject,
          status,
          ...(body.error ? { error: body.error } : {}),
          remediation: remediationFor(scope, subject),
        })
      }
      const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600
      cache.set(cacheKey, { value: granted, expiresAtMs: now() + lifetime * 1000 })
      return granted
    },

    invalidate(scope, subject) {
      cache.delete(tokenCacheKey(scope, subject))
    },

    async probe(scope, subject) {
      try {
        const { status, body } = await exchange(scope, subject)
        const ok = status === 200 && typeof body.access_token === 'string'
        // Only the OAuth error code is carried forward. `error_description`
        // echoes parts of the request, and a probe report is printed and pasted
        // into issues.
        return ok ? { ok, status } : { ok, status, ...(body.error ? { error: body.error } : {}) }
      } catch (err) {
        // A probe reports; it does not fail a run. A transport error is
        // reported as not ok with status 0 rather than throwing, so one
        // unreachable endpoint does not hide the rest of the table.
        return { ok: false, status: 0, error: errorCode(err) }
      }
    },
  }
}

/** Cache key. Never the scope alone: subjects share scopes. */
export function tokenCacheKey(scope: string, subject: string | null): string {
  return `${scope} ${subject ?? SELF_SUBJECT_CACHE_KEY}`
}

/** Which address a given kind of subject resolves to. */
export function subjectFor(
  kind: SubjectKind,
  cfg: Pick<GoogleConnectorConfig, 'adminEmail' | 'senderMailbox'>,
  leaverEmail?: string,
): string | null {
  switch (kind) {
    case 'admin':
      return cfg.adminEmail
    case 'sender':
      return cfg.senderMailbox
    case 'leaver':
      if (!leaverEmail) throw new Error('a leaver-subject token needs the leaver address')
      return leaverEmail
    case 'self':
      return null
  }
}

/**
 * Make one authorised call.
 *
 * Every request in this connector goes through here, so the scope and the
 * subject are visible at the call site and no request can accidentally reuse a
 * token minted for somebody else.
 */
export async function authorisedRequest(
  ctx: GoogleCtx,
  opts: {
    method: HttpRequest['method']
    url: string
    scope: GoogleScope
    subject: string | null
    query?: HttpRequest['query']
    json?: HttpRequest['body']
    label?: string
    /**
     * False for a request that must not be repeated. Starting a file transfer
     * twice creates two transfers, and a retried 5xx is indistinguishable from
     * a first attempt at the far end.
     */
    retryOn5xx?: boolean
  },
): Promise<HttpResponse> {
  const bearer = await ctx.auth.tokenFor(opts.scope, opts.subject)
  return ctx.http.request({
    method: opts.method,
    url: opts.url,
    headers: { authorization: 'Bearer ' + bearer },
    ...(opts.query === undefined ? {} : { query: opts.query }),
    ...(opts.json === undefined ? {} : { body: opts.json }),
    ...(opts.retryOn5xx === undefined ? {} : { retryOn5xx: opts.retryOn5xx }),
    label: opts.label ?? 'google api call',
  })
}

function parseIdentity(raw: string, ref: string): ServiceAccountIdentity {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // The message names the reference, not the content: a malformed key file
    // pasted into an error is a key file in a log.
    throw new Error(`${ref} is not valid JSON, so it is not a service account key file`)
  }
  const clientEmail = parsed.client_email
  if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
    throw new Error(`${ref} has no client_email, so it is not a service account key file`)
  }
  const tokenUrl = typeof parsed.token_uri === 'string' ? parsed.token_uri : DEFAULT_TOKEN_URL
  const keyId = parsed.private_key_id
  return {
    clientEmail,
    tokenUrl,
    privateKeyId: typeof keyId === 'string' && keyId.length > 0 ? keyId : null,
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function errorCode(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown_error'
}

/**
 * What to do about a refusal.
 *
 * Delegation is granted per scope string against the service account's client
 * id, and the subject must be a real mailbox in the domain, so both halves get
 * named.
 */
function remediationFor(scope: string, subject: string | null): string {
  const where =
    'Google Admin > Security > Access and data control > API controls > Domain-wide delegation'
  if (subject === null) {
    return `This scope is requested with the service account acting as itself, so delegation does not apply. Share the resource with the service account address instead, and confirm the API is enabled on the Cloud project. Scope: ${scope}`
  }
  return `Add the scope to the service account client id in ${where}, exactly as written, then retry. Confirm the subject is a real mailbox that can be impersonated. Scope: ${scope}`
}
