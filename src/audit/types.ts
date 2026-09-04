/**
 * The record of what this toolkit did.
 *
 * Two rows per action, not one: the intent is appended BEFORE the provider call
 * and the outcome after. A single row written afterwards cannot describe the
 * case that matters most, which is a call that was made and whose result was
 * never learned. If the intent cannot be written, the action does not happen.
 *
 * Rows are chained by hash so a deleted or edited line is detectable, and the
 * default sink is a local append-only JSONL file: an audit log that depends on
 * a network service is unavailable exactly when it is most needed.
 */

import type { Actor } from '../core/types.ts'

export interface AuditEvent {
  at: string
  runId: string
  /** `intent` before the call, `outcome` after it. */
  phase: 'intent' | 'outcome'
  actor: Actor
  /** For example `jumpcloud.suspendUser`. */
  action: string
  /** The person or device acted on. */
  subject: { kind: 'person' | 'device' | 'run'; id: string; label?: string }
  dryRun: boolean
  ok?: boolean
  verified?: boolean
  /** Redacted before it reaches here. Never carries a credential. */
  detail?: Record<string, unknown>
  /** Hash of the previous line, making the file tamper-evident. */
  prevHash?: string
  hash?: string
}

export interface AuditSink {
  readonly name: string
  /** Throws when the row cannot be persisted; the caller must not proceed. */
  append(event: AuditEvent): Promise<void>
  /** Walks the chain and reports the first line that does not verify. */
  verify?(): Promise<{ ok: boolean; checkedLines: number; firstBadLine?: number }>
  close?(): Promise<void>
}
