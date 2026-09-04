/**
 * `jml serve`, end to end, from a configuration file on disk.
 *
 * This is the shape a scheduler sees: a container with a configuration file
 * and an environment, a health route with no credential, and one authenticated
 * route that starts a run and hands back an id to poll.
 *
 * The configuration deliberately holds no credential value. Every secret field
 * is a reference into the environment, which is what makes the file safe to
 * commit and what this test also proves: the resolved token never appears in
 * the file, in the log or in a response.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactor } from '../../src/config/redact.ts'
import { serveCommand } from '../../src/cli/commands/serve.ts'
import type { RunReport } from '../../src/core/types.ts'

/** 32 bytes of hex, which is what `jml init` writes. */
const API_TOKEN = 'ab'.repeat(32)
/** Not a real key: the Google connector reads it lazily and this test never calls it. */
const FAKE_SERVICE_ACCOUNT = '{"client_email":"svc@example.com","private_key":"not-a-key","token_uri":"https://example.com/token"}'

const CONFIG = `
version: 1
org:
  name: Example Organisation
  primaryDomain: example.com
  timezone: Europe/London
  itTeamSignature: The IT team
mode: dry-run
armedActions: []
mail:
  senderMailbox: it-noreply@example.com
hris:
  adapter: fixture
  minPlausibleHeadcount: 3
  fixture:
    path: src/cli/fixtures/demo.json
store:
  adapter: memory
identity:
  jumpcloud:
    apiKey: env:JUMPCLOUD_API_KEY
google:
  serviceAccountJson: env:GOOGLE_SERVICE_ACCOUNT_JSON
  adminEmail: admin@example.com
notify:
  adapters:
    - console
audit:
  minimisePii: false
  jsonl:
    dir: AUDIT_DIR
server:
  token: env:JML_API_TOKEN
`

interface Started {
  port: number
  out: string
  err: string
  stop(): Promise<void>
}

async function serve(): Promise<Started> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-serve-e2e-'))
  const configPath = join(dir, 'jml.config.yaml')
  await writeFile(configPath, CONFIG.replace('AUDIT_DIR', join(dir, 'audit')), 'utf8')

  let out = ''
  let err = ''
  let stop = (): void => undefined
  const until = new Promise<void>((resolve) => {
    stop = resolve
  })

  const finished = serveCommand(
    {
      out: (text) => {
        out += text
      },
      err: (text) => {
        err += text
      },
      env: {
        JML_API_TOKEN: API_TOKEN,
        JUMPCLOUD_API_KEY: 'not-a-real-key-0123456789abcdef',
        GOOGLE_SERVICE_ACCOUNT_JSON: FAKE_SERVICE_ACCOUNT,
      },
      cwd: process.cwd(),
    },
    { configPath, bind: '127.0.0.1:0', until },
  )

  // The listening line is the only place the chosen port appears, which is
  // also what an operator reads out of `docker logs`.
  await vi.waitFor(() => {
    if (!/listening on 127\.0\.0\.1:\d+/.test(out)) throw new Error('not listening yet')
  })
  const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(out)?.[1])

  return {
    port,
    get out() {
      return out
    },
    get err() {
      return err
    },
    async stop() {
      stop()
      await finished
    },
  }
}

let running: Started | null = null

afterEach(async () => {
  if (running) await running.stop()
  running = null
  redactor.clear()
})

function url(port: number, path: string): string {
  return 'http://127.0.0.1:' + port + path
}

describe('the sidecar, from a configuration file', () => {
  it('answers health without a credential', async () => {
    running = await serve()
    const response = await fetch(url(running.port, '/v1/health'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('refuses an unauthenticated run', async () => {
    running = await serve()
    const response = await fetch(url(running.port, '/v1/runs'), { method: 'POST' })
    expect(response.status).toBe(401)
  })

  it('runs the pipeline as a dry run when the caller says nothing about it', async () => {
    running = await serve()
    const started = await fetch(url(running.port, '/v1/runs'), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + API_TOKEN,
        'content-type': 'application/json',
        'x-jml-actor': 'scheduler:nightly#7',
      },
      body: '{}',
    })
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }

    const finished = await vi.waitFor(async () => {
      const polled = await fetch(url(running?.port ?? 0, '/v1/runs/' + runId), {
        headers: { authorization: 'Bearer ' + API_TOKEN },
      })
      if (polled.status === 202) throw new Error('still running')
      return polled
    })

    expect(finished.status).toBe(200)
    const body = (await finished.json()) as { report: RunReport }
    expect(body.report.dryRun).toBe(true)
    expect(body.report.kind).toBe('pipeline')
    // The HR fixture was read, so the run really did something rather than
    // failing early.
    expect(body.report.counts.hrisPeople).toBe(7)
  })

  it('never prints the token, in the log or in a response', async () => {
    running = await serve()
    const health = await fetch(url(running.port, '/v1/health'))
    expect(await health.text()).not.toContain(API_TOKEN)
    expect(running.out).not.toContain(API_TOKEN)
    expect(running.err).not.toContain(API_TOKEN)
    // It says where to find the value rather than quoting it.
    expect(running.out).toContain('JML_API_TOKEN')
  })
})
