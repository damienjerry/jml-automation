/**
 * Prevents: a mass suspension on a day when the data was wrong.
 *
 * A migration removed the tombstone rows for people who had already left. The
 * next HR sync saw hundreds of historic leavers as brand new terminations, and
 * the offboarding engine began suspending accounts that had been closed for
 * years. Nothing counted the candidates before acting, so the first anybody
 * knew of it was the accounts going out.
 *
 * The breaker counts before any write and aborts the WHOLE run, including the
 * later phases. It fires in a dry run too, because a rehearsal is exactly when
 * somebody wants to be told the number is forty rather than two.
 */

import { describe, expect, it } from 'vitest'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { deleteCutoff } from '../../src/engine/leaver/select.ts'
import {
  IDP_USER_ID,
  LEAVER_EMAIL,
  TODAY,
  harness,
  leaverConfig,
  personFixture,
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

const SYSTEM = { kind: 'system' as const, id: 'system:leaver-engine' }
const HUMAN = { kind: 'human' as const, id: 'jane.doe@example.com' }
const RUN = { dryRun: false, actor: SYSTEM, runId: 'run-1' }

/** Six leavers where the configured limit is five. */
function crowd(count = 6) {
  return Array.from({ length: count }, (_, index) =>
    personFixture({ hrisId: `hris-${String(index).padStart(4, '0')}`, primaryEmail: `person${index}@example.com` }),
  )
}

function crowdHarness(extra: Parameters<typeof harness>[0] = {}) {
  return harness({
    armed: true,
    people: crowd(),
    seed: {
      idp: crowd().map((p, index) => ({ id: `usr-${index}`, email: p.primaryEmail })),
      google: [],
    },
    ...extra,
  })
}

describe('more day-0 candidates than the limit', () => {
  it('aborts the run and makes no write of any kind', async () => {
    const h = crowdHarness()
    const writesBefore = h.store.writes

    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.aborted?.reason).toBe('circuit_breaker')
    expect(report.ok).toBe(false)
    expect(report.counts.selectedDay0).toBe(6)
    expect(report.counts.day0 ?? 0).toBe(0)
    // Nothing at all: no provider call, no store write, nobody suspended.
    expect(h.calls).toEqual([])
    expect(h.store.writes).toBe(writesBefore)
  })

  it('names the count and the first few rows, so somebody can go and look', async () => {
    const h = crowdHarness()
    const report = await runLeaverEngine(h.deps, RUN)

    expect(String(report.aborted?.detail?.['candidates'])).toBe('6')
    expect(report.aborted?.detail?.['limit']).toBe(5)
    expect((report.aborted?.detail?.['firstTen'] as string[]).length).toBe(6)

    const abortRow = h.audit.events.find((e) => e.action === 'run.abort')
    expect(abortRow?.detail?.['circuitBreaker']).toBe(true)
  })

  it('sends exactly one notification, and it says nothing was changed', async () => {
    const h = crowdHarness()
    await runLeaverEngine(h.deps, RUN)

    expect(h.notifier.kinds()).toEqual(['run.aborted'])
    expect(h.notifier.bodies()).toContain('nothing was changed')
  })

  it('stops the later phases as well', async () => {
    // A day this far out of the ordinary is not a day to be deleting
    // accounts, whatever phase they are in.
    const cfg = leaverConfig()
    const h = crowdHarness({
      people: [...crowd(), suspendedPersonFixture(deleteCutoff(TODAY, cfg), { hrisId: 'hris-ready' })],
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.aborted?.reason).toBe('circuit_breaker')
    expect(report.counts.day7 ?? 0).toBe(0)
    expect(h.calls).toEqual([])
  })

  it('fires in a dry run too', async () => {
    const h = crowdHarness()
    const report = await runLeaverEngine(h.deps, { ...RUN, dryRun: true })
    expect(report.aborted?.reason).toBe('circuit_breaker')
  })
})

describe('the one-off override', () => {
  it('lets a named person raise the limit for one run, and records who', async () => {
    const h = crowdHarness()
    const report = await runLeaverEngine(h.deps, { ...RUN, actor: HUMAN, allowBulk: 10 })

    expect(report.aborted).toBeUndefined()
    expect(report.counts.day0).toBe(6)
    const override = h.audit.events.find((e) => e.action === 'run.circuit_breaker_override')
    expect(override?.actor).toEqual(HUMAN)
    expect(override?.detail?.['raisedTo']).toBe(10)
  })

  it('refuses an override that no person asked for', async () => {
    // A schedule that can raise its own limit is not a limit. The override
    // exists so that a bulk day is somebody's decision, on the record.
    const h = crowdHarness()
    const report = await runLeaverEngine(h.deps, { ...RUN, allowBulk: 10 })

    expect(report.aborted?.reason).toBe('circuit_breaker')
    expect(h.calls).toEqual([])
  })

  it('still aborts when even the raised limit is exceeded', async () => {
    const h = crowdHarness()
    const report = await runLeaverEngine(h.deps, { ...RUN, actor: HUMAN, allowBulk: 2 })
    expect(report.aborted?.reason).toBe('circuit_breaker')
    expect(h.calls).toEqual([])
  })
})

describe('a normal day', () => {
  it('is not affected by the breaker', async () => {
    const h = harness({
      armed: true,
      people: [personFixture()],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [] },
    })
    const report = await runLeaverEngine(h.deps, RUN)
    expect(report.aborted).toBeUndefined()
    expect(report.counts.day0).toBe(1)
  })
})
