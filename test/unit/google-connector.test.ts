import { describe, expect, it } from 'vitest'

import type { GoogleConnectorConfig } from '../../src/connectors/google/auth.ts'
import { createGoogleConnector } from '../../src/connectors/google/index.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import type { GoogleWorkspaceConnector } from '../../src/connectors/types.ts'
import {
  directoryUser,
  fakeHttp,
  grantAllTokens,
  refuseScopes,
  requestedScopes,
  testConfig,
  type Rule,
} from '../fixtures/google/harness.ts'

function connectorWith(rules: Rule[], cfgOverrides: Partial<GoogleConnectorConfig> = {}) {
  const http = fakeHttp([...rules, grantAllTokens()])
  const connector = createGoogleConnector(testConfig(cfgOverrides), { http })
  return { connector, http }
}

describe('the assembled connector', () => {
  it('satisfies the shared provider contract', () => {
    const { connector } = connectorWith([])
    const contract: GoogleWorkspaceConnector = connector

    expect(contract.name).toBe('google')
    for (const method of [
      'getUser',
      'suspendUser',
      'deleteUser',
      'listLicences',
      'revokeLicence',
      'transferDrive',
      'getTransferStatus',
      'setVacationResponder',
      'signOutUser',
      'sendMail',
      'testConnection',
      'probeScopes',
    ] as const) {
      expect(typeof contract[method]).toBe('function')
    }
  })

  it('reduces licence assignments to the pairs the revoke needs', async () => {
    const { connector } = connectorWith(
      [
        {
          method: 'GET',
          match: '/sku/example-standard-sku/user/',
          respond: {
            status: 200,
            body: {
              productId: 'Google-Apps',
              skuId: 'example-standard-sku',
              skuName: 'Example Standard',
            },
          },
        },
      ],
      { licenceSkuIds: ['example-standard-sku'] },
    )

    expect(await connector.listLicences('jane.doe@example.com')).toEqual([
      { productId: 'Google-Apps', skuId: 'example-standard-sku' },
    ])
    expect(await connector.listLicenceAssignments('jane.doe@example.com')).toEqual([
      { productId: 'Google-Apps', skuId: 'example-standard-sku', skuName: 'Example Standard' },
    ])
  })
})

describe('testConnection', () => {
  it('proves the key signs, the delegation covers the directory and the subject is real', async () => {
    const { connector } = connectorWith([
      {
        method: 'GET',
        match: '/users?',
        respond: { status: 200, body: { users: [directoryUser()] } },
      },
    ])

    const check = await connector.testConnection()

    expect(check.ok).toBe(true)
    expect(check.detail).toContain('customer-wide list')
    expect(check.docsAnchor).toBe('docs/credentials.md#google-workspace')
  })

  it('names the console screen when the directory scope is not delegated', async () => {
    const { connector } = connectorWith([refuseScopes([GOOGLE_SCOPES.directoryUser])])

    const check = await connector.testConnection()

    expect(check.ok).toBe(false)
    expect(check.remediation).toContain('domain-wide delegation')
  })

  it('separates a working token from a failing read', async () => {
    const { connector } = connectorWith([
      { method: 'GET', match: '/users?', respond: { status: 403, body: {} } },
    ])

    const check = await connector.testConnection()

    expect(check.ok).toBe(false)
    expect(check.detail).toContain('delegated token worked')
    expect(check.remediation).toContain('Admin SDK API is enabled')
  })
})

describe('probeScopes', () => {
  it('reports every required scope on its own, one token each', async () => {
    const { connector, http } = connectorWith([])

    const reports = await connector.probeScopes()

    expect(reports).toHaveLength(6)
    expect(reports.every((r) => r.ok)).toBe(true)
    expect(requestedScopes(http)).toEqual(reports.map((r) => r.scope))
    for (const scope of requestedScopes(http)) expect(scope).not.toContain(' ')
  })

  it('names the one refused scope rather than failing as a whole', async () => {
    const { connector } = connectorWith([refuseScopes([GOOGLE_SCOPES.dataTransfer])])

    const reports = await connector.probeScopes()

    const refused = reports.filter((r) => !r.ok)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({
      scope: GOOGLE_SCOPES.dataTransfer,
      status: 401,
      error: 'unauthorized_client',
    })
    expect(refused[0]!.breaksWithout).toContain('never handed over')
    expect(refused[0]!.neededBy).toContain('transferDrive')
  })

  it('probes each scope as the subject that will really use it', async () => {
    const { connector } = connectorWith([])

    const reports = await connector.probeScopes({ mailbox: 'jane.doe@example.com' })
    const bySubject = Object.fromEntries(reports.map((r) => [r.scope, r.subject]))

    expect(bySubject[GOOGLE_SCOPES.gmailSettingsBasic]).toBe('jane.doe@example.com')
    expect(bySubject[GOOGLE_SCOPES.gmailSend]).toBe('it.notifications@example.com')
    expect(bySubject[GOOGLE_SCOPES.directoryUser]).toBe('admin@example.com')
  })

  it('falls back to the administrator when no ordinary mailbox is offered', async () => {
    const { connector } = connectorWith([])

    const reports = await connector.probeScopes()
    const mailboxRow = reports.find((r) => r.scope === GOOGLE_SCOPES.gmailSettingsBasic)

    expect(mailboxRow!.subject).toBe('admin@example.com')
  })
})
