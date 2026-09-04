/**
 * Which HiBob field holds which canonical value, and how a record is read
 * through that map.
 *
 * Every path is overridable from config. HiBob is configurable per tenant, so
 * the leaving date, the site and the manager can genuinely live somewhere else
 * in another company's account. An adopter who has to fork the code to remap a
 * field will not adopt it, so the map is data and this file only holds the
 * defaults and the reading rules.
 */

import { HrisIncomplete, type HrisPerson } from '../types.ts'

export interface HiBobFieldMap {
  hrisId: string
  primaryEmail: string
  displayName: string
  firstName: string
  lastName: string
  department: string
  jobTitle: string
  site: string
  startDate: string
  managerEmail: string
  /**
   * The manager's name.
   *
   * Requested and mapped, but not returned on the canonical person: nothing in
   * this toolkit joins on a manager's name, because resolving a manager that
   * way once matched the wrong colleague. It is here so a tenant can point at
   * the right field the day a notification template needs the wording.
   */
  managerName: string
  /**
   * Ordered fallbacks: the first path that holds a value wins.
   *
   * Both of these exist in HiBob and they do not always agree. Live probing of
   * one tenant found the internal field populated where the employment table
   * was empty, so an adapter that read only one of them saw no leaving date at
   * all for some people. The order is config, not a rule of the product.
   */
  terminationDate: string[]
}

export type HiBobFieldOverrides = Partial<HiBobFieldMap>

export const DEFAULT_HIBOB_FIELDS: HiBobFieldMap = {
  hrisId: 'root.id',
  primaryEmail: 'root.email',
  displayName: 'root.displayName',
  firstName: 'root.firstName',
  lastName: 'root.surname',
  department: 'work.department',
  jobTitle: 'work.title',
  site: 'work.site',
  startDate: 'work.startDate',
  managerEmail: 'work.reportsTo.email',
  managerName: 'work.reportsTo.displayName',
  terminationDate: ['internal.terminationDate', 'employment.terminationDate'],
}

export function resolveFieldMap(overrides?: HiBobFieldOverrides): HiBobFieldMap {
  const map = { ...DEFAULT_HIBOB_FIELDS, ...(overrides ?? {}) }
  if (!map.terminationDate.length) {
    throw new Error(
      'hris.hibob.fields.terminationDate must name at least one path, otherwise no leaver ever has a date.',
    )
  }
  return map
}

/**
 * The field list to ask for.
 *
 * Naming the fields keeps the response small, but the reason that matters is
 * different: when the map is wrong for a tenant the response comes back
 * without the value, which the reader below turns into a loud failure rather
 * than a person with no leaving date.
 */
export function requestFields(map: HiBobFieldMap): string[] {
  const paths = [
    map.hrisId,
    map.primaryEmail,
    map.displayName,
    map.firstName,
    map.lastName,
    map.department,
    map.jobTitle,
    map.site,
    map.startDate,
    map.managerEmail,
    map.managerName,
    ...map.terminationDate,
  ]
  return [...new Set(paths.filter((p) => p.trim().length > 0))]
}

/**
 * Read one dotted path out of a record.
 *
 * The request paths carry a `root.` prefix for the top-level fields while the
 * response puts those same fields at the top level, so the prefix is dropped
 * here rather than being duplicated in the map.
 */
export function readPath(record: unknown, path: string): unknown {
  const segments = path.split('.').filter((s) => s.length > 0)
  if (segments[0] === 'root') segments.shift()

  let cursor: unknown = record
  for (const segment of segments) {
    // Some HiBob tables come back as a list even when only the current row is
    // requested. Descending into a single-element list is unambiguous, so it
    // is allowed; a longer list is not, because picking one row of a history
    // table by position is a guess, and a guessed leaving date is worse than
    // no leaving date.
    if (Array.isArray(cursor) && cursor.length === 1) cursor = cursor[0]
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  if (Array.isArray(cursor) && cursor.length === 1) cursor = cursor[0]
  return cursor
}

/** A trimmed string, or null for anything blank or non-scalar. */
export function readString(record: unknown, path: string): string | null {
  const value = readPath(record, path)
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Email addresses are lower-cased on the way in.
 *
 * Comparison and alias handling belong to the identity module, but a stray
 * capital letter must not be able to look like a second person here.
 */
export function readEmail(record: unknown, path: string): string | null {
  const value = readString(record, path)
  return value === null ? null : value.toLowerCase()
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Accept an ISO date, refuse anything else.
 *
 * The automation this was ported from asked HiBob for human-readable output
 * and then split the result on slashes. That works in exactly one locale: in
 * any other tenant the same string means a different day, and a wrong leaving
 * date suspends somebody's account on the wrong morning. So the adapter asks
 * for machine-readable dates and a locale-formatted value is treated as a
 * broken read of the whole snapshot rather than something to parse.
 */
export function toIsoDate(value: unknown, fieldPath: string, context?: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    if (typeof value === 'number') {
      throw new HrisIncomplete(
        `${fieldPath} came back as a number${where(context)}. The adapter reads ISO dates only; remap the field or fix the request.`,
      )
    }
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  // An ISO date-time is fine: the date part is what every decision uses.
  const datePart = trimmed.includes('T') ? (trimmed.split('T')[0] ?? '') : trimmed
  const match = ISO_DATE.exec(datePart)
  if (!match) {
    throw new HrisIncomplete(
      `${fieldPath} is not an ISO date${where(context)}. A locale-formatted date is ambiguous, so the snapshot is refused rather than guessed. Check that the request does not ask for human-readable output and that the field map points at a date field.`,
    )
  }

  const [, year, month, day] = match
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) {
    throw new HrisIncomplete(`${fieldPath} is not a real date${where(context)}.`)
  }
  return `${year}-${month}-${day}`
}

function where(context?: string): string {
  return context ? ` (record ${context})` : ''
}

/**
 * Turn one HiBob record into the canonical shape.
 *
 * A record with no id throws. It cannot be keyed on anything else, and
 * dropping it silently would remove a person from the snapshot, which is the
 * same thing as telling the pipeline they have left.
 */
export function readPerson(record: unknown, map: HiBobFieldMap): HrisPerson {
  const hrisId = readString(record, map.hrisId)
  if (hrisId === null) {
    throw new HrisIncomplete(
      `A record came back with no value at ${map.hrisId}. The field map is probably wrong for this tenant; a record with no id cannot be matched to anybody.`,
    )
  }

  const firstName = readString(record, map.firstName)
  const lastName = readString(record, map.lastName)
  const primaryEmail = readEmail(record, map.primaryEmail)

  let terminationDate: string | null = null
  for (const path of map.terminationDate) {
    terminationDate = toIsoDate(readPath(record, path), path, hrisId)
    if (terminationDate !== null) break
  }

  return {
    hrisId,
    // A person with no work mailbox is still a person the HR system employs,
    // so they stay in the snapshot with an empty address. Removing them here
    // would make them indistinguishable from a leaver.
    primaryEmail: primaryEmail ?? '',
    displayName: displayNameOf(record, map, { firstName, lastName, primaryEmail, hrisId }),
    firstName,
    lastName,
    department: readString(record, map.department),
    jobTitle: readString(record, map.jobTitle),
    site: readString(record, map.site),
    managerEmail: readEmail(record, map.managerEmail),
    startDate: toIsoDate(readPath(record, map.startDate), map.startDate, hrisId),
    terminationDate,
  }
}

function displayNameOf(
  record: unknown,
  map: HiBobFieldMap,
  parts: { firstName: string | null; lastName: string | null; primaryEmail: string | null; hrisId: string },
): string {
  const given = readString(record, map.displayName)
  if (given !== null) return given
  const joined = [parts.firstName, parts.lastName].filter((p) => p !== null).join(' ').trim()
  if (joined.length > 0) return joined
  // Notifications and run reports print the display name, so it must never be
  // empty. Falling back to the id keeps a nameless record identifiable without
  // putting an address into a message.
  return parts.primaryEmail ?? parts.hrisId
}
