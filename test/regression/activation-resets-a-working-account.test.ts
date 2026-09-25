/**
 * An account somebody was using got its password reset by the joiner
 * automation.
 *
 * A mis-entered HR field queued a working colleague for "activation". The
 * only thing that separates a staged account from a working one is that
 * nobody has ever set its password or enrolled MFA, and that is the test:
 * either sign of use means the account is refused, its password untouched.
 */
import { describe, expect, it } from 'vitest'
import { joinerHarness, starter } from '../helpers/joiner-harness.ts'

describe('an identity account that is already in use', () => {
  it('is never reset, and is recorded as activated by observation when nobody expected activation', async () => {
    const h = await joinerHarness({ seed: { idp: [{ id: 'idp-starter', email: 'john.doe@example.com', activated: true }], google: [] } })
    const report = await h.run()
    expect(h.providers.calls.filter((c) => c.startsWith('idp.setTemporaryPassword'))).toEqual([])
    expect(h.providers.calls.filter((c) => c.startsWith('idp.expirePassword'))).toEqual([])
    const row = await h.store.get('hr-starter')
    expect(row?.activation?.activatedBy).toBe('observed')
    expect(report.counts.activated ?? 0).toBe(0)
    expect(h.sent.filter((n) => n.kind === 'joiner.password')).toEqual([])
  })

  it('is refused and reported when a person opened the gate expecting an activation', async () => {
    const h = await joinerHarness({
      config: { joiner: { gate: 'manual', licence: { skuId: '' } } },
      people: [starter({ activation: { gateOpenedAt: '2026-01-27', gateOpenedBy: 'ops@example.com' } })],
      seed: { idp: [{ id: 'idp-starter', email: 'john.doe@example.com', mfaConfigured: true, activated: false }], google: [] },
    })
    const report = await h.run()
    expect(report.people[0]?.phase).toBe('joiner_refused')
    expect((await h.store.get('hr-starter'))?.activation?.refusedReason).toBe('already_in_use')
    expect(h.sent.some((n) => n.kind === 'joiner.refused')).toBe(true)
    expect(h.providers.calls.some((c) => c.startsWith('idp.setTemporaryPassword'))).toBe(false)
  })

  it('stays refused on the next run until a person clears it', async () => {
    const h = await joinerHarness({ people: [starter({ activation: { refusedReason: 'already_in_use' } })] })
    const report = await h.run()
    expect(report.counts.joinerCandidates).toBe(0)
    expect(h.providers.calls).toEqual([])
  })
})
