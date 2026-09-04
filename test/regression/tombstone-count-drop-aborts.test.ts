/**
 * Prevents: a run acting on a picture that lost its tombstones.
 *
 * Tombstone rows are the only thing that stops a historic leaver being
 * offboarded a second time. A migration removed several hundred of them, and
 * at that moment every removed person looked like a brand new termination.
 *
 * So the pipeline compares the tombstone count against the last run's before
 * anything else happens, and a fall means it does nothing at all. The store
 * half of this is covered by tombstones-pruned-refire; this file is the
 * pipeline half, and it also pins the order: the check comes before the HR
 * read, so an abort really does mean nothing was touched.
 */

import { describe, expect, it } from 'vitest'
import { DEPARTED_COUNTER } from '../../src/store/bootstrap.ts'
import { runPipeline } from '../../src/engine/pipeline.ts'
import type { PipelineDeps } from '../../src/engine/pipeline.ts'
import { LEAVER_ID, fixtureHris, harness, personFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:pipeline' } }

function pipelineHarness() {
  const h = harness({ armed: true })
  let hrisReads = 0
  const hris = fixtureHris([personFixture()])
  const deps: PipelineDeps = {
    ...h.deps,
    hris: {
      name: 'fixture',
      fetchAll: async () => {
        hrisReads += 1
        return hris.fetchAll()
      },
      testConnection: hris.testConnection,
    },
  }
  return { h, deps, reads: () => hrisReads }
}

describe('a tombstone count that has fallen since the last run', () => {
  it('aborts the run before the HR system is even read', async () => {
    const { h, deps, reads } = pipelineHarness()
    // The last run saw three hundred tombstones. There are none now, which is
    // the signature of rows removed outside this toolkit.
    await h.state.setCounter(DEPARTED_COUNTER, 300)

    const report = await runPipeline(deps, RUN)

    expect(report.aborted?.reason).toBe('invariant_failed')
    expect(report.ok).toBe(false)
    expect(reads()).toBe(0)
    expect(h.calls).toEqual([])
    expect((await h.store.get(LEAVER_ID))?.status).toBe('terminated')
  })

  it('leaves the recorded count high, so the next run refuses as well', async () => {
    const { h, deps } = pipelineHarness()
    await h.state.setCounter(DEPARTED_COUNTER, 300)

    await runPipeline(deps, RUN)
    // Writing the new, lower number would teach the next run that the loss is
    // normal and let it carry on.
    expect(await h.state.getCounter(DEPARTED_COUNTER)).toBe(300)

    const second = await runPipeline(deps, { ...RUN })
    expect(second.aborted?.reason).toBe('invariant_failed')
  })

  it('says in the notification that nothing was changed, and names the numbers', async () => {
    const { h, deps } = pipelineHarness()
    await h.state.setCounter(DEPARTED_COUNTER, 300)

    const report = await runPipeline(deps, RUN)

    expect(h.notifier.kinds()).toEqual(['run.aborted'])
    expect(h.notifier.bodies()).toContain('nothing was changed')
    expect(String(report.aborted?.detail?.['previous'])).toBe('300')
    expect(String(report.aborted?.detail?.['current'])).toBe('0')
  })

  it('does not ping the dead-man on an abort', async () => {
    // A dead-man fed by a refusing run reports a healthy schedule while
    // nothing is happening.
    const { h, deps } = pipelineHarness()
    await h.state.setCounter(DEPARTED_COUNTER, 300)
    const report = await runPipeline(deps, RUN)
    expect(report.warnings.join(' ')).not.toContain('liveness')
  })
})

describe('a tombstone count that has grown', () => {
  it('is normal, and the baseline moves up with it', async () => {
    const { h, deps } = pipelineHarness()
    await h.state.setCounter(DEPARTED_COUNTER, 0)
    await h.store.transition({
      hrisId: LEAVER_ID,
      expectFrom: 'terminated',
      event: 'human.tombstone',
      owner: 'human',
      reason: 'handled by hand',
    })

    const report = await runPipeline(deps, { ...RUN, steps: ['leaver'] })

    expect(report.aborted).toBeUndefined()
    expect(await h.state.getCounter(DEPARTED_COUNTER)).toBe(1)
  })
})
