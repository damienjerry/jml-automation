/**
 * On the first run against a real tenant, 102 of the 150 people on the books
 * were joiner candidates, and the run reported 97 of them held over the
 * per-run cap of five, for ever.
 *
 * A fresh people store holds no activation marker for anybody, and the
 * selection had no lower bound on the start date, so every employee with an
 * in-scope record was a starter whose account had never been activated. With
 * the gate at `none` and `activate` armed that is a temporary password issued
 * to five long-serving people per run; with a ticketing adapter wired in, it
 * is a starter-form nudge to a hundred managers. Somebody who started longer
 * ago than `joiner.graceDays` with no activation recorded is now an existing
 * employee to the selection, to the detect step and to the manager nudge, and
 * only naming them with --hris-id activates them.
 */
import { describe, expect, it } from 'vitest'
import { runDetect } from '../../src/engine/detect.ts'
import { runTicketing } from '../../src/engine/ticketing/index.ts'
import { joinerSkipReason, selectJoiners } from '../../src/engine/joiner/select.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { joinerHarness, starter, TODAY } from '../helpers/joiner-harness.ts'

const SELECTION = { today: TODAY, leadWorkingDays: 3, graceDays: 7, holidays: new Set<string>() }

/** A hundred people who have been here for years, as a fresh store sees them. */
const veterans = Array.from({ length: 100 }, (_, i) =>
  starter({ hrisId: `hr-vet-${i}`, primaryEmail: `person${i}@example.com`, status: 'active', startDate: '2021-03-01', personalEmail: null }),
)
const startedLastWeek = starter({ hrisId: 'hr-recent', primaryEmail: 'sam.rivera@example.com', status: 'active', startDate: '2026-01-23' })
const startsNextWeek = starter({ hrisId: 'hr-starter', startDate: '2026-01-30' })

describe('a fresh people store full of existing employees', () => {
  it('selects only the people inside the grace period', () => {
    const chosen = selectJoiners([...veterans, startedLastWeek, startsNextWeek], SELECTION)
    expect(chosen.map((p) => p.hrisId)).toEqual(['hr-recent', 'hr-starter'])
    expect(joinerSkipReason(veterans[0]!, SELECTION)).toBe('started_before_grace')
  })

  it('does not announce a veteran as a joiner', async () => {
    const people = new MemoryPeopleStore({ seed: [...veterans, startedLastWeek] })
    await people.init()
    const report = await runDetect({ people, today: TODAY, terminationLookbackDays: 60, joinerGraceDays: 7 })
    expect(report.counts.joiner).toBe(1)
  })

  it('does not nudge a hundred managers to raise a starter form', async () => {
    const h = await joinerHarness({
      people: [...veterans, startedLastWeek],
      config: { joiner: { gate: 'ticket' }, ticketing: { adapter: 'suptask', suptask: { apiToken: 'env:SUPTASK_API_TOKEN', queueId: 'q', requesterId: 'U-it', starterFormId: 'form-starter' } } },
    })
    const report = await runTicketing(h.ticketingDeps, { dryRun: false, actor: { kind: 'system', id: 'system:test' }, runId: 'r1' })
    expect(report.counts.ticketNudged).toBe(1)
  })

  it('caps the engine at the genuine starters, and a named veteran is still looked at', async () => {
    const h = await joinerHarness({ people: [...veterans, startedLastWeek] })
    const all = await h.run()
    expect(all.counts.joinerCandidates).toBe(1)
    expect(all.warnings.filter((w) => /held over the per-run cap/.test(w))).toEqual([])

    const named = await h.run({ only: { hrisId: 'hr-vet-0' } })
    // Looked at rather than dropped for age: whatever happens next is decided
    // by the gate and by the account's own state, not by the calendar. Here
    // the fake identity provider holds no account for them, and that is the
    // reason reported, not the grace period.
    expect(named.counts.joinerCandidates).toBe(1)
    expect(named.counts.joinerNoAccount).toBe(1)
    expect((named.people[0]?.notes ?? []).join(' ')).not.toMatch(/graceDays/)
  })
})
