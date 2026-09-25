/**
 * One ordered run, replacing several schedules that used to race.
 *
 * The automation this was ported from had five schedules whose ordering lived
 * in a comment: the HR sync ran fifteen minutes before the offboarding engine,
 * so that a leaver flipped to terminated in the morning was visible to the
 * same day's day-0 run. That is not an ordering, it is a hope, and the day the
 * sync ran late the engine acted on yesterday's picture.
 *
 * So this is the ordering, in code:
 *
 *   take the lease, or skip
 *   assert the tombstone count has not fallen
 *   read the HR system ONCE
 *   sync, then detect, then the leaver engine
 *   flush the audit
 *   send the run summary
 *   ping the dead-man ONLY once the summary was delivered
 *   record the run, release the lease
 *
 * Two of those need spelling out.
 *
 * The tombstone check runs before anything else writes. A drop in the number
 * of departed rows means somebody removed them outside this toolkit, and at
 * that moment every removed person looks like a brand new leaver. The correct
 * response is to do nothing at all.
 *
 * The liveness ping is last, and only after the notification is proven
 * delivered. A dead-man that is pinged whatever happened proves the process
 * ran; a dead-man pinged after delivery proves the alerting path works too,
 * which is the part that has failed silently before.
 */

import { randomUUID } from 'node:crypto'
import type { SecretRegistry } from '../config/secrets.ts'
import { acquireOrSkip } from '../core/lease.ts'
import type { Actor, RunReport } from '../core/types.ts'
import { HrisImplausible, HrisIncomplete, type HrisAdapter, type HrisSnapshot } from '../hris/types.ts'
import { DEPARTED_COUNTER, checkDepartedInvariant } from '../store/bootstrap.ts'
import { createChangeGate } from '../core/gate.ts'
import { createIdentityRules } from '../core/identity.ts'
import { runDetect } from './detect.ts'
import { runSync } from './sync.ts'
import { runLeaverEngine, type LeaverRunOptions } from './leaver/engine.ts'
import { runJoinerEngine, type JoinerDeps } from './joiner/engine.ts'
import { runTicketing } from './ticketing/index.ts'
import { runOwnerNotifications } from './ownernotify/index.ts'
import type { SaasRegisterAdapter } from '../register/types.ts'
import type { TicketingAdapter } from '../ticketing/types.ts'
import type { LeaverDeps } from './leaver/legs.ts'
import { notifyRunAborted, notifyRunSummary, runAuditCtx } from './leaver/notify.ts'

/** The job name the lease is taken under. One run of anything at a time. */
export const PIPELINE_LEASE = 'pipeline'

/**
 * Long enough for a slow run, short enough that a crashed process does not
 * lock the schedule out until somebody notices.
 */
export const PIPELINE_LEASE_TTL_SECONDS = 900

export type PipelineStepName = 'sync' | 'detect' | 'ticketing' | 'joiner' | 'leaver' | 'owners'

/**
 * The one HTTP call the pipeline makes itself.
 *
 * Declared as a narrow port rather than the shared client, so a test can hand
 * over two lines and so nothing here can reach for a richer HTTP surface than
 * a dead-man ping needs. The real client satisfies it structurally, which a
 * test asserts.
 */
export interface LivenessHttp {
  request(req: { method: 'GET'; url: string; label?: string; timeoutMs?: number }): Promise<{ ok: boolean; status: number }>
}

export interface PipelineDeps extends LeaverDeps {
  hris: HrisAdapter
  /** Present when the connectors support activation; the joiner step is skipped otherwise. */
  joiner?: Pick<JoinerDeps, 'idp' | 'google' | 'gate' | 'passwordGenerator'> | null
  /** Null when no ticketing system is configured; the step then does nothing. */
  ticketing?: TicketingAdapter | null
  /** Null when owner notifications are off. */
  register?: SaasRegisterAdapter | null
  /** Needed only for the liveness ping. */
  http?: LivenessHttp
  secrets?: SecretRegistry
}

export interface PipelineOptions {
  dryRun: boolean
  actor: Actor
  runId?: string
  /** Defaults to sync, then detect, then the leaver engine. */
  steps?: readonly PipelineStepName[]
  allowBulk?: number
  only?: LeaverRunOptions['only']
}

/** Sync, then detect, then the engine. The order is the point of this module. */
const DEFAULT_STEPS: readonly PipelineStepName[] = ['sync', 'detect', 'ticketing', 'joiner', 'leaver', 'owners']

type AbortReason =
  | 'lease_held'
  | 'invariant_failed'
  | 'hris_incomplete'
  | 'hris_implausible'
  | 'hris_unavailable'
  | 'audit_unavailable'
  | 'store_unavailable'

function emptyReport(runId: string, dryRun: boolean, at: string): RunReport {
  return {
    runId,
    kind: 'pipeline',
    startedAt: at,
    finishedAt: at,
    dryRun,
    ok: true,
    counts: {},
    people: [],
    warnings: [],
    errors: [],
  }
}

export async function runPipeline(deps: PipelineDeps, opts: PipelineOptions): Promise<RunReport> {
  const runId = opts.runId ?? randomUUID()
  const today = deps.clock.today(deps.cfg.org.timezone)
  const report = emptyReport(runId, opts.dryRun, deps.clock.nowIso())
  const auditCtx = runAuditCtx(runId, opts.actor, opts.dryRun)

  const held = await acquireOrSkip({
    state: deps.state,
    job: PIPELINE_LEASE,
    ttlSeconds: PIPELINE_LEASE_TTL_SECONDS,
    logger: deps.logger,
  })
  if (!held) {
    // Not a failure. An overlapping schedule is normal operation, and turning
    // it into a red run teaches people to ignore red runs. The caller reports
    // it as a skip.
    report.aborted = { reason: 'lease_held', detail: { job: PIPELINE_LEASE } }
    report.warnings.push('another run holds the pipeline lease, so this one skipped')
    report.finishedAt = deps.clock.nowIso()
    deps.logger.info('pipeline skipped: another run holds the lease', { runId })
    return report
  }

  try {
    await deps.audit.append({
      at: deps.clock.nowIso(),
      runId,
      phase: 'intent',
      actor: opts.actor,
      action: 'run.start',
      subject: { kind: 'run', id: runId },
      dryRun: opts.dryRun,
      detail: { pipeline: 'pipeline', steps: opts.steps ?? 'default', today },
    })

    // Before any write, including in a dry run: a fallen tombstone count means
    // the picture cannot be trusted, and a dry run is exactly when somebody
    // wants to be told that.
    const invariant = await checkDepartedInvariant(deps.store, deps.state, { dryRun: opts.dryRun })
    if (!invariant.ok) {
      return await abort(deps, report, auditCtx, 'invariant_failed', {
        reason: invariant.reason ?? 'the tombstone count fell',
        previous: invariant.previous,
        current: invariant.current,
        counter: DEPARTED_COUNTER,
      })
    }

    let snapshot: HrisSnapshot
    try {
      snapshot = await deps.hris.fetchAll()
    } catch (err) {
      const reason: AbortReason =
        err instanceof HrisIncomplete ? 'hris_incomplete' : err instanceof HrisImplausible ? 'hris_implausible' : 'hris_unavailable'
      return await abort(deps, report, auditCtx, reason, {
        reason: err instanceof Error ? err.message : String(err),
        adapter: deps.hris.name,
      })
    }
    report.counts.hrisPeople = snapshot.all.length
    report.counts.hrisEmployed = snapshot.activeIds.size
    for (const warning of snapshot.warnings ?? []) report.warnings.push(`HR snapshot: ${warning}`)

    const steps = opts.steps ?? DEFAULT_STEPS

    if (steps.includes('sync')) {
      // The sync runs inside the same run as the engine, rather than on its
      // own schedule fifteen minutes earlier. That gap was the race: the
      // engine acted on whatever the store happened to hold.
      const sync = await runSync({
        snapshot,
        people: deps.store,
        today,
        identity: createIdentityRules(deps.domain, deps.cfg.hris.exitRenamePatterns),
        minPlausibleHeadcount: deps.cfg.hris.minPlausibleHeadcount,
        terminationLookbackDays: deps.cfg.leaver.terminationLookbackDays,
        dryRun: opts.dryRun,
        logger: deps.logger,
        audit: deps.audit,
        runId,
        actor: opts.actor,
        notifier: deps.notifier,
        clock: deps.clock,
      })
      for (const [field, value] of Object.entries(sync.counts)) report.counts[`sync.${field}`] = value
      report.warnings.push(...sync.warnings)
      report.errors.push(...sync.errors)
      if (!sync.ok) report.ok = false
    }

    if (steps.includes('detect')) {
      const detect = await runDetect({
        people: deps.store,
        today,
        terminationLookbackDays: deps.cfg.leaver.terminationLookbackDays,
        // Announced only when the set of people changes, with the configured
        // weekly re-raise. A schedule firing is not news.
        gate: createChangeGate({
          subject: 'detect',
          state: deps.state,
          clock: deps.clock,
          timezone: deps.cfg.org.timezone,
          weeklyReraiseDay: deps.cfg.notify.weeklyReraiseDay,
          logger: deps.logger,
        }),
        notifier: deps.notifier,
        logger: deps.logger,
      })
      for (const [field, value] of Object.entries(detect.counts)) report.counts[`detect.${field}`] = value
      report.warnings.push(...detect.warnings)
      report.errors.push(...detect.errors)
      if (!detect.ok) report.ok = false
    }

    if (steps.includes('ticketing') && deps.cfg.ticketing.adapter !== 'none') {
      // Before the joiner step: a nudge sent today and a gate opened by a
      // ticket both want to be visible to the same run's activation pass.
      const ticketing = await runTicketing({ ...deps, ticketing: deps.ticketing ?? null }, { dryRun: opts.dryRun, actor: opts.actor, runId })
      mergeLeaverReport(report, ticketing)
    }

    if (steps.includes('joiner') && deps.joiner) {
      // Joiners before leavers, so a starter whose account exists by the
      // morning is activated on the same run that reads the HR system.
      const joiner = await runJoinerEngine({ ...deps, idp: deps.joiner.idp, google: deps.joiner.google, ...(deps.joiner.gate ? { gate: deps.joiner.gate } : {}), ...(deps.joiner.passwordGenerator ? { passwordGenerator: deps.joiner.passwordGenerator } : {}) }, {
        dryRun: opts.dryRun,
        actor: opts.actor,
        runId,
        ...(opts.only ? { only: opts.only } : {}),
      })
      mergeLeaverReport(report, joiner)
    }

    if (steps.includes('leaver')) {
      const leaver = await runLeaverEngine(deps, {
        dryRun: opts.dryRun,
        actor: opts.actor,
        runId,
        ...(opts.allowBulk === undefined ? {} : { allowBulk: opts.allowBulk }),
        ...(opts.only ? { only: opts.only } : {}),
      })
      mergeLeaverReport(report, leaver)
      if (leaver.aborted) {
        // The leaver engine already sent its own abort notification, naming the
        // count, so this run does not send a second one.
        report.finishedAt = deps.clock.nowIso()
        await recordRun(deps, report)
        return report
      }
    }

    if (steps.includes('owners') && deps.cfg.ownerNotifications.enabled) {
      // After the leaver step: the day after somebody's last day is also the
      // day their status has settled, and the owners hear once.
      const owners = await runOwnerNotifications({ ...deps, register: deps.register ?? null }, { dryRun: opts.dryRun, actor: opts.actor, runId })
      mergeLeaverReport(report, owners)
    }

    await flushAudit(deps, report)
    report.finishedAt = deps.clock.nowIso()

    const summary = await notifyRunSummary(deps, auditCtx, report)
    if (!summary.delivered) {
      report.ok = false
      report.warnings.push(...summary.reasons)
    } else {
      // Only here. The ping means "the run finished and the alerting path
      // works", which is a stronger statement than "the process started".
      await pingLiveness(deps, report)
    }

    await bumpDepartedCounter(deps, report)
    await recordRun(deps, report)
    return report
  } catch (err) {
    // Anything thrown still leaves a report rather than a stack trace: the
    // caller is a CLI exit code or an automation node, and both need the
    // reason in a field. A step asserting the HR plausibility floor a second
    // time lands here, which is why the reason is classified rather than
    // called a store problem.
    deps.logger.error('the pipeline stopped on an error', { runId, err })
    return await abort(deps, report, auditCtx, classify(err), {
      reason: err instanceof Error ? err.message : String(err),
    })
  } finally {
    await held.release()
  }
}

/**
 * Name the reason a run stopped.
 *
 * The HR errors are re-checked here because the sync asserts the plausibility
 * floor a second time, and an abort from that check has to read as an HR
 * problem rather than as a store problem: they need different responses.
 */
function classify(err: unknown): AbortReason {
  if (err instanceof HrisIncomplete) return 'hris_incomplete'
  if (err instanceof HrisImplausible) return 'hris_implausible'
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'audit_unavailable') {
    return 'audit_unavailable'
  }
  return 'store_unavailable'
}

/** Record the abort, tell somebody, and return the report unchanged otherwise. */
async function abort(
  deps: PipelineDeps,
  report: RunReport,
  ctx: ReturnType<typeof runAuditCtx>,
  reason: AbortReason,
  detail: Record<string, unknown>,
): Promise<RunReport> {
  report.ok = false
  report.aborted = { reason, detail }
  report.errors.push(String(detail['reason'] ?? reason))
  report.finishedAt = deps.clock.nowIso()
  try {
    await deps.audit.append({
      at: deps.clock.nowIso(),
      runId: report.runId,
      phase: 'outcome',
      actor: ctx.actor,
      action: 'run.abort',
      subject: { kind: 'run', id: report.runId },
      dryRun: report.dryRun,
      ok: false,
      detail: { abortReason: reason, ...detail },
    })
  } catch (err) {
    // An unwritable audit log is itself a reason to abort, so this row is the
    // one place the contract has to bend: the report and the notification are
    // all that is left to carry the reason out.
    report.warnings.push(`the abort could not be recorded in the audit log: ${err instanceof Error ? err.message : String(err)}`)
  }
  deps.logger.error('the pipeline aborted before doing any work', { runId: report.runId, reason, ...detail })
  try {
    const told = await notifyRunAborted(deps, ctx, report)
    if (!told.delivered) report.warnings.push(...told.reasons)
  } catch (err) {
    // The notifier writes its own audit rows, so an unwritable log takes this
    // path down with it. The returned report is then the only carrier of the
    // reason, which is why it is built before anything is sent.
    report.warnings.push(`the abort could not be announced: ${err instanceof Error ? err.message : String(err)}`)
  }
  // An aborted run is still a run, and the history is where somebody looks to
  // see that today's schedule refused rather than never fired.
  await recordRun(deps, report)
  // No liveness ping on an abort. A dead-man that is fed by a refusing run
  // reports a healthy schedule while nothing is happening.
  return report
}

function mergeLeaverReport(report: RunReport, leaver: RunReport): void {
  for (const [field, value] of Object.entries(leaver.counts)) report.counts[field] = value
  report.people.push(...leaver.people)
  report.warnings.push(...leaver.warnings)
  report.errors.push(...leaver.errors)
  if (!leaver.ok) report.ok = false
  if (leaver.aborted) report.aborted = leaver.aborted
}

/**
 * Flush whatever the sink buffers.
 *
 * The default sink fsyncs every row as it writes it, so this is usually
 * nothing. It is called anyway because a sink that does buffer must not be
 * left holding the last rows of a destructive run.
 */
async function flushAudit(deps: PipelineDeps, report: RunReport): Promise<void> {
  const sink = deps.audit as { flush?: () => Promise<void>; warnings?: () => string[] }
  try {
    if (typeof sink.flush === 'function') await sink.flush()
  } catch (err) {
    report.ok = false
    report.errors.push(`the audit log could not be flushed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // A fan-out sink counts the secondary failures it tolerated. They belong in
  // the summary rather than in a log nobody reads.
  if (typeof sink.warnings === 'function') report.warnings.push(...sink.warnings())
}

/**
 * The dead-man ping.
 *
 * The URL is itself the credential, so it never reaches a log line or an
 * error: it is used inside `SecretHandle.use` and only the resulting status is
 * recorded.
 */
async function pingLiveness(deps: PipelineDeps, report: RunReport): Promise<void> {
  const ref = deps.cfg.liveness.healthchecksPingUrl
  if (!ref) return
  if (report.dryRun) {
    report.warnings.push('dry run: the liveness ping was not sent')
    return
  }
  if (!deps.http || !deps.secrets?.has('liveness.healthchecksPingUrl')) {
    report.warnings.push('a liveness ping is configured but no HTTP client or resolved secret was supplied, so nothing was pinged')
    return
  }
  try {
    const response = await deps.secrets
      .get('liveness.healthchecksPingUrl')
      .use((url) => deps.http?.request({ method: 'GET', url, label: 'liveness ping', timeoutMs: 10_000 }))
    if (!response || !response.ok) {
      report.warnings.push(`the liveness ping answered ${response ? response.status : 'nothing'}`)
    }
  } catch (err) {
    report.warnings.push(`the liveness ping could not be sent: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Raise the tombstone baseline after new tombstones were written.
 *
 * Only ever upwards. Writing a lower number would teach the next run that a
 * loss of rows is normal, which is precisely the check this counter exists
 * for.
 */
async function bumpDepartedCounter(deps: PipelineDeps, report: RunReport): Promise<void> {
  if (report.dryRun) return
  try {
    const current = await deps.store.countExact({ status: ['departed'] })
    const recorded = await deps.state.getCounter(DEPARTED_COUNTER)
    if (recorded === null || current > recorded) await deps.state.setCounter(DEPARTED_COUNTER, current)
  } catch (err) {
    report.warnings.push(`the tombstone baseline could not be updated: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function recordRun(deps: PipelineDeps, report: RunReport): Promise<void> {
  try {
    await deps.state.recordRun(report.runId, report.kind, summarise(report))
  } catch (err) {
    report.warnings.push(`the run could not be recorded in the state store: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** One line, for `jml doctor` and for the run history table. */
export function summarise(report: RunReport): string {
  const counts = Object.entries(report.counts)
    .filter(([, value]) => value > 0)
    .map(([field, value]) => `${field}=${value}`)
    .join(' ')
  const state = report.aborted ? `aborted:${report.aborted.reason}` : report.ok ? 'ok' : 'failed'
  return `${state} ${report.dryRun ? 'dry-run' : 'armed'} ${counts}`.trim()
}
