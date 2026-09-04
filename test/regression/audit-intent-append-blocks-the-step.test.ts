/**
 * Failure this prevents: an action taken with no record that it was attempted.
 *
 * The audit contract is two rows per action: the intent BEFORE the provider
 * call and the outcome after. A single row written afterwards cannot describe
 * the case that matters most, which is a call that was made and whose result
 * was never learned, because the process died or the network went away between
 * the request and the answer.
 *
 * That only holds if a failed intent append STOPS the call. This test drives
 * the contract with a spy standing in for the provider: when the sink refuses
 * the intent row, the provider must not be touched at all.
 *
 * The engine implements this wrapper for real; here it is written out inline so
 * the sink's half of the bargain is proven on its own, which is that a sink
 * that cannot persist a row throws rather than degrading.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AuditUnavailableError, createJsonlAuditSink } from '../../src/audit/jsonl.ts'
import type { AuditEvent, AuditSink } from '../../src/audit/types.ts'
import type { Outcome } from '../../src/core/types.ts'

const INTENT: AuditEvent = {
  at: '2026-03-02T09:00:00.000Z',
  runId: 'run-1',
  phase: 'intent',
  actor: { kind: 'system', id: 'system:pipeline' },
  action: 'jumpcloud.suspendUser',
  subject: { kind: 'person', id: 'hris-1', label: 'Jane Doe' },
  dryRun: false,
}

/** The shape every mutating step in the toolkit follows. */
async function recordedStep(
  audit: AuditSink,
  call: () => Promise<Outcome>,
): Promise<Outcome> {
  await audit.append(INTENT)
  const outcome = await call()
  await audit.append({ ...INTENT, phase: 'outcome', ok: outcome.ok, verified: outcome.verified })
  return outcome
}

async function unwritableSink() {
  const dir = await mkdtemp(join(tmpdir(), 'jml-intent-'))
  const blocker = join(dir, 'not-a-directory')
  await writeFile(blocker, 'a file, so no directory can be created inside it')
  return createJsonlAuditSink({ dir: join(blocker, 'audit'), today: () => '2026-03-02' })
}

describe('a step whose intent cannot be recorded', () => {
  it('makes no provider call', async () => {
    const suspendUser = vi.fn<() => Promise<Outcome>>(async () => ({ ok: true, verified: true }))
    const audit = await unwritableSink()

    await expect(recordedStep(audit, suspendUser)).rejects.toBeInstanceOf(AuditUnavailableError)

    expect(suspendUser).not.toHaveBeenCalled()
  })

  it('makes the call exactly once when the intent is recorded', async () => {
    const suspendUser = vi.fn<() => Promise<Outcome>>(async () => ({ ok: true, verified: true }))
    const dir = await mkdtemp(join(tmpdir(), 'jml-intent-'))
    const audit = createJsonlAuditSink({ dir, today: () => '2026-03-02' })

    const outcome = await recordedStep(audit, suspendUser)
    await audit.close()

    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(suspendUser).toHaveBeenCalledOnce()
    // Two rows: the intent and the outcome. One row could not have told a
    // reader that the call was attempted at all.
    await expect(audit.verify()).resolves.toMatchObject({ ok: true, checkedLines: 2 })
  })

  it('leaves the intent row behind when the call itself fails', async () => {
    const suspendUser = vi.fn<() => Promise<Outcome>>(async () => {
      throw new Error('provider unreachable')
    })
    const dir = await mkdtemp(join(tmpdir(), 'jml-intent-'))
    const audit = createJsonlAuditSink({ dir, today: () => '2026-03-02' })

    await expect(recordedStep(audit, suspendUser)).rejects.toThrow(/provider unreachable/)
    await audit.close()

    // Exactly the case a single after-the-fact row cannot express: we know the
    // call was attempted, and we do not know what it did.
    await expect(audit.verify()).resolves.toMatchObject({ ok: true, checkedLines: 1 })
  })
})
