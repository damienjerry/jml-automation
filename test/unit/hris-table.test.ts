/**
 * People from a CSV file or a Google Sheet.
 *
 * The rule that matters most: a table that cannot be fully read is not read at
 * all, because a skipped row is indistinguishable from a leaver.
 */
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CsvHrisAdapter } from '../../src/hris/csv.ts'
import { SheetHrisAdapter } from '../../src/hris/sheet.ts'
import { deriveHrisStatus } from '../../src/hris/status.ts'
import { parseCsv, parseDate, snapshotFromRows, type TableColumns } from '../../src/hris/table.ts'
import { HrisImplausible, HrisIncomplete } from '../../src/hris/types.ts'
import type { HttpRequest, HttpResponse } from '../../src/core/http.ts'

const COLUMNS: TableColumns = {
  hrisId: 'Employee ID', primaryEmail: 'Work email', firstName: 'First name', lastName: 'Last name', displayName: null,
  department: 'Department', jobTitle: 'Job title', managerEmail: 'Manager email', personalEmail: 'Personal email',
  startDate: 'Start date', lastWorkingDay: 'Last working day', terminationDate: null, inScope: null,
}
const OPTS = { source: 'people.csv', columns: COLUMNS, dateFormat: 'YYYY-MM-DD' as const, inScopeValues: ['yes'], minPlausibleHeadcount: 1 }
const HEAD = ['Employee ID', 'First name', 'Last name', 'Work email', 'Personal email', 'Department', 'Job title', 'Manager email', 'Start date', 'Last working day']
const row = (id: string, email: string, start = '2024-01-01', leave = ''): string[] => [id, 'Jane', 'Doe', email, '', 'Finance', '', '', start, leave]

describe('reading a table of people', () => {
  it('reads the shipped example, and the dates decide who is hired, active and gone', async () => {
    const adapter = new CsvHrisAdapter({ ...OPTS, path: 'examples/people.csv', maxAgeHours: null })
    const snap = await adapter.fetchAll()
    expect(snap.all.map((p) => p.hrisId)).toEqual(['E001', 'E002', 'E003'])
    const status = Object.fromEntries(snap.all.map((p) => [p.hrisId, deriveHrisStatus(p, snap.activeIds, '2026-09-26')]))
    expect(status).toEqual({ E001: 'active', E002: 'terminated', E003: 'hired' })
    expect(snap.all[1]).toMatchObject({ displayName: 'Robin Ellis', managerEmail: 'alex.morgan@example.com', lastWorkingDay: '2026-09-25' })
  })

  it('refuses the whole table, naming each row, when any row is wrong', () => {
    const rows = [HEAD, row('E1', 'a@example.com'), row('E1', 'b@example.com'), row('E3', 'a@example.com'), row('E4', 'd@example.com', '2024-13-01'), row('E5', 'e@example.com', '2025-01-01', '2024-01-01'), row('', 'f@example.com')]
    let message = ''
    try {
      snapshotFromRows(rows, OPTS)
    } catch (err) {
      expect(err).toBeInstanceOf(HrisIncomplete)
      message = (err as Error).message
    }
    expect(message).toMatch(/row 3: id "E1" is also on row 2/)
    expect(message).toMatch(/row 4: work email is also on row 2/)
    expect(message).toMatch(/row 5: startDate "2024-13-01"/)
    expect(message).toMatch(/row 6: leaves \(2024-01-01\) before starting/)
    expect(message).toMatch(/row 7: no id/)
  })

  it('refuses a table missing a mapped column, and one below the headcount floor', () => {
    expect(() => snapshotFromRows([HEAD.filter((h) => h !== 'Department'), ['E1']], OPTS)).toThrow(/"Department"/)
    expect(() => snapshotFromRows([HEAD, row('E1', 'a@example.com')], { ...OPTS, minPlausibleHeadcount: 5 })).toThrow(HrisImplausible)
  })

  it('skips blank rows and matches headings without regard to case', () => {
    const snap = snapshotFromRows([HEAD.map((h) => h.toUpperCase()), row('E1', 'A@Example.com'), ['', '', ''], []], OPTS)
    expect(snap.all).toHaveLength(1)
    expect(snap.all[0]?.primaryEmail).toBe('a@example.com')
  })

  it('refuses a CSV older than maxAgeHours', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-csv-'))
    const path = join(dir, 'people.csv')
    await writeFile(path, [HEAD, row('E1', 'a@example.com')].map((r) => r.join(',')).join('\n'))
    const old = new Date(Date.now() - 50 * 3_600_000)
    await utimes(path, old, old)
    await expect(new CsvHrisAdapter({ ...OPTS, path, maxAgeHours: 48 }).fetchAll()).rejects.toThrow(/older than hris.table.maxAgeHours/)
    await expect(new CsvHrisAdapter({ ...OPTS, path, maxAgeHours: 72 }).fetchAll()).resolves.toMatchObject({ complete: true })
  })
})

describe('parsing', () => {
  it('handles quotes, commas and line breaks inside quotes, CRLF and a byte order mark', () => {
    expect(parseCsv('﻿a,"b, c","say ""hi"""\r\n1,"two\nlines",3\n')).toEqual([['a', 'b, c', 'say "hi"'], ['1', 'two\nlines', '3']])
    expect(() => parseCsv('a,"unfinished')).toThrow(HrisIncomplete)
  })

  it('reads dates in the one stated format, and rejects impossible ones', () => {
    expect(parseDate('2026-09-05', 'YYYY-MM-DD')).toBe('2026-09-05')
    expect(parseDate('05/09/2026', 'DD/MM/YYYY')).toBe('2026-09-05')
    expect(parseDate('09/05/2026', 'MM/DD/YYYY')).toBe('2026-09-05')
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull()
    expect(parseDate('2026-09-05', 'DD/MM/YYYY')).toBeNull()
  })
})

describe('a Google Sheet', () => {
  function sheet(responses: Record<string, HttpResponse>, maxAgeHours: number | null = null) {
    const requests: HttpRequest[] = []
    const http = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req)
        const key = Object.keys(responses).find((k) => req.url.includes(k))
        if (!key) throw new Error('no fake for ' + req.url)
        return responses[key] as HttpResponse
      },
    }
    const scopes: (string | null)[][] = []
    const auth = { tokenFor: async (scope: string, subject: string | null) => (scopes.push([scope, subject]), 'fake-bearer-value') }
    const adapter = new SheetHrisAdapter({ ...OPTS, spreadsheetId: 'sheet-1', range: 'People', maxAgeHours, http: http as never, auth: auth as never })
    return { adapter, requests, scopes }
  }
  const ok = (body: unknown): HttpResponse => ({ ok: true, status: 200, headers: {}, text: JSON.stringify(body), json: <T>() => body as T }) as unknown as HttpResponse
  const status = (code: number): HttpResponse => ({ ok: false, status: code, headers: {}, text: '', json: () => null }) as unknown as HttpResponse

  it('reads the tab as the service account itself, with the read-only scope', async () => {
    const { adapter, scopes } = sheet({ 'sheets.googleapis.com': ok({ values: [HEAD, row('E1', 'a@example.com')] }) })
    expect((await adapter.fetchAll()).all).toHaveLength(1)
    expect(scopes).toEqual([['https://www.googleapis.com/auth/spreadsheets.readonly', null]])
  })

  it('says to share the sheet when it is refused', async () => {
    const { adapter } = sheet({ 'sheets.googleapis.com': status(403) })
    await expect(adapter.fetchAll()).rejects.toThrow(/Share the sheet with the service account/)
  })

  it('refuses a sheet nobody has edited within maxAgeHours, before reading it', async () => {
    const stale = new Date(Date.now() - 100 * 3_600_000).toISOString()
    const { adapter, requests } = sheet({ 'drive/v3/files': ok({ modifiedTime: stale }), 'sheets.googleapis.com': ok({ values: [HEAD] }) }, 24)
    await expect(adapter.fetchAll()).rejects.toThrow(/last edited 100 hours ago/)
    expect(requests.some((r) => r.url.includes('sheets.googleapis.com'))).toBe(false)
  })
})
