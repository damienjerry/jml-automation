import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { importBundle, N8nApiError, ERROR_WORKFLOW } from '../../src/n8n/import.ts'
import { FakeN8n } from '../helpers/fake-n8n.ts'

const BUNDLE = join(process.cwd(), 'n8n', 'workflows')
const VALUES = {
  apiToken: 'sidecar-token-not-real',
  inboundToken: 'inbound-token-not-real',
  formUser: 'jml',
  formPassword: 'form-password-not-real',
  slackBotToken: 'slack-bot-not-real',
}

function run(fake: FakeN8n, overrides: Partial<Parameters<typeof importBundle>[0]> = {}) {
  return importBundle({ http: fake.http(), baseUrl: fake.baseUrl, apiKey: fake.apiKey, bundleDir: BUNDLE, values: VALUES, ...overrides })
}

describe('importing the bundle into n8n', () => {
  it('creates the four credentials and all six workflows, error workflow first, each bound by id', async () => {
    const fake = new FakeN8n()
    const report = await run(fake)
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(Object.keys(report.credentials).sort()).toEqual(['JML Form Access', 'JML Inbound Webhook', 'JML Slack Alerts', 'JML Toolkit API'])
    expect(report.workflows.map((w) => w.state)).toEqual(Array(6).fill('created'))
    expect(report.workflows[0]?.name).toBe(ERROR_WORKFLOW)

    const errorId = fake.workflows.get(ERROR_WORKFLOW)?.id
    for (const [name, wf] of fake.workflows) {
      const settings = wf.body['settings'] as Record<string, unknown>
      if (name === ERROR_WORKFLOW) expect(settings['errorWorkflow']).toBeUndefined()
      else expect(settings['errorWorkflow']).toBe(errorId)
      for (const node of wf.body['nodes'] as { credentials?: Record<string, { id?: string; name: string }> }[]) {
        for (const cred of Object.values(node.credentials ?? {})) expect(cred.id).toBe(report.credentials[cred.name as keyof typeof report.credentials]?.id)
      }
      // The create body carries only what the endpoint accepts: nothing that would make it active.
      expect(Object.keys(wf.body).sort()).toEqual(['connections', 'name', 'nodes', 'settings'])
    }
  })

  it('stores each credential in the shape n8n expects', async () => {
    const fake = new FakeN8n()
    await run(fake)
    const byName = new Map([...fake.credentials.values()].map((c) => [c.name, c]))
    expect(byName.get('JML Toolkit API')).toMatchObject({ type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer sidecar-token-not-real' } })
    expect(byName.get('JML Inbound Webhook')).toMatchObject({ type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer inbound-token-not-real' } })
    expect(byName.get('JML Form Access')).toMatchObject({ type: 'httpBasicAuth', data: { user: 'jml', password: 'form-password-not-real' } })
    expect(byName.get('JML Slack Alerts')).toMatchObject({ type: 'slackApi', data: { accessToken: 'slack-bot-not-real', notice: '' } })
  })

  it('sends every request to the n8n it was given, and secret values only in credential bodies', async () => {
    const fake = new FakeN8n()
    await run(fake)
    for (const r of fake.requests) {
      expect(r.url.startsWith(fake.baseUrl + '/')).toBe(true)
      const carriesSecret = Object.values(VALUES).some((v) => v.length > 4 && JSON.stringify(r.body ?? '').includes(v))
      if (carriesSecret) expect(r.url).toBe(fake.baseUrl + '/api/v1/credentials')
    }
  })

  it('leaves an existing workflow alone and reuses credential ids from an earlier run', async () => {
    const fake = new FakeN8n()
    const first = await run(fake)
    const credentialPosts = fake.requests.filter((r) => r.url.endsWith('/api/v1/credentials')).length
    const known = Object.fromEntries(Object.entries(first.credentials).map(([k, v]) => [k, v!.id]))
    const second = await run(fake, { knownCredentialIds: known })
    expect(second.ok).toBe(true)
    expect(second.workflows.map((w) => w.state)).toEqual(Array(6).fill('already_present'))
    expect(fake.requests.filter((r) => r.url.endsWith('/api/v1/credentials')).length).toBe(credentialPosts)
    expect(fake.workflows.size).toBe(6)
  })

  it('skips the Slack credential when no bot token is configured, and says so', async () => {
    const fake = new FakeN8n()
    const report = await run(fake, { values: { ...VALUES, slackBotToken: null } })
    expect(report.skippedCredentials).toEqual(['JML Slack Alerts'])
    expect(report.credentials['JML Slack Alerts']).toBeUndefined()
  })

  it('refuses with a clear message when the API key is wrong', async () => {
    const fake = new FakeN8n()
    await expect(run(fake, { apiKey: 'wrong' })).rejects.toThrow(N8nApiError)
    await expect(run(fake, { apiKey: 'wrong' })).rejects.toThrow(/Settings, n8n API/)
    expect(fake.workflows.size).toBe(0)
  })
})
