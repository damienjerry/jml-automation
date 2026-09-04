/**
 * The HR sync, rule by rule.
 *
 * The incident-shaped cases live in test/regression; this file covers the
 * ordinary behaviour those rules sit on top of, so a regression test failing
 * tells you the safeguard broke rather than that the sync stopped working at
 * all.
 */

import { describe, expect, it } from 'vitest'
import { deriveHrisStatus, runSync, terminationOutsideLookback } from '../../src/engine/sync.ts'
import { HrisImplausible, HrisIncomplete } from '../../src/hris/types.ts'
import type { AuditEvent, AuditRef, AuditSink } from '../../src/audit/types.ts'
import type { Notification, NotificationResult, Notifier } from '../../src/notify/types.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import type { TransitionResult } from '../../src/store/types.ts'
import { ANCHOR, harness, hrisPerson, rules, snapshot, storedPerson, TODAY } from '../helpers/sync-harness.ts'

/** A store that refuses status writes, which is what a lost race looks like. */
class RefusingStore extends MemoryPeopleStore {
  override async transition(): Promise<TransitionResult> {
    return { ok: false, refusal: 'stale_status', reason: 'Row is offboarding, caller expected active.' }
  }
}

function recordingNotifier(delivered = true): Notifier & { sent: Notification[] } {
  const sent: Notification[] = []
  return {
    name: 'recording',
    sent,
    async send(n: Notification): Promise<NotificationResult> {
      sent.push(n)
      return delivered ? { delivered: true, channel: 'recording' } : { delivered: false, channel: 'recording', error: 'refused' }
    },
    async testConnection() {
      return { ok: true, detail: 'test double' }
    },
  }
}

function recordingAudit(failOn?: 'intent' | 'outcome'): AuditSink & { rows: AuditEvent[] } {
  const rows: AuditEvent[] = []
  return {
    name: 'recording',
    rows,
    async append(event: AuditEvent): Promise<AuditRef> {
      if (event.phase === failOn) throw new Error('audit sink is read-only')
      rows.push(event)
      return { seq: rows.length }
    },
  }
}

describe('deriving a status from an HR record', () => {
  it('is hired while the start date is in the future, employed or not', () => {
    const record = hrisPerson({ startDate: '2026-04-01' })
    expect(deriveHrisStatus(record, new Set([record.hrisId]), TODAY)).toBe('hired')
    expect(deriveHrisStatus(record, new Set(), TODAY)).toBe('hired')
  })

  it('is active only for somebody in the employed set', () => {
    const record = hrisPerson({ startDate: '2024-01-08' })
    expect(deriveHrisStatus(record, new Set([record.hrisId]), TODAY)).toBe('active')
    expect(deriveHrisStatus(record, new Set(), TODAY)).toBe('terminated')
  })

  it('ignores a start date it cannot parse rather than guessing at it', () => {
    // A locale-formatted date reaching this far is a bug upstream, and reading
    // "10/03/2026" as a future date would silently hold up a real joiner.
    const record = hrisPerson({ startDate: '10/03/2026' })
    expect(deriveHrisStatus(record, new Set([record.hrisId]), TODAY)).toBe('active')
  })
})

describe('the leaving-date lookback', () => {
  it('treats a missing or unparseable date as outside it', () => {
    expect(terminationOutsideLookback(null, TODAY, 60)).toBe(true)
    expect(terminationOutsideLookback('', TODAY, 60)).toBe(true)
    expect(terminationOutsideLookback('01/02/2026', TODAY, 60)).toBe(true)
  })

  it('accepts a recent date and a future one, and refuses an old one', () => {
    expect(terminationOutsideLookback('2026-03-09', TODAY, 60)).toBe(false)
    expect(terminationOutsideLookback('2026-04-01', TODAY, 60)).toBe(false)
    expect(terminationOutsideLookback('2025-01-01', TODAY, 60)).toBe(true)
  })
})

describe('creating rows', () => {
  it('creates the employed and the not-yet-started', async () => {
    const h = harness()
    const report = await runSync(
      h.options(snapshot([hrisPerson(), hrisPerson({ hrisId: 'hr-002', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone', startDate: '2026-04-06' })])),
    )

    expect(report.counts.created).toBe(2)
    expect((await h.store.get('hr-001'))?.status).toBe('active')
    expect((await h.store.get('hr-002'))?.status).toBe('hired')
  })

  it('refuses a record with no address rather than dropping it silently', async () => {
    const h = harness()
    const report = await runSync(h.options(snapshot([hrisPerson({ primaryEmail: '' })])))

    expect(report.counts.skipped_no_email).toBe(1)
    expect(await h.store.get('hr-001')).toBeNull()
    // The reason has to name the fix: nothing can be resolved for a person
    // with no address, in any provider.
    expect(report.rows[0]?.reason).toContain('no work address')
  })

  it('parks a new row whose address an employed row already holds', async () => {
    const h = harness([storedPerson({ hrisId: 'hr-old', status: 'active', primaryEmail: 'jane.doe@example.com' })])
    const report = await runSync(h.options(snapshot([hrisPerson({ hrisId: 'hr-new' })])))

    const created = await h.store.get('hr-new')
    expect(created?.reviewReason).toBe('identity_claimed_by_live_person')
    expect(report.warnings.join(' ')).toContain('hr-old')
  })

  it('creates normally when the address belonged to somebody who has left', async () => {
    const h = harness([storedPerson({ hrisId: 'hr-old', status: 'departed', primaryEmail: 'jane.doe@example.com' })])
    const report = await runSync(h.options(snapshot([hrisPerson({ hrisId: 'hr-new' })])))

    expect((await h.store.get('hr-new'))?.reviewReason).toBeNull()
    expect(report.warnings.join(' ')).toContain('rehire')
  })

  it('writes nothing when two stored rows claim the address, rather than picking one', async () => {
    const h = harness([
      storedPerson({ hrisId: 'hr-a', status: 'departed', primaryEmail: 'jane.doe@example.com' }),
      storedPerson({ hrisId: 'hr-b', status: 'departed', primaryEmail: 'jane.doe@legacy.example.com' }),
    ])
    const report = await runSync(h.options(snapshot([hrisPerson({ hrisId: 'hr-new' })])))

    expect(report.counts.refused).toBe(1)
    expect(await h.store.get('hr-new')).toBeNull()
  })
})

describe('updating rows', () => {
  it('patches the fields the HR system owns and reports which changed', async () => {
    const h = harness([storedPerson()])
    const report = await runSync(h.options(snapshot([hrisPerson({ department: 'Technology', jobTitle: 'Engineer' })])))

    expect(report.counts.updated).toBe(1)
    expect(report.rows[0]?.changedFields).toEqual(['department', 'jobTitle'])
    expect((await h.store.get('hr-001'))?.department).toBe('Technology')
  })

  it('keeps one row when an exit rename changes the address', async () => {
    // The alias path. An address matching an exit-rename pattern is the same
    // person on the way out, so the row keeps its provider account ids and the
    // old address stays reachable for a lookup.
    const h = harness([storedPerson({ externalIds: { jumpcloudUserId: 'idp-account-jane' } })])
    await runSync(h.options(snapshot([hrisPerson({ primaryEmail: 'jane.doe+exit@example.com' })])))

    const stored = await h.store.get('hr-001')
    expect(stored?.primaryEmail).toBe('jane.doe+exit@example.com')
    expect(stored?.aliasEmails).toContain('jane.doe@example.com')
    expect(stored?.externalIds.jumpcloudUserId).toBe('idp-account-jane')
  })

  it('moves an existing row through the transition table on a status change', async () => {
    const h = harness([storedPerson({ status: 'hired', startDate: '2026-03-01' })])
    const report = await runSync(h.options(snapshot([hrisPerson({ startDate: '2026-03-01' })])))

    expect(report.counts.status_changed).toBe(1)
    expect((await h.store.get('hr-001'))?.status).toBe('active')
  })

  it('reports a store refusal instead of pretending the write happened', async () => {
    // A tombstone is terminal, so the sync cannot move it. The row is
    // preserved rather than refused, which is the point of PRESERVED_BY_SYNC.
    const h = harness([storedPerson({ status: 'departed' })])
    const report = await runSync(h.options(snapshot([hrisPerson(), ANCHOR], [ANCHOR.hrisId])))

    expect(report.counts.preserved).toBe(1)
    expect(report.counts.refused).toBe(0)
    expect((await h.store.get('hr-001'))?.status).toBe('departed')
  })
})

describe('rows the engine owns', () => {
  it('patches names and dates on an offboarding row but never its status', async () => {
    const h = harness([
      storedPerson({
        status: 'offboarding',
        terminationDate: '2026-03-01',
        offboarding: { suspendedAt: '2026-03-02', legs: {} },
      }),
    ])
    const report = await runSync(h.options(snapshot([hrisPerson({ department: 'Commercial', terminationDate: '2026-03-01' }), ANCHOR], [ANCHOR.hrisId])))

    const stored = await h.store.get('hr-001')
    expect(report.counts.preserved).toBe(1)
    expect(stored?.status).toBe('offboarding')
    expect(stored?.department).toBe('Commercial')
  })

  it('never lets a blank HR value erase a stored one on a preserved row', async () => {
    const h = harness([storedPerson({ status: 'departed', department: 'Operations' })])
    await runSync(h.options(snapshot([hrisPerson({ department: '', managerEmail: null }), ANCHOR], [ANCHOR.hrisId])))

    const stored = await h.store.get('hr-001')
    expect(stored?.department).toBe('Operations')
    expect(stored?.managerEmail).toBe('john.doe@example.com')
  })

  it('reports a tombstoned person the HR system says is employed again', async () => {
    const h = harness([storedPerson({ status: 'departed' })])
    const report = await runSync(h.options(snapshot([hrisPerson()])))

    expect((await h.store.get('hr-001'))?.status).toBe('departed')
    expect(report.warnings.join(' ')).toContain('new HR record')
  })
})

describe('a role change on a reused HR id', () => {
  it('tombstones the old identity when nothing suggests a rename', async () => {
    const h = harness([storedPerson()])
    const report = await runSync(
      h.options(snapshot([hrisPerson({ primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' })])),
    )

    expect(report.counts.tombstoned).toBe(1)
    expect((await h.store.get('hr-001'))?.status).toBe('departed')
  })

  it('parks instead of tombstoning when an employed row holds the new address', async () => {
    const h = harness([
      storedPerson(),
      storedPerson({ hrisId: 'hr-002', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' }),
    ])
    const report = await runSync(
      h.options(
        snapshot([
          hrisPerson({ primaryEmail: 'ada.stone@example.com' }),
          hrisPerson({ hrisId: 'hr-002', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' }),
        ]),
      ),
    )

    expect(report.counts.tombstoned).toBe(0)
    const stored = await h.store.get('hr-001')
    expect(stored?.status).toBe('active')
    expect(stored?.reviewReason).toBe('identity_claimed_by_live_person')
  })

  it('keeps one row when the person is not employed, whatever the address says', async () => {
    const h = harness([storedPerson({ status: 'terminated', terminationDate: '2026-03-05' })])
    const report = await runSync(
      h.options(snapshot([hrisPerson({ primaryEmail: 'ada.stone@example.com', terminationDate: '2026-03-05' }), ANCHOR], [ANCHOR.hrisId])),
    )

    expect(report.counts.tombstoned).toBe(0)
    expect((await h.store.get('hr-001'))?.aliasEmails).toContain('jane.doe@example.com')
  })
})

describe('the run as a whole', () => {
  it('leaves a stored row the snapshot never mentions exactly as it is', async () => {
    const h = harness([storedPerson({ hrisId: 'hr-999', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' })])
    const report = await runSync(h.options(snapshot([hrisPerson()])))

    expect(report.counts.storedNotInSnapshot).toBe(1)
    // Absence from a snapshot is not a departure: that is what a truncated
    // read looks like.
    expect((await h.store.get('hr-999'))?.status).toBe('active')
    expect(report.warnings.join(' ')).toContain('hr-999')
  })

  it('uses the first record when the snapshot repeats an id', async () => {
    const h = harness()
    const report = await runSync(
      h.options(snapshot([hrisPerson({ department: 'First' }), hrisPerson({ department: 'Second' })])),
    )

    expect(report.counts.created).toBe(1)
    expect((await h.store.get('hr-001'))?.department).toBe('First')
    expect(report.warnings.join(' ')).toContain('more than once')
  })

  it('plans without writing in dry run', async () => {
    const h = harness([storedPerson({ status: 'hired', startDate: '2026-03-01' })])
    const before = h.store.writes
    const report = await runSync(
      h.options(snapshot([hrisPerson({ startDate: '2026-03-01', department: 'Technology' }), hrisPerson({ hrisId: 'hr-002', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' })]), {
        dryRun: true,
      }),
    )

    expect(h.store.writes).toBe(before)
    expect(report.counts.created).toBe(1)
    expect(report.counts.status_changed).toBe(1)
    expect(report.rows.find((r) => r.hrisId === 'hr-001')?.changedFields).toContain('department')
  })
})

describe('a store that refuses the status write', () => {
  it('reports the refusal and makes the run not ok, rather than reporting a change', async () => {
    // The compare-and-set exists because a row can move between the read and
    // the write. Reporting that as a successful transition would leave the
    // report describing a status the store does not hold.
    const store = new RefusingStore({ seed: [storedPerson()] })
    const report = await runSync({
      snapshot: snapshot([hrisPerson({ terminationDate: '2026-03-05' }), ANCHOR], [ANCHOR.hrisId]),
      people: store,
      today: TODAY,
      identity: rules(),
      minPlausibleHeadcount: 1,
      terminationLookbackDays: 60,
    })

    expect(report.ok).toBe(false)
    expect(report.counts.refused).toBe(1)
    expect(report.errors[0]).toContain('stale_status')
    expect((await store.get('hr-001'))?.status).toBe('active')
  })
})

describe('the audit pair around a status write', () => {
  it('records an intent and an outcome', async () => {
    const audit = recordingAudit()
    const h = harness([storedPerson()])
    await runSync(h.options(snapshot([hrisPerson({ terminationDate: '2026-03-05' }), ANCHOR], [ANCHOR.hrisId]), { audit }))

    expect(audit.rows.map((r) => r.phase)).toEqual(['intent', 'outcome'])
    expect(audit.rows[1]?.ok).toBe(true)
    expect(audit.rows[1]?.verified).toBe(true)
  })

  it('does not write the status when the intent row cannot be persisted', async () => {
    const audit = recordingAudit('intent')
    const h = harness([storedPerson()])
    const report = await runSync(h.options(snapshot([hrisPerson({ terminationDate: '2026-03-05' }), ANCHOR], [ANCHOR.hrisId]), { audit }))

    expect((await h.store.get('hr-001'))?.status).toBe('active')
    expect(report.ok).toBe(false)
    expect(report.counts.refused).toBe(1)
  })
})

describe('refusing a snapshot', () => {
  it('aborts on an incomplete read, before any write', async () => {
    const h = harness()
    await expect(runSync(h.options(snapshot([hrisPerson()], undefined, { complete: false })))).rejects.toBeInstanceOf(
      HrisIncomplete,
    )
    expect(h.store.writes).toBe(0)
  })

  it('aborts when the employed set alone is below the floor', async () => {
    // The employed set is usually a second read, so it can be truncated on its
    // own while the full list looks perfectly healthy.
    const h = harness()
    const people = [hrisPerson(), hrisPerson({ hrisId: 'hr-002', primaryEmail: 'ada.stone@example.com', displayName: 'Ada Stone' })]
    await expect(
      runSync(h.options(snapshot(people, ['hr-001']), { minPlausibleHeadcount: 2 })),
    ).rejects.toBeInstanceOf(HrisImplausible)
    expect(h.store.writes).toBe(0)
  })
})

describe('telling somebody about a reinstatement', () => {
  it('sends one notification and makes the run not ok when it is not delivered', async () => {
    const notifier = recordingNotifier(false)
    const h = harness([
      storedPerson({ status: 'offboarding', offboarding: { suspendedAt: '2026-03-02', legs: {} } }),
    ])
    const report = await runSync(h.options(snapshot([hrisPerson()]), { notifier }))

    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]?.kind).toBe('leaver.parked')
    expect(report.ok).toBe(false)
    // The protective write still happened: the hold does not depend on a chat
    // API being reachable.
    expect((await h.store.get('hr-001'))?.hold).toBe(true)
  })
})
