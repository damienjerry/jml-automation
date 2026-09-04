/**
 * Email addresses and the domains an organisation owns.
 *
 * This is the only place addresses are normalised. It exists as one module
 * because the automation this replaces had the logic three times, and the
 * copies disagreed: one lowercased, one did not, and none of them knew about
 * the second domain. A tenant with a primary domain and an alias domain
 * therefore keyed the same person differently in different systems, and every
 * reconciliation reported an identity mismatch for everybody.
 *
 * One thing this module deliberately does NOT do is strip dots or
 * plus-addresses. Some providers treat those as the same mailbox, but an HR
 * system does not: a leaver renamed to `local+exit@` is a distinct recorded
 * address, and that rename is the signal a later module has to detect. Folding
 * it away here would hide it.
 */

export interface DomainMapConfig {
  primaryDomain: string
  aliasDomains?: readonly string[]
}

export interface DomainMap {
  readonly primaryDomain: string
  readonly aliasDomains: readonly string[]
  /** Trim and lowercase. Nothing else. */
  normalise(email: string): string
  localPart(email: string): string
  domainOf(email: string): string
  /** True when the address is on a domain this organisation owns. */
  isOurs(email: string): boolean
  /**
   * The same local part on every domain we own, primary first.
   * An address on a domain we do not own returns just itself.
   */
  variants(email: string): string[]
  /** The primary-domain form. The key two systems can be compared on. */
  canonical(email: string): string
  /** True when two addresses are the same mailbox across our domains. */
  sameMailbox(a: string, b: string): boolean
}

export function createDomainMap(config: DomainMapConfig): DomainMap {
  const primaryDomain = config.primaryDomain.trim().toLowerCase()
  const aliasDomains = [...new Set((config.aliasDomains ?? []).map((d) => d.trim().toLowerCase()))].filter(
    (d) => d !== '' && d !== primaryDomain,
  )
  const owned = new Set([primaryDomain, ...aliasDomains])

  const normalise = (email: string): string => (email ?? '').trim().toLowerCase()
  const domainOf = (email: string): string => {
    const at = normalise(email).lastIndexOf('@')
    return at < 0 ? '' : normalise(email).slice(at + 1)
  }
  const localPart = (email: string): string => {
    const at = normalise(email).lastIndexOf('@')
    return at < 0 ? normalise(email) : normalise(email).slice(0, at)
  }
  const isOurs = (email: string): boolean => owned.has(domainOf(email))

  return {
    primaryDomain,
    aliasDomains,
    normalise,
    localPart,
    domainOf,
    isOurs,
    variants(email) {
      const address = normalise(email)
      if (!isOurs(address)) return address === '' ? [] : [address]
      const local = localPart(address)
      return [primaryDomain, ...aliasDomains].map((d) => local + '@' + d)
    },
    canonical(email) {
      const address = normalise(email)
      return isOurs(address) ? localPart(address) + '@' + primaryDomain : address
    },
    sameMailbox(a, b) {
      const left = normalise(a)
      const right = normalise(b)
      if (left === '' || right === '') return false
      return this.canonical(left) === this.canonical(right)
    },
  }
}
