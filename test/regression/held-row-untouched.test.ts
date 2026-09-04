/**
 * Prevents: a hold that stops the engine but not the sync.
 *
 * The hold flag is the kill switch for one person. It was added during an
 * incident in which a row had inherited an employed colleague's account ids,
 * and it had to be certain: while somebody is reading a row to work out what
 * went wrong, nothing may keep changing it underneath them. A sync that went
 * on patching a held row would rewrite the evidence, and a sync that went on
 * flipping its status would put it back into a selection the hold exists to
 * keep it out of.
 *
 * So a held row is skipped ENTIRELY. Not "skipped for status writes": no field
 * patches either, whatever the HR system now says.
 */

import { describe, expect, it } from 'vitest'
import { runSync } from '../../src/engine/sync.ts'
import { ANCHOR, harness, hrisPerson, snapshot, storedPerson } from '../helpers/sync-harness.ts'

const HELD = storedPerson({
  hold: true,
  holdReason: 'account ids look wrong, being checked by hand',
  externalIds: { jumpcloudUserId: 'idp-account-jane' },
})

describe('a row a person has frozen', () => {
  it('is not written to at all, even when every HR field changed', async () => {
    const h = harness([HELD])
    const report = await runSync(
      h.options(
        snapshot([
          hrisPerson({
            primaryEmail: 'jane.roe@example.com',
            displayName: 'Jane Roe',
            department: 'Commercial',
            jobTitle: 'Manager',
            site: 'Northern depot',
            managerEmail: 'ada.stone@example.com',
          }),
        ]),
      ),
    )

    expect(h.store.writes).toBe(0)
    expect(report.counts.held).toBe(1)
    const person = await h.store.get('hr-001')
    expect(person?.primaryEmail).toBe('jane.doe@example.com')
    expect(person?.department).toBe('Operations')
    expect(person?.externalIds.jumpcloudUserId).toBe('idp-account-jane')
  })

  it('does not change status when the HR system drops the person', async () => {
    const h = harness([HELD])
    const report = await runSync(
      h.options(snapshot([hrisPerson({ terminationDate: '2026-03-09' }), ANCHOR], [ANCHOR.hrisId])),
    )

    expect((await h.store.get('hr-001'))?.status).toBe('active')
    expect(report.counts.status_changed).toBe(0)
  })

  it('is not tombstoned as a reused HR id', async () => {
    // The role-change tombstone is the sync's one destructive move, so the
    // hold has to sit in front of it as well.
    const h = harness([HELD])
    await runSync(h.options(snapshot([hrisPerson({ primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' })])))

    expect((await h.store.get('hr-001'))?.status).toBe('active')
    expect(h.store.writes).toBe(0)
  })

  it('is reported rather than silently ignored, and names why it is held', async () => {
    // Over-suppression is silent. A held row that vanished from the report
    // would look exactly like a row with nothing to do.
    const h = harness([HELD])
    const report = await runSync(h.options(snapshot([hrisPerson()])))

    expect(report.rows[0]?.action).toBe('held')
    expect(report.rows[0]?.reason).toContain('being checked by hand')
  })

  it('is patched again once the hold is lifted', async () => {
    const h = harness([HELD])
    const snap = snapshot([hrisPerson({ department: 'Commercial' })])
    await runSync(h.options(snap))
    await h.store.patch('hr-001', { hold: false, holdReason: null })

    const report = await runSync(h.options(snap))
    expect(report.counts.updated).toBe(1)
    expect((await h.store.get('hr-001'))?.department).toBe('Commercial')
  })
})
