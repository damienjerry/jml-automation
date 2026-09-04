/**
 * The shared write guard, tested directly.
 *
 * The conformance suite proves the behaviour through each adapter. This file
 * covers the field-ownership rules, which are easier to read at the level of
 * the guard itself.
 */

import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  guardTransition,
  HRIS_OWNED_FIELDS,
  mergeHrisFields,
  normaliseNewPerson,
  StoreWriteRefused,
} from '../../src/store/transitions-guard.ts'
import { samplePerson } from '../../src/store/conformance.ts'

const AT = '2026-03-31T09:00:00.000Z'

describe('what the HR sync is allowed to write', () => {
  it('lists only fields the HR system owns', () => {
    // An allowlist, so a field added to Person later is off limits to the
    // sync until somebody decides otherwise. A denylist gets forgotten, and
    // the sync then starts carrying account ids and stop switches with it.
    for (const field of ['status', 'hold', 'reviewReason', 'externalIds', 'offboarding', 'note'] as const) {
      expect(HRIS_OWNED_FIELDS).not.toContain(field)
    }
  })

  it('ignores every field it does not own, even when the incoming record sets one', () => {
    const stored = normaliseNewPerson(
      samplePerson({ hold: true, holdReason: 'A person is looking at this', note: 'hand written' }),
      AT,
    )
    const incoming = samplePerson({
      hold: false,
      holdReason: null,
      note: 'overwritten by a sync',
      reviewReason: 'identity_mismatch',
      externalIds: { jumpcloudUserId: 'jc-user-1' },
      department: 'Engineering',
    })

    const decision = mergeHrisFields(stored, incoming, AT)

    expect(decision.changedFields).toEqual(['department'])
    expect(decision.merged.hold).toBe(true)
    expect(decision.merged.note).toBe('hand written')
    expect(decision.merged.reviewReason).toBeNull()
    expect(decision.merged.externalIds).toEqual({})
  })

  it('does not touch the timestamp when nothing changed', () => {
    const stored = normaliseNewPerson(samplePerson(), AT)
    const decision = mergeHrisFields(stored, samplePerson(), '2026-04-01T09:00:00.000Z')
    expect(decision.changed).toBe(false)
    expect(decision.merged.updatedAt).toBe(AT)
  })
})

describe('an explicit patch', () => {
  it('is literal: undefined leaves a field alone, null clears it', () => {
    const stored = normaliseNewPerson(samplePerson({ department: 'Operations', site: 'Head office' }), AT)
    const decision = applyPatch(stored, { department: undefined, site: null }, AT)
    expect(decision.merged.department).toBe('Operations')
    expect(decision.merged.site).toBeNull()
    expect(decision.changedFields).toEqual(['site'])
  })

  it('refuses to write a status or a different HR id', () => {
    const stored = normaliseNewPerson(samplePerson(), AT)
    expect(() => applyPatch(stored, { status: 'departed' }, AT)).toThrow(StoreWriteRefused)
    expect(() => applyPatch(stored, { hrisId: 'hris-0002' }, AT)).toThrow(StoreWriteRefused)
  })

  it('reports no change when the patch says what is already stored', () => {
    const stored = normaliseNewPerson(samplePerson(), AT)
    expect(applyPatch(stored, { department: 'Operations', hold: false }, AT).changed).toBe(false)
  })
})

describe('the transition guard', () => {
  it('writes the patch and the status together, and records the caller reason', () => {
    const stored = normaliseNewPerson(samplePerson({ status: 'terminated' }), AT)
    const outcome = guardTransition(
      stored,
      {
        hrisId: stored.hrisId,
        expectFrom: 'terminated',
        event: 'engine.phantom_departed',
        owner: 'engine',
        patch: { externalIds: { jumpcloudUserId: null } },
        reason: 'No account exists anywhere for this person.',
      },
      AT,
    )

    expect(outcome.allowed).toBe(true)
    if (!outcome.allowed) return
    expect(outcome.merged.status).toBe('departed')
    expect(outcome.merged.externalIds.jumpcloudUserId).toBeNull()
    expect(outcome.merged.note).toBe('No account exists anywhere for this person.')
  })

  it('refuses rather than throwing when the row is not there', () => {
    const outcome = guardTransition(
      null,
      { hrisId: 'hris-absent', expectFrom: 'terminated', event: 'engine.day0_suspended', owner: 'engine' },
      AT,
    )
    expect(outcome).toMatchObject({ allowed: false, refusal: 'stale_status' })
  })
})
