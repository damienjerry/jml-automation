import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuditUnavailableError,
  canonicalJson,
  createJsonlAuditSink,
  GENESIS_HASH,
  JsonlAuditSink,
} from '../../src/audit/jsonl.ts'
import type { AuditEvent } from '../../src/audit/types.ts'

const open: JsonlAuditSink[] = []

afterEach(async () => {
  for (const sink of open.splice(0)) await sink.close()
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jml-audit-'))
}

function sinkIn(dir: string, today: () => string): JsonlAuditSink {
  const sink = createJsonlAuditSink({ dir, today })
  open.push(sink)
  return sink
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    at: '2026-03-02T09:00:00.000Z',
    runId: 'run-1',
    phase: 'intent',
    actor: { kind: 'system', id: 'system:pipeline' },
    action: 'jumpcloud.suspendUser',
    subject: { kind: 'person', id: 'hris-1', label: 'Jane Doe' },
    dryRun: false,
    ...overrides,
  }
}

async function linesIn(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('the JSONL audit sink', () => {
  it('writes one dated file and chains every line to the one before it', async () => {
    const dir = await scratch()
    const sink = sinkIn(dir, () => '2026-03-02')

    await sink.append(event())
    await sink.append(event({ phase: 'outcome', ok: true, verified: true }))

    const file = join(dir, 'jml-2026-03-02.jsonl')
    const rows = await linesIn(file)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH)
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash)
    await expect(sink.verify()).resolves.toMatchObject({ ok: true, checkedLines: 2 })
  })

  it('continues the chain across a day boundary and after a restart', async () => {
    const dir = await scratch()
    let today = '2026-03-02'
    const first = sinkIn(dir, () => today)
    await first.append(event())
    const firstHash = (await linesIn(join(dir, 'jml-2026-03-02.jsonl')))[0]?.hash

    today = '2026-03-03'
    // A fresh sink stands for the next day's process, which must pick the chain
    // up from disk rather than starting a second one.
    const second = sinkIn(dir, () => today)
    await second.append(event({ at: '2026-03-03T09:00:00.000Z' }))

    const rows = await linesIn(join(dir, 'jml-2026-03-03.jsonl'))
    expect(rows[0]?.prevHash).toBe(firstHash)
    await expect(second.verify()).resolves.toMatchObject({ ok: true, checkedLines: 2 })
  })

  it('recomputes the hash rather than trusting one supplied by the caller', async () => {
    const dir = await scratch()
    const sink = sinkIn(dir, () => '2026-03-02')
    await sink.append(event({ hash: 'a-hash-somebody-made-up', prevHash: 'invented' }))

    const rows = await linesIn(join(dir, 'jml-2026-03-02.jsonl'))
    expect(rows[0]?.hash).not.toBe('a-hash-somebody-made-up')
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH)
    await expect(sink.verify()).resolves.toMatchObject({ ok: true })
  })

  it('throws rather than degrading when the log cannot be written', async () => {
    const dir = await scratch()
    const blocker = join(dir, 'not-a-directory')
    await writeFile(blocker, 'this is a file, so no directory can be created inside it')
    const sink = sinkIn(join(blocker, 'audit'), () => '2026-03-02')

    await expect(sink.append(event())).rejects.toBeInstanceOf(AuditUnavailableError)
  })

  it('keeps the chain sound when appends overlap', async () => {
    const dir = await scratch()
    const sink = sinkIn(dir, () => '2026-03-02')

    // Two callers that do not await each other. Reading the same previous hash
    // would produce two lines claiming one predecessor, which reads as
    // tampering to everybody downstream.
    await Promise.all([sink.append(event()), sink.append(event({ phase: 'outcome' }))])

    const rows = await linesIn(join(dir, 'jml-2026-03-02.jsonl'))
    expect(rows).toHaveLength(2)
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash)
    await expect(sink.verify()).resolves.toMatchObject({ ok: true, checkedLines: 2 })
  })

  it('reports an empty directory as sound rather than as unreadable', async () => {
    const dir = await scratch()
    const sink = sinkIn(dir, () => '2026-03-02')
    await expect(sink.verify()).resolves.toEqual({ ok: true, checkedLines: 0 })
  })
})

describe('canonical serialisation', () => {
  it('orders keys and drops undefined so a reader can recompute the hash', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}]},"b":1}',
    )
  })

  it('asks a value carrying toJSON for its own representation', () => {
    const handle = { use: (fn: (v: string) => unknown) => fn('x'), toJSON: () => '[redacted]' }
    expect(canonicalJson({ apiKey: handle })).toBe('{"apiKey":"[redacted]"}')
  })
})
