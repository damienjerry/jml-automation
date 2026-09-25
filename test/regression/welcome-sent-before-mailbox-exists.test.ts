/**
 * A starter's welcome email bounced because their mailbox did not exist yet.
 *
 * An account created by a directory integration has no mailbox until it is
 * licensed and the provider has built one, which takes minutes. The welcome
 * to the work address must wait for the mailbox, and be withheld rather than
 * bounced when it is not ready in time. The personal address still gets it.
 */
import { describe, expect, it } from 'vitest'
import { joinerHarness } from '../helpers/joiner-harness.ts'

describe('the welcome to the work address', () => {
  it('waits for the mailbox after licensing, then goes to both addresses', async () => {
    const h = await joinerHarness()
    await h.run()
    const welcome = h.sent.find((n) => n.kind === 'joiner.welcome')
    expect(welcome?.recipients).toEqual(['john.doe.home@example.net', 'john.doe@example.com'])
    expect(h.providers.calls.filter((c) => c.startsWith('google.assignLicence'))).toHaveLength(1)
    expect((await h.store.get('hr-starter'))?.activation?.welcomeSentAt).toBe('2026-01-28')
  })

  it('is withheld, not bounced, when the mailbox is not ready in time, and IT is told', async () => {
    const h = await joinerHarness({
      seed: { idp: [{ id: 'idp-starter', email: 'john.doe@example.com', activated: false }], google: [{ id: 'goog-starter', email: 'john.doe@example.com', licences: [], mailboxReady: false, mailboxReadyAfterReads: 99, orgUnitPath: '/' }] },
    })
    const report = await h.run()
    const welcome = h.sent.find((n) => n.kind === 'joiner.welcome')
    expect(welcome?.recipients).toEqual(['john.doe.home@example.net'])
    expect(h.sent.some((n) => n.kind === 'joiner.withheld' && n.body.includes('work address'))).toBe(true)
    expect(report.people[0]?.notes?.some((n) => n.includes('welcome email withheld'))).toBe(true)
    expect((await h.store.get('hr-starter'))?.activation?.welcomeSentAt ?? null).toBeNull()
    // The account is still activated: a slow mailbox is not a reason to leave
    // somebody without a password on their first morning.
    expect((await h.store.get('hr-starter'))?.activation?.activatedAt).toBe('2026-01-28')
  })
})
