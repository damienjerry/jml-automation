/**
 * People as a table: a CSV export or a Google Sheet.
 *
 * For a team with no HR API. A person keeps a sheet, or an HR system exports
 * a file on a schedule, and the toolkit reads it each run. The table is only
 * ever read; the toolkit's own record stays in its people store.
 *
 * Three rules shape this file.
 *
 * A row that cannot be read refuses the whole read. An absent row is exactly
 * what makes somebody a leaver, so a snapshot with rows quietly dropped would
 * offboard them. Every problem is collected and named by row number, so one
 * attempt shows everything wrong with the file.
 *
 * Leavers are rows with a leaving date, not deleted rows. The status of each
 * person is derived from the dates by the same rule as every other HR adapter:
 * not started yet, employed, or past their last day. A deleted row simply stops
 * being read, and a deleted row for somebody still in the people store is
 * reported by the sync rather than acted on.
 *
 * Dates are parsed in one stated format. A table that mixes 03/04 as March and
 * April is exactly the ambiguity that moves a leaving date by a month.
 */

import { HrisIncomplete, HrisImplausible, type HrisPerson, type HrisSnapshot } from './types.ts'

export type TableDateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY'

/** The column heading that holds each field. Null means the table has no such column. */
export interface TableColumns {
  hrisId: string
  primaryEmail: string
  firstName: string | null
  lastName: string | null
  displayName: string | null
  department: string | null
  jobTitle: string | null
  managerEmail: string | null
  personalEmail: string | null
  startDate: string | null
  lastWorkingDay: string | null
  terminationDate: string | null
  inScope: string | null
}

export interface TableOptions {
  /** For messages: the file path or the sheet. */
  source: string
  columns: TableColumns
  dateFormat: TableDateFormat
  /** Values of the in-scope column that mean yes, compared without case. */
  inScopeValues: readonly string[]
  minPlausibleHeadcount: number | null
}

/** How many problems to name before summarising the rest. */
const MAX_NAMED_PROBLEMS = 15

/**
 * Turn rows (the first one the headings) into a snapshot, or refuse.
 *
 * Exported so the CSV and Sheet readers share one set of rules, and so the
 * rules can be tested without either.
 */
export function snapshotFromRows(rows: readonly (readonly string[])[], opts: TableOptions): HrisSnapshot {
  const problems: string[] = []
  const [header, ...body] = rows
  if (!header || header.length === 0) {
    throw new HrisIncomplete(`${opts.source} has no heading row, so no column can be found.`)
  }

  const headings = header.map((h) => h.trim().toLowerCase())
  const index = (name: string | null): number | null => {
    if (!name) return null
    const at = headings.indexOf(name.trim().toLowerCase())
    return at >= 0 ? at : -1
  }
  const columnAt: Partial<Record<keyof TableColumns, number | null>> = {}
  for (const field of Object.keys(opts.columns) as (keyof TableColumns)[]) {
    const at = index(opts.columns[field])
    if (at === -1) problems.push(`the column "${opts.columns[field]}" (for ${field}) is not in the heading row`)
    columnAt[field] = at === -1 ? null : at
  }
  const hasName = columnAt.displayName != null || (columnAt.firstName != null && columnAt.lastName != null)
  if (columnAt.hrisId == null) problems.push('no id column: every person needs a stable id that never changes')
  if (columnAt.primaryEmail == null) problems.push('no work email column')
  if (!hasName) problems.push('no name: map displayName, or both firstName and lastName')
  if (problems.length > 0) throw refusal(opts.source, problems)

  const people: HrisPerson[] = []
  const seenIds = new Map<string, number>()
  const seenEmails = new Map<string, number>()

  body.forEach((row, i) => {
    const line = i + 2
    const cell = (key: keyof TableColumns): string => {
      const at = columnAt[key]
      return at == null ? '' : (row[at] ?? '').trim()
    }
    if (row.every((c) => c.trim() === '')) return

    const hrisId = cell('hrisId')
    const primaryEmail = cell('primaryEmail').toLowerCase()
    if (!hrisId) {
      problems.push(`row ${line}: no id`)
      return
    }
    const firstId = seenIds.get(hrisId)
    if (firstId !== undefined) problems.push(`row ${line}: id "${hrisId}" is also on row ${firstId}`)
    else seenIds.set(hrisId, line)
    if (primaryEmail) {
      if (!primaryEmail.includes('@')) problems.push(`row ${line}: work email "${primaryEmail}" is not an address`)
      const firstEmail = seenEmails.get(primaryEmail)
      if (firstEmail !== undefined) problems.push(`row ${line}: work email is also on row ${firstEmail}`)
      else seenEmails.set(primaryEmail, line)
    }

    const date = (field: 'startDate' | 'lastWorkingDay' | 'terminationDate'): string | null => {
      const raw = cell(field)
      if (!raw) return null
      const iso = parseDate(raw, opts.dateFormat)
      if (!iso) problems.push(`row ${line}: ${field} "${raw}" is not a ${opts.dateFormat} date`)
      return iso
    }
    const startDate = date('startDate')
    const lastWorkingDay = date('lastWorkingDay')
    const terminationDate = date('terminationDate')
    const leave = lastWorkingDay ?? terminationDate
    if (startDate && leave && leave < startDate) problems.push(`row ${line}: leaves (${leave}) before starting (${startDate})`)

    const first = cell('firstName') || null
    const last = cell('lastName') || null
    const displayName = cell('displayName') || [first, last].filter(Boolean).join(' ')
    if (!displayName) problems.push(`row ${line}: no name`)

    const scopeRaw = cell('inScope')
    const inScope = columnAt.inScope == null || scopeRaw === '' ? null : opts.inScopeValues.some((v) => v.toLowerCase() === scopeRaw.toLowerCase())

    people.push({
      hrisId,
      primaryEmail,
      displayName,
      firstName: first,
      lastName: last,
      department: cell('department') || null,
      jobTitle: cell('jobTitle') || null,
      managerEmail: cell('managerEmail').toLowerCase() || null,
      personalEmail: cell('personalEmail') || null,
      startDate,
      lastWorkingDay,
      terminationDate,
      inScope,
    })
  })

  if (problems.length > 0) throw refusal(opts.source, problems)

  if (opts.minPlausibleHeadcount !== null && people.length < opts.minPlausibleHeadcount) {
    throw new HrisImplausible(
      `${opts.source} holds ${people.length} people, below the stated floor of ${opts.minPlausibleHeadcount}. Nothing is written from a table that small.`,
      { received: people.length, floor: opts.minPlausibleHeadcount },
    )
  }

  // Everybody listed is on the employed list; the dates decide who has left.
  return {
    all: people,
    activeIds: new Set(people.map((p) => p.hrisId)),
    fetchedAt: new Date().toISOString(),
    complete: true,
  }
}

function refusal(source: string, problems: readonly string[]): HrisIncomplete {
  const named = problems.slice(0, MAX_NAMED_PROBLEMS).map((p) => '  - ' + p)
  const more = problems.length > MAX_NAMED_PROBLEMS ? [`  ...and ${problems.length - MAX_NAMED_PROBLEMS} more`] : []
  return new HrisIncomplete(
    `${source} could not be read, so nothing was taken from it (a partial read would offboard everybody on a skipped row):\n${[...named, ...more].join('\n')}`,
  )
}

/** A date in the stated format, as ISO, or null when it is not one. */
export function parseDate(raw: string, format: TableDateFormat): string | null {
  const text = raw.trim()
  let y: number, m: number, d: number
  if (format === 'YYYY-MM-DD') {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
    if (!match) return null
    ;[y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  } else {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
    if (!match) return null
    const a = Number(match[1])
    const b = Number(match[2])
    y = Number(match[3])
    ;[d, m] = format === 'DD/MM/YYYY' ? [a, b] : [b, a]
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Parse CSV text into rows. RFC 4180: quoted fields, doubled quotes inside
 * them, commas and line breaks inside quotes, CRLF or LF, and a leading byte
 * order mark, which spreadsheet exports often add.
 */
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (quoted) throw new HrisIncomplete('the CSV ends inside a quoted field, so it was cut short')
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
