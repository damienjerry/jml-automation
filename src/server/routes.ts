/**
 * The sidecar's routes, as a pure function of a request.
 *
 * Everything about the HTTP surface that is worth testing is decided here, and
 * nothing here opens a socket. `http.ts` is the thin part that does.
 *
 * Four rules run through the whole file.
 *
 * Runs are asynchronous. Every route that starts work answers 202 with a run
 * id, and the caller polls. This is not a preference: the device paths hold a
 * command association for two minutes, wait up to ten for a receipt and then
 * confirm silence for another ten, which is longer than any automation tool's
 * HTTP node will wait. A synchronous route would have made the timeout the
 * limit on what the toolkit could do.
 *
 * A second concurrent run is a skip, not a failure. A schedule that overlaps
 * itself is normal operation, so it answers 409 and the caller treats it as
 * nothing to do. Turning an overlap into a red run teaches people to ignore
 * red runs.
 *
 * Dry run is the default on every route. Only an explicit `dryRun: false`
 * arms a call, so a malformed body, a missing field or a caller that has not
 * read the documentation plans instead of acting.
 *
 * Every response goes through the redaction registry on the way out. The
 * doctor report names credentials by reference and length, and health returns
 * one field, but a body that is redacted by construction cannot be made unsafe
 * by a later change to what a report carries.
 */

import { redactDeep } from '../config/redact.ts'
import type { Actor, Person, RunReport } from '../core/types.ts'
import type { DoctorReport } from '../cli/doctor.ts'
import type { DeviceDisposition, DevicePreflight } from '../engine/device/preflight.ts'
import type { DispositionReport } from '../engine/device/disposition.ts'

/** What the server was asked. Built by http.ts, or by a test directly. */
export interface ServerRequest {
  method: string
  /** Path only, no query string. */
  path: string
  query: Record<string, string>
  headers: Record<string, string | undefined>
  /** The raw body. Empty string means no body. */
  body: string
}

export interface ServerResponse {
  status: number
  body: Record<string, unknown>
}

export type JobKind = 'pipeline' | 'leaver' | 'joiner' | 'device'

export interface JobRecord {
  runId: string
  kind: JobKind
  state: 'running' | 'done' | 'failed'
  startedAt: string
  finishedAt: string | null
  /** The report, once the job is terminal. */
  result: Record<string, unknown> | null
  error: string | null
}

/**
 * What the routes are allowed to ask the toolkit to do.
 *
 * A narrow port rather than the whole runtime, so a route test states the
 * outcome it is about in two lines, and so nothing in this file can reach for
 * a provider directly.
 */
export interface ServerEngine {
  pipeline(req: { dryRun: boolean; actor: Actor; runId: string; allowBulk?: number }): Promise<RunReport>
  leaver(req: {
    dryRun: boolean
    actor: Actor
    runId: string
    hrisId?: string
    email?: string
  }): Promise<RunReport>
  joiner(req: { dryRun: boolean; actor: Actor; runId: string; hrisId?: string; email?: string }): Promise<RunReport>
  /** A raw ticketing webhook body. Returns what the bridge decided; never a run. */
  ticketInbound(req: { body: unknown; actor: Actor }): Promise<Record<string, unknown>>
  devicePreflight(req: { systemId: string; disposition: DeviceDisposition; actor: Actor; runId: string }): Promise<DevicePreflight>
  deviceDispose(req: {
    systemId: string
    disposition: DeviceDisposition
    actor: Actor
    runId: string
    dryRun: boolean
    acknowledgeFdeKeyLoss?: boolean
    canariedSystemId?: string
    expectedOwnerHrisId?: string
    note?: string
  }): Promise<DispositionReport>
  show(hrisId: string): Promise<Person | null>
  hold(req: { hrisId: string; actor: Actor; reason: string }): Promise<Person>
  release(req: { hrisId: string; actor: Actor; note?: string }): Promise<Person>
  ack(req: { hrisId: string; actor: Actor; note?: string }): Promise<Person>
  tombstone(req: { hrisId: string; actor: Actor; reason: string }): Promise<Person>
  doctor(): Promise<DoctorReport>
}

/** The one thing the server needs a secret for. */
export interface TokenLike {
  use<T>(fn: (value: string) => T): T
}

export interface RouteContext {
  engine: ServerEngine
  jobs: JobBoard
  /** Compares a bearer token in constant time. */
  authorise(header: string | undefined): boolean
  nowIso(): string
  newRunId(): string
  onError?(err: unknown, req: ServerRequest): void
}

/** How many finished jobs are remembered, so a long-lived process is bounded. */
const JOB_HISTORY = 200

/**
 * The runs this process has started.
 *
 * One in flight per kind. The pipeline also takes a lease in the state store,
 * which is what stops two separate processes overlapping; this board is what
 * stops one process accepting two of its own, and it answers immediately
 * rather than making the caller wait to find out.
 */
export class JobBoard {
  private readonly records = new Map<string, JobRecord>()
  private readonly active = new Map<JobKind, string>()
  private readonly inFlight = new Set<Promise<void>>()

  activeRun(kind: JobKind): string | null {
    return this.active.get(kind) ?? null
  }

  get(runId: string): JobRecord | null {
    return this.records.get(runId) ?? null
  }

  /** Every job, newest first. */
  list(): JobRecord[] {
    return [...this.records.values()].reverse()
  }

  start(
    kind: JobKind,
    runId: string,
    startedAt: string,
    work: () => Promise<Record<string, unknown>>,
    finishedAt: () => string,
  ): JobRecord {
    const record: JobRecord = { runId, kind, state: 'running', startedAt, finishedAt: null, result: null, error: null }
    this.records.set(runId, record)
    this.active.set(kind, runId)
    this.prune()

    const done = work().then(
      (result) => {
        record.state = 'done'
        record.result = result
        record.finishedAt = finishedAt()
      },
      (err: unknown) => {
        // A thrown job is recorded as failed rather than lost. The caller is
        // polling, and a run that simply never becomes terminal is the shape
        // of an outage nobody notices.
        record.state = 'failed'
        record.error = err instanceof Error ? err.message : String(err)
        record.finishedAt = finishedAt()
      },
    )
    const tracked = done.finally(() => {
      if (this.active.get(kind) === runId) this.active.delete(kind)
      this.inFlight.delete(tracked)
    })
    this.inFlight.add(tracked)
    return record
  }

  /** Resolves when nothing is running. For tests and for a clean shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  private prune(): void {
    while (this.records.size > JOB_HISTORY) {
      const oldest = this.records.keys().next()
      if (oldest.done) return
      const record = this.records.get(oldest.value)
      // Never drop something still running: its poller would get a 404 and
      // read it as a run that never happened.
      if (record?.state === 'running') return
      this.records.delete(oldest.value)
    }
  }
}

function json(status: number, body: Record<string, unknown>): ServerResponse {
  return { status, body: redactDeep(body) }
}

function parseBody(req: ServerRequest): Record<string, unknown> {
  if (req.body.trim() === '') return {}
  const parsed: unknown = JSON.parse(req.body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('the body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Dry run unless the caller says otherwise, in the exact word.
 *
 * `dryRun: "false"` as a string stays a dry run. A caller that sends the wrong
 * type gets the safe reading, which is the only direction this can fail in
 * without doing something irreversible.
 */
export function dryRunFrom(body: Record<string, unknown>): boolean {
  return body['dryRun'] !== false
}

/**
 * Who asked, from the header.
 *
 * `human:` in front of the value marks a person; anything else is recorded as
 * a system actor. That distinction is load-bearing rather than cosmetic: the
 * circuit-breaker override is refused to a system actor, so a scheduled
 * workflow cannot raise the day-0 limit on its own.
 */
export function actorFrom(headers: Record<string, string | undefined>, fallback: string): Actor {
  const raw = (headers['x-jml-actor'] ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200)
  if (raw === '') return { kind: 'system', id: fallback }
  if (raw.startsWith('human:')) {
    const id = raw.slice('human:'.length).trim()
    return id === '' ? { kind: 'system', id: fallback } : { kind: 'human', id }
  }
  return { kind: 'system', id: raw }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequest(`${field} is required and must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

class BadRequest extends Error {
  readonly code = 'bad_request'
}

const DISPOSITIONS: readonly DeviceDisposition[] = ['return_to_pool', 'reassign', 'handover', 'retain_unmanaged']

function dispositionFrom(body: Record<string, unknown>): DeviceDisposition {
  const value = requireString(body, 'disposition')
  const found = DISPOSITIONS.find((d) => d === value)
  if (!found) throw new BadRequest(`disposition must be one of: ${DISPOSITIONS.join(', ')}`)
  return found
}

export async function handle(req: ServerRequest, ctx: RouteContext): Promise<ServerResponse> {
  // Unauthenticated, and it answers one field. A health endpoint that reported
  // versions, configuration or credential state would be a reconnaissance
  // surface on a service whose whole job is destructive.
  if (req.method === 'GET' && req.path === '/v1/health') return json(200, { ok: true })

  if (!ctx.authorise(req.headers['authorization'])) {
    // No detail. "Wrong token" and "no token" look the same from outside.
    return json(401, { ok: false, error: 'unauthorised' })
  }

  try {
    return await route(req, ctx)
  } catch (err) {
    if (err instanceof BadRequest || err instanceof SyntaxError) {
      return json(400, { ok: false, error: 'bad_request', detail: err.message })
    }
    ctx.onError?.(err, req)
    return json(500, { ok: false, error: 'internal_error', detail: err instanceof Error ? err.message : String(err) })
  }
}

async function route(req: ServerRequest, ctx: RouteContext): Promise<ServerResponse> {
  const path = req.path.replace(/\/+$/, '') || '/'

  if (req.method === 'GET' && path === '/v1/doctor') {
    const report = await ctx.engine.doctor()
    return json(report.ok ? 200 : 503, { ok: report.ok, report })
  }

  if (req.method === 'GET' && path === '/v1/runs') {
    return json(200, { ok: true, runs: ctx.jobs.list() })
  }

  if (req.method === 'GET' && path.startsWith('/v1/runs/')) {
    return pollJob(path.slice('/v1/runs/'.length), ctx)
  }

  if (req.method === 'POST' && path === '/v1/runs') {
    const body = parseBody(req)
    const dryRun = dryRunFrom(body)
    const actor = actorFrom(req.headers, 'system:api')
    const allowBulk = typeof body['allowBulk'] === 'number' ? body['allowBulk'] : undefined
    return startJob('pipeline', ctx, async (runId) =>
      asRecord(await ctx.engine.pipeline({ dryRun, actor, runId, ...(allowBulk === undefined ? {} : { allowBulk }) })),
    )
  }

  if (req.method === 'POST' && path === '/v1/leavers/run') {
    const body = parseBody(req)
    const dryRun = dryRunFrom(body)
    const actor = actorFrom(req.headers, 'system:api')
    const hrisId = optionalString(body, 'hrisId')
    const email = optionalString(body, 'email')
    if (!hrisId && !email) throw new BadRequest('name the person with hrisId or email')
    return startJob('leaver', ctx, async (runId) =>
      asRecord(
        await ctx.engine.leaver({
          dryRun,
          actor,
          runId,
          ...(hrisId ? { hrisId } : {}),
          ...(email ? { email } : {}),
        }),
      ),
    )
  }

  if (req.method === 'POST' && path === '/v1/tickets/inbound') {
    // Synchronous: the bridge reads the store and writes one row. The caller
    // is a webhook relay that wants an answer, not a job to poll.
    const actor = actorFrom(req.headers, 'system:ticketing')
    const result = await ctx.engine.ticketInbound({ body: parseBody(req), actor })
    return json(200, { ok: true, ...result })
  }

  if (req.method === 'POST' && path === '/v1/joiners/run') {
    const body = parseBody(req)
    const dryRun = dryRunFrom(body)
    const actor = actorFrom(req.headers, 'system:api')
    const hrisId = optionalString(body, 'hrisId')
    const email = optionalString(body, 'email')
    return startJob('joiner', ctx, async (runId) =>
      asRecord(await ctx.engine.joiner({ dryRun, actor, runId, ...(hrisId ? { hrisId } : {}), ...(email ? { email } : {}) })),
    )
  }

  if (req.method === 'GET' && path.startsWith('/v1/leavers/')) {
    const hrisId = decodeURIComponent(path.slice('/v1/leavers/'.length))
    if (hrisId === '') throw new BadRequest('name the person in the path')
    const person = await ctx.engine.show(hrisId)
    if (!person) return json(404, { ok: false, error: 'not_found', hrisId })
    return json(200, { ok: true, person })
  }

  if (req.method === 'POST' && (path === '/v1/leavers/hold' || path === '/v1/leavers/tombstone')) {
    const body = parseBody(req)
    const actor = actorFrom(req.headers, 'system:api')
    const hrisId = requireString(body, 'hrisId')
    // A reason is required on both. A frozen row with no reason is a mystery
    // to whoever finds it, and the reason is the only thing that lets them
    // decide whether it is still needed.
    const reason = requireString(body, 'reason')
    const person =
      path === '/v1/leavers/hold'
        ? await ctx.engine.hold({ hrisId, actor, reason })
        : await ctx.engine.tombstone({ hrisId, actor, reason })
    return json(200, { ok: true, person })
  }

  if (req.method === 'POST' && (path === '/v1/leavers/release' || path === '/v1/leavers/ack')) {
    const body = parseBody(req)
    const actor = actorFrom(req.headers, 'system:api')
    const hrisId = requireString(body, 'hrisId')
    const note = optionalString(body, 'note')
    const person =
      path === '/v1/leavers/release'
        ? await ctx.engine.release({ hrisId, actor, ...(note ? { note } : {}) })
        : await ctx.engine.ack({ hrisId, actor, ...(note ? { note } : {}) })
    return json(200, { ok: true, person })
  }

  if (req.method === 'POST' && path === '/v1/devices/preflight') {
    const body = parseBody(req)
    const actor = actorFrom(req.headers, 'system:api')
    const systemId = requireString(body, 'systemId')
    const disposition = dispositionFrom(body)
    // A preflight reads the provider several times and is asynchronous for the
    // same reason a run is: the caller must not be holding a socket open while
    // it happens.
    return startJob('device', ctx, async (runId) =>
      asRecord(await ctx.engine.devicePreflight({ systemId, disposition, actor, runId })),
    )
  }

  if (req.method === 'POST' && path === '/v1/devices/disposition') {
    const body = parseBody(req)
    const actor = actorFrom(req.headers, 'system:api')
    const systemId = requireString(body, 'systemId')
    const disposition = dispositionFrom(body)
    const dryRun = dryRunFrom(body)
    const canariedSystemId = optionalString(body, 'canariedSystemId')
    const expectedOwnerHrisId = optionalString(body, 'expectedOwnerHrisId')
    const note = optionalString(body, 'note')
    return startJob('device', ctx, async (runId) =>
      asRecord(
        await ctx.engine.deviceDispose({
          systemId,
          disposition,
          actor,
          runId,
          dryRun,
          // Deleting a device record destroys the escrowed disk-encryption
          // key, so this has to be said in the request and cannot be defaulted.
          acknowledgeFdeKeyLoss: body['acknowledgeFdeKeyLoss'] === true,
          ...(canariedSystemId ? { canariedSystemId } : {}),
          ...(expectedOwnerHrisId ? { expectedOwnerHrisId } : {}),
          ...(note ? { note } : {}),
        }),
      ),
    )
  }

  return json(404, { ok: false, error: 'not_found', path })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function startJob(
  kind: JobKind,
  ctx: RouteContext,
  work: (runId: string) => Promise<Record<string, unknown>>,
): ServerResponse {
  const already = ctx.jobs.activeRun(kind)
  if (already) {
    return json(409, {
      ok: false,
      error: 'run_in_progress',
      kind,
      runId: already,
      detail: 'a run of this kind is already in flight, so this request did nothing. Treat it as a skip.',
    })
  }
  const runId = ctx.newRunId()
  const record = ctx.jobs.start(kind, runId, ctx.nowIso(), () => work(runId), () => ctx.nowIso())
  return json(202, { ok: true, runId, kind, state: record.state, poll: `/v1/runs/${runId}` })
}

/**
 * Poll one run.
 *
 * The 409 here is the other kind of overlap: the run started, took its lease,
 * found somebody else holding it and skipped. That is not this process's own
 * concurrency and there is no way to know it before the run begins, so it
 * surfaces on the poll with the same status a caller already treats as a skip.
 */
function pollJob(rawId: string, ctx: RouteContext): ServerResponse {
  const runId = decodeURIComponent(rawId)
  const record = ctx.jobs.get(runId)
  if (!record) return json(404, { ok: false, error: 'not_found', runId })
  if (record.state === 'running') {
    return json(202, { ok: false, state: 'running', runId, startedAt: record.startedAt })
  }
  if (record.state === 'failed') {
    return json(500, { ok: false, state: 'failed', runId, error: record.error })
  }
  const aborted = record.result?.['aborted'] as { reason?: string } | null | undefined
  if (aborted?.reason === 'lease_held') {
    return json(409, {
      ok: false,
      error: 'lease_held',
      state: 'skipped',
      runId,
      report: record.result,
      detail: 'another run held the pipeline lease, so this one did nothing. Treat it as a skip.',
    })
  }
  const ok = record.result?.['ok'] === true
  return json(200, { ok, state: 'done', runId, report: record.result })
}
