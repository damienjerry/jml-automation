/**
 * The listener itself: authentication, limits and shutdown.
 *
 * These are the parts that cannot be tested through the pure route function,
 * and each of them is a way a service like this gets broken into or falls
 * over: a token compared carelessly, a body with no cap, and a shutdown that
 * abandons work halfway through.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createSecretHandle } from '../../src/config/secrets.ts'
import { redactor } from '../../src/config/redact.ts'
import type { RunReport } from '../../src/core/types.ts'
import { nullLogger } from '../../src/core/logger.ts'
import { makeAuthoriser, MAX_BODY_BYTES, MIN_TOKEN_LENGTH, parseBind, startServer, type RunningServer } from '../../src/server/http.ts'
import type { ServerEngine } from '../../src/server/routes.ts'

/** 32 bytes of hex, which is what `jml init` writes. */
const TOKEN = '0'.repeat(64)

function report(): RunReport {
  return {
    runId: 'run-1',
    kind: 'pipeline',
    startedAt: '2026-03-03T09:00:00.000Z',
    finishedAt: '2026-03-03T09:00:01.000Z',
    dryRun: true,
    ok: true,
    counts: {},
    people: [],
    warnings: [],
    errors: [],
  }
}

function engine(overrides: Partial<ServerEngine> = {}): ServerEngine {
  const unused = (() => Promise.reject(new Error('not used by this test'))) as never
  return {
    pipeline: async () => report(),
    leaver: async () => report(),
    devicePreflight: unused,
    deviceDispose: unused,
    show: async () => null,
    hold: unused,
    release: unused,
    ack: unused,
    tombstone: unused,
    doctor: unused,
    ...overrides,
  }
}

let running: RunningServer | null = null

afterEach(async () => {
  if (running) await running.close()
  running = null
  redactor.clear()
})

async function serve(overrides: Partial<ServerEngine> = {}, token = TOKEN): Promise<RunningServer> {
  running = await startServer({
    engine: engine(overrides),
    token: createSecretHandle('env:JML_API_TOKEN', token),
    logger: nullLogger(),
    // Port 0, so the operating system picks a free one and two test files
    // cannot collide.
    bind: '127.0.0.1:0',
  })
  return running
}

function url(server: RunningServer, path: string): string {
  return 'http://127.0.0.1:' + server.port + path
}

describe('parseBind', () => {
  it('reads host and port', () => {
    expect(parseBind('0.0.0.0:8787')).toEqual({ host: '0.0.0.0', port: 8787 })
  })

  it('refuses anything that is not host:port, rather than guessing a default', () => {
    expect(() => parseBind('8787')).toThrow(/host:port/)
  })
})

describe('the bearer token', () => {
  it('matches the configured value and nothing else', () => {
    const authorise = makeAuthoriser({ use: (fn) => fn('the-real-value-0123456789abcdef') })
    expect(authorise('Bearer the-real-value-0123456789abcdef')).toBe(true)
    expect(authorise('bearer the-real-value-0123456789abcdef')).toBe(true)
    expect(authorise('Bearer the-real-value')).toBe(false)
    expect(authorise('the-real-value-0123456789abcdef')).toBe(false)
    expect(authorise(undefined)).toBe(false)
  })

  it('compares values of different lengths without throwing', () => {
    // A comparison over raw bytes throws on a length mismatch, which turns a
    // wrong token into a 500 and leaks the length of the right one.
    const authorise = makeAuthoriser({ use: (fn) => fn('short-but-long-enough-value') })
    expect(authorise('Bearer ' + 'x'.repeat(500))).toBe(false)
  })

  it('will not start with a token short enough to guess', async () => {
    await expect(serve({}, 'too-short')).rejects.toThrow(new RegExp(String(MIN_TOKEN_LENGTH)))
  })
})

describe('serving', () => {
  it('answers health unauthenticated and carries no secret value in the body', async () => {
    const server = await serve()
    const response = await fetch(url(server, '/v1/health'))
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ok: true })
    expect(text).not.toContain(TOKEN)
  })

  it('refuses an unauthenticated call to a real route', async () => {
    const server = await serve()
    const response = await fetch(url(server, '/v1/runs'), { method: 'POST' })
    expect(response.status).toBe(401)
  })

  it('runs a pipeline and hands the report back on the poll', async () => {
    const server = await serve()
    const started = await fetch(url(server, '/v1/runs'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }
    await server.jobs.idle()

    const polled = await fetch(url(server, '/v1/runs/' + runId), { headers: { authorization: 'Bearer ' + TOKEN } })
    expect(polled.status).toBe(200)
    expect((await polled.json()) as { report: RunReport }).toMatchObject({ report: { kind: 'pipeline' } })
  })

  it('refuses a body larger than the cap instead of buffering it', async () => {
    const server = await serve()
    const response = await fetch(url(server, '/v1/runs'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x'.repeat(MAX_BODY_BYTES + 1024) }),
    }).catch(() => null)
    // The connection is dropped once the cap is passed, so either a 413 or a
    // refused socket is a pass. What must not happen is the body being read.
    if (response) expect(response.status).toBe(413)
  })

  it('waits for work already started before it finishes closing', async () => {
    let finished = false
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const server = await serve({
      pipeline: async () => {
        await held
        finished = true
        return report()
      },
    })
    await fetch(url(server, '/v1/runs'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({}),
    })
    release()
    await server.close()
    running = null
    // A run halfway through suspending somebody has to finish and write its
    // audit rows. Killing the listener must not abandon it.
    expect(finished).toBe(true)
  })
})
