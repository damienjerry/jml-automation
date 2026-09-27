/**
 * `jml device preflight | dispose`.
 *
 * Preflight is a read. It prints the machine, who is bound to it directly, the
 * command it would fire, the association it would create, and every reason
 * this run could be refused. Running it first is the habit this whole package
 * is built to encourage: in an earlier design, every destructive
 * device change that shipped as a rehearsal first had no regressions, and
 * every one that went straight to a live fleet had several on its first day.
 *
 * Dispose is the write, and it defaults to a dry run even when the caller
 * forgets to say so. The flag that arms it is `--armed`, and config has to arm
 * the action as well.
 */

import { previewDeviceDisposition, runDeviceDisposition, type DispositionReport } from '../../engine/device/disposition.ts'
import type { DeviceDeps, DeviceDisposition, DevicePreflight, DispositionRequest } from '../../engine/device/preflight.ts'
import { CliError, openRuntime, type CliIo, type Runtime } from './context.ts'
import { actorFor } from './run.ts'

export function deviceDeps(rt: Runtime): DeviceDeps {
  if (!rt.providers) throw new Error('the device commands need the provider connectors')
  return {
    config: rt.cfg,
    devices: rt.providers.devices,
    commands: rt.providers.commands,
    identity: rt.providers.idp,
    people: rt.store,
    clock: rt.clock,
    audit: rt.audit,
    notifier: rt.notifier,
    logger: rt.logger,
  }
}

export interface DeviceCommandOptions {
  configPath?: string
  action: 'preflight' | 'dispose'
  systemId?: string
  disposition?: string
  armed?: boolean
  json?: boolean
  actor?: string
  acknowledgeFdeKeyLoss?: boolean
  canariedSystemId?: string
  expectedOwnerHrisId?: string
  note?: string
}

const DISPOSITIONS: readonly DeviceDisposition[] = ['return_to_pool', 'reassign', 'handover', 'retain_unmanaged']

export function dispositionOf(value: string | undefined, fallback: DeviceDisposition): DeviceDisposition {
  if (value === undefined) return fallback
  const found = DISPOSITIONS.find((d) => d === value)
  if (!found) {
    throw new CliError('--disposition must be one of: ' + DISPOSITIONS.join(', '), {
      exitCode: 2,
      docsAnchor: 'docs/runbooks/canary-a-device-script.md',
    })
  }
  return found
}

export async function deviceCommand(io: CliIo, opts: DeviceCommandOptions): Promise<number> {
  const systemId = opts.systemId?.trim()
  if (!systemId) throw new CliError('name the machine with --system-id', { exitCode: 2 })

  const rt = await openRuntime({
    io,
    withProviders: true,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  })
  try {
    const deps = deviceDeps(rt)
    const disposition = dispositionOf(opts.disposition, rt.cfg.devices.dispositionDefault)
    const request: DispositionRequest = {
      systemId,
      disposition,
      actor: actorFor(opts),
      runId: 'cli-device-' + rt.clock.nowIso(),
      dryRun: opts.action === 'preflight' || opts.armed !== true,
      ...(opts.acknowledgeFdeKeyLoss ? { acknowledgeFdeKeyLoss: true } : {}),
      ...(opts.canariedSystemId ? { canariedSystemId: opts.canariedSystemId } : {}),
      ...(opts.expectedOwnerHrisId ? { expectedOwnerHrisId: opts.expectedOwnerHrisId } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    }

    if (opts.action === 'preflight') {
      const plan = await previewDeviceDisposition(deps, request)
      io.out(opts.json ? JSON.stringify(plan, null, 2) + '\n' : renderPreflight(plan) + '\n')
      return plan.refusals.length === 0 ? 0 : 1
    }

    const report = await runDeviceDisposition(deps, request)
    io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderDisposition(report) + '\n')
    return report.ok ? 0 : 1
  } finally {
    await rt.close()
  }
}

export function renderPreflight(plan: DevicePreflight): string {
  const lines = [
    '',
    'device            ' + plan.displayName + '  (' + plan.systemId + ')',
    'platform          ' + plan.osFamily + (plan.triggerOs ? '' : '   no uninstall trigger is configured for it'),
    'direct owners     ' + (plan.directOwnerIds.length > 0 ? plan.directOwnerIds.join(', ') : 'none'),
    'would unbind      ' + (plan.unbindUserId ?? 'nothing'),
    'would bind        ' + (plan.rebindUserId ? plan.rebindUserId + ' (' + (plan.rebindLabel ?? 'no label') + ')' : 'nothing'),
    'last contact      ' + (plan.lastContactAgeMin === null ? 'unknown' : plan.lastContactAgeMin + ' minute(s) ago'),
    'encryption key    ' +
      (plan.fdeKeyPresent === null
        ? 'unknown'
        : plan.fdeKeyPresent
          ? 'held by the provider, and DESTROYED if the record is deleted'
          : 'not held'),
    'command           ' + (plan.command ? plan.command.name + ' (' + plan.command.launchType + ')' : 'none needed'),
    'agents expected   ' + (plan.agentsExpected.length > 0 ? plan.agentsExpected.join(', ') : 'none'),
    'script proven     ' +
      (plan.scriptProvenOnHardware === null ? 'no script involved' : plan.scriptProvenOnHardware ? 'yes' : 'NOT on hardware yet'),
    'dry run           ' + (plan.dryRun ? 'yes' + (plan.notArmedReason ? ': ' + plan.notArmedReason : '') : 'no'),
    '',
  ]
  for (const warning of plan.warnings) lines.push('warning:  ' + warning)
  for (const refusal of plan.refusals) {
    lines.push('REFUSED:  ' + refusal.code + '  ' + refusal.detail)
  }
  if (plan.refusals.length === 0) lines.push('nothing refuses this run')
  lines.push('')
  return lines.join('\n')
}

export function renderDisposition(report: DispositionReport): string {
  const lines = [
    '',
    'device            ' + report.displayName + '  (' + report.systemId + ')',
    'disposition       ' + report.disposition + (report.dryRun ? '  (dry run: nothing was written)' : ''),
    'outcome           ' + report.final + '  ok=' + report.ok,
    'record deleted    ' + report.recordDeleted,
    'left enrolled     ' + report.leftEnrolled,
    '',
  ]
  for (const step of report.steps) {
    lines.push(
      '  ' + step.step.padEnd(14) + step.leg.state.padEnd(15) + (step.leg.verified ? 'verified  ' : '          ') + step.label,
    )
  }
  if (report.plannedWrites.length > 0) {
    lines.push('')
    lines.push('  writes ' + (report.dryRun ? 'this run would make' : 'made') + ':')
    for (const write of report.plannedWrites) lines.push('    ' + write)
  }
  if (report.agents) {
    lines.push('')
    lines.push('  agent receipt: ' + JSON.stringify(report.agents))
  }
  lines.push('')
  lines.push(
    '  deletion gate after this run: ' +
      (report.gateAfter.clears ? 'clears' : 'still blocked') +
      ' (' + report.gateAfter.reason + ') ' + report.gateAfter.detail,
  )
  for (const warning of report.warnings) lines.push('  warning: ' + warning)
  lines.push('')
  return lines.join('\n')
}
