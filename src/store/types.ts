/**
 * Where the canonical person records live.
 *
 * Two stores, deliberately separate:
 *  - PeopleStore holds people. It can be SQLite (the default), or an adapter
 *    over something an IT team already reads, like a Notion database or a
 *    spreadsheet.
 *  - StateStore holds the toolkit's own bookkeeping: run leases, alert
 *    fingerprints, invariant counters, run history. It is ALWAYS local SQLite,
 *    whatever the people store is, because a lease that lives in a remote
 *    document with no transactions is not a lease.
 */

import type { LifecycleStatus, Person, TransitionOwner } from '../core/types.ts'
import type { TransitionEvent, TransitionRefusal } from '../core/transitions.ts'

export interface PersonFilter {
  status?: LifecycleStatus[]
  /** Exclude rows a human has frozen. Every engine selection sets this. */
  excludeHeld?: boolean
  /** `true` selects rows with a review reason set, `false` those without. */
  parked?: boolean
  /** Day-0 selection uses `suspendedAt: 'empty'`. */
  suspendedAt?: 'empty' | 'set'
  suspendedOn?: string
  suspendedOnOrBefore?: string
  hasExternalId?: 'jumpcloudUserId' | 'googleUserId'
  limit?: number
}

export interface UpsertResult {
  created: boolean
  /** False when the incoming record matched the stored one, so nothing was written. */
  changed: boolean
  /** Field names that differed, for the dry-run diff table. */
  changedFields: string[]
  person: Person
}

export interface TransitionRequest {
  hrisId: string
  /** The status the caller read. A mismatch refuses the write. */
  expectFrom: LifecycleStatus
  event: TransitionEvent
  owner: TransitionOwner
  /** Non-status fields to write in the same transaction. */
  patch?: Partial<Person>
  reason?: string
}

export type TransitionResult =
  | { ok: true; person: Person }
  | { ok: false; refusal: TransitionRefusal; reason: string; person?: Person }

export interface StoreCapabilities {
  /**
   * True when the backing store has no transactions of its own, so all writes
   * must happen under the pipeline lease. Notion and Sheets set this.
   */
  singleWriterOnly: boolean
  /** True when the adapter can count rows without reading them all. */
  exactCounts: boolean
}

/**
 * The people store.
 *
 * Note what is absent: there is no `delete`, and no `prune`. Tombstone rows are
 * the only thing preventing a historic leaver being re-created and offboarded a
 * second time, and the incident that taught this lesson was a migration that
 * deleted them. Making the interface incapable of deletion is stronger than a
 * warning in a document, so adapters are append-only by construction and every
 * migration adds rather than removes.
 */
export interface PeopleStore {
  readonly capabilities: StoreCapabilities
  init(): Promise<void>
  get(hrisId: string): Promise<Person | null>
  /** Look a person up by any address they have ever used. */
  findByEmail(email: string): Promise<Person[]>
  list(filter?: PersonFilter): Promise<Person[]>
  countExact(filter?: PersonFilter): Promise<number>
  /** Create or update non-status fields. Never changes status. */
  upsert(person: Person): Promise<UpsertResult>
  /** The only way a status changes. Checks the table, the owner and the CAS. */
  transition(req: TransitionRequest): Promise<TransitionResult>
  /** Update markers and flags without touching status. */
  patch(hrisId: string, patch: Partial<Person>): Promise<Person>
  close(): Promise<void>
}

export interface Lease {
  name: string
  token: string
  expiresAt: string
}

/** The toolkit's own bookkeeping. Always local SQLite. */
export interface StateStore {
  init(): Promise<void>
  /** Returns null when somebody else holds the lease, so a second run skips. */
  acquireLease(name: string, ttlSeconds: number): Promise<Lease | null>
  releaseLease(lease: Lease): Promise<void>
  /**
   * Alert de-duplication. Keyed on the SET of things being reported, never on a
   * timestamp and never on our own bookkeeping: a gate keyed on when we last
   * posted fires every run, and one keyed on a field we write ourselves goes
   * silent the moment that field changes shape.
   */
  getFingerprint(key: string): Promise<{ value: string; at: string } | null>
  setFingerprint(key: string, value: string): Promise<void>
  /**
   * Invariant counters. The pipeline records the tombstone count and refuses to
   * run when the live count has dropped, which is the shape of the mass re-fire
   * incident (rows vanished, everything looked new).
   */
  getCounter(name: string): Promise<number | null>
  setCounter(name: string, value: number): Promise<void>
  recordRun(runId: string, kind: string, summary: string): Promise<void>
  lastRun(kind: string): Promise<{ runId: string; at: string; summary: string } | null>
  close(): Promise<void>
}
