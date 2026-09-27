/**
 * Signing a leaver out of Google.
 *
 * The licence goes on day 0 and the account stays active until day 6, so the
 * account is still an identity: Sign in with Google into other apps works,
 * and grants already given to third-party apps keep working. This step ends
 * the sessions and revokes the grants. Sessions cannot be read back, so what
 * is verified is the grants, by a fresh list after the deletes.
 */
import { describe, expect, it } from 'vitest'
import { createGoogleConnector } from '../../src/connectors/google/index.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import { fakeHttp, grantAllTokens, refuseScopes, requestedScopes, testConfig, type Rule } from '../fixtures/google/harness.ts'

const EMAIL = 'jane.doe@example.com'

function connectorWith(rules: Rule[], tokens: Rule = grantAllTokens()) {
  const http = fakeHttp([...rules, tokens])
  return { connector: createGoogleConnector(testConfig(), { http }), http }
}

const signOutOk: Rule = { method: 'POST', match: '/signOut', respond: { status: 204, body: null } }
const revokeOk: Rule = { method: 'DELETE', match: '/tokens/', respond: { status: 204, body: null } }
function aspLists(...lists: number[][]): Rule {
  return { method: 'GET', match: /\/asps$/, respond: lists.map((ids) => ({ status: 200, body: { items: ids.map((codeId) => ({ codeId })) } })) }
}
const noAsps = aspLists([], [])
const aspRevokeOk: Rule = { method: 'DELETE', match: '/asps/', respond: { status: 204, body: null } }
function tokenLists(...lists: string[][]): Rule {
  return { method: 'GET', match: /\/tokens$/, respond: lists.map((ids) => ({ status: 200, body: { items: ids.map((clientId) => ({ clientId })) } })) }
}

describe('signing a Google account out', () => {
  it('signs out, revokes every grant, and is verified only once none remain', async () => {
    const { connector, http } = connectorWith([signOutOk, revokeOk, noAsps, tokenLists(['app-one', 'app-two'], [])])
    const outcome = await connector.signOutUser(EMAIL)

    expect(outcome).toMatchObject({ ok: true, verified: true, detail: { sessionsReset: 'requested', grantsRevoked: 2, grantsRemaining: 0 } })
    const deletes = http.requests.filter((r) => r.method === 'DELETE').map((r) => r.url)
    expect(deletes).toHaveLength(2)
    expect(deletes[0]).toContain('/tokens/app-one')
    expect(new Set(requestedScopes(http))).toEqual(new Set([GOOGLE_SCOPES.directoryUserSecurity]))
  })

  it('is not verified while a grant is still there after revoking', async () => {
    const { connector } = connectorWith([signOutOk, revokeOk, noAsps, tokenLists(['app-one'], ['app-one'])])
    const outcome = await connector.signOutUser(EMAIL)
    expect(outcome.ok).toBe(false)
    expect(outcome.verified).toBe(false)
    expect(outcome.error).toMatch(/1 third-party grant/)
  })

  it('is not verified when the grants cannot be read back', async () => {
    const { connector } = connectorWith([signOutOk, revokeOk, noAsps, { method: 'GET', match: /\/tokens$/, respond: [{ status: 200, body: { items: [] } }, { status: 500, body: null }] }])
    const outcome = await connector.signOutUser(EMAIL)
    expect(outcome).toMatchObject({ ok: false, verified: false, retryable: true })
  })

  it('revokes app passwords too, and counts one left behind as not done', async () => {
    const good = connectorWith([signOutOk, revokeOk, aspRevokeOk, aspLists([11, 12], []), tokenLists([], [])])
    expect(await good.connector.signOutUser(EMAIL)).toMatchObject({ ok: true, verified: true, detail: { grantsRevoked: 2 } })
    expect(good.http.requests.filter((r) => r.method === 'DELETE' && r.url.includes('/asps/'))).toHaveLength(2)

    const stuck = connectorWith([signOutOk, revokeOk, aspRevokeOk, aspLists([11], [11]), tokenLists([], [])])
    expect(await stuck.connector.signOutUser(EMAIL)).toMatchObject({ ok: false, verified: false })
  })

  it('fails without touching the grants when the sign-out is refused', async () => {
    const { connector, http } = connectorWith([{ method: 'POST', match: '/signOut', respond: { status: 403, body: null } }])
    const outcome = await connector.signOutUser(EMAIL)
    expect(outcome).toMatchObject({ ok: false, verified: false, retryable: false })
    expect(http.requests.some((r) => r.url.includes('/tokens'))).toBe(false)
  })

  it('reports a missing account as already absent', async () => {
    const { connector } = connectorWith([{ method: 'POST', match: '/signOut', respond: { status: 404, body: null } }])
    expect(await connector.signOutUser(EMAIL)).toMatchObject({ ok: true, verified: true, alreadyAbsent: true })
  })
})

describe('an unreadable answer is never a clean one', () => {
  // Found by an outside review: an HTTP 200 whose body was not JSON became an
  // empty list, and an empty list read as "no grants remain", verified.
  const garbage = { status: 200, body: 'not json at all' }

  it('refuses a grant list that is not JSON, not a list, or has an entry with no id', async () => {
    for (const bad of [garbage, { status: 200, body: { items: 'nope' } }, { status: 200, body: { items: [{ displayText: 'no id' }] } }]) {
      const { connector } = connectorWith([signOutOk, revokeOk, noAsps, { method: 'GET', match: /\/tokens$/, respond: bad }])
      const outcome = await connector.signOutUser(EMAIL)
      expect(outcome.ok).toBe(false)
      expect(outcome.verified).toBe(false)
    }
  })

  it('refuses an app password list that cannot be read', async () => {
    const { connector } = connectorWith([signOutOk, revokeOk, tokenLists([], []), { method: 'GET', match: /\/asps$/, respond: garbage }])
    expect(await connector.signOutUser(EMAIL)).toMatchObject({ ok: false, verified: false })
  })

  it('refuses a licence list that cannot be read, rather than finding no seat', async () => {
    const http = fakeHttp([{ method: 'GET', match: /licensing/, respond: garbage }, grantAllTokens()])
    const connector = createGoogleConnector(testConfig({ licensingCustomerId: 'example.com' }), { http })
    await expect(connector.listLicences(EMAIL)).rejects.toThrow(/not a JSON object/)
  })

  it('an empty list Google leaves out entirely is still empty', async () => {
    const { connector } = connectorWith([signOutOk, revokeOk, aspLists([], []), { method: 'GET', match: /\/tokens$/, respond: { status: 200, body: { kind: 'admin#directory#tokenList' } } }])
    expect(await connector.signOutUser(EMAIL)).toMatchObject({ ok: true, verified: true })
  })
})

describe('closing a Google account on day 0, with no identity provider', () => {
  const userGet = (flag: boolean): Rule => ({ method: 'GET', match: /\/users\/[^/]+$/, respond: { status: 200, body: { primaryEmail: EMAIL, changePasswordAtNextLogin: flag } } })

  it('replaces the password, reads the forced change back, and ends every session', async () => {
    const { connector, http } = connectorWith([{ method: 'PUT', match: /\/users\/[^/]+$/, respond: { status: 200, body: {} } }, userGet(true), signOutOk])
    const outcome = await connector.closeUser(EMAIL)
    expect(outcome).toMatchObject({ ok: true, verified: true, detail: { passwordReplaced: true, sessionsReset: 'requested' } })
    const put = http.requests.find((r) => r.method === 'PUT')
    expect(put?.json).toMatchObject({ changePasswordAtNextLogin: true })
    // A real random value was sent, and it appears nowhere in the outcome.
    const sent = String((put?.json as Record<string, unknown>)['password'])
    expect(sent.length).toBeGreaterThanOrEqual(24)
    expect(JSON.stringify(outcome)).not.toContain(sent)
  })

  it('is not verified when the forced change does not read back', async () => {
    const { connector, http } = connectorWith([{ method: 'PUT', match: /\/users\/[^/]+$/, respond: { status: 200, body: {} } }, userGet(false), signOutOk])
    expect(await connector.closeUser(EMAIL)).toMatchObject({ ok: false, verified: false })
    expect(http.requests.some((r) => r.url.endsWith('/signOut'))).toBe(false)
  })

  it('reports a missing account as already absent', async () => {
    const { connector } = connectorWith([{ method: 'PUT', match: /\/users\/[^/]+$/, respond: { status: 404, body: null } }])
    expect(await connector.closeUser(EMAIL)).toMatchObject({ ok: true, verified: true, alreadyAbsent: true })
  })
})

describe('a starter password set on Google', () => {
  const user = (body: Record<string, unknown>): Rule => ({ method: 'GET', match: /\/users\/[^/]+$/, respond: { status: 200, body: { id: 'g-1', primaryEmail: EMAIL, ...body } } })

  it('is set on an account that has never signed in', async () => {
    const { connector, http } = connectorWith([
      { method: 'GET', match: /\/users\/[^/]+$/, respond: [
        { status: 200, body: { id: 'g-1', lastLoginTime: '1970-01-01T00:00:00.000Z' } },
        { status: 200, body: { id: 'g-1', changePasswordAtNextLogin: true } },
      ] },
      { method: 'PUT', match: /\/users\/[^/]+$/, respond: { status: 200, body: {} } },
    ])
    expect(await connector.activation.setTemporaryPassword('g-1', 'temporary-value-for-the-test')).toMatchObject({ ok: true, verified: true })
    expect(http.requests.some((r) => r.method === 'PUT')).toBe(true)
  })

  it('is refused on an account somebody has signed in to, or whose sign-in record is missing', async () => {
    for (const body of [{ lastLoginTime: '2026-09-01T08:00:00.000Z' }, {}, { lastLoginTime: 'not a date' }, { lastLoginTime: '1970-01-01T00:00:00.000Z', isEnrolledIn2Sv: true }]) {
      const { connector, http } = connectorWith([user(body)])
      expect(await connector.activation.setTemporaryPassword('g-1', 'temporary-value-for-the-test')).toMatchObject({ ok: false, detail: { reason: 'already_in_use' } })
      expect(http.requests.some((r) => r.method === 'PUT')).toBe(false)
    }
  })
})

describe('the scope it needs', () => {
  it('is probed by doctor only once the sign-out is armed', async () => {
    const { connector } = connectorWith([], refuseScopes([GOOGLE_SCOPES.directoryUserSecurity]))
    const unarmed = await connector.probeScopes()
    expect(unarmed.map((r) => r.scope)).not.toContain(GOOGLE_SCOPES.directoryUserSecurity)

    const armed = await connector.probeScopes({ armed: ['google_signout'] })
    const row = armed.find((r) => r.scope === GOOGLE_SCOPES.directoryUserSecurity)
    expect(row).toMatchObject({ ok: false, required: true })
  })
})
