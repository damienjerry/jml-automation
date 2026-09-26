/**
 * The two files `jml setup` edits, and the one it keeps for itself.
 *
 * `jml.config.yaml` is edited in place with its comments kept, because every
 * key carries its own documentation and a wizard that threw that away would
 * hand the operator a file they can no longer read. It only ever receives
 * non-secret values and references.
 *
 * `.env` receives the values. Each is written single-quoted, which is the one
 * form both a shell (`set -a; . ./.env`) and Docker Compose's `env_file` read
 * back byte for byte, so a Google key in minified JSON survives both. A value
 * that itself contains a single quote or a newline is refused rather than
 * escaped, because neither reader agrees on an escape.
 *
 * `data/setup-state.json` records which steps are done and the non-secret
 * things a re-run needs: 1Password references and n8n credential ids. It
 * never holds a value.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseDocument } from 'yaml'

export class EnvValueError extends Error {}

/** Parse `.env` into a map. Unquotes single- and double-quoted values; ignores comments. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/** Set KEY in `.env`, replacing an existing line or appending one. Mode stays 600. */
export async function setEnv(path: string, name: string, value: string): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new EnvValueError(`${name} is not a valid environment variable name`)
  if (value.includes("'") || value.includes('\n') || value.includes('\r')) {
    throw new EnvValueError(`the value for ${name} contains a quote or a line break, which .env cannot hold safely; use a file or a 1Password reference instead`)
  }
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = ''
  }
  const line = `${name}='${value}'`
  const pattern = new RegExp('^' + name + '=.*$', 'm')
  // A function replacer, so a `$` in a secret is never read as a pattern.
  text = pattern.test(text) ? text.replace(pattern, () => line) : text.replace(/\n?$/, '\n') + line + '\n'
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
  // writeFile's mode applies only when the file is created.
  await chmod(path, 0o600)
}

/** Set values in the YAML config, keeping every comment. Paths are arrays of keys. */
export async function setConfig(path: string, values: [readonly (string | number)[], unknown][]): Promise<void> {
  const doc = parseDocument(await readFile(path, 'utf8'))
  for (const [keyPath, value] of values) doc.setIn(keyPath, value)
  if (doc.errors.length > 0) throw new Error(`could not edit ${path}: ${doc.errors[0]?.message}`)
  await writeFile(path, String(doc), 'utf8')
}

export async function getConfig(path: string, keyPath: readonly (string | number)[]): Promise<unknown> {
  const doc = parseDocument(await readFile(path, 'utf8'))
  const value = doc.getIn(keyPath)
  return value && typeof value === 'object' && 'toJSON' in value ? (value as { toJSON(): unknown }).toJSON() : value
}

export const STEPS = ['prerequisites', 'configuration', 'credentials', 'doctor', 'bootstrap', 'compose', 'n8n'] as const
export type StepName = (typeof STEPS)[number]

export interface SetupState {
  version: 1
  completed: StepName[]
  /** 1Password references the operator gave, by environment variable. References, never values. */
  references: Record<string, string>
  /** n8n credential ids from an earlier import, so a re-run does not duplicate them. */
  n8nCredentialIds: Record<string, string>
}

export function emptyState(): SetupState {
  return { version: 1, completed: [], references: {}, n8nCredentialIds: {} }
}

export async function loadState(path: string): Promise<SetupState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SetupState>
    return { ...emptyState(), ...parsed, version: 1 }
  } catch {
    return emptyState()
  }
}

export async function saveState(path: string, state: SetupState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
}
