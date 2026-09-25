/**
 * One Notion database as the people store.
 *
 * Notion has no transactions and no compare-and-set, so this adapter is
 * single-writer by declaration: the pipeline lease is what keeps two writers
 * apart, and every status change is read fresh, checked, written, and read
 * back. That is the most a document store can offer, and it is why the local
 * state store is never Notion.
 *
 * There is no delete and no prune, as on every adapter. `init()` adds any
 * mapped property the database lacks and refuses one that exists with the
 * wrong type; it never removes or retypes anything.
 */

import { SystemClock, type Clock } from '../../core/clock.ts'
import type { LifecycleStatus, Person } from '../../core/types.ts'
import { matchesFilter } from '../memory/store.ts'
import { applyPatch, clonePerson, guardTransition, mergeHrisFields, normaliseEmail, normaliseNewPerson } from '../transitions-guard.ts'
import type { PeopleStore, PersonFilter, StoreCapabilities, TransitionRequest, TransitionResult, UpsertResult } from '../types.ts'
import { NotionClient, type NotionPage } from './client.ts'
import { fromPage, propertyDefinition, resolvePropertyMap, resolveStatusValues, schemaGaps, toProperties, type NotionPropertyMap, type NotionPropertyTypes } from './schema.ts'

export interface NotionPeopleStoreOptions {
  client: NotionClient
  databaseId: string
  properties?: Record<string, string>
  statusValues?: Record<string, string>
  /**
   * Never write. Reads, counts, `verify` and every dry run work; every write
   * throws; `init()` reports a missing property instead of adding one. For a
   * database that another automation owns, which is what a shadow run against
   * a live estate looks at.
   */
  readOnly?: boolean
  clock?: Clock
}

export class NotionPeopleStore implements PeopleStore {
  readonly capabilities: StoreCapabilities = { singleWriterOnly: true, exactCounts: true }

  private readonly client: NotionClient
  private readonly databaseId: string
  private readonly map: NotionPropertyMap
  private readonly statuses: Record<LifecycleStatus, string>
  private readonly readOnly: boolean
  /** The live type of each mapped property, so a select column is written as one. */
  private types: NotionPropertyTypes = {}
  private readonly clock: Clock
  /** Page ids by HR id, filled by every read so a write does not need a query first. */
  private readonly pageIds = new Map<string, string>()
  private writeCount = 0

  constructor(options: NotionPeopleStoreOptions) {
    this.client = options.client
    this.databaseId = options.databaseId
    this.map = resolvePropertyMap(options.properties)
    this.statuses = resolveStatusValues(options.statusValues)
    this.readOnly = options.readOnly === true
    this.clock = options.clock ?? new SystemClock()
  }

  get writes(): number {
    return this.writeCount
  }

  async init(): Promise<void> {
    const db = await this.client.getDatabase(this.databaseId)
    const gaps = schemaGaps(db, this.map)
    this.types = gaps.types
    if (gaps.wrongType.length > 0) {
      const detail = gaps.wrongType.map((g) => `"${g.name}" is ${g.have}, needs ${g.want}`).join('; ')
      throw new Error(`the Notion database has mapped properties of the wrong type: ${detail}. Remap them in store.properties or change the property type in Notion.`)
    }
    // Read-only means read-only for the schema as well. A missing property
    // reads as empty, which is the right answer for a database this toolkit
    // does not own.
    if (this.readOnly) return
    if (gaps.missing.length > 0) {
      // Additive only. The title property cannot be added after the fact and
      // is always present, so it never appears here.
      const additions = Object.fromEntries(gaps.missing.filter((k) => k !== 'title').map((k) => [this.map[k], propertyDefinition(k, this.statuses)]))
      if (Object.keys(additions).length > 0) await this.client.addDatabaseProperties(this.databaseId, additions)
    }
  }

  async get(hrisId: string): Promise<Person | null> {
    const found = await this.queryBy({ property: this.map.hrisId, rich_text: { equals: hrisId } })
    const page = found.find((p) => p.person.hrisId === hrisId)
    return page ? page.person : null
  }

  async findByEmail(email: string): Promise<Person[]> {
    const needle = normaliseEmail(email)
    // Aliases live in the JSON, which Notion cannot filter on, so this is a
    // full read. Rare enough (one lookup per unmatched person) not to matter.
    const all = await this.readAll()
    return all.filter((p) => [p.primaryEmail, ...p.aliasEmails].map(normaliseEmail).includes(needle)).sort((a, b) => a.hrisId.localeCompare(b.hrisId))
  }

  async list(filter?: PersonFilter): Promise<Person[]> {
    const rows = (await this.readAll(this.notionFilter(filter))).filter((p) => matchesFilter(p, filter)).sort((a, b) => a.hrisId.localeCompare(b.hrisId))
    return filter?.limit === undefined ? rows : rows.slice(0, filter.limit)
  }

  async countExact(filter?: PersonFilter): Promise<number> {
    return (await this.list({ ...(filter ?? {}), limit: undefined })).length
  }

  async upsert(person: Person): Promise<UpsertResult> {
    const at = this.clock.nowIso()
    const stored = await this.get(person.hrisId)
    if (!stored) {
      const created = normaliseNewPerson(person, at)
      await this.write(created, null)
      return { created: true, changed: true, changedFields: ['*created*'], person: clonePerson(created) }
    }
    const decision = mergeHrisFields(stored, person, at)
    if (!decision.changed) return { created: false, changed: false, changedFields: [], person: clonePerson(stored) }
    await this.write(decision.merged, this.pageIds.get(person.hrisId) ?? null)
    return { created: false, changed: true, changedFields: decision.changedFields, person: clonePerson(decision.merged) }
  }

  async transition(req: TransitionRequest): Promise<TransitionResult> {
    const at = this.clock.nowIso()
    // Read fresh, never from a list the caller made minutes ago: the hold
    // checkbox and the status are the two things a human edits in Notion.
    const stored = await this.get(req.hrisId)
    const outcome = guardTransition(stored, req, at)
    if (!outcome.allowed) {
      const refused: TransitionResult = { ok: false, refusal: outcome.refusal, reason: outcome.reason }
      if (stored) refused.person = clonePerson(stored)
      return refused
    }
    await this.write(outcome.merged, this.pageIds.get(req.hrisId) ?? null)
    // Read back. Notion answers 200 to a PATCH it applied; this is the only
    // place a write is treated as an effect, and only after the read agrees.
    const after = await this.get(req.hrisId)
    if (!after || after.status !== outcome.merged.status) {
      return { ok: false, refusal: 'stale_status', reason: `Notion accepted the write and the row reads ${after?.status ?? 'missing'} rather than ${outcome.merged.status}` }
    }
    return { ok: true, person: after }
  }

  async patch(hrisId: string, patch: Partial<Person>): Promise<Person> {
    const at = this.clock.nowIso()
    const stored = await this.get(hrisId)
    if (!stored) throw new Error(`No person with HR id ${hrisId}; patch() never creates a row.`)
    const decision = applyPatch(stored, patch, at)
    if (!decision.changed) return clonePerson(stored)
    await this.write(decision.merged, this.pageIds.get(hrisId) ?? null)
    return clonePerson(decision.merged)
  }

  async close(): Promise<void> {}

  private async write(person: Person, pageId: string | null): Promise<void> {
    if (this.readOnly) {
      throw new Error(`store.readOnly is true, so the Notion database is never written (refused a write for ${person.hrisId}). Clear readOnly once this toolkit owns the database.`)
    }
    const properties = toProperties(person, this.map, this.statuses, this.types)
    const page = pageId ? await this.client.updatePage(pageId, properties) : await this.client.createPage(this.databaseId, properties)
    this.pageIds.set(person.hrisId, page.id)
    this.writeCount += 1
  }

  private async readAll(filter?: unknown): Promise<Person[]> {
    return (await this.queryBy(filter)).map((r) => r.person)
  }

  private async queryBy(filter?: unknown): Promise<{ page: NotionPage; person: Person }[]> {
    const pages = await this.client.queryAll(this.databaseId, filter)
    const out: { page: NotionPage; person: Person }[] = []
    for (const page of pages) {
      if (page.archived) continue
      const person = fromPage(page, this.map, this.statuses)
      if (!person) continue
      this.pageIds.set(person.hrisId, page.id)
      out.push({ page, person })
    }
    return out
  }

  /**
   * The part of a PersonFilter Notion can evaluate itself. Anything else is
   * applied after the read. Status and the hold checkbox are the two that
   * cut the read down; the rest live in the JSON property.
   */
  private notionFilter(filter?: PersonFilter): unknown {
    const and: unknown[] = []
    if (filter?.status && filter.status.length > 0) {
      const or = filter.status.map((s) => ({ property: this.map.status, select: { equals: this.statuses[s] } }))
      and.push(or.length === 1 ? or[0] : { or })
    }
    if (filter?.excludeHeld) and.push({ property: this.map.hold, checkbox: { equals: false } })
    if (and.length === 0) return undefined
    return and.length === 1 ? and[0] : { and }
  }
}
