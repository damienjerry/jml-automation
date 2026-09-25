/**
 * `jml run`, `jml sync` and `jml detect`.
 *
 * All three are the same ordered run with a different list of steps, because
 * the ordering is the point: the HR system is read once, the sync writes what
 * it derives, the detector announces what changed, and only then does the
 * leaver engine act. The automation this replaces had those on separate
 * schedules fifteen minutes apart, which is a hope rather than an ordering,
 * and the day the sync ran late the engine acted on yesterday's picture.
 *
 * Dry run is the default. `--armed` is the only way to arm a run, and config
 * still has to arm each action separately, so an adopter can rehearse the
 * whole thing and then arm suspension alone.
 */

import type { Actor } from '../../core/types.ts'
import { runPipeline, type PipelineDeps, type PipelineOptions, type PipelineStepName } from '../../engine/pipeline.ts'
import { renderRunReport } from './render.ts'
import { openRuntime, type CliIo, type Runtime } from './context.ts'

export interface RunCommandOptions {
  configPath?: string
  steps?: readonly PipelineStepName[]
  armed?: boolean
  json?: boolean
  allowBulk?: number
  /** A person's name or address, recorded on every audit row this run writes. */
  actor?: string
  only?: { hrisId?: string; email?: string }
}

/**
 * Who to record.
 *
 * Without `--actor` this is a system actor, which is right for a cron entry
 * and is also what refuses the circuit-breaker override: raising the day-0
 * limit is a decision somebody signs for, so it needs a name.
 */
export function actorFor(opts: { actor?: string }): Actor {
  const named = opts.actor?.trim()
  return named ? { kind: 'human', id: named } : { kind: 'system', id: 'system:cli' }
}

export function pipelineDeps(rt: Runtime): PipelineDeps {
  if (!rt.providers) {
    throw new Error('a run needs the provider connectors; this runtime was opened without them')
  }
  return {
    cfg: rt.cfg,
    hris: rt.hris,
    store: rt.store,
    state: rt.state,
    idp: rt.providers.idp,
    devices: rt.providers.devices,
    google: rt.providers.google,
    joiner: { idp: rt.providers.idp, google: rt.providers.google },
    ticketing: rt.ticketing,
    notifier: rt.notifier,
    audit: rt.audit,
    clock: rt.clock,
    logger: rt.logger,
    domain: rt.domain,
    http: rt.http,
    secrets: rt.secrets,
  }
}

export async function runCommand(io: CliIo, opts: RunCommandOptions): Promise<number> {
  const rt = await openRuntime({
    io,
    withProviders: true,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  })
  try {
    const pipeline: PipelineOptions = {
      dryRun: opts.armed !== true,
      actor: actorFor(opts),
      ...(opts.steps ? { steps: opts.steps } : {}),
      ...(opts.allowBulk === undefined ? {} : { allowBulk: opts.allowBulk }),
      ...(opts.only ? { only: opts.only } : {}),
    }
    const report = await runPipeline(pipelineDeps(rt), pipeline)
    io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderRunReport(report) + '\n')
    // A skipped run is not a failure: an overlapping schedule is normal, and a
    // red exit code here would teach whoever reads the cron mail to ignore it.
    if (report.aborted?.reason === 'lease_held') return 0
    return report.ok ? 0 : 1
  } finally {
    await rt.close()
  }
}
