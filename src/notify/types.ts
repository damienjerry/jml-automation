/**
 * Telling people what happened.
 *
 * `delivered` is separate from `ok` for one reason: chat APIs answer 200 with a
 * failure in the body. Three workflows in the automation this replaces posted
 * nothing for weeks while every run recorded success, because nobody checked
 * the body. A notifier that cannot prove delivery reports delivered: false, and
 * the run is not ok.
 */

export type NotificationKind =
  | 'leaver.day0'
  | 'leaver.day6'
  | 'leaver.day7'
  | 'leaver.blocked'
  | 'leaver.parked'
  | 'run.summary'
  | 'run.aborted'
  | 'device.report'
  | 'doctor.changed'
  | 'joiner.password'
  | 'joiner.welcome'
  | 'joiner.manager'
  | 'joiner.refused'
  | 'joiner.withheld'

export interface Notification {
  kind: NotificationKind
  subject: string
  body: string
  /** Who this is for: the IT owner, or the leaver's manager. */
  audience: 'it' | 'manager'
  managerEmail?: string | null
  /**
   * Explicit addresses, for the joiner path where a message goes to a personal
   * address that is nobody's manager. A mail notifier sends to these instead
   * of its route; a chat notifier ignores them and delivers to its channel.
   */
  recipients?: string[] | null
  detail?: Record<string, unknown>
}

export interface NotificationResult {
  /** Proven delivered: a 2xx AND a success body. */
  delivered: boolean
  channel: string
  error?: string
}

export interface Notifier {
  readonly name: string
  send(n: Notification): Promise<NotificationResult>
  testConnection(): Promise<{ ok: boolean; detail: string; remediation?: string }>
}
