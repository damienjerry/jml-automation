/**
 * `jml doctor`.
 *
 * The table is the deliverable. A doctor that answered "something is wrong"
 * would be worse than nothing, because the whole reason it exists is that the
 * failures it looks for are individually silent: a scope that was never
 * delegated, a directory that cannot be written, a row parked weeks ago that
 * nobody was reminded about.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJsonlAuditSink } from '../../src/audit/jsonl.ts'
import { createSecretHandle, createSecretRegistry, type SecretHandle } from '../../src/config/secrets.ts'
import { FakeClock } from '../../src/core/clock.ts'
import { createDomainMap } from '../../src/core/domain.ts'
import { createHttpClient } from '../../src/core/http.ts'
import { nullLogger } from '../../src/core/logger.ts'
import type { Person } from '../../src/core/types.ts'
import { renderDoctor, runDoctor } from '../../src/cli/doctor.ts'
import type { Providers, Runtime } from '../../src/cli/commands/context.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { SqliteStateStore } from '../../src/store/state-sqlite.ts'
import { leaverConfig, NOW } from '../fixtures/leaver/harness.ts'

const TOKEN_VALUE = 'not-a-real-credential-0123456789abcdef'

interface HarnessOptions {
  people?: readonly Person[]
  scopes?: { scope: string; ok: boolean; required: boolean }[]
  googleOk?: boolean
  auditDir?: string
}

async function harness(opts: HarnessOptions = {}): Promise<{ rt: Runtime; secret: SecretHandle }> {
  const dir = opts.auditDir ?? (await mkdtemp(join(tmpdir(), 'jml-doctor-')))
  const clock = new FakeClock(NOW)
  const store = new MemoryPeopleStore({ seed: opts.people ?? [], clock })
  await store.init()
  const state = new SqliteStateStore({ path: ':memory:', clock })
  await state.init()
  const secret = createSecretHandle('env:JUMPCLOUD_API_KEY', TOKEN_VALUE)

  const providers = {
    idp: {
      name: 'stub-idp',
      findUser: async () => null,
      suspendUser: async () => ({ ok: true, verified: true }),
      deleteUser: async () => ({ ok: true, verified: true }),
      testConnection: async () => ({ ok: true, detail: 'a write-capable key' }),
    },
    google: {
      testConnection: async () =>
        opts.googleOk === false
          ? { ok: false, detail: 'the directory refused the request', remediation: 'delegate the scopes' }
          : { ok: true, detail: 'directory readable' },
      probeScopes: async () =>
        (opts.scopes ?? []).map((entry) => ({
          scope: 'https://www.googleapis.com/auth/' + entry.scope,
          ok: entry.ok,
          subject: 'admin@example.com',
          status: entry.ok ? 200 : 401,
          error: entry.ok ? undefined : 'unauthorized_client',
          required: entry.required,
          neededBy: ['suspendUser'],
          breaksWithout: 'suspension cannot run',
        })),
    },
  } as unknown as Providers

  const rt: Runtime = {
    cfg: leaverConfig({ audit: { minimisePii: false, jsonl: { dir } } }),
    secrets: createSecretRegistry(new Map([['identity.jumpcloud.apiKey', secret]])),
    source: 'jml.config.yaml',
    ticketing: null,
    register: null,
    store,
    state,
    audit: createJsonlAuditSink({ dir, today: () => '2026-03-03', fsync: false }),
    notifier: {
      name: 'stub',
      send: async () => ({ delivered: true, channel: 'stub' }),
      testConnection: async () => ({ ok: true, detail: 'prints to stdout' }),
    },
    hris: { name: 'fixture', fetchAll: async () => ({ all: [], activeIds: new Set<string>(), fetchedAt: NOW, complete: true }), testConnection: async () => ({ ok: true, detail: '7 people, no credential required' }) },
    clock,
    logger: nullLogger(),
    domain: createDomainMap({ primaryDomain: 'example.com' }),
    http: createHttpClient(),
    providers,
    close: async () => {
      await state.close()
      await store.close()
    },
  }
  return { rt, secret }
}

function parked(overrides: Partial<Person> = {}): Person {
  return {
    hrisId: 'hr-parked',
    status: 'terminated',
    primaryEmail: 'jane.doe@example.com',
    aliasEmails: [],
    displayName: 'Jane Doe',
    hold: false,
    reviewReason: 'termination_older_than_lookback',
    externalIds: {},
    offboarding: { suspendedAt: null, legs: {} },
    // Written three weeks before the harness clock.
    updatedAt: '2026-02-10T09:00:00.000Z',
    ...overrides,
  }
}

describe('jml doctor', () => {
  it('names every credential by reference and length, never by value', async () => {
    const { rt } = await harness()
    const report = await runDoctor(rt)
    await rt.close()

    const row = report.rows.find((entry) => entry.name.startsWith('credential'))
    expect(row?.detail).toContain('env:JUMPCLOUD_API_KEY')
    expect(row?.detail).toContain(String(TOKEN_VALUE.length) + ' characters')
    expect(JSON.stringify(report)).not.toContain(TOKEN_VALUE)
    expect(renderDoctor(report)).not.toContain(TOKEN_VALUE)
  })

  it('fails the row for a scope that was never delegated, and names what it breaks', async () => {
    const { rt } = await harness({
      scopes: [
        { scope: 'admin.directory.user', ok: true, required: true },
        { scope: 'admin.directory.group', ok: false, required: false },
      ],
    })
    const report = await runDoctor(rt)
    await rt.close()

    const failed = report.rows.find((entry) => entry.name.includes('admin.directory.group'))
    expect(failed?.ok).toBe(false)
    expect(failed?.detail).toContain('unauthorized_client')
    expect(failed?.remediation).toContain('suspension cannot run')
    expect(failed?.docsAnchor).toContain('docs/credentials.md')
    expect(report.ok).toBe(false)
    // The one that IS delegated still passes, so the table is usable rather
    // than a single verdict.
    expect(report.rows.find((entry) => entry.name.includes('admin.directory.user'))?.ok).toBe(true)
  })

  it('reports the age of the oldest parked row, because nothing else ever will', async () => {
    const { rt } = await harness({ people: [parked()] })
    const report = await runDoctor(rt)
    await rt.close()

    expect(report.parkedCount).toBe(1)
    expect(report.oldestParked?.ageDays).toBe(21)
    const row = report.rows.find((entry) => entry.name === 'parked rows')
    expect(row?.ok).toBe(false)
    expect(row?.detail).toContain('21 day(s)')
    expect(row?.remediation).toContain('jml leaver release')
  })

  it('passes the parked check when nothing is parked, and says so plainly', async () => {
    const { rt } = await harness()
    const report = await runDoctor(rt)
    await rt.close()
    expect(report.rows.find((entry) => entry.name === 'parked rows')?.detail).toBe('nothing is parked')
  })

  it('fails rather than throwing when a probe throws', async () => {
    const { rt } = await harness()
    const broken: Runtime = {
      ...rt,
      hris: {
        name: 'fixture',
        fetchAll: rt.hris.fetchAll.bind(rt.hris),
        testConnection: async () => {
          throw new Error('the HR system refused the connection')
        },
      },
    }
    const report = await runDoctor(broken)
    await rt.close()

    const row = report.rows.find((entry) => entry.name === 'HR system')
    expect(row?.ok).toBe(false)
    expect(row?.detail).toContain('refused the connection')
    // The rows after it were still collected: the table is worth more than
    // the first failure.
    expect(report.rows.some((entry) => entry.name === 'parked rows')).toBe(true)
  })

  it('reports the store counts an operator compares across a migration', async () => {
    const { rt } = await harness({ people: [parked()] })
    const report = await runDoctor(rt)
    await rt.close()
    expect(report.storeCounts?.total).toBe(1)
    expect(report.storeCounts?.departed).toBe(0)
  })
})
