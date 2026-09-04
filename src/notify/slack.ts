/**
 * Posting to a chat channel with a bot token.
 *
 * One rule matters more than the rest of this file: this API answers HTTP 200
 * with the failure in the body. Three workflows in the automation this replaces
 * posted nothing for weeks while every run was recorded as a success, because
 * the transport status was checked and `ok` in the body was not. So a post
 * counts as delivered only on a 2xx AND `ok === true`, and anything else is
 * reported as undelivered with the body's own error string, which is the part
 * that tells an operator what to fix.
 *
 * The second rule is about the error that reads like something else.
 * Channel membership is per bot: a bot that is not in a private channel gets
 * `channel_not_found`, which looks exactly like a mistyped channel id. Another
 * bot being in that channel proves nothing. `jml doctor` therefore probes
 * membership for this token specifically, and the remediation text says so.
 */

import type { SecretHandle } from '../config/secrets.ts'
import type { HttpClient } from '../core/http.ts'

/**
 * The one method this module calls. Narrowed from the shared client rather
 * than redeclared, so it cannot drift from it, and so a test supplies one
 * function instead of a whole client.
 */
export type HttpPoster = Pick<HttpClient, 'post'>
import type { Notification, NotificationResult, Notifier } from './types.ts'

export interface SlackNotifierOptions {
  /** Bot token. Needs chat:write and nothing else for the default flow. */
  botToken: SecretHandle
  /** Channel that IT notifications go to. */
  itChannelId: string
  /** The shared client, which keeps a non-2xx body instead of losing it. */
  http: HttpPoster
  baseUrl?: string
  timeoutMs?: number
  /**
   * Allow `testConnection` to schedule and immediately delete a message.
   *
   * Membership cannot be proven by any read this token is meant to hold, so the
   * only honest probe is a write that is undone. It is off by default because a
   * check that writes is a surprise, and `jml doctor --probe-writes` is the
   * explicit way to ask for it.
   */
  probeWrites?: boolean
  now?: () => number
}

interface SlackBody {
  ok?: boolean
  error?: string
  needed?: string
  provided?: string
  channel?: string
  ts?: string
  scheduled_message_id?: string
  team?: string
  bot_id?: string
}

/** How far ahead a probe message is scheduled before being deleted again. */
const PROBE_DELAY_SECONDS = 300

export class SlackNotifier implements Notifier {
  readonly name = 'slack'
  private readonly botToken: SecretHandle
  private readonly itChannelId: string
  private readonly http: HttpPoster
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly probeWrites: boolean
  private readonly now: () => number

  constructor(options: SlackNotifierOptions) {
    this.botToken = options.botToken
    this.itChannelId = options.itChannelId
    this.http = options.http
    this.baseUrl = (options.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.probeWrites = options.probeWrites ?? false
    this.now = options.now ?? (() => Date.now())
  }

  async send(n: Notification): Promise<NotificationResult> {
    const channel = this.itChannelId
    // A manager note routed here still says who it was for, so a reader cannot
    // mistake it for something addressed to the IT channel.
    const intendedFor =
      n.audience === 'manager' ? `\n(intended for the line manager: ${n.managerEmail ?? 'unresolved'})` : ''
    const text = `*${n.subject}*\n${n.body}${intendedFor}`
    const call = await this.call('chat.postMessage', { channel, text })
    if (!call.ok) {
      return { delivered: false, channel: `slack:${channel}`, error: call.error }
    }
    return { delivered: true, channel: `slack:${channel}` }
  }

  async testConnection(): Promise<{ ok: boolean; detail: string; remediation?: string }> {
    const auth = await this.call('auth.test', {})
    if (!auth.ok) {
      return {
        ok: false,
        detail: `the bot token was rejected: ${auth.error}`,
        remediation:
          'check the token is the bot token (it is issued under OAuth and Permissions, and is not the user token or the SCIM token) and that the app is still installed',
      }
    }
    if (!this.probeWrites) {
      return {
        ok: true,
        detail:
          'the bot token is valid; channel membership is NOT checked, because proving it needs a write. Re-run with the write probe enabled to check it',
      }
    }
    const probe = await this.probeChannelMembership(this.itChannelId)
    return probe.ok
      ? { ok: true, detail: `the bot token is valid and this bot can post to ${this.itChannelId}` }
      : {
          ok: false,
          detail: probe.detail,
          ...(probe.remediation ? { remediation: probe.remediation } : {}),
        }
  }

  /**
   * Prove this bot can post to a channel, without posting anything visible.
   *
   * Schedule a message far enough ahead to be cancellable, then delete it. A
   * `channel_not_found` here means this bot is not in the channel, not that the
   * id is wrong, which is the misreading that costs an afternoon.
   */
  async probeChannelMembership(
    channelId: string,
  ): Promise<{ ok: boolean; detail: string; remediation?: string }> {
    const postAt = Math.floor(this.now() / 1000) + PROBE_DELAY_SECONDS
    const scheduled = await this.call('chat.scheduleMessage', {
      channel: channelId,
      post_at: postAt,
      text: 'jml doctor connection probe; this message is deleted immediately',
    })
    if (!scheduled.ok) {
      return {
        ok: false,
        detail: `this bot cannot post to ${channelId}: ${scheduled.error}`,
        remediation:
          scheduled.body.error === 'channel_not_found'
            ? 'invite THIS bot to the channel. Membership is per bot, so another bot posting there proves nothing, and a private channel the bot is not in reports the same error as a wrong id'
            : 'check the channel id and that the bot token carries chat:write',
      }
    }
    const id = scheduled.body.scheduled_message_id
    if (!id) {
      return {
        ok: false,
        detail: `the probe message was accepted for ${channelId} but no id came back, so it could not be withdrawn`,
        remediation: 'delete the scheduled message by hand before the send time',
      }
    }
    const deleted = await this.call('chat.deleteScheduledMessage', {
      channel: channelId,
      scheduled_message_id: id,
    })
    if (!deleted.ok) {
      return {
        ok: false,
        detail: `this bot can post to ${channelId}, but the probe message could not be withdrawn: ${deleted.error}`,
        remediation: `delete the scheduled message in ${channelId} before it sends`,
      }
    }
    return { ok: true, detail: `this bot can post to ${channelId}` }
  }

  /**
   * One API call, with the two-part success test.
   *
   * Never throws: a notifier that throws into the engine would abort an
   * offboarding because a chat service was down, and the engine's own answer to
   * an undelivered notification is to make the run not ok.
   */
  private async call(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; body: SlackBody }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      authorization: this.botToken.use((value) => 'Bearer ' + value),
    }
    let status: number
    let raw: string
    try {
      const response = await this.http.post(`${this.baseUrl}/${method}`, payload, {
        headers,
        timeoutMs: this.timeoutMs,
        label: `slack.${method}`,
        // Posting the same note twice is worse than posting it late, and a 5xx
        // gives no evidence either way, so a failed post is reported instead.
        retryOn5xx: false,
      })
      status = response.status
      raw = response.body
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `${method} did not complete: ${message}`, body: {} }
    }

    let body: SlackBody = {}
    try {
      body = JSON.parse(raw) as SlackBody
    } catch {
      body = {}
    }

    if (status < 200 || status >= 300) {
      return { ok: false, error: `${method} returned status ${status}`, body }
    }
    if (body.ok !== true) {
      // The status said 200. Only the body knows this failed.
      return { ok: false, error: `${method} returned ok=false: ${describeError(body)}`, body }
    }
    return { ok: true, body }
  }
}

function describeError(body: SlackBody): string {
  const parts = [
    body.error ?? 'no error string in the response',
    body.needed ? `needed=${body.needed}` : null,
    body.provided ? `provided=${body.provided}` : null,
    body.channel ? `channel=${body.channel}` : null,
  ]
  return parts.filter((p): p is string => p !== null).join(' ')
}

export function createSlackNotifier(options: SlackNotifierOptions): SlackNotifier {
  return new SlackNotifier(options)
}
