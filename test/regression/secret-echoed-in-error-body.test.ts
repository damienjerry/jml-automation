/**
 * Prevents: a credential reaching a log line, a run report or an audit row
 * because a provider echoed it back inside an error body.
 *
 * A credential rarely escapes through the code that handles it. It escapes
 * because a provider answered `400 bad key: <the key>`, and that response body
 * was then written into a log, attached to a report and stored in an audit
 * trail kept for years, by three call sites none of which knew they were
 * handling a secret.
 *
 * The defence is a registry rather than discipline at each call site: every
 * resolved credential registers itself at start-up, and every outbound string
 * passes through the redactor.
 */

import { describe, expect, it } from 'vitest'
import type { AuditEvent } from '../../src/audit/types.ts'
import type { RunReport } from '../../src/core/types.ts'
import { createRedactor, REDACTED } from '../../src/config/redact.ts'
import { createSecretHandle } from '../../src/config/secrets.ts'
import { createHttpClient } from '../../src/core/http.ts'
import { createLogger } from '../../src/core/logger.ts'
import { redactDeep, redactor } from '../../src/config/redact.ts'
import { outcomeFromResponse } from '../../src/core/result.ts'

/** Shaped like a real credential, and belonging to nobody. */
const CREDENTIAL = 'test-only-credential-0000000000'

describe('a provider echoing a credential in an error body', () => {
  it('does not reach the HTTP response body a caller will log', async () => {
    createSecretHandle('env:EXAMPLE_API_KEY', CREDENTIAL)
    const http = createHttpClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: 'invalid_client', message: 'bad key: ' + CREDENTIAL }), { status: 400 }),
      maxRetries: 0,
    })
    const res = await http.get('https://api.example.com/v1/users')
    expect(res.body).not.toContain(CREDENTIAL)
    expect(res.body).toContain(REDACTED)
  })

  it('does not reach a log line, even when a whole request object is logged', () => {
    createSecretHandle('env:EXAMPLE_API_KEY', CREDENTIAL)
    const lines: string[] = []
    const logger = createLogger({ write: (l) => lines.push(l) })
    logger.error('call failed', {
      request: { headers: { authorization: 'Bearer ' + CREDENTIAL } },
      err: new Error('bad key: ' + CREDENTIAL),
    })
    expect(lines[0]).not.toContain(CREDENTIAL)
    expect(lines[0]).toContain(REDACTED)
  })

  it('does not reach the leg error recorded on the person', () => {
    createSecretHandle('env:EXAMPLE_API_KEY', CREDENTIAL)
    const outcome = outcomeFromResponse(
      { ok: false, status: 400, body: 'bad key: ' + CREDENTIAL, attempts: 1 },
      { label: 'suspend user' },
    )
    expect(outcome.error).not.toContain(CREDENTIAL)
  })

  it('does not reach the run report', () => {
    createSecretHandle('env:EXAMPLE_API_KEY', CREDENTIAL)
    const report: RunReport = {
      runId: 'run-1',
      kind: 'leaver',
      startedAt: '2026-09-04T09:00:00Z',
      finishedAt: '2026-09-04T09:01:00Z',
      dryRun: false,
      ok: false,
      counts: { day0: 1 },
      people: [
        {
          hrisId: 'HR-1',
          displayName: 'Jane Doe',
          phase: 'day0',
          legs: { suspend_idp: { state: 'failed', verified: false, attempts: 1, error: 'bad key: ' + CREDENTIAL } },
          statusBefore: 'terminated',
          statusAfter: 'terminated',
        },
      ],
      warnings: [],
      errors: ['suspend user returned 400: bad key: ' + CREDENTIAL],
    }
    const safe = redactDeep(report)
    const serialised = JSON.stringify(safe)
    expect(serialised).not.toContain(CREDENTIAL)
    expect(safe.people[0]?.legs.suspend_idp?.error).toContain(REDACTED)
    expect(safe.errors[0]).toContain(REDACTED)
  })

  it('does not reach an audit detail, in a value or in a key', () => {
    createSecretHandle('env:EXAMPLE_API_KEY', CREDENTIAL)
    const event: AuditEvent = {
      at: '2026-09-04T09:00:00Z',
      runId: 'run-1',
      phase: 'outcome',
      actor: { kind: 'system', id: 'system:pipeline' },
      action: 'jumpcloud.suspendUser',
      subject: { kind: 'person', id: 'HR-1' },
      dryRun: false,
      ok: false,
      detail: { responseBody: 'bad key: ' + CREDENTIAL, ['header-' + CREDENTIAL]: 1 },
    }
    const serialised = JSON.stringify(redactDeep(event))
    expect(serialised).not.toContain(CREDENTIAL)
    expect(serialised).toContain(REDACTED)
  })

  it('masks a credential that arrives percent-encoded in a URL', () => {
    // A ping-style credential lives in the URL, and a URL is logged whole.
    const local = createRedactor()
    local.register('cred with/reserved+chars')
    expect(local.redactString('GET /ping/cred%20with%2Freserved%2Bchars')).toContain(REDACTED)
  })

  it('leaves ordinary text alone, so redaction stays switched on', () => {
    // A redactor that masks half of every log line gets turned off, and then
    // it protects nothing at all.
    expect(redactor.redactString('suspended 3 people, 0 errors')).toBe('suspended 3 people, 0 errors')
  })
})
