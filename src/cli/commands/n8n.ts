/**
 * `jml n8n scrub | import`.
 *
 * The workflow bundle is a set of hand-authored JSON files, and an export
 * taken back out of a running automation tool carries things that must never
 * be committed: credential ids, node uuids, and static data holding the real
 * people the workflow last ran against. Scrubbing is therefore part of the
 * contribution path rather than an afterthought.
 *
 * Both actions run the scripts that ship beside the workflows rather than
 * reimplementing them here. There is exactly one definition of what a clean
 * export looks like, and it is the one the continuous integration job runs; a
 * second copy inside the CLI would drift from it and start passing files the
 * build rejects.
 */

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHttpClient, type HttpClient } from '../../core/http.ts'
import { importBundle } from '../../n8n/import.ts'
import { CliError, type CliIo } from './context.ts'
import { loadState, parseEnv, saveState } from './setup/files.ts'

/** The scripts this command drives, relative to the repository root. */
export const N8N_SCRIPTS: Record<'scrub' | 'validate', string> = {
  scrub: join('n8n', 'scrub-export.mjs'),
  validate: join('n8n', 'validate.mjs'),
}

export interface N8nCommandOptions {
  action: 'scrub'
  /** Everything after the subcommand, passed through untouched. */
  rest: readonly string[]
  dir?: string
}

export async function n8nCommand(io: CliIo, opts: N8nCommandOptions): Promise<number> {
  const root = opts.dir ?? io.cwd
  const script = join(root, N8N_SCRIPTS[opts.action])
  try {
    await access(script, constants.R_OK)
  } catch {
    // Two different causes, and the operator cannot tell them apart from
    // here: they are running from an installed package rather than a clone,
    // or this release does not ship that script at all.
    throw new CliError(
      'cannot find ' +
        N8N_SCRIPTS[opts.action] +
        '. These scripts live in the repository rather than in the installed package, so run this from a ' +
        'clone. If the file is not in your checkout either, this release does not ship it and the workflow ' +
        'bundle documents doing that step by hand.',
      { exitCode: 2, docsAnchor: 'n8n/README.md' },
    )
  }
  return runNode(io, script, opts.rest)
}

/**
 * Run a script and pass its exit code straight through.
 *
 * `stdio: inherit` on purpose: the validator's output is what the operator
 * needs to read, and buffering it here would mean losing it if this process
 * were interrupted.
 */
function runNode(io: CliIo, script: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', cwd: io.cwd })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 70))
  })
}

/**
 * `jml n8n import`: the importer without the wizard around it.
 *
 * Non-interactive, so it can be run again after an n8n rebuild: the API key
 * comes from N8N_API_KEY, the credential values from `.env`, and credential
 * ids from an earlier run from `data/setup-state.json`, so nothing is created
 * twice.
 */
export async function n8nImportCommand(io: CliIo, opts: { url?: string; dir?: string }, http: HttpClient = createHttpClient({ maxRetries: 0 })): Promise<number> {
  const root = opts.dir ?? io.cwd
  const apiKey = io.env['N8N_API_KEY']
  if (!apiKey) throw new CliError('set N8N_API_KEY to an n8n API key (Settings, n8n API) and run this again', { exitCode: 2 })
  let env: Record<string, string> = {}
  try {
    env = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  } catch {
    env = {}
  }
  const pick = (k: string): string => io.env[k] ?? env[k] ?? ''
  if (!pick('JML_API_TOKEN')) throw new CliError('no JML_API_TOKEN in the environment or .env; run jml init or jml setup first', { exitCode: 78 })
  for (const k of ['JML_INBOUND_WEBHOOK_TOKEN', 'N8N_FORM_USER', 'N8N_FORM_PASSWORD']) {
    if (!pick(k)) throw new CliError(`no ${k} in .env; jml setup generates it, or set it yourself`, { exitCode: 78 })
  }
  const statePath = join(root, 'data', 'setup-state.json')
  const state = await loadState(statePath)
  const report = await importBundle({
    http,
    baseUrl: opts.url ?? io.env['N8N_URL'] ?? 'http://127.0.0.1:5678',
    apiKey,
    bundleDir: join(root, 'n8n', 'workflows'),
    values: {
      apiToken: pick('JML_API_TOKEN'),
      inboundToken: pick('JML_INBOUND_WEBHOOK_TOKEN'),
      formUser: pick('N8N_FORM_USER'),
      formPassword: pick('N8N_FORM_PASSWORD'),
      slackBotToken: pick('SLACK_BOT_TOKEN') || null,
    },
    knownCredentialIds: state.n8nCredentialIds,
    log: (line) => io.out(line + '\n'),
  })
  for (const [name, cred] of Object.entries(report.credentials)) if (cred) state.n8nCredentialIds[name] = cred.id
  await saveState(statePath, state)
  for (const wf of report.workflows) io.out(`${wf.state.padEnd(15)} ${wf.name}${wf.detail ? '  ' + wf.detail : ''}\n`)
  for (const e of report.errors) io.err(`error: ${e}\n`)
  return report.ok ? 0 : 1
}
