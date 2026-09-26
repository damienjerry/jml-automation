/**
 * The HR system is the source of truth. Everything else in this toolkit is
 * downstream of it.
 *
 * The interface is deliberately small: one call that returns everybody, plus a
 * connection check. HiBob is the reference adapter, but the surface is thin
 * enough that another HR system is a day's work rather than a rewrite, which is
 * the point of publishing it.
 */

export interface HrisPerson {
  /** The HR system's stable id. Becomes Person.hrisId. */
  hrisId: string
  primaryEmail: string
  displayName: string
  firstName?: string | null
  lastName?: string | null
  department?: string | null
  jobTitle?: string | null
  site?: string | null
  managerEmail?: string | null
  /**
   * The manager's name as the HR system renders it.
   *
   * Carried separately from the address because a notification addressed to a
   * person reads better with their name, and because the two can disagree: the
   * HR system may know a manager by name while holding no usable address for
   * them.
   */
  managerName?: string | null
  /**
   * A non-work address the HR system holds for the person.
   *
   * Where the temporary password goes on activation, because the work
   * mailbox does not exist yet and the manager may be away. Validated at send
   * time: a company address in this field once sent a starter's credential to
   * a colleague's inbox, and the HR system is not exempt from that check.
   */
  personalEmail?: string | null
  /** ISO date. Never a locale-formatted string: see HrisAdapter. */
  startDate?: string | null
  /**
   * The contractual leaving date.
   *
   * Not on its own the day access ends. See `lastWorkingDay` and
   * `leaveDateOf()` in src/hris/leave-date.ts for how the two combine.
   */
  terminationDate?: string | null
  /**
   * The last day the person is actually in.
   *
   * Often earlier than the termination date: notice served away from work,
   * garden leave, a contract that ends on a Friday after a last shift on the
   * Wednesday. Access should stop the day after this, not the day after the
   * contract ends, so where both are held the earlier one decides. An adapter
   * that cannot read it leaves it null and the termination date is used.
   */
  lastWorkingDay?: string | null
  /**
   * Whether this person is somebody IT provisions accounts for.
   *
   * Many HR systems hold people who never get a work account: frontline
   * staff, contractors on their own kit. Treating every HR record as needing
   * accounts announces a joiner for each of them and looks up accounts that
   * were never created. `false` keeps them out of joiner announcements and, in
   * the next phase, out of activation. `null` means the adapter cannot tell
   * and they are treated as in scope, which is the safe direction: a person
   * wrongly in scope costs a lookup, a person wrongly out of scope costs their
   * accounts never being closed.
   */
  inScope?: boolean | null
}

export interface HrisSnapshot {
  /** Everybody the HR system knows about, including leavers. */
  all: HrisPerson[]
  /**
   * The ids the HR system reports as currently employed.
   *
   * This is a separate authoritative list rather than something derived from a
   * status string on each record, because a lifecycle label means different
   * things in different HR systems and in different configurations of the same
   * one. Absence from this set is what makes somebody a leaver.
   */
  activeIds: Set<string>
  fetchedAt: string
  /** True when every page was read. A partial snapshot must abort the sync. */
  complete: boolean
  /**
   * Oddities in individual records that did not justify abandoning the whole
   * snapshot: a missing address, an unparseable optional field.
   *
   * Without somewhere to put these, an adapter has only two options for a bad
   * record, and both are wrong: drop it silently, or abort the run for
   * everybody. Anything that would change an identity or a date still aborts.
   */
  warnings?: string[]
}

/** Thrown when the snapshot cannot be trusted. Both abort with zero writes. */
export class HrisIncomplete extends Error {
  readonly code = 'hris_incomplete'
}

/**
 * Thrown when the snapshot is suspiciously small.
 *
 * A truncated read looks exactly like a company where everybody left, and the
 * consequence of getting that wrong is suspending the entire staff. The floor
 * has no default: an adopter states their own headcount.
 */
export class HrisImplausible extends Error {
  readonly code = 'hris_implausible'
  readonly detail: { received: number; floor: number }
  constructor(message: string, detail: { received: number; floor: number }) {
    super(message)
    this.detail = detail
  }
}

export interface ConnectionCheck {
  ok: boolean
  /** What this credential turned out to be able to do. */
  detail: string
  /** Present when the check failed, pointing at the fix. */
  remediation?: string
  docsAnchor?: string
}

export interface HrisAdapter {
  readonly name: string
  /**
   * Read everybody.
   *
   * Implementations must: page until a short page rather than assuming one
   * call returns everything; request ISO dates rather than human-readable ones
   * and never parse a locale-formatted date; and mark the snapshot incomplete
   * rather than returning what they managed to read.
   */
  fetchAll(): Promise<HrisSnapshot>
  testConnection(): Promise<ConnectionCheck>
}
