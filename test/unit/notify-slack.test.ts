import { describe, expect, it } from 'vitest'
import { createSlackNotifier } from '../../src/notify/slack.ts'
import type { Notification } from '../../src/notify/types.ts'
import {
  fakeSecret,
  poster,
  type ScriptedReply,
  type SentRequest,
} from '../helpers/notify-http-double.ts'

const NOTIFICATION: Notification = {
  kind: 'leaver.day0',
  subject: 'Jane Doe: IT access suspended',
  body: 'Suspended today. Drive transfer on day 6, deletion on day 7.',
  audience: 'it',
}

const CHANNEL = 'channel-placeholder'
const NOW = 1_772_000_000_000

function harness(reply: (request: SentRequest) => ScriptedReply, probeWrites = false) {
  const sent: SentRequest[] = []
  const slack = createSlackNotifier({
    botToken: fakeSecret('value-from-the-handle'),
    itChannelId: CHANNEL,
    http: poster(sent, reply),
    probeWrites,
    now: () => NOW,
  })
  return { slack, sent, methods: () => sent.map((r) => r.url.split('/api/')[1]) }
}

const always = (status: number, body: string) => (): ScriptedReply => ({ status, body })

describe('the chat notifier', () => {
  it('reports delivered only when the body says the post succeeded', async () => {
    const { slack, sent } = harness(always(200, '{"ok":true,"ts":"1.2"}'))

    const result = await slack.send(NOTIFICATION)

    expect(result).toEqual({ delivered: true, channel: `slack:${CHANNEL}` })
    expect(sent[0]?.url).toBe('https://slack.com/api/chat.postMessage')
    expect(sent[0]?.headers['authorization']).toBe('Bearer value-from-the-handle')
    expect(sent[0]?.body).toMatchObject({ channel: CHANNEL })
    // A retried post could double-notify with no evidence it was needed.
    expect(sent[0]?.retryOn5xx).toBe(false)
  })

  it('reports undelivered on a non-2xx status', async () => {
    const { slack } = harness(always(500, 'server error'))
    const result = await slack.send(NOTIFICATION)

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/status 500/)
  })

  it('reports undelivered when the transport fails, and never throws at the caller', async () => {
    const { slack } = harness(() => ({ status: 0, body: '', throws: new Error('socket hang up') }))
    const result = await slack.send(NOTIFICATION)

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/socket hang up/)
  })

  it('reports undelivered when the body is not JSON at all', async () => {
    const { slack } = harness(always(200, '<html>gateway</html>'))
    const result = await slack.send(NOTIFICATION)

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/ok=false/)
  })

  it('names the manager a redirected note was meant for', async () => {
    const { slack, sent } = harness(always(200, '{"ok":true}'))

    await slack.send({
      ...NOTIFICATION,
      audience: 'manager',
      managerEmail: 'john.doe@example.com',
    })

    expect((sent[0]?.body as { text: string }).text).toContain('john.doe@example.com')
  })
})

describe('the chat connection check', () => {
  it('does not write unless the write probe is asked for', async () => {
    const { slack, methods } = harness(always(200, '{"ok":true}'))

    const check = await slack.testConnection()

    expect(check.ok).toBe(true)
    expect(methods()).toEqual(['auth.test'])
    expect(check.detail).toMatch(/membership is NOT checked/)
  })

  it('schedules and withdraws one message when the write probe is enabled', async () => {
    const { slack, sent, methods } = harness(
      (request) =>
        request.url.endsWith('chat.scheduleMessage')
          ? { status: 200, body: '{"ok":true,"scheduled_message_id":"Q-1"}' }
          : { status: 200, body: '{"ok":true}' },
      true,
    )

    const check = await slack.testConnection()

    expect(check.ok).toBe(true)
    expect(methods()).toEqual(['auth.test', 'chat.scheduleMessage', 'chat.deleteScheduledMessage'])
    expect(sent[1]?.body).toMatchObject({ post_at: NOW / 1000 + 300 })
    expect(sent[2]?.body).toMatchObject({ scheduled_message_id: 'Q-1' })
  })

  it('explains that a channel-not-found is a membership problem, not a wrong id', async () => {
    const { slack } = harness(always(200, '{"ok":false,"error":"channel_not_found"}'))

    const probe = await slack.probeChannelMembership(CHANNEL)

    expect(probe.ok).toBe(false)
    expect(probe.remediation).toMatch(/Membership is per bot/)
  })

  it('says so when a probe message cannot be withdrawn', async () => {
    const { slack } = harness((request) =>
      request.url.endsWith('chat.scheduleMessage')
        ? { status: 200, body: '{"ok":true,"scheduled_message_id":"Q-1"}' }
        : { status: 200, body: '{"ok":false,"error":"invalid_scheduled_message_id"}' },
    )

    const probe = await slack.probeChannelMembership(CHANNEL)

    expect(probe.ok).toBe(false)
    expect(probe.detail).toMatch(/could not be withdrawn/)
  })

  it('says so when the probe is accepted without an id to withdraw it by', async () => {
    const { slack } = harness(always(200, '{"ok":true}'))

    const probe = await slack.probeChannelMembership(CHANNEL)

    expect(probe.ok).toBe(false)
    expect(probe.detail).toMatch(/no id came back/)
  })

  it('points at the right credential when the token is rejected', async () => {
    const { slack } = harness(always(200, '{"ok":false,"error":"invalid_auth"}'))

    const check = await slack.testConnection()

    expect(check.ok).toBe(false)
    expect(check.remediation).toMatch(/not the user token or the SCIM token/)
  })
})
