/**
 * The default audit sink: one append-only JSONL file per day.
 *
 * Local first, deliberately. An audit log that lives in a network service is
 * unavailable exactly when it is most needed, and the automation this was
 * ported from pushed its only record of what it had done to a log service on a
 * best-effort basis, inside a `catch {}`. So the file is opened with O_APPEND,
 * every line is fsynced before the call it describes is allowed to happen, and
 * a write that fails throws rather than degrading.
 *
 * Every line carries the hash of the line before it. That does not stop anybody
 * editing the file, but it does mean an edited or deleted line cannot be hidden:
 * `verify()` walks the chain and names the first line that does not follow from
 * its predecessor.
 */

import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { redactDeep } from '../config/redact.ts'
import type { AuditEvent, AuditSink } from './types.ts'

/** Applied to `detail` before it is written. */
export type RedactFn = (detail: Record<string, unknown>) => Record<string, unknown>

export interface JsonlAuditSinkOptions {
  /** Directory the daily files live in. Created if it does not exist. */
  dir: string
  /**
   * Returns today's date as YYYY-MM-DD in the organisation's timezone.
   *
   * Injected rather than computed, because a local midnight formatted through
   * UTC lands on the previous calendar day in any zone ahead of UTC, which is
   * how a run once filed its evidence under yesterday.
   */
  today?: () => string
  /**
   * Replaces the default redactor, which is the process-wide registry every
   * resolved secret registers itself with. Override only in a test.
   */
  redact?: RedactFn
  /** Off only for tests that write thousands of rows. */
  fsync?: boolean
}

/**
 * The audit log could not be written, so the step it described must not run.
 *
 * A distinct error type because the pipeline treats it as an abort reason
 * rather than as one failed leg among many.
 */
export class AuditUnavailableError extends Error {
  readonly code = 'audit_unavailable'
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'AuditUnavailableError'
  }
}

/** First link in the chain. Any chain that does not start here is not ours. */
export const GENESIS_HASH = sha256('jml-audit-chain-v1')

const FILE_PATTERN = /^jml-\d{4}-\d{2}-\d{2}\.jsonl$/

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Stable serialisation.
 *
 * The hash has to be reproducible by a reader who only has the file, so keys
 * are sorted, `undefined` is dropped rather than becoming `null`, and anything
 * carrying `toJSON` is asked for its own representation. That last part is what
 * makes a SecretHandle serialise as its redacted form even if one is handed to
 * the sink by mistake.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const withToJson = value as { toJSON?: () => unknown }
  if (typeof withToJson.toJSON === 'function') return canonical(withToJson.toJSON())
  if (Array.isArray(value)) return value.map(canonical)
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue
    out[key] = canonical(source[key])
  }
  return out
}

/** Hash the row as it will be verified: everything except the hash itself. */
function hashRow(row: AuditEvent): string {
  const withoutHash: Record<string, unknown> = { ...row }
  delete withoutHash['hash']
  return sha256(canonicalJson(withoutHash))
}

export interface AuditVerifyResult {
  ok: boolean
  checkedLines: number
  /** 1-based, within `firstBadFile`. */
  firstBadLine?: number
  firstBadFile?: string
  reason?: string
}

export class JsonlAuditSink implements AuditSink {
  readonly name = 'jsonl'
  private readonly dir: string
  private readonly today: () => string
  private readonly redact: RedactFn
  private readonly doFsync: boolean
  private handle: FileHandle | null = null
  private handlePath: string | null = null
  private prevHash = GENESIS_HASH
  /** Serialises appends. See `append`. */
  private queue: Promise<void> = Promise.resolve()

  constructor(options: JsonlAuditSinkOptions) {
    this.dir = options.dir
    this.today = options.today ?? (() => new Date().toISOString().slice(0, 10))
    // The default is the shared registry rather than a list passed in here: a
    // credential usually escapes through a body somebody else serialised, and
    // that call site does not know it is holding a secret.
    this.redact = options.redact ?? ((detail) => redactDeep(detail))
    this.doFsync = options.fsync ?? true
  }

  /** The file today's rows are appended to. */
  currentFile(): string {
    return join(this.dir, `jml-${this.today()}.jsonl`)
  }

  /**
   * Append one row.
   *
   * Appends are serialised through a queue rather than run as they arrive. Two
   * overlapping calls would read the same previous hash and write two lines
   * claiming the same predecessor, which breaks the chain for every later
   * reader and looks exactly like tampering.
   */
  async append(event: AuditEvent): Promise<void> {
    const mine = this.queue.then(
      () => this.appendNow(event),
      () => this.appendNow(event),
    )
    this.queue = mine.then(
      () => undefined,
      () => undefined,
    )
    return mine
  }

  private async appendNow(event: AuditEvent): Promise<void> {
    const path = this.currentFile()
    let hash: string
    try {
      await mkdir(this.dir, { recursive: true })
      if (this.handlePath !== path) {
        await this.close()
        // Continue the chain from whatever is already on disk, so restarting
        // the process does not silently start a second chain in the same file.
        this.prevHash = await lastHashBefore(this.dir, path)
        this.handle = await open(path, 'a')
        this.handlePath = path
      }
      // A hash or a previous hash supplied by the caller is discarded: the
      // chain is the sink's to compute, or it proves nothing.
      const row: AuditEvent = { ...event, prevHash: this.prevHash }
      delete row.hash
      if (row.detail) row.detail = this.redact(row.detail)
      hash = hashRow(row)
      row.hash = hash
      const handle = this.handle
      if (!handle) throw new Error('audit file handle missing after open')
      await handle.write(`${canonicalJson(row)}\n`)
      if (this.doFsync) await handle.sync()
    } catch (err) {
      // The caller's contract is that a step whose intent cannot be recorded
      // does not run, so this must throw rather than return.
      throw new AuditUnavailableError(`could not append to the audit log at ${path}`, err)
    }
    this.prevHash = hash
  }

  /** Walk every daily file in date order and report the first broken link. */
  async verify(): Promise<AuditVerifyResult> {
    let files: string[]
    try {
      files = (await readdir(this.dir)).filter((f) => FILE_PATTERN.test(f)).sort()
    } catch (err) {
      throw new AuditUnavailableError(`could not read the audit directory ${this.dir}`, err)
    }
    let expected = GENESIS_HASH
    let checkedLines = 0
    for (const file of files) {
      const text = await readFile(join(this.dir, file), 'utf8')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i] ?? ''
        if (raw.trim() === '') continue
        checkedLines++
        const position = { checkedLines, firstBadLine: i + 1, firstBadFile: file }
        let row: AuditEvent
        try {
          row = JSON.parse(raw) as AuditEvent
        } catch {
          return { ok: false, ...position, reason: 'line is not valid JSON' }
        }
        if (row.prevHash !== expected) {
          return { ok: false, ...position, reason: 'previous-line hash does not match' }
        }
        if (row.hash !== hashRow(row)) {
          return { ok: false, ...position, reason: 'line content does not match its own hash' }
        }
        expected = row.hash
      }
    }
    return { ok: true, checkedLines }
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.handlePath = null
    if (handle) await handle.close()
  }
}

/**
 * The hash the next line must quote.
 *
 * Today's file when it already has rows, otherwise the newest earlier file, so
 * the chain runs across day boundaries and a missing day cannot be used to
 * restart it.
 */
async function lastHashBefore(dir: string, path: string): Promise<string> {
  const target = basename(path)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((f) => FILE_PATTERN.test(f) && f <= target).sort()
  } catch {
    return GENESIS_HASH
  }
  for (const name of names.reverse()) {
    const text = await readFile(join(dir, name), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    const last = lines[lines.length - 1]
    if (!last) continue
    try {
      const row = JSON.parse(last) as AuditEvent
      if (typeof row.hash === 'string') return row.hash
    } catch {
      // A corrupt tail is left for verify() to report; carrying on from the
      // genesis hash here would quietly paper over it.
      return GENESIS_HASH
    }
  }
  return GENESIS_HASH
}

export function createJsonlAuditSink(options: JsonlAuditSinkOptions): JsonlAuditSink {
  return new JsonlAuditSink(options)
}
