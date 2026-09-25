/**
 * How a Person is laid out across a Notion page.
 *
 * Two kinds of property. The readable ones (name, address, status, dates,
 * the hold checkbox, a note) are columns a human uses and may edit in Notion,
 * so they are written as their own properties and, for status, hold, the
 * suspension date and the note, read back as the authority. Everything
 * structured that no human edits (aliases, account ids, leg records,
 * activation markers, review reasons) is kept as JSON in one rich-text
 * property, so the toolkit's markers survive without the database growing a
 * column per field.
 *
 * Every property name and every status label is configurable, because the
 * database this was ported from already had its own names.
 */

import type { LifecycleStatus, Person } from '../../core/types.ts'
import type { NotionDatabase, NotionPage, NotionProperties } from './client.ts'

export interface NotionPropertyMap {
  title: string
  hrisId: string
  primaryEmail: string
  status: string
  suspendedAt: string
  hold: string
  googleAccountPresent: string
  identityId: string
  managerEmail: string
  note: string
  startDate: string
  department: string
  jobTitle: string
  source: string
  updatedAt: string
  /** The JSON property holding everything structured. */
  state: string
}

export const DEFAULT_PROPERTIES: NotionPropertyMap = {
  title: 'Name',
  hrisId: 'HR ID',
  primaryEmail: 'Email',
  status: 'Status',
  suspendedAt: 'Suspended Date',
  hold: 'Offboarding Hold',
  googleAccountPresent: 'Google Account',
  identityId: 'JumpCloud ID',
  managerEmail: 'Manager',
  note: 'Notes',
  startDate: 'Start Date',
  department: 'Department',
  jobTitle: 'Role',
  source: 'Source',
  updatedAt: 'Last Sync',
  state: 'JML State',
}

export const DEFAULT_STATUS_VALUES: Record<LifecycleStatus, string> = {
  hired: 'Hired',
  active: 'Active',
  terminated: 'Terminated',
  offboarding: 'Offboarding',
  departed: 'Departed',
}

/** The Notion type each mapped property must have, for init() to add or refuse. */
export const PROPERTY_TYPES: Record<keyof NotionPropertyMap, string> = {
  title: 'title',
  hrisId: 'rich_text',
  primaryEmail: 'email',
  status: 'select',
  suspendedAt: 'date',
  hold: 'checkbox',
  googleAccountPresent: 'checkbox',
  identityId: 'rich_text',
  managerEmail: 'rich_text',
  note: 'rich_text',
  startDate: 'date',
  department: 'rich_text',
  jobTitle: 'rich_text',
  source: 'rich_text',
  updatedAt: 'date',
  state: 'rich_text',
}

export function resolvePropertyMap(overrides: Record<string, string> = {}): NotionPropertyMap {
  const map = { ...DEFAULT_PROPERTIES }
  for (const [key, value] of Object.entries(overrides)) {
    if (key in map && value.trim()) (map as Record<string, string>)[key] = value.trim()
  }
  return map
}

export function resolveStatusValues(overrides: Record<string, string> = {}): Record<LifecycleStatus, string> {
  const values = { ...DEFAULT_STATUS_VALUES }
  for (const status of Object.keys(values) as LifecycleStatus[]) {
    const v = overrides[status]?.trim()
    if (v) values[status] = v
  }
  return values
}

/** Notion caps one rich-text object at 2000 characters; long JSON is split across several. */
const RICH_TEXT_LIMIT = 2000

function richText(text: string | null | undefined): { rich_text: { text: { content: string } }[] } {
  const value = text ?? ''
  const parts: { text: { content: string } }[] = []
  for (let i = 0; i < value.length; i += RICH_TEXT_LIMIT) parts.push({ text: { content: value.slice(i, i + RICH_TEXT_LIMIT) } })
  return { rich_text: parts }
}

function readRichText(prop: unknown): string {
  const list = (prop as { rich_text?: { plain_text?: string; text?: { content?: string } }[] } | undefined)?.rich_text ?? []
  return list.map((t) => t.plain_text ?? t.text?.content ?? '').join('')
}

function readTitle(prop: unknown): string {
  const list = (prop as { title?: { plain_text?: string; text?: { content?: string } }[] } | undefined)?.title ?? []
  return list.map((t) => t.plain_text ?? t.text?.content ?? '').join('')
}

function readDate(prop: unknown): string | null {
  const start = (prop as { date?: { start?: string } | null } | undefined)?.date?.start
  return start ? start.slice(0, 10) : null
}

function readCheckbox(prop: unknown): boolean {
  return (prop as { checkbox?: boolean } | undefined)?.checkbox === true
}

function readSelect(prop: unknown): string | null {
  return (prop as { select?: { name?: string } | null } | undefined)?.select?.name ?? null
}

function readEmail(prop: unknown): string {
  return ((prop as { email?: string | null } | undefined)?.email ?? '').trim().toLowerCase()
}

/** The parts of a Person that live in the JSON property. */
type StateBlob = Omit<Person, 'hrisId' | 'status' | 'primaryEmail' | 'displayName' | 'hold' | 'note' | 'startDate' | 'department' | 'jobTitle' | 'source' | 'updatedAt' | 'managerEmail'>

export function toProperties(person: Person, map: NotionPropertyMap, statuses: Record<LifecycleStatus, string>): NotionProperties {
  const { hrisId, status, primaryEmail, displayName, hold, note, startDate, department, jobTitle, source, updatedAt, managerEmail, ...rest } = person
  const googleAccountPresent = person.googleAccountPresent
  const blob: StateBlob = rest
  return {
    [map.title]: { title: [{ text: { content: displayName || primaryEmail || hrisId } }] },
    [map.hrisId]: richText(hrisId),
    [map.primaryEmail]: { email: primaryEmail || null },
    [map.status]: { select: { name: statuses[status] } },
    [map.suspendedAt]: { date: person.offboarding?.suspendedAt ? { start: person.offboarding.suspendedAt } : null },
    [map.hold]: { checkbox: hold },
    [map.googleAccountPresent]: { checkbox: googleAccountPresent === true },
    [map.identityId]: richText(person.externalIds?.jumpcloudUserId ?? ''),
    [map.managerEmail]: richText(managerEmail ?? ''),
    [map.note]: richText(note ?? ''),
    [map.startDate]: { date: startDate ? { start: startDate } : null },
    [map.department]: richText(department ?? ''),
    [map.jobTitle]: richText(jobTitle ?? ''),
    [map.source]: richText(source ?? ''),
    [map.updatedAt]: { date: updatedAt ? { start: updatedAt } : null },
    [map.state]: richText(JSON.stringify(blob)),
  }
}

/**
 * Read a page back into a Person.
 *
 * The visible columns win over the JSON for the fields a human may edit:
 * status, hold, the suspension date, the note, the address and the name.
 * Ticking the hold checkbox in Notion has to stop the engine, and it can
 * only do that if the checkbox is what the engine reads.
 */
export function fromPage(page: NotionPage, map: NotionPropertyMap, statuses: Record<LifecycleStatus, string>): Person | null {
  const p = page.properties
  const hrisId = readRichText(p[map.hrisId]).trim()
  if (!hrisId) return null
  let blob: Partial<StateBlob> = {}
  const raw = readRichText(p[map.state])
  if (raw.trim()) {
    try {
      blob = JSON.parse(raw) as Partial<StateBlob>
    } catch {
      // A hand-edited JSON cell is treated as absent rather than as a reason to
      // refuse the row; the visible columns still describe the person.
      blob = {}
    }
  }
  const label = readSelect(p[map.status])
  const status = (Object.keys(statuses) as LifecycleStatus[]).find((k) => statuses[k] === label) ?? 'active'
  const suspendedAt = readDate(p[map.suspendedAt])
  const identityId = readRichText(p[map.identityId]).trim() || null
  const externalIds = { ...(blob.externalIds ?? {}), ...(identityId ? { jumpcloudUserId: identityId } : {}) }
  const offboarding = blob.offboarding || suspendedAt ? { legs: {}, ...(blob.offboarding ?? {}), suspendedAt } : null
  return {
    aliasEmails: [],
    ...blob,
    hrisId,
    status,
    primaryEmail: readEmail(p[map.primaryEmail]),
    displayName: readTitle(p[map.title]).trim() || hrisId,
    hold: readCheckbox(p[map.hold]),
    note: readRichText(p[map.note]) || null,
    startDate: readDate(p[map.startDate]),
    department: readRichText(p[map.department]) || null,
    jobTitle: readRichText(p[map.jobTitle]) || null,
    source: readRichText(p[map.source]) || null,
    updatedAt: readDate(p[map.updatedAt]),
    managerEmail: readRichText(p[map.managerEmail]).trim().toLowerCase() || null,
    googleAccountPresent: readCheckbox(p[map.googleAccountPresent]) ? true : (blob.googleAccountPresent ?? null),
    externalIds,
    offboarding,
  }
}

/** Which mapped properties the database lacks, and which exist with the wrong type. */
export function schemaGaps(db: NotionDatabase, map: NotionPropertyMap): { missing: (keyof NotionPropertyMap)[]; wrongType: { key: keyof NotionPropertyMap; name: string; have: string; want: string }[] } {
  const byName = new Map(Object.entries(db.properties).map(([name, def]) => [name, def.type]))
  const missing: (keyof NotionPropertyMap)[] = []
  const wrongType: { key: keyof NotionPropertyMap; name: string; have: string; want: string }[] = []
  for (const key of Object.keys(map) as (keyof NotionPropertyMap)[]) {
    const name = map[key]
    const have = byName.get(name)
    const want = PROPERTY_TYPES[key]
    if (have === undefined) missing.push(key)
    else if (have !== want) wrongType.push({ key, name, have, want })
  }
  return { missing, wrongType }
}

export function propertyDefinition(key: keyof NotionPropertyMap, statuses: Record<LifecycleStatus, string>): unknown {
  const type = PROPERTY_TYPES[key]
  if (type === 'select') return { select: { options: Object.values(statuses).map((name) => ({ name })) } }
  return { [type]: {} }
}
