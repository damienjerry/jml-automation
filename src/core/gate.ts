/**
 * The change gate: report when something changes, not while a known state
 * persists.
 *
 * A schedule firing is not news. An earlier design posted the same
 * standing problem three times a day, to a channel that stopped being read
 * because of it, and the one day the set of affected people actually changed
 * looked exactly like the two hundred days before it.
 *
 * Three rules, each from a way an earlier gate failed:
 *
 *  - The fingerprint is over the SET of things being reported, never over a
 *    timestamp and never over a field we write ourselves. A gate keyed on when
 *    we last posted fires every run. A gate keyed on our own bookkeeping goes
 *    silent the moment that field changes shape, and a silent gate looks
 *    exactly like a fixed problem.
 *  - A weekly re-raise fires once on its weekday, not on every run of that
 *    weekday. A weekday test is true for all forty-eight of Monday's runs, so
 *    a calendar condition needs "and we have not done it yet today".
 *  - Recording happens in `commit`, after the notification is proven
 *    delivered. Recording at decision time means a failed post silences the
 *    next run as well.
 *
 * The failure direction is over-suppression, and over-suppression is silent, so
 * anything that goes wrong here announces rather than withholds.
 */

import { createHash } from 'node:crypto'
import type { StateStore } from '../store/types.ts'
import type { Clock, Weekday } from './clock.ts'
import { weekdayOf } from './clock.ts'
import type { Logger } from './logger.ts'

export type ReraiseDay = Weekday | 'none'

export type GateReason =
  /** Nothing to report. Silence here is honest, not suppression. */
  | 'nothing_to_report'
  /** We have never reported on this subject and there is something to say. */
  | 'first_sight'
  /** The set of things being reported is different from last time. */
  | 'changed'
  /** Same set, but it is the configured weekday and we have not re-raised today. */
  | 'weekly_reraise'
  | 'unchanged'
  /** The bookkeeping could not be read, so we announce rather than guess. */
  | 'state_unavailable'

export interface GateDecision {
  announce: boolean
  reason: GateReason
  fingerprint: string
  previous: string | null
  /** The normalised set the fingerprint was taken over, for the audit detail. */
  items: string[]
}

export interface ChangeGate {
  /** Pure decision. Writes nothing. */
  evaluate(items: readonly string[]): Promise<GateDecision>
  /** Call only after the notification was delivered. */
  commit(decision: GateDecision): Promise<void>
}

export interface ChangeGateOptions {
  /** Names the subject, for example `leaver.blocked`. One gate per subject. */
  subject: string
  state: StateStore
  clock: Clock
  timezone: string
  weeklyReraiseDay?: ReraiseDay
  logger?: Logger
}

/**
 * The fingerprint of a set.
 *
 * Sorted and deduped first, so the same set in a different order is the same
 * fingerprint. That matters more than it sounds: an earlier gate hashed a
 * rendered message, a language model regrouped the items every run, and the
 * gate treated the regrouping as new information every time.
 */
export function fingerprintOf(items: readonly string[]): string {
  const normalised = [...new Set(items.map((i) => String(i).trim()).filter((i) => i !== ''))].sort()
  const hash = createHash('sha256')
  hash.update(JSON.stringify(normalised))
  return hash.digest('hex').slice(0, 32)
}

export function normaliseItems(items: readonly string[]): string[] {
  return [...new Set(items.map((i) => String(i).trim()).filter((i) => i !== ''))].sort()
}

export function createChangeGate(options: ChangeGateOptions): ChangeGate {
  const reraiseDay = options.weeklyReraiseDay ?? 'monday'
  // Built by concatenation rather than interpolation: eslint forbids putting a
  // name ending in "key" inside a template literal, and the rule is worth more
  // than the shorter line.
  const setKeyName = 'gate:' + options.subject
  const reraiseKeyName = 'gate:' + options.subject + ':reraised-on'

  return {
    async evaluate(items) {
      const normalised = normaliseItems(items)
      const fingerprint = fingerprintOf(normalised)

      let previous: string | null = null
      try {
        previous = (await options.state.getFingerprint(setKeyName))?.value ?? null
      } catch (err) {
        options.logger?.warn('change gate could not read its state, announcing rather than withholding', {
          subject: options.subject,
          err,
        })
        return { announce: true, reason: 'state_unavailable', fingerprint, previous: null, items: normalised }
      }

      if (normalised.length === 0) {
        return { announce: false, reason: 'nothing_to_report', fingerprint, previous, items: normalised }
      }
      if (previous === null) {
        return { announce: true, reason: 'first_sight', fingerprint, previous, items: normalised }
      }
      if (previous !== fingerprint) {
        return { announce: true, reason: 'changed', fingerprint, previous, items: normalised }
      }

      if (reraiseDay !== 'none') {
        const today = options.clock.today(options.timezone)
        if (weekdayOf(today) === reraiseDay) {
          let lastReraise: string | null = null
          try {
            lastReraise = (await options.state.getFingerprint(reraiseKeyName))?.value ?? null
          } catch {
            // Unreadable bookkeeping cannot be allowed to suppress the one
            // scheduled reminder that a standing problem still exists.
            lastReraise = null
          }
          if (lastReraise !== today) {
            return { announce: true, reason: 'weekly_reraise', fingerprint, previous, items: normalised }
          }
        }
      }

      return { announce: false, reason: 'unchanged', fingerprint, previous, items: normalised }
    },

    async commit(decision) {
      if (decision.reason === 'state_unavailable') return
      try {
        await options.state.setFingerprint(setKeyName, decision.fingerprint)
        if (decision.reason === 'weekly_reraise') {
          await options.state.setFingerprint(reraiseKeyName, options.clock.today(options.timezone))
        }
      } catch (err) {
        // A failed write means the next run announces again. Noisy, and the
        // right way round: the alternative is losing the notification.
        options.logger?.warn('change gate could not record its state; the next run will announce again', {
          subject: options.subject,
          err,
        })
      }
    },
  }
}
