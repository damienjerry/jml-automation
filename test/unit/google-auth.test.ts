import { describe, expect, it } from 'vitest'

import { createGoogleAuth, GoogleAuthError, tokenCacheKey } from '../../src/connectors/google/auth.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import {
  assertionClaims,
  assertionHeader,
  fakeHttp,
  fakeSecret,
  grantAllTokens,
  serviceAccountJson,
} from '../fixtures/google/harness.ts'

describe('google delegated tokens', () => {
  it('mints one scope per assertion', async () => {
    const http = fakeHttp([grantAllTokens()])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    await auth.tokenFor(GOOGLE_SCOPES.directoryUser, 'admin@example.com')
    await auth.tokenFor(GOOGLE_SCOPES.licensing, 'admin@example.com')

    const scopes = http.tokenRequests().map((req) => String(assertionClaims(req).scope))
    expect(scopes).toEqual([GOOGLE_SCOPES.directoryUser, GOOGLE_SCOPES.licensing])
    for (const scope of scopes) expect(scope).not.toContain(' ')
  })

  it('signs with RS256 and names the key so a rotated key is recognised', async () => {
    const http = fakeHttp([grantAllTokens()])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    await auth.tokenFor(GOOGLE_SCOPES.gmailSend, 'it.notifications@example.com')

    const [request] = http.tokenRequests()
    expect(assertionHeader(request!)).toMatchObject({ alg: 'RS256', typ: 'JWT' })
    expect(assertionHeader(request!).kid).toBeTruthy()
    const claims = assertionClaims(request!)
    expect(claims.iss).toBe('service.account@example.com')
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token')
    expect(claims.sub).toBe('it.notifications@example.com')
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600)
    expect(request!.form?.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
  })

  it('omits the subject when the service account acts as itself', async () => {
    const http = fakeHttp([grantAllTokens()])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    await auth.tokenFor(GOOGLE_SCOPES.spreadsheetsReadonly, null)

    const claims = assertionClaims(http.tokenRequests()[0]!)
    expect(claims.sub).toBeUndefined()
    expect(claims.scope).toBe(GOOGLE_SCOPES.spreadsheetsReadonly)
  })

  it('caches on scope and subject together, never on the scope alone', async () => {
    const http = fakeHttp([grantAllTokens()])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    await auth.tokenFor(GOOGLE_SCOPES.gmailSettingsBasic, 'jane.doe@example.com')
    await auth.tokenFor(GOOGLE_SCOPES.gmailSettingsBasic, 'jane.doe@example.com')
    expect(http.tokenRequests()).toHaveLength(1)

    await auth.tokenFor(GOOGLE_SCOPES.gmailSettingsBasic, 'john.doe@example.com')
    expect(http.tokenRequests()).toHaveLength(2)
    expect(assertionClaims(http.tokenRequests()[1]!).sub).toBe('john.doe@example.com')
  })

  it('retires a cached token before it expires', async () => {
    let clock = 1_000_000
    const http = fakeHttp([
      {
        method: 'POST',
        match: 'oauth2',
        respond: { status: 200, body: { access_token: 'granted', expires_in: 3600 } },
      },
    ])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http, now: () => clock })

    await auth.tokenFor(GOOGLE_SCOPES.directoryUser, 'admin@example.com')
    clock += 3_560_000 // still inside the hour, but within the skew of expiry
    await auth.tokenFor(GOOGLE_SCOPES.directoryUser, 'admin@example.com')

    expect(http.tokenRequests()).toHaveLength(2)
  })

  it('drops a cached token on request, so a revoked grant is not reused', async () => {
    const http = fakeHttp([grantAllTokens()])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    await auth.tokenFor(GOOGLE_SCOPES.licensing, 'admin@example.com')
    auth.invalidate(GOOGLE_SCOPES.licensing, 'admin@example.com')
    await auth.tokenFor(GOOGLE_SCOPES.licensing, 'admin@example.com')

    expect(http.tokenRequests()).toHaveLength(2)
  })

  it('names the scope and the subject when a grant is missing', async () => {
    const http = fakeHttp([
      {
        method: 'POST',
        match: 'oauth2',
        respond: {
          status: 401,
          body: { error: 'unauthorized_client', error_description: 'not authorised' },
        },
      },
    ])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    const failure = await auth
      .tokenFor(GOOGLE_SCOPES.dataTransfer, 'admin@example.com')
      .catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(GoogleAuthError)
    const err = failure as GoogleAuthError
    expect(err.detail).toMatchObject({
      scope: GOOGLE_SCOPES.dataTransfer,
      subject: 'admin@example.com',
      status: 401,
      error: 'unauthorized_client',
    })
    expect(err.detail.remediation).toContain('Domain-wide delegation')
    // The description can quote the request, so it is deliberately dropped.
    expect(JSON.stringify(err.detail)).not.toContain('not authorised')
  })

  it('reports a probe result rather than throwing', async () => {
    const http = fakeHttp([
      { method: 'POST', match: 'oauth2', respond: { status: 401, body: { error: 'invalid_grant' } } },
    ])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    expect(await auth.probe(GOOGLE_SCOPES.gmailSend, 'it.notifications@example.com')).toEqual({
      ok: false,
      status: 401,
      error: 'invalid_grant',
    })
  })

  it('reports an unreachable token endpoint as not granted rather than failing the table', async () => {
    const http = fakeHttp([
      {
        method: 'POST',
        match: 'oauth2',
        respond: () => {
          // The shared client throws only when there is no response at all.
          throw new Error('connect ECONNREFUSED')
        },
      },
    ])
    const auth = createGoogleAuth(fakeSecret(serviceAccountJson()), { http })

    const result = await auth.probe(GOOGLE_SCOPES.licensing, 'admin@example.com')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(0)
  })

  it('refuses a file that is not a service account key, without quoting it', async () => {
    const http = fakeHttp([grantAllTokens()])
    const auth = createGoogleAuth(fakeSecret('{"nonsense":true}', 'env:EXAMPLE_REF'), { http })

    const failure = await auth
      .tokenFor(GOOGLE_SCOPES.directoryUser, 'admin@example.com')
      .catch((err: unknown) => err)

    expect((failure as Error).message).toContain('env:EXAMPLE_REF')
    expect((failure as Error).message).not.toContain('nonsense')
  })

  it('keys the cache on both halves', () => {
    expect(tokenCacheKey('scope-a', 'jane.doe@example.com')).not.toBe(
      tokenCacheKey('scope-a', 'john.doe@example.com'),
    )
    expect(tokenCacheKey('scope-a', null)).not.toBe(tokenCacheKey('scope-a', 'jane.doe@example.com'))
  })
})
