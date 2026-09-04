/**
 * Failure this prevents: a credential written into a permanent record.
 *
 * A provider that rejects a call often quotes the request back, credential
 * included. The connector puts that body in the error detail so an operator can
 * read what went wrong, and the audit log keeps that detail for years. So the
 * redaction has to happen on the way INTO the record, not when somebody
 * remembers to look.
 *
 * The credential does not escape through the line that handles it. It escapes
 * through a body somebody else serialised, and that call site does not know it
 * is holding a secret, which is why the audit sink consults the shared registry
 * rather than a list of secrets passed to it at construction.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createJsonlAuditSink } from '../../src/audit/jsonl.ts'
import { createLokiAuditSink } from '../../src/audit/loki.ts'
import type { AuditEvent } from '../../src/audit/types.ts'
import { redactor } from '../../src/config/redact.ts'
import { fakeSecret, poster } from '../helpers/notify-http-double.ts'

/** Stands in for a resolved credential, registered the way loadConfig does. */
const CREDENTIAL = 'credential-value-placeholder'

beforeEach(() => {
  redactor.register(CREDENTIAL)
})

afterEach(() => {
  redactor.clear()
})

function eventWithEchoedCredential(): AuditEvent {
  return {
    at: '2026-03-02T09:00:00.000Z',
    runId: 'run-1',
    phase: 'outcome',
    actor: { kind: 'system', id: 'system:pipeline' },
    action: 'jumpcloud.suspendUser',
    subject: { kind: 'person', id: 'hris-1', label: 'Jane Doe' },
    dryRun: false,
    ok: false,
    verified: false,
    detail: {
      status: 401,
      // The shape a rejecting provider hands back.
      body: `{"error":"unauthorised","x-api-key":"${CREDENTIAL}"}`,
      nested: { headers: { authorization: `Bearer ${CREDENTIAL}` } },
    },
  }
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jml-redact-'))
}

describe('a credential echoed in an error body', () => {
  it('is redacted before it reaches the audit file', async () => {
    const dir = await scratch()
    const sink = createJsonlAuditSink({ dir, today: () => '2026-03-02' })

    await sink.append(eventWithEchoedCredential())
    await sink.close()

    const written = await readFile(join(dir, 'jml-2026-03-02.jsonl'), 'utf8')
    expect(written).not.toContain(CREDENTIAL)
    expect(written).toContain('[redacted]')
    // The rest of the detail survives: redaction must not cost the diagnosis.
    expect(written).toContain('unauthorised')
    expect(written).toContain('401')
  })

  it('does not mutate the event the caller passed in', async () => {
    const dir = await scratch()
    const sink = createJsonlAuditSink({ dir, today: () => '2026-03-02' })
    const event = eventWithEchoedCredential()

    await sink.append(event)
    await sink.close()

    expect(JSON.stringify(event.detail)).toContain(CREDENTIAL)
  })

  it('still verifies afterwards, so the redacted form is what was chained', async () => {
    const dir = await scratch()
    const sink = createJsonlAuditSink({ dir, today: () => '2026-03-02' })

    await sink.append(eventWithEchoedCredential())
    await sink.append(eventWithEchoedCredential())

    await expect(sink.verify()).resolves.toMatchObject({ ok: true, checkedLines: 2 })
    await sink.close()
  })

  it('is redacted in the message of a failed audit push as well', async () => {
    const sink = createLokiAuditSink({
      baseUrl: 'http://logs.example.com',
      http: poster([], () => ({ status: 401, body: `rejected credential ${CREDENTIAL}` })),
      auth: { kind: 'bearer', secret: fakeSecret(CREDENTIAL) },
    })

    const error = await sink.append(eventWithEchoedCredential()).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('[redacted]')
    expect(message).not.toContain(CREDENTIAL)
    // The status is what an operator needs in order to act, so it survives.
    expect(message).toContain('401')
  })

  it('never serialises a secret handle that reaches the sink by mistake', async () => {
    const dir = await scratch()
    const sink = createJsonlAuditSink({ dir, today: () => '2026-03-02' })

    await sink.append({
      ...eventWithEchoedCredential(),
      detail: { credentialUsed: fakeSecret(CREDENTIAL) },
    })
    await sink.close()

    const written = await readFile(join(dir, 'jml-2026-03-02.jsonl'), 'utf8')
    expect(written).not.toContain(CREDENTIAL)
    expect(written).toContain('[redacted]')
  })
})
