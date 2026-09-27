/**
 * One device, one decision, one report.
 *
 * This is the entry point the command line and the HTTP sidecar both call. It
 * plans, refuses, executes the disposition the operator chose, then re-reads
 * the provider and states what the day-7 deletion gate would now say. That last
 * part matters more than it looks: in an earlier design an
 * operator cleared a block and then had to wait for the next scheduled run to
 * find out whether it had worked, so the same devices were "fixed" several
 * times over.
 *
 * Three rules govern everything below.
 *
 * Dry run is the default. Not a convenience: every destructive device change in
 * the source estate that shipped dry-run first had no regressions, and the ones
 * that went straight onto a live schedule had several on the first day. A dry
 * run here names the exact machine and the exact association that would be
 * created, because a plan that does not name what it would touch is not a plan.
 *
 * Only four outcomes clear the gate: the leaver was unbound, the machine was
 * rebound to the spares account, it was bound to a new owner, or its record was
 * deleted after a proven agent removal. Keeping the machine unmanaged clears
 * NOTHING and is designed not to. Deleting a record while the agents are still
 * installed removes the machine from our view and not from the network.
 *
 * The gate fails closed. If the provider cannot be re-read, the verdict is
 * "still blocked", never "probably fine": reading an error as "no devices" is
 * how an account was deleted while the machine was still out there.
 */

import type { AuditEvent } from '../../audit/types.ts'
import { GateError } from '../../connectors/types.ts'
import type { CommandReceipt } from '../../connectors/types.ts'
import { legFrom } from '../../core/result.ts'
import type { LegRecord, Outcome } from '../../core/types.ts'
import { renderNotification } from '../../notify/fanout.ts'
import type { AgentsReceipt } from './handover.ts'
import { handover } from './handover.ts'
import {
  describe,
  planDeviceDisposition,
  type DeviceDeps,
  type DevicePreflight,
  type DeviceStep,
  type DeviceStepName,
  type DispositionRequest,
  type StepContext,
} from './preflight.ts'
import { reassign, returnToPool } from './unbind.ts'

export type GateAfterReason =
  | 'unbound'
  | 'rebound_to_pool'
  | 'bound_to_new_owner'
  | 'record_deleted'
  | 'still_bound'
  | 'unreadable'
  | 'retained_unmanaged'
  | 'not_executed'

/** What the day-7 deletion gate would say about this machine right now. */
export interface DeviceGateVerdict {
  clears: boolean
  reason: GateAfterReason
  detail: string
}

export interface DispositionReport {
  runId: string
  systemId: string
  displayName: string
  disposition: DispositionRequest['disposition']
  dryRun: boolean
  preflight: DevicePreflight
  steps: DeviceStep[]
  /** The writes a dry run would make, each naming its exact association. */
  plannedWrites: string[]
  receipt?: CommandReceipt | null
  agents?: AgentsReceipt | null
  recordDeleted: boolean
  /** True for anything short of a confirmed removal, including every refusal. */
  leftEnrolled: boolean
  gateAfter: DeviceGateVerdict
  final: 'done' | 'left_enrolled' | 'refused' | 'planned'
  ok: boolean
  warnings: string[]
  /** True when a notification was asked for and proven delivered. */
  notified: boolean
}

/** Read the plan without doing anything. What `jml device preflight` prints. */
export async function previewDeviceDisposition(
  deps: DeviceDeps,
  req: DispositionRequest,
): Promise<DevicePreflight> {
  return planDeviceDisposition(deps, req)
}

export async function runDeviceDisposition(
  deps: DeviceDeps,
  req: DispositionRequest,
): Promise<DispositionReport> {
  const steps: DeviceStep[] = []
  const warnings: string[] = []
  // Set from the plan below, so an audit row cannot claim a real write while
  // config had in fact forced a dry run.
  const effective = { dryRun: true }
  const ctx = stepContext(deps, req, steps, warnings, effective)

  const plan = await planDeviceDisposition(deps, req)
  effective.dryRun = plan.dryRun
  warnings.push(...plan.warnings)
  ctx.record('preflight', 'read ' + plan.displayName + ' and everything that could refuse this run', {
    state: plan.refusals.length === 0 ? 'done' : 'failed',
    verified: plan.refusals.length === 0,
    attempts: 1,
    at: deps.clock.nowIso(),
    ...(plan.refusals.length === 0 ? {} : { error: plan.refusals.map((r) => r.code).join(', ') }),
  })
  await deps.audit.append(auditRow(deps, req, 'outcome', 'device.preflight', plan.displayName, plan.dryRun, {
    ok: plan.refusals.length === 0,
    verified: plan.refusals.length === 0,
    detail: {
      refusals: plan.refusals,
      warnings: plan.warnings,
      osFamily: plan.osFamily,
      directOwners: plan.directOwnerIds.length,
      fdeKeyPresent: plan.fdeKeyPresent,
    },
  }))

  const plannedWrites = describeWrites(plan, req)

  if (plan.refusals.length > 0) {
    return finish(deps, req, plan, {
      steps,
      warnings,
      plannedWrites,
      recordDeleted: false,
      gateAfter: {
        clears: false,
        reason: 'not_executed',
        detail: 'the run was refused before anything was fired: ' + plan.refusals.map((r) => r.detail).join('; '),
      },
      final: 'refused',
      ok: false,
    })
  }

  if (req.disposition === 'retain_unmanaged') {
    // Deliberately empty of writes. The gate stays blocked and waits for a
    // person to choose another disposition or record an override: a machine
    // somebody keeps, with our agents on it, is not a resolved case.
    ctx.record('report', 'report ' + plan.displayName + ' as retained and unmanaged, changing nothing', {
      state: 'done',
      verified: true,
      attempts: 1,
      at: deps.clock.nowIso(),
    })
    return finish(deps, req, plan, {
      steps,
      warnings,
      plannedWrites: [],
      recordDeleted: false,
      gateAfter: {
        clears: false,
        reason: 'retained_unmanaged',
        detail:
          'nothing was changed, so the deletion gate stays blocked; choose another disposition or record an explicit override',
      },
      final: 'left_enrolled',
      ok: true,
    })
  }

  if (plan.dryRun) {
    for (const write of plannedWrites) {
      ctx.record('report', write, { state: 'not_armed', verified: false, attempts: 0, at: deps.clock.nowIso() })
    }
    if (plan.notArmedReason) warnings.push('nothing was written because ' + plan.notArmedReason)
    return finish(deps, req, plan, {
      steps,
      warnings,
      plannedWrites,
      recordDeleted: false,
      gateAfter: {
        clears: false,
        reason: 'not_executed',
        detail: 'a dry run changes nothing, so the gate is unchanged; it would ' + wouldClear(plan, req),
      },
      final: 'planned',
      ok: true,
    })
  }

  let receipt: CommandReceipt | null = null
  let agents: AgentsReceipt | null = null
  let recordDeleted = false

  if (req.disposition === 'return_to_pool') {
    await returnToPool(deps, req, plan, ctx)
  } else if (req.disposition === 'reassign') {
    await reassign(deps, req, plan, ctx)
  } else {
    const result = await handover(deps, req, plan, ctx)
    receipt = result.receipt
    agents = result.agents
    recordDeleted = result.recordDeleted
  }

  const gateAfter = await readGate(deps, plan, req, recordDeleted)
  const failedSteps = steps.filter((s) => s.leg.state === 'failed')
  return finish(deps, req, plan, {
    steps,
    warnings,
    plannedWrites,
    recordDeleted,
    receipt,
    agents,
    gateAfter,
    final: recordDeleted || gateAfter.clears ? 'done' : 'left_enrolled',
    ok: failedSteps.length === 0,
  })
}

/**
 * Re-read the provider and decide what the gate would now say.
 *
 * The verdict comes from a fresh read, never from the steps above reporting
 * success: a provider accepting a write and changing nothing is the single most
 * repeated failure in this whole estate.
 */
async function readGate(
  deps: DeviceDeps,
  plan: DevicePreflight,
  req: DispositionRequest,
  recordDeleted: boolean,
): Promise<DeviceGateVerdict> {
  if (recordDeleted) {
    return {
      clears: true,
      reason: 'record_deleted',
      detail: 'the provider record is gone, confirmed by reading it back, so no machine is bound to this person',
    }
  }

  if (req.disposition === 'handover') {
    // A handover clears the gate only by removing the record, and only after
    // the agents are proven gone. Reaching here means it did not, so whoever
    // was bound to the machine still is, and the block stands.
    return {
      clears: false,
      reason: 'still_bound',
      detail:
        plan.displayName +
        ' is still enrolled because the record was not deleted; the agents are unproven, so nothing was removed',
    }
  }

  let owners: string[]
  try {
    owners = await deps.devices.listDeviceOwners(plan.systemId)
  } catch (err) {
    return {
      clears: false,
      reason: 'unreadable',
      detail: 'the bindings could not be re-read, so the gate stays blocked: ' + describe(err),
    }
  }

  if (plan.unbindUserId && owners.includes(plan.unbindUserId)) {
    return {
      clears: false,
      reason: 'still_bound',
      detail: plan.displayName + ' is still bound to the person being offboarded',
    }
  }
  if (plan.rebindUserId && owners.includes(plan.rebindUserId)) {
    return {
      clears: true,
      reason: req.disposition === 'reassign' ? 'bound_to_new_owner' : 'rebound_to_pool',
      detail: plan.displayName + ' is now bound to ' + (plan.rebindLabel ?? 'another account'),
    }
  }
  return {
    clears: true,
    reason: 'unbound',
    detail: plan.displayName + ' has no direct binding to the person being offboarded',
  }
}

function wouldClear(plan: DevicePreflight, req: DispositionRequest): string {
  if (req.disposition === 'handover') {
    return 'clear only if the removal receipt accounts for every agent and the machine then goes quiet'
  }
  if (plan.unbindUserId === null) return 'clear, because nothing is bound directly to this machine'
  return 'clear once the direct binding is removed and read back absent'
}

/**
 * The exact writes, named.
 *
 * Spelled out as associations rather than as intentions, because "unbind the
 * user" reads as safe and "remove user X from system Y, then attach system Y to
 * command Z and fire it" does not, and the second is what actually happens.
 */
function describeWrites(plan: DevicePreflight, req: DispositionRequest): string[] {
  const writes: string[] = []
  const on = ' on ' + plan.displayName + ' (system ' + plan.systemId + ')'

  if (req.disposition === 'reassign' && plan.rebindUserId) {
    writes.push('association add: user ' + plan.rebindUserId + on + ', read back present')
  }
  if (req.disposition !== 'handover' && plan.unbindUserId) {
    writes.push('association remove: user ' + plan.unbindUserId + on + ', read back absent')
  }
  if (req.disposition === 'return_to_pool' && plan.rebindUserId) {
    writes.push('association add: user ' + plan.rebindUserId + on + ' (spares account), read back present')
  }
  if (req.disposition === 'handover' && plan.command) {
    writes.push(
      'association add: system ' +
        plan.systemId +
        ' on command ' +
        plan.command.name +
        ' (' +
        plan.command.id +
        '), fired once, then removed in a finally and asserted back to zero',
    )
    writes.push('uninstall receipt required for: ' + plan.agentsExpected.join(', '))
    writes.push('delete the provider record for ' + plan.displayName + ', only after the receipt and a quiet machine')
  }
  return writes
}

interface FinishParts {
  steps: DeviceStep[]
  warnings: string[]
  plannedWrites: string[]
  recordDeleted: boolean
  receipt?: CommandReceipt | null
  agents?: AgentsReceipt | null
  gateAfter: DeviceGateVerdict
  final: DispositionReport['final']
  ok: boolean
}

async function finish(
  deps: DeviceDeps,
  req: DispositionRequest,
  plan: DevicePreflight,
  parts: FinishParts,
): Promise<DispositionReport> {
  const report: DispositionReport = {
    runId: req.runId,
    systemId: req.systemId,
    displayName: plan.displayName,
    disposition: req.disposition,
    dryRun: plan.dryRun,
    preflight: plan,
    steps: parts.steps,
    plannedWrites: parts.plannedWrites,
    receipt: parts.receipt ?? null,
    agents: parts.agents ?? null,
    recordDeleted: parts.recordDeleted,
    leftEnrolled: !parts.recordDeleted,
    gateAfter: parts.gateAfter,
    final: parts.final,
    ok: parts.ok,
    warnings: [...new Set(parts.warnings)],
    notified: false,
  }
  report.notified = await notify(deps, report)
  return report
}

/**
 * Tell somebody.
 *
 * Delivery is proven, not assumed: a chat API answers 200 with a failure in the
 * body, and three workflows in the source estate posted nothing for weeks while
 * every run recorded success. A notifier that cannot prove delivery makes the
 * run not ok.
 */
async function notify(deps: DeviceDeps, report: DispositionReport): Promise<boolean> {
  if (!deps.notifier) return false
  const device = report.preflight.device
  const body = renderNotification('device-report', {
    disposition: report.disposition,
    deviceName: report.displayName,
    deviceSerial: device?.serial ?? 'not reported',
    deviceOs: report.preflight.osFamily,
    deviceLastContact: device?.lastContact ?? 'never',
    fdeKeyPresent: device?.fdeKeyPresent === true ? 'yes' : device?.fdeKeyPresent === false ? 'no' : 'not reported',
    previousOwner: report.preflight.directOwnerIds.length > 0 ? report.preflight.directOwnerIds.join(', ') : 'nobody',
    steps: renderSteps(report),
    gateAfter: (report.gateAfter.clears ? 'clear' : 'BLOCKED') + ' (' + report.gateAfter.detail + ')',
  })
  try {
    const result = await deps.notifier.send({
      kind: 'device.report',
      subject: 'Device ' + report.disposition + ': ' + report.displayName,
      body,
      audience: 'it',
      detail: { systemId: report.systemId, final: report.final, gateClears: report.gateAfter.clears },
    })
    if (!result.delivered) {
      report.warnings.push('the device report was not delivered: ' + (result.error ?? 'the channel did not confirm'))
      report.ok = false
    }
    return result.delivered
  } catch (err) {
    report.warnings.push('the device report could not be sent: ' + describe(err))
    report.ok = false
    return false
  }
}

function renderSteps(report: DispositionReport): string {
  const lines = report.steps.map((s) => '- ' + s.step + ': ' + s.leg.state + ' - ' + s.label)
  for (const warning of report.warnings) lines.push('- warning: ' + warning)
  return lines.length > 0 ? lines.join('\n') : '- nothing was done'
}

/**
 * The audit-writing step runner.
 *
 * The intent row goes in BEFORE the call, and if it cannot be written the call
 * does not happen: the whole point of the pair is to describe a call that was
 * made and whose result was never learnt, which a single row written afterwards
 * cannot do.
 */
function stepContext(
  deps: DeviceDeps,
  req: DispositionRequest,
  steps: DeviceStep[],
  warnings: string[],
  effective: { dryRun: boolean },
): StepContext {
  return {
    steps,
    warnings,
    record(step, label, leg) {
      steps.push({ step, label, leg })
    },
    async run(step: DeviceStepName, action, label, call, detail) {
      const dryRun = effective.dryRun
      await deps.audit.append(
        auditRow(deps, req, 'intent', action, label, dryRun, { detail: { step, ...(detail ?? {}) } }),
      )
      let outcome: Outcome
      try {
        outcome = await call()
      } catch (err) {
        outcome = {
          ok: false,
          verified: false,
          error: describe(err),
          retryable: !(err instanceof GateError),
        }
      }
      const leg: LegRecord = legFrom(outcome, { at: deps.clock.nowIso() })
      steps.push({ step, label, leg })
      if (leg.state === 'failed' && outcome.error) warnings.push(label + ' failed: ' + outcome.error)
      await deps.audit.append(
        auditRow(deps, req, 'outcome', action, label, dryRun, {
          ok: outcome.ok,
          verified: outcome.verified,
          detail: { step, ...(outcome.detail ?? {}), ...(outcome.error ? { error: outcome.error } : {}) },
        }),
      )
      return outcome
    },
  }
}

function auditRow(
  deps: DeviceDeps,
  req: DispositionRequest,
  phase: AuditEvent['phase'],
  action: string,
  label: string,
  dryRun: boolean,
  extra: Partial<Pick<AuditEvent, 'ok' | 'verified' | 'detail'>>,
): AuditEvent {
  return {
    at: deps.clock.nowIso(),
    runId: req.runId,
    phase,
    actor: req.actor,
    action,
    subject: { kind: 'device', id: req.systemId, label },
    dryRun,
    ...extra,
  }
}
