import { describe, expect, it } from 'vitest'
import { ConfigError, describeConfig, loadConfig, SECRET_PATHS } from '../../src/config/load.ts'
import { envProvider } from '../../src/config/secrets.ts'
import { REDACTED } from '../../src/config/redact.ts'

/** The smallest document the schema accepts, with the memory store. */
function minimalDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

const ENV = {
  JUMPCLOUD_API_KEY: 'jc-value-for-the-test',
  GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}',
  JML_API_TOKEN: 'a-token-of-at-least-thirty-two-bytes-long',
}

function load(document: Record<string, unknown>, env: NodeJS.ProcessEnv = ENV) {
  return loadConfig({ document, env, providers: [envProvider(env)] })
}

describe('loadConfig', () => {
  it('accepts a minimal document and applies defaults', async () => {
    const { config } = await load(minimalDocument())
    expect(config.mode).toBe('dry-run')
    expect(config.armedActions).toEqual([])
    expect(config.leaver.transferDay).toBe(6)
    expect(config.leaver.deleteDay).toBe(7)
    expect(config.leaver.terminationLookbackDays).toBe(60)
    expect(config.leaver.maxDay0PerRun).toBe(5)
    expect(config.notify.adapters).toEqual(['console'])
    expect(config.notify.weeklyReraiseDay).toBe('monday')
    expect(config.devices.uninstallTriggers).toEqual({ windows: null, darwin: null, linux: null })
  })

  it('resolves every secret reference once, at start-up', async () => {
    const { secrets } = await load(minimalDocument())
    expect(secrets.paths()).toEqual(['google.serviceAccountJson', 'identity.jumpcloud.apiKey', 'server.token'])
    expect(secrets.get('identity.jumpcloud.apiKey').use((v) => v)).toBe('jc-value-for-the-test')
  })

  it('refuses to start when a secret cannot be resolved', async () => {
    // The alternative was resolving lazily inside each step, where a missing
    // credential became a step that quietly did nothing and a run that
    // reported success.
    const err = await load(minimalDocument(), { ...ENV, JUMPCLOUD_API_KEY: undefined }).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.issues[0].path).toBe('identity.jumpcloud.apiKey')
  })

  it('fails at start-up on an unknown key', async () => {
    const err = await load(minimalDocument({ leaver: { deleteDayz: 9 } })).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.message).toContain('deleteDayz')
  })

  it('refuses armed mode with nothing armed', async () => {
    const err = await load(minimalDocument({ mode: 'armed' })).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.issues[0].path).toBe('armedActions')
  })

  it('accepts armed mode when the actions are named', async () => {
    const { config } = await load(minimalDocument({ mode: 'armed', armedActions: ['suspend'] }))
    expect(config.armedActions).toEqual(['suspend'])
  })

  it('refuses a delete day that is not after the transfer day', async () => {
    const err = await load(minimalDocument({ leaver: { transferDay: 6, deleteDay: 6 } })).catch((e) => e)
    expect(err.issues[0].path).toBe('leaver.deleteDay')
  })

  it('requires a salt when audit minimisation is on', async () => {
    const err = await load(minimalDocument({ audit: { minimisePii: true } })).catch((e) => e)
    expect(err.issues[0].path).toBe('audit.salt')
  })

  it('expands an environment reference in any string', async () => {
    const env = { ...ENV, ORG_PRIMARY_DOMAIN: 'example.org' }
    const { config } = await load(
      minimalDocument({
        org: { name: 'Example', primaryDomain: '${ORG_PRIMARY_DOMAIN}', timezone: 'Europe/London', itTeamSignature: 'IT' },
      }),
      env,
    )
    expect(config.org.primaryDomain).toBe('example.org')
  })

  it('fails on a reference to an unset variable rather than substituting a blank', async () => {
    const err = await load(
      minimalDocument({
        org: { name: 'Example', primaryDomain: '${NOT_SET_ANYWHERE}', timezone: 'Europe/London', itTeamSignature: 'IT' },
      }),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.message).toContain('NOT_SET_ANYWHERE')
  })

  it('refuses to start when a credential for a reserved leg is present', async () => {
    const err = await load(minimalDocument(), { ...ENV, SLACK_SCIM_TOKEN: 'present-but-inert' }).catch((e) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.issues[0].path).toBe('legs.slackScim')
  })

  it('can validate without resolving credentials, for the generator and the tests', async () => {
    const { secrets } = await loadConfig({ document: minimalDocument(), env: {}, allowMissingSecrets: true })
    expect(secrets.paths()).toEqual([])
  })
})

describe('describeConfig', () => {
  it('prints references and lengths, never a value', async () => {
    const loaded = await load(minimalDocument())
    const shown = JSON.stringify(describeConfig(loaded))
    expect(shown).toContain('env:JUMPCLOUD_API_KEY')
    expect(shown).not.toContain('jc-value-for-the-test')
    expect(shown).toContain('"length":' + ENV.JUMPCLOUD_API_KEY.length)
  })

  it('would mask a value that reached the printed object by any other route', async () => {
    const loaded = await load(minimalDocument())
    // org.name is not a secret field, but the redactor works on values rather
    // than on paths, so a registered credential is masked wherever it appears.
    loaded.config.org.name = 'org named jc-value-for-the-test'
    expect(JSON.stringify(describeConfig(loaded))).toContain(REDACTED)
  })
})

describe('SECRET_PATHS', () => {
  it('lists every path the loader will try to resolve', () => {
    // The parity test against the schema lives in config-generate.test.ts, so
    // a new secret field in the schema cannot be forgotten here.
    expect(new Set(SECRET_PATHS).size).toBe(SECRET_PATHS.length)
  })
})
