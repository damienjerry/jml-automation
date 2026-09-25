/**
 * Starters were activated with no laptop and no access, or not at all.
 *
 * In one estate the manager's form was the only thing that said what a
 * starter needed, and the only thing that opened the gate. Two failures
 * around it: a nudge that fired on every run until the channel was muted, and
 * a bridge that matched a ticket to the wrong person by name. The rules: ask
 * once, remind once the day before, and open the gate only on a unique match
 * on the configured form.
 */
import { describe, expect, it } from 'vitest'
import { openGateFromTicket } from '../../src/engine/ticketing/bridge.ts'
import { runTicketing } from '../../src/engine/ticketing/index.ts'
import { joinerHarness, starter } from '../helpers/joiner-harness.ts'
import { starterTicket } from '../helpers/fake-ticketing.ts'

const TICKETED = { ticketing: { adapter: 'suptask', suptask: { apiToken: 'env:SUPTASK_API_TOKEN', queueId: 'q', requesterId: 'U-it', starterFormId: 'form-starter' } }, joiner: { gate: 'ticket', licence: { skuId: '' } } }
const ACTOR = { kind: 'system' as const, id: 'system:test' }

describe('the starter form gate', () => {
  it('nudges the manager once, not on every run', async () => {
    const h = await joinerHarness({ config: TICKETED })
    await runTicketing(h.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r1' })
    await runTicketing(h.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r2' })
    const nudges = h.sent.filter((n) => n.kind === 'joiner.nudge')
    expect(nudges).toHaveLength(1)
    expect(nudges[0]?.managerEmail).toBe('jane.doe@example.com')
    expect((await h.store.get('hr-starter'))?.activation?.nudgedAt).toBe('2026-01-28')
  })

  it('reminds once the day before the start, and only while the gate is still closed', async () => {
    const h = await joinerHarness({ config: TICKETED, people: [starter({ startDate: '2026-01-29', activation: { nudgedAt: '2026-01-20' } })] })
    await runTicketing(h.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r1' })
    await runTicketing(h.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r2' })
    expect(h.sent.filter((n) => n.kind === 'joiner.reminder')).toHaveLength(1)

    const open = await joinerHarness({ config: TICKETED, people: [starter({ startDate: '2026-01-29', activation: { nudgedAt: '2026-01-20', gateOpenedAt: '2026-01-27' } })] })
    await runTicketing(open.ticketingDeps, { dryRun: false, actor: ACTOR, runId: 'r1' })
    expect(open.sent.filter((n) => n.kind === 'joiner.reminder')).toEqual([])
  })

  it('does not activate while the gate is closed, and activates once a ticket on the right form opens it', async () => {
    const h = await joinerHarness({ config: TICKETED })
    expect((await h.run()).counts.joinerGateClosed).toBe(1)

    const result = await openGateFromTicket(h.ticketingDeps, starterTicket({ 'First Name': 'John', 'Last Name': 'Doe', 'Personal Email': 'jd.personal@example.net' }), ACTOR)
    expect(result.outcome).toBe('opened')
    const row = await h.store.get('hr-starter')
    expect(row?.activation?.gateOpenedBy).toBe('ticket:42')
    expect(row?.personalEmail).toBe('jd.personal@example.net')
    expect(h.ticketing.replies[0]?.text).toContain('matched to John Doe')

    expect((await h.run()).counts.activated).toBe(1)
  })

  it('ignores a ticket raised on any other form', async () => {
    const h = await joinerHarness({ config: TICKETED })
    const result = await openGateFromTicket(h.ticketingDeps, starterTicket({ 'First Name': 'John', 'Last Name': 'Doe' }, 'some-other-form'), ACTOR)
    expect(result.outcome).toBe('ignored')
    expect((await h.store.get('hr-starter'))?.activation?.gateOpenedAt ?? null).toBeNull()
  })

  it('never opens a gate on an ambiguous name, and tells both the ticket and IT', async () => {
    const twins = [starter(), starter({ hrisId: 'hr-twin', primaryEmail: 'john.doe2@example.com' })]
    const h = await joinerHarness({ config: TICKETED, people: twins })
    const result = await openGateFromTicket(h.ticketingDeps, starterTicket({ 'First Name': 'John', 'Last Name': 'Doe' }), ACTOR)
    expect(result.outcome).toBe('ambiguous')
    for (const p of twins) expect((await h.store.get(p.hrisId))?.activation?.gateOpenedAt ?? null).toBeNull()
    expect(h.sent.some((n) => n.kind === 'ticket.unmatched')).toBe(true)
    expect(h.ticketing.replies).toHaveLength(1)
  })

  it('matches on the work address before the name when the form asks for one', async () => {
    const twins = [starter(), starter({ hrisId: 'hr-twin', primaryEmail: 'john.doe2@example.com' })]
    const h = await joinerHarness({ config: TICKETED, people: twins })
    const result = await openGateFromTicket(h.ticketingDeps, starterTicket({ 'First Name': 'John', 'Last Name': 'Doe', 'Work Email': 'john.doe2@example.com' }), ACTOR)
    expect(result).toMatchObject({ outcome: 'opened', hrisId: 'hr-twin' })
  })

  it('does not match somebody already activated, even by exact name', async () => {
    const h = await joinerHarness({ config: TICKETED, people: [starter({ activation: { activatedAt: '2026-01-10', activatedBy: 'engine' } })] })
    const result = await openGateFromTicket(h.ticketingDeps, starterTicket({ 'First Name': 'John', 'Last Name': 'Doe' }), ACTOR)
    expect(result.outcome).toBe('unmatched')
  })
})
