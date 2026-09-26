/**
 * Where the ticketing system meets the lifecycle.
 *
 * Three jobs, all optional and all off when no adapter is configured:
 *
 *  1. Nudge: when a joiner is detected and the activation gate is closed, ask
 *     the manager to raise the starter form. Once per person, recorded on the
 *     row, so a run firing is never a reason to ask again.
 *  2. Remind: the day before the start date, if the gate is still closed,
 *     tell the manager once that the account will not work tomorrow.
 *  3. Leaver ticket: when a leaver first becomes a day-0 candidate, raise a
 *     ticket carrying the plan, once.
 *
 * The fourth job, opening the gate from an inbound ticket, is in bridge.ts
 * because it is driven by a webhook rather than by the pipeline.
 */

import { deletionPlan } from '../leaver/notify.ts'
import { addDays, daysBetween } from '../../core/clock.ts'
import type { RunReport } from '../../core/types.ts'
import { leaveDateOf } from '../../hris/leave-date.ts'
import type { TicketRef, TicketingAdapter } from '../../ticketing/types.ts'
import { renderNotification } from '../../notify/fanout.ts'
import { auditedCall, type AuditCtx, type LeaverDeps } from '../leaver/legs.ts'
import { DAY0_SELECTION } from '../../store/bootstrap.ts'
import { addWorkingDays } from '../joiner/workdays.ts'

export interface TicketingDeps extends LeaverDeps {
  ticketing: TicketingAdapter | null
}

export interface TicketingRunOptions {
  dryRun: boolean
  actor: AuditCtx['actor']
  runId: string
}

export async function runTicketing(deps: TicketingDeps, opts: TicketingRunOptions): Promise<RunReport> {
  const today = deps.clock.today(deps.cfg.org.timezone)
  const report: RunReport = {
    runId: opts.runId,
    kind: 'pipeline',
    startedAt: deps.clock.nowIso(),
    finishedAt: deps.clock.nowIso(),
    dryRun: opts.dryRun,
    ok: true,
    counts: { ticketNudged: 0, ticketReminded: 0, leaverTickets: 0 },
    people: [],
    warnings: [],
    errors: [],
  }
  const cfg = deps.cfg.ticketing
  if (cfg.adapter === 'none') return report

  const gated = deps.cfg.joiner.gate !== 'none'
  if (gated && (cfg.nudgeManager || cfg.dayBeforeReminder)) {
    const holidays = new Set(deps.cfg.joiner.holidays)
    const horizon = addWorkingDays(today, Math.max(deps.cfg.joiner.leadWorkingDays, 1) + 10, holidays)
    const rows = await deps.store.list({ status: ['hired', 'active'], excludeHeld: true })
    for (const person of rows) {
      if (!person.startDate || person.inScope === false || person.activation?.activatedAt || person.activation?.gateOpenedAt || person.activation?.refusedReason) continue
      // Past the grace period they are an existing employee, and their
      // manager is not asked to raise a starter form for somebody who has
      // been here a year.
      if (daysBetween(person.startDate, today) > deps.cfg.joiner.graceDays) continue
      const ctx: AuditCtx = { person, runId: opts.runId, actor: opts.actor, dryRun: opts.dryRun }
      try {
        if (cfg.nudgeManager && !person.activation?.nudgedAt && person.startDate <= horizon) {
          if (await nudge(deps, ctx, today)) report.counts.ticketNudged = (report.counts.ticketNudged ?? 0) + 1
        }
        if (cfg.dayBeforeReminder && !person.activation?.remindedAt && person.startDate === addDays(today, 1)) {
          if (await remind(deps, ctx, today)) report.counts.ticketReminded = (report.counts.ticketReminded ?? 0) + 1
        }
      } catch (err) {
        report.ok = false
        report.errors.push(`${person.displayName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (cfg.leaverTicket && deps.ticketing) {
    const due = await deps.store.list({ ...DAY0_SELECTION })
    for (const person of due) {
      if (person.offboarding?.ticketRef) continue
      const ctx: AuditCtx = { person, runId: opts.runId, actor: opts.actor, dryRun: opts.dryRun }
      try {
        if (await leaverTicket(deps, ctx, deps.ticketing, today)) report.counts.leaverTickets = (report.counts.leaverTickets ?? 0) + 1
      } catch (err) {
        report.ok = false
        report.errors.push(`${person.displayName}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  report.finishedAt = deps.clock.nowIso()
  return report
}

async function managerOf(deps: TicketingDeps, ctx: AuditCtx, kind: 'joiner.nudge' | 'joiner.reminder'): Promise<string | null> {
  const manager = ctx.person.managerEmail?.trim() ?? ''
  if (manager && deps.domain.isOurs(manager)) return manager
  // Nobody to ask. Said to IT once, on the row, rather than every run.
  await deps.notifier.send({
    kind: 'ticket.unmatched',
    subject: `Nobody to ask about ${ctx.person.displayName}`,
    body: `${ctx.person.displayName} (${ctx.person.hrisId}) starts on ${ctx.person.startDate ?? 'an unknown date'} and needs the starter form raised, but the HR record holds no usable manager address (${manager || 'none'}). Somebody has to raise it, or open the gate with \`jml joiner approve\`.`,
    audience: 'it',
    detail: { hrisId: ctx.person.hrisId, kind },
  })
  return null
}

async function nudge(deps: TicketingDeps, ctx: AuditCtx, today: string): Promise<boolean> {
  const manager = await managerOf(deps, ctx, 'joiner.nudge')
  if (!ctx.dryRun) await deps.store.patch(ctx.person.hrisId, { activation: { ...(ctx.person.activation ?? {}), nudgedAt: today } })
  if (!manager) return false
  const body = renderNotification('joiner-nudge', {
    personName: ctx.person.displayName,
    startDate: ctx.person.startDate ?? 'an unresolved date',
    formInstruction: deps.cfg.ticketing.formInstruction,
    itTeamSignature: deps.cfg.org.itTeamSignature,
  })
  const outcome = await auditedCall(deps, ctx, { action: 'notify.joiner.nudge', target: 'notify', detail: { audience: 'manager' } }, async () => {
    const r = await deps.notifier.send({ kind: 'joiner.nudge', subject: `${ctx.dryRun ? '[DRY RUN] ' : ''}New starter: ${ctx.person.displayName} needs IT set up before ${ctx.person.startDate}`, body, audience: 'manager', managerEmail: manager })
    return r.delivered ? { ok: true, verified: true } : { ok: false, verified: false, error: r.error ?? 'not delivered', retryable: true }
  })
  return outcome.ok
}

async function remind(deps: TicketingDeps, ctx: AuditCtx, today: string): Promise<boolean> {
  const manager = await managerOf(deps, ctx, 'joiner.reminder')
  if (!ctx.dryRun) await deps.store.patch(ctx.person.hrisId, { activation: { ...(ctx.person.activation ?? {}), remindedAt: today } })
  if (!manager) return false
  const body = renderNotification('joiner-reminder', {
    personName: ctx.person.displayName,
    formInstruction: deps.cfg.ticketing.formInstruction,
    itTeamSignature: deps.cfg.org.itTeamSignature,
  })
  const outcome = await auditedCall(deps, ctx, { action: 'notify.joiner.reminder', target: 'notify', detail: { audience: 'manager' } }, async () => {
    const r = await deps.notifier.send({ kind: 'joiner.reminder', subject: `${ctx.dryRun ? '[DRY RUN] ' : ''}Last chance: ${ctx.person.displayName} starts tomorrow`, body, audience: 'manager', managerEmail: manager })
    return r.delivered ? { ok: true, verified: true } : { ok: false, verified: false, error: r.error ?? 'not delivered', retryable: true }
  })
  return outcome.ok
}

async function leaverTicket(deps: TicketingDeps, ctx: AuditCtx, adapter: TicketingAdapter, today: string): Promise<boolean> {
  const person = ctx.person
  const leaving = leaveDateOf(person) ?? today
  const description = renderNotification('leaver-ticket', {
    personName: person.displayName,
    workEmail: person.primaryEmail,
    hrisId: person.hrisId,
    leavingDate: leaving,
    transferOn: addDays(leaving, deps.cfg.leaver.transferDay),
    deletionPlan: deletionPlan(deps.cfg, addDays(leaving, deps.cfg.leaver.deleteDay), 'ticket'),
    managerEmail: person.managerEmail ?? 'none held',
  })
  if (ctx.dryRun) return true
  let ref: TicketRef | null = null
  const outcome = await auditedCall(deps, ctx, { action: 'ticket.leaver.create', target: 'notify', detail: { adapter: adapter.name } }, async () => {
    const created = await adapter.createTicket({
      kind: 'leaver',
      person,
      subject: `Leaver: ${person.displayName}`,
      description,
      dueDate: addDays(leaving, 1),
      tags: ['Offboard'],
    })
    ref = created.ticket
    return created.outcome
  })
  if (!outcome.ok || !ref) return false
  await deps.store.patch(person.hrisId, { offboarding: { suspendedAt: null, legs: {}, ...(person.offboarding ?? {}), ticketRef: ref } })
  return true
}
