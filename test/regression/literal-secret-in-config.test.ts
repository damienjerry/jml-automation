/**
 * Prevents: a credential written directly into the configuration file, and a
 * credential that cannot be resolved turning into a step that quietly does
 * nothing.
 *
 * Both halves come from the same arrangement. Credentials were read from the
 * environment inside each step, lazily, with no validation at start-up. A
 * missing one produced a step that skipped and a run that reported success,
 * and the natural fix people reached for was to paste the value into the
 * config file, where it went into a backup, a screen share and eventually a
 * repository.
 */

import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config/load.ts'
import { envProvider } from '../../src/config/secrets.ts'

const ENV = {
  JUMPCLOUD_API_KEY: 'resolvable-test-value',
  GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
  JML_API_TOKEN: 'a-token-of-at-least-thirty-two-bytes-long',
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    org: { name: 'Example Organisation', primaryDomain: 'example.com', timezone: 'Europe/London', itTeamSignature: 'IT Team' },
    mail: { senderMailbox: 'it-noreply@example.com' },
    hris: { adapter: 'fixture', minPlausibleHeadcount: 5, fixture: { path: './src/cli/fixtures/demo.json' } },
    store: { adapter: 'memory' },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY' } },
    google: { serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', adminEmail: 'admin@example.com' },
    audit: { minimisePii: false },
    server: { token: 'env:JML_API_TOKEN' },
    ...overrides,
  }
}

function load(doc: Record<string, unknown>, env: NodeJS.ProcessEnv = ENV) {
  return loadConfig({ document: doc, env, providers: [envProvider(env)] })
}

describe('a credential pasted into the config file', () => {
  it('is refused at start-up, with the docs anchor for the reference grammar', async () => {
    const err = await load(
      document({ identity: { jumpcloud: { apiKey: 'a-value-somebody-pasted-in' } } }),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.issues[0].path).toBe('identity.jumpcloud.apiKey')
    expect(err.issues[0].docsAnchor).toBe('docs/config-reference.md#secret-references')
    expect(err.issues[0].message).toContain('secret reference is required')
  })

  it('does not echo the pasted value in the error, which would copy it again', async () => {
    const err = await load(
      document({ identity: { jumpcloud: { apiKey: 'a-value-somebody-pasted-in' } } }),
    ).catch((e) => e)
    expect(err.message).not.toContain('a-value-somebody-pasted-in')
  })

  it('is refused on an optional secret field too', async () => {
    const err = await load(
      document({ notify: { adapters: ['console'], slack: { botToken: 'a-value-somebody-pasted-in' } } }),
    ).catch((e) => e)
    expect(err.issues[0].path).toBe('notify.slack.botToken')
    expect(err.issues[0].docsAnchor).toBe('docs/config-reference.md#secret-references')
  })

  it('accepts all three reference forms', async () => {
    const opRef = 'op://<vault>/<item-uuid>/<field>'
    const err = await load(document({ identity: { jumpcloud: { apiKey: opRef } } }), ENV).catch((e) => e)
    // The grammar is accepted; only resolution fails here, because the CLI is
    // not available in a test, and that failure names the reference.
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.issues[0].message).toContain(opRef)
  })
})

describe('a credential that cannot be resolved', () => {
  it('stops the process instead of becoming a step that quietly does nothing', async () => {
    const err = await load(document(), { ...ENV, GOOGLE_SERVICE_ACCOUNT_JSON: undefined }).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.issues.map((i: { path: string }) => i.path)).toEqual(['google.serviceAccountJson'])
  })

  it('reports every unresolvable reference at once, not one per restart', async () => {
    const err = await load(document(), {}).catch((e) => e)
    expect(err.issues).toHaveLength(3)
  })

  it('resolves the whole set before anything runs, so nothing resolves mid-run', async () => {
    const { secrets } = await load(document())
    expect(secrets.describe()).toEqual([
      { path: 'google.serviceAccountJson', ref: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', length: ENV.GOOGLE_SERVICE_ACCOUNT_JSON.length },
      { path: 'identity.jumpcloud.apiKey', ref: 'env:JUMPCLOUD_API_KEY', length: ENV.JUMPCLOUD_API_KEY.length },
      { path: 'server.token', ref: 'env:JML_API_TOKEN', length: ENV.JML_API_TOKEN.length },
    ])
  })
})
