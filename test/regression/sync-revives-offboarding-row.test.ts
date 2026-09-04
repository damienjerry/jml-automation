/**
 * Failure this prevents: the HR sync writing a status onto a row the
 * offboarding engine owns. A person mid-offboarding was flipped back to
 * employed by a sync that had simply read them from a full history export, and
 * a tombstone was reopened the same way. The engine then had two runs
 * disagreeing about whether the same accounts should exist.
 *
 * The store answers this rather than the sync: the transition table has no
 * edge out of `offboarding` for an HR event, and none at all out of
 * `departed`, so the refusal happens on the write and not in whichever caller
 * remembered to check.
 */

import { describe, expect, it } from 'vitest'
import { PRESERVED_BY_SYNC } from '../../src/core/transitions.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { samplePerson } from '../../src/store/conformance.ts'

describe('a sync reading a full history', () => {
  it('cannot move a row the engine owns, whatever the HR system says', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson())
    await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
    await store.transition({
      hrisId: 'hris-0001',
      expectFrom: 'terminated',
      event: 'engine.day0_suspended',
      owner: 'engine',
      patch: { offboarding: { suspendedAt: '2026-03-31', legs: {} } },
    })
    expect(PRESERVED_BY_SYNC).toContain('offboarding')

    for (const event of ['hris.active', 'hris.hired', 'hris.terminated'] as const) {
      const result = await store.transition({
        hrisId: 'hris-0001',
        expectFrom: 'offboarding',
        event,
        owner: 'sync',
      })
      expect(result).toMatchObject({ ok: false, refusal: 'illegal_transition' })
    }
    expect((await store.get('hris-0001'))?.status).toBe('offboarding')
  })

  it('cannot reopen a tombstone', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson({ status: 'departed' }))
    expect(PRESERVED_BY_SYNC).toContain('departed')

    const result = await store.transition({
      hrisId: 'hris-0001',
      expectFrom: 'departed',
      event: 'hris.active',
      owner: 'sync',
    })
    // Somebody genuinely returning is a new HR record, which means a new id
    // and a new row. Reviving this one would inherit its account history.
    expect(result).toMatchObject({ ok: false, refusal: 'illegal_transition' })
    expect((await store.get('hris-0001'))?.status).toBe('departed')
  })

  it('may still patch the names and departments on such a row', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson({ status: 'departed' }))
    const result = await store.upsert(samplePerson({ status: 'active', department: 'Engineering' }))
    expect(result.changedFields).toEqual(['department'])
    expect(result.person.status).toBe('departed')
  })
})
