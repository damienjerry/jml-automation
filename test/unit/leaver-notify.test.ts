import { describe, expect, it } from 'vitest'
import type { RunReport } from '../../src/core/types.ts'
import {
  describeLegs,
  notifyBlocked,
  notifyDay0,
  notifyDay6,
  notifyParked,
  notifyRunAborted,
  notifyRunSummary,
  offboardDates,
  runAuditCtx,
} from '../../src/engine/leaver/notify.ts'
import { addDays } from '../../src/core/clock.ts'
import { LEAVER_ID, TODAY, harness, personFixture } from '../fixtures/leaver/harness.ts'

const ACTOR = { kind: 'system' as const, id: 'system:leaver-engine' }

function ctxFor(person = personFixture({ offboarding: { suspendedAt: TODAY, legs: {} } }), dryRun = false) {
  return { person, runId: 'run-1', actor: ACTOR, dryRun }
}

const DONE_LEGS = [
  { name: 'suspend_idp' as const, record: { state: 'done' as const, verified: true, attempts: 1 }, note: 'account suspended' },
]

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-1',
    kind: 'pipeline',
    startedAt: `${TODAY}T09:00:00.000Z`,
    finishedAt: `${TODAY}T09:00:10.000Z`,
    dryRun: false,
    ok: true,
    counts: { day0: 1, blocked: 0 },
    people: [],
    warnings: [],
    errors: [],
    ...overrides,
  }
}

describe('the dated milestones', () => {
  it('are derived from the day-0 marker, not from today', () => {
    const person = personFixture({ offboarding: { suspendedAt: '2026-02-20', legs: {} } })
    const dates = offboardDates(person, harness().deps, TODAY)
    expect(dates.suspendedOn).toBe('2026-02-20')
    expect(dates.transferOn).toBe(addDays('2026-02-20', 6))
    expect(dates.deleteOn).toBe(addDays('2026-02-20', 7))
  })
})

describe('the steps list in a note', () => {
  it('names each step and what it did, in the order they ran', () => {
    expect(describeLegs(DONE_LEGS)).toBe('- suspend_idp: account suspended')
    // A note with nothing in it would read as a step list that failed to
    // render, so the empty case says what it means.
    expect(describeLegs([])).toBe('- nothing to do')
  })
})

describe('the day-0 notes', () => {
  it('go to the manager and to IT', async () => {
    const h = harness()
    const result = await notifyDay0(h.deps, ctxFor(), DONE_LEGS, TODAY)

    expect(result.delivered).toBe(true)
    expect(h.notifier.sent.map((n) => n.audience)).toEqual(['manager', 'it'])
  })

  it('skip the manager when the adopter has switched that off', async () => {
    const h = harness({ config: { mail: { senderMailbox: 'it-noreply@example.com', managerOnDay0: false } } })
    await notifyDay0(h.deps, ctxFor(), DONE_LEGS, TODAY)
    expect(h.notifier.sent.map((n) => n.audience)).toEqual(['it'])
  })

  it('still address the manager note when the HR record holds no manager', async () => {
    // The fan-out sends it to the IT route and reports it undelivered, which
    // is the honest answer: the person it was for was not told.
    const h = harness()
    const result = await notifyDay0(h.deps, ctxFor(personFixture({ managerEmail: null, offboarding: { suspendedAt: TODAY, legs: {} } })), DONE_LEGS, TODAY)
    expect(result.delivered).toBe(true)
    expect(h.notifier.sent[0]?.managerEmail).toBeNull()
  })

  it('say when a step failed, in the subject as well as the body', async () => {
    const h = harness()
    await notifyDay0(
      h.deps,
      ctxFor(),
      [{ name: 'revoke_licence', record: { state: 'failed', verified: false, attempts: 1 }, note: 'the seat is still assigned' }],
      TODAY,
    )
    const it = h.notifier.sent.find((n) => n.audience === 'it')
    expect(it?.subject).toContain('failed steps')
    expect(it?.body).toContain('the seat is still assigned')
  })
})

describe('the day-6 note', () => {
  it('names the recipient and the deletion date', async () => {
    const h = harness()
    const person = personFixture({
      offboarding: { suspendedAt: TODAY, legs: {}, transferRecipient: 'john.doe@example.com' },
    })
    await notifyDay6(
      h.deps,
      ctxFor(person),
      [{ name: 'transfer_drive', record: { state: 'done', verified: true, attempts: 1 }, note: 'files handed over' }],
      TODAY,
    )
    const sent = h.notifier.sent[0]
    expect(sent?.body).toContain('john.doe@example.com')
    expect(sent?.body).toContain(addDays(TODAY, 7))
  })

  it('says nobody was found rather than leaving the line blank', async () => {
    const h = harness()
    await notifyDay6(h.deps, ctxFor(), [], TODAY)
    expect(h.notifier.sent[0]?.body).toContain('nobody yet')
  })
})

describe('the blocked note', () => {
  it('says nothing at all when the gate is open', async () => {
    const h = harness()
    const result = await notifyBlocked(h.deps, ctxFor(), { open: true, detail: 'clear' })
    expect(result.delivered).toBe(true)
    expect(h.notifier.sent).toEqual([])
  })

  it('carries the reason when there are no machines to name', async () => {
    const h = harness()
    await notifyBlocked(h.deps, ctxFor(), {
      open: false,
      reason: 'gate_error',
      detail: 'the bound-device list could not be read',
    })
    expect(h.notifier.sent[0]?.body).toContain('could not be read')
    expect(h.notifier.sent[0]?.subject).toContain('gate_error')
  })

  it('goes quiet on the second run and explains why in the result', async () => {
    const h = harness()
    const gate = { open: false as const, reason: 'gate_error' as const, detail: 'unreadable' }
    await notifyBlocked(h.deps, ctxFor(), gate)
    const second = await notifyBlocked(h.deps, ctxFor(), gate)

    expect(h.notifier.sent).toHaveLength(1)
    // The silence is explained, so a reader of the report can tell it from a
    // resolved problem.
    expect(second.reasons.join(' ')).toContain('unchanged')
  })
})

describe('the parked note', () => {
  it('is sent once per reason', async () => {
    const h = harness()
    await notifyParked(h.deps, ctxFor(), 'max_leg_attempts', 'release it with the CLI')
    await notifyParked(h.deps, ctxFor(), 'max_leg_attempts', 'release it with the CLI')
    expect(h.notifier.sent).toHaveLength(1)
    expect(h.notifier.sent[0]?.body).toContain('release it with the CLI')
  })

  it('is sent again when the reason changes', async () => {
    const h = harness()
    await notifyParked(h.deps, ctxFor(), 'max_leg_attempts', 'hint one')
    await notifyParked(h.deps, ctxFor(), 'identity_claimed_by_live_person', 'hint two')
    expect(h.notifier.sent).toHaveLength(2)
  })
})

describe('the run notes', () => {
  it('summarise the counts, and say plainly when a run had failures', async () => {
    const h = harness()
    const ctx = runAuditCtx('run-1', ACTOR, false)
    await notifyRunSummary(h.deps, ctx, report({ ok: false, warnings: ['one thing'], errors: ['another thing'] }))

    const sent = h.notifier.sent[0]
    expect(sent?.subject).toContain('with failures')
    expect(sent?.body).toContain('FINISHED WITH FAILURES')
    expect(sent?.body).toContain('one thing')
    expect(sent?.body).toContain('another thing')
  })

  it('say there is nothing else to report rather than leaving a blank section', async () => {
    const h = harness()
    await notifyRunSummary(h.deps, runAuditCtx('run-1', ACTOR, false), report())
    expect(h.notifier.sent[0]?.body).toContain('Nothing else to report')
  })

  it('mark a rehearsal, and never suppress it', async () => {
    const h = harness()
    await notifyRunSummary(h.deps, runAuditCtx('run-1', ACTOR, true), report({ dryRun: true }))
    expect(h.notifier.sent[0]?.subject).toContain('[DRY RUN]')
  })

  it('name the abort reason where a reader will see it', async () => {
    const h = harness()
    await notifyRunAborted(
      h.deps,
      runAuditCtx('run-1', ACTOR, false),
      report({ ok: false, aborted: { reason: 'circuit_breaker', detail: { candidates: 40 } } }),
    )
    expect(h.notifier.sent[0]?.subject).toContain('circuit_breaker')
    expect(h.notifier.sent[0]?.body).toContain('40')
  })
})

describe('a run-level audit subject', () => {
  it('is the run, not a borrowed person', () => {
    const ctx = runAuditCtx('run-7', ACTOR, false)
    expect(ctx.person.hrisId).toBe('run:run-7')
    expect(ctx.person.hrisId).not.toBe(LEAVER_ID)
  })
})
