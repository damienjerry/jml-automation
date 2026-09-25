/**
 * `jml serve`: the HTTP sidecar.
 *
 * The sidecar exists so that a scheduler can drive this toolkit without
 * holding any of its credentials. Everything sensitive stays in this process:
 * the configuration, the vendor keys, the people store, the audit log. The
 * scheduler holds one bearer token and nothing else, which is what makes the
 * claim "your automation tool cannot leak your Google key" checkable rather
 * than aspirational.
 *
 * It refuses to start on two conditions, both learnt the hard way. An
 * unwritable audit directory means no step could record its intent, and a step
 * whose intent cannot be recorded must not run. A people store whose tombstone
 * count has fallen means the picture cannot be trusted, and every removed
 * person now looks like a brand new leaver.
 */

import { previewDeviceDisposition, runDeviceDisposition } from '../../engine/device/disposition.ts'
import { runLeaverEngine } from '../../engine/leaver/engine.ts'
import { runPipeline } from '../../engine/pipeline.ts'
import { runJoinerEngine } from '../../engine/joiner/engine.ts'
import { openGateFromTicket } from '../../engine/ticketing/bridge.ts'
import { joinerDeps } from './joiner.ts'
import { startServer, type RunningServer } from '../../server/http.ts'
import type { ServerEngine } from '../../server/routes.ts'
import { assertServable, runDoctor } from '../doctor.ts'
import { deviceDeps } from './device.ts'
import { ackPerson, holdPerson, leaverDeps, releasePerson, tombstonePerson } from './leaver.ts'
import { pipelineDeps } from './run.ts'
import { CliError, openRuntime, type CliIo, type Runtime } from './context.ts'

export function serverEngine(rt: Runtime): ServerEngine {
  const marks = { store: rt.store, audit: rt.audit, clock: rt.clock }
  return {
    pipeline: (req) => runPipeline(pipelineDeps(rt), req),
    leaver: (req) =>
      runLeaverEngine(leaverDeps(rt), {
        dryRun: req.dryRun,
        actor: req.actor,
        runId: req.runId,
        ...(req.hrisId || req.email
          ? { only: { ...(req.hrisId ? { hrisId: req.hrisId } : {}), ...(req.email ? { email: req.email } : {}) } }
          : {}),
      }),
    joiner: (req) =>
      runJoinerEngine(joinerDeps(rt), {
        dryRun: req.dryRun,
        actor: req.actor,
        runId: req.runId,
        ...(req.hrisId || req.email
          ? { only: { ...(req.hrisId ? { hrisId: req.hrisId } : {}), ...(req.email ? { email: req.email } : {}) } }
          : {}),
      }),
    ticketInbound: async (req) => {
      if (!rt.ticketing) return { outcome: 'ignored', detail: 'no ticketing adapter is configured' }
      const event = rt.ticketing.parseInbound(req.body)
      if (!event) return { outcome: 'ignored', detail: 'the body is not a ticket event this adapter recognises' }
      const result = await openGateFromTicket({ ...leaverDeps(rt), ticketing: rt.ticketing }, event, req.actor)
      return { ...result }
    },
    devicePreflight: (req) =>
      previewDeviceDisposition(deviceDeps(rt), {
        systemId: req.systemId,
        disposition: req.disposition,
        actor: req.actor,
        runId: req.runId,
        dryRun: true,
      }),
    deviceDispose: (req) => runDeviceDisposition(deviceDeps(rt), req),
    show: (hrisId) => rt.store.get(hrisId),
    hold: (req) => holdPerson(marks, req),
    release: (req) => releasePerson(marks, req),
    ack: (req) => ackPerson(marks, req),
    tombstone: (req) => tombstonePerson(marks, req),
    doctor: () => runDoctor(rt),
  }
}

export interface ServeCommandOptions {
  configPath?: string
  /** Overrides server.bind, for a test that needs an ephemeral port. */
  bind?: string
  /** Resolves when the caller wants the server stopped. Tests supply one. */
  until?: Promise<void>
}

export async function serveCommand(io: CliIo, opts: ServeCommandOptions): Promise<number> {
  const rt = await openRuntime({
    io,
    withProviders: true,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  })
  let server: RunningServer | null = null
  try {
    await assertServable(rt)
    if (!rt.secrets.has('server.token')) {
      throw new CliError(
        'server.token did not resolve, so there is no bearer token to authenticate with and the sidecar will not start.',
        { exitCode: 78, docsAnchor: 'docs/config-reference.md#secret-references' },
      )
    }

    server = await startServer({
      engine: serverEngine(rt),
      token: rt.secrets.get('server.token'),
      logger: rt.logger,
      bind: opts.bind ?? rt.cfg.server.bind,
    })

    io.out(
      'jml is listening on ' +
        server.host +
        ':' +
        server.port +
        '\n' +
        'Every route under /v1 needs `Authorization: Bearer <the value of JML_API_TOKEN>`.\n' +
        'GET /v1/health is the one unauthenticated route and answers {"ok":true} and nothing else.\n' +
        'The shipped compose file does NOT publish this port: it is reachable by service name on the ' +
        'private network only.\n',
    )

    await (opts.until ?? untilSignalled(io))
    return 0
  } finally {
    // Stop listening, finish the work already started, then close the stores.
    // A run halfway through suspending somebody has to write its audit rows.
    if (server) await server.close()
    await rt.close()
  }
}

/**
 * Wait for the container to be asked to stop.
 *
 * Both signals resolve rather than exiting, so the shutdown path above runs.
 * Calling process.exit here would abandon a run in flight, and the record of
 * what it had already done with it.
 */
function untilSignalled(io: CliIo): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      io.err('received ' + signal + ': finishing the work already started, then stopping\n')
      resolve()
    }
    process.once('SIGINT', () => stop('SIGINT'))
    process.once('SIGTERM', () => stop('SIGTERM'))
  })
}
