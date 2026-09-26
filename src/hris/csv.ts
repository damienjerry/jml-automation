/**
 * People from a CSV file: an export from an HR system, or a list kept by hand.
 *
 * The rules live in table.ts; this reads the file and checks its age. An old
 * export is refused when `hris.table.maxAgeHours` is set, because a file that
 * stopped being refreshed still parses, and every starter and leaver since the
 * last export would be invisible.
 */

import { readFile, stat } from 'node:fs/promises'
import { HrisIncomplete, type ConnectionCheck, type HrisAdapter, type HrisSnapshot } from './types.ts'
import { parseCsv, snapshotFromRows, type TableOptions } from './table.ts'

export interface CsvAdapterOptions extends Omit<TableOptions, 'source'> {
  path: string
  maxAgeHours: number | null
  now?: () => number
}

export class CsvHrisAdapter implements HrisAdapter {
  readonly name = 'csv'
  private readonly opts: CsvAdapterOptions

  constructor(opts: CsvAdapterOptions) {
    this.opts = opts
  }

  async fetchAll(): Promise<HrisSnapshot> {
    const { path, maxAgeHours } = this.opts
    let text: string
    let modified: number
    try {
      ;[text, modified] = await Promise.all([readFile(path, 'utf8'), stat(path).then((s) => s.mtimeMs)])
    } catch (err) {
      throw new HrisIncomplete(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (maxAgeHours !== null) {
      const ageHours = ((this.opts.now ?? Date.now)() - modified) / 3_600_000
      if (ageHours > maxAgeHours) {
        throw new HrisIncomplete(`${path} was last changed ${Math.floor(ageHours)} hours ago, older than hris.table.maxAgeHours (${maxAgeHours}). Refresh the export; nothing was read from a stale file.`)
      }
    }
    return snapshotFromRows(parseCsv(text), { ...this.opts, source: path })
  }

  async testConnection(): Promise<ConnectionCheck> {
    try {
      const snapshot = await this.fetchAll()
      return { ok: true, detail: `${this.opts.path}: ${snapshot.all.length} people read, no credential required`, docsAnchor: 'docs/adapters/hris-table.md' }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), remediation: 'Fix the rows named above, or the column map in hris.table.columns.', docsAnchor: 'docs/adapters/hris-table.md' }
    }
  }
}
