/**
 * Translating between a database row and a `Person`, and turning a filter into
 * SQL.
 *
 * Kept apart from the store itself so the mapping can be read on its own: it
 * is the only place a column name appears, and the only place a nullable
 * column is turned into a value the rest of the toolkit can trust.
 */

import type { ExternalIds, LifecycleStatus, OffboardingRecord, Person, ReviewReason } from '../../core/types.ts'
import type { PersonFilter } from '../types.ts'
import { normaliseEmail } from '../transitions-guard.ts'

export type Row = Record<string, unknown>
export type Params = Record<string, string | number | null>

/**
 * Wraps each address in `email_index`. A unit separator is used because it
 * cannot appear inside an address, so a lookup is an exact containment test
 * rather than a pattern match that could hit a longer address instead.
 */
export const SEP = '\u001f'

function str(row: Row, column: string): string | null {
  const value = row[column]
  return typeof value === 'string' && value !== '' ? value : null
}

function required(row: Row, column: string): string {
  const value = str(row, column)
  if (value === null) throw new Error(`Row is missing the required column ${column}.`)
  return value
}

function parseJson<T>(row: Row, column: string, fallback: T): T {
  const raw = str(row, column)
  if (raw === null) return fallback
  return JSON.parse(raw) as T
}

export function fromRow(row: Row): Person {
  const googleAccount = row['google_account_present']
  return {
    hrisId: required(row, 'hris_id'),
    status: required(row, 'status') as LifecycleStatus,
    primaryEmail: required(row, 'primary_email'),
    aliasEmails: parseJson<string[]>(row, 'alias_emails', []),
    displayName: required(row, 'display_name'),
    firstName: str(row, 'first_name'),
    lastName: str(row, 'last_name'),
    department: str(row, 'department'),
    jobTitle: str(row, 'job_title'),
    site: str(row, 'site'),
    managerEmail: str(row, 'manager_email'),
    startDate: str(row, 'start_date'),
    terminationDate: str(row, 'termination_date'),
    hold: row['hold'] === 1,
    holdReason: str(row, 'hold_reason'),
    reviewReason: str(row, 'review_reason') as ReviewReason | null,
    externalIds: parseJson<ExternalIds>(row, 'external_ids', {}),
    // Tri-state on purpose: null means nobody has asked the Google directory
    // yet, which is not the same as "this person has no Google account".
    googleAccountPresent: typeof googleAccount === 'number' ? googleAccount === 1 : null,
    offboarding: parseJson<OffboardingRecord | null>(row, 'offboarding', null),
    activation: parseJson<Person['activation']>(row, 'activation', null),
    note: str(row, 'note'),
    source: str(row, 'source'),
    updatedAt: str(row, 'updated_at'),
  }
}

export function toParams(person: Person): Params {
  const emails = [person.primaryEmail, ...person.aliasEmails].map(normaliseEmail)
  return {
    hris_id: person.hrisId,
    status: person.status,
    primary_email: person.primaryEmail,
    alias_emails: JSON.stringify(person.aliasEmails),
    email_index: SEP + emails.join(SEP) + SEP,
    display_name: person.displayName,
    first_name: person.firstName ?? null,
    last_name: person.lastName ?? null,
    department: person.department ?? null,
    job_title: person.jobTitle ?? null,
    site: person.site ?? null,
    manager_email: person.managerEmail ?? null,
    start_date: person.startDate ?? null,
    termination_date: person.terminationDate ?? null,
    hold: person.hold ? 1 : 0,
    hold_reason: person.holdReason ?? null,
    review_reason: person.reviewReason ?? null,
    external_ids: JSON.stringify(person.externalIds ?? {}),
    google_account_present:
      person.googleAccountPresent === null || person.googleAccountPresent === undefined
        ? null
        : person.googleAccountPresent
          ? 1
          : 0,
    offboarding: person.offboarding ? JSON.stringify(person.offboarding) : null,
    activation: person.activation ? JSON.stringify(person.activation) : null,
    note: person.note ?? null,
    source: person.source ?? null,
    updated_at: person.updatedAt ?? null,
    suspended_at: person.offboarding?.suspendedAt ?? null,
  }
}

export const COLUMNS = [
  'hris_id',
  'status',
  'primary_email',
  'alias_emails',
  'email_index',
  'display_name',
  'first_name',
  'last_name',
  'department',
  'job_title',
  'site',
  'manager_email',
  'start_date',
  'termination_date',
  'hold',
  'hold_reason',
  'review_reason',
  'external_ids',
  'google_account_present',
  'offboarding',
  'activation',
  'note',
  'source',
  'updated_at',
  'suspended_at',
] as const

/** Build the WHERE clause for a filter. Shared by list() and countExact(). */
export function whereClause(filter: PersonFilter | undefined): { sql: string; params: Params } {
  const clauses: string[] = []
  const params: Params = {}
  if (filter?.status && filter.status.length > 0) {
    const names = filter.status.map((status, index) => {
      params[`status${index}`] = status
      return `:status${index}`
    })
    clauses.push(`status IN (${names.join(', ')})`)
  }
  if (filter?.excludeHeld) clauses.push('hold = 0')
  if (filter?.parked === true) clauses.push('review_reason IS NOT NULL')
  if (filter?.parked === false) clauses.push('review_reason IS NULL')
  if (filter?.suspendedAt === 'empty') clauses.push('suspended_at IS NULL')
  if (filter?.suspendedAt === 'set') clauses.push('suspended_at IS NOT NULL')
  if (filter?.suspendedOn) {
    // Compare the date part only. The marker is a date in the organisation's
    // own timezone; comparing whole strings would make a stored timestamp and
    // a stored date disagree about the same day.
    params['suspendedOn'] = filter.suspendedOn
    clauses.push('substr(suspended_at, 1, 10) = :suspendedOn')
  }
  if (filter?.suspendedOnOrBefore) {
    params['suspendedOnOrBefore'] = filter.suspendedOnOrBefore
    clauses.push('suspended_at IS NOT NULL AND substr(suspended_at, 1, 10) <= :suspendedOnOrBefore')
  }
  if (filter?.hasExternalId) {
    params['externalIdKey'] = `$.${filter.hasExternalId}`
    clauses.push(`json_extract(external_ids, :externalIdKey) IS NOT NULL`)
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
}
