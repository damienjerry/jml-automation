/**
 * Failure this prevents: a person renamed on the way out was looked up by
 * their new address only. The old address was gone from the record, so one
 * stage of offboarding found nobody and reported success, while another stage
 * matched a different account entirely.
 *
 * At the store level the rule is narrow: an address a person has ever used is
 * never lost, and a lookup by address returns every row that claims it rather
 * than the first one. Deciding whether a new address means a rename or a
 * genuinely different person is the identity module's job, not the store's.
 */

import { describe, expect, it } from 'vitest'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { samplePerson } from '../../src/store/conformance.ts'

describe('an address that changes', () => {
  it('keeps every previous address on the same row', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson())
    await store.upsert(samplePerson({ primaryEmail: 'jane.doe+exit@example.com' }))
    await store.upsert(samplePerson({ primaryEmail: 'jane.doe@legacy.example.com' }))

    const stored = await store.get('hris-0001')
    expect(stored?.primaryEmail).toBe('jane.doe@legacy.example.com')
    expect(stored?.aliasEmails).toEqual(['jane.doe+exit@example.com', 'jane.doe@example.com'])

    for (const address of ['jane.doe@example.com', 'jane.doe+exit@example.com', 'jane.doe@legacy.example.com']) {
      const found = await store.findByEmail(address)
      expect(found.map((person) => person.hrisId)).toEqual(['hris-0001'])
    }
  })

  it('cannot have its alias history shortened by a patch', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson({ aliasEmails: ['jane.doe@legacy.example.com'] }))

    await store.patch('hris-0001', { aliasEmails: [] })
    await store.patch('hris-0001', { aliasEmails: ['jane.doe+exit@example.com'] })

    const stored = await store.get('hris-0001')
    // Aliases only grow. Shrinking them is what makes a later lookup miss.
    expect(stored?.aliasEmails).toEqual(['jane.doe+exit@example.com', 'jane.doe@legacy.example.com'])
  })

  it('returns both rows when a second person claims an address', async () => {
    const store = new MemoryPeopleStore()
    await store.init()
    await store.upsert(samplePerson())
    await store.upsert(
      samplePerson({
        hrisId: 'hris-0002',
        primaryEmail: 'john.doe@example.com',
        aliasEmails: ['jane.doe@example.com'],
      }),
    )

    // The caller has to see the ambiguity and park the row. Taking the first
    // match is how a suspension lands on a colleague who still works here.
    const found = await store.findByEmail('jane.doe@example.com')
    expect(found.map((person) => person.hrisId)).toEqual(['hris-0001', 'hris-0002'])
  })
})
