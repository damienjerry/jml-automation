/**
 * The messages the joiner path sends.
 *
 * The temporary password is the only credential this toolkit ever puts in a
 * message. It is rendered into the body here and nowhere else: not into the
 * audit row, not into the run report, not into a log line. The audit records
 * that a password message was sent and to how many addresses.
 */

import { renderNotification } from '../../notify/fanout.ts'
import type { Notification, NotificationResult } from '../../notify/types.ts'
import { auditedCall, type AuditCtx } from '../leaver/legs.ts'
import type { JoinerDeps } from './engine.ts'

export interface NotifyReport {
  delivered: boolean
  reasons: string[]
}

function prefix(dryRun: boolean): string {
  return dryRun ? '[DRY RUN] ' : ''
}

async function send(deps: JoinerDeps, ctx: AuditCtx, n: Notification, count: number): Promise<NotificationResult> {
  let result: NotificationResult = { delivered: false, channel: 'none', error: 'the notifier was never called' }
  // The recipient list length is audited; the addresses and the body are not.
  await auditedCall(deps, ctx, { action: `notify.${n.kind}`, target: 'notify', detail: { audience: n.audience, recipients: count } }, async () => {
    result = await deps.notifier.send(n)
    return result.delivered
      ? { ok: true, verified: true, detail: { channel: result.channel } }
      : { ok: false, verified: false, error: `the ${n.kind} notification was not delivered: ${result.error ?? 'no reason given'}`, retryable: true }
  })
  return result
}

function report(results: readonly NotificationResult[]): NotifyReport {
  const failed = results.filter((r) => !r.delivered)
  return { delivered: failed.length === 0, reasons: failed.map((r) => `${r.channel}: ${r.error ?? 'no reason given'}`) }
}

export async function notifyJoinerPassword(deps: JoinerDeps, ctx: AuditCtx, to: readonly string[], password: string): Promise<NotifyReport> {
  if (to.length === 0) return { delivered: false, reasons: ['no usable address for the temporary password'] }
  const person = ctx.person
  const body = renderNotification('joiner-password', {
    personName: person.displayName,
    workEmail: person.primaryEmail,
    temporaryPassword: ctx.dryRun ? '(not generated in a dry run)' : password,
    identityConsoleUrl: deps.cfg.identity.jumpcloud.consoleUrl ?? 'the identity provider sign-in page',
    orgName: deps.cfg.org.name,
    itTeamSignature: deps.cfg.org.itTeamSignature,
  })
  const r = await send(deps, ctx, { kind: 'joiner.password', subject: `${prefix(ctx.dryRun)}${person.displayName}: temporary password`, body, audience: 'manager', recipients: [...to] }, to.length)
  return report([r])
}

export async function notifyJoinerWelcome(deps: JoinerDeps, ctx: AuditCtx, to: readonly string[]): Promise<NotifyReport> {
  const person = ctx.person
  const body = renderNotification('joiner-welcome', {
    firstName: person.firstName ?? person.displayName,
    workEmail: person.primaryEmail,
    identityConsoleUrl: deps.cfg.identity.jumpcloud.consoleUrl ?? 'the identity provider sign-in page',
    orgName: deps.cfg.org.name,
    itTeamSignature: deps.cfg.org.itTeamSignature,
  })
  const r = await send(deps, ctx, { kind: 'joiner.welcome', subject: `${prefix(ctx.dryRun)}Welcome to ${deps.cfg.org.name}: your IT access is ready`, body, audience: 'manager', recipients: [...to] }, to.length)
  return report([r])
}

export async function notifyJoinerManager(deps: JoinerDeps, ctx: AuditCtx, manager: string, mailboxReady: boolean): Promise<NotifyReport> {
  const person = ctx.person
  const body = renderNotification('joiner-manager', {
    personName: person.displayName,
    workEmail: person.primaryEmail,
    startDate: person.startDate ?? 'not held',
    mailboxLine: mailboxReady ? 'Their mailbox is ready and the welcome note has gone to it.' : 'Their mailbox was not ready yet; the welcome note went to their personal address only and IT has been told.',
    itTeamSignature: deps.cfg.org.itTeamSignature,
  })
  const r = await send(deps, ctx, { kind: 'joiner.manager', subject: `${prefix(ctx.dryRun)}${person.displayName} is set up for ${person.startDate ?? 'their start'}`, body, audience: 'manager', managerEmail: manager }, 1)
  return report([r])
}

export async function notifyJoinerRefused(deps: JoinerDeps, ctx: AuditCtx): Promise<NotifyReport> {
  const person = ctx.person
  const body = renderNotification('joiner-refused', { personName: person.displayName, workEmail: person.primaryEmail, hrisId: person.hrisId })
  const r = await send(deps, ctx, { kind: 'joiner.refused', subject: `${prefix(ctx.dryRun)}Activation refused: ${person.displayName} is already in use`, body, audience: 'it' }, 1)
  return report([r])
}

export async function notifyJoinerWithheld(deps: JoinerDeps, ctx: AuditCtx, withheld: readonly string[]): Promise<NotifyReport> {
  const person = ctx.person
  const body = renderNotification('joiner-withheld', { personName: person.displayName, workEmail: person.primaryEmail, withheldList: withheld.map((w) => `- ${w}`).join('\n') })
  const r = await send(deps, ctx, { kind: 'joiner.withheld', subject: `${prefix(ctx.dryRun)}Message withheld for ${person.displayName}`, body, audience: 'it' }, 1)
  return report([r])
}
