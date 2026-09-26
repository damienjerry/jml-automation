import { describe, expect, it } from 'vitest'
import { addDays } from '../../src/core/clock.ts'
import type { Actor } from '../../src/core/types.ts'
import type { PeopleStore } from '../../src/store/types.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { deleteCutoff, transferCutoff } from '../../src/engine/leaver/select.ts'
import {
  CapturingNotifier,
  DEVICE_ID,
  IDP_USER_ID,
  LEAVER_EMAIL,
  LEAVER_ID,
  MANAGER_EMAIL,
  TODAY,
  defaultSeed,
  harness,
  leaverConfig,
  personFixture,
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

/**
 * A store that behaves like the real one apart from what a test overrides.
 *
 * Written out rather than spread, because the store is a class and an object
 * spread of a class instance quietly loses every method.
 */
function delegate(inner: PeopleStore, overrides: Partial<PeopleStore>): PeopleStore {
  return {
    capabilities: inner.capabilities,
    init: () => inner.init(),
    get: (hrisId) => inner.get(hrisId),
    findByEmail: (email) => inner.findByEmail(email),
    list: (filter) => inner.list(filter),
    countExact: (filter) => inner.countExact(filter),
    upsert: (person) => inner.upsert(person),
    transition: (req) => inner.transition(req),
    patch: (hrisId, patch) => inner.patch(hrisId, patch),
    close: () => inner.close(),
    ...overrides,
  }
}

const SYSTEM: Actor = { kind: 'system', id: 'system:leaver-engine' }
const RUN = { dryRun: false, actor: SYSTEM, runId: 'run-1' }
const cfg = leaverConfig()

describe('day 0, armed', () => {
  it('suspends, sets the auto-reply, releases the licence and writes the marker', async () => {
    const h = harness({ armed: true })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day0).toBe(1)
    expect(report.ok).toBe(true)
    expect(h.calls).toEqual([
      'idp.findUser(jane.doe@example.com)',
      'google.getUser(jane.doe@example.com)',
      'idp.suspendUser(usr-leaver-1)',
      'google.setVacationResponder(jane.doe@example.com)',
      'google.listLicences(jane.doe@example.com)',
      'google.revokeLicence(jane.doe@example.com,sku-standard)',
    ])

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.suspendedAt).toBe(TODAY)
    expect(row?.offboarding?.legs?.suspend_idp).toMatchObject({ state: 'done', verified: true })
    expect(row?.offboarding?.legs?.revoke_licence).toMatchObject({ state: 'done', verified: true })
    expect(h.providers.idpAccount(IDP_USER_ID)?.suspended).toBe(true)
  })

  it('tells the manager what was done, when the files arrive and when deletion happens', async () => {
    const h = harness({ armed: true })
    await runLeaverEngine(h.deps, RUN)

    const manager = h.notifier.sent.find((n) => n.audience === 'manager')
    expect(manager?.managerEmail).toBe(MANAGER_EMAIL)
    expect(manager?.body).toContain(addDays(TODAY, cfg.leaver.transferDay))
    expect(manager?.body).toContain(addDays(TODAY, cfg.leaver.deleteDay))
    expect(manager?.body).toContain('suspend')
    expect(h.notifier.kinds()).toContain('leaver.day0')
  })

  it('records an intent row before every provider call and an outcome row after it', async () => {
    const h = harness({ armed: true })
    await runLeaverEngine(h.deps, RUN)

    const suspend = h.audit.events.filter((e) => e.action === 'leaver.day0.suspend_idp')
    expect(suspend.map((e) => e.phase)).toEqual(['intent', 'outcome'])
    // The outcome cites the intent, rather than the pair being matched on a
    // timestamp, which stops working the moment a step is retried in one run.
    expect(suspend[1]?.intentSeq).toBe(1)
    expect(suspend[1]?.verified).toBe(true)
  })

  it('does not name the leaver by address in the audit subject', async () => {
    const h = harness({ armed: true })
    await runLeaverEngine(h.deps, RUN)
    for (const event of h.audit.events) {
      expect(event.subject.id).not.toContain('@')
    }
  })

  it('records a leg that is not armed rather than dropping it', async () => {
    const h = harness({ armed: ['suspend'] })
    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.legs?.set_autoreply?.state).toBe('not_armed')
    expect(row?.offboarding?.legs?.revoke_licence?.state).toBe('not_armed')
    // Declining to act is not an attempt, so it must not count towards the
    // limit that parks a row.
    expect(row?.offboarding?.legs?.set_autoreply?.attempts).toBe(0)
    expect(report.ok).toBe(true)
    expect(h.calls).not.toContain('google.setVacationResponder(jane.doe@example.com)')
  })

  it('reports nothing to do when no Google account exists, and still suspends', async () => {
    const h = harness({ armed: true, seed: { ...defaultSeed(), google: [] } })
    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.googleAccountPresent).toBe(false)
    expect(row?.offboarding?.legs?.set_autoreply?.state).toBe('not_applicable')
  })

  it('reads whether a Google account exists from the directory rather than inferring it', async () => {
    const h = harness({ armed: true, people: [personFixture({ googleAccountPresent: null })] })
    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.googleAccountPresent).toBe(true)
  })
})

describe('a dry run', () => {
  it('writes nothing anywhere and calls no provider write', async () => {
    const h = harness({ armed: true })
    const writesBefore = h.store.writes
    const report = await runLeaverEngine(h.deps, { ...RUN, dryRun: true })

    expect(h.store.writes).toBe(writesBefore)
    expect((await h.store.get(LEAVER_ID))?.status).toBe('terminated')
    expect(h.providers.idpAccount(IDP_USER_ID)?.suspended).toBeFalsy()
    expect(h.calls).toEqual([
      'idp.findUser(jane.doe@example.com)',
      'google.getUser(jane.doe@example.com)',
      // The licence list is a read, so a rehearsal can name the seats it
      // would release.
      'google.listLicences(jane.doe@example.com)',
    ])
    expect(report.people[0]?.statusAfter).toBe('offboarding')
    expect(report.people[0]?.notes?.join(' ')).toContain('dry run')
  })

  it('still renders the notification, marked as a rehearsal', async () => {
    const h = harness({ armed: true })
    await runLeaverEngine(h.deps, { ...RUN, dryRun: true })
    expect(h.notifier.sent.length).toBeGreaterThan(0)
    expect(h.notifier.sent.every((n) => n.subject.startsWith('[DRY RUN]'))).toBe(true)
  })
})

describe('day 6', () => {
  const due = transferCutoff(TODAY, cfg)

  it('hands the files to the manager and closes the Google account', async () => {
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(due)],
      seed: {
        ...defaultSeed(),
        google: [
          { id: 'goog-leaver-1', email: LEAVER_EMAIL, licences: [] },
          { id: 'goog-manager-1', email: MANAGER_EMAIL },
        ],
      },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day6).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.transferredAt).toBeTruthy()
    expect(row?.offboarding?.transferRecipient).toBe(MANAGER_EMAIL)
    expect(row?.offboarding?.legs?.suspend_google).toMatchObject({ state: 'done', verified: true })
    // No status change on day 6: the marker is the only record of progress.
    expect(row?.status).toBe('offboarding')
  })

  it('leaves an unfinished hand-over to the next run and does not start a second one', async () => {
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(due)],
      seed: {
        google: [
          { id: 'goog-leaver-1', email: LEAVER_EMAIL },
          { id: 'goog-manager-1', email: MANAGER_EMAIL },
        ],
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
        transferStates: ['inProgress'],
      },
    })
    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.transferId).toBe('transfer-1')
    expect(row?.offboarding?.transferredAt).toBeFalsy()

    // Second run: it polls the same transfer rather than inserting another.
    const second = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })
    expect(h.calls.filter((c) => c.startsWith('google.transferDrive'))).toHaveLength(1)
    expect(second.counts.day6).toBe(1)
  })

  it('closes the Google account even when nobody could be found to take the files', async () => {
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(due, { managerEmail: null })],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }], google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL }] },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.reviewReason).toBe('no_transfer_recipient')
    expect(row?.offboarding?.legs?.suspend_google).toMatchObject({ verified: true })
    expect(report.ok).toBe(false)
  })
})

describe('day 7', () => {
  const due = deleteCutoff(TODAY, cfg)

  function readyToDelete(overrides: Record<string, unknown> = {}) {
    return suspendedPersonFixture(due, {
      offboarding: {
        suspendedAt: due,
        legs: {},
        transferredAt: `${TODAY}T08:00:00.000Z`,
        transferRecipient: MANAGER_EMAIL,
      },
      ...overrides,
    })
  }

  it('deletes both accounts and tombstones the row once both reads confirm it', async () => {
    const h = harness({
      armed: true,
      people: [readyToDelete()],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day7).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('departed')
    expect(row?.offboarding?.departedAt).toBe(TODAY)
    expect(row?.offboarding?.deleteBlockedReason).toBeNull()
    // The account record is written to the audit before it is destroyed,
    // because it cannot be read afterwards.
    expect(h.audit.actions()).toContain('leaver.day7.delete_idp.snapshot')
  })

  it('refuses to delete while the hand-over has not completed', async () => {
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(due)],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL }],
      },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.blocked).toBe(1)
    expect((await h.store.get(LEAVER_ID))?.offboarding?.deleteBlockedReason).toBe('transfer_incomplete')
    expect(h.calls).not.toContain(`idp.deleteUser(${IDP_USER_ID})`)
  })

  it('refuses to delete while a machine is still bound, and names the machine', async () => {
    const h = harness({
      armed: true,
      people: [readyToDelete()],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true, devices: [DEVICE_ID] }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
        devices: [{ id: DEVICE_ID, displayName: 'Field laptop 1', serial: 'SERIAL0001' }],
      },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.blocked).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.deleteBlockedReason).toBe('devices_bound')
    expect(row?.offboarding?.boundDevices?.[0]?.id).toBe(DEVICE_ID)
    // A raw id in an alert is not actionable, so the machine is named.
    expect(h.notifier.bodies()).toContain('Field laptop 1')
  })

  it('refuses to delete an account that is no longer suspended', async () => {
    const h = harness({
      armed: true,
      people: [readyToDelete()],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: false }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.reviewReason).toBe('reinstated_after_day0')
    expect(h.providers.idpAccount(IDP_USER_ID)).toBeDefined()
  })

  it('records the delete attempt on the row even when it refuses', async () => {
    const h = harness({
      armed: true,
      people: [readyToDelete()],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: false }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    await runLeaverEngine(h.deps, RUN)

    // The refusal is evidence, and evidence belongs on the row rather than
    // only in the run that happened to notice.
    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.legs?.delete_idp).toMatchObject({ state: 'failed', attempts: 1 })
    expect(row?.offboarding?.legs?.delete_idp?.error).toContain('not suspended')
  })

  it('evaluates the hand-over gate against what the directory said this run', async () => {
    // The row said nothing about a Google account and the directory says there
    // is none, so there are no files to hand over and nothing to wait for. A
    // gate reading the copy taken before that lookup would block for ever.
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(due, { googleAccountPresent: null })],
      seed: { idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }], google: [] },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day7).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.googleAccountPresent).toBe(false)
    expect(row?.status).toBe('departed')
  })

  it('stops at suspended when the Google deletion is switched off', async () => {
    const h = harness({
      armed: true,
      config: { leaver: { deleteGoogleUser: false } },
      people: [readyToDelete()],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day7).toBe(1)
    expect(h.providers.googleAccount(LEAVER_EMAIL)).toBeDefined()
    expect((await h.store.get(LEAVER_ID))?.offboarding?.legs?.delete_google?.state).toBe('not_applicable')
  })

  it('waits for an acknowledgement when one is required', async () => {
    const h = harness({
      armed: true,
      config: { leaver: { requireOperatorAck: true } },
      people: [readyToDelete()],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.offboarding?.deleteBlockedReason).toBe('awaiting_ack')

    const blocked = await h.store.get(LEAVER_ID)
    await h.store.patch(LEAVER_ID, {
      offboarding: {
        ...(blocked?.offboarding ?? { suspendedAt: due, legs: {} }),
        operatorAck: { by: 'jane.doe@example.com', at: `${TODAY}T09:30:00.000Z` },
      },
    })
    const second = await runLeaverEngine(h.deps, { ...RUN, runId: 'run-2' })
    expect(second.counts.day7).toBe(1)
  })
})

describe('one person at a time', () => {
  it('only touches the person named by an address', async () => {
    const h = harness({
      armed: true,
      people: [personFixture(), personFixture({ hrisId: 'hris-0002', primaryEmail: 'someone.else@example.com' })],
      seed: {
        idp: [
          { id: IDP_USER_ID, email: LEAVER_EMAIL },
          { id: 'usr-other', email: 'someone.else@example.com' },
        ],
        google: [],
      },
    })
    const report = await runLeaverEngine(h.deps, { ...RUN, only: { email: LEAVER_EMAIL } })

    expect(report.people.map((p) => p.hrisId)).toEqual([LEAVER_ID])
    expect(h.calls).not.toContain('idp.suspendUser(usr-other)')
  })
})

describe('the later phases', () => {
  it('report an error when the tombstone write is refused after the accounts went', async () => {
    const due = deleteCutoff(TODAY, cfg)
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(due, {
          offboarding: { suspendedAt: due, legs: {}, transferredAt: `${TODAY}T08:00:00.000Z`, transferRecipient: MANAGER_EMAIL },
        }),
      ],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })
    const deps = {
      ...h.deps,
      store: delegate(h.store, {
        transition: async () => ({ ok: false as const, refusal: 'stale_status' as const, reason: 'the row moved' }),
      }),
    }

    const report = await runLeaverEngine(deps, RUN)

    // The accounts are gone and the row says offboarding, which is the honest
    // record: the next run finds both deletes already absent and completes.
    expect(report.ok).toBe(false)
    expect(report.errors.join(' ')).toContain('could not be marked departed')
  })

  it('parks rather than announcing when the blockage is a data problem', async () => {
    const due = deleteCutoff(TODAY, cfg)
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(due, {
          offboarding: { suspendedAt: due, legs: {}, transferredAt: `${TODAY}T08:00:00.000Z` },
          externalIds: { jumpcloudUserId: IDP_USER_ID },
        }),
        personFixture({ hrisId: 'hris-live', status: 'active', terminationDate: null, primaryEmail: 'live.person@example.com' }),
      ],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, suspended: true }],
      },
    })

    await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.reviewReason).toBe('identity_claimed_by_live_person')
    // Parked, not merely blocked: a shared identifier needs a person, not a
    // note that repeats when the device set changes.
    expect(h.notifier.kinds()).toContain('leaver.parked')
    expect(h.notifier.kinds()).not.toContain('leaver.blocked')
  })

  it('reports a hand-over the provider says failed, and keeps deletion blocked', async () => {
    const due = transferCutoff(TODAY, cfg)
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(due, { offboarding: { suspendedAt: due, legs: {}, transferId: 'transfer-1' } })],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, suspended: true }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL }],
        transferStates: ['failed'],
      },
    })

    const report = await runLeaverEngine(h.deps, RUN)

    const row = await h.store.get(LEAVER_ID)
    expect(row?.offboarding?.legs?.transfer_drive?.state).toBe('failed')
    expect(row?.offboarding?.transferredAt).toBeFalsy()
    expect(report.ok).toBe(false)
  })
})

describe('the run report', () => {
  it('is not ok when a notification could not be delivered, and counts it', async () => {
    // A chat API answering 200 with a failure in the body is what silently
    // stopped several workflows posting for weeks.
    const h = harness({ armed: true, notifier: new CapturingNotifier(false) })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day0).toBe(1)
    expect(report.counts.notificationsFailed).toBeGreaterThan(0)
    expect(report.ok).toBe(false)
    // The work still happened: a failed notification never rolls back a
    // suspension that was read back.
    expect((await h.store.get(LEAVER_ID))?.status).toBe('offboarding')
  })

  it('warns rather than throwing when a selected row has gone by the time it is reached', async () => {
    const h = harness({ armed: true })
    let reads = 0
    const deps = {
      ...h.deps,
      store: delegate(h.store, {
        get: async (hrisId: string) => {
          reads += 1
          return reads === 1 ? null : h.store.get(hrisId)
        },
      }),
    }

    const report = await runLeaverEngine(deps, RUN)

    expect(report.warnings.join(' ')).toContain('could not be read')
    expect(h.calls).toEqual([])
  })

  it('records an error when the store refuses the status change', async () => {
    const h = harness({ armed: true })
    const deps = {
      ...h.deps,
      store: delegate(h.store, {
        transition: async () => ({ ok: false as const, refusal: 'stale_status' as const, reason: 'the row moved' }),
      }),
    }

    const report = await runLeaverEngine(deps, RUN)

    // The account really is suspended, so the run says so and leaves the row
    // to be picked up again: every leg is idempotent, which is what makes
    // that safe.
    expect(report.ok).toBe(false)
    expect(report.errors.join(' ')).toContain('could not be moved to offboarding')
    expect(h.providers.idpAccount(IDP_USER_ID)?.suspended).toBe(true)
  })

  it('reports a parked row without acting on it, even when it is named directly', async () => {
    const h = harness({
      armed: true,
      people: [personFixture({ status: 'offboarding', reviewReason: 'max_leg_attempts', offboarding: { suspendedAt: '2026-02-01', legs: {} } })],
    })
    const report = await runLeaverEngine(h.deps, { ...RUN, phases: ['day7'] })

    expect(report.counts.parked ?? 0).toBe(0)
    expect(h.calls).toEqual([])
  })
})
