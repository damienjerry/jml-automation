/**
 * An in-memory people store.
 *
 * It exists for three jobs: the unit tests, the offline demo, and rehearsing a
 * run against a copy of real data without any chance of writing to the real
 * store. It enforces exactly the same rules as the SQLite store because both
 * call the shared guard, and the conformance suite runs against both, so a
 * behaviour proved here is a behaviour the default store has too.
 *
 * Like every adapter it has no delete and no prune.
 */

import type { Person } from '../../core/types.ts'
import { SystemClock, type Clock } from '../../core/clock.ts'
import type {
  PeopleStore,
  PersonFilter,
  StoreCapabilities,
  TransitionRequest,
  TransitionResult,
  UpsertResult,
} from '../types.ts'
import {
  applyPatch,
  clonePerson,
  guardTransition,
  mergeHrisFields,
  normaliseEmail,
  normaliseNewPerson,
} from '../transitions-guard.ts'

export interface MemoryPeopleStoreOptions {
  /** Rows to start from. Cloned, so the caller's array is never mutated. */
  seed?: readonly Person[]
  clock?: Clock
}

/** True when this row satisfies the filter. Mirrors the SQL in the SQLite store. */
function matches(person: Person, filter: PersonFilter | undefined): boolean {
  if (!filter) return true
  if (filter.status && filter.status.length > 0 && !filter.status.includes(person.status)) return false
  if (filter.excludeHeld && person.hold) return false
  if (filter.parked === true && !person.reviewReason) return false
  if (filter.parked === false && person.reviewReason) return false

  const suspendedAt = person.offboarding?.suspendedAt ?? null
  if (filter.suspendedAt === 'empty' && suspendedAt !== null) return false
  if (filter.suspendedAt === 'set' && suspendedAt === null) return false
  // Date part only, so a stored timestamp and a stored date agree about a day.
  const suspendedDay = suspendedAt === null ? null : suspendedAt.slice(0, 10)
  if (filter.suspendedOn && suspendedDay !== filter.suspendedOn) return false
  if (filter.suspendedOnOrBefore && (suspendedDay === null || suspendedDay > filter.suspendedOnOrBefore)) return false

  if (filter.hasExternalId) {
    const value = person.externalIds?.[filter.hasExternalId]
    if (value === null || value === undefined || value === '') return false
  }
  return true
}

export class MemoryPeopleStore implements PeopleStore {
  readonly capabilities: StoreCapabilities = { singleWriterOnly: false, exactCounts: true }

  private readonly rows = new Map<string, Person>()
  private readonly clock: Clock
  /** Read by the conformance suite to prove an unchanged sync writes nothing. */
  private writeCount = 0

  constructor(options: MemoryPeopleStoreOptions = {}) {
    this.clock = options.clock ?? new SystemClock()
    for (const person of options.seed ?? []) {
      this.rows.set(person.hrisId, clonePerson(person))
    }
  }

  get writes(): number {
    return this.writeCount
  }

  async init(): Promise<void> {}

  private write(person: Person): void {
    this.rows.set(person.hrisId, clonePerson(person))
    this.writeCount += 1
  }

  async get(hrisId: string): Promise<Person | null> {
    const row = this.rows.get(hrisId)
    // Cloned on the way out as well as in. Handing a caller the stored object
    // lets an accidental mutation change the store with no write and no audit
    // row, and that bug is invisible until something downstream disagrees.
    return row ? clonePerson(row) : null
  }

  async findByEmail(email: string): Promise<Person[]> {
    const needle = normaliseEmail(email)
    const found: Person[] = []
    for (const person of this.rows.values()) {
      const addresses = [person.primaryEmail, ...person.aliasEmails].map(normaliseEmail)
      if (addresses.includes(needle)) found.push(clonePerson(person))
    }
    return found.sort((a, b) => a.hrisId.localeCompare(b.hrisId))
  }

  /** Every match, in id order. No implicit page size: see the SQLite store. */
  async list(filter?: PersonFilter): Promise<Person[]> {
    const found = [...this.rows.values()]
      .filter((person) => matches(person, filter))
      .sort((a, b) => a.hrisId.localeCompare(b.hrisId))
      .map(clonePerson)
    return filter?.limit === undefined ? found : found.slice(0, filter.limit)
  }

  async countExact(filter?: PersonFilter): Promise<number> {
    let total = 0
    for (const person of this.rows.values()) if (matches(person, filter)) total += 1
    return total
  }

  async upsert(person: Person): Promise<UpsertResult> {
    const at = this.clock.nowIso()
    const stored = this.rows.get(person.hrisId)
    if (!stored) {
      const created = normaliseNewPerson(person, at)
      this.write(created)
      return { created: true, changed: true, changedFields: ['*created*'], person: clonePerson(created) }
    }
    const decision = mergeHrisFields(stored, person, at)
    if (!decision.changed) {
      return { created: false, changed: false, changedFields: [], person: clonePerson(stored) }
    }
    this.write(decision.merged)
    return { created: false, changed: true, changedFields: decision.changedFields, person: clonePerson(decision.merged) }
  }

  async transition(req: TransitionRequest): Promise<TransitionResult> {
    const at = this.clock.nowIso()
    const stored = this.rows.get(req.hrisId) ?? null
    const outcome = guardTransition(stored, req, at)
    if (!outcome.allowed) {
      const refused: TransitionResult = { ok: false, refusal: outcome.refusal, reason: outcome.reason }
      if (stored) refused.person = clonePerson(stored)
      return refused
    }
    this.write(outcome.merged)
    return { ok: true, person: clonePerson(outcome.merged) }
  }

  async patch(hrisId: string, patch: Partial<Person>): Promise<Person> {
    const at = this.clock.nowIso()
    const stored = this.rows.get(hrisId)
    if (!stored) throw new Error(`No person with HR id ${hrisId}; patch() never creates a row.`)
    const decision = applyPatch(stored, patch, at)
    if (!decision.changed) return clonePerson(stored)
    this.write(decision.merged)
    return clonePerson(decision.merged)
  }

  async close(): Promise<void> {}
}
