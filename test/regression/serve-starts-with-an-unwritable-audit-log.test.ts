/**
 * Prevents: the sidecar starting when it cannot record what it does.
 *
 * The contract everywhere else in this toolkit is that a step whose intent
 * cannot be written to the audit log does not happen. A service that started
 * anyway would honour that contract by failing every run, one at a time, after
 * each one had already been accepted with a 202 and reported back as an
 * internal error. The right moment to refuse is before the port is open.
 *
 * The second half is the tombstone count. A store whose count of departed rows
 * has fallen is the signature of the worst incident on record for this class
 * of automation: rows were removed outside the toolkit, and every removed
 * person then looked like a brand new leaver. Serving in that state would
 * happily accept a scheduled run and offboard people who left years ago.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJsonlAuditSink } from '../../src/audit/jsonl.ts'
import { createSecretRegistry } from '../../src/config/secrets.ts'
import { FakeClock } from '../../src/core/clock.ts'
import { createDomainMap } from '../../src/core/domain.ts'
import { createHttpClient } from '../../src/core/http.ts'
import { nullLogger } from '../../src/core/logger.ts'
import type { Person } from '../../src/core/types.ts'
import { assertServable } from '../../src/cli/doctor.ts'
import type { Runtime } from '../../src/cli/commands/context.ts'
import { DEPARTED_COUNTER } from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { SqliteStateStore } from '../../src/store/state-sqlite.ts'
import { leaverConfig, NOW } from '../fixtures/leaver/harness.ts'

async function runtime(auditDir: string, people: readonly Person[] = []): Promise<Runtime> {
  const clock = new FakeClock(NOW)
  const store = new MemoryPeopleStore({ seed: people, clock })
  await store.init()
  const state = new SqliteStateStore({ path: ':memory:', clock })
  await state.init()
  return {
    cfg: leaverConfig({ audit: { minimisePii: false, jsonl: { dir: auditDir } } }),
    secrets: createSecretRegistry(new Map()),
    source: 'jml.config.yaml',
    store,
    state,
    audit: createJsonlAuditSink({ dir: auditDir, today: () => '2026-03-03', fsync: false }),
    notifier: {
      name: 'stub',
      send: async () => ({ delivered: true, channel: 'stub' }),
      testConnection: async () => ({ ok: true, detail: 'stub' }),
    },
    hris: {
      name: 'fixture',
      fetchAll: async () => ({ all: [], activeIds: new Set<string>(), fetchedAt: NOW, complete: true }),
      testConnection: async () => ({ ok: true, detail: 'stub' }),
    },
    clock,
    logger: nullLogger(),
    domain: createDomainMap({ primaryDomain: 'example.com' }),
    http: createHttpClient(),
    providers: null,
    close: async () => {
      await state.close()
      await store.close()
    },
  }
}

function tombstone(hrisId: string): Person {
  return {
    hrisId,
    status: 'departed',
    primaryEmail: hrisId + '@example.com',
    aliasEmails: [],
    displayName: hrisId,
    hold: false,
    externalIds: {},
    offboarding: { suspendedAt: null, legs: {}, departedAt: '2024-01-01' },
  }
}

describe('starting the sidecar', () => {
  it('refuses when the audit directory cannot be created', async () => {
    // A regular file where the directory should be. This is what a missing
    // volume mount looks like from inside a container.
    const base = await mkdtemp(join(tmpdir(), 'jml-serve-'))
    const blocked = join(base, 'not-a-directory')
    await writeFile(blocked, 'this is a file\n', 'utf8')

    const rt = await runtime(join(blocked, 'audit'))
    await expect(assertServable(rt)).rejects.toThrow(/refusing to serve/)
    await expect(assertServable(rt)).rejects.toThrow(/intent cannot be recorded/)
    await rt.close()
  })

  it('starts when the audit directory is writable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-serve-ok-'))
    const rt = await runtime(dir)
    await expect(assertServable(rt)).resolves.toBeUndefined()
    await rt.close()
  })

  it('refuses when the tombstone count has fallen since the last run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-serve-counter-'))
    const rt = await runtime(dir, [tombstone('hr-1')])
    // The last run saw three hundred tombstones and there is one now.
    await rt.state.setCounter(DEPARTED_COUNTER, 300)

    await expect(assertServable(rt)).rejects.toThrow(/tombstone count has fallen from 300 to 1/)
    await rt.close()
  })

  it('does not raise the recorded count while checking it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-serve-readonly-'))
    const rt = await runtime(dir, [tombstone('hr-1'), tombstone('hr-2')])
    await rt.state.setCounter(DEPARTED_COUNTER, 1)

    await assertServable(rt)

    // The pipeline is what raises the baseline, deliberately. A health check
    // that wrote it could record an empty store as normal, which is exactly
    // the picture a missing volume produces.
    expect(await rt.state.getCounter(DEPARTED_COUNTER)).toBe(1)
    await rt.close()
  })
})
