/**
 * `jml setup` end to end, with a script of answers, a fake `jml`, a fake shell
 * and a fake n8n. Nothing leaves the process and nothing outside a temporary
 * directory is written.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupCommand, type SetupDeps, type ShellResult } from '../../src/cli/commands/setup/index.ts'
import { parseEnv } from '../../src/cli/commands/setup/files.ts'
import { scriptedPrompter } from '../../src/cli/commands/setup/prompter.ts'
import { getConfig } from '../../src/cli/commands/setup/files.ts'
import type { CliIo } from '../../src/cli/commands/context.ts'
import { FakeN8n } from '../helpers/fake-n8n.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A temporary checkout: just the workflow bundle, which the n8n step reads. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jml-setup-'))
  dirs.push(dir)
  cpSync(join(process.cwd(), 'n8n', 'workflows'), join(dir, 'n8n', 'workflows'), { recursive: true })
  return dir
}

const SECRETS = {
  hibobUser: 'hibob-user-not-real',
  hibobTokenFromOp: 'hibob-token-from-op-not-real',
  jumpcloud: 'jumpcloud-key-not-real',
  slack: 'slack-bot-not-real',
  n8nKey: 'n8n-api-key-not-real',
  privateKey: 'private-key-material-not-real',
}

function googleKeyFile(dir: string): string {
  const path = join(dir, 'key.json')
  writeFileSync(path, JSON.stringify({ type: 'service_account', client_email: 'svc@example.com', client_id: '1234', private_key: SECRETS.privateKey }, null, 2))
  return path
}

/** Answers, in the order the wizard asks. */
function fullRunAnswers(keyPath: string): string[] {
  return [
    // configuration
    'Example Organisation', 'example.com', 'legacy.example.com', 'Europe/London', '', 'admin@example.com', '',
    'hibob', '5', 'sqlite', 'y', 'GEXAMPLE01',
    // credentials: HiBob id, HiBob token, JumpCloud, Google, Slack
    'paste', SECRETS.hibobUser,
    'op', 'op://Vault/item/field',
    'paste', SECRETS.jumpcloud,
    'file', keyPath,
    'paste', SECRETS.slack,
    // bootstrap
    'y',
    // n8n
    SECRETS.n8nKey,
  ]
}

interface Harness {
  io: CliIo
  output: () => string
  deps: Partial<SetupDeps>
  jmlCalls: string[][]
  n8n: FakeN8n
}

function harness(answers: string[], opts: { doctorOk?: boolean; dockerUp?: boolean; verifyCode?: number; day0?: number } = {}): Harness {
  let out = ''
  const io: CliIo = { out: (t) => (out += t), err: (t) => (out += t), env: {}, cwd: '/' }
  const jmlCalls: string[][] = []
  const n8n = new FakeN8n()
  const shell = async (cmd: string, args: string[]): Promise<ShellResult> => {
    const line = [cmd, ...args].join(' ')
    if (line === 'docker version --format {{.Server.Version}}') return { code: opts.dockerUp === false ? 1 : 0, stdout: '27.0.0\n', stderr: '' }
    if (line === 'docker compose version --short') return { code: 0, stdout: '2.29.0\n', stderr: '' }
    if (line === 'op read --no-newline op://Vault/item/field') return { code: 0, stdout: SECRETS.hibobTokenFromOp, stderr: '' }
    if (line === 'docker compose up -d --build') return { code: 0, stdout: '', stderr: '' }
    if (line.startsWith('docker compose ps')) return { code: 0, stdout: 'jml healthy\nn8n \n', stderr: '' }
    return { code: 127, stdout: '', stderr: 'unexpected command ' + line }
  }
  const jml = async (argv: string[]): Promise<{ code: number; out: string }> => {
    jmlCalls.push(argv)
    if (argv[0] === 'doctor') {
      const ok = opts.doctorOk !== false
      return { code: ok ? 0 : 1, out: JSON.stringify({ ok, rows: [{ name: 'HR system', ok, detail: ok ? 'read people' : 'HTTP 401', docsAnchor: 'docs/credentials.md#the-hr-system' }] }) }
    }
    if (argv[0] === 'store' && argv[1] === 'bootstrap') {
      const armed = argv.includes('--armed')
      const day0 = opts.day0 ?? 0
      return { code: day0 > 0 ? 1 : 0, out: JSON.stringify({ scanned: 10, tombstoned: 6, skippedActive: 3, skippedHired: 1, day0SelectionAfter: day0, warnings: [], ok: day0 === 0, dryRun: !armed }) }
    }
    if (argv[0] === 'store' && argv[1] === 'verify') return { code: opts.verifyCode ?? 0, out: 'departed 6\nday-0 today 0\n' }
    return { code: 2, out: 'unexpected ' + argv.join(' ') }
  }
  return {
    io,
    output: () => out,
    deps: { prompter: scriptedPrompter(answers), jml, shell, http: n8n.http(), sleep: async () => {} },
    jmlCalls,
    n8n,
  }
}

describe('jml setup', () => {
  it('goes from an empty checkout to an imported, unarmed n8n', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)))
    const code = await setupCommand(h.io, { dir }, h.deps)
    expect(code, h.output()).toBe(0)

    const config = join(dir, 'jml.config.yaml')
    expect(await getConfig(config, ['org', 'primaryDomain'])).toBe('example.com')
    expect(await getConfig(config, ['org', 'aliasDomains'])).toEqual(['legacy.example.com'])
    expect(await getConfig(config, ['mail', 'senderMailbox'])).toBe('admin@example.com')
    expect(await getConfig(config, ['hris', 'adapter'])).toBe('hibob')
    expect(await getConfig(config, ['hris', 'minPlausibleHeadcount'])).toBe(5)
    expect(await getConfig(config, ['notify', 'adapters'])).toEqual(['slack', 'console'])
    // Nothing is armed.
    expect(await getConfig(config, ['mode'])).toBe('dry-run')
    expect(await getConfig(config, ['armedActions'])).toEqual([])
    // The configuration holds references, never values.
    const configText = readFileSync(config, 'utf8')
    for (const secret of Object.values(SECRETS)) expect(configText).not.toContain(secret)

    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'))
    expect(env['HIBOB_SERVICE_USER_ID']).toBe(SECRETS.hibobUser)
    expect(env['HIBOB_SERVICE_TOKEN']).toBe(SECRETS.hibobTokenFromOp)
    expect(env['JUMPCLOUD_API_KEY']).toBe(SECRETS.jumpcloud)
    expect(JSON.parse(env['GOOGLE_SERVICE_ACCOUNT_JSON'] ?? '{}').private_key).toBe(SECRETS.privateKey)
    expect(env['SLACK_BOT_TOKEN']).toBe(SECRETS.slack)
    expect(env['SLACK_JML_CHANNEL_ID']).toBe('GEXAMPLE01')
    expect(env['JML_DRY_RUN']).toBe('true')
    expect(env['JML_INBOUND_WEBHOOK_TOKEN']).toMatch(/^[0-9a-f]{64}$/)

    // The bootstrap was rehearsed before it was written.
    const bootstraps = h.jmlCalls.filter((c) => c[1] === 'bootstrap')
    expect(bootstraps.map((c) => c.includes('--armed'))).toEqual([false, true])

    expect(h.n8n.workflows.size).toBe(6)
    expect(h.n8n.credentials.size).toBe(4)

    const state = JSON.parse(readFileSync(join(dir, 'data', 'setup-state.json'), 'utf8'))
    expect(state.completed).toEqual(['prerequisites', 'configuration', 'credentials', 'doctor', 'bootstrap', 'compose', 'n8n'])
    expect(state.references).toEqual({ HIBOB_SERVICE_TOKEN: 'op://Vault/item/field' })
    // The state file holds references and ids, never a value.
    for (const secret of Object.values(SECRETS)) expect(JSON.stringify(state)).not.toContain(secret)
  })

  it('never prints a secret, including the one read from 1Password', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)))
    await setupCommand(h.io, { dir }, h.deps)
    for (const secret of Object.values(SECRETS)) expect(h.output()).not.toContain(secret)
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'))
    for (const key of ['JML_API_TOKEN', 'JML_INBOUND_WEBHOOK_TOKEN', 'N8N_FORM_PASSWORD']) expect(h.output()).not.toContain(env[key])
  })

  it('resumes: a second run asks nothing and changes nothing', async () => {
    const dir = checkout()
    await setupCommand(harness(fullRunAnswers(googleKeyFile(dir))).io, { dir }, harness(fullRunAnswers(googleKeyFile(dir))).deps)
    const before = readFileSync(join(dir, '.env'), 'utf8')
    const again = harness([])
    expect(await setupCommand(again.io, { dir }, again.deps)).toBe(0)
    expect(again.output()).toContain('done on an earlier run')
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(before)
  })

  it('--from redoes a step and those after it, and reuses the n8n credentials it made', async () => {
    const dir = checkout()
    const first = harness(fullRunAnswers(googleKeyFile(dir)))
    await setupCommand(first.io, { dir }, first.deps)
    const redo = harness(['y', SECRETS.n8nKey])
    redo.n8n.workflows.clear()
    for (const [k, v] of first.n8n.workflows) redo.n8n.workflows.set(k, v)
    expect(await setupCommand(redo.io, { dir, from: 'doctor' }, redo.deps)).toBe(0)
    expect(redo.jmlCalls[0]?.[0]).toBe('doctor')
    expect(redo.n8n.requests.filter((r) => r.url.endsWith('/api/v1/credentials'))).toEqual([])
    expect(redo.output()).toContain('already_present')
  })

  it('stops at a failing doctor when asked, and keeps what it had done', async () => {
    const dir = checkout()
    const answers = fullRunAnswers(googleKeyFile(dir)).slice(0, 22).concat(['stop'])
    const h = harness(answers, { doctorOk: false })
    expect(await setupCommand(h.io, { dir }, h.deps)).toBe(1)
    expect(h.output()).toContain('FAIL  HR system: HTTP 401')
    const state = JSON.parse(readFileSync(join(dir, 'data', 'setup-state.json'), 'utf8'))
    expect(state.completed).toEqual(['prerequisites', 'configuration', 'credentials'])
  })

  it('stops before anything is written when Docker is not running, and says how to go on without it', async () => {
    const dir = checkout()
    const h = harness([], { dockerUp: false })
    expect(await setupCommand(h.io, { dir }, h.deps)).toBe(1)
    expect(h.output()).toContain('--no-docker')
    expect(existsSync(join(dir, 'jml.config.yaml'))).toBe(false)
  })

  it('--no-docker leaves out the compose and n8n steps', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)).slice(0, -1), { dockerUp: false })
    expect(await setupCommand(h.io, { dir, noDocker: true }, h.deps)).toBe(0)
    const state = JSON.parse(readFileSync(join(dir, 'data', 'setup-state.json'), 'utf8'))
    expect(state.completed).toEqual(['prerequisites', 'configuration', 'credentials', 'doctor', 'bootstrap'])
    expect(h.n8n.requests).toEqual([])
  })

  it('--dry-run prints the plan and writes nothing', async () => {
    const dir = checkout()
    const h = harness([])
    expect(await setupCommand(h.io, { dir, dryRun: true }, h.deps)).toBe(0)
    expect(h.output()).toMatch(/1\. prerequisites[\s\S]*7\. n8n/)
    expect(readdirSync(dir).sort()).toEqual(['n8n'])
  })

  it('carrying on past a failing doctor finishes as incomplete, not complete', async () => {
    const dir = checkout()
    const answers = fullRunAnswers(googleKeyFile(dir))
    // After the credentials: carry on at doctor, then bootstrap and n8n as normal.
    const h = harness([...answers.slice(0, 22), 'continue', ...answers.slice(22)], { doctorOk: false })
    expect(await setupCommand(h.io, { dir }, h.deps)).toBe(1)
    expect(h.output()).toContain('Setup finished INCOMPLETE')
    expect(h.output()).not.toContain('Setup is complete')
    expect(JSON.parse(readFileSync(join(dir, 'data', 'setup-state.json'), 'utf8')).overrides).toEqual(['doctor'])
  })

  it('stops when jml store verify fails, rather than moving on to Docker', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)), { verifyCode: 1 })
    expect(await setupCommand(h.io, { dir }, h.deps)).toBe(1)
    expect(h.output()).toContain('jml store verify did not pass')
    const state = JSON.parse(readFileSync(join(dir, 'data', 'setup-state.json'), 'utf8'))
    expect(state.completed).not.toContain('bootstrap')
    expect(h.n8n.requests).toEqual([])
  })

  it('without Docker, a 1Password reference stays a reference and its value never reaches disk', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)).slice(0, -1), { dockerUp: false })
    expect(await setupCommand(h.io, { dir, noDocker: true }, h.deps)).toBe(0)
    expect(await getConfig(join(dir, 'jml.config.yaml'), ['hris', 'hibob', 'serviceToken'])).toBe('op://Vault/item/field')
    expect(await getConfig(join(dir, 'jml.config.yaml'), ['identity', 'jumpcloud', 'apiKey'])).toBe('env:JUMPCLOUD_API_KEY')
    const env = parseEnv(readFileSync(join(dir, '.env'), 'utf8'))
    expect(env['HIBOB_SERVICE_TOKEN'] ?? '').toBe('')
    expect(readFileSync(join(dir, '.env'), 'utf8')).not.toContain(SECRETS.hibobTokenFromOp)
  })

  it('with Docker, says plainly that values are copied into plain-text .env', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)))
    await setupCommand(h.io, { dir }, h.deps)
    expect(h.output()).toMatch(/plain text, mode 600/)
    expect(await getConfig(join(dir, 'jml.config.yaml'), ['hris', 'hibob', 'serviceToken'])).toBe('env:HIBOB_SERVICE_TOKEN')
  })

  it('a bootstrap that leaves somebody selected for offboarding finishes as incomplete', async () => {
    const dir = checkout()
    const h = harness(fullRunAnswers(googleKeyFile(dir)), { day0: 1 })
    expect(await setupCommand(h.io, { dir }, h.deps)).toBe(1)
    expect(h.output()).toContain('Setup finished INCOMPLETE')
    expect(h.output()).not.toContain('Setup is complete')
    expect(JSON.parse(readFileSync(join(dir, 'data', 'setup-state.json'), 'utf8')).overrides).toEqual(['bootstrap'])
  })

  it('moving a credential to a 1Password reference offers to remove the old plain-text value, and removes it on yes', async () => {
    const dir = checkout()
    // First run, command line only, every credential pasted or read from a file.
    const answers = fullRunAnswers(googleKeyFile(dir)).slice(0, -1)
    answers.splice(14, 2, 'paste', 'hibob-token-pasted-not-real')
    const first = harness(answers, { dockerUp: false })
    expect(await setupCommand(first.io, { dir, noDocker: true }, first.deps)).toBe(0)
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('hibob-token-pasted-not-real')

    // Redo credentials: keep all but the HiBob token, which moves to 1Password.
    const redo = harness(['keep', 'op', 'op://Vault/item/field', 'y', 'keep', 'keep', 'keep', 'y'], { dockerUp: false })
    expect(await setupCommand(redo.io, { dir, noDocker: true, from: 'credentials' }, redo.deps)).toBe(0)
    expect(await getConfig(join(dir, 'jml.config.yaml'), ['hris', 'hibob', 'serviceToken'])).toBe('op://Vault/item/field')
    const env = readFileSync(join(dir, '.env'), 'utf8')
    expect(env).not.toContain('hibob-token-pasted-not-real')
    expect(parseEnv(env)['HIBOB_SERVICE_TOKEN']).toBeUndefined()
    expect(parseEnv(env)['JUMPCLOUD_API_KEY']).toBe(SECRETS.jumpcloud)
  })

  it('says plainly that the old value stays when the operator keeps it', async () => {
    const dir = checkout()
    const answers = fullRunAnswers(googleKeyFile(dir)).slice(0, -1)
    answers.splice(14, 2, 'paste', 'hibob-token-pasted-not-real')
    const first = harness(answers, { dockerUp: false })
    await setupCommand(first.io, { dir, noDocker: true }, first.deps)
    const redo = harness(['keep', 'op', 'op://Vault/item/field', 'n', 'keep', 'keep', 'keep', 'y'], { dockerUp: false })
    await setupCommand(redo.io, { dir, noDocker: true, from: 'credentials' }, redo.deps)
    expect(redo.output()).toContain('stays in .env in plain text')
    expect(readFileSync(join(dir, '.env'), 'utf8')).toContain('hibob-token-pasted-not-real')
  })
})
