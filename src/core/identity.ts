/**
 * Deciding who somebody is.
 *
 * The rule the whole toolkit is built on: a person is keyed on the identifier
 * the HR system owns, and an email address is an attribute of that person, not
 * their identity. Every serious incident on record in the automation this was
 * ported from came from breaking that rule in one of two ways.
 *
 * First, an HR system renamed a leaver's address on the way out. The sync saw
 * an unfamiliar address, decided it was a new person, created a row, and that
 * row inherited the provider account ids belonging to somebody who still
 * worked there. When the leaving date passed, the offboarding engine suspended
 * a live colleague's account.
 *
 * Second, a later step looked the provider account up by address alone. After
 * the same rename the lookup found nothing, the deletion silently did nothing,
 * and the row was marked finished anyway.
 *
 * So: join on the HR id first, treat an address change on somebody with a
 * leaving date as an alias on the SAME row, detect the rename pattern
 * explicitly, and refuse to act on an address another employed person holds.
 */

import type { LifecycleStatus, Person } from './types.ts'
import type { DomainMap } from './domain.ts'

/** Statuses that mean somebody still works here. */
export const LIVE_STATUSES: readonly LifecycleStatus[] = ['hired', 'active']

export interface IdentityRules {
  readonly domain: DomainMap
  /** Compiled once at start-up so a bad pattern is a start-up failure. */
  readonly exitRenamePatterns: readonly RegExp[]
}

export function createIdentityRules(domain: DomainMap, patterns: readonly string[]): IdentityRules {
  const compiled = patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error('hris.exitRenamePatterns contains an invalid regular expression (' + pattern + '): ' + reason)
    }
  })
  return { domain, exitRenamePatterns: compiled }
}

/** Every address this person has ever been known by, normalised and deduped. */
export function knownAddresses(person: Person, domain: DomainMap): string[] {
  const all = [person.primaryEmail, ...(person.aliasEmails ?? [])]
    .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
    .map((e) => domain.normalise(e))
  return [...new Set(all)]
}

/** The same, expanded across every domain we own, for comparing two systems. */
export function canonicalAddresses(person: Person, domain: DomainMap): string[] {
  return [...new Set(knownAddresses(person, domain).map((e) => domain.canonical(e)))]
}

/**
 * The `+tag` part of an address, if any.
 *
 * Reported rather than folded away. A plus-address on a leaver is evidence of
 * a rename, and evidence is only useful while it is still visible.
 */
export function plusTag(email: string): string | null {
  const local = email.split('@')[0] ?? ''
  const plus = local.indexOf('+')
  return plus < 0 ? null : local.slice(plus + 1)
}

/** True when the address matches one of the configured exit-rename patterns. */
export function isExitRename(email: string, rules: IdentityRules): boolean {
  const address = rules.domain.normalise(email)
  return rules.exitRenamePatterns.some((pattern) => pattern.test(address))
}

export type EmailChangeKind = 'unchanged' | 'alias' | 'new_identity'

export interface EmailChangeDecision {
  kind: EmailChangeKind
  reason: string
}

/**
 * What an address change on an existing HR row means.
 *
 * Only one answer creates a second identity, and it requires all three of:
 * the new address is not another form of the old one on a domain we own, it
 * does not match an exit-rename pattern, and the person carries no leaving
 * date. Anything else is an alias on the same row.
 *
 * The bias is deliberate and asymmetric. Recording an alias that should have
 * been a new person leaves one row holding two addresses, which a human can
 * see and correct. Creating a person who should have been an alias hands a
 * live colleague's account ids to a row that is about to be offboarded, which
 * nobody sees until the account is suspended.
 */
export function classifyEmailChange(opts: {
  previousEmail: string
  newEmail: string
  hasTerminationDate: boolean
  rules: IdentityRules
}): EmailChangeDecision {
  const { domain } = opts.rules
  const previous = domain.normalise(opts.previousEmail)
  const next = domain.normalise(opts.newEmail)

  if (previous === next) return { kind: 'unchanged', reason: 'the address is the same' }
  if (next === '') return { kind: 'unchanged', reason: 'the incoming address is blank, and a blank never erases what we hold' }
  if (previous === '') return { kind: 'alias', reason: 'we held no address for this person, so this is the first one' }

  if (domain.sameMailbox(previous, next)) {
    return { kind: 'alias', reason: 'the same mailbox on another domain we own' }
  }
  if (isExitRename(next, opts.rules)) {
    return { kind: 'alias', reason: 'the new address matches an exit-rename pattern, so it is the same person on the way out' }
  }
  if (opts.hasTerminationDate) {
    return {
      kind: 'alias',
      reason: 'the address changed on somebody who carries a leaving date, which is what an exit rename looks like',
    }
  }
  return { kind: 'new_identity', reason: 'the address changed with no leaving date and no rename pattern, so the HR id has been reused' }
}

/** Where a candidate was matched, so a caller can tell a strong join from a weak one. */
export type MatchBasis = 'hrisId' | 'email' | 'alias' | 'none'

export interface MatchResult {
  person: Person | null
  basis: MatchBasis
  /**
   * Populated when more than one stored row claims the address. Callers must
   * park rather than choose: taking the first result once wrote to a different
   * person who happened to share a display name.
   */
  ambiguous: Person[]
}

/**
 * Find the stored row for an incoming HR record.
 *
 * HR id first, always. The address is only consulted when no row carries that
 * id, which is how a person whose address changed is still recognised.
 */
export function matchPerson(
  people: readonly Person[],
  candidate: { hrisId: string; email?: string | null },
  domain: DomainMap,
): MatchResult {
  const byId = people.filter((p) => p.hrisId === candidate.hrisId)
  if (byId.length === 1) return { person: byId[0] as Person, basis: 'hrisId', ambiguous: [] }
  if (byId.length > 1) return { person: null, basis: 'none', ambiguous: byId }

  const address = domain.normalise(candidate.email ?? '')
  if (address === '') return { person: null, basis: 'none', ambiguous: [] }
  const wanted = domain.canonical(address)

  const byPrimary = people.filter((p) => domain.canonical(p.primaryEmail) === wanted)
  if (byPrimary.length === 1) return { person: byPrimary[0] as Person, basis: 'email', ambiguous: [] }
  if (byPrimary.length > 1) return { person: null, basis: 'none', ambiguous: byPrimary }

  const byAlias = people.filter((p) => canonicalAddresses(p, domain).includes(wanted))
  if (byAlias.length === 1) return { person: byAlias[0] as Person, basis: 'alias', ambiguous: [] }
  if (byAlias.length > 1) return { person: null, basis: 'none', ambiguous: byAlias }

  return { person: null, basis: 'none', ambiguous: [] }
}

/**
 * Is this address held by somebody who still works here?
 *
 * The guard that stops an offboarding row acting on a live colleague's
 * account. Called before every mutating step, not only at sync time, because
 * the row and the account can drift apart between the two.
 *
 * Matching is generous on purpose: it compares canonical forms across every
 * domain we own and every historic address on the row. Over-matching parks a
 * leaver for a human to look at. Under-matching suspends the wrong person.
 */
export function claimedByLivePerson(
  email: string,
  people: readonly Person[],
  domain: DomainMap,
  opts: { exceptHrisId?: string } = {},
): Person | null {
  const wanted = domain.canonical(domain.normalise(email))
  if (wanted === '') return null
  return (
    people.find(
      (p) =>
        p.hrisId !== opts.exceptHrisId &&
        LIVE_STATUSES.includes(p.status) &&
        canonicalAddresses(p, domain).includes(wanted),
    ) ?? null
  )
}

/**
 * Is this provider account id held by somebody who still works here?
 *
 * The same guard, on the other key. An inherited account id is exactly what
 * the exit-rename incident produced, and the address check alone would not
 * have caught it: the row had a new address and somebody else's account id.
 */
export function idClaimedByLivePerson(
  provider: string,
  providerId: string,
  people: readonly Person[],
  opts: { exceptHrisId?: string } = {},
): Person | null {
  if (!providerId) return null
  return (
    people.find(
      (p) => p.hrisId !== opts.exceptHrisId && LIVE_STATUSES.includes(p.status) && p.externalIds?.[provider] === providerId,
    ) ?? null
  )
}

/**
 * Record a new address on a person, keeping the old one.
 *
 * The previous address moves into `aliasEmails` rather than being replaced,
 * so a lookup by the address the provider still holds keeps working. Pure:
 * returns the fields to write.
 */
export function withAlias(person: Person, newEmail: string, domain: DomainMap): { primaryEmail: string; aliasEmails: string[] } {
  const address = domain.normalise(newEmail)
  if (address === '') return { primaryEmail: person.primaryEmail, aliasEmails: [...(person.aliasEmails ?? [])] }
  const aliases = new Set(knownAddresses(person, domain))
  aliases.delete(address)
  return { primaryEmail: address, aliasEmails: [...aliases] }
}
