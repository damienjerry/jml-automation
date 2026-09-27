/**
 * Sending a notification as mail, through the Google connector.
 *
 * Mail is the channel that matters for the manager note, because it is the one
 * the manager already reads and can keep. The connector owns the credential and
 * the send-as detail; this file only decides who a notification is addressed to
 * and whether the provider accepted it.
 *
 * On what `delivered` means here. Mail cannot be read back, so the strongest
 * available evidence is that the provider accepted the message for delivery.
 * That is recorded as delivery and nothing stronger is implied: a bounce
 * afterwards is invisible to this toolkit, which is why the day-0 note is also
 * summarised to the IT channel.
 */

import type { GoogleWorkspaceConnector } from '../connectors/types.ts'
import type { Outcome } from '../core/types.ts'
import type { ConnectionCheck } from '../hris/types.ts'
import type { Notification, NotificationResult, Notifier } from './types.ts'

/**
 * The slice of the Google connector this notifier uses.
 *
 * Two methods, taken from the connector's own interface, so a test needs a
 * two-method stub rather than a whole fake Workspace and this file cannot
 * quietly grow a second responsibility.
 */
export type MailSender = Pick<GoogleWorkspaceConnector, 'sendMail' | 'testConnection'>

export interface EmailNotifierOptions {
  google: MailSender
  /** Where an IT-audience notification goes. At least one address. */
  itRecipients: readonly string[]
}

/**
 * There is deliberately no bcc option here. The connector's `sendMail` takes a
 * recipient list and nothing else, so a bcc field would be config that looks
 * honoured and is not. If a shared copy is wanted, add the address to the IT
 * recipients or widen the connector.
 */

export class EmailNotifier implements Notifier {
  readonly name = 'email'
  private readonly google: MailSender
  private readonly itRecipients: readonly string[]

  constructor(options: EmailNotifierOptions) {
    this.google = options.google
    this.itRecipients = options.itRecipients
  }

  async send(n: Notification): Promise<NotificationResult> {
    const to = this.recipients(n)
    if (to.length === 0) {
      // Reported, never skipped. In an earlier design, an
      // unresolvable manager address meant the note was quietly dropped while
      // the offboarding carried on to permanent deletion a week later.
      return {
        delivered: false,
        channel: 'email',
        error:
          n.audience === 'manager'
            ? 'no manager address on this notification, so nobody was told'
            : 'no IT recipient configured, so nobody was told',
      }
    }

    let outcome: Outcome
    try {
      outcome = await this.google.sendMail({ to: [...to], subject: n.subject, body: n.body })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { delivered: false, channel: 'email', error: `send failed: ${message}` }
    }
    if (!outcome.ok) {
      return {
        delivered: false,
        channel: 'email',
        error: outcome.error ?? 'the mail provider refused the message without saying why',
      }
    }
    return { delivered: true, channel: `email:${to.length} recipient(s)` }
  }

  async testConnection(): Promise<ConnectionCheck> {
    const check = await this.google.testConnection()
    if (check.ok && this.itRecipients.length === 0) {
      return {
        ok: false,
        detail: 'the mail credential works, but no IT recipient is configured',
        remediation: 'set at least one IT recipient address in the notify section of the config',
      }
    }
    return check
  }

  private recipients(n: Notification): string[] {
    if (n.recipients && n.recipients.length > 0) return n.recipients.map((r) => r.trim()).filter((r) => r.length > 0)
    if (n.audience === 'manager') {
      const manager = n.managerEmail?.trim()
      return manager ? [manager] : []
    }
    return [...this.itRecipients]
  }
}

export function createEmailNotifier(options: EmailNotifierOptions): EmailNotifier {
  return new EmailNotifier(options)
}
