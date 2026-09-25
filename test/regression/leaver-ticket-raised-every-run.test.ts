/**
 * A leaver ticket is raised once, on the run where the person first becomes
 * a day-0 candidate, and never again. Creating a ticket is not idempotent,
 * so the marker on the row is the only thing standing between one ticket
 * and one per run.
 */
import { describe, expect, it } from 'vitest'
import { runTicketing } from '../../src/engine/ticketing/index.ts'
import { joinerHarness } from '../helpers/joiner-harness.ts'
import { storedPerson } from '../helpers/sync-harness.ts'

const TICKETED = { ticketing: { adapter: 'suptask', suptask: { apiToken: 'env:SUPTASK_API_TOKEN', queueId: 'q', requesterId: 'U-it', leaverFormId: 'form-leaver' } } }
const ACTOR = { kind: 'system' as const, id: 'system:test' }

describe('the leaver ticket', () => {
  it('is raised once for a day-0 candidate and recorded on the row', async () => {
    const leaver = storedPerson({ hrisId: 'hr-leaver', displayName: 'Sam Rivera', primaryEmail: 'sam.rivera@example.com', status: 'terminated', terminationDate: '2026-01-27' })
    const h = await joinerHarness({ config: TICKETED, people: [leaver] })
    await runTicketing(h.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r1' })
    await runTicketing(h.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r2' })
    expect(h.ticketing.created).toHaveLength(1)
    expect(h.ticketing.created[0]).toMatchObject({ kind: 'leaver', dueDate: '2026-01-28', tags: ['Offboard'] })
    expect(h.ticketing.created[0]?.description).toContain('platform IT does not administer')
    expect((await h.store.get('hr-leaver'))?.offboarding?.ticketRef?.number).toBe('101')
  })

  it('raises nothing in a dry run and nothing when the create fails, so the next run tries again', async () => {
    const leaver = storedPerson({ hrisId: 'hr-leaver', status: 'terminated', terminationDate: '2026-01-27' })
    const dry = await joinerHarness({ config: TICKETED, people: [leaver] })
    await runTicketing(dry.ticketingDeps, { dryRun: true, actor: ACTOR, runId: 'r1' })
    expect(dry.ticketing.created).toEqual([])

    const failing = await joinerHarness({ config: TICKETED, people: [leaver] })
    failing.ticketing.failCreate = true
    await runTicketing(failing.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r1' })
    expect((await failing.store.get('hr-leaver'))?.offboarding?.ticketRef ?? null).toBeNull()
  })
})
