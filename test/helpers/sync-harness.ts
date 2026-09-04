/**
 * Fixtures for the sync and detect tests.
 *
 * The point of a harness here is that every test states only the thing it is
 * about. A test that has to spell out a whole snapshot and a whole set of
 * options buries its own subject, and the subjects in this package are one
 * field each: a missing leaving date, a held row, an address that changed.
 */

import { createDomainMap } from '../../src/core/domain.ts'
import { createIdentityRules } from '../../src/core/identity.ts'
import type { IdentityRules } from '../../src/core/identity.ts'
import type { Person } from '../../src/core/types.ts'
import type { HrisPerson, HrisSnapshot } from '../../src/hris/types.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import type { SyncOptions } from '../../src/engine/sync.ts'

export const TODAY = '2026-03-10'

export const domain = createDomainMap({ primaryDomain: 'example.com', aliasDomains: ['legacy.example.com'] })

export function rules(patterns: readonly string[] = ['\\+(exit|leaver)@']): IdentityRules {
  return createIdentityRules(domain, patterns)
}

/** An HR record with sensible values, so a test overrides one field. */
export function hrisPerson(overrides: Partial<HrisPerson> = {}): HrisPerson {
  return {
    hrisId: 'hr-001',
    primaryEmail: 'jane.doe@example.com',
    displayName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    department: 'Operations',
    jobTitle: 'Analyst',
    site: 'Head office',
    managerEmail: 'john.doe@example.com',
    startDate: '2024-01-08',
    terminationDate: null,
    ...overrides,
  }
}

/**
 * A colleague who is still employed.
 *
 * Include this in any fixture where the subject has left. Without somebody
 * employed the snapshot says the whole organisation has gone, which the sync
 * refuses outright, and rightly: that is what a truncated read looks like.
 */
export const ANCHOR: HrisPerson = {
  hrisId: 'hr-anchor',
  primaryEmail: 'john.doe@example.com',
  displayName: 'John Doe',
  startDate: '2020-06-01',
  terminationDate: null,
}

/**
 * A snapshot. `activeIds` defaults to everybody, because a test about leavers
 * should have to say who left.
 */
export function snapshot(people: HrisPerson[], activeIds?: string[], overrides: Partial<HrisSnapshot> = {}): HrisSnapshot {
  return {
    all: people,
    activeIds: new Set(activeIds ?? people.map((p) => p.hrisId)),
    fetchedAt: `${TODAY}T08:00:00.000Z`,
    complete: true,
    ...overrides,
  }
}

/** A stored row with sensible values. */
export function storedPerson(overrides: Partial<Person> = {}): Person {
  return {
    hrisId: 'hr-001',
    status: 'active',
    primaryEmail: 'jane.doe@example.com',
    aliasEmails: [],
    displayName: 'Jane Doe',
    firstName: 'Jane',
    lastName: 'Doe',
    department: 'Operations',
    jobTitle: 'Analyst',
    site: 'Head office',
    managerEmail: 'john.doe@example.com',
    startDate: '2024-01-08',
    terminationDate: null,
    hold: false,
    holdReason: null,
    reviewReason: null,
    externalIds: {},
    googleAccountPresent: null,
    offboarding: null,
    note: null,
    source: 'hris',
    ...overrides,
  }
}

export interface Harness {
  store: MemoryPeopleStore
  options: (snap: HrisSnapshot, overrides?: Partial<SyncOptions>) => SyncOptions
}

/**
 * A store seeded with rows, and an options builder for it.
 *
 * The plausibility floor is 1 rather than the shipped default so a two-person
 * fixture is usable; the tests that care about the floor state their own.
 */
export function harness(seed: readonly Person[] = []): Harness {
  const store = new MemoryPeopleStore({ seed })
  return {
    store,
    options: (snap, overrides = {}) => ({
      snapshot: snap,
      people: store,
      today: TODAY,
      identity: rules(),
      minPlausibleHeadcount: 1,
      terminationLookbackDays: 60,
      ...overrides,
    }),
  }
}
