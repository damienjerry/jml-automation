/**
 * The sidecar's routes.
 *
 * These tests are about the HTTP contract an automation tool depends on: what
 * a caller is allowed to do without a token, what happens when two runs
 * overlap, and which way an ambiguous request falls. Nothing here opens a
 * socket; the listener is tested separately.
 */

import { describe, expect, it } from 'vitest'
import type { RunReport } from '../../src/core/types.ts'
import { makeAuthoriser } from '../../src/server/http.ts'
import { handle, JobBoard, type RouteContext, type ServerEngine, type ServerRequest } from '../../src/server/routes.ts'

const TOKEN = 'a-token-long-enough-to-be-plausible-0123456789'

function report(overrides: Partial<RunReport> = {}): RunReport {
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
    ...overrides,
  }
}

function stubEngine(overrides: Partial<ServerEngine> = {}): ServerEngine {
  const notImplemented = () => Promise.reject(new Error('this test did not expect that call'))
  return {
    pipeline: async () => report(),
    leaver: async () => report({ kind: 'leaver' }),

    joiner: async () => report({ kind: 'joiner' }),

    ticketInbound: async () => ({ outcome: 'ignored' }),
    devicePreflight: notImplemented as unknown as ServerEngine['devicePreflight'],
    deviceDispose: notImplemented as unknown as ServerEngine['deviceDispose'],
    show: async () => null,
    hold: notImplemented as unknown as ServerEngine['hold'],
    release: notImplemented as unknown as ServerEngine['release'],
    ack: notImplemented as unknown as ServerEngine['ack'],
    tombstone: notImplemented as unknown as ServerEngine['tombstone'],
    doctor: notImplemented as unknown as ServerEngine['doctor'],
    ...overrides,
  }
}

function context(engine: ServerEngine, jobs = new JobBoard()): RouteContext {
  let seq = 0
  return {
    engine,
    jobs,
    authorise: makeAuthoriser({ use: (fn) => fn(TOKEN) }),
    nowIso: () => '2026-03-03T09:00:00.000Z',
    newRunId: () => 'run-' + ++seq,
  }
}

function request(method: string, path: string, opts: { body?: unknown; token?: string; actor?: string } = {}): ServerRequest {
  return {
    method,
    path,
    query: {},
    headers: {
      ...(opts.token === undefined ? { authorization: 'Bearer ' + TOKEN } : opts.token === '' ? {} : { authorization: opts.token }),
      ...(opts.actor ? { 'x-jml-actor': opts.actor } : {}),
    },
    body: opts.body === undefined ? '' : JSON.stringify(opts.body),
  }
}

describe('authentication', () => {
  it('lets nobody past without a bearer token', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('POST', '/v1/runs', { token: '' }), ctx)
    expect(answer.status).toBe(401)
    // No detail: a caller must not be able to tell "no token" from "wrong token".
    expect(answer.body).toEqual({ ok: false, error: 'unauthorised' })
  })

  it('rejects a token that shares a prefix with the real one', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('POST', '/v1/runs', { token: 'Bearer ' + TOKEN.slice(0, 20) }), ctx)
    expect(answer.status).toBe(401)
  })

  it('answers health without a token, and says nothing else', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('GET', '/v1/health', { token: '' }), ctx)
    expect(answer.status).toBe(200)
    // Exactly one field. A health route that reported versions or credential
    // state would be reconnaissance on a service that can delete accounts.
    expect(answer.body).toEqual({ ok: true })
  })
})

describe('the run lifecycle', () => {
  it('answers 202 with a run id, then 202 while running, then 200 with the report', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ctx = context(stubEngine({ pipeline: async () => { await held; return report({ runId: 'run-1' }) } }))

    const started = await handle(request('POST', '/v1/runs'), ctx)
    expect(started.status).toBe(202)
    expect(started.body).toMatchObject({ ok: true, runId: 'run-1', poll: '/v1/runs/run-1' })

    const running = await handle(request('GET', '/v1/runs/run-1'), ctx)
    expect(running.status).toBe(202)
    expect(running.body).toMatchObject({ state: 'running' })

    release()
    await ctx.jobs.idle()

    const done = await handle(request('GET', '/v1/runs/run-1'), ctx)
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ ok: true, state: 'done' })
  })

  it('records a thrown run as failed rather than leaving it running for ever', async () => {
    const ctx = context(stubEngine({ pipeline: async () => { throw new Error('the store went away') } }))
    await handle(request('POST', '/v1/runs'), ctx)
    await ctx.jobs.idle()
    const answer = await handle(request('GET', '/v1/runs/run-1'), ctx)
    expect(answer.status).toBe(500)
    expect(answer.body).toMatchObject({ state: 'failed', error: 'the store went away' })
  })

  it('answers 404 for a run id it has never heard of', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('GET', '/v1/runs/run-nobody-started'), ctx)
    expect(answer.status).toBe(404)
  })
})

describe('overlapping work', () => {
  it('answers 409 rather than starting a second run of the same kind', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ctx = context(stubEngine({ pipeline: async () => { await held; return report() } }))

    const first = await handle(request('POST', '/v1/runs'), ctx)
    const second = await handle(request('POST', '/v1/runs'), ctx)

    expect(first.status).toBe(202)
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ error: 'run_in_progress', runId: 'run-1' })

    release()
    await ctx.jobs.idle()
    // Once it is finished the next request is accepted, so an overlap is a
    // skip rather than a lock somebody has to clear.
    expect((await handle(request('POST', '/v1/runs'), ctx)).status).toBe(202)
  })

  it('answers 409 on the poll when another process held the lease', async () => {
    const ctx = context(
      stubEngine({
        pipeline: async () => report({ aborted: { reason: 'lease_held' }, warnings: ['another run holds the lease'] }),
      }),
    )
    await handle(request('POST', '/v1/runs'), ctx)
    await ctx.jobs.idle()
    const answer = await handle(request('GET', '/v1/runs/run-1'), ctx)
    expect(answer.status).toBe(409)
    expect(answer.body).toMatchObject({ error: 'lease_held', state: 'skipped' })
  })
})

describe('dry run', () => {
  it('is the default when the caller says nothing', async () => {
    const seen: boolean[] = []
    const ctx = context(
      stubEngine({
        pipeline: async (req) => {
          seen.push(req.dryRun)
          return report()
        },
      }),
    )
    await handle(request('POST', '/v1/runs'), ctx)
    await ctx.jobs.idle()
    expect(seen).toEqual([true])
  })

  it('stays a dry run when dryRun arrives as the string "false"', async () => {
    const seen: boolean[] = []
    const ctx = context(
      stubEngine({
        pipeline: async (req) => {
          seen.push(req.dryRun)
          return report()
        },
      }),
    )
    // A caller sending the wrong type gets the safe reading. This is the only
    // direction the mistake can fall in without doing something irreversible.
    await handle(request('POST', '/v1/runs', { body: { dryRun: 'false' } }), ctx)
    await ctx.jobs.idle()
    expect(seen).toEqual([true])
  })

  it('arms only on the exact boolean false', async () => {
    const seen: boolean[] = []
    const ctx = context(
      stubEngine({
        pipeline: async (req) => {
          seen.push(req.dryRun)
          return report()
        },
      }),
    )
    await handle(request('POST', '/v1/runs', { body: { dryRun: false } }), ctx)
    await ctx.jobs.idle()
    expect(seen).toEqual([false])
  })
})

describe('the actor header', () => {
  it('records a scheduled caller as a system actor, which refuses a bulk override', async () => {
    const actors: string[] = []
    const kinds: string[] = []
    const ctx = context(
      stubEngine({
        pipeline: async (req) => {
          actors.push(req.actor.id)
          kinds.push(req.actor.kind)
          return report()
        },
      }),
    )
    await handle(request('POST', '/v1/runs', { actor: 'scheduler:nightly#42' }), ctx)
    await ctx.jobs.idle()
    expect(kinds).toEqual(['system'])
    expect(actors).toEqual(['scheduler:nightly#42'])
  })

  it('records a person only when the header says so', async () => {
    const kinds: string[] = []
    const ctx = context(
      stubEngine({
        pipeline: async (req) => {
          kinds.push(req.actor.kind)
          return report()
        },
      }),
    )
    await handle(request('POST', '/v1/runs', { actor: 'human:jane.doe@example.com' }), ctx)
    await ctx.jobs.idle()
    expect(kinds).toEqual(['human'])
  })

  it('strips anything that is not printable, so the header cannot forge an audit row', async () => {
    const actors: string[] = []
    const ctx = context(
      stubEngine({
        pipeline: async (req) => {
          actors.push(req.actor.id)
          return report()
        },
      }),
    )
    await handle(request('POST', '/v1/runs', { actor: 'scheduler\n{"forged":true}' }), ctx)
    await ctx.jobs.idle()
    expect(actors[0]).not.toContain('\n')
  })
})

describe('malformed and unknown requests', () => {
  it('refuses a body that is not a JSON object', async () => {
    const ctx = context(stubEngine())
    const answer = await handle({ ...request('POST', '/v1/runs'), body: '["not an object"]' }, ctx)
    expect(answer.status).toBe(400)
  })

  it('needs a person named on a leaver run', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('POST', '/v1/leavers/run', { body: {} }), ctx)
    expect(answer.status).toBe(400)
    expect(answer.body).toMatchObject({ error: 'bad_request' })
  })

  it('needs a reason on a hold, because whoever finds the row has only that', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('POST', '/v1/leavers/hold', { body: { hrisId: 'hr-1' } }), ctx)
    expect(answer.status).toBe(400)
  })

  it('refuses a disposition it does not recognise', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(
      request('POST', '/v1/devices/disposition', { body: { systemId: 'sys-1', disposition: 'wipe_it' } }),
      ctx,
    )
    expect(answer.status).toBe(400)
  })

  it('answers 404 for a route that does not exist', async () => {
    const ctx = context(stubEngine())
    const answer = await handle(request('GET', '/v1/everything'), ctx)
    expect(answer.status).toBe(404)
  })
})

describe('device routes', () => {
  it('runs a preflight asynchronously, because reading a machine is not instant', async () => {
    const asked: string[] = []
    const ctx = context(
      stubEngine({
        devicePreflight: (async (req: { systemId: string }) => {
          asked.push(req.systemId)
          return { systemId: req.systemId, refusals: [], warnings: [], dryRun: true } as never
        }) as unknown as ServerEngine['devicePreflight'],
      }),
    )
    const answer = await handle(request('POST', '/v1/devices/preflight', { body: { systemId: 'sys-1', disposition: 'handover' } }), ctx)
    expect(answer.status).toBe(202)
    await ctx.jobs.idle()
    expect(asked).toEqual(['sys-1'])
  })

  it('never assumes the encryption key may be destroyed', async () => {
    const acknowledgements: (boolean | undefined)[] = []
    const ctx = context(
      stubEngine({
        deviceDispose: (async (req: { acknowledgeFdeKeyLoss?: boolean }) => {
          acknowledgements.push(req.acknowledgeFdeKeyLoss)
          return { ok: true, warnings: [] } as never
        }) as unknown as ServerEngine['deviceDispose'],
      }),
    )
    await handle(request('POST', '/v1/devices/disposition', { body: { systemId: 'sys-1', disposition: 'handover' } }), ctx)
    await ctx.jobs.idle()
    // Deleting a device record destroys the disk-encryption key the provider
    // holds for it, so silence has to mean no.
    expect(acknowledgements).toEqual([false])
  })
})
