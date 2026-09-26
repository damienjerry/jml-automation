/**
 * People from a Google Sheet that somebody keeps up to date.
 *
 * The sheet is shared with the service account's own address (as a viewer) and
 * read with the read-only Sheets scope, as the service account itself: no
 * delegation, no administrator impersonated. It is never written to.
 *
 * The rules live in table.ts. Staleness is checked from the file's last edit
 * time in Drive, when `hris.table.maxAgeHours` is set: a sheet nobody has
 * touched for a fortnight is more likely forgotten than accurate.
 */

import type { HttpClient } from '../core/http.ts'
import type { GoogleAuth } from '../connectors/google/auth.ts'
import { GOOGLE_SCOPES } from '../connectors/google/scopes.ts'
import { HrisIncomplete, type ConnectionCheck, type HrisAdapter, type HrisSnapshot } from './types.ts'
import { snapshotFromRows, type TableOptions } from './table.ts'

export interface SheetAdapterOptions extends Omit<TableOptions, 'source'> {
  spreadsheetId: string
  /** A tab name, or an A1 range such as `People!A1:Z`. */
  range: string
  maxAgeHours: number | null
  http: HttpClient
  auth: GoogleAuth
  now?: () => number
}

export class SheetHrisAdapter implements HrisAdapter {
  readonly name = 'sheet'
  private readonly opts: SheetAdapterOptions

  constructor(opts: SheetAdapterOptions) {
    this.opts = opts
  }

  private get source(): string {
    return `the Google Sheet ${this.opts.spreadsheetId} (${this.opts.range})`
  }

  async fetchAll(): Promise<HrisSnapshot> {
    const { spreadsheetId, range, maxAgeHours, http, auth } = this.opts
    if (maxAgeHours !== null) {
      const token = await auth.tokenFor(GOOGLE_SCOPES.driveReadonly, null)
      const meta = await http.request({
        method: 'GET',
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}`,
        query: { fields: 'modifiedTime', supportsAllDrives: 'true' },
        headers: { authorization: 'Bearer ' + token },
      })
      const modified = Date.parse(meta.ok ? (meta.json<{ modifiedTime?: string }>()?.modifiedTime ?? '') : '')
      if (Number.isNaN(modified)) {
        throw new HrisIncomplete(`the last edit time of ${this.source} could not be read (status ${meta.status}), so its age is unknown and it was not used. Share the sheet with the service account, or unset hris.table.maxAgeHours.`)
      }
      const ageHours = ((this.opts.now ?? Date.now)() - modified) / 3_600_000
      if (ageHours > maxAgeHours) {
        throw new HrisIncomplete(`${this.source} was last edited ${Math.floor(ageHours)} hours ago, older than hris.table.maxAgeHours (${maxAgeHours}). Nothing was read from it.`)
      }
    }

    const token = await auth.tokenFor(GOOGLE_SCOPES.spreadsheetsReadonly, null)
    const res = await http.request({
      method: 'GET',
      url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      // Formatted values, so a date cell reads as the date a person sees
      // rather than a spreadsheet serial number.
      query: { valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' },
      headers: { authorization: 'Bearer ' + token },
    })
    if (!res.ok) {
      const hint = res.status === 403 || res.status === 404 ? ' Share the sheet with the service account address as a viewer.' : ''
      throw new HrisIncomplete(`reading ${this.source} answered ${res.status}.${hint}`)
    }
    const values = res.json<{ values?: unknown[][] }>()?.values ?? []
    const rows = values.map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))))
    return snapshotFromRows(rows, { ...this.opts, source: this.source })
  }

  async testConnection(): Promise<ConnectionCheck> {
    try {
      const snapshot = await this.fetchAll()
      return { ok: true, detail: `${this.source}: ${snapshot.all.length} people read`, docsAnchor: 'docs/adapters/hris-table.md' }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), remediation: 'Share the sheet with the service account, and check hris.table.columns against the heading row.', docsAnchor: 'docs/adapters/hris-table.md' }
    }
  }
}
