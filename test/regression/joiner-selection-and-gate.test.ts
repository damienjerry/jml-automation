/**
 * Who gets activated, and when. Each case is a rule that was learned the
 * hard way: out-of-scope people announced and activated, a gate that was a
 * form nobody had filled in, a run that activated a crowd on a data glitch,
 * and a start date counted in calendar days across a weekend.
 */
import { describe, expect, it } from 'vitest'
import { joinerHarness, starter } from '../helpers/joiner-harness.ts'

describe('joiner selection', () => {
  it('skips a person the HR system says IT does not provision for', async () => {
    const h = await joinerHarness({ people: [starter({ inScope: false })] })
    const report = await h.run()
    expect(report.counts.joinerCandidates).toBe(0)
    expect(h.providers.calls).toEqual([])
  })

  it('counts the lead in working days, so a Monday start is due on the Wednesday before', async () => {
    // TODAY is Wednesday 2026-01-28. Three working days on is Monday 02-02.
    const due = await joinerHarness({ people: [starter({ startDate: '2026-02-02' })] })
    expect((await due.run()).counts.joinerCandidates).toBe(1)
    const notYet = await joinerHarness({ people: [starter({ startDate: '2026-02-03' })] })
    expect((await notYet.run()).counts.joinerCandidates).toBe(0)
  })

  it('holds everybody over the per-run cap and names them', async () => {
    const people = ['a', 'b', 'c'].map((k) => starter({ hrisId: `hr-${k}`, displayName: `Person ${k.toUpperCase()}`, primaryEmail: `${k}@example.com` }))
    const h = await joinerHarness({ people, config: { joiner: { maxActivationsPerRun: 2, licence: { skuId: '' } } }, seed: { idp: people.map((p) => ({ id: `idp-${p.hrisId}`, email: p.primaryEmail, activated: false })), google: [] } })
    const report = await h.run()
    expect(report.counts.joinerHeld).toBe(1)
    expect(report.warnings.some((w) => w.includes('Person C'))).toBe(true)
    expect(h.providers.calls.filter((c) => c.startsWith('idp.setTemporaryPassword'))).toHaveLength(2)
  })

  it('does nothing while a manual gate is closed, and activates once it is opened', async () => {
    const closed = await joinerHarness({ config: { joiner: { gate: 'manual' } } })
    const first = await closed.run()
    expect(first.counts.joinerGateClosed).toBe(1)
    expect(closed.providers.calls.some((c) => c.startsWith('idp.setTemporaryPassword'))).toBe(false)

    const opened = await joinerHarness({ config: { joiner: { gate: 'manual' } }, people: [starter({ activation: { gateOpenedAt: '2026-01-27', gateOpenedBy: 'ops@example.com' } })] })
    const second = await opened.run()
    expect(second.counts.activated).toBe(1)
  })

  it('looks again next run when the identity account does not exist yet', async () => {
    const h = await joinerHarness({ seed: { idp: [], google: [] } })
    const report = await h.run()
    expect(report.counts.joinerNoAccount).toBe(1)
    expect((await h.store.get('hr-starter'))?.activation?.activatedAt ?? null).toBeNull()
    expect(report.ok).toBe(true)
  })

  it('never activates twice', async () => {
    const h = await joinerHarness()
    await h.run()
    const before = h.providers.calls.length
    await h.run()
    expect(h.providers.calls.length).toBe(before)
  })

  it('makes zero writes in a dry run', async () => {
    const h = await joinerHarness()
    const report = await h.run({ dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(h.providers.calls.filter((c) => !c.startsWith('idp.findUser') && !c.startsWith('idp.getActivationState'))).toEqual([])
    expect((await h.store.get('hr-starter'))?.activation ?? null).toBeNull()
  })
})
