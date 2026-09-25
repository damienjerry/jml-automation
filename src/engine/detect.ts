/**
 * Turning stored lifecycle state into events, and saying so once.
 *
 * The sync decides what somebody's status is. This step reads the store back
 * and names what that means: who is joining, who the engine will offboard on
 * this run, and who looks like a departure that nothing automatic will touch.
 *
 * Three rules, each from a way the automation this replaces got it wrong:
 *
 *  - Announce the HR-dated leavers as well as the doubtful ones. The original
 *    detector reported only the cases needing a decision, so the ordinary
 *    departures it was about to act on never appeared in its own summary, and
 *    the one useful line ("these accounts are being suspended today") was the
 *    line nobody ever saw.
 *  - The leaver set is read through the SAME filter the engine selects on, so
 *    the announcement cannot describe a different set from the one that is
 *    acted on. Two definitions of "who is leaving today" drift within weeks.
 *  - Nothing is announced twice. The change gate keys on the SET of people, not
 *    on a timestamp and not on our own bookkeeping, and it is committed only
 *    after the notification is proven delivered.
 *
 * Joiner events are emitted and consumed by nothing in Phase 1. That is
 * deliberate: it is where joiner activation hangs in the next phase, and
 * emitting them now means the shape is exercised by real data and a real
 * summary rather than designed later from memory.
 */

import { leaveDateOf } from '../hris/leave-date.ts'
import { daysBetween } from '../core/clock.ts'
import type { IsoDate } from '../core/clock.ts'
import type { ChangeGate, GateDecision } from '../core/gate.ts'
import { nullLogger } from '../core/logger.ts'
import type { Logger } from '../core/logger.ts'
import type { LifecycleStatus, Person, ReviewReason } from '../core/types.ts'
import { DAY0_SELECTION } from '../store/bootstrap.ts'
import type { PeopleStore } from '../store/types.ts'
import type { Notifier } from '../notify/types.ts'
import { terminationOutsideLookback } from './sync.ts'

export type LifecycleEventKind = 'joiner' | 'leaver' | 'potential_leaver'

export interface LifecycleEvent {
  kind: LifecycleEventKind
  hrisId: string
  /** Display name, never an address: this ends up in logs and chat. */
  label: string
  status: LifecycleStatus
  startDate?: string | null
  terminationDate?: string | null
  /** One sentence, printed as-is in the summary. */
  reason: string
  /** Days from today to the date this event turns on. Negative means passed. */
  daysUntil: number | null
  /**
   * True when the engine will act on this row on this run. A potential leaver
   * is never actionable; that is the whole distinction.
   */
  actionable: boolean
  reviewReason?: ReviewReason | null
}

export interface DetectCounts {
  joiner: number
  /** Started or starting, but not somebody IT provisions for. Counted so a quiet run is not mistaken for a broken read. */
  joinerOutOfScope: number
  leaver: number
  potentialLeaver: number
  /** Leavers the engine will actually start offboarding today. */
  actionable: number
}

export interface DetectReport {
  ok: boolean
  today: IsoDate
  events: LifecycleEvent[]
  counts: DetectCounts
  /** The rendered summary, whether or not it was announced. */
  summary: string
  /** Null when no gate was supplied, so the caller decides about noise. */
  gate: GateDecision | null
  announced: boolean
  warnings: string[]
  errors: string[]
}

export interface DetectOptions {
  people: PeopleStore
  /** Today in the organisation's own zone. The caller owns the clock. */
  today: IsoDate
  terminationLookbackDays: number
  /** How far ahead a future start date is worth announcing. */
  joinerLookaheadDays?: number
  /** How long after a start date somebody still counts as a joiner. */
  joinerGraceDays?: number
  /** Announce only when the set of people changed. Omit to always announce. */
  gate?: ChangeGate
  notifier?: Notifier
  logger?: Logger
}

const DEFAULT_LOOKAHEAD_DAYS = 14
const DEFAULT_GRACE_DAYS = 7

export async function runDetect(options: DetectOptions): Promise<DetectReport> {
  const { people, today } = options
  const logger = options.logger ?? nullLogger()
  const lookahead = options.joinerLookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS
  const grace = options.joinerGraceDays ?? DEFAULT_GRACE_DAYS

  const joiners = await joinerEvents(people, today, lookahead, grace)
  const events: LifecycleEvent[] = [
    ...joiners.events,
    ...(await leaverEvents(people, today, options.terminationLookbackDays)),
    ...(await scheduledLeaverEvents(people, today)),
  ]

  const counts: DetectCounts = {
    joiner: events.filter((e) => e.kind === 'joiner').length,
    joinerOutOfScope: joiners.outOfScope,
    leaver: events.filter((e) => e.kind === 'leaver').length,
    potentialLeaver: events.filter((e) => e.kind === 'potential_leaver').length,
    actionable: events.filter((e) => e.actionable).length,
  }

  const report: DetectReport = {
    ok: true,
    today,
    events,
    counts,
    summary: renderSummary(events, counts, today),
    gate: null,
    announced: false,
    warnings: [],
    errors: [],
  }

  // The fingerprint is over the set of people and what each one is, so a
  // person moving from potential leaver to leaver is news while a standing
  // list that has not moved is not.
  const items = events.map((event) => `${event.kind}:${event.hrisId}`)
  const decision = options.gate ? await options.gate.evaluate(items) : null
  report.gate = decision

  const worthSaying = events.length > 0 && (decision === null || decision.announce)
  if (worthSaying && options.notifier) {
    const result = await options.notifier.send({
      kind: 'run.summary',
      subject: `Lifecycle: ${counts.leaver} leaver(s), ${counts.potentialLeaver} to review, ${counts.joiner} joining`,
      body: report.summary,
      audience: 'it',
      detail: { counts, gate: decision?.reason ?? 'no gate' },
    })
    if (result.delivered) {
      report.announced = true
      // Committed only now. Recording at decision time means a failed post
      // silences the next run as well, and a silent gate looks exactly like a
      // fixed problem.
      if (options.gate && decision) await options.gate.commit(decision)
    } else {
      report.ok = false
      report.warnings.push(
        `The lifecycle summary was not delivered (${result.error ?? 'no reason given'}), so the gate was not committed and the next run will say it again.`,
      )
    }
  }

  logger.info('lifecycle detect finished', {
    counts,
    gate: decision?.reason ?? 'no gate',
    announced: report.announced,
  })
  return report
}

/**
 * People starting soon, and people who have just started.
 *
 * Both are joiners, and the second half is the one that matters to an IT team:
 * somebody whose first day has arrived and whose accounts nobody has finished
 * setting up. `activation.activatedAt` is the marker Phase 1b writes, so a row
 * drops out of this set once the work is really done rather than once a
 * schedule has run.
 */
async function joinerEvents(
  people: PeopleStore,
  today: IsoDate,
  lookaheadDays: number,
  graceDays: number,
): Promise<{ events: LifecycleEvent[]; outOfScope: number }> {
  const rows = await people.list({ status: ['hired', 'active'], excludeHeld: true })
  const events: LifecycleEvent[] = []
  let outOfScope = 0

  for (const person of rows) {
    if (person.activation?.activatedAt) continue
    const start = person.startDate
    if (!start) continue
    const days = daysBetween(today, start)
    // Somebody the HR system says IT does not provision for: no accounts to
    // set up, so nothing to announce. Counted rather than dropped, because a
    // run that announces nobody must be distinguishable from one that read
    // nobody. Only an explicit "no" excludes; unknown reads as in scope.
    if (person.inScope === false) {
      outOfScope += 1
      continue
    }

    if (person.status === 'hired' && days >= 0 && days <= lookaheadDays) {
      events.push(
        event(person, 'joiner', days, `Starts on ${start}, in ${days} day(s). Nothing is provisioned for a future start date.`),
      )
      continue
    }
    if (days <= 0 && days >= -graceDays) {
      events.push(event(person, 'joiner', days, `Started on ${start}, ${Math.abs(days)} day(s) ago, with no activation recorded.`))
    }
  }
  return { events, outOfScope }
}

/**
 * The leaver set, split by whether the engine will act.
 *
 * The actionable half is read through `DAY0_SELECTION`, which is the same
 * filter the engine selects on, and then narrowed by the leaving-date lookback.
 * Everything else terminated and unsuspended is a potential leaver: held,
 * parked, or carrying a date too old to trust.
 */
async function leaverEvents(
  people: PeopleStore,
  today: IsoDate,
  lookbackDays: number,
): Promise<LifecycleEvent[]> {
  const selectable = new Set(
    (await people.list({ ...DAY0_SELECTION })).map((person) => person.hrisId),
  )
  const rows = await people.list({ status: ['terminated'], suspendedAt: 'empty' })
  const events: LifecycleEvent[] = []

  for (const person of rows) {
    const date = leaveDateOf(person)
    const days = date ? daysBetween(today, date) : null
    const stale = terminationOutsideLookback(date, today, lookbackDays)

    if (selectable.has(person.hrisId) && !stale) {
      events.push(
        event(person, 'leaver', days, `Left on ${String(date)}. The engine will start offboarding on this run.`, true),
      )
      continue
    }
    events.push(event(person, 'potential_leaver', days, potentialReason(person, date, stale, lookbackDays)))
  }
  return events
}

function potentialReason(
  person: Person,
  date: string | null | undefined,
  stale: boolean,
  lookbackDays: number,
): string {
  if (person.hold) {
    return `Terminated, but held by a person${person.holdReason ? ` (${person.holdReason})` : ''}, so nothing automatic will touch it.`
  }
  if (person.reviewReason) {
    return `Terminated and parked as ${person.reviewReason}, so nothing automatic will touch it until somebody clears the reason.`
  }
  if (stale) {
    return date
      ? `Terminated with a leaving date of ${date}, outside the ${lookbackDays}-day lookback, so it may be historic.`
      : 'Terminated with no leaving date held by the HR system, so it cannot be told apart from a historic record.'
  }
  return 'Terminated, and not selectable on this run. Read the row before clearing anything.'
}

/**
 * Employed people who already carry a leaving date.
 *
 * Advance notice, and the one lifecycle event an IT team can act on before the
 * day it happens: kit to collect, licences to plan, a handover to arrange.
 */
async function scheduledLeaverEvents(people: PeopleStore, today: IsoDate): Promise<LifecycleEvent[]> {
  const rows = await people.list({ status: ['hired', 'active'], excludeHeld: true })
  const events: LifecycleEvent[] = []
  for (const person of rows) {
    const date = leaveDateOf(person)
    if (!date) continue
    const days = daysBetween(today, date)
    if (days < 0) continue
    events.push(
      event(
        person,
        'potential_leaver',
        days,
        `Still employed and carrying a leaving date of ${date}, in ${days} day(s). Nothing happens until the HR system drops them from the employed set.`,
      ),
    )
  }
  return events
}

function event(
  person: Person,
  kind: LifecycleEventKind,
  daysUntil: number | null,
  reason: string,
  actionable = false,
): LifecycleEvent {
  return {
    kind,
    hrisId: person.hrisId,
    label: person.displayName,
    status: person.status,
    startDate: person.startDate ?? null,
    terminationDate: person.terminationDate ?? null,
    reason,
    daysUntil,
    actionable,
    reviewReason: person.reviewReason ?? null,
  }
}

/**
 * The summary text.
 *
 * Built here rather than from a template because it is a list whose length
 * varies, and the notification templates deliberately have no loops: anything
 * needing a decision is decided in the engine and passed in as a rendered
 * string.
 */
export function renderSummary(
  events: readonly LifecycleEvent[],
  counts: DetectCounts,
  today: IsoDate,
): string {
  const lines = [`Lifecycle detection for ${today}`, '']
  if (events.length === 0) {
    lines.push('Nothing to report. No joiners, no leavers, nothing parked.')
    return lines.join('\n')
  }

  lines.push(
    `- Leavers the engine will start offboarding: ${counts.actionable}`,
    `- Terminated rows nothing will touch: ${counts.potentialLeaver}`,
    `- Joiners: ${counts.joiner}`,
    ...(counts.joinerOutOfScope > 0 ? [`- Joiners the HR system marks as not needing IT accounts: ${counts.joinerOutOfScope}`] : []),
    '',
  )
  for (const kind of ['leaver', 'potential_leaver', 'joiner'] as const) {
    const group = events.filter((e) => e.kind === kind)
    if (group.length === 0) continue
    lines.push(`${HEADINGS[kind]}:`, '')
    for (const item of group) lines.push(`- ${item.label} (${item.hrisId}): ${item.reason}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

const HEADINGS: Record<LifecycleEventKind, string> = {
  leaver: 'Leaving today',
  potential_leaver: 'For review, no automatic action',
  joiner: 'Joining',
}
