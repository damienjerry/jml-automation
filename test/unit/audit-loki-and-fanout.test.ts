import { describe, expect, it, vi } from 'vitest'
import { createFanoutAuditSink } from '../../src/audit/fanout.ts'
import { createLokiAuditSink, LokiPushError } from '../../src/audit/loki.ts'
import type { AuditEvent, AuditSink } from '../../src/audit/types.ts'
import { fakeSecret, poster, type SentRequest } from '../helpers/notify-http-double.ts'

const EVENT: AuditEvent = {
  at: '2026-03-02T09:00:00.000Z',
  runId: 'run-1',
  phase: 'intent',
  actor: { kind: 'system', id: 'system:pipeline' },
  action: 'google.transferDrive',
  subject: { kind: 'person', id: 'hris-1', label: 'Jane Doe' },
  dryRun: false,
}

const NOW = 1_772_000_000_000

function streamsIn(request: SentRequest | undefined) {
  return (request?.body ?? { streams: [] }) as {
    streams: { stream: Record<string, string>; values: [string, string][] }[]
  }
}

describe('the optional Loki sink', () => {
  it('pushes to the write path and keeps person detail out of the labels', async () => {
    const sent: SentRequest[] = []
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com/',
      http: poster(sent, () => ({ status: 204, body: '' })),
      labels: { job: 'jml_audit' },
      now: () => NOW,
    })

    await sink.append(EVENT)

    expect(sent[0]?.url).toBe('http://logs.example.com/loki/api/v1/push')
    const stream = streamsIn(sent[0]).streams[0]
    expect(stream?.stream).toEqual({ job: 'jml_audit', phase: 'intent' })
    expect(stream?.values[0]?.[0]).toBe('1772000000000000000')
    expect(stream?.values[0]?.[1]).toContain('google.transferDrive')
  })

  it('separates two rows written inside the same millisecond', async () => {
    const sent: SentRequest[] = []
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com',
      http: poster(sent, () => ({ status: 204, body: '' })),
      now: () => NOW,
    })

    await sink.append(EVENT)
    await sink.append(EVENT)

    // Loki drops a second entry with the same timestamp in the same stream, so
    // two rows written in one millisecond would otherwise become one.
    expect(streamsIn(sent[0]).streams[0]?.values[0]?.[0]).toBe('1772000000000000000')
    expect(streamsIn(sent[1]).streams[0]?.values[0]?.[0]).toBe('1772000000000000001')
  })

  it('builds the authorisation header from the secret handle', async () => {
    const sent: SentRequest[] = []
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com',
      http: poster(sent, () => ({ status: 204, body: '' })),
      auth: { kind: 'bearer', secret: fakeSecret('value-from-the-handle') },
    })

    await sink.append(EVENT)

    expect(sent[0]?.headers['authorization']).toBe('Bearer value-from-the-handle')
  })

  it('sends no authorisation header when the adopter has none to give', async () => {
    const sent: SentRequest[] = []
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com',
      http: poster(sent, () => ({ status: 204, body: '' })),
    })

    await sink.append(EVENT)

    expect(sent[0]?.headers['authorization']).toBeUndefined()
  })

  it('throws on a rejected push instead of swallowing it', async () => {
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com',
      http: poster([], () => ({ status: 503, body: 'ingester unavailable' })),
    })

    await expect(sink.append(EVENT)).rejects.toBeInstanceOf(LokiPushError)
  })

  it('throws when the transport itself fails', async () => {
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com',
      http: poster([], () => ({ status: 0, body: '', throws: new Error('connection refused') })),
    })

    await expect(sink.append(EVENT)).rejects.toThrow(/connection refused/)
  })
})

describe('the audit fanout', () => {
  function recordingSink(name: string, rows: AuditEvent[]): AuditSink {
    return {
      name,
      append: async (e) => {
        rows.push(e)
      },
    }
  }

  it('stops the caller when the primary sink refuses the row', async () => {
    const secondaryRows: AuditEvent[] = []
    const primary: AuditSink = {
      name: 'primary',
      append: async () => {
        throw new Error('disk full')
      },
    }
    const sink = createFanoutAuditSink({
      primary,
      secondary: [recordingSink('secondary', secondaryRows)],
    })

    await expect(sink.append(EVENT)).rejects.toThrow(/disk full/)
    // The primary is written first on purpose, so a remote sink cannot end up
    // holding a row for a step that never ran.
    expect(secondaryRows).toHaveLength(0)
  })

  it('counts a secondary failure as a warning and carries on', async () => {
    const primaryRows: AuditEvent[] = []
    const sink = createFanoutAuditSink({
      primary: recordingSink('jsonl', primaryRows),
      secondary: [
        {
          name: 'loki',
          append: async () => {
            throw new Error('ingester unavailable')
          },
        },
      ],
    })

    await sink.append(EVENT)

    expect(primaryRows).toHaveLength(1)
    expect(sink.secondaryFailures).toBe(1)
    expect(sink.warnings()[0]).toMatch(/loki did not accept a row: ingester unavailable/)
  })

  it('writes to every secondary even when one of them fails', async () => {
    const lastRows: AuditEvent[] = []
    const sink = createFanoutAuditSink({
      primary: recordingSink('jsonl', []),
      secondary: [
        {
          name: 'broken',
          append: async () => {
            throw new Error('nope')
          },
        },
        recordingSink('last', lastRows),
      ],
    })

    await sink.append(EVENT)

    expect(lastRows).toHaveLength(1)
    expect(sink.secondaryFailures).toBe(1)
  })

  it('verifies through the primary and reports when the primary cannot verify', async () => {
    const verify = vi.fn(async () => ({ ok: true, checkedLines: 7 }))
    const withVerify = createFanoutAuditSink({
      primary: { name: 'jsonl', append: async () => {}, verify },
    })
    await expect(withVerify.verify()).resolves.toEqual({ ok: true, checkedLines: 7 })
    expect(verify).toHaveBeenCalledOnce()

    const withoutVerify = createFanoutAuditSink({
      primary: { name: 'memory', append: async () => {} },
    })
    // "Nothing to check" must not read the same as "checked and sound".
    await expect(withoutVerify.verify()).resolves.toMatchObject({ ok: false, checkedLines: 0 })
  })

  it('closes every sink it was given', async () => {
    const closed: string[] = []
    const closing = (name: string): AuditSink => ({
      name,
      append: async () => {},
      close: async () => {
        closed.push(name)
      },
    })
    await createFanoutAuditSink({
      primary: closing('jsonl'),
      secondary: [closing('loki')],
    }).close()

    expect(closed).toEqual(['jsonl', 'loki'])
  })
})
