/**
 * Prevents: a sync reviving a row whose access has already been suspended.
 *
 * What happened, in the class of automation this comes from: a leaving date was
 * cancelled or entered against the wrong person, the HR system started
 * reporting them as employed again, and the sync flipped the row back to
 * active. Nothing unsuspended the accounts, so the row and the accounts
 * disagreed; and because the row was active again it stopped being visible as
 * an offboarding in progress, so nobody looked.
 *
 * The rule: once the Day-0 marker is written, the sync does not change the
 * status. It sets hold, sets reviewReason reinstated_after_day0 and says so
 * once. Restoring somebody's access is a decision for a person, because by
 * this point their files may already have been handed to somebody else.
 */

import { describe, expect, it } from 'vitest'
import { runSync } from '../../src/engine/sync.ts'
import type { Notification, NotificationResult, Notifier } from '../../src/notify/types.ts'
import { harness, hrisPerson, snapshot, storedPerson } from '../helpers/sync-harness.ts'

function notifier(): Notifier & { sent: Notification[] } {
  const sent: Notification[] = []
  return {
    name: 'recording',
    sent,
    async send(n: Notification): Promise<NotificationResult> {
      sent.push(n)
      return { delivered: true, channel: 'recording' }
    },
    async testConnection() {
      return { ok: true, detail: 'test double' }
    },
  }
}

const SUSPENDED = { suspendedAt: '2026-03-02', legs: {} }

describe('the HR system reporting a suspended person as employed again', () => {
  it('freezes the row instead of reviving it', async () => {
    const post = notifier()
    const h = harness([storedPerson({ status: 'offboarding', offboarding: SUSPENDED })])
    const report = await runSync(h.options(snapshot([hrisPerson()]), { notifier: post }))

    const person = await h.store.get('hr-001')
    expect(person?.status).toBe('offboarding')
    expect(person?.hold).toBe(true)
    expect(person?.reviewReason).toBe('reinstated_after_day0')
    expect(report.reinstated).toEqual(['hr-001'])
    expect(post.sent).toHaveLength(1)
  })

  it('says it once, not on every run', async () => {
    const post = notifier()
    const h = harness([storedPerson({ status: 'offboarding', offboarding: SUSPENDED })])
    const snap = snapshot([hrisPerson()])
    await runSync(h.options(snap, { notifier: post }))
    const afterFirst = h.store.writes
    const second = await runSync(h.options(snap, { notifier: post }))

    // No gate is needed for this: the hold written by the first run is the
    // idempotency key, because a held row is skipped before the decision.
    expect(post.sent).toHaveLength(1)
    expect(h.store.writes).toBe(afterFirst)
    expect(second.counts.held).toBe(1)
    expect(second.reinstated).toEqual([])
  })

  it('freezes a terminated row that already carries the Day-0 marker', async () => {
    // The Day-0 legs can run and the status write can still fail, leaving the
    // marker on a terminated row. Reviving that row would suspend the person a
    // second time.
    const h = harness([storedPerson({ status: 'terminated', terminationDate: '2026-03-01', offboarding: SUSPENDED })])
    const report = await runSync(h.options(snapshot([hrisPerson()])))

    const person = await h.store.get('hr-001')
    expect(person?.status).toBe('terminated')
    expect(person?.hold).toBe(true)
    expect(report.counts.auto_held).toBe(1)
  })

  it('still revives a leaver whose date was cancelled before Day 0', async () => {
    // The guard must not swallow the ordinary case. Nothing has been suspended
    // here, so there is nothing for a person to decide.
    const h = harness([storedPerson({ status: 'terminated', terminationDate: '2026-03-01' })])
    const report = await runSync(h.options(snapshot([hrisPerson({ terminationDate: null })])))

    const person = await h.store.get('hr-001')
    expect(person?.status).toBe('active')
    expect(person?.hold).toBe(false)
    expect(report.counts.status_changed).toBe(1)
  })

  it('plans the freeze in dry run without writing or telling anybody', async () => {
    const post = notifier()
    const h = harness([storedPerson({ status: 'offboarding', offboarding: SUSPENDED })])
    const report = await runSync(h.options(snapshot([hrisPerson()]), { notifier: post, dryRun: true }))

    expect(h.store.writes).toBe(0)
    expect(post.sent).toHaveLength(0)
    expect(report.counts.auto_held).toBe(1)
    expect(report.reinstated).toEqual(['hr-001'])
  })
})
