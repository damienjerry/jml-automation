import { describe, expect, it } from 'vitest'
import { autoReplyValues, DAY0_LEGS, DAY6_LEGS, DAY7_LEGS, isArmed } from '../../src/engine/leaver/legs.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { transferCutoff } from '../../src/engine/leaver/select.ts'
import {
  IDP_USER_ID,
  LEAVER_EMAIL,
  LEAVER_ID,
  MANAGER_EMAIL,
  MemoryAuditSink,
  PRODUCT,
  SKU,
  TODAY,
  harness,
  leaverConfig,
  personFixture,
  suspendedPersonFixture,
} from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }

describe('the leg tables', () => {
  it('run in the order the days depend on', () => {
    // The sign-out comes last on day 0: the licence is already gone by then, so
    // what it closes is the account as an identity for other apps.
    expect(DAY0_LEGS.map((l) => l.name)).toEqual(['suspend_idp', 'set_autoreply', 'revoke_licence', 'signout_google'])
    // The hand-over comes before the Google suspension: suspending first is
    // harmless, but a transfer that has not started when the account closes
    // needs a person either way, so the file step goes first.
    expect(DAY6_LEGS.map((l) => l.name)).toEqual(['transfer_drive', 'suspend_google'])
    expect(DAY7_LEGS.map((l) => l.name)).toEqual(['delete_idp', 'delete_google'])
  })

  it('names the armed action each one needs', () => {
    expect(DAY0_LEGS.map((l) => l.action)).toEqual(['suspend', 'autoreply', 'licence', 'google_signout'])
    expect(DAY7_LEGS.every((l) => l.action === 'delete')).toBe(true)
  })
})

describe('arming', () => {
  it('needs both armed mode and the action named', () => {
    expect(isArmed(leaverConfig(), 'suspend')).toBe(false)
    expect(isArmed(leaverConfig({}, ['suspend']), 'suspend')).toBe(true)
    // One switch that arms everything is how a rehearsal becomes a mass
    // suspension, so an action absent from the list is declined.
    expect(isArmed(leaverConfig({}, ['suspend']), 'delete')).toBe(false)
  })
})

describe('a step whose intent cannot be recorded', () => {
  it('does not happen at all', async () => {
    // Without the log there is no record of what a destructive step did, so
    // the step is refused rather than run unrecorded.
    const refusing = new MemoryAuditSink((event) => event.action === 'leaver.day0.suspend_idp' && event.phase === 'intent')
    const h = harness({ armed: true, audit: refusing })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(h.calls).not.toContain(`idp.suspendUser(${IDP_USER_ID})`)
    expect(h.providers.idpAccount(IDP_USER_ID)?.suspended).toBeFalsy()
    expect(report.ok).toBe(false)
    // The whole run stops rather than one person: the people after this one
    // would be acted on unrecorded too.
    expect(report.aborted?.reason).toBe('audit_unavailable')
    expect((await h.store.get(LEAVER_ID))?.status).toBe('terminated')
    // Somebody is told, or an abort looks exactly like a quiet day.
    expect(h.notifier.kinds()).toContain('run.aborted')
  })
})

describe('a run whose audit log is dead altogether', () => {
  it('still returns a report, because that is the only carrier left', async () => {
    // The notifier records its own audit rows, so a completely unwritable log
    // takes the abort announcement down with it. The report is built before
    // anything is sent for exactly this case.
    const dead = new MemoryAuditSink(() => true)
    const h = harness({ armed: true, audit: dead })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.aborted?.reason).toBe('audit_unavailable')
    expect(report.warnings.join(' ')).toContain('could not be announced')
    expect(h.calls).not.toContain(`idp.suspendUser(${IDP_USER_ID})`)
  })
})

describe('releasing licences', () => {
  it('lists what the person holds rather than assuming one product', async () => {
    const h = harness({
      armed: true,
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
        google: [
          {
            id: 'goog-leaver-1',
            email: LEAVER_EMAIL,
            licences: [
              { productId: PRODUCT, skuId: SKU },
              { productId: PRODUCT, skuId: 'sku-extra' },
            ],
          },
        ],
      },
    })
    await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('google.revokeLicence'))).toEqual([
      `google.revokeLicence(${LEAVER_EMAIL},${SKU})`,
      `google.revokeLicence(${LEAVER_EMAIL},sku-extra)`,
    ])
    expect(h.providers.googleAccount(LEAVER_EMAIL)?.licences).toEqual([])
  })

  it('revokes only the named SKUs when a list is configured', async () => {
    const h = harness({
      armed: true,
      config: { leaver: { revokeLicences: [SKU] } },
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
        google: [
          {
            id: 'goog-leaver-1',
            email: LEAVER_EMAIL,
            licences: [
              { productId: PRODUCT, skuId: SKU },
              { productId: PRODUCT, skuId: 'sku-free' },
            ],
          },
        ],
      },
    })
    await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('google.revokeLicence'))).toEqual([
      `google.revokeLicence(${LEAVER_EMAIL},${SKU})`,
    ])
  })

  it('records a seat that was already free as already absent, not as work done', async () => {
    // So the audit can still answer "did this run release a licence" long
    // afterwards.
    const h = harness({
      armed: true,
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
        google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL, licences: [] }],
      },
    })
    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.offboarding?.legs?.revoke_licence).toMatchObject({
      state: 'already_absent',
      verified: true,
    })
  })

  it('fails the leg when the licence list cannot be read', async () => {
    const h = harness({ armed: true })
    h.providers.fault('google.listLicences', { kind: 'error' })
    await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.offboarding?.legs?.revoke_licence?.state).toBe('failed')
  })
})

describe('deleting an account that is already gone', () => {
  it('is recorded as already absent and still closes the row', async () => {
    const due = '2026-02-24'
    const h = harness({
      armed: true,
      people: [
        suspendedPersonFixture(due, {
          offboarding: {
            suspendedAt: due,
            legs: {},
            transferredAt: `${TODAY}T08:00:00.000Z`,
            transferRecipient: MANAGER_EMAIL,
          },
          externalIds: {},
          googleAccountPresent: false,
        }),
      ],
      seed: { idp: [], google: [] },
    })

    const report = await runLeaverEngine(h.deps, RUN)

    expect(report.counts.day7).toBe(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('departed')
    expect(row?.offboarding?.legs?.delete_idp).toMatchObject({ state: 'already_absent', verified: true })
    expect(row?.offboarding?.legs?.delete_google).toMatchObject({ state: 'already_absent', verified: true })
    // Nothing was deleted by us, and the record says so rather than claiming
    // the work: a 404 masked as success is how a log stopped being able to
    // answer what a run had actually done.
    expect(h.calls.some((c) => c.startsWith('idp.deleteUser'))).toBe(false)
    expect(h.calls.some((c) => c.startsWith('google.deleteUser'))).toBe(false)
  })
})

describe('the hand-over poll', () => {
  it('is bounded, so a run cannot outlive its own lease waiting', async () => {
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(transferCutoff(TODAY, leaverConfig()))],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
        google: [
          { id: 'goog-leaver-1', email: LEAVER_EMAIL },
          { id: 'goog-manager-1', email: MANAGER_EMAIL },
        ],
        transferStates: ['inProgress'],
      },
    })

    await runLeaverEngine(h.deps, RUN)

    // Eight rounds of fifteen seconds is the two-minute cap, well inside the
    // fifteen-minute lease.
    expect(h.slept.length).toBeLessThanOrEqual(8)
    expect(h.slept.every((ms) => ms === 15_000)).toBe(true)
    expect(h.calls.filter((c) => c.startsWith('google.getTransferStatus')).length).toBeLessThanOrEqual(8)
  })

  it('stops polling as soon as the provider says it finished', async () => {
    const h = harness({
      armed: true,
      people: [suspendedPersonFixture(transferCutoff(TODAY, leaverConfig()))],
      seed: {
        idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
        google: [
          { id: 'goog-leaver-1', email: LEAVER_EMAIL },
          { id: 'goog-manager-1', email: MANAGER_EMAIL },
        ],
        transferStates: ['completed'],
      },
    })
    await runLeaverEngine(h.deps, RUN)
    expect(h.slept).toEqual([])
  })
})

describe('the auto-reply values', () => {
  it('name the manager by address, because the row holds no manager name', () => {
    const values = autoReplyValues(leaverConfig(), personFixture())
    expect(values.managerEmail).toBe(MANAGER_EMAIL)
    expect(values.managerName).toBe(MANAGER_EMAIL)
    expect(values.orgName).toBe('Example Organisation')
  })

  it('fall back to the sending mailbox when the HR record has no manager', () => {
    // Rendering would throw on an empty value, and a responder that never
    // goes on is worse than one naming the IT mailbox.
    const values = autoReplyValues(leaverConfig(), personFixture({ managerEmail: null }))
    expect(values.managerEmail).toBe('it-noreply@example.com')
  })
})
