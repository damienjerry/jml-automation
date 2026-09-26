/**
 * An HR system read from a file still demanded HiBob credentials.
 *
 * Every secret reference in the configuration was resolved at start-up, and
 * the generated configuration carries a HiBob block whichever HR adapter is
 * selected. So somebody using the file adapter as a bridge to another HR
 * system could not run a single command without HIBOB_SERVICE_USER_ID set.
 * Found while testing the adaptation guide. A secret under an adapter that is
 * not selected is now not resolved.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.ts'

function document(hrisAdapter: 'hibob' | 'fixture', ticketing: 'none' | 'suptask' = 'none'): Record<string, unknown> {
  return {
    version: 1,
    org: { name: 'Example Organisation', primaryDomain: 'example.com', timezone: 'Europe/London', itTeamSignature: 'IT Team' },
    mail: { senderMailbox: 'it-noreply@example.com' },
    hris: {
      adapter: hrisAdapter,
      minPlausibleHeadcount: 5,
      fixture: { path: './src/cli/fixtures/demo.json' },
      hibob: { serviceUserId: 'env:HIBOB_SERVICE_USER_ID', serviceToken: 'env:HIBOB_SERVICE_TOKEN' },
    },
    store: { adapter: 'memory' },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY' } },
    google: { serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', adminEmail: 'admin@example.com' },
    ticketing: { adapter: ticketing, suptask: { apiToken: 'env:SUPTASK_API_TOKEN' } },
    audit: { minimisePii: false },
    server: { token: 'env:JML_API_TOKEN' },
  }
}

const ENV = { JUMPCLOUD_API_KEY: 'jc-value-for-the-test', GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}', JML_API_TOKEN: 'x'.repeat(64) }

describe('credentials for an adapter that is not selected', () => {
  it('are not required when the HR system is a file', async () => {
    const loaded = await loadConfig({ document: document('fixture'), env: ENV })
    expect(loaded.secrets.has('hris.hibob.serviceUserId')).toBe(false)
  })

  it('are still required when that adapter is selected', async () => {
    await expect(loadConfig({ document: document('hibob'), env: ENV })).rejects.toThrow(/HIBOB_SERVICE_USER_ID/)
  })

  it('apply to the ticketing adapter too', async () => {
    const off = await loadConfig({ document: document('fixture', 'none'), env: ENV })
    expect(off.secrets.has('ticketing.suptask.apiToken')).toBe(false)
    await expect(loadConfig({ document: document('fixture', 'suptask'), env: ENV })).rejects.toThrow(/SUPTASK_API_TOKEN/)
  })
})
