/**
 * Prevents: `audit.minimisePii` being true and doing nothing.
 *
 * The configuration ships with minimisation on, and the reference says
 * addresses are stored as a salted hash. Nothing read either key. The sink was
 * built with the log directory and a date function and no minimisation at all,
 * so every audit row held the leaver's address in clear.
 *
 * That is worse than an ordinary missing feature, for two reasons. The log is
 * append-only and kept for years, so the file becomes a permanent directory of
 * everybody who has ever left; and the operator believes otherwise, because
 * both the configuration they wrote and the documentation they read say the
 * addresses are hashed. Nothing surfaces the difference: a row full of
 * addresses looks exactly like a row full of hashes to anybody not reading it.
 *
 * The order of operations is asserted as well as the behaviour. Minimisation
 * has to run before the row hash is computed, or every minimised line fails
 * the chain verification that exists to prove the log has not been edited.
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AuditEvent } from '../../src/audit/types.ts'
import { createJsonlAuditSink, hashAddress } from '../../src/audit/jsonl.ts'

const SALT = 'a-salt-nobody-else-has'
const ADDRESS = 'jane.doe@example.com'
const MANAGER = 'john.doe@example.com'

function event(): AuditEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    phase: 'outcome',
    actor: { kind: 'system', id: 'system:leaver-engine' },
    action: 'leaver.day7.delete_google',
    subject: { kind: 'person', id: 'p-1', label: 'Jane Doe' },
    dryRun: false,
    ok: true,
    detail: {
      email: ADDRESS,
      // Addresses turn up inside prose as well as in their own field, which is
      // why the replacement is over the whole string rather than per key.
      note: `deleted the Google account ${ADDRESS}, files went to ${MANAGER}`,
      recipients: [MANAGER],
    },
  }
}

async function writeAndRead(options: { minimisePii: boolean; salt: string | null }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-audit-pii-'))
  const sink = createJsonlAuditSink({ dir, today: () => '2026-01-01', ...options })
  await sink.append(event())
  await sink.close()
  const files = await readdir(dir)
  return readFile(join(dir, files[0] as string), 'utf8')
}

describe('an audit log with PII minimisation on', () => {
  it('holds no address anywhere in the row', async () => {
    const text = await writeAndRead({ minimisePii: true, salt: SALT })
    expect(text).not.toContain(ADDRESS)
    expect(text).not.toContain(MANAGER)
    // Not merely removed: hashed, so the rows for one person are still findable.
    expect(text).toContain(hashAddress(ADDRESS, SALT))
    expect(text).toContain(hashAddress(MANAGER, SALT))
  })

  it('hashes an address inside prose and inside an array, not only its own field', async () => {
    const text = await writeAndRead({ minimisePii: true, salt: SALT })
    const row = JSON.parse(text.trim()) as { detail: { note: string; recipients: string[] } }
    expect(row.detail.note).toContain(hashAddress(ADDRESS, SALT))
    expect(row.detail.recipients).toEqual([hashAddress(MANAGER, SALT)])
  })

  it('leaves the HR id and the display name alone, which is what the key promises', async () => {
    const text = await writeAndRead({ minimisePii: true, salt: SALT })
    // Hashing these too would make the log useless for its actual job, which
    // is answering what happened to which row.
    expect(text).toContain('p-1')
    expect(text).toContain('Jane Doe')
  })

  it('still verifies, because the hash is computed after minimisation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-audit-chain-'))
    const sink = createJsonlAuditSink({ dir, today: () => '2026-01-01', minimisePii: true, salt: SALT })
    await sink.append(event())
    await sink.append({ ...event(), at: '2026-01-01T00:01:00.000Z' })
    const result = await sink.verify()
    await sink.close()
    expect(result.ok).toBe(true)
    expect(result.checkedLines).toBe(2)
  })

  it('produces the same hash for the same address, so a person is searchable', async () => {
    expect(hashAddress(ADDRESS, SALT)).toBe(hashAddress(ADDRESS, SALT))
    // Case and surrounding space are not a different person.
    expect(hashAddress(' JANE.DOE@Example.com ', SALT)).toBe(hashAddress(ADDRESS, SALT))
    // A different salt is a different hash, or one log's hashes would read
    // another log's.
    expect(hashAddress(ADDRESS, 'other-salt')).not.toBe(hashAddress(ADDRESS, SALT))
  })

  it('refuses to be built with minimisation on and no salt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-audit-nosalt-'))
    // Degrading to clear addresses is the failure this replaces. An unsalted
    // hash is barely better: the address format is short enough to guess.
    expect(() => createJsonlAuditSink({ dir, minimisePii: true, salt: null })).toThrow(/needs a salt/)
  })

  it('writes addresses in clear only when minimisation is explicitly off', async () => {
    // The other direction of the same assertion: the flag has to do something,
    // in both positions.
    const text = await writeAndRead({ minimisePii: false, salt: null })
    expect(text).toContain(ADDRESS)
  })
})

describe('the wiring, which is where this was actually broken', () => {
  it('hands the configured flag and the resolved salt to the sink', async () => {
    // The sink always could minimise once asked. Nothing asked it: the runtime
    // built it with a directory and a date function, so the flag was true in
    // every shipped configuration and inert. Asserting the sink alone would
    // have passed throughout the defect.
    const dir = await mkdtemp(join(tmpdir(), 'jml-runtime-audit-'))
    const { openRuntime } = await import('../../src/cli/commands/context.ts')
    const runtime = await openRuntime({
      io: {
        out: () => {},
        err: () => {},
        env: {
          JML_AUDIT_SALT: SALT,
          JUMPCLOUD_API_KEY: 'k'.repeat(40),
          GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
          JML_API_TOKEN: 't'.repeat(40),
        },
        cwd: process.cwd(),
      },
      configPath: await writeConfig(dir),
    })
    try {
      await runtime.audit.append(event())
    } finally {
      await runtime.close()
    }
    const files = (await readdir(join(dir, 'audit'))).filter((f) => f.endsWith('.jsonl'))
    const text = await readFile(join(dir, 'audit', files[0] as string), 'utf8')
    expect(text).not.toContain(ADDRESS)
    expect(text).toContain(hashAddress(ADDRESS, SALT))
  })
})

/** A minimal real configuration file, with minimisation left at its default. */
async function writeConfig(dir: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises')
  const path = join(dir, 'jml.config.yaml')
  await writeFile(
    path,
    [
      'version: 1',
      'org:',
      '  name: Example',
      '  primaryDomain: example.com',
      '  timezone: Europe/London',
      '  itTeamSignature: IT',
      'mail:',
      '  senderMailbox: it@example.com',
      'hris:',
      '  adapter: fixture',
      '  minPlausibleHeadcount: 1',
      '  fixture:',
      '    path: ./src/cli/fixtures/demo.json',
      'store:',
      '  adapter: memory',
      'identity:',
      '  jumpcloud:',
      '    apiKey: env:JUMPCLOUD_API_KEY',
      'google:',
      '  serviceAccountJson: env:GOOGLE_SERVICE_ACCOUNT_JSON',
      '  adminEmail: admin@example.com',
      'server:',
      '  token: env:JML_API_TOKEN',
      'notify:',
      '  adapters: []',
      'audit:',
      // Deliberately not set here: the default is true, which is the case that
      // was silently doing nothing.
      '  salt: env:JML_AUDIT_SALT',
      '  jsonl:',
      `    dir: ${join(dir, 'audit')}`,
      '',
    ].join('\n'),
    'utf8',
  )
  return path
}
