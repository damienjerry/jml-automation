/**
 * `jml setup`: from a fresh clone to a scheduled first dry run.
 *
 * It is the sixteen-step quickstart as one resumable session. Every step calls
 * something that already exists (`init`, `doctor`, `store bootstrap`, `store
 * verify`, Docker Compose, the n8n importer), so the wizard adds prompts and
 * ordering, not a second implementation of anything.
 *
 * Three properties it keeps:
 *
 *  - Nothing is armed. The configuration it writes is `mode: dry-run` with an
 *    empty `armedActions`, the n8n workflows are created inactive, and the one
 *    write it makes to your own data, the tombstone bootstrap, is shown as a
 *    rehearsal and needs a yes.
 *  - Nothing secret is printed. Credential prompts do not echo, values go to
 *    `.env` only, and what is reported back is a length.
 *  - Every network destination is one you configured: your HR system, identity
 *    provider, Google, Notion and Slack through `jml doctor`; your own n8n on
 *    this machine; and whatever Docker pulls to build the images. There is no
 *    telemetry and nothing else is contacted.
 *
 * Progress is kept in `data/setup-state.json`, so a run that stops half way
 * resumes where it stopped. `--from <step>` redoes a step and everything after.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHttpClient, type HttpClient } from '../../../core/http.ts'
import { importBundle, n8nHealthy } from '../../../n8n/import.ts'
import { CliError, type CliIo } from '../context.ts'
import { CONFIG_FILE, ENV_FILE, initCommand } from '../init.ts'
import { getConfig, loadState, parseEnv, saveState, setEnv, STEPS, type SetupState, type StepName } from './files.ts'
import { terminalPrompter, type Prompter } from './prompter.ts'
import { askConfiguration, askCredentials, type Answers } from './questions.ts'

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
}

export interface SetupDeps {
  prompter: Prompter
  /** Run a `jml` command in-process. */
  jml(argv: string[], env: Record<string, string>): Promise<{ code: number; out: string }>
  /** Run a program. `inherit` shows its output live; otherwise it is captured and never printed. */
  shell(cmd: string, args: string[], opts?: { inherit?: boolean; env?: Record<string, string> }): Promise<ShellResult>
  http: HttpClient
  sleep(ms: number): Promise<void>
}

export interface SetupOptions {
  dir?: string
  from?: string
  dryRun?: boolean
  noDocker?: boolean
  n8nUrl?: string
}

const PLAN: Record<StepName, string> = {
  prerequisites: 'check Node 22.13+, and Docker with Compose unless --no-docker',
  configuration: 'write jml.config.yaml (jml init) and ask for your organisation, HR system, store and notifications',
  credentials: 'ask for each credential, show its minimum access, and write the values to .env (mode 600)',
  doctor: 'run jml doctor until every credential and scope passes',
  bootstrap: 'rehearse importing your HR history as tombstones, then do it on a yes, then jml store verify',
  compose: 'docker compose up -d --build, and wait for the sidecar and n8n to report healthy',
  n8n: 'ask for an n8n API key, create the four n8n credentials and import the six workflows, all inactive',
}

export async function setupCommand(io: CliIo, opts: SetupOptions, deps?: Partial<SetupDeps>): Promise<number> {
  const dir = opts.dir ?? io.cwd
  const say = (line: string): void => io.out(line + '\n')
  const configPath = join(dir, CONFIG_FILE)
  const envPath = join(dir, ENV_FILE)
  const statePath = join(dir, 'data', 'setup-state.json')
  const n8nUrl = (opts.n8nUrl ?? 'http://127.0.0.1:5678').replace(/\/+$/, '')

  if (opts.from && !(STEPS as readonly string[]).includes(opts.from)) {
    throw new CliError(`--from must be one of: ${STEPS.join(', ')}`, { exitCode: 2 })
  }
  const steps = STEPS.filter((s) => !(opts.noDocker && (s === 'compose' || s === 'n8n')))

  if (opts.dryRun) {
    say('\njml setup would do this, in order, and writes nothing now:\n')
    steps.forEach((s, i) => say(`  ${i + 1}. ${s}: ${PLAN[s]}`))
    say('\nFiles it writes: jml.config.yaml, .env, data/setup-state.json, the local people store and audit log.')
    say('Network: the services you configure (via jml doctor), n8n on this machine, and Docker image pulls. Nothing else.\n')
    return 0
  }

  const d: SetupDeps = {
    prompter: deps?.prompter ?? terminalPrompter(),
    jml: deps?.jml ?? defaultJml(dir),
    shell: deps?.shell ?? defaultShell(dir),
    http: deps?.http ?? createHttpClient({ maxRetries: 0 }),
    sleep: deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  }
  const state = await loadState(statePath)
  if (opts.from) state.completed = state.completed.filter((s) => STEPS.indexOf(s) < STEPS.indexOf(opts.from as StepName))

  try {
    for (const step of steps) {
      if (state.completed.includes(step)) {
        say(`\n= ${step}: done on an earlier run (--from ${step} to redo it)`)
        continue
      }
      say(`\n= ${step}: ${PLAN[step]}`)
      const outcome = await runStep(step, { io, d, say, dir, configPath, envPath, state, n8nUrl, noDocker: Boolean(opts.noDocker) })
      if (outcome === 'stop') {
        await saveState(statePath, state)
        say(`\nstopped at ${step}. Run jml setup again to carry on from here.`)
        return 1
      }
      state.completed.push(step)
      await saveState(statePath, state)
    }
  } finally {
    d.prompter.close()
  }

  if (state.overrides.length > 0) {
    say(`\nSetup finished INCOMPLETE: you carried on past ${state.overrides.join(', ')}. Nothing is armed. Fix it and run jml setup --from ${state.overrides[0]}.`)
    return 1
  }
  say('\nSetup is complete, and nothing is armed.')
  say('  Next: open n8n, run jml-doctor and jml-pipeline once by hand, read what they would do, then activate them.')
  say('  Arming happens one action at a time in jml.config.yaml; docs/quickstart.md sections 10 to 12 walk through it.')
  say('  To run jml yourself on this machine:  set -a; . ./.env; set +a; node bin/jml.mjs doctor')
  return 0
}

interface Ctx {
  io: CliIo
  d: SetupDeps
  say(line: string): void
  dir: string
  configPath: string
  envPath: string
  state: SetupState
  n8nUrl: string
  noDocker: boolean
}

async function runStep(step: StepName, c: Ctx): Promise<'done' | 'stop'> {
  switch (step) {
    case 'prerequisites':
      return prerequisites(c)
    case 'configuration': {
      if (!(await exists(c.configPath))) {
        const code = await initCommand({ ...c.io, out: () => {} }, { dir: c.dir })
        if (code !== 0) throw new CliError('jml init failed', { exitCode: code })
        c.say('wrote jml.config.yaml and .env with a random sidecar token and audit salt')
      } else {
        c.say('jml.config.yaml exists; answering these questions updates it in place and keeps its comments')
      }
      await askConfiguration(c.d.prompter, c.say, c.configPath, c.envPath)
      return 'done'
    }
    case 'credentials': {
      const env = await readEnv(c.envPath)
      await askCredentials(
        { prompter: c.d.prompter, say: c.say, envPath: c.envPath, env, state: c.state, configPath: c.configPath, keepReferences: c.noDocker, opRead: (ref) => opRead(c.d, ref) },
        await answersFromConfig(c.configPath),
      )
      return 'done'
    }
    case 'doctor':
      return doctor(c)
    case 'bootstrap':
      return bootstrap(c)
    case 'compose':
      return compose(c)
    case 'n8n':
      return n8n(c)
  }
}

async function prerequisites(c: Ctx): Promise<'done' | 'stop'> {
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number]
  if (major < 22 || (major === 22 && minor < 13)) {
    c.say(`Node ${process.versions.node} is too old; 22.13 or newer is needed. On a Mac: brew install node@22`)
    return 'stop'
  }
  c.say(`node ${process.versions.node}: ok`)
  if (c.noDocker) {
    c.say('docker: skipped (--no-docker). The compose and n8n steps will not run; the CLI works on its own.')
    return 'done'
  }
  const server = await c.d.shell('docker', ['version', '--format', '{{.Server.Version}}'])
  if (server.code !== 0) {
    c.say('docker: not running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, and run jml setup again.')
    c.say('  Or run jml setup --no-docker to set up the CLI alone.')
    return 'stop'
  }
  const composeV = await c.d.shell('docker', ['compose', 'version', '--short'])
  if (composeV.code !== 0) {
    c.say('docker compose: not available. Docker Desktop ships it; update Docker and run jml setup again.')
    return 'stop'
  }
  c.say(`docker ${server.stdout.trim()}, compose ${composeV.stdout.trim()}: ok`)
  return 'done'
}

async function doctor(c: Ctx): Promise<'done' | 'stop'> {
  for (;;) {
    const env = await readEnv(c.envPath)
    const res = await c.d.jml(['doctor', '--config', c.configPath, '--json'], env)
    let report: { ok: boolean; rows: { name: string; ok: boolean; skipped?: boolean; detail: string; docsAnchor: string; remediation?: string }[] } | null = null
    try {
      report = JSON.parse(res.out)
    } catch {
      report = null
    }
    if (!report) {
      c.say('jml doctor did not return a report:\n' + res.out.slice(0, 2000))
    } else {
      for (const row of report.rows) {
        c.say(`  ${row.skipped ? 'skip' : row.ok ? 'pass' : 'FAIL'}  ${row.name}: ${row.detail}`)
        if (!row.ok) c.say(`        ${row.remediation ? row.remediation + ' ' : ''}see ${row.docsAnchor}`)
      }
      if (report.ok && res.code === 0) {
        c.say('every check passed')
        c.state.overrides = c.state.overrides.filter((o) => o !== 'doctor')
        return 'done'
      }
    }
    const next = await c.d.prompter.choose('Not every check passed.', [
      { value: 'retry', label: 'fix it (for example in the Google Admin console) and check again' },
      { value: 'credentials', label: 'enter the credentials again' },
      { value: 'continue', label: 'carry on anyway (recorded: setup will finish as incomplete until doctor passes)' },
      { value: 'stop', label: 'stop here and come back later' },
    ], 'retry')
    if (next === 'stop') return 'stop'
    if (next === 'continue') {
      if (!c.state.overrides.includes('doctor')) c.state.overrides.push('doctor')
      return 'done'
    }
    if (next === 'credentials') {
      await askCredentials({ prompter: c.d.prompter, say: c.say, envPath: c.envPath, env: await readEnv(c.envPath), state: c.state, configPath: c.configPath, keepReferences: c.noDocker, opRead: (ref) => opRead(c.d, ref) }, await answersFromConfig(c.configPath))
    }
  }
}

async function bootstrap(c: Ctx): Promise<'done' | 'stop'> {
  const env = await readEnv(c.envPath)
  const adapter = await getConfig(c.configPath, ['store', 'adapter'])
  const where = adapter === 'notion' ? 'your Notion people database' : 'the local SQLite file'
  if (adapter === 'notion') {
    if ((await getConfig(c.configPath, ['store', 'readOnly'])) === true) {
      c.say('The Notion store is read-only, so there is nothing to bootstrap: the automation that owns the database already holds its leavers. Skipped.')
      return 'done'
    }
    // The only schema change this toolkit makes to a Notion database, shown before it happens.
    const plan = await c.d.jml(['store', 'migrate', '--config', c.configPath], env)
    if (plan.code !== 0) {
      c.say('could not read the Notion database schema:\n' + plan.out.slice(0, 2000))
      return 'stop'
    }
    c.say(plan.out.trimEnd())
    if (!/already has every mapped property/.test(plan.out)) {
      if (!(await c.d.prompter.confirm('Add those properties to the Notion database? Nothing is removed or retyped.', false))) return 'stop'
      const applied = await c.d.jml(['store', 'migrate', '--config', c.configPath, '--armed'], env)
      c.say(applied.out.trimEnd())
      if (applied.code !== 0) return 'stop'
    }
  }
  c.say('Every person the HR system lists as not employed becomes a tombstone, so the first real run cannot mistake a historic leaver for a new one.')
  const rehearsal = await c.d.jml(['store', 'bootstrap', '--config', c.configPath, '--json'], env)
  const r = parseJson<{ scanned: number; tombstoned: number; skippedActive: number; skippedHired: number; day0SelectionAfter: number; warnings: string[]; ok: boolean }>(rehearsal.out)
  if (!r || rehearsal.code > 1) {
    c.say('the rehearsal did not return a report:\n' + rehearsal.out.slice(0, 2000))
    return 'stop'
  }
  c.say(`  rehearsal: ${r.scanned} people read, ${r.tombstoned} would become tombstones, ${r.skippedActive} employed and ${r.skippedHired ?? 0} not yet started left alone`)
  for (const w of r.warnings.slice(0, 10)) c.say(`  warning: ${w}`)
  if (!r.ok) {
    // Somebody would still be selected for offboarding. Not a reason to stop
    // writing tombstones, but the operator must see it and say yes to it.
    c.say(`  ${r.day0SelectionAfter} person(s) would still be selected for offboarding after the bootstrap. Read them with jml store verify before arming anything.`)
  }
  if (!(await c.d.prompter.confirm(`Write those tombstones to ${where}?`, r.ok))) return 'stop'
  const armed = await c.d.jml(['store', 'bootstrap', '--config', c.configPath, '--armed', '--json'], env)
  const a = parseJson<{ tombstoned: number; day0SelectionAfter: number; ok: boolean }>(armed.out)
  if (!a || armed.code > 1) {
    c.say('the bootstrap did not complete:\n' + armed.out.slice(0, 2000))
    return 'stop'
  }
  c.say(`  wrote ${a.tombstoned} tombstones; ${a.day0SelectionAfter} people would start offboarding today${a.day0SelectionAfter > 0 ? ' (read them with jml store verify before arming anything)' : ''}`)
  // People still selected for offboarding may be genuine leavers or a data
  // fault, and only a person can tell which. Either way setup is not
  // finished: it is recorded like a doctor override, so the run ends as
  // incomplete, and it clears the next time a bootstrap leaves nobody selected.
  c.state.overrides = c.state.overrides.filter((o) => o !== 'bootstrap')
  if (a.day0SelectionAfter > 0 || a.ok === false) c.state.overrides.push('bootstrap')
  const verify = await c.d.jml(['store', 'verify', '--config', c.configPath], env)
  c.say(verify.out.trimEnd())
  if (verify.code !== 0) {
    c.say('jml store verify did not pass, so setup stops here.')
    return 'stop'
  }
  return 'done'
}

async function compose(c: Ctx): Promise<'done' | 'stop'> {
  const env = await readEnv(c.envPath)
  if (!env['JML_DRY_RUN']) await setEnv(c.envPath, 'JML_DRY_RUN', 'true')
  const up = await c.d.shell('docker', ['compose', 'up', '-d', '--build'], { inherit: true })
  if (up.code !== 0) {
    c.say('docker compose up failed; the output above says why.')
    return 'stop'
  }
  for (let i = 0; i < 60; i += 1) {
    const ps = await c.d.shell('docker', ['compose', 'ps', '--format', '{{.Service}} {{.Health}}'])
    const sidecar = ps.stdout.split('\n').find((l) => l.startsWith('jml '))?.split(' ')[1] ?? ''
    const n8nUp = await n8nHealthy(c.d.http, c.n8nUrl)
    if (sidecar === 'healthy' && n8nUp) {
      c.say(`sidecar healthy, n8n answering on ${c.n8nUrl}`)
      return 'done'
    }
    await c.d.sleep(3_000)
  }
  c.say('the containers did not report healthy within three minutes. docker compose logs jml n8n shows why.')
  return 'stop'
}

async function n8n(c: Ctx): Promise<'done' | 'stop'> {
  c.say(`Open ${c.n8nUrl} in a browser. Create the owner account if n8n asks, then go to Settings, n8n API, and create an API key.`)
  c.say('The key is used for this import only and is not saved.')
  const apiKey = await c.d.prompter.secret('n8n API key')
  if (!apiKey) return 'stop'

  // Generated once and kept, like the sidecar token, so a re-run does not
  // break a ticketing tool or a form login that already uses them.
  let env = await readEnv(c.envPath)
  if (!env['JML_INBOUND_WEBHOOK_TOKEN']) await setEnv(c.envPath, 'JML_INBOUND_WEBHOOK_TOKEN', randomBytes(32).toString('hex'))
  if (!env['N8N_FORM_USER']) await setEnv(c.envPath, 'N8N_FORM_USER', 'jml')
  if (!env['N8N_FORM_PASSWORD']) await setEnv(c.envPath, 'N8N_FORM_PASSWORD', randomBytes(18).toString('base64url'))
  env = await readEnv(c.envPath)
  const token = env['JML_API_TOKEN']
  if (!token) throw new CliError('.env has no JML_API_TOKEN; run jml setup --from configuration', { exitCode: 78 })

  const report = await importBundle({
    http: c.d.http,
    baseUrl: c.n8nUrl,
    apiKey,
    bundleDir: join(c.dir, 'n8n', 'workflows'),
    values: {
      apiToken: token,
      inboundToken: env['JML_INBOUND_WEBHOOK_TOKEN'] ?? '',
      formUser: env['N8N_FORM_USER'] ?? 'jml',
      formPassword: env['N8N_FORM_PASSWORD'] ?? '',
      slackBotToken: env['SLACK_BOT_TOKEN'] ?? null,
    },
    knownCredentialIds: c.state.n8nCredentialIds,
    log: c.say,
  })
  for (const [name, cred] of Object.entries(report.credentials)) if (cred) c.state.n8nCredentialIds[name] = cred.id
  for (const wf of report.workflows) c.say(`  ${wf.state.padEnd(15)} ${wf.name}${wf.detail ? '  ' + wf.detail : ''}`)
  for (const name of report.skippedCredentials) c.say(`  no value for credential "${name}"; the workflows that post to Slack will fail visibly until you add it in n8n`)
  for (const e of report.errors) c.say(`  error: ${e}`)
  c.say('The form login is N8N_FORM_USER / N8N_FORM_PASSWORD in .env. The ticketing tool sends JML_INBOUND_WEBHOOK_TOKEN as a bearer token.')
  return report.ok ? 'done' : 'stop'
}

async function answersFromConfig(configPath: string): Promise<Answers> {
  const rawHris = await getConfig(configPath, ['hris', 'adapter'])
  const hris = rawHris === 'hibob' || rawHris === 'csv' || rawHris === 'sheet' ? rawHris : 'fixture'
  const identity = (await getConfig(configPath, ['identity', 'adapter'])) === 'none' ? 'none' : 'jumpcloud'
  const store = (await getConfig(configPath, ['store', 'adapter'])) === 'notion' ? 'notion' : 'sqlite'
  const adapters = await getConfig(configPath, ['notify', 'adapters'])
  return { identity, hris, store, slack: Array.isArray(adapters) && adapters.includes('slack') }
}

async function opRead(d: SetupDeps, ref: string): Promise<{ ok: boolean; value: string; error: string }> {
  const r = await d.shell('op', ['read', '--no-newline', ref])
  return { ok: r.code === 0, value: r.stdout, error: r.stderr.split('\n')[0] ?? '' }
}

async function readEnv(path: string): Promise<Record<string, string>> {
  try {
    return parseEnv(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function defaultJml(dir: string): SetupDeps['jml'] {
  return async (argv, env) => {
    // Imported lazily: the CLI entry imports this module through the registry.
    const { main } = await import('../../index.ts')
    let out = ''
    const code = await main(argv, { out: (t) => (out += t), err: () => {}, env: { ...process.env, ...env }, cwd: dir, setProcessExitCode: false })
    return { code, out }
  }
}

function defaultShell(dir: string): SetupDeps['shell'] {
  return (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd: dir, env: { ...process.env, ...(opts.env ?? {}) }, stdio: opts.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (b) => (stdout += String(b)))
      child.stderr?.on('data', (b) => (stderr += String(b)))
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
}
