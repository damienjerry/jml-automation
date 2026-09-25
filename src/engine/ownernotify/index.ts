/**
 * Telling platform owners that somebody has left.
 *
 * For every platform IT does not administer, the only thing IT can do is tell
 * the owner. So the day after a leaver's last day, each owner listed in the
 * register gets one message naming the platforms they own and asking them to
 * check for and remove access. Sent whether or not the person is known to
 * have an account there, and never chased: the message says so.
 *
 * Guards, each from a recorded failure or a near miss:
 *  - A go-live date. Nobody whose leave date is before it is ever notified,
 *    so switching this on does not blast every owner about every leaver in
 *    the store's history.
 *  - A lookback. A leaver older than it is not picked up, so a register that
 *    gains an owner months later does not reopen old departures.
 *  - One message per leaver per owner, recorded on the row.
 *  - An empty register is a refusal, not "nothing to send". A register that
 *    reads as empty is a broken read far more often than a company with no
 *    platforms.
 *  - Out-of-scope people are skipped: they never had accounts.
 */

import { daysBetween } from '../../core/clock.ts'
import type { Person, RunReport } from '../../core/types.ts'
import { leaveDateOf } from '../../hris/leave-date.ts'
import { renderNotification } from '../../notify/fanout.ts'
import type { SaasRegisterAdapter } from '../../register/types.ts'
import { auditedCall, type AuditCtx, type LeaverDeps } from '../leaver/legs.ts'

export interface OwnerNotifyDeps extends LeaverDeps {
  register: SaasRegisterAdapter | null
}

export interface OwnerNotifyRunOptions {
  dryRun: boolean
  actor: AuditCtx['actor']
  runId: string
}

export async function runOwnerNotifications(deps: OwnerNotifyDeps, opts: OwnerNotifyRunOptions): Promise<RunReport> {
  const today = deps.clock.today(deps.cfg.org.timezone)
  const cfg = deps.cfg.ownerNotifications
  const report: RunReport = {
    runId: opts.runId,
    kind: 'pipeline',
    startedAt: deps.clock.nowIso(),
    finishedAt: deps.clock.nowIso(),
    dryRun: opts.dryRun,
    ok: true,
    counts: { ownerLeavers: 0, ownerMessages: 0, ownerSkippedBeforeGoLive: 0 },
    people: [],
    warnings: [],
    errors: [],
  }
  if (!cfg.enabled || !deps.register || !cfg.goLiveDate) return report

  let byOwner: Map<string, string[]>
  try {
    byOwner = await ownersFrom(deps.register)
  } catch (err) {
    report.ok = false
    report.errors.push(`owner notifications did not run: ${err instanceof Error ? err.message : String(err)}. Nothing was sent.`)
    return report
  }

  const rows = await deps.store.list({ status: ['terminated', 'offboarding', 'departed'], excludeHeld: true })
  for (const person of rows) {
    if (person.inScope === false) continue
    const leave = leaveDateOf(person)
    if (!leave || !(today > leave)) continue
    if (leave < cfg.goLiveDate) { report.counts.ownerSkippedBeforeGoLive = (report.counts.ownerSkippedBeforeGoLive ?? 0) + 1; continue }
    if (daysBetween(leave, today) > cfg.lookbackDays) continue

    const sent = { ...(person.offboarding?.ownersNotified ?? {}) }
    const todo = [...byOwner.entries()].filter(([owner]) => !sent[owner])
    if (todo.length === 0) continue
    report.counts.ownerLeavers = (report.counts.ownerLeavers ?? 0) + 1
    const ctx: AuditCtx = { person, runId: opts.runId, actor: opts.actor, dryRun: opts.dryRun }
    for (const [owner, platforms] of todo) {
      const delivered = await tellOwner(deps, ctx, owner, platforms, leave)
      if (delivered) {
        sent[owner] = today
        report.counts.ownerMessages = (report.counts.ownerMessages ?? 0) + 1
      } else {
        report.ok = false
        report.warnings.push(`${person.displayName}: the owner message to ${owner} was not delivered; it will be tried again next run`)
      }
    }
    if (!opts.dryRun) await persist(deps, person, sent)
  }
  report.finishedAt = deps.clock.nowIso()
  return report
}

async function ownersFrom(register: SaasRegisterAdapter): Promise<Map<string, string[]>> {
  const platforms = await register.listPlatforms()
  const byOwner = new Map<string, string[]>()
  for (const p of platforms) {
    if (p.handling.trim().toLowerCase() === 'retired') continue
    for (const owner of p.owners) byOwner.set(owner, [...(byOwner.get(owner) ?? []), p.name])
  }
  if (byOwner.size === 0) throw new Error('the register returned no owner addresses at all; refusing to treat that as nothing to send')
  for (const list of byOwner.values()) list.sort()
  return byOwner
}

async function tellOwner(deps: OwnerNotifyDeps, ctx: AuditCtx, owner: string, platforms: string[], leave: string): Promise<boolean> {
  const person = ctx.person
  const many = platforms.length > 1
  const body = renderNotification('leaver-owner', {
    personName: person.displayName,
    workEmail: person.primaryEmail,
    lastDay: leave,
    platformList: platforms.join(', '),
    these: many ? 'these platforms' : 'this platform',
    them: many ? 'these platforms' : 'it',
    itTeamSignature: deps.cfg.org.itTeamSignature,
  })
  const outcome = await auditedCall(deps, ctx, { action: 'notify.leaver.owner', target: 'notify', detail: { platforms: platforms.length } }, async () => {
    const r = await deps.notifier.send({
      kind: 'leaver.owner',
      subject: `${ctx.dryRun ? '[DRY RUN] ' : ''}Leaver: ${person.displayName}, please check ${platforms.join(', ')}`,
      body,
      audience: 'manager',
      recipients: [owner],
      detail: { hrisId: person.hrisId, platforms },
    })
    return r.delivered ? { ok: true, verified: true } : { ok: false, verified: false, error: r.error ?? 'not delivered', retryable: true }
  })
  return outcome.ok
}

async function persist(deps: OwnerNotifyDeps, person: Person, ownersNotified: Record<string, string>): Promise<void> {
  await deps.store.patch(person.hrisId, { offboarding: { suspendedAt: null, legs: {}, ...(person.offboarding ?? {}), ownersNotified } })
}
