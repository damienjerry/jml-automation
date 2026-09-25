/**
 * A starter's temporary password was emailed to a colleague's work inbox.
 *
 * The personal-address field held a company address, typed in by whoever
 * filled the form. Both credential recipients are validated at send time:
 * the personal address must not be a company one, the manager's must be.
 * An unusable address is dropped with a warning and the IT copy always goes,
 * so the credential is re-routed to a person rather than lost.
 */
import { describe, expect, it } from 'vitest'
import { joinerHarness, starter } from '../helpers/joiner-harness.ts'

describe('where the temporary password may go', () => {
  it('goes to the personal address, the manager and IT when all three are usable', async () => {
    const h = await joinerHarness()
    await h.run()
    expect(h.sent.find((n) => n.kind === 'joiner.password')?.recipients).toEqual(['john.doe.home@example.net', 'jane.doe@example.com', 'it-support@example.com'])
  })

  it('is withheld from a personal address that is really a company one', async () => {
    const h = await joinerHarness({ people: [starter({ personalEmail: 'someone.else@example.com' })] })
    await h.run()
    expect(h.sent.find((n) => n.kind === 'joiner.password')?.recipients).toEqual(['jane.doe@example.com', 'it-support@example.com'])
    expect(h.sent.some((n) => n.kind === 'joiner.withheld' && n.body.includes('personal address'))).toBe(true)
  })

  it('is withheld from a manager field that is not a company address', async () => {
    const h = await joinerHarness({ people: [starter({ managerEmail: 'Robin Ellis' })] })
    await h.run()
    expect(h.sent.find((n) => n.kind === 'joiner.password')?.recipients).toEqual(['john.doe.home@example.net', 'it-support@example.com'])
  })

  it('still goes to IT when nothing else is usable, so it is never lost', async () => {
    const h = await joinerHarness({ people: [starter({ personalEmail: null, managerEmail: null })] })
    const report = await h.run()
    expect(h.sent.find((n) => n.kind === 'joiner.password')?.recipients).toEqual(['it-support@example.com'])
    expect(report.people[0]?.legs.welcome?.state).toBe('done')
  })
})
