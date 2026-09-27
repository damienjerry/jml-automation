/**
 * The default people store: local SQLite through `node:sqlite`.
 *
 * Chosen over a hosted database because the toolkit has to be runnable by one
 * person on one machine in an hour, and over a document store because a lease
 * and a compare-and-set need a real transaction. `node:sqlite` ships with Node
 * itself, so there is no native module to compile: the only cost is a single
 * ExperimentalWarning, which the CLI entry point filters.
 *
 * Notice what is not here: no delete, and no prune. See the interface in
 * ../types.ts for why, and the migration ledger for how that is kept true over
 * time.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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
import { COLUMNS, fromRow, SEP, toParams, whereClause, type Params, type Row } from './rows.ts'
import { MIGRATIONS, type Migration } from './migrations/index.ts'

export interface SqlitePeopleStoreOptions {
  /** File path, or ':memory:' for a throwaway store in tests. */
  path: string
  /** Injected so a date-dependent test does not have to wait a week. */
  clock?: Clock
}

/**
 * Open a database with the settings this toolkit depends on.
 *
 * WAL so a read (the doctor command, or a second terminal) cannot block the
 * run that is writing, and a busy timeout so a brief overlap waits rather than
 * failing the run outright.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

/**
 * Run `fn` inside one transaction.
 *
 * BEGIN IMMEDIATE rather than a deferred begin: the write lock is taken up
 * front, so two concurrent runs collide at the start instead of one of them
 * discovering halfway through that it cannot upgrade.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Apply any migration this build knows about and the database has not seen.
 *
 * It also refuses to continue when the database carries a migration this build
 * does not know, which means an older binary has been pointed at a schema a
 * newer one wrote. Reading a newer schema with older code is how a column that
 * matters gets ignored.
 */
export function applyMigrations(db: DatabaseSync, ledger: string, migrations: readonly Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${ledger} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT`)
  const applied = new Set(
    db
      .prepare(`SELECT id FROM ${ledger}`)
      .all()
      .map((row) => String((row as Row).id)),
  )
  const known = new Set(migrations.map((m) => m.id))
  for (const id of applied) {
    if (!known.has(id)) {
      throw new Error(
        `The store at this path has migration "${id}" applied, which this build of the toolkit does not know about. ` +
          `A newer version wrote this schema; upgrade rather than running the older one.`,
      )
    }
  }
  const record = db.prepare(`INSERT INTO ${ledger} (id, applied_at) VALUES (:id, :at)`)
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue
    withTransaction(db, () => {
      migration.up(db)
      record.run({ id: migration.id, at: new Date().toISOString() })
    })
  }
}

export class SqlitePeopleStore implements PeopleStore {
  readonly capabilities: StoreCapabilities = { singleWriterOnly: false, exactCounts: true }

  private db: DatabaseSync | null = null
  private insert: StatementSync | null = null
  private update: StatementSync | null = null
  private readonly clock: Clock
  /**
   * Counts statements that actually changed a row. The conformance suite reads
   * it to prove that an unchanged sync writes nothing, which is a claim no
   * amount of documentation can make credible.
   */
  private writeCount = 0

  private readonly options: SqlitePeopleStoreOptions
  constructor(options: SqlitePeopleStoreOptions) {
    this.options = options
    this.clock = options.clock ?? new SystemClock()
  }

  get writes(): number {
    return this.writeCount
  }

  async init(): Promise<void> {
    if (this.db) return
    const db = openDatabase(this.options.path)
    // Closed on refusal: an open handle stays locked on Windows, and the
    // caller that sees this error cannot close a database it never got.
    try {
      applyMigrations(db, 'schema_migrations', MIGRATIONS)
    } catch (err) {
      db.close()
      throw err
    }
    this.db = db
    const columns = COLUMNS.join(', ')
    const placeholders = COLUMNS.map((column) => `:${column}`).join(', ')
    this.insert = db.prepare(`INSERT INTO people (${columns}) VALUES (${placeholders})`)
    const assignments = COLUMNS.filter((column) => column !== 'hris_id')
      .map((column) => `${column} = :${column}`)
      .join(', ')
    this.update = db.prepare(`UPDATE people SET ${assignments} WHERE hris_id = :hris_id`)
  }

  private handle(): DatabaseSync {
    if (!this.db) throw new Error('The people store is not open. Call init() first.')
    return this.db
  }

  private readPerson(hrisId: string): Person | null {
    const row = this.handle().prepare('SELECT * FROM people WHERE hris_id = :hris_id').get({ hris_id: hrisId })
    return row ? fromRow(row as Row) : null
  }

  private writePerson(person: Person, mode: 'insert' | 'update'): void {
    const statement = mode === 'insert' ? this.insert : this.update
    if (!statement) throw new Error('The people store is not open. Call init() first.')
    statement.run(toParams(person))
    this.writeCount += 1
  }

  async get(hrisId: string): Promise<Person | null> {
    return this.readPerson(hrisId)
  }

  async findByEmail(email: string): Promise<Person[]> {
    const needle = SEP + normaliseEmail(email) + SEP
    const rows = this.handle()
      .prepare('SELECT * FROM people WHERE instr(email_index, :needle) > 0 ORDER BY hris_id')
      .all({ needle })
    return rows.map((row) => fromRow(row as Row))
  }

  /**
   * Every matching row, in id order.
   *
   * There is no page size and no implicit cap. An earlier design read
   * one page of a hundred and silently ignored everybody after it, so a fleet
   * that had grown past that number simply stopped being offboarded. A caller
   * that wants a cap must ask for one through `filter.limit`.
   */
  async list(filter?: PersonFilter): Promise<Person[]> {
    const { sql, params } = whereClause(filter)
    let query = `SELECT * FROM people ${sql} ORDER BY hris_id`
    const bound: Params = { ...params }
    if (filter?.limit !== undefined) {
      query += ' LIMIT :rowLimit'
      bound['rowLimit'] = filter.limit
    }
    const rows = this.handle().prepare(query).all(bound)
    return rows.map((row) => fromRow(row as Row))
  }

  /** An exact count. The pipeline aborts on a drop, so an estimate is useless. */
  async countExact(filter?: PersonFilter): Promise<number> {
    const { sql, params } = whereClause(filter)
    const row = this.handle()
      .prepare(`SELECT count(*) AS total FROM people ${sql}`)
      .get(params) as Row | undefined
    const total = row?.['total']
    return typeof total === 'number' ? total : Number(total ?? 0)
  }

  async upsert(person: Person): Promise<UpsertResult> {
    const at = this.clock.nowIso()
    return withTransaction(this.handle(), () => {
      const stored = this.readPerson(person.hrisId)
      if (!stored) {
        const created = normaliseNewPerson(person, at)
        this.writePerson(created, 'insert')
        return { created: true, changed: true, changedFields: ['*created*'], person: clonePerson(created) }
      }
      const decision = mergeHrisFields(stored, person, at)
      if (!decision.changed) {
        return { created: false, changed: false, changedFields: [], person: clonePerson(stored) }
      }
      this.writePerson(decision.merged, 'update')
      return {
        created: false,
        changed: true,
        changedFields: decision.changedFields,
        person: clonePerson(decision.merged),
      }
    })
  }

  async transition(req: TransitionRequest): Promise<TransitionResult> {
    const at = this.clock.nowIso()
    return withTransaction(this.handle(), () => {
      const stored = this.readPerson(req.hrisId)
      const outcome = guardTransition(stored, req, at)
      if (!outcome.allowed) {
        const refused: TransitionResult = { ok: false, refusal: outcome.refusal, reason: outcome.reason }
        if (stored) refused.person = clonePerson(stored)
        return refused
      }
      this.writePerson(outcome.merged, 'update')
      return { ok: true, person: clonePerson(outcome.merged) }
    })
  }

  async patch(hrisId: string, patch: Partial<Person>): Promise<Person> {
    const at = this.clock.nowIso()
    return withTransaction(this.handle(), () => {
      const stored = this.readPerson(hrisId)
      if (!stored) throw new Error(`No person with HR id ${hrisId}; patch() never creates a row.`)
      const decision = applyPatch(stored, patch, at)
      if (!decision.changed) return clonePerson(stored)
      this.writePerson(decision.merged, 'update')
      return clonePerson(decision.merged)
    })
  }

  async close(): Promise<void> {
    if (!this.db) return
    this.db.close()
    this.db = null
    this.insert = null
    this.update = null
  }
}
