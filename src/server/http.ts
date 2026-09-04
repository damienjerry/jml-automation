/**
 * The listener. Everything it decides is decided in routes.ts.
 *
 * Three properties matter here and nowhere else.
 *
 * The bearer token is compared with a constant-time comparison over fixed
 * length digests. A plain string comparison leaks the length of the matching
 * prefix through timing, and a comparison over raw bytes throws on a length
 * mismatch, which leaks the length. Hashing both sides first makes every
 * comparison the same shape.
 *
 * The body is capped and the connection is dropped when a caller exceeds it. A
 * service with no cap can be held open by one request until it runs out of
 * memory, and this process is the one holding every credential.
 *
 * The bind address defaults to the whole container interface and the shipped
 * compose file does not publish the port. The service is reachable by name on
 * the private network and nowhere else, so the token is the second line of
 * defence rather than the only one.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse as NodeResponse } from 'node:http'
import type { Logger } from '../core/logger.ts'
import { handle, JobBoard, type RouteContext, type ServerEngine, type ServerRequest, type TokenLike } from './routes.ts'

/** Bodies are small: the largest legitimate request is a device disposition. */
export const MAX_BODY_BYTES = 64 * 1024

/** The shortest token this server will start with. */
export const MIN_TOKEN_LENGTH = 32

export interface HttpServerOptions {
  engine: ServerEngine
  token: TokenLike
  logger: Logger
  /** `host:port`, as `server.bind` in the configuration. */
  bind: string
  nowIso?: () => string
  newRunId?: () => string
  jobs?: JobBoard
}

export interface RunningServer {
  /** The port actually bound, which matters when the request asked for 0. */
  port: number
  host: string
  jobs: JobBoard
  close(): Promise<void>
}

export function parseBind(bind: string): { host: string; port: number } {
  const match = /^(.*):(\d+)$/.exec(bind.trim())
  if (!match) throw new Error(`server.bind must be host:port, for example 0.0.0.0:8787, not "${bind}"`)
  const host = match[1] === '' ? '0.0.0.0' : (match[1] as string)
  return { host, port: Number(match[2]) }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Compare a bearer header against the configured token.
 *
 * The value is only ever read inside `use`, so it has no name in this scope
 * that a log line or a thrown error could pick up.
 */
export function makeAuthoriser(token: TokenLike): (header: string | undefined) => boolean {
  return (header) => {
    if (!header) return false
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
    if (!match) return false
    const presented = digest((match[1] as string).trim())
    return token.use((expected) => timingSafeEqual(presented, digest(expected)))
  }
}

export function routeContext(opts: HttpServerOptions): RouteContext {
  const jobs = opts.jobs ?? new JobBoard()
  return {
    engine: opts.engine,
    jobs,
    authorise: makeAuthoriser(opts.token),
    nowIso: opts.nowIso ?? (() => new Date().toISOString()),
    newRunId: opts.newRunId ?? (() => randomUUID()),
    onError: (err, req) => {
      // The path and method, never the body: a body can carry an address, and
      // an error log is the place a payload most often escapes into.
      opts.logger.error('a request failed', { method: req.method, path: req.path, err })
    },
  }
}

export async function startServer(opts: HttpServerOptions): Promise<RunningServer> {
  const tooShort = opts.token.use((value) => value.length < MIN_TOKEN_LENGTH)
  if (tooShort) {
    throw new Error(
      `server.token resolves to fewer than ${MIN_TOKEN_LENGTH} characters. ` +
        `\`jml init\` writes a random 32-byte value; a guessable token on this service is a way to delete accounts.`,
    )
  }

  const ctx = routeContext(opts)
  const { host, port } = parseBind(opts.bind)
  const server = createServer((req, res) => {
    void serve(req, res, ctx, opts.logger)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  opts.logger.info('the sidecar is listening', { host, port: bound })

  return {
    port: bound,
    host,
    jobs: ctx.jobs,
    close: () => closeServer(server, ctx.jobs),
  }
}

/**
 * Stop listening, then wait for the work already started.
 *
 * In that order. A run that is halfway through suspending somebody must finish
 * and write its audit rows; killing it would leave a person half offboarded
 * with no record of which half.
 */
async function closeServer(server: Server, jobs: JobBoard): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await jobs.idle()
}

async function serve(req: IncomingMessage, res: NodeResponse, ctx: RouteContext, logger: Logger): Promise<void> {
  let request: ServerRequest
  try {
    request = await readRequest(req)
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'body_too_large'
    logger.warn('a request was refused before routing', { reason: tooLarge ? 'body_too_large' : 'unreadable' })
    send(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'body_too_large' : 'bad_request' })
    return
  }

  try {
    const answer = await handle(request, ctx)
    send(res, answer.status, answer.body)
  } catch (err) {
    // handle() catches its own failures, so anything arriving here is a defect
    // in the server itself. It still answers, because a caller polling a run
    // must never be left holding an open socket.
    logger.error('the server failed to answer a request', { path: request.path, err })
    send(res, 500, { ok: false, error: 'internal_error' })
  }
}

function readRequest(req: IncomingMessage): Promise<ServerRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const headers: Record<string, string | undefined> = {}
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
      }
      resolve({
        method: (req.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
    })
  })
}

function send(res: NodeResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    // Nothing here is a browser surface, and a cached 202 would be read as a
    // finished run.
    'cache-control': 'no-store',
  })
  res.end(text)
}
