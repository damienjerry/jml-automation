/**
 * Telling people what the engine did, and not telling them twice.
 *
 * Two rules run through this file.
 *
 * A notification is a mutation. It leaves the process and reaches a person, so
 * it gets the same intent-then-outcome audit pair as a provider call, and its
 * delivery is checked rather than assumed. A chat API answering 200 with a
 * failure in the body is what silently stopped three workflows posting for
 * weeks in the automation this replaces, so an undelivered notification makes
 * the run not ok.
 *
 * A standing problem is reported when it changes, not while it persists. The
 * blocked and parked notes go through the change gate, keyed on the SET of
 * things being reported. The earlier version re-sent the same blocked note
 * three times a day until somebody resolved it, so the channel stopped being
 * read, and the day the list actually changed looked like every other day.
 *
 * The templates carry no logic, so every decision is made here and passed in
 * as a rendered string. Anything that needs a conditional gets decided in
 * TypeScript, where it can be tested.
 */

import { leaveDateOf } from '../../hris/leave-date.ts'
import { addDays } from '../../core/clock.ts'
import { createChangeGate, type ReraiseDay } from '../../core/gate.ts'
import { renderNotification } from '../../notify/fanout.ts'
import type { Notification, NotificationResult } from '../../notify/types.ts'
import type { Person, RunReport } from '../../core/types.ts'
import { blockedItems, describeDevices, type GateResult } from './gate.ts'
import { auditedCall, type AuditCtx, type LeaverDeps, type LegResult } from './legs.ts'

/** What the engine records about one attempt to tell somebody. */
export interface NotifyReport {
  delivered: boolean
  /** Empty when nothing needed saying. Used to explain a silent run. */
  reasons: string[]
}

const DELIVERED: NotifyReport = { delivered: true, reasons: [] }

function dryPrefix(dryRun: boolean): string {
  // Never suppressed in a dry run, only marked. Somebody rehearsing needs to
  // read the exact note their leaver's manager would receive.
  return dryRun ? '[DRY RUN] ' : ''
}

/** A value a template can render. Empty strings throw, so absences are named. */
function orElse(value: string | null | undefined, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? fallback : text
}

interface PersonFields {
  personName: string
  personEmail: string
  hrisId: string
  terminationDate: string
}

function personFields(person: Person): PersonFields {
  return {
    personName: orElse(person.displayName, person.primaryEmail),
    personEmail: orElse(person.primaryEmail, 'no address recorded'),
    hrisId: person.hrisId,
    terminationDate: orElse(leaveDateOf(person), 'not recorded'),
  }
}

/** The dated milestones a manager needs, derived from the day-0 marker. */
export function offboardDates(person: Person, deps: LeaverDeps, today: string): {
  suspendedOn: string
  transferOn: string
  deleteOn: string
} {
  const suspendedOn = (person.offboarding?.suspendedAt ?? today).slice(0, 10)
  return {
    suspendedOn,
    transferOn: addDays(suspendedOn, deps.cfg.leaver.transferDay),
    deleteOn: addDays(suspendedOn, deps.cfg.leaver.deleteDay),
  }
}

/**
 * What the messages say about deletion, from the policy in force.
 *
 * The wording for automatic deletion is the long-standing text. Under
 * `leaver.deletion: never` the messages must not tell a manager the accounts
 * will be gone on a date, because they will not.
 */
export function deletionPlan(cfg: LeaverDeps['cfg'], deleteOn: string, style: 'manager' | 'it' | 'ticket'): string {
  const never = cfg.leaver.deletion === 'never'
  if (style === 'manager') {
    return never
      ? '- Their accounts are then kept, not deleted. IT will close them by hand when they\n  are no longer needed.'
      : `- On ${deleteOn} their accounts are deleted permanently. After that date their\n  mail and any file still owned by their account cannot be recovered.\n\nIf you need anything else from their account, ask before ${deleteOn}. Once the\naccounts are gone there is nothing left to recover from.`
  }
  if (style === 'ticket') {
    return never ? 'accounts are then kept; deletion is off (leaver.deletion: never)' : `${deleteOn}: accounts deleted, if every gate opens`
  }
  return never
    ? 'Deletion is off (leaver.deletion: never): the accounts are kept after the hand-over. Close them by hand, then run `jml leaver tombstone`.'
    : cfg.identity.adapter === 'none'
      ? `Deletion is due ${deleteOn}, and is refused until the transfer has completed.`
      : `Deletion is due ${deleteOn}, and is refused\nuntil the transfer has completed and no device is still bound to this person.`
}

/** One bullet per leg, in the order the legs ran. */
export function describeLegs(legs: readonly LegResult[]): string {
  if (legs.length === 0) return '- nothing to do'
  return legs.map((leg) => `- ${leg.name}: ${leg.note}`).join('\n')
}

/**
 * Send one notification, audited and delivery-checked.
 *
 * The result is returned rather than thrown on, because a failed notification
 * must not roll back work that already happened. The account really is
 * suspended; what failed is telling somebody about it.
 */
async function send(deps: LeaverDeps, ctx: AuditCtx, n: Notification): Promise<NotificationResult> {
  let result: NotificationResult = { delivered: false, channel: 'none', error: 'the notifier was never called' }
  await auditedCall(deps, ctx, { action: `notify.${n.kind}`, target: 'notify', detail: { audience: n.audience } }, async () => {
    result = await deps.notifier.send(n)
    if (result.delivered) return { ok: true, verified: true, detail: { channel: result.channel } }
    return {
      ok: false,
      verified: false,
      error: `the ${n.kind} notification was not delivered: ${result.error ?? 'no reason given'}`,
      retryable: true,
      detail: { channel: result.channel },
    }
  })
  if (!result.delivered) {
    deps.logger.warn('a notification was not delivered', {
      kind: n.kind,
      hrisId: ctx.person.hrisId,
      channel: result.channel,
      err: result.error,
    })
  }
  return result
}

function collect(results: readonly NotificationResult[]): NotifyReport {
  const failed = results.filter((r) => !r.delivered)
  return {
    delivered: failed.length === 0,
    reasons: failed.map((r) => `${r.channel}: ${r.error ?? 'no reason given'}`),
  }
}

/**
 * Day 0: tell the manager and the IT team.
 *
 * The manager note names every step, says the files arrive on the hand-over
 * day, and gives the dated deadline after which nothing can be recovered. That
 * last sentence is the one that gets read, and it is why the deletion date is
 * a rendered value rather than "in a week".
 */
export async function notifyDay0(
  deps: LeaverDeps,
  ctx: AuditCtx,
  legs: readonly LegResult[],
  today: string,
): Promise<NotifyReport> {
  const person = ctx.person
  const dates = offboardDates(person, deps, today)
  const actionsTaken = describeLegs(legs)
  const partial = legs.some((leg) => leg.record.state === 'failed')
  const results: NotificationResult[] = []

  if (deps.cfg.mail.managerOnDay0) {
    const managerEmail = person.managerEmail?.trim() ?? ''
    const body = renderNotification('day0-manager', {
      // The row carries no manager display name, so the address is the label.
      // A guessed first name in a greeting is worse than a plain address.
      managerFirstName: orElse(managerEmail, 'Colleague'),
      personName: personFields(person).personName,
      orgName: deps.cfg.org.name,
      suspendedOn: dates.suspendedOn,
      actionsTaken,
      transferOn: dates.transferOn,
      deletionPlan: deletionPlan(deps.cfg, dates.deleteOn, 'manager'),
      itTeamSignature: deps.cfg.org.itTeamSignature,
    })
    results.push(
      await send(deps, ctx, {
        kind: 'leaver.day0',
        subject: `${dryPrefix(ctx.dryRun)}${personFields(person).personName} has left ${deps.cfg.org.name}`,
        body,
        audience: 'manager',
        managerEmail: managerEmail === '' ? null : managerEmail,
      }),
    )
  }

  const itBody = renderNotification('day0-it', {
    ...personFields(person),
    suspendedAt: dates.suspendedOn,
    managerStatus: orElse(person.managerEmail, 'no manager address in the HR record'),
    actionsTaken,
    transferOn: dates.transferOn,
    deletionPlan: deletionPlan(deps.cfg, dates.deleteOn, 'it'),
  })
  results.push(
    await send(deps, ctx, {
      kind: 'leaver.day0',
      subject: `${dryPrefix(ctx.dryRun)}Day 0${partial ? ' (with failed steps)' : ''}: ${personFields(person).personName}`,
      body: itBody,
      audience: 'it',
    }),
  )
  return collect(results)
}

export async function notifyDay6(
  deps: LeaverDeps,
  ctx: AuditCtx,
  legs: readonly LegResult[],
  today: string,
): Promise<NotifyReport> {
  const person = ctx.person
  const transfer = legs.find((leg) => leg.name === 'transfer_drive')
  const google = legs.find((leg) => leg.name === 'suspend_google')
  const body = renderNotification('day6', {
    ...personFields(person),
    transferStatus: orElse(transfer?.note, 'no hand-over was attempted'),
    transferRecipient: orElse(person.offboarding?.transferRecipient, 'nobody yet'),
    googleStatus: orElse(google?.note, 'no Google step was attempted'),
    deletionPlan: deletionPlan(deps.cfg, offboardDates(person, deps, today).deleteOn, 'it'),
  })
  return collect([
    await send(deps, ctx, {
      kind: 'leaver.day6',
      subject: `${dryPrefix(ctx.dryRun)}Day 6 hand-over: ${personFields(person).personName}`,
      body,
      audience: 'it',
    }),
  ])
}

export async function notifyDay7(
  deps: LeaverDeps,
  ctx: AuditCtx,
  legs: readonly LegResult[],
): Promise<NotifyReport> {
  const person = ctx.person
  const body = renderNotification('day7', {
    ...personFields(person),
    idpStatus: orElse(legs.find((l) => l.name === 'delete_idp')?.note, 'not attempted'),
    googleStatus: orElse(legs.find((l) => l.name === 'delete_google')?.note, 'not attempted'),
    transferRecipient: orElse(person.offboarding?.transferRecipient, 'nobody: no hand-over was recorded'),
  })
  return collect([
    await send(deps, ctx, {
      kind: 'leaver.day7',
      subject: `${dryPrefix(ctx.dryRun)}Day 7 complete: ${personFields(person).personName}`,
      body,
      audience: 'it',
    }),
  ])
}

function reraiseDay(deps: LeaverDeps): ReraiseDay {
  return deps.cfg.notify.weeklyReraiseDay as ReraiseDay
}

/**
 * A blocked deletion, reported only when the blockage changes.
 *
 * The gate is keyed on the machine ids and the reason. It is committed only
 * after the note is delivered, so a failed post does not silence the next run
 * as well.
 */
export async function notifyBlocked(deps: LeaverDeps, ctx: AuditCtx, gate: GateResult): Promise<NotifyReport> {
  if (gate.open) return DELIVERED
  const person = ctx.person
  const changeGate = createChangeGate({
    subject: `leaver.blocked:${person.hrisId}`,
    state: deps.state,
    clock: deps.clock,
    timezone: deps.cfg.org.timezone,
    weeklyReraiseDay: reraiseDay(deps),
    logger: deps.logger,
  })
  const decision = await changeGate.evaluate(blockedItems(gate.reason, gate.devices ?? []))
  if (!decision.announce) {
    return { delivered: true, reasons: [`the blockage is unchanged (${decision.reason}), so nothing was sent`] }
  }

  const body = renderNotification('blocked', {
    ...personFields(person),
    blockedReason: gate.reason,
    blockingDetail: gate.devices?.length ? describeDevices(gate.devices) : gate.detail,
    runbookHint: 'See docs/runbooks/clear-a-blocked-deletion.md.',
  })
  const result = await send(deps, ctx, {
    kind: 'leaver.blocked',
    subject: `${dryPrefix(ctx.dryRun)}Deletion blocked (${gate.reason}): ${personFields(person).personName}`,
    body,
    audience: 'it',
    detail: { reason: gate.reason, devices: (gate.devices ?? []).length },
  })
  // Recorded only on delivery, and never in a dry run. Recording at decision
  // time means a failed post suppresses the next run, and recording during a
  // rehearsal would suppress the first real one.
  if (result.delivered && !ctx.dryRun) await changeGate.commit(decision)
  return collect([result])
}

/** A parked row, reported once per reason rather than once per run. */
export async function notifyParked(deps: LeaverDeps, ctx: AuditCtx, reason: string, hint: string): Promise<NotifyReport> {
  const person = ctx.person
  const changeGate = createChangeGate({
    subject: `leaver.parked:${person.hrisId}`,
    state: deps.state,
    clock: deps.clock,
    timezone: deps.cfg.org.timezone,
    weeklyReraiseDay: reraiseDay(deps),
    logger: deps.logger,
  })
  const decision = await changeGate.evaluate([`reason:${reason}`])
  if (!decision.announce) {
    return { delivered: true, reasons: [`this row is already parked for ${reason}, so nothing was sent`] }
  }
  const body = renderNotification('parked', {
    ...personFields(person),
    reviewReason: reason,
    reviewHint: hint,
  })
  const result = await send(deps, ctx, {
    kind: 'leaver.parked',
    subject: `${dryPrefix(ctx.dryRun)}Parked for review (${reason}): ${personFields(person).personName}`,
    body,
    audience: 'it',
  })
  if (result.delivered && !ctx.dryRun) await changeGate.commit(decision)
  return collect([result])
}

/** The run summary. Sent every run: it is the record that the run happened. */
export async function notifyRunSummary(deps: LeaverDeps, ctx: AuditCtx, report: RunReport): Promise<NotifyReport> {
  const counts = report.counts
  const detail = [
    report.warnings.length > 0 ? `Warnings:\n${report.warnings.map((w) => `- ${w}`).join('\n')}` : '',
    report.errors.length > 0 ? `Errors:\n${report.errors.map((e) => `- ${e}`).join('\n')}` : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n')
  const body = renderNotification('run-summary', {
    runKind: report.kind,
    runId: report.runId,
    outcome: report.ok ? 'ok' : 'FINISHED WITH FAILURES',
    mode: report.dryRun ? 'dry run' : 'armed',
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    countDay0: counts.day0 ?? 0,
    countDay6: counts.day6 ?? 0,
    countDay7: counts.day7 ?? 0,
    countBlocked: counts.blocked ?? 0,
    countParked: counts.parked ?? 0,
    countHold: counts.held ?? 0,
    countFailedSteps: counts.failedLegs ?? 0,
    detail: detail === '' ? 'Nothing else to report.' : detail,
  })
  return collect([
    await send(deps, ctx, {
      kind: 'run.summary',
      subject: `${dryPrefix(report.dryRun)}${report.kind} run ${report.ok ? 'ok' : 'with failures'}`,
      body,
      audience: 'it',
    }),
  ])
}

/** A run that refused to do anything. Always sent: silence would look healthy. */
export async function notifyRunAborted(deps: LeaverDeps, ctx: AuditCtx, report: RunReport): Promise<NotifyReport> {
  const body = renderNotification('run-aborted', {
    runKind: report.kind,
    runId: report.runId,
    abortReason: report.aborted?.reason ?? 'unknown',
    abortDetail: JSON.stringify(report.aborted?.detail ?? {}),
  })
  return collect([
    await send(deps, ctx, {
      kind: 'run.aborted',
      subject: `${dryPrefix(report.dryRun)}${report.kind} run ABORTED: ${report.aborted?.reason ?? 'unknown'}`,
      body,
      audience: 'it',
    }),
  ])
}

/**
 * The audit subject for a run-level notification.
 *
 * A run is not a person, and the audit row says so rather than borrowing
 * somebody's HR id to hang the row on.
 */
export function runAuditCtx(runId: string, actor: AuditCtx['actor'], dryRun: boolean): AuditCtx {
  return {
    runId,
    actor,
    dryRun,
    person: {
      hrisId: `run:${runId}`,
      status: 'active',
      primaryEmail: '',
      aliasEmails: [],
      displayName: `run ${runId}`,
      hold: false,
      externalIds: {},
    },
  }
}
