/**
 * Hold, release, acknowledge and tombstone.
 *
 * These are the manual overrides, and the reason they need tests of their own
 * is that each of them is the answer to the engine refusing to guess. A parked
 * row is excluded from every selection, so if release does not clear both the
 * freeze and the parked reason, the row looks released and is still inert,
 * which is indistinguishable from the automation being broken.
 */

import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../src/core/clock.ts'
import type { Actor, Person } from '../../src/core/types.ts'
import { ackPerson, holdPerson, markActor, releasePerson, tombstonePerson, type MarkDeps } from '../../src/cli/commands/leaver.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { MemoryAuditSink, NOW, personFixture, suspendedPersonFixture } from '../fixtures/leaver/harness.ts'

const HUMAN: Actor = { kind: 'human', id: 'jane.doe@example.com' }

async function deps(people: readonly Person[]): Promise<{ marks: MarkDeps; store: MemoryPeopleStore; audit: MemoryAuditSink }> {
  const clock = new FakeClock(NOW)
  const store = new MemoryPeopleStore({ seed: people, clock })
  await store.init()
  const audit = new MemoryAuditSink()
  return { marks: { store, audit, clock }, store, audit }
}

describe('hold', () => {
  it('freezes the row and records who asked and why', async () => {
    const { marks, audit } = await deps([personFixture()])
    const person = await holdPerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN, reason: 'HR are checking the leaving date' })

    expect(person.hold).toBe(true)
    expect(person.holdReason).toBe('HR are checking the leaving date')
    // An intent row and an outcome row, the same discipline as a provider
    // call: one row written afterwards cannot describe a write that failed.
    expect(audit.trail()).toEqual(['intent human.hold', 'outcome human.hold'])
    expect(audit.events[0]?.actor.id).toBe('jane.doe@example.com')
    expect(audit.events[0]?.detail?.reason).toBe('HR are checking the leaving date')
  })

  it('refuses without a reason', async () => {
    const { marks, audit } = await deps([personFixture()])
    await expect(holdPerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN })).rejects.toThrow(/needs a reason/)
    // Nothing was recorded, because nothing happened.
    expect(audit.events).toEqual([])
  })

  it('refuses on an HR id that does not exist rather than creating a row', async () => {
    const { marks, store } = await deps([personFixture()])
    await expect(holdPerson(marks, { hrisId: 'hr-nobody', actor: HUMAN, reason: 'typo' })).rejects.toThrow(/no person with HR id/)
    expect(await store.get('hr-nobody')).toBeNull()
  })
})

describe('release', () => {
  it('clears the freeze and the parked reason in one write', async () => {
    const { marks } = await deps([
      personFixture({ hold: true, holdReason: 'waiting on HR', reviewReason: 'termination_older_than_lookback' }),
    ])
    const person = await releasePerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN, note: 'confirmed a genuine leaver' })

    expect(person.hold).toBe(false)
    expect(person.holdReason).toBeNull()
    // Both, together. Clearing one and leaving the other gives a row that
    // reads as released and is still excluded from every selection.
    expect(person.reviewReason).toBeNull()
    expect(person.note).toBe('confirmed a genuine leaver')
  })

  it('records the reason the row had been parked for, so the decision is answerable', async () => {
    const { marks, audit } = await deps([personFixture({ reviewReason: 'no_transfer_recipient' })])
    await releasePerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN })
    expect(audit.events[0]?.detail?.previousReviewReason).toBe('no_transfer_recipient')
  })
})

describe('acknowledge', () => {
  it('records the person who agreed, without disturbing the day-0 marker', async () => {
    const { marks } = await deps([suspendedPersonFixture('2026-02-25')])
    const person = await ackPerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN, note: 'checked with the manager' })

    expect(person.offboarding?.operatorAck?.by).toBe('jane.doe@example.com')
    expect(person.offboarding?.operatorAck?.note).toBe('checked with the manager')
    // The marker is what stops day 0 running twice, so an acknowledgement
    // must carry it through rather than replacing the record.
    expect(person.offboarding?.suspendedAt).toBe('2026-02-25')
    expect(person.offboarding?.legs?.suspend_idp?.state).toBe('done')
  })
})

describe('tombstone', () => {
  it('closes a terminated row without touching an account', async () => {
    const { marks, audit } = await deps([personFixture()])
    const person = await tombstonePerson(marks, {
      hrisId: personFixture().hrisId,
      actor: HUMAN,
      reason: 'left in 2019, accounts closed by hand at the time',
    })

    expect(person.status).toBe('departed')
    expect(person.offboarding?.departedAt).toBe('2026-03-03')
    expect(person.note).toContain('left in 2019')
    expect(audit.trail()).toEqual(['intent human.tombstone', 'outcome human.tombstone'])
  })

  it('refuses on a row that is already a tombstone, and records the refusal', async () => {
    const { marks, audit } = await deps([personFixture({ status: 'departed' })])
    await expect(
      tombstonePerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN, reason: 'again' }),
    ).rejects.toThrow(/refused/)

    // The failure is in the log as an outcome row, not missing from it.
    expect(audit.trail()).toEqual(['intent human.tombstone', 'outcome human.tombstone'])
    expect(audit.events[1]?.ok).toBe(false)
  })

  it('refuses without a reason, because it is a permanent decision', async () => {
    const { marks } = await deps([personFixture()])
    await expect(tombstonePerson(marks, { hrisId: personFixture().hrisId, actor: HUMAN })).rejects.toThrow(/needs a reason/)
  })
})

describe('who a manual override is recorded as', () => {
  const io = { out: () => undefined, err: () => undefined, cwd: '.', env: { USER: 'local-account' } }

  it('names the person when they say who they are', () => {
    expect(markActor({ actor: 'jane.doe@example.com' }, io)).toEqual({ kind: 'human', id: 'jane.doe@example.com' })
  })

  it('falls back to the local account, still as a person', () => {
    // These commands can only be run by somebody typing them, so recording a
    // system actor would be untrue, and an audit row naming nobody cannot be
    // followed up.
    expect(markActor({}, io)).toEqual({ kind: 'human', id: 'cli:local-account' })
  })

  it('says so plainly when even that is unavailable', () => {
    expect(markActor({}, { ...io, env: {} })).toEqual({ kind: 'human', id: 'cli:unknown' })
  })
})
