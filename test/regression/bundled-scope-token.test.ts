/**
 * Failure this prevents: one token was minted for every scope at once, so when
 * a single scope was missing from the delegation the whole exchange failed with
 * a bare `unauthorized_client` naming no scope. A partial grant therefore read
 * as no delegation at all, and the search went looking for a broken key.
 *
 * The connector must mint one token per scope, always, on every path. This
 * drives every method and asserts it of every request made.
 */

import { describe, expect, it } from 'vitest'

import { createGoogleConnector } from '../../src/connectors/google/index.ts'
import { GOOGLE_SCOPES } from '../../src/connectors/google/scopes.ts'
import {
  assertionClaims,
  directoryUser,
  fakeHttp,
  grantAllTokens,
  testConfig,
  type Rule,
} from '../fixtures/google/harness.ts'

/** Enough of a tenancy for every method to complete. */
const TENANCY: Rule[] = [
  {
    method: 'GET',
    match: '/sku/example-standard-sku/user/',
    respond: [
      { status: 200, body: { productId: 'Google-Apps', skuId: 'example-standard-sku' } },
      { status: 404, body: {} },
    ],
  },
  { method: 'DELETE', match: '/sku/', respond: { status: 204, body: {} } },
  {
    method: 'GET',
    match: '/datatransfer/v1/applications',
    respond: { status: 200, body: { applications: [{ id: '100000000000002', name: 'Drive and Docs' }] } },
  },
  { method: 'GET', match: '/transfers?', respond: { status: 200, body: { dataTransfers: [] } } },
  {
    method: 'POST',
    match: '/transfers',
    respond: { status: 200, body: { id: 'transfer-1', overallTransferStatusCode: 'inProgress' } },
  },
  {
    method: 'GET',
    match: '/transfers/transfer-1',
    respond: { status: 200, body: { overallTransferStatusCode: 'completed' } },
  },
  { method: 'PUT', match: '/settings/vacation', respond: { status: 200, body: {} } },
  {
    method: 'GET',
    match: '/settings/vacation',
    respond: { status: 200, body: { enableAutoReply: true } },
  },
  { method: 'POST', match: '/messages/send', respond: { status: 200, body: { id: 'message-1' } } },
  { method: 'PUT', match: '/users/', respond: { status: 200, body: directoryUser() } },
  { method: 'DELETE', match: '/users/', respond: { status: 204, body: {} } },
  {
    method: 'GET',
    match: '/users/',
    respond: [
      { status: 200, body: directoryUser({ suspended: true }) },
      { status: 200, body: directoryUser({ suspended: true }) },
      { status: 404, body: {} },
      { status: 200, body: directoryUser({ id: 'recipient-id' }) },
    ],
  },
]

describe('one scope per token, on every path', () => {
  it('never bundles scopes, whatever the connector is asked to do', async () => {
    const http = fakeHttp([...TENANCY, grantAllTokens()])
    const connector = createGoogleConnector(
      testConfig({ licenceSkuIds: ['example-standard-sku'] }),
      { http },
    )

    await connector.suspendUser('jane.doe@example.com')
    await connector.listLicences('jane.doe@example.com')
    await connector.revokeLicence('jane.doe@example.com', 'Google-Apps', 'example-standard-sku')
    await connector.setVacationResponder('jane.doe@example.com', 'Subject', '<p>Body</p>')
    await connector.sendMail({ to: ['john.doe@example.com'], subject: 'Subject', body: 'Body' })
    await connector.transferDrive('jane.doe@example.com', 'john.doe@example.com')
    await connector.getTransferStatus('transfer-1')
    await connector.probeScopes()

    const requests = http.tokenRequests()
    expect(requests.length).toBeGreaterThan(5)
    for (const request of requests) {
      const scope = String(assertionClaims(request).scope)
      expect(scope).not.toContain(' ')
      expect(scope.split(' ')).toHaveLength(1)
      expect(Object.values(GOOGLE_SCOPES)).toContain(scope)
    }
  })

  it('mints the mailbox scope as the mailbox owner and the directory scope as the administrator', async () => {
    const http = fakeHttp([...TENANCY, grantAllTokens()])
    const connector = createGoogleConnector(testConfig(), { http })

    await connector.setVacationResponder('jane.doe@example.com', 'Subject', '<p>Body</p>')
    await connector.suspendUser('jane.doe@example.com')

    const subjects = http.tokenRequests().map((req) => ({
      scope: assertionClaims(req).scope,
      subject: assertionClaims(req).sub,
    }))
    expect(subjects).toEqual([
      { scope: GOOGLE_SCOPES.gmailSettingsBasic, subject: 'jane.doe@example.com' },
      { scope: GOOGLE_SCOPES.directoryUser, subject: 'admin@example.com' },
    ])
  })
})
