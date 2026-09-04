/**
 * Prevents: a second file hand-over started for the same person.
 *
 * The hand-over is asynchronous and can take hours. If the run that starts it
 * dies before recording the transfer id, the next run has no way to tell that
 * a transfer already exists, so it inserts another one. Two transfers of the
 * same Drive is not a tidy outcome: they interleave, and neither run can say
 * which of them the eventual state belongs to.
 *
 * So the id is persisted immediately after the insert, BEFORE the first poll
 * and before any later leg. This test pins that order rather than only the end
 * state, because the end state of a run that completes looks the same either
 * way.
 */

import { describe, expect, it } from 'vitest'
import type { Person } from '../../src/core/types.ts'
import type { PeopleStore, PersonFilter, TransitionRequest } from '../../src/store/types.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { transferCutoff } from '../../src/engine/leaver/select.ts'
import {
  IDP_USER_ID,
  LEAVER_EMAIL,
  LEAVER_ID,
  MANAGER_EMAIL,
  TODAY,
  harness,
  leaverConfig,
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
const due = transferCutoff(TODAY, leaverConfig())

/**
 * A store that writes its own calls into the provider timeline.
 *
 * Ordering between a store write and a provider call is the thing being
 * tested, so both have to land in one list.
 */
function recordingStore(inner: PeopleStore, timeline: string[]): PeopleStore {
  return {
    capabilities: inner.capabilities,
    init: () => inner.init(),
    get: (hrisId: string) => inner.get(hrisId),
    findByEmail: (email: string) => inner.findByEmail(email),
    list: (filter?: PersonFilter) => inner.list(filter),
    countExact: (filter?: PersonFilter) => inner.countExact(filter),
    upsert: (person: Person) => inner.upsert(person),
    transition: (req: TransitionRequest) => {
      timeline.push(`store.transition(${req.event})`)
      return inner.transition(req)
    },
    patch: (hrisId: string, patch: Partial<Person>) => {
      const transferId = patch.offboarding?.transferId
      timeline.push(transferId ? `store.patch(transferId=${transferId})` : 'store.patch')
      return inner.patch(hrisId, patch)
    },
    close: () => inner.close(),
  }
}

function day6Harness(transferStates: ('inProgress' | 'completed' | 'failed')[]) {
  const h = harness({
    armed: true,
    people: [suspendedPersonFixture(due)],
    seed: {
      idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
      google: [
        { id: 'goog-leaver-1', email: LEAVER_EMAIL },
        { id: 'goog-manager-1', email: MANAGER_EMAIL },
      ],
      transferStates,
    },
  })
  const timeline = h.calls
  const deps = { ...h.deps, store: recordingStore(h.store, timeline) }
  return { h, deps, timeline }
}

describe('starting a file hand-over', () => {
  it('persists the transfer id before polling it and before the Google suspension', async () => {
    const { deps, timeline } = day6Harness(['inProgress'])

    await runLeaverEngine(deps, RUN)

    const insert = timeline.findIndex((c) => c.startsWith('google.transferDrive'))
    const persist = timeline.findIndex((c) => c.startsWith('store.patch(transferId='))
    const poll = timeline.findIndex((c) => c.startsWith('google.getTransferStatus'))
    const suspend = timeline.findIndex((c) => c.startsWith('google.suspendUser'))

    expect(insert).toBeGreaterThanOrEqual(0)
    expect(persist).toBeGreaterThan(insert)
    expect(poll).toBeGreaterThan(persist)
    expect(suspend).toBeGreaterThan(persist)
  })

  it('resumes the same transfer on the next run rather than starting another', async () => {
    const { h, deps, timeline } = day6Harness(['inProgress', 'inProgress', 'completed'])

    await runLeaverEngine(deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.offboarding?.transferId).toBe('transfer-1')

    await runLeaverEngine(deps, { ...RUN, runId: 'run-2' })
    await runLeaverEngine(deps, { ...RUN, runId: 'run-3' })

    expect(timeline.filter((c) => c.startsWith('google.transferDrive'))).toHaveLength(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.transferredAt).toBeTruthy()
    expect(row?.offboarding?.legs?.transfer_drive).toMatchObject({ state: 'done', verified: true })
  })

  it('does not count a hand-over that is still running as an attempt', async () => {
    // A transfer that is simply taking hours must not accumulate attempts, or
    // a slow hand-over would park the row for review.
    const { h, deps } = day6Harness(['inProgress'])

    await runLeaverEngine(deps, RUN)
    await runLeaverEngine(deps, { ...RUN, runId: 'run-2' })
    await runLeaverEngine(deps, { ...RUN, runId: 'run-3' })

    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.legs?.transfer_drive?.state).toBe('pending')
    expect(row?.offboarding?.legs?.transfer_drive?.attempts).toBeLessThanOrEqual(1)
    expect(row?.reviewReason ?? null).toBeNull()
  })

  it('writes nothing at all in a dry run, so no transfer id is invented', async () => {
    const { h, deps, timeline } = day6Harness(['completed'])
    const writesBefore = h.store.writes

    await runLeaverEngine(deps, { ...RUN, dryRun: true })

    expect(timeline.filter((c) => c.startsWith('google.transferDrive'))).toHaveLength(0)
    expect(timeline.filter((c) => c.startsWith('store.patch(transferId='))).toHaveLength(0)
    expect(h.store.writes).toBe(writesBefore)
  })
})
