/**
 * Secret references and the handles they resolve to.
 *
 * No credential value ever appears in `jml.config.yaml`. Every secret field
 * holds a reference instead, in one of three grammars:
 *
 *   env:JUMPCLOUD_API_KEY          the value of that environment variable
 *   file:/run/secrets/jc-api-key   the trimmed contents of that file
 *   op://<vault>/<item>/<field>    read through the 1Password CLI
 *
 * Two rules run through the whole module.
 *
 * First, every reference resolves ONCE, at start-up. A secret that cannot be
 * resolved is a start-up failure, never a runtime null. The automation this
 * replaces read credentials lazily inside each step, so a missing one produced
 * a step that quietly did nothing and a run that reported success.
 *
 * Second, the resolved value is reachable only through `use(fn)`. It is held in
 * a closure rather than a property, so a handle cannot be stringified,
 * serialised, spread or inspected into a log by accident.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { REDACTED, registerSecretValue } from './redact.ts'

/** Where the reference grammar is documented, for every error message. */
export const SECRETS_DOCS_ANCHOR = 'docs/config-reference.md#secret-references'

/**
 * `keychain:` is reserved for a later phase and deliberately absent here: an
 * unimplemented scheme must fail the grammar rather than resolve to nothing.
 */
export const SECRET_REF_PATTERN = /^(env:[A-Z][A-Z0-9_]*|file:\/.+|op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)$/

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && SECRET_REF_PATTERN.test(value)
}

/** A resolved secret. The value is never a readable property. */
export interface SecretHandle {
  /** The reference it came from. Safe to print: it names a location. */
  readonly ref: string
  /** Length of the resolved value, so `jml doctor` can prove presence. */
  readonly length: number
  use<T>(fn: (value: string) => T): T
  toString(): string
  toJSON(): string
}

const SECRET_BRAND = Symbol('jml.secretHandle')

export function createSecretHandle(ref: string, value: string): SecretHandle {
  registerSecretValue(value)
  const handle = {
    [SECRET_BRAND]: true as const,
    ref,
    length: value.length,
    use<T>(fn: (v: string) => T): T {
      return fn(value)
    },
    toString(): string {
      return REDACTED
    },
    toJSON(): string {
      return REDACTED
    },
    // console.log and util.inspect ignore toString, so they need their own hook.
    [Symbol.for('nodejs.util.inspect.custom')](): string {
      return REDACTED
    },
  }
  return handle
}

export function isSecretHandle(value: unknown): value is SecretHandle {
  return typeof value === 'object' && value !== null && SECRET_BRAND in value
}

export class SecretResolutionError extends Error {
  readonly code = 'secret_unresolved'
  readonly ref: string
  readonly detail: string
  readonly docsAnchor: string

  constructor(ref: string, detail: string, docsAnchor: string = SECRETS_DOCS_ANCHOR) {
    // The reference names a location, not a value, so it is safe in the message.
    super('could not resolve secret reference ' + ref + ': ' + detail + '. See ' + docsAnchor)
    this.name = 'SecretResolutionError'
    this.ref = ref
    this.detail = detail
    this.docsAnchor = docsAnchor
  }
}

export interface SecretProvider {
  readonly scheme: string
  canResolve(ref: string): boolean
  /** Returns the raw value. Callers wrap it in a handle; providers never log. */
  resolve(ref: string): Promise<string>
}

export function envProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  return {
    scheme: 'env',
    canResolve: (ref) => ref.startsWith('env:'),
    async resolve(ref) {
      const name = ref.slice('env:'.length)
      const value = env[name]
      if (value === undefined) {
        throw new SecretResolutionError(ref, `environment variable ${name} is not set`)
      }
      // An empty variable is the shape a broken deployment takes: the name is
      // present in the environment file with nothing after the equals sign.
      // Treating it as a value would authenticate with an empty credential.
      if (value.trim() === '') {
        throw new SecretResolutionError(ref, `environment variable ${name} is set but empty`)
      }
      return value
    },
  }
}

export function fileProvider(): SecretProvider {
  return {
    scheme: 'file',
    canResolve: (ref) => ref.startsWith('file:'),
    async resolve(ref) {
      const path = ref.slice('file:'.length)
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new SecretResolutionError(ref, reason)
      }
      // Trailing newlines are how a secret file is normally written, and an
      // unnoticed one has broken bearer authentication before now.
      const value = text.replace(/\r?\n$/, '')
      if (value.trim() === '') throw new SecretResolutionError(ref, 'file is empty')
      return value
    },
  }
}

/** How the op provider runs the CLI. Injectable so tests never shell out. */
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>

const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
  })

/**
 * 1Password references.
 *
 * Always reference an item by its UUID rather than its title. A title
 * reference resolves until somebody renames the item, and then it fails at the
 * next scheduled run with nobody watching: a credential rename once broke a
 * nightly job that looked the item up by name.
 */
export function opProvider(runner: CommandRunner = defaultRunner): SecretProvider {
  return {
    scheme: 'op',
    canResolve: (ref) => ref.startsWith('op://'),
    async resolve(ref) {
      const { stdout, stderr, code } = await runner('op', ['read', '--no-newline', ref])
      if (code !== 0) {
        // stderr from the CLI names the item and the vault, not the value, but
        // it is trimmed to one line so a verbose failure cannot carry anything
        // unexpected into a start-up error.
        const reason = stderr.split('\n').find((l) => l.trim() !== '') ?? `op exited ${code}`
        throw new SecretResolutionError(ref, reason.trim())
      }
      const value = stdout.replace(/\r?\n$/, '')
      if (value.trim() === '') throw new SecretResolutionError(ref, 'op returned an empty value')
      return value
    },
  }
}

export function defaultProviders(env: NodeJS.ProcessEnv = process.env): SecretProvider[] {
  return [envProvider(env), fileProvider(), opProvider()]
}

export async function resolveSecret(ref: string, providers: SecretProvider[]): Promise<SecretHandle> {
  if (!isSecretRef(ref)) {
    throw new SecretResolutionError(ref, 'not a valid secret reference')
  }
  const provider = providers.find((p) => p.canResolve(ref))
  if (!provider) {
    const schemes = providers.map((p) => p.scheme).join(', ')
    throw new SecretResolutionError(ref, `no provider for this scheme (have: ${schemes})`)
  }
  const value = await provider.resolve(ref)
  return createSecretHandle(ref, value)
}

/**
 * Every secret the running process holds, addressed by its config path.
 *
 * The config object itself keeps the reference string, so `jml config show`
 * prints where a credential lives without ever touching the value.
 */
export interface SecretRegistry {
  has(path: string): boolean
  /** Throws rather than returning undefined: a caller reaching for a secret
   * that was never resolved is a wiring bug, not a runtime condition. */
  get(path: string): SecretHandle
  paths(): string[]
  /** What `jml config show` and `jml doctor` print: locations and lengths. */
  describe(): { path: string; ref: string; length: number }[]
}

export function createSecretRegistry(entries: Map<string, SecretHandle>): SecretRegistry {
  return {
    has: (path) => entries.has(path),
    get(path) {
      const handle = entries.get(path)
      if (!handle) throw new Error(`no secret resolved for config path ${path}`)
      return handle
    },
    paths: () => [...entries.keys()].sort(),
    describe: () =>
      [...entries.entries()]
        .map(([path, handle]) => ({ path, ref: handle.ref, length: handle.length }))
        .sort((a, b) => a.path.localeCompare(b.path)),
  }
}
