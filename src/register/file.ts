/**
 * A register read from a file: JSON, or CSV with a header row.
 *
 * Columns are matched by header label, configurable, so an export from any
 * register product works without being reshaped first. An owner cell may hold
 * several addresses separated by commas, semicolons or spaces.
 */

import { readFile } from 'node:fs/promises'
import type { RegisterPlatform, SaasRegisterAdapter } from './types.ts'

export interface FileRegisterOptions {
  path: string
  nameColumn?: string
  ownerColumn?: string
  handlingColumn?: string
}

export class FileRegisterAdapter implements SaasRegisterAdapter {
  readonly name = 'file'
  private readonly path: string
  private readonly nameColumn: string
  private readonly ownerColumn: string
  private readonly handlingColumn: string

  constructor(options: FileRegisterOptions) {
    this.path = options.path
    this.nameColumn = options.nameColumn ?? 'Software'
    this.ownerColumn = options.ownerColumn ?? 'Owner Email'
    this.handlingColumn = options.handlingColumn ?? 'Offboarding'
  }

  async listPlatforms(): Promise<RegisterPlatform[]> {
    const text = await readFile(this.path, 'utf8')
    const rows = this.path.toLowerCase().endsWith('.json') ? parseJson(text) : parseCsv(text)
    const out: RegisterPlatform[] = []
    for (const row of rows) {
      const name = (row[this.nameColumn] ?? '').trim()
      if (!name) continue
      out.push({
        name,
        owners: splitOwners(row[this.ownerColumn] ?? ''),
        handling: (row[this.handlingColumn] ?? '').trim(),
      })
    }
    return out
  }
}

export function splitOwners(cell: string): string[] {
  return [...new Set(cell.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@')))]
}

function parseJson(text: string): Record<string, string>[] {
  const parsed: unknown = JSON.parse(text)
  const list = Array.isArray(parsed) ? parsed : (parsed as { platforms?: unknown })?.platforms
  if (!Array.isArray(list)) throw new Error('a JSON register must be an array of rows, or an object with a "platforms" array')
  return list.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')])))
}

/** A small CSV reader: quoted fields, doubled quotes, CRLF. Enough for a register export. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = splitLines(text)
  if (lines.length === 0) return []
  const headers = lines[0]!.map((h) => h.trim())
  return lines.slice(1).filter((cells) => cells.some((c) => c.trim() !== '')).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])))
}

function splitLines(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}
