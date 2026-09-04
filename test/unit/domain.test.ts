import { describe, expect, it } from 'vitest'
import { createDomainMap } from '../../src/core/domain.ts'

const domain = createDomainMap({ primaryDomain: 'Example.com', aliasDomains: ['legacy.example.com', 'Example.com', ''] })

describe('createDomainMap', () => {
  it('lowercases the configured domains and drops duplicates and blanks', () => {
    expect(domain.primaryDomain).toBe('example.com')
    expect(domain.aliasDomains).toEqual(['legacy.example.com'])
  })

  it('normalises by trimming and lowercasing, and nothing else', () => {
    expect(domain.normalise('  Jane.Doe@Example.com ')).toBe('jane.doe@example.com')
    // Dots and plus tags are NOT folded away. An HR system treats
    // `jane.doe+exit@` as a distinct recorded address, and that rename is the
    // signal the identity rules have to detect.
    expect(domain.normalise('jane.doe+exit@example.com')).toBe('jane.doe+exit@example.com')
  })

  it('knows which addresses are ours', () => {
    expect(domain.isOurs('jane.doe@example.com')).toBe(true)
    expect(domain.isOurs('jane.doe@legacy.example.com')).toBe(true)
    expect(domain.isOurs('jane.doe@example.org')).toBe(false)
  })

  it('expands an address across every domain we own, primary first', () => {
    expect(domain.variants('jane.doe@legacy.example.com')).toEqual(['jane.doe@example.com', 'jane.doe@legacy.example.com'])
  })

  it('leaves an outside address alone', () => {
    expect(domain.variants('someone@example.org')).toEqual(['someone@example.org'])
    expect(domain.canonical('someone@example.org')).toBe('someone@example.org')
    expect(domain.variants('')).toEqual([])
  })

  it('canonicalises an alias-domain address onto the primary domain', () => {
    expect(domain.canonical('Jane.Doe@Legacy.Example.com')).toBe('jane.doe@example.com')
  })

  it('recognises one mailbox across two domains, which is what stops a false mismatch', () => {
    expect(domain.sameMailbox('jane.doe@example.com', 'jane.doe@legacy.example.com')).toBe(true)
    expect(domain.sameMailbox('jane.doe@example.com', 'john.doe@example.com')).toBe(false)
    expect(domain.sameMailbox('jane.doe@example.com', '')).toBe(false)
  })

  it('keeps a plus-addressed leaver distinct from the live address', () => {
    expect(domain.sameMailbox('jane.doe@example.com', 'jane.doe+exit@example.com')).toBe(false)
  })

  it('splits an address on the last @, which some local parts contain', () => {
    expect(domain.localPart('"odd@name"@example.com')).toBe('"odd@name"')
    expect(domain.domainOf('"odd@name"@example.com')).toBe('example.com')
  })
})
