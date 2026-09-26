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

import type { JmlConfig } from '../../config/schema.ts'
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

/**
 * The steps that read only the HR system and the people store.
 *
 * A run of just these needs no identity provider or Google credential, which
 * is what lets somebody point the toolkit at their own HR data and see who it
 * thinks has joined and left before they grant it access to anything else.
 * The one exception is email notification: the detector announces through the
 * notifier, and the email notifier sends through Google, so with email on the
 * connectors are still built rather than the announcement going nowhere.
 */
export const REPORT_ONLY_STEPS: readonly PipelineStepName[] = ['sync', 'detect']

export function isReportOnly(steps: readonly PipelineStepName[] | undefined): boolean {
  return steps !== undefined && steps.length > 0 && steps.every((s) => REPORT_ONLY_STEPS.includes(s))
}

function needsProviders(steps: readonly PipelineStepName[] | undefined): (cfg: JmlConfig) => boolean {
  return (cfg) => !isReportOnly(steps) || cfg.notify.adapters.includes('email')
}

/** Stands in for a connector the runtime did not build. Any call is a bug, and says so. */
function unopened<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === 'then') return undefined
      return () => {
        throw new Error('the ' + name + ' connector was not opened for this run (sync and detect only), but ' + String(prop) + ' was called')
      }
    },
  })
}

export function pipelineDeps(rt: Runtime, steps?: readonly PipelineStepName[]): PipelineDeps {
  if (!rt.providers) {
    if (!isReportOnly(steps)) throw new Error('a run needs the provider connectors; this runtime was opened without them')
    return {
      cfg: rt.cfg,
      hris: rt.hris,
      store: rt.store,
      state: rt.state,
      idp: unopened('identity provider'),
      devices: unopened('device'),
      google: unopened('Google'),
      joiner: null,
      ticketing: rt.ticketing,
      register: rt.register,
      notifier: rt.notifier,
      audit: rt.audit,
      clock: rt.clock,
      logger: rt.logger,
      domain: rt.domain,
      http: rt.http,
      secrets: rt.secrets,
    }
  }
  return {
    cfg: rt.cfg,
    hris: rt.hris,
    store: rt.store,
    state: rt.state,
    idp: rt.providers.idp,
    devices: rt.providers.devices,
    google: rt.providers.google,
    joiner: { idp: rt.providers.activation, google: rt.providers.google },
    ticketing: rt.ticketing,
    register: rt.register,
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
    withProviders: needsProviders(opts.steps),
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
    const report = await runPipeline(pipelineDeps(rt, opts.steps), pipeline)
    io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderRunReport(report) + '\n')
    // A skipped run is not a failure: an overlapping schedule is normal, and a
    // red exit code here would teach whoever reads the cron mail to ignore it.
    if (report.aborted?.reason === 'lease_held') return 0
    return report.ok ? 0 : 1
  } finally {
    await rt.close()
  }
}
