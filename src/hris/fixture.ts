/**
 * A JSON file standing in for an HR system.
 *
 * Three jobs, and all three matter:
 *
 *  - `jml demo` runs the whole lifecycle from this adapter, so a stranger can
 *    watch the state machine work before they have a single credential.
 *  - The tests replay recorded snapshots through it.
 *  - An adopter whose HR system has no usable API can export people by hand
 *    and still use the toolkit. This is the credential-free path, so it is a
 *    supported adapter rather than a test double.
 *
 * The file states who is employed as a list of ids. That is not a convenience:
 * absence from the employed set is the only thing that makes somebody a
 * leaver, so a hand-written snapshot has to say it out loud rather than have
 * it inferred from a status word.
 */

import { readFile } from 'node:fs/promises'
import {
  HrisImplausible,
  HrisIncomplete,
  type ConnectionCheck,
  type HrisAdapter,
  type HrisPerson,
  type HrisSnapshot,
} from './types.ts'

export interface HrisFixtureFile {
  /**
   * Free text for whoever opens the file, as a line or a list of lines. Read
   * by nothing, but a fixture that does not say what each person is there to
   * demonstrate stops being maintainable within a month.
   */
  _readme?: string
  /**
   * The date the fixture is written around, for a demo that pins its clock.
   * Not used by this adapter; `jml demo` reads it so the dates in the file
   * mean something relative to the day being simulated.
   */
  demoToday?: string
  people: HrisPerson[]
  /** The ids the HR system reports as currently employed. */
  activeIds: string[]
  /**
   * Set false to replay a truncated read. The adapter then throws
   * `HrisIncomplete`, which is what a real short read must do.
   */
  complete?: boolean
  fetchedAt?: string
}

export interface FixtureAdapterOptions {
  path: string
  /**
   * Same floor as the live adapters. A hand-written file is at least as easy
   * to truncate as an API response, so it gets the same refusal.
   *
   * It is checked against the people list only, unlike the live adapter, which
   * also checks the employed set. There the employed set is a separate paged
   * read that can come back truncated on its own; here both lists are stated
   * in one file, and a mismatch between them is caught by the contradiction
   * check instead.
   */
  minPlausibleHeadcount?: number
}

export class FixtureHrisAdapter implements HrisAdapter {
  readonly name = 'fixture'

  private readonly path: string
  private readonly minPlausibleHeadcount: number | null

  constructor(options: FixtureAdapterOptions) {
    this.path = options.path
    this.minPlausibleHeadcount = options.minPlausibleHeadcount ?? null
  }

  async fetchAll(): Promise<HrisSnapshot> {
    const file = await readFixtureFile(this.path)

    if (file.complete === false) {
      throw new HrisIncomplete(
        `${this.path} is marked as a truncated read (complete: false), so no snapshot is produced.`,
      )
    }

    const activeIds = new Set(file.activeIds)
    const known = new Set(file.people.map((p) => p.hrisId))
    const unknownActive = [...activeIds].filter((id) => !known.has(id))
    if (unknownActive.length > 0) {
      throw new HrisIncomplete(
        `${this.path} lists ${unknownActive.length} employed id(s) that are not in people, so the snapshot contradicts itself.`,
      )
    }

    if (this.minPlausibleHeadcount !== null && file.people.length < this.minPlausibleHeadcount) {
      throw new HrisImplausible(
        `${this.path} holds ${file.people.length} people, below the stated floor of ${this.minPlausibleHeadcount}. Nothing is written from a snapshot that small.`,
        { received: file.people.length, floor: this.minPlausibleHeadcount },
      )
    }

    return {
      all: file.people,
      activeIds,
      fetchedAt: file.fetchedAt ?? new Date().toISOString(),
      complete: true,
    }
  }

  async testConnection(): Promise<ConnectionCheck> {
    try {
      const file = await readFixtureFile(this.path)
      return {
        ok: true,
        detail: `${this.path}: ${file.people.length} people, ${file.activeIds.length} employed, no credential required`,
        docsAnchor: 'docs/adapters/hris-fixture.md',
      }
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        remediation: `Point hris.fixture.path at a readable JSON file with people[] and activeIds[]. See ${EXAMPLE_PATH}.`,
        docsAnchor: 'docs/adapters/hris-fixture.md',
      }
    }
  }
}

const EXAMPLE_PATH = './src/cli/fixtures/demo.json'

/**
 * Read and validate a fixture file.
 *
 * Exported because the demo command needs `demoToday` from the same file, and
 * two readers of one format drift apart.
 */
export async function readFixtureFile(path: string): Promise<HrisFixtureFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new HrisIncomplete(`Could not read the HR fixture at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new HrisIncomplete(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateFixture(parsed, path)
}

export function validateFixture(parsed: unknown, path: string): HrisFixtureFile {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HrisIncomplete(`${path} must hold a JSON object with people[] and activeIds[].`)
  }
  const raw = parsed as Record<string, unknown>

  if (!Array.isArray(raw['people'])) {
    throw new HrisIncomplete(`${path} has no people array.`)
  }
  if (!Array.isArray(raw['activeIds'])) {
    // Defaulting this would be the dangerous choice in both directions: an
    // empty default reads as everybody having left, and a full default means a
    // fixture can never express a leaver at all.
    throw new HrisIncomplete(
      `${path} has no activeIds array. State the ids the HR system reports as employed; absence from that list is what makes somebody a leaver.`,
    )
  }

  const people = raw['people'].map((record, index) => validatePerson(record, path, index))
  const seen = new Set<string>()
  for (const person of people) {
    if (seen.has(person.hrisId)) {
      throw new HrisIncomplete(`${path} lists hrisId ${person.hrisId} twice; an id is one person.`)
    }
    seen.add(person.hrisId)
  }

  const activeIds = raw['activeIds'].map((id, index) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new HrisIncomplete(`${path} activeIds[${index}] is not a non-empty string.`)
    }
    return id
  })

  const file: HrisFixtureFile = { people, activeIds }
  const readme = raw['_readme']
  if (typeof readme === 'string') file._readme = readme
  else if (Array.isArray(readme) && readme.every((line) => typeof line === 'string')) {
    file._readme = readme.join('\n')
  }
  if (typeof raw['demoToday'] === 'string') file.demoToday = raw['demoToday']
  if (typeof raw['fetchedAt'] === 'string') file.fetchedAt = raw['fetchedAt']
  if (typeof raw['complete'] === 'boolean') file.complete = raw['complete']
  return file
}

function validatePerson(record: unknown, path: string, index: number): HrisPerson {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new HrisIncomplete(`${path} people[${index}] is not an object.`)
  }
  const raw = record as Record<string, unknown>
  const hrisId = raw['hrisId']
  if (typeof hrisId !== 'string' || hrisId.trim().length === 0) {
    throw new HrisIncomplete(`${path} people[${index}] has no hrisId. The id is the only key a person has.`)
  }

  const person: HrisPerson = {
    hrisId,
    // A person with no work mailbox keeps an empty address rather than being
    // dropped from the file, because a dropped person is indistinguishable
    // from somebody who has left.
    primaryEmail: optionalString(raw['primaryEmail'], path, index, 'primaryEmail')?.toLowerCase() ?? '',
    displayName: optionalString(raw['displayName'], path, index, 'displayName') ?? hrisId,
    firstName: optionalString(raw['firstName'], path, index, 'firstName') ?? null,
    lastName: optionalString(raw['lastName'], path, index, 'lastName') ?? null,
    department: optionalString(raw['department'], path, index, 'department') ?? null,
    jobTitle: optionalString(raw['jobTitle'], path, index, 'jobTitle') ?? null,
    site: optionalString(raw['site'], path, index, 'site') ?? null,
    managerEmail: optionalString(raw['managerEmail'], path, index, 'managerEmail')?.toLowerCase() ?? null,
    startDate: isoOrNull(raw['startDate'], path, index, 'startDate'),
    terminationDate: isoOrNull(raw['terminationDate'], path, index, 'terminationDate'),
    lastWorkingDay: isoOrNull(raw['lastWorkingDay'], path, index, 'lastWorkingDay'),
    inScope: typeof raw['inScope'] === 'boolean' ? raw['inScope'] : null,
  }
  return person
}

function optionalString(
  value: unknown,
  path: string,
  index: number,
  field: string,
): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new HrisIncomplete(`${path} people[${index}].${field} must be a string.`)
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Dates in a fixture are ISO or nothing.
 *
 * The same rule as the live adapter, for the same reason: a hand-written
 * `01/02/2026` is a different day in two countries, and this value decides
 * which morning somebody loses their account.
 */
function isoOrNull(value: unknown, path: string, index: number, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !ISO_DATE.test(value.trim())) {
    throw new HrisIncomplete(
      `${path} people[${index}].${field} must be an ISO date (YYYY-MM-DD) or null. A locale-formatted date is ambiguous and is refused rather than guessed.`,
    )
  }
  return value.trim()
}
