/**
 * The only place a lifecycle status is assigned.
 *
 * Every status change names the event that caused it and the kind of caller
 * allowed to cause it. A store refuses a write that is not in this table, so
 * "the HR sync must never revive a row the offboarding engine owns" is checked
 * on every write rather than being an instruction somebody has to remember.
 *
 * The rules encode failures that really happened in an earlier design. Each one names its incident so a future reader can tell a
 * safeguard from an accident. See docs/incidents.md.
 */

import type { LifecycleStatus, TransitionOwner } from './types.ts'

/** Something that can change a person's status. */
export type TransitionEvent =
  /** HR system says: start date is in the future. */
  | 'hris.hired'
  /** HR system says: employed, started. */
  | 'hris.active'
  /** HR system says: no longer in the active set. */
  | 'hris.terminated'
  /** The same HR id turned up as a genuinely different person. */
  | 'sync.role_change_tombstone'
  /** Offboarding began. Day-0 work has run. */
  | 'engine.day0_suspended'
  /** There was nothing to offboard: no accounts anywhere. */
  | 'engine.phantom_departed'
  /** Offboarding finished; accounts deleted. */
  | 'engine.day7_departed'
  /** A human closed the row by hand without automation touching accounts. */
  | 'human.tombstone'

export interface Transition {
  from: LifecycleStatus
  event: TransitionEvent
  to: LifecycleStatus
  owner: TransitionOwner
  /** Why this edge exists, or why it is deliberately absent elsewhere. */
  reason: string
}

/**
 * Statuses the HR sync passes through untouched.
 *
 * Incident: a data migration pruned the tombstone rows, the next sync saw
 * hundreds of historic leavers as brand new terminations, and the offboarding
 * engine began suspending accounts that had been closed for years. The sync
 * may still patch names and departments on these rows; it may never touch
 * their status.
 */
export const PRESERVED_BY_SYNC: readonly LifecycleStatus[] = ['offboarding', 'departed']

export const TRANSITIONS: readonly Transition[] = [
  // ---- Joining and employment: owned by the HR sync ----
  {
    from: 'hired',
    event: 'hris.active',
    to: 'active',
    owner: 'sync',
    reason: 'Start date reached and the person is in the HR active set.',
  },
  {
    from: 'hired',
    event: 'hris.terminated',
    to: 'terminated',
    owner: 'sync',
    reason: 'Start date reached but the person never appeared as active: an offer that fell through.',
  },
  {
    from: 'active',
    event: 'hris.hired',
    to: 'hired',
    owner: 'sync',
    reason: 'The HR system moved the start date into the future.',
  },
  {
    from: 'active',
    event: 'hris.terminated',
    to: 'terminated',
    owner: 'sync',
    reason: 'The person left the HR active set. The only route into offboarding.',
  },
  {
    from: 'terminated',
    event: 'hris.active',
    to: 'active',
    owner: 'sync',
    reason:
      'Rehired, or the leaving date was cancelled, BEFORE any suspension. Once suspendedAt is set the sync may not do this: it sets hold and parks the row instead, because unsuspending somebody is a decision for a person.',
  },
  {
    from: 'terminated',
    event: 'hris.hired',
    to: 'hired',
    owner: 'sync',
    reason: 'A cancelled leaver whose start date is now in the future (a returning contractor).',
  },
  {
    from: 'active',
    event: 'sync.role_change_tombstone',
    to: 'departed',
    owner: 'sync',
    reason:
      'The same HR id reappeared under an address that is not an alias, is not an exit-rename pattern, and carries no leaving date: a genuinely different identity. The old row is closed and a new one created. An address change that DOES carry a leaving date or match the exit pattern is an alias on the same row, never a new person: that mistake once let a renamed leaver inherit a live colleague\'s account ids.',
  },

  // ---- Offboarding: owned by the engine ----
  {
    from: 'terminated',
    event: 'engine.day0_suspended',
    to: 'offboarding',
    owner: 'engine',
    reason: 'Day 0 ran and suspendedAt was written. Written once; a row that has it is never selected again.',
  },
  {
    from: 'terminated',
    event: 'engine.phantom_departed',
    to: 'departed',
    owner: 'engine',
    reason:
      'No account exists anywhere for this person, so there is nothing to suspend. This is the landing zone a mistaken identity is defused into by clearing its account ids.',
  },
  {
    from: 'offboarding',
    event: 'engine.phantom_departed',
    to: 'departed',
    owner: 'engine',
    reason: 'A later phase found no accounts left to act on.',
  },
  {
    from: 'offboarding',
    event: 'engine.day7_departed',
    to: 'departed',
    owner: 'engine',
    reason: 'Deletion completed and was read back. The end of the automatic path.',
  },

  // ---- Closing a row by hand ----
  {
    from: 'terminated',
    event: 'human.tombstone',
    to: 'departed',
    owner: 'human',
    reason: 'A person decided this row needs no automated offboarding (historic, or handled manually).',
  },
  {
    from: 'offboarding',
    event: 'human.tombstone',
    to: 'departed',
    owner: 'human',
    reason: 'A person finished the offboarding by hand and closed the row.',
  },
]

/**
 * `departed` has no outgoing transition, deliberately. It is the guard that
 * stops a historic leaver being re-created and re-fired, so nothing may move a
 * row out of it — not the sync, not the engine, not a human command. Recreating
 * somebody means a new HR record, which means a new hrisId and a new row.
 */
export const TERMINAL_STATUSES: readonly LifecycleStatus[] = ['departed']

export type TransitionRefusal =
  /** No such edge exists in the table. */
  | 'illegal_transition'
  /** The edge exists but this kind of caller may not use it. */
  | 'owner_forbidden'
  /** The row moved underneath us; the caller's expected status is stale. */
  | 'stale_status'

export interface TransitionDecision {
  allowed: boolean
  to?: LifecycleStatus
  refusal?: TransitionRefusal
  reason?: string
}

/**
 * Decide whether a status change may happen. Pure: the caller does the writing.
 *
 * `expectFrom` is the status the caller believes the row currently holds, so a
 * store can compare-and-set and refuse a write based on a stale read.
 */
export function decideTransition(
  current: LifecycleStatus,
  expectFrom: LifecycleStatus,
  event: TransitionEvent,
  owner: TransitionOwner,
): TransitionDecision {
  if (current !== expectFrom) {
    return {
      allowed: false,
      refusal: 'stale_status',
      reason: `Row is ${current}, caller expected ${expectFrom}.`,
    }
  }
  if (TERMINAL_STATUSES.includes(current)) {
    return {
      allowed: false,
      refusal: 'illegal_transition',
      reason: `${current} is terminal and has no outgoing transition.`,
    }
  }

  const byEdge = TRANSITIONS.filter((t) => t.from === current && t.event === event)
  if (byEdge.length === 0) {
    return {
      allowed: false,
      refusal: 'illegal_transition',
      reason: `No transition from ${current} on ${event}.`,
    }
  }

  const permitted = byEdge.find((t) => t.owner === owner)
  if (!permitted) {
    const owners = byEdge.map((t) => t.owner).join(', ')
    return {
      allowed: false,
      refusal: 'owner_forbidden',
      reason: `${event} from ${current} belongs to ${owners}, not ${owner}.`,
    }
  }

  return { allowed: true, to: permitted.to, reason: permitted.reason }
}

/** True when the HR sync must leave this row's status alone. */
export function isPreservedBySync(status: LifecycleStatus): boolean {
  return PRESERVED_BY_SYNC.includes(status)
}
