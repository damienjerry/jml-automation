/**
 * The toolkit's own bookkeeping: leases, alert fingerprints, invariant
 * counters and run history.
 *
 * This is always local SQLite, whatever the people store is. A lease held in a
 * shared document with no transactions is not a lease, it is a hope, and two
 * overlapping runs both suspending the same person is exactly the failure the
 * lease exists to prevent. Keeping it separate also means the people store can
 * be something an IT team already reads, without that choice weakening the
 * concurrency guarantees.
 *
 * Nothing in here is a person. It is safe to delete this file and start again:
 * the run loses its fingerprints and counters, which costs one duplicate alert
 * and one skipped invariant check, not a person's account.
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SystemClock, type Clock } from '../core/clock.ts'
import type { Lease, StateStore } from './types.ts'
import type { Migration } from './sqlite/migrations/index.ts'
import { applyMigrations, openDatabase, withTransaction } from './sqlite/store.ts'

type Row = Record<string, unknown>

const STATE_MIGRATIONS: readonly Migration[] = [
  {
    id: '001-state',
    description: 'leases, fingerprints, counters and run history',
    up(db: DatabaseSync) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          name        TEXT PRIMARY KEY,
          token       TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at  TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS fingerprints (
          name  TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          at    TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS counters (
          name  TEXT PRIMARY KEY,
          value INTEGER NOT NULL,
          at    TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id  TEXT PRIMARY KEY,
          kind    TEXT NOT NULL,
          at      TEXT NOT NULL,
          summary TEXT NOT NULL
        ) STRICT
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS runs_kind_at ON runs (kind, at)`)
    },
  },
]

export interface SqliteStateStoreOptions {
  /** File path, or ':memory:' in tests. */
  path: string
  /** Injected so lease expiry can be tested without sleeping. */
  clock?: Clock
}

export class SqliteStateStore implements StateStore {
  private db: DatabaseSync | null = null
  private readonly clock: Clock

  private readonly options: SqliteStateStoreOptions
  constructor(options: SqliteStateStoreOptions) {
    this.options = options
    this.clock = options.clock ?? new SystemClock()
  }

  async init(): Promise<void> {
    if (this.db) return
    const db = openDatabase(this.options.path)
    applyMigrations(db, 'state_migrations', STATE_MIGRATIONS)
    this.db = db
  }

  private handle(): DatabaseSync {
    if (!this.db) throw new Error('The state store is not open. Call init() first.')
    return this.db
  }

  /**
   * Take a named lease, or return null because somebody else holds it.
   *
   * Expiry rather than an explicit unlock only, because a run that is killed
   * halfway through never releases anything. Without expiry the first crash
   * stops every later run for ever, which is the shape of an outage that hides
   * itself: nothing errors, the schedule simply stops doing any work.
   */
  async acquireLease(name: string, ttlSeconds: number): Promise<Lease | null> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`A lease needs a positive time to live; got ${String(ttlSeconds)}.`)
    }
    const now = this.clock.now()
    const db = this.handle()
    return withTransaction(db, () => {
      const existing = db.prepare('SELECT expires_at FROM leases WHERE name = :name').get({ name }) as Row | undefined
      const heldUntil = existing ? Date.parse(String(existing['expires_at'])) : null
      if (heldUntil !== null && Number.isFinite(heldUntil) && heldUntil > now.getTime()) return null

      const lease: Lease = {
        name,
        token: randomUUID(),
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      }
      db.prepare(
        `INSERT INTO leases (name, token, acquired_at, expires_at)
         VALUES (:name, :issued, :acquiredAt, :expiresAt)
         ON CONFLICT(name) DO UPDATE SET
           token = :issued, acquired_at = :acquiredAt, expires_at = :expiresAt`,
      ).run({
        name,
        issued: lease.token,
        acquiredAt: now.toISOString(),
        expiresAt: lease.expiresAt,
      })
      return lease
    })
  }

  /**
   * Release a lease we still hold.
   *
   * The compare-and-set on the issued value is the point: a run whose lease
   * expired mid-flight, and which then finishes and tidies up, must not evict
   * the run that has legitimately taken over. A no-op here is the correct
   * outcome in that case.
   */
  async releaseLease(lease: Lease): Promise<void> {
    this.handle()
      .prepare('DELETE FROM leases WHERE name = :name AND token = :issued')
      .run({ name: lease.name, issued: lease.token })
  }

  async getFingerprint(name: string): Promise<{ value: string; at: string } | null> {
    const row = this.handle()
      .prepare('SELECT value, at FROM fingerprints WHERE name = :name')
      .get({ name }) as Row | undefined
    if (!row) return null
    return { value: String(row['value']), at: String(row['at']) }
  }

  async setFingerprint(name: string, value: string): Promise<void> {
    this.handle()
      .prepare(
        `INSERT INTO fingerprints (name, value, at) VALUES (:name, :value, :at)
         ON CONFLICT(name) DO UPDATE SET value = :value, at = :at`,
      )
      .run({ name, value, at: this.clock.nowIso() })
  }

  /**
   * A counter, or null when we have never recorded one.
   *
   * Null and zero are different answers. Zero tombstones is a fact worth
   * comparing against; "no baseline yet" is a first run, and treating the two
   * the same either disarms the invariant or blocks the very first run.
   */
  async getCounter(name: string): Promise<number | null> {
    const row = this.handle().prepare('SELECT value FROM counters WHERE name = :name').get({ name }) as Row | undefined
    if (!row) return null
    return Number(row['value'])
  }

  async setCounter(name: string, value: number): Promise<void> {
    if (!Number.isInteger(value)) throw new Error(`Counter ${name} must be an integer; got ${String(value)}.`)
    this.handle()
      .prepare(
        `INSERT INTO counters (name, value, at) VALUES (:name, :value, :at)
         ON CONFLICT(name) DO UPDATE SET value = :value, at = :at`,
      )
      .run({ name, value, at: this.clock.nowIso() })
  }

  async recordRun(runId: string, kind: string, summary: string): Promise<void> {
    this.handle()
      .prepare(
        `INSERT INTO runs (run_id, kind, at, summary) VALUES (:runId, :kind, :at, :summary)
         ON CONFLICT(run_id) DO UPDATE SET kind = :kind, at = :at, summary = :summary`,
      )
      .run({ runId, kind, at: this.clock.nowIso(), summary })
  }

  async lastRun(kind: string): Promise<{ runId: string; at: string; summary: string } | null> {
    const row = this.handle()
      .prepare(
        // rowid breaks the tie so two runs recorded in the same second still
        // have a defined order.
        'SELECT run_id, at, summary FROM runs WHERE kind = :kind ORDER BY at DESC, rowid DESC LIMIT 1',
      )
      .get({ kind }) as Row | undefined
    if (!row) return null
    return { runId: String(row['run_id']), at: String(row['at']), summary: String(row['summary']) }
  }

  async close(): Promise<void> {
    if (!this.db) return
    this.db.close()
    this.db = null
  }
}
