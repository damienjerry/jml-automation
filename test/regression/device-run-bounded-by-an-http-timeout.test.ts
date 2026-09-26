/**
 * Prevents: a long device step being bounded by the caller's HTTP timeout.
 *
 * A device hand-over holds a command association for two minutes, waits up to
 * ten for a receipt, and then confirms the agents have gone quiet for another
 * ten. That is longer than any scheduler's HTTP node will wait, and the
 * failure mode is nasty rather than merely annoying: the caller times out, the
 * run is recorded as failed, somebody retries it, and now two runs are
 * attaching and detaching the same command on the same machine. In the estate
 * this was ported from, a device left attached to a command was swept up by
 * every later run of it, and a laptop was restarted repeatedly by a job that
 * had nothing to do with it.
 *
 * So no route waits for work. Starting a run answers immediately with a run
 * id, and the caller polls.
 */

import { describe, expect, it } from 'vitest'
import { handle, JobBoard, type RouteContext, type ServerEngine } from '../../src/server/routes.ts'

function context(engine: Partial<ServerEngine>): RouteContext {
  const unused = (() => Promise.reject(new Error('not used'))) as never
  return {
    engine: {
      pipeline: unused,
      leaver: unused,
      joiner: unused,
      ticketInbound: unused,
      devicePreflight: unused,
      deviceDispose: unused,
      show: async () => null,
      hold: unused,
      release: unused,
      ack: unused,
      tombstone: unused,
      doctor: unused,
      ...engine,
    },
    jobs: new JobBoard(),
    authorise: () => true,
    nowIso: () => '2026-03-03T09:00:00.000Z',
    newRunId: () => 'run-1',
  }
}

function post(path: string, body: unknown) {
  return { method: 'POST', path, query: {}, headers: {}, body: JSON.stringify(body) }
}

describe('a device disposition that takes minutes', () => {
  it('answers straight away and reports itself as running', async () => {
    let release = (): void => undefined
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    const ctx = context({
      deviceDispose: (async () => {
        await finished
        return { ok: true, recordDeleted: false, warnings: [] } as never
      }) as unknown as ServerEngine['deviceDispose'],
    })

    const started = await handle(post('/v1/devices/disposition', { systemId: 'sys-1', disposition: 'handover' }), ctx)

    // 202 with a run id, before the work is anywhere near done.
    expect(started.status).toBe(202)
    expect(started.body).toMatchObject({ runId: 'run-1', poll: '/v1/runs/run-1' })

    const polled = await handle({ method: 'GET', path: '/v1/runs/run-1', query: {}, headers: {}, body: '' }, ctx)
    expect(polled.status).toBe(202)
    expect(polled.body).toMatchObject({ state: 'running' })

    release()
    await ctx.jobs.idle()
  })

  it('refuses a second disposition while one is in flight', async () => {
    let release = (): void => undefined
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    const ctx = context({
      deviceDispose: (async () => {
        await finished
        return { ok: true, warnings: [] } as never
      }) as unknown as ServerEngine['deviceDispose'],
    })

    await handle(post('/v1/devices/disposition', { systemId: 'sys-1', disposition: 'handover' }), ctx)
    const second = await handle(post('/v1/devices/disposition', { systemId: 'sys-2', disposition: 'handover' }), ctx)

    // Two device runs at once means two callers attaching and detaching
    // commands on the same fleet, which is how an association gets left
    // behind.
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({ error: 'run_in_progress' })

    release()
    await ctx.jobs.idle()
  })

  it('keeps the report available after the work finishes, so a slow poller still learns the outcome', async () => {
    const ctx = context({
      deviceDispose: (async () => ({ ok: true, final: 'done', warnings: [] }) as never) as unknown as ServerEngine['deviceDispose'],
    })
    await handle(post('/v1/devices/disposition', { systemId: 'sys-1', disposition: 'return_to_pool' }), ctx)
    await ctx.jobs.idle()

    const polled = await handle({ method: 'GET', path: '/v1/runs/run-1', query: {}, headers: {}, body: '' }, ctx)
    expect(polled.status).toBe(200)
    expect(polled.body).toMatchObject({ ok: true, state: 'done', report: { final: 'done' } })
  })
})
