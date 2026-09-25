/**
 * Every starter was told to change a temporary password that nothing forced
 * them to change.
 *
 * The forced-reset flag is not writable on the account and is cleared by
 * setting a password, so it has to be set by its own action AFTER the
 * password write, and proven from a fresh read. The old order set the flag,
 * then the password, and the flag went with it. The account was usable with
 * the emailed password indefinitely while the email said otherwise.
 */
import { describe, expect, it } from 'vitest'
import { joinerHarness } from '../helpers/joiner-harness.ts'

describe('the forced reset', () => {
  it('runs after the password is set, and both are read back before the marker is written', async () => {
    const h = await joinerHarness()
    const report = await h.run()
    const order = h.providers.calls.filter((c) => c.startsWith('idp.setTemporaryPassword') || c.startsWith('idp.expirePassword'))
    expect(order).toEqual(['idp.setTemporaryPassword(idp-starter)', 'idp.expirePassword(idp-starter)'])
    expect(h.providers.idpAccount('idp-starter')?.passwordExpired).toBe(true)
    const row = await h.store.get('hr-starter')
    expect(row?.activation?.activatedAt).toBe('2026-01-28')
    expect(row?.activation?.passwordResetForced).toBe(true)
    expect(report.people[0]?.legs.activate?.verified).toBe(true)
  })

  it('does not write the activation marker when the reset did not apply', async () => {
    const h = await joinerHarness({ seed: { idp: [{ id: 'idp-starter', email: 'john.doe@example.com', activated: false }], google: [] } })
    h.providers.fault('idp.expirePassword', { kind: 'unverified' })
    const report = await h.run()
    expect(report.people[0]?.legs.activate?.state).toBe('failed')
    expect((await h.store.get('hr-starter'))?.activation?.activatedAt ?? null).toBeNull()
    // No credential goes out for an account whose activation did not complete.
    expect(h.sent.filter((n) => n.kind === 'joiner.password')).toEqual([])
  })

  it('never puts the password into the audit log or the run report', async () => {
    const h = await joinerHarness()
    const report = await h.run()
    const everything = JSON.stringify(h.audit) + JSON.stringify(report) + h.providers.calls.join('\n')
    expect(everything).not.toContain('TEST-ONLY-NOT-A-PASSWORD')
    // It reaches exactly one place: the password message.
    expect(h.sent.find((n) => n.kind === 'joiner.password')?.body).toContain('TEST-ONLY-NOT-A-PASSWORD')
  })
})
