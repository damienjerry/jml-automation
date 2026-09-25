/**
 * `jml run --json` wrote a file nothing could parse.
 *
 * The console notifier printed the run summary to stdout, in front of the
 * JSON report, on the first run against a real tenant. `--json` promises that
 * stdout carries the report and nothing else, so with that flag the console
 * notifier now writes to stderr, where the log lines already go.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.ts'
import { openRuntimeFrom, type CliIo } from '../../src/cli/commands/context.ts'
import { main } from '../../src/cli/index.ts'

function document(): Record<string, unknown> {
  return {
    version: 1,
    org: { name: 'Example Organisation', primaryDomain: 'example.com', timezone: 'Europe/London', itTeamSignature: 'IT Team' },
    mail: { senderMailbox: 'it-noreply@example.com' },
    hris: { adapter: 'fixture', minPlausibleHeadcount: 5, fixture: { path: './src/cli/fixtures/demo.json' } },
    store: { adapter: 'memory' },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY' } },
    google: { serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', adminEmail: 'admin@example.com' },
    notify: { adapters: ['console'] },
    audit: { minimisePii: false },
    server: { token: 'env:JML_API_TOKEN' },
  }
}

async function runtimeWith(jsonOutput: boolean) {
  const captured = { out: [] as string[], err: [] as string[] }
  const cli: CliIo = {
    out: (text) => void captured.out.push(text),
    err: (text) => void captured.err.push(text),
    env: {},
    cwd: process.cwd(),
    jsonOutput,
  }
  const loaded = await loadConfig({ document: document(), allowMissingSecrets: true, env: {} })
  const rt = await openRuntimeFrom(loaded, { io: cli })
  return { rt, captured }
}

describe('the console notifier under --json', () => {
  it('writes to stderr, so stdout stays parseable', async () => {
    const { rt, captured } = await runtimeWith(true)
    try {
      await rt.notifier.send({ kind: 'run.summary', audience: 'it', subject: 'pipeline run ok', body: 'nothing happened' })
    } finally {
      await rt.close()
    }
    expect(captured.out).toEqual([])
    expect(captured.err.join('')).toContain('pipeline run ok')
  })

  it('still writes to stdout without the flag, where a person reads it', async () => {
    const { rt, captured } = await runtimeWith(false)
    try {
      await rt.notifier.send({ kind: 'run.summary', audience: 'it', subject: 'pipeline run ok', body: 'nothing happened' })
    } finally {
      await rt.close()
    }
    expect(captured.out.join('')).toContain('pipeline run ok')
  })

  it('is set by the CLI from the global --json flag', async () => {
    // `--help` short-circuits before any command runs, so this proves only
    // that the flag is accepted globally; the two cases above prove its effect.
    const out: string[] = []
    const code = await main(['run', '--json', '--help'], { out: (t) => void out.push(t), err: () => {}, setProcessExitCode: false })
    expect(code).toBe(0)
  })
})
