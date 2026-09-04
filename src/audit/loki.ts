/**
 * An optional second audit sink that pushes to Loki.
 *
 * Off unless an adopter configures it. The local JSONL file is the record; this
 * is for organisations that already keep their operational logs in one place
 * and want the lifecycle trail beside them.
 *
 * Two things about the original are deliberately not reproduced.
 *
 * It pushed unauthenticated, on the grounds that the log service was only
 * reachable on a private network. An audit row names a person, their address
 * and their manager, so "the network is private" is a deployment assumption
 * that ages badly and cannot be checked from here. Authentication is therefore a
 * config field rather than an assumption, and an adopter who genuinely has an
 * unauthenticated collector must say so by leaving it unset.
 *
 * It also swallowed every failure in a `catch {}`, so a broken audit push was
 * invisible for as long as it lasted. This sink throws, and the fanout sink
 * decides that a secondary failure is a counted warning rather than an abort.
 */

import type { HttpClient } from '../core/http.ts'

/**
 * The one method this module calls. Narrowed from the shared client rather
 * than redeclared, so it cannot drift from it, and so a test supplies one
 * function instead of a whole client.
 */
export type HttpPoster = Pick<HttpClient, 'post'>
import { redact, redactDeep } from '../config/redact.ts'
import type { SecretHandle } from '../config/secrets.ts'
import type { AuditEvent, AuditSink } from './types.ts'
import { canonicalJson, type RedactFn } from './jsonl.ts'

export type LokiAuth =
  | { kind: 'bearer'; secret: SecretHandle }
  | { kind: 'basic'; username: string; secret: SecretHandle }

export interface LokiAuditSinkOptions {
  /** Base URL of the Loki write endpoint, without a path. */
  baseUrl: string
  /** The shared client, which keeps a non-2xx body instead of losing it. */
  http: HttpPoster
  /** Unset means an unauthenticated push, which the adopter has chosen. */
  auth?: LokiAuth
  /**
   * Stream labels. Kept low-cardinality on purpose: a label per person would
   * both wreck the index and put names into label values, which are readable
   * far more widely than log content in most deployments.
   */
  labels?: Record<string, string>
  timeoutMs?: number
  /** Override only in a test; the default is the shared redaction registry. */
  redact?: RedactFn
  now?: () => number
}

export class LokiPushError extends Error {
  readonly code = 'loki_push_failed'
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
    this.name = 'LokiPushError'
  }
}

export class LokiAuditSink implements AuditSink {
  readonly name = 'loki'
  private readonly baseUrl: string
  private readonly http: HttpPoster
  private readonly auth: LokiAuth | undefined
  private readonly labels: Record<string, string>
  private readonly timeoutMs: number
  private readonly redact: RedactFn
  private readonly now: () => number
  private lastMillis = 0
  private withinMillis = 0

  constructor(options: LokiAuditSinkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.http = options.http
    this.auth = options.auth
    this.labels = options.labels ?? { job: 'jml_audit' }
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.redact = options.redact ?? ((detail) => redactDeep(detail))
    this.now = options.now ?? (() => Date.now())
  }

  async append(event: AuditEvent): Promise<void> {
    const row: AuditEvent = { ...event }
    if (row.detail) row.detail = this.redact(row.detail)
    const payload = {
      streams: [
        {
          stream: { ...this.labels, phase: row.phase },
          values: [[this.nanosecondTimestamp(), canonicalJson(row)]],
        },
      ],
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.auth) headers['authorization'] = this.authorisationHeader(this.auth)

    let status: number
    let body: string
    try {
      const response = await this.http.post(`${this.baseUrl}/loki/api/v1/push`, payload, {
        headers,
        timeoutMs: this.timeoutMs,
        label: 'loki.push',
        // A push is a plain append, so repeating one costs a duplicate line at
        // worst and is worth it against losing the row.
        retryOn5xx: true,
      })
      status = response.status
      body = response.body
    } catch (err) {
      throw new LokiPushError(`Loki push failed: ${this.scrub(describe(err))}`)
    }
    if (!(status >= 200 && status < 300)) {
      // A rejected push often quotes what it was sent, credential included, so
      // the body goes through redaction before it reaches an error message that
      // somebody will paste into a ticket.
      throw new LokiPushError(`Loki push failed with status ${status}: ${this.scrub(body)}`, status)
    }
  }

  /**
   * Loki timestamps are nanoseconds, and it drops a second entry with the same
   * timestamp in the same stream. The clock here has millisecond resolution, so
   * rows written inside one millisecond are separated by a counter rather than
   * being silently lost.
   */
  private nanosecondTimestamp(): string {
    const millis = this.now()
    if (millis === this.lastMillis) this.withinMillis++
    else {
      this.lastMillis = millis
      this.withinMillis = 0
    }
    return (BigInt(millis) * 1_000_000n + BigInt(this.withinMillis)).toString()
  }

  private authorisationHeader(auth: LokiAuth): string {
    if (auth.kind === 'bearer') return auth.secret.use((value) => 'Bearer ' + value)
    return auth.secret.use(
      (value) => 'Basic ' + Buffer.from(`${auth.username}:${value}`, 'utf8').toString('base64'),
    )
  }

  /** Belt and braces: the client redacts a body, and so does this. */
  private scrub(text: string): string {
    const redacted = this.redact({ text: redact(text) })
    return typeof redacted.text === 'string' ? redacted.text : '[redacted]'
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createLokiAuditSink(options: LokiAuditSinkOptions): LokiAuditSink {
  return new LokiAuditSink(options)
}
