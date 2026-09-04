/**
 * Failure this prevents: the Day-0 marker is the only thing that makes the
 * first stage of offboarding run once. When a row lost it, whether through a
 * partial write, a field being cleared by hand or a sync overwriting the
 * offboarding record, the person was selected again and the whole Day-0 stage
 * ran a second time against accounts it had already changed.
 *
 * The marker is therefore write-once at the store level, and the two other
 * ways it used to disappear are closed here as well.
 */

import { describe, expect, it } from 'vitest'
import { DAY0_SELECTION } from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { StoreWriteRefused } from '../../src/store/transitions-guard.ts'
import { samplePerson } from '../../src/store/conformance.ts'

async function suspendedRow(): Promise<MemoryPeopleStore> {
  const store = new MemoryPeopleStore()
  await store.init()
  await store.upsert(samplePerson())
  await store.transition({ hrisId: 'hris-0001', expectFrom: 'active', event: 'hris.terminated', owner: 'sync' })
  await store.transition({
    hrisId: 'hris-0001',
    expectFrom: 'terminated',
    event: 'engine.day0_suspended',
    owner: 'engine',
    patch: {
      offboarding: {
        suspendedAt: '2026-03-31',
        legs: { suspend_idp: { state: 'done', verified: true, attempts: 1 } },
      },
    },
  })
  return store
}

describe('the Day-0 marker', () => {
  it('keeps the person out of the selection once it is set', async () => {
    const store = await suspendedRow()
    expect(await store.countExact(DAY0_SELECTION)).toBe(0)
  })

  it('cannot be cleared, nor dropped with the record around it', async () => {
    const store = await suspendedRow()
    await expect(
      store.patch('hris-0001', { offboarding: { suspendedAt: null, legs: {} } }),
    ).rejects.toThrow(StoreWriteRefused)
    await expect(store.patch('hris-0001', { offboarding: null })).rejects.toThrow(StoreWriteRefused)
    expect((await store.get('hris-0001'))?.offboarding?.suspendedAt).toBe('2026-03-31')
  })

  it('survives a sync that carries a whole person record with no offboarding data', async () => {
    const store = await suspendedRow()
    // This is the shape that used to wipe it: an HR record has no idea an
    // offboarding record exists, and an unconditional write replaces it.
    await store.upsert(samplePerson({ status: 'active', offboarding: null }))

    const stored = await store.get('hris-0001')
    expect(stored?.offboarding?.suspendedAt).toBe('2026-03-31')
    expect(stored?.status).toBe('offboarding')
    expect(await store.countExact(DAY0_SELECTION)).toBe(0)
  })

  it('survives a later step writing only its own leg result', async () => {
    const store = await suspendedRow()
    await store.patch('hris-0001', {
      offboarding: {
        suspendedAt: '2026-03-31',
        legs: { transfer_drive: { state: 'done', verified: true, attempts: 1 } },
      },
    })
    const legs = (await store.get('hris-0001'))?.offboarding?.legs
    expect(legs?.suspend_idp?.state).toBe('done')
    expect(legs?.transfer_drive?.state).toBe('done')
  })
})
