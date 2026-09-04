/**
 * Failure this prevents: a sync that wrote every field on every run erased
 * values a person had entered by hand, because the HR system carried nothing
 * for those fields. The same unconditional write also made every run look like
 * a change, so the change-only alerting downstream fired constantly and was
 * muted, and the audit log stopped recording anything meaningful.
 *
 * Two rules, one write path: diff before writing, and never let a blank
 * incoming value overwrite a populated stored one.
 */

import { describe, expect, it } from 'vitest'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { samplePerson } from '../../src/store/conformance.ts'

describe('a sync run with nothing new to say', () => {
  it('writes nothing at all, twenty runs in a row', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson())
    const afterFirst = store.writes

    for (let run = 0; run < 20; run += 1) {
      const result = await store.upsert(samplePerson())
      expect(result.changed).toBe(false)
    }

    expect(store.writes).toBe(afterFirst)
  })

  it('leaves hand-entered values alone when the HR record is blank', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson())
    // Somebody filled these in by hand because the HR system does not hold
    // them.
    await store.patch('hris-0001', { note: 'Shared site account, do not offboard automatically' })
    await store.upsert(samplePerson({ site: 'Depot' }))

    await store.upsert(
      samplePerson({ site: null, department: '', jobTitle: undefined, managerEmail: '   ' }),
    )

    const stored = await store.get('hris-0001')
    expect(stored?.site).toBe('Depot')
    expect(stored?.department).toBe('Operations')
    expect(stored?.jobTitle).toBe('Analyst')
    expect(stored?.managerEmail).toBe('john.doe@example.com')
    expect(stored?.note).toBe('Shared site account, do not offboard automatically')
  })

  it('does write a real change, so this is not just a store that ignores updates', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson())
    const result = await store.upsert(samplePerson({ managerEmail: 'jane.doe@example.com' }))
    expect(result.changed).toBe(true)
    expect(result.changedFields).toEqual(['managerEmail'])
  })
})
