/**
 * The default notifier: print what would be sent.
 *
 * This is the default so the toolkit is useful on the first run, before any
 * chat or mail credential exists. An adopter can watch a whole dry-run
 * lifecycle, read the exact note their leaver's manager would receive, and only
 * then decide which channel to wire up.
 *
 * It reports delivered: true because the write to the stream is the delivery,
 * and it is the one channel that can honestly say so.
 */

import type { Notification, NotificationResult, Notifier } from './types.ts'

export interface ConsoleNotifierOptions {
  /** Defaults to process.stdout.write. Injected for tests. */
  write?: (text: string) => void
  /** Prints the whole body rather than the first few lines. Default true. */
  full?: boolean
}

const PREVIEW_LINES = 12

export class ConsoleNotifier implements Notifier {
  readonly name = 'console'
  private readonly write: (text: string) => void
  private readonly full: boolean

  constructor(options: ConsoleNotifierOptions = {}) {
    this.write = options.write ?? ((text) => process.stdout.write(text))
    this.full = options.full ?? true
  }

  async send(n: Notification): Promise<NotificationResult> {
    const to = n.audience === 'manager' ? (n.managerEmail ?? 'manager address unresolved') : 'IT'
    const lines = [
      '',
      `--- notification (${n.kind}) would be sent to ${to} ---`,
      `subject: ${n.subject}`,
      '',
      this.body(n.body),
      '--- end notification ---',
      '',
    ]
    this.write(lines.join('\n'))
    return { delivered: true, channel: 'console' }
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: 'prints notifications to stdout; no credential needed and nothing leaves this machine',
    }
  }

  private body(body: string): string {
    if (this.full) return body
    const lines = body.split('\n')
    if (lines.length <= PREVIEW_LINES) return body
    const shown = lines.slice(0, PREVIEW_LINES).join('\n')
    return `${shown}\n... ${lines.length - PREVIEW_LINES} more line(s)`
  }
}

export function createConsoleNotifier(options: ConsoleNotifierOptions = {}): ConsoleNotifier {
  return new ConsoleNotifier(options)
}
