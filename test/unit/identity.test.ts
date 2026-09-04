import { describe, expect, it } from 'vitest'
import type { LifecycleStatus, Person } from '../../src/core/types.ts'
import { createDomainMap } from '../../src/core/domain.ts'
import {
  canonicalAddresses,
  claimedByLivePerson,
  classifyEmailChange,
  createIdentityRules,
  idClaimedByLivePerson,
  isExitRename,
  knownAddresses,
  matchPerson,
  plusTag,
  withAlias,
} from '../../src/core/identity.ts'

const domain = createDomainMap({ primaryDomain: 'example.com', aliasDomains: ['legacy.example.com'] })
const rules = createIdentityRules(domain, ['\\+(exit|leaver)@'])

function person(overrides: Partial<Person> & { hrisId: string; primaryEmail: string }): Person {
  return {
    status: 'active' as LifecycleStatus,
    aliasEmails: [],
    displayName: overrides.primaryEmail,
    hold: false,
    externalIds: {},
    ...overrides,
  }
}

describe('createIdentityRules', () => {
  it('rejects an unusable pattern at start-up rather than at match time', () => {
    expect(() => createIdentityRules(domain, ['('])).toThrow(/invalid regular expression/)
  })
})

describe('exit-rename detection', () => {
  it('matches the configured pattern, case-insensitively', () => {
    expect(isExitRename('jane.doe+exit@example.com', rules)).toBe(true)
    expect(isExitRename('JANE.DOE+LEAVER@EXAMPLE.COM', rules)).toBe(true)
    expect(isExitRename('jane.doe@example.com', rules)).toBe(false)
  })

  it('reports a plus tag rather than folding it away', () => {
    expect(plusTag('jane.doe+exit@example.com')).toBe('exit')
    expect(plusTag('jane.doe@example.com')).toBeNull()
  })
})

describe('classifyEmailChange', () => {
  const base = { previousEmail: 'jane.doe@example.com', rules }

  it('calls an alias-domain form of the same mailbox an alias', () => {
    const out = classifyEmailChange({ ...base, newEmail: 'jane.doe@legacy.example.com', hasTerminationDate: false })
    expect(out.kind).toBe('alias')
  })

  it('calls an exit-pattern address an alias even with no leaving date yet', () => {
    const out = classifyEmailChange({ ...base, newEmail: 'jane.doe+exit@example.com', hasTerminationDate: false })
    expect(out.kind).toBe('alias')
  })

  it('calls any change on somebody with a leaving date an alias', () => {
    const out = classifyEmailChange({ ...base, newEmail: 'j.doe.old@example.com', hasTerminationDate: true })
    expect(out.kind).toBe('alias')
  })

  it('calls a change with no leaving date and no pattern a new identity', () => {
    const out = classifyEmailChange({ ...base, newEmail: 'john.roe@example.com', hasTerminationDate: false })
    expect(out.kind).toBe('new_identity')
  })

  it('treats a blank incoming address as no change, because a blank never erases', () => {
    expect(classifyEmailChange({ ...base, newEmail: '', hasTerminationDate: false }).kind).toBe('unchanged')
  })

  it('treats the same address as no change, whatever its case', () => {
    expect(classifyEmailChange({ ...base, newEmail: 'Jane.Doe@Example.com', hasTerminationDate: false }).kind).toBe('unchanged')
  })

  it('records the first address we ever see as an alias, not a new identity', () => {
    expect(classifyEmailChange({ previousEmail: '', newEmail: 'jane.doe@example.com', hasTerminationDate: false, rules }).kind).toBe('alias')
  })
})

describe('matchPerson', () => {
  const people = [
    person({ hrisId: 'H-1', primaryEmail: 'jane.doe@example.com', aliasEmails: ['j.doe@legacy.example.com'] }),
    person({ hrisId: 'H-2', primaryEmail: 'john.doe@example.com' }),
  ]

  it('joins on the HR id first', () => {
    const out = matchPerson(people, { hrisId: 'H-1', email: 'somebody.else@example.com' }, domain)
    expect(out.basis).toBe('hrisId')
    expect(out.person?.hrisId).toBe('H-1')
  })

  it('falls back to the address when no row carries the id', () => {
    const out = matchPerson(people, { hrisId: 'H-9', email: 'john.doe@example.com' }, domain)
    expect(out.basis).toBe('email')
    expect(out.person?.hrisId).toBe('H-2')
  })

  it('finds a person by an address they used to have', () => {
    const out = matchPerson(people, { hrisId: 'H-9', email: 'j.doe@example.com' }, domain)
    expect(out.basis).toBe('alias')
    expect(out.person?.hrisId).toBe('H-1')
  })

  it('reports ambiguity rather than choosing', () => {
    // Taking the first result once wrote to a different person who happened to
    // share a display name, so this returns no person at all.
    const twins = [person({ hrisId: 'H-3', primaryEmail: 'sam@example.com' }), person({ hrisId: 'H-4', primaryEmail: 'sam@legacy.example.com' })]
    const out = matchPerson(twins, { hrisId: 'H-9', email: 'sam@example.com' }, domain)
    expect(out.person).toBeNull()
    expect(out.ambiguous.map((p) => p.hrisId)).toEqual(['H-3', 'H-4'])
  })

  it('reports ambiguity when two rows share an HR id', () => {
    const dupes = [person({ hrisId: 'H-5', primaryEmail: 'a@example.com' }), person({ hrisId: 'H-5', primaryEmail: 'b@example.com' })]
    expect(matchPerson(dupes, { hrisId: 'H-5' }, domain).ambiguous).toHaveLength(2)
  })

  it('matches nothing when there is nothing to match on', () => {
    expect(matchPerson(people, { hrisId: 'H-9', email: null }, domain).basis).toBe('none')
  })
})

describe('claimedByLivePerson', () => {
  const people = [
    person({ hrisId: 'H-1', primaryEmail: 'jane.doe@example.com', status: 'active' }),
    person({ hrisId: 'H-2', primaryEmail: 'john.doe@example.com', status: 'hired' }),
    person({ hrisId: 'H-3', primaryEmail: 'gone@example.com', status: 'departed' }),
  ]

  it('finds an employed person holding the address', () => {
    expect(claimedByLivePerson('jane.doe@example.com', people, domain)?.hrisId).toBe('H-1')
  })

  it('counts a future joiner as employed', () => {
    expect(claimedByLivePerson('john.doe@example.com', people, domain)?.hrisId).toBe('H-2')
  })

  it('matches across an alias domain, which is where a false negative would come from', () => {
    expect(claimedByLivePerson('jane.doe@legacy.example.com', people, domain)?.hrisId).toBe('H-1')
  })

  it('ignores a tombstoned person', () => {
    expect(claimedByLivePerson('gone@example.com', people, domain)).toBeNull()
  })

  it('does not report a person against their own row', () => {
    expect(claimedByLivePerson('jane.doe@example.com', people, domain, { exceptHrisId: 'H-1' })).toBeNull()
  })

  it('finds a live person by a provider account id as well as by address', () => {
    const withIds = [person({ hrisId: 'H-1', primaryEmail: 'jane.doe@example.com', externalIds: { jumpcloudUserId: 'account-a' } })]
    expect(idClaimedByLivePerson('jumpcloudUserId', 'account-a', withIds)?.hrisId).toBe('H-1')
    expect(idClaimedByLivePerson('jumpcloudUserId', 'account-b', withIds)).toBeNull()
    expect(idClaimedByLivePerson('jumpcloudUserId', '', withIds)).toBeNull()
  })
})

describe('address bookkeeping', () => {
  it('keeps every address a person has used, deduped', () => {
    const p = person({ hrisId: 'H-1', primaryEmail: 'Jane.Doe@example.com', aliasEmails: ['jane.doe@example.com', 'j.doe@legacy.example.com'] })
    expect(knownAddresses(p, domain)).toEqual(['jane.doe@example.com', 'j.doe@legacy.example.com'])
    expect(canonicalAddresses(p, domain)).toEqual(['jane.doe@example.com', 'j.doe@example.com'])
  })

  it('moves the old address into the alias list rather than replacing it', () => {
    // A lookup by the address the provider still holds has to keep working.
    const p = person({ hrisId: 'H-1', primaryEmail: 'jane.doe@example.com' })
    expect(withAlias(p, 'jane.doe+exit@example.com', domain)).toEqual({
      primaryEmail: 'jane.doe+exit@example.com',
      aliasEmails: ['jane.doe@example.com'],
    })
  })

  it('changes nothing on a blank incoming address', () => {
    const p = person({ hrisId: 'H-1', primaryEmail: 'jane.doe@example.com', aliasEmails: ['old@example.com'] })
    expect(withAlias(p, '  ', domain)).toEqual({ primaryEmail: 'jane.doe@example.com', aliasEmails: ['old@example.com'] })
  })
})
