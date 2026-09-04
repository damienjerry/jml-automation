/**
 * Failure this prevents: an audit trail nobody can rely on.
 *
 * A plain append-only file answers "what did the automation do" only as long as
 * nobody has edited it. Chaining each line to the hash of the one before turns
 * an edit or a deletion into something a reader can detect and locate, which is
 * what makes the file usable as evidence rather than as a courtesy.
 *
 * `jml audit verify` is built on this: it must fail AT the offending line, not
 * merely report that something somewhere is wrong.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createJsonlAuditSink, JsonlAuditSink } from '../../src/audit/jsonl.ts'
import type { AuditEvent } from '../../src/audit/types.ts'

const DAY = '2026-03-02'

function event(n: number): AuditEvent {
  return {
    at: `2026-03-02T09:0${n}:00.000Z`,
    runId: 'run-1',
    phase: n % 2 === 0 ? 'outcome' : 'intent',
    actor: { kind: 'system', id: 'system:pipeline' },
    action: 'jumpcloud.suspendUser',
    subject: { kind: 'person', id: `hris-${n}`, label: 'Jane Doe' },
    dryRun: false,
    detail: { attempt: n },
  }
}

async function threeLines(): Promise<{ dir: string; file: string; sink: JsonlAuditSink }> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-tamper-'))
  const sink = createJsonlAuditSink({ dir, today: () => DAY })
  for (const n of [1, 2, 3]) await sink.append(event(n))
  await sink.close()
  return { dir, file: join(dir, `jml-${DAY}.jsonl`), sink }
}

async function readLines(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim() !== '')
}

describe('a tampered audit file', () => {
  it('verifies before anybody touches it', async () => {
    const { sink } = await threeLines()
    await expect(sink.verify()).resolves.toMatchObject({ ok: true, checkedLines: 3 })
  })

  it('fails at the edited line', async () => {
    const { file, sink } = await threeLines()
    const lines = await readLines(file)
    lines[1] = (lines[1] ?? '').replace('"attempt":2', '"attempt":99')
    await writeFile(file, `${lines.join('\n')}\n`)

    const result = await sink.verify()

    expect(result.ok).toBe(false)
    expect(result.firstBadLine).toBe(2)
    expect(result.firstBadFile).toBe(`jml-${DAY}.jsonl`)
    expect(result.reason).toMatch(/does not match its own hash/)
  })

  it('fails at the gap left by a deleted line', async () => {
    const { file, sink } = await threeLines()
    const lines = await readLines(file)
    await writeFile(file, `${[lines[0], lines[2]].join('\n')}\n`)

    const result = await sink.verify()

    expect(result.ok).toBe(false)
    // What was line 3 is now line 2, and it still quotes the hash of the line
    // that was removed, so the gap is visible exactly where it was made.
    expect(result.firstBadLine).toBe(2)
    expect(result.reason).toMatch(/previous-line hash does not match/)
  })

  it('fails at a line that is no longer valid JSON', async () => {
    const { file, sink } = await threeLines()
    const lines = await readLines(file)
    lines[2] = '{ this was hand-edited'
    await writeFile(file, `${lines.join('\n')}\n`)

    const result = await sink.verify()

    expect(result).toMatchObject({ ok: false, firstBadLine: 3 })
    expect(result.reason).toMatch(/not valid JSON/)
  })

  it('fails when a whole earlier day is removed to hide it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-tamper-'))
    let today = '2026-03-02'
    const sink = createJsonlAuditSink({ dir, today: () => today })
    await sink.append(event(1))
    today = '2026-03-03'
    await sink.append(event(2))
    await sink.close()

    await writeFile(join(dir, 'jml-2026-03-02.jsonl'), '')

    const result = await sink.verify()
    expect(result).toMatchObject({ ok: false, firstBadFile: 'jml-2026-03-03.jsonl', firstBadLine: 1 })
  })
})
