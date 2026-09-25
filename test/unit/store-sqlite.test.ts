/**
 * The parts of the SQLite store that are about the file rather than about the
 * rules: durability, journal mode, the migration ledger and transactions.
 *
 * The shared behaviour lives in the conformance suite and is not repeated
 * here.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS } from '../../src/store/sqlite/migrations/index.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePeopleStore } from '../../src/store/sqlite/store.ts'
import { samplePerson } from '../../src/store/conformance.ts'

const directories: string[] = []

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'jml-store-'))
  directories.push(directory)
  // A nested path on purpose: the store creates the directory it is pointed
  // at, so `jml init` in an empty checkout works with no setup step.
  return join(directory, 'data', 'jml.sqlite')
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe('the store on disk', () => {
  it('creates its directory, keeps rows across a reopen and uses WAL', async () => {
    const path = storePath()
    const first = new SqlitePeopleStore({ path })
    await first.init()
    await first.upsert(samplePerson())
    await first.close()

    const second = new SqlitePeopleStore({ path })
    await second.init()
    expect((await second.get('hris-0001'))?.displayName).toBe('Jane Doe')
    await second.close()

    const raw = new DatabaseSync(path)
    const mode = raw.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined
    // WAL so a doctor command or a second terminal reading the store cannot
    // block the run that is writing to it.
    expect(String(mode?.['journal_mode'])).toBe('wal')
    raw.close()
  })

  it('applies each migration once and records it', async () => {
    const path = storePath()
    const store = new SqlitePeopleStore({ path })
    await store.init()
    await store.close()

    const raw = new DatabaseSync(path)
    const applied = raw.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Record<string, unknown>[]
    expect(applied.map((row) => String(row['id']))).toEqual(MIGRATIONS.map((m) => m.id))
    raw.close()

    const again = new SqlitePeopleStore({ path })
    await again.init()
    await again.close()

    const check = new DatabaseSync(path)
    const count = check.prepare('SELECT count(*) AS total FROM schema_migrations').get() as
      | Record<string, unknown>
      | undefined
    expect(Number(count?.['total'])).toBe(MIGRATIONS.length)
    check.close()
  })

  it('refuses to open a store written by a newer build', async () => {
    const path = storePath()
    const store = new SqlitePeopleStore({ path })
    await store.init()
    await store.close()

    const raw = new DatabaseSync(path)
    raw
      .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (:id, :at)')
      .run({ id: '099-from-the-future', at: '2026-04-01T00:00:00.000Z' })
    raw.close()

    // Reading a newer schema with older code is how a column that matters is
    // silently ignored, so it is refused rather than tolerated.
    const older = new SqlitePeopleStore({ path })
    await expect(older.init()).rejects.toThrow(/099-from-the-future/)
  })

  it('will not answer before init', async () => {
    const store = new SqlitePeopleStore({ path: ':memory:' })
    await expect(store.get('hris-0001')).rejects.toThrow(/init/)
  })

  it('rolls back a refused write rather than leaving half of it', async () => {
    const store = new SqlitePeopleStore({ path: ':memory:' })
    await store.init()
    await store.upsert(samplePerson())
    await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
    await store.transition({
      hrisId: 'hris-0001',
      expectFrom: 'terminated',
      event: 'engine.day0_suspended',
      owner: 'engine',
      patch: { offboarding: { suspendedAt: '2026-03-31', legs: {} } },
    })

    // The patch sets a legitimate field and then tries to clear the Day-0
    // marker. Both must be discarded together.
    await expect(
      store.patch('hris-0001', { note: 'half a write', offboarding: { suspendedAt: null, legs: {} } }),
    ).rejects.toThrow()

    const stored = await store.get('hris-0001')
    expect(stored?.offboarding?.suspendedAt).toBe('2026-03-31')
    expect(stored?.note).not.toBe('half a write')
    await store.close()
  })

  it('closes twice without complaint', async () => {
    const store = new SqlitePeopleStore({ path: ':memory:' })
    await store.init()
    await store.close()
    await expect(store.close()).resolves.toBeUndefined()
  })
})
