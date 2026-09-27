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
import { rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpClient, type HttpClient } from '../../../core/http.ts'
import { importBundle, n8nHealthy } from '../../../n8n/import.ts'
import { CliError, type CliIo } from '../context.ts'
import { CONFIG_FILE, ENV_FILE, initCommand } from '../init.ts'
import { getConfig, loadState, parseEnv, saveState, setEnv, STEPS, type SetupState, type StepName } from './files.ts'
import { terminalPrompter, type Prompter } from './prompter.ts'
import { askConfiguration, askCredentials, type Answers } from './questions.ts'
import { format, setColour, stepBanner } from './ui.ts'

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
  /**
   * Walk the whole wizard, asking every real question, in a temporary folder
   * that is deleted at the end. The steps that act (doctor, bootstrap, Docker,
   * n8n) say what they would do instead of doing it, and nothing is read from
   * 1Password. For seeing what a new user sees.
   */
  preview?: boolean
  /** Internal: set by the preview wrapper on the inner run. */
  previewing?: boolean
  /** Colour and layout for a person at a terminal. Off for tests, pipes and CI. */
  colour?: boolean
  noDocker?: boolean
  n8nUrl?: string
}

/** What each acting step would do, said in its place during a preview. */
const PREVIEW: Partial<Record<StepName, string>> = {
  doctor:
    'Here it runs jml doctor: one read per key and one per Google permission, shown as a pass or FAIL list. If anything fails you choose: fix it and test again, type the keys again, carry on anyway (setup then finishes as incomplete), or stop.',
  bootstrap:
    'Here it counts everyone in your list who has already left, and shows the numbers. It then asks whether to save them as closed records, and checks that nobody would be offboarded today, which must be 0 before anything is switched on.',
  compose: 'Here it runs docker compose up, starting the toolkit and the scheduler (n8n) on this computer, and waits until both are ready.',
  n8n: 'Here it asks for an n8n API key (in n8n: Settings, then n8n API), then adds the six scheduled jobs and the keys they use, all switched off.',
}

/** A stand-in for a 1Password read during a preview: shaped like a service account key so the key check passes. */
const PREVIEW_SECRET = JSON.stringify({
  type: 'service_account',
  client_email: 'preview-only@example.com',
  client_id: 'preview-only',
  private_key: '-----BEGIN PRIVATE KEY-----\npreview only, not a key\n-----END PRIVATE KEY-----\n',
})

const PLAN: Record<StepName, string> = {
  prerequisites: 'Checks for Node.js 22.13 or newer, and for Docker unless you chose --no-docker. Installs nothing.',
  configuration: 'Asks about your organisation, where your list of people is kept, and where summaries go. Nothing secret.',
  credentials: 'Asks for each access key the toolkit needs, says exactly what access each one must have, and saves it.',
  doctor: 'Tests every key and every Google permission with one read each. Changes nothing anywhere.',
  bootstrap: 'Records everyone who has already left as closed, so the first real run never mistakes them for new leavers. Shows you the numbers before saving. Changes nothing in Google or JumpCloud.',
  compose: 'Starts the toolkit and the scheduler (n8n) on this computer with Docker.',
  n8n: 'Adds the six scheduled jobs to n8n, all switched off until you turn them on.',
}

/** What each step is called on screen. */
const TITLE: Record<StepName, string> = {
  prerequisites: 'Check this computer',
  configuration: 'Your organisation',
  credentials: 'Access keys',
  doctor: 'Test the access',
  bootstrap: 'Record past leavers',
  compose: 'Start the services',
  n8n: 'Add the scheduled jobs',
}

export async function setupCommand(io: CliIo, opts: SetupOptions, deps?: Partial<SetupDeps>): Promise<number> {
  if (opts.preview) {
    const scratch = await mkdtemp(join(tmpdir(), 'jml-setup-preview-'))
    // Ctrl-C mid-preview must not leave typed values behind in the scratch folder.
    const onSignal = (): void => {
      rmSync(scratch, { recursive: true, force: true })
      io.out('\nPreview stopped. The temporary folder has been deleted.\n')
      process.exit(130)
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    if (opts.colour !== undefined) setColour(opts.colour)
    io.out(format('# PREVIEW: nothing you answer is kept') + '\n')
    io.out(format('~ Every question is the real one. Your answers go into a temporary folder that is deleted at the end.') + '\n')
    io.out(format('~ The steps that would change something say what they would do instead. Nothing is read from 1Password.') + '\n')
    io.out(format('~ At a secret question you can type anything: it never leaves this computer.') + '\n')
    try {
      const code = await setupCommand(io, { ...opts, preview: false, previewing: true, dir: scratch }, deps)
      io.out(format('+ Preview finished. The temporary folder has been deleted; nothing was written anywhere else.') + '\n')
      io.out(format('~ For a real setup, run ./install.sh (or jml setup) without --preview.') + '\n')
      return code === 0 ? 0 : code
    } finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await rm(scratch, { recursive: true, force: true })
    }
  }
  const previewing = Boolean(opts.previewing)
  const dir = opts.dir ?? io.cwd
  if (opts.colour !== undefined) setColour(opts.colour)
  const say = (line: string): void => io.out(format(line) + '\n')
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
        say(stepBanner(steps.indexOf(step) + 1, steps.length, TITLE[step], `done on an earlier run (jml setup --from ${step} redoes it)`))
        continue
      }
      say(stepBanner(steps.indexOf(step) + 1, steps.length, TITLE[step], PLAN[step]))
      const outcome = await runStep(step, { io, d, say, dir, configPath, envPath, state, n8nUrl, noDocker: Boolean(opts.noDocker), previewing })
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

  if (previewing) {
    say('# End of the preview')
    say('~ A real setup ends here with "Setup is complete, and nothing is switched on", and what to do next.')
    return 0
  }
  if (state.overrides.length > 0) {
    say(`# Setup finished INCOMPLETE`)
    say(`! You carried on past a failed step (${state.overrides.join(', ')}). Nothing is switched on. Fix it, then run jml setup --from ${state.overrides[0]}.`)
    return 1
  }
  say('# Setup is complete, and nothing is switched on')
  say('~ Next: open n8n, run the jml-doctor and jml-pipeline jobs once by hand, and read what they would do. Then switch them on.')
  say('~ Actions are switched on one at a time in jml.config.yaml; docs/quickstart.md, steps 10 to 12, walks through it.')
  say('~ To run the toolkit yourself on this computer:  set -a; . ./.env; set +a; node bin/jml.mjs doctor')
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
  /** A preview: acting steps describe themselves and return. */
  previewing?: boolean
}

async function runStep(step: StepName, c: Ctx): Promise<'done' | 'stop'> {
  const preview = c.previewing ? PREVIEW[step] : undefined
  if (preview) {
    c.say('~ (preview) ' + preview)
    return 'done'
  }
  switch (step) {
    case 'prerequisites': {
      const outcome = await prerequisites(c)
      if (outcome === 'stop' && c.previewing) {
        c.say('~ (preview) A real setup stops here until this is fixed. The preview carries on.')
        return 'done'
      }
      return outcome
    }
    case 'configuration': {
      if (!(await exists(c.configPath))) {
        const code = await initCommand({ ...c.io, out: () => {} }, { dir: c.dir })
        if (code !== 0) throw new CliError('jml init failed', { exitCode: code })
        c.say('+ Created jml.config.yaml and .env in this folder.')
      } else {
        c.say('~ jml.config.yaml is already here. Your answers update it, and keep everything else in it.')
      }
      await askConfiguration(c.d.prompter, c.say, c.configPath, c.envPath, { docker: !c.noDocker })
      return 'done'
    }
    case 'credentials': {
      const env = await readEnv(c.envPath)
      await askCredentials(
        { prompter: c.d.prompter, say: c.say, envPath: c.envPath, env, state: c.state, configPath: c.configPath, keepReferences: c.noDocker, opRead: (ref) => (c.previewing ? Promise.resolve({ ok: true, value: PREVIEW_SECRET, error: '' }) : opRead(c.d, ref)) },
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
    c.say(`! Node.js ${process.versions.node} is too old: 22.13 or newer is needed. Install it from https://nodejs.org, then run this again.`)
    return 'stop'
  }
  c.say(`+ Node.js ${process.versions.node}`)
  if (c.noDocker) {
    c.say('~ Docker: not used (--no-docker). The last two steps are skipped; the toolkit runs from the command line on its own.')
    return 'done'
  }
  const server = await c.d.shell('docker', ['version', '--format', '{{.Server.Version}}'])
  if (server.code !== 0) {
    c.say('! Docker is not running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, and run this again.')
    c.say('~ Or run jml setup --no-docker to set up the command line tool on its own.')
    return 'stop'
  }
  const composeV = await c.d.shell('docker', ['compose', 'version', '--short'])
  if (composeV.code !== 0) {
    c.say('! Docker Compose is missing. It comes with Docker Desktop: update Docker, then run this again.')
    return 'stop'
  }
  c.say(`+ Docker ${server.stdout.trim()}, with Compose ${composeV.stdout.trim()}`)
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
        c.say(`${row.skipped ? '~ skip' : row.ok ? '+ pass' : '! FAIL'}  ${row.name}: ${row.detail}`)
        if (!row.ok) c.say(`~       What to do: ${row.remediation ? row.remediation + ' ' : ''}See ${row.docsAnchor}.`)
      }
      if (report.ok && res.code === 0) {
        c.say('+ Every check passed.')
        c.state.overrides = c.state.overrides.filter((o) => o !== 'doctor')
        return 'done'
      }
    }
    const next = await c.d.prompter.choose('Some checks failed. What do you want to do?', [
      { value: 'retry', label: 'I have fixed it: test again' },
      { value: 'credentials', label: 'Type the keys again' },
      { value: 'continue', label: 'Carry on anyway (setup will finish as incomplete until every check passes)' },
      { value: 'stop', label: 'Stop here and come back later' },
    ], 'retry')
    if (next === 'stop') return 'stop'
    if (next === 'continue') {
      if (!c.state.overrides.includes('doctor')) c.state.overrides.push('doctor')
      return 'done'
    }
    if (next === 'credentials') {
      await askCredentials({ prompter: c.d.prompter, say: c.say, envPath: c.envPath, env: await readEnv(c.envPath), state: c.state, configPath: c.configPath, keepReferences: c.noDocker, opRead: (ref) => (c.previewing ? Promise.resolve({ ok: true, value: PREVIEW_SECRET, error: '' }) : opRead(c.d, ref)) }, await answersFromConfig(c.configPath))
    }
  }
}

async function bootstrap(c: Ctx): Promise<'done' | 'stop'> {
  const env = await readEnv(c.envPath)
  const adapter = await getConfig(c.configPath, ['store', 'adapter'])
  const where = adapter === 'notion' ? 'your Notion people database' : 'the local SQLite file'
  if (adapter === 'notion') {
    if ((await getConfig(c.configPath, ['store', 'readOnly'])) === true) {
      c.say('~ Skipped: the Notion database is read-only here, and the automation that writes to it already holds the past leavers.')
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
      c.say('~ Adding columns removes and changes nothing that is already there.')
      if (!(await c.d.prompter.confirm('Add the missing columns to the Notion database?', false))) return 'stop'
      const applied = await c.d.jml(['store', 'migrate', '--config', c.configPath, '--armed'], env)
      c.say(applied.out.trimEnd())
      if (applied.code !== 0) return 'stop'
    }
  }
  c.say('~ Everyone in your list who has already left is saved as a closed record, so the first real run never treats them as new leavers. Here are the numbers first; nothing is saved yet.')
  const rehearsal = await c.d.jml(['store', 'bootstrap', '--config', c.configPath, '--json'], env)
  const r = parseJson<{ scanned: number; tombstoned: number; skippedActive: number; skippedHired: number; day0SelectionAfter: number; warnings: string[]; ok: boolean }>(rehearsal.out)
  if (!r || rehearsal.code > 1) {
    c.say('the rehearsal did not return a report:\n' + rehearsal.out.slice(0, 2000))
    return 'stop'
  }
  c.say(`+ Read ${r.scanned} people: ${r.tombstoned} have already left, ${r.skippedActive} work here now, ${r.skippedHired ?? 0} have not started yet.`)
  for (const w of r.warnings.slice(0, 10)) c.say(`! ${w}`)
  if (!r.ok) {
    // Somebody would still be selected for offboarding. Not a reason to stop
    // writing tombstones, but the operator must see it and say yes to it.
    c.say(`! ${r.day0SelectionAfter} person(s) would still be offboarded after this. Check them with jml store verify before switching anything on.`)
  }
  if (!(await c.d.prompter.confirm(`Save the ${r.tombstoned} people who have left as closed records in ${where}? This changes nothing in Google or JumpCloud.`, r.ok))) return 'stop'
  const armed = await c.d.jml(['store', 'bootstrap', '--config', c.configPath, '--armed', '--json'], env)
  const a = parseJson<{ tombstoned: number; day0SelectionAfter: number; ok: boolean }>(armed.out)
  if (!a || armed.code > 1) {
    c.say('the bootstrap did not complete:\n' + armed.out.slice(0, 2000))
    return 'stop'
  }
  c.say(`+ Saved ${a.tombstoned} closed records. People who would be offboarded today: ${a.day0SelectionAfter}${a.day0SelectionAfter > 0 ? ' (check them with jml store verify before switching anything on)' : ''}.`)
  // People still selected for offboarding may be genuine leavers or a data
  // fault, and only a person can tell which. Either way setup is not
  // finished: it is recorded like a doctor override, so the run ends as
  // incomplete, and it clears the next time a bootstrap leaves nobody selected.
  c.state.overrides = c.state.overrides.filter((o) => o !== 'bootstrap')
  if (a.day0SelectionAfter > 0 || a.ok === false) c.state.overrides.push('bootstrap')
  const verify = await c.d.jml(['store', 'verify', '--config', c.configPath], env)
  c.say(verify.out.trimEnd())
  if (verify.code !== 0) {
    c.say('! The check (jml store verify) did not pass, so setup stops here.')
    return 'stop'
  }
  return 'done'
}

async function compose(c: Ctx): Promise<'done' | 'stop'> {
  const env = await readEnv(c.envPath)
  if (!env['JML_DRY_RUN']) await setEnv(c.envPath, 'JML_DRY_RUN', 'true')
  const up = await c.d.shell('docker', ['compose', 'up', '-d', '--build'], { inherit: true })
  if (up.code !== 0) {
    c.say('! Docker could not start the services. The lines above say why.')
    return 'stop'
  }
  for (let i = 0; i < 60; i += 1) {
    const ps = await c.d.shell('docker', ['compose', 'ps', '--format', '{{.Service}} {{.Health}}'])
    const sidecar = ps.stdout.split('\n').find((l) => l.startsWith('jml '))?.split(' ')[1] ?? ''
    const n8nUp = await n8nHealthy(c.d.http, c.n8nUrl)
    if (sidecar === 'healthy' && n8nUp) {
      c.say(`+ The toolkit is running, and n8n is at ${c.n8nUrl}`)
      return 'done'
    }
    await c.d.sleep(3_000)
  }
  c.say('! The services were not ready after three minutes. Run docker compose logs jml n8n to see why.')
  return 'stop'
}

async function n8n(c: Ctx): Promise<'done' | 'stop'> {
  c.say(`~ Open ${c.n8nUrl} in a browser. If n8n asks, create its owner account. Then go to Settings, then n8n API, and create an API key.`)
  c.say('~ The key is used only now, to add the jobs, and is not saved.')
  const apiKey = await c.d.prompter.secret('Paste the n8n API key')
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
  for (const name of report.skippedCredentials) c.say(`! No value for the n8n key "${name}": the jobs that post to Slack will fail, visibly, until you add it in n8n.`)
  for (const e of report.errors) c.say(`! ${e}`)
  c.say('~ The login for the forms in n8n is N8N_FORM_USER and N8N_FORM_PASSWORD, saved in .env.')
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
