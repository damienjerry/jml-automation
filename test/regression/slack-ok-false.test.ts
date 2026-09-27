/**
 * Failure this prevents: a chat post that reached nobody while the run recorded
 * a success.
 *
 * The API answers HTTP 200 and puts the failure in the body. Several scheduled
 * workflows in an earlier design posted nothing for weeks
 * because the transport status was checked and the body was not, so their
 * reports went quietly missing while every execution was green.
 *
 * The rule: a 2xx alone is not delivery. `delivered` is true only when the body
 * also says `ok: true`, and an undelivered notification makes the run not ok,
 * which is what turns a scheduled execution red.
 */

import { describe, expect, it } from 'vitest'
import { createFanoutNotifier } from '../../src/notify/fanout.ts'
import { createSlackNotifier } from '../../src/notify/slack.ts'
import type { Notification } from '../../src/notify/types.ts'
import { fakeSecret, poster } from '../helpers/notify-http-double.ts'

const NOTE: Notification = {
  kind: 'leaver.day0',
  subject: 'Jane Doe: IT access suspended',
  body: 'Suspended today.',
  audience: 'it',
}

describe('a 200 carrying ok:false is not a delivery', () => {
  it('reports delivered false and quotes the error the body gave', async () => {
    const notifier = createSlackNotifier({
      botToken: fakeSecret('value-from-the-handle'),
      itChannelId: 'channel-placeholder',
      http: poster([], () => ({
        status: 200,
        // Verbatim shape of the real answer, warning and all.
        body: '{"ok":false,"error":"channel_not_found","warning":"missing_charset"}',
      })),
    })

    const result = await notifier.send(NOTE)

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/channel_not_found/)
  })

  it('carries that verdict through the fanout, so the run can be marked not ok', async () => {
    const notifier = createSlackNotifier({
      botToken: fakeSecret('value-from-the-handle'),
      itChannelId: 'channel-placeholder',
      http: poster([], () => ({ status: 200, body: '{"ok":false,"error":"not_in_channel"}' })),
    })

    const result = await createFanoutNotifier({ it: [notifier], manager: [] }).send(NOTE)

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/not_in_channel/)
  })

  it('does not treat a missing ok field as success either', async () => {
    const notifier = createSlackNotifier({
      botToken: fakeSecret('value-from-the-handle'),
      itChannelId: 'channel-placeholder',
      http: poster([], () => ({ status: 200, body: '{"ts":"1.2"}' })),
    })

    await expect(notifier.send(NOTE)).resolves.toMatchObject({ delivered: false })
  })
})
