/**
 * Writes one audit row to several sinks.
 *
 * The asymmetry is the whole point. One sink is primary, and its failure stops
 * the step: the contract is that an action whose intent cannot be recorded does
 * not happen. Every other sink is a convenience, and its failure is counted and
 * reported in the run summary instead of aborting an offboarding halfway
 * through because a log collector was restarting.
 *
 * The primary is written FIRST for the same reason. If a remote sink went first
 * and the local write then failed, the remote log would hold a row for a step
 * that never ran, which is worse than a missing row: it is a false record.
 */

import type { AuditEvent, AuditSink } from './types.ts'

export interface FanoutAuditSinkOptions {
  /** Failure here throws, and the caller must not proceed. */
  primary: AuditSink
  /** Failure here is counted, named and carried into the run report. */
  secondary?: readonly AuditSink[]
}

export class FanoutAuditSink implements AuditSink {
  readonly name = 'fanout'
  readonly primary: AuditSink
  readonly secondary: readonly AuditSink[]
  /** Every secondary failure so far, ready to fold into RunReport.warnings. */
  private readonly failures: string[] = []

  constructor(options: FanoutAuditSinkOptions) {
    this.primary = options.primary
    this.secondary = options.secondary ?? []
  }

  get secondaryFailures(): number {
    return this.failures.length
  }

  /** The accumulated warnings. Read once per run and put in the RunReport. */
  warnings(): string[] {
    return [...this.failures]
  }

  async append(event: AuditEvent): Promise<void> {
    await this.primary.append(event)
    for (const sink of this.secondary) {
      try {
        await sink.append(event)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.failures.push(`audit sink ${sink.name} did not accept a row: ${message}`)
      }
    }
  }

  /** Only the primary is verifiable; a remote sink cannot prove its own chain. */
  async verify(): Promise<{
    ok: boolean
    checkedLines: number
    firstBadLine?: number
    reason?: string
  }> {
    if (!this.primary.verify) {
      // Reported rather than assumed good: "nothing to check" and "checked and
      // sound" must not look the same to whoever ran the check.
      return { ok: false, checkedLines: 0, reason: `sink ${this.primary.name} cannot verify itself` }
    }
    return this.primary.verify()
  }

  async close(): Promise<void> {
    for (const sink of [this.primary, ...this.secondary]) {
      if (sink.close) await sink.close()
    }
  }
}

export function createFanoutAuditSink(options: FanoutAuditSinkOptions): FanoutAuditSink {
  return new FanoutAuditSink(options)
}
