import { describe, expect, it, vi } from 'vitest'
import { createConsoleNotifier } from '../../src/notify/console.ts'
import { createEmailNotifier, type MailSender } from '../../src/notify/email.ts'
import { createFanoutNotifier } from '../../src/notify/fanout.ts'
import type { Notification, NotificationResult, Notifier } from '../../src/notify/types.ts'

const IT_NOTE: Notification = {
  kind: 'run.summary',
  subject: 'Pipeline run: 1 suspended, 1 parked',
  body: 'Counts and detail.',
  audience: 'it',
}

const MANAGER_NOTE: Notification = {
  kind: 'leaver.day0',
  subject: 'Jane Doe: IT access suspended',
  body: 'What was done, and the dated deadline for deletion.',
  audience: 'manager',
  managerEmail: 'john.doe@example.com',
}

function stubNotifier(name: string, result: NotificationResult): Notifier & { calls: number } {
  const notifier = {
    name,
    calls: 0,
    send: async () => {
      notifier.calls++
      return result
    },
    testConnection: async () => ({ ok: result.delivered, detail: `${name} stub` }),
  }
  return notifier
}

describe('the console notifier', () => {
  it('prints the subject, the body and who it would go to', async () => {
    const written: string[] = []
    const result = await createConsoleNotifier({ write: (t) => written.push(t) }).send(MANAGER_NOTE)

    expect(result).toEqual({ delivered: true, channel: 'console' })
    const output = written.join('')
    expect(output).toContain('john.doe@example.com')
    expect(output).toContain(MANAGER_NOTE.subject)
    expect(output).toContain(MANAGER_NOTE.body)
  })

  it('needs no credential, so the first run of the toolkit works', async () => {
    await expect(createConsoleNotifier().testConnection()).resolves.toMatchObject({ ok: true })
  })

  it('says how much of a long body it withheld rather than truncating silently', async () => {
    const written: string[] = []
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    await createConsoleNotifier({ write: (t) => written.push(t), full: false }).send({
      ...IT_NOTE,
      body,
    })

    expect(written.join('')).toContain('8 more line(s)')
  })
})

describe('the mail notifier', () => {
  function mailer(outcome = { ok: true, verified: false }): MailSender & {
    sent: { to: string[]; subject: string }[]
  } {
    const sent: { to: string[]; subject: string }[] = []
    return {
      sent,
      sendMail: async (opts) => {
        sent.push({ to: opts.to, subject: opts.subject })
        return outcome
      },
      testConnection: async () => ({ ok: true, detail: 'can send as the configured mailbox' }),
    }
  }

  it('sends a manager note to the manager and an IT note to the IT recipients', async () => {
    const google = mailer()
    const notifier = createEmailNotifier({
      google,
      itRecipients: ['it.team@example.com'],
    })

    await notifier.send(MANAGER_NOTE)
    await notifier.send(IT_NOTE)

    expect(google.sent[0]?.to).toEqual(['john.doe@example.com'])
    expect(google.sent[1]?.to).toEqual(['it.team@example.com'])
  })

  it('reports a missing manager address rather than skipping the note', async () => {
    const google = mailer()
    const result = await createEmailNotifier({ google, itRecipients: ['it.team@example.com'] }).send(
      { ...MANAGER_NOTE, managerEmail: null },
    )

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/nobody was told/)
    expect(google.sent).toHaveLength(0)
  })

  it('reports a refusal from the provider', async () => {
    const google = mailer({ ok: false, verified: false })
    const result = await createEmailNotifier({ google, itRecipients: ['it.team@example.com'] }).send(
      IT_NOTE,
    )

    expect(result.delivered).toBe(false)
  })

  it('fails its connection check when no IT recipient is configured', async () => {
    const check = await createEmailNotifier({ google: mailer(), itRecipients: [] }).testConnection()
    expect(check.ok).toBe(false)
    expect(check.remediation).toMatch(/IT recipient/)
  })
})

describe('the notifier fanout', () => {
  it('routes by audience', async () => {
    const chat = stubNotifier('slack', { delivered: true, channel: 'slack' })
    const mail = stubNotifier('email', { delivered: true, channel: 'email' })
    const fanout = createFanoutNotifier({ it: [chat], manager: [mail] })

    await fanout.send(IT_NOTE)
    await fanout.send(MANAGER_NOTE)

    expect(chat.calls).toBe(1)
    expect(mail.calls).toBe(1)
  })

  it('counts a partial delivery as undelivered and names the broken channel', async () => {
    const good = stubNotifier('console', { delivered: true, channel: 'console' })
    const bad = stubNotifier('slack', {
      delivered: false,
      channel: 'slack',
      error: 'channel_not_found',
    })
    const result = await createFanoutNotifier({ it: [good, bad], manager: [] }).send(IT_NOTE)

    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/slack: channel_not_found/)
    // The working channel still received it: the point is the report, not a veto.
    expect(good.calls).toBe(1)
  })

  it('redirects a manager note with no address to IT and still calls it undelivered', async () => {
    const chat = stubNotifier('slack', { delivered: true, channel: 'slack' })
    const mail = stubNotifier('email', { delivered: true, channel: 'email' })
    const result = await createFanoutNotifier({ it: [chat], manager: [mail] }).send({
      ...MANAGER_NOTE,
      managerEmail: null,
    })

    expect(chat.calls).toBe(1)
    expect(mail.calls).toBe(0)
    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/no manager address was resolved/)
  })

  it('redirects to IT when the audience has no notifier of its own', async () => {
    const chat = stubNotifier('slack', { delivered: true, channel: 'slack' })
    const result = await createFanoutNotifier({ it: [chat], manager: [] }).send(MANAGER_NOTE)

    expect(chat.calls).toBe(1)
    expect(result.error).toMatch(/no notifier is configured for the manager audience/)
  })

  it('reports rather than silently dropping when nothing at all is configured', async () => {
    const result = await createFanoutNotifier({ it: [], manager: [] }).send(IT_NOTE)
    expect(result).toMatchObject({ delivered: false })
    expect(result.error).toMatch(/not sent anywhere/)
  })

  it('turns a notifier that throws into an undelivered result', async () => {
    const thrower: Notifier = {
      name: 'slack',
      send: async () => {
        throw new Error('unexpected')
      },
      testConnection: async () => ({ ok: true, detail: '' }),
    }
    const result = await createFanoutNotifier({ it: [thrower], manager: [] }).send(IT_NOTE)
    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/threw: unexpected/)
  })

  it('checks each configured notifier once and fails if any of them fails', async () => {
    const ok = stubNotifier('console', { delivered: true, channel: 'console' })
    const broken = stubNotifier('slack', { delivered: false, channel: 'slack' })
    const check = await createFanoutNotifier({ it: [ok, broken], manager: [ok] }).testConnection()

    expect(check.ok).toBe(false)
    expect(check.detail).toContain('console stub')
    expect(check.detail).toContain('slack stub')
  })

  it('says the console notifier is the safe default when nothing is configured', async () => {
    const check = await createFanoutNotifier({ it: [], manager: [] }).testConnection()
    expect(check.ok).toBe(false)
    expect(check.remediation).toMatch(/console notifier/)
  })
})

describe('a notifier never aborts a run', () => {
  it('is a contract the fanout enforces even for a badly behaved adapter', async () => {
    const send = vi.fn(async () => {
      throw new Error('boom')
    })
    const result = await createFanoutNotifier({
      it: [{ name: 'x', send, testConnection: async () => ({ ok: true, detail: '' }) }],
      manager: [],
    }).send(IT_NOTE)

    expect(result.delivered).toBe(false)
    expect(send).toHaveBeenCalledOnce()
  })
})
