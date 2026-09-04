/**
 * Prevents two opposite mistakes about a leaver with no accounts.
 *
 * A row can genuinely have nothing to offboard: the person never had an
 * account, or somebody closed it by hand. That row has to be closed without
 * touching a provider, or it is selected again every run for ever. It is also
 * the landing zone a mistaken identity is defused into: clearing the account
 * ids on a bad row drops it here, inert.
 *
 * The dangerous version of the same shape is a failed lookup. "No account" and
 * "could not tell" are opposite facts, and the automation this was ported from
 * collapsed them: a paging bug meant its account list stopped at two hundred
 * users, so real leavers past that point looked accountless and were closed as
 * having had nothing to offboard while their accounts stayed live.
 */

import { describe, expect, it } from 'vitest'
import { createLogger, type LogLevel } from '../../src/core/logger.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { LEAVER_ID, TODAY, harness, personFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }

function capturingLogger(lines: string[]) {
  return createLogger({ level: 'debug' as LogLevel, write: (line) => lines.push(line) })
}

/** Nobody has an account anywhere, and both lookups succeeded in saying so. */
function noAccounts() {
  return harness({ armed: true, seed: { idp: [], google: [] } })
}

describe('a leaver with no account in either provider', () => {
  it('is closed as departed without a single provider write', async () => {
    const h = noAccounts()
    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('departed')
    expect(row?.offboarding?.suspendedAt).toBe(TODAY)
    expect(row?.offboarding?.departedAt).toBe(TODAY)
    expect(row?.note).toContain('nothing to offboard')
    // Both lookups, and nothing else at all.
    expect(h.calls).toEqual(['idp.findUser(jane.doe@example.com)', 'google.getUser(jane.doe@example.com)'])
    expect(report.counts.phantom).toBe(1)
  })

  it('says so loudly rather than passing quietly', async () => {
    // A row closing itself with no work done is exactly the event somebody
    // needs to see if it was not supposed to happen.
    const lines: string[] = []
    const h = noAccounts()
    const report = await runLeaverEngine({ ...h.deps, logger: capturingLogger(lines) }, RUN)

    expect(lines.join('\n')).toContain('phantom leaver')
    expect(lines.join('\n')).toContain('"level":"warn"')
    expect(report.people[0]?.notes?.join(' ')).toContain('nothing to offboard')
  })

  it('is terminal, so it is never selected again', async () => {
    const h = noAccounts()
    await runLeaverEngine(h.deps, RUN)
    const second = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })

    expect(second.people).toEqual([])
    expect(second.counts.selectedDay0).toBe(0)
  })

  it('writes nothing in a dry run, and reports what it would do', async () => {
    const h = noAccounts()
    const report = await runLeaverEngine(h.deps, { ...RUN, dryRun: true })

    expect((await h.store.get(LEAVER_ID))?.status).toBe('terminated')
    expect(report.counts.phantom).toBe(1)
    expect(report.people[0]?.notes?.join(' ')).toContain('would be closed')
  })
})

describe('a leaver whose lookups failed', () => {
  it('is parked, never closed as having had no accounts', async () => {
    const h = harness({ armed: true, seed: { idp: [], google: [] } })
    h.providers.fault('idp.findUser', { kind: 'error', message: 'the directory answered 500' })

    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('terminated')
    expect(row?.reviewReason).toBe('identity_mismatch')
    expect(report.counts.phantom ?? 0).toBe(0)
    expect(report.counts.parked).toBe(1)
  })

  it('is parked when the Google read failed as well', async () => {
    const h = harness({ armed: true, seed: { idp: [], google: [] } })
    h.providers.fault('google.getUser', { kind: 'error' })

    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.reviewReason).toBe('identity_mismatch')
  })

  it('is closed only when BOTH lookups succeeded and found nothing', async () => {
    const h = harness({
      armed: true,
      people: [personFixture({ externalIds: {} })],
      seed: { idp: [], google: [] },
    })
    const report = await runLeaverEngine(h.deps, RUN)
    expect(report.counts.phantom).toBe(1)
    expect((await h.store.get(LEAVER_ID))?.status).toBe('departed')
  })
})
