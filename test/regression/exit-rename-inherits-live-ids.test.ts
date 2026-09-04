/**
 * Prevents: an HR exit-rename becoming a second identity that inherits a live
 * colleague's provider account ids.
 *
 * What happened. An HR system renamed a leaver's work address to a
 * plus-addressed form on the way out. The sync joined on the email address,
 * did not recognise the new one, and took the "the HR id has been reused by a
 * different person" branch. That created a second row, and the row was
 * populated from a provider lookup that matched by address and landed on an
 * employed colleague's account. When the leaving date passed, the offboarding
 * engine suspended that colleague's live account.
 *
 * Three separate guards now have to fail for this to recur, and each is
 * asserted below: the address change is classified as an alias, the join
 * happens on the HR id so there is only ever one row, and the address is
 * checked against every employed person before anything acts on it. The last
 * block runs the real sync over the snapshot that caused it, because the
 * guards being correct in isolation is not the same as the sync using them.
 */

import { describe, expect, it } from 'vitest'
import type { Person } from '../../src/core/types.ts'
import { createDomainMap } from '../../src/core/domain.ts'
import { claimedByLivePerson, classifyEmailChange, createIdentityRules, idClaimedByLivePerson, matchPerson, withAlias } from '../../src/core/identity.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { runSync } from '../../src/engine/sync.ts'
import type { HrisSnapshot } from '../../src/hris/types.ts'

const domain = createDomainMap({ primaryDomain: 'example.com', aliasDomains: ['legacy.example.com'] })
const rules = createIdentityRules(domain, ['\\+(exit|leaver)@'])

/** The employed colleague whose account was suspended. */
const colleague: Person = {
  hrisId: 'HR-COLLEAGUE',
  status: 'active',
  primaryEmail: 'alex.roe@example.com',
  aliasEmails: [],
  displayName: 'Alex Roe',
  hold: false,
  externalIds: { jumpcloudUserId: 'idp-account-alex' },
}

/** The leaver, before the HR system renamed them. */
const leaver: Person = {
  hrisId: 'HR-LEAVER',
  status: 'terminated',
  primaryEmail: 'alex.roebuck@example.com',
  aliasEmails: [],
  displayName: 'Alex Roebuck',
  terminationDate: '2026-09-01',
  hold: false,
  externalIds: { jumpcloudUserId: 'idp-account-roebuck' },
}

const RENAMED_TO = 'alex.roebuck+exit@example.com'

describe('an exit rename on an existing HR row', () => {
  it('is classified as an alias, never as a new identity', () => {
    const decision = classifyEmailChange({
      previousEmail: leaver.primaryEmail,
      newEmail: RENAMED_TO,
      hasTerminationDate: true,
      rules,
    })
    expect(decision.kind).toBe('alias')
  })

  it('is still an alias when the leaving date has not arrived in the feed yet', () => {
    // The rename and the leaving date do not always land in the same snapshot,
    // so the pattern alone has to be enough.
    const decision = classifyEmailChange({
      previousEmail: leaver.primaryEmail,
      newEmail: RENAMED_TO,
      hasTerminationDate: false,
      rules,
    })
    expect(decision.kind).toBe('alias')
  })

  it('joins to the same row on the HR id, so no second row is created', () => {
    const stored = [colleague, leaver]
    const match = matchPerson(stored, { hrisId: 'HR-LEAVER', email: RENAMED_TO }, domain)
    expect(match.basis).toBe('hrisId')
    expect(match.person?.hrisId).toBe('HR-LEAVER')
    expect(match.ambiguous).toEqual([])
  })

  it('keeps the pre-rename address, so a lookup by what the provider holds still works', () => {
    const patch = withAlias(leaver, RENAMED_TO, domain)
    expect(patch.primaryEmail).toBe(RENAMED_TO)
    expect(patch.aliasEmails).toContain('alex.roebuck@example.com')
  })

  it('leaves the colleague unclaimed by the renamed row', () => {
    const stored = [colleague, { ...leaver, primaryEmail: RENAMED_TO, aliasEmails: [leaver.primaryEmail] }]
    expect(claimedByLivePerson(RENAMED_TO, stored, domain, { exceptHrisId: 'HR-LEAVER' })).toBeNull()
  })

  it('refuses the colleague address if a leaver row ever ends up holding it', () => {
    // The last line of defence: whatever put the address on the row, the
    // address belongs to somebody who still works here, so nothing acts on it.
    const stored = [colleague, leaver]
    const claimed = claimedByLivePerson('alex.roe@example.com', stored, domain, { exceptHrisId: 'HR-LEAVER' })
    expect(claimed?.hrisId).toBe('HR-COLLEAGUE')
  })

  it('refuses an inherited provider account id, which the address check alone would miss', () => {
    // In the incident the row carried a NEW address and SOMEBODY ELSE'S
    // account id, so checking the address would have found nothing wrong.
    const stored = [colleague, leaver]
    const claimed = idClaimedByLivePerson('jumpcloudUserId', 'idp-account-alex', stored, { exceptHrisId: 'HR-LEAVER' })
    expect(claimed?.hrisId).toBe('HR-COLLEAGUE')
  })

  it('still allows a genuine HR id reuse to become a new identity', () => {
    // The guard must not swallow the case it was built around: a reused id
    // with a different address, no leaving date and no rename pattern really
    // is a different person.
    const decision = classifyEmailChange({
      previousEmail: colleague.primaryEmail,
      newEmail: 'new.starter@example.com',
      hasTerminationDate: false,
      rules,
    })
    expect(decision.kind).toBe('new_identity')
  })
})

// ---------------------------------------------------------------------------
// The same rename, through the real sync
// ---------------------------------------------------------------------------

/** The snapshot as it arrived: the leaver renamed, the colleague still there. */
const AFTER_THE_RENAME: HrisSnapshot = {
  all: [
    { hrisId: 'HR-LEAVER', primaryEmail: RENAMED_TO, displayName: 'Alex Roebuck', terminationDate: '2026-09-01' },
    { hrisId: 'HR-COLLEAGUE', primaryEmail: 'alex.roe@example.com', displayName: 'Alex Roe', terminationDate: null },
  ],
  activeIds: new Set(['HR-COLLEAGUE']),
  fetchedAt: '2026-09-02T08:00:00.000Z',
  complete: true,
}

describe('the sync, given the snapshot that caused the incident', () => {
  it('keeps one row for the leaver and leaves the colleague alone', async () => {
    const store = new MemoryPeopleStore({ seed: [colleague, leaver] })
    const report = await runSync({
      snapshot: AFTER_THE_RENAME,
      people: store,
      today: '2026-09-02',
      identity: rules,
      minPlausibleHeadcount: 1,
      terminationLookbackDays: 60,
    })

    // No second identity, and no new row: two people in, two rows out.
    expect(report.counts.created).toBe(0)
    expect(report.counts.tombstoned).toBe(0)
    expect(await store.countExact()).toBe(2)

    const renamed = await store.get('HR-LEAVER')
    expect(renamed?.primaryEmail).toBe(RENAMED_TO)
    expect(renamed?.aliasEmails).toContain('alex.roebuck@example.com')
    // The account id stayed on the row it belonged to, which is the whole
    // point: the incident was a row inheriting somebody else's.
    expect(renamed?.externalIds.jumpcloudUserId).toBe('idp-account-roebuck')

    const stillHere = await store.get('HR-COLLEAGUE')
    expect(stillHere?.status).toBe('active')
    expect(stillHere?.externalIds.jumpcloudUserId).toBe('idp-account-alex')
    expect(stillHere?.hold).toBe(false)
    expect(stillHere?.reviewReason ?? null).toBeNull()
  })
})
