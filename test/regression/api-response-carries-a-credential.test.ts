/**
 * Prevents: a credential leaving through an HTTP response.
 *
 * A credential rarely escapes through the line that handles it. It escapes
 * because a provider echoed the key back inside an error body and something
 * serialised the whole object into a response, a log or a report. Neither of
 * those call sites knows it is holding a secret.
 *
 * So every response this server builds goes through the redaction registry,
 * and these tests prove it for the two routes an operator is most likely to
 * expose: health, which is unauthenticated, and doctor, which is a report
 * ABOUT credentials and therefore the one most likely to name one.
 */

import { describe, expect, it } from 'vitest'
import { createSecretHandle } from '../../src/config/secrets.ts'
import { redactor } from '../../src/config/redact.ts'
import type { DoctorReport } from '../../src/cli/doctor.ts'
import { handle, JobBoard, type RouteContext, type ServerEngine } from '../../src/server/routes.ts'

/** Not a real credential, but the right shape and long enough to register. */
const CREDENTIAL = 'jml-test-credential-0123456789abcdefghij'

function context(engine: Partial<ServerEngine>): RouteContext {
  const unused = (() => Promise.reject(new Error('not used'))) as never
  return {
    engine: {
      pipeline: unused,
      leaver: unused,
      joiner: unused,
      ticketInbound: unused,
      devicePreflight: unused,
      deviceDispose: unused,
      show: async () => null,
      hold: unused,
      release: unused,
      ack: unused,
      tombstone: unused,
      doctor: unused,
      ...engine,
    },
    jobs: new JobBoard(),
    authorise: () => true,
    nowIso: () => '2026-03-03T09:00:00.000Z',
    newRunId: () => 'run-1',
  }
}

function request(method: string, path: string) {
  return { method, path, query: {}, headers: {}, body: '' }
}

describe('responses', () => {
  it('answers health with one field and nothing else', async () => {
    // Registered as a secret, exactly as it would be at start-up.
    createSecretHandle('env:JML_API_TOKEN', CREDENTIAL)
    try {
      const answer = await handle(request('GET', '/v1/health'), context({}))
      expect(answer.body).toEqual({ ok: true })
      expect(JSON.stringify(answer.body)).not.toContain(CREDENTIAL)
    } finally {
      redactor.clear()
    }
  })

  it('masks a credential that reached a doctor row through an error body', async () => {
    createSecretHandle('env:JUMPCLOUD_API_KEY', CREDENTIAL)
    try {
      const report: DoctorReport = {
        ok: false,
        at: '2026-03-03T09:00:00.000Z',
        mode: 'dry-run',
        armedActions: [],
        rows: [
          {
            name: 'identity provider',
            ok: false,
            // The shape that has actually leaked keys before now: the provider
            // quotes the request back in its error body.
            detail: 'the provider answered 401 for request with key=' + CREDENTIAL,
            remediation: null,
            docsAnchor: 'docs/credentials.md',
            skipped: false,
          },
        ],
        secrets: [{ path: 'identity.jumpcloud.apiKey', ref: 'env:JUMPCLOUD_API_KEY', length: CREDENTIAL.length }],
        parkedCount: 0,
        oldestParked: null,
        storeCounts: null,
        failures: [],
      }

      const answer = await handle(request('GET', '/v1/doctor'), context({ doctor: async () => report }))

      expect(answer.status).toBe(503)
      const serialised = JSON.stringify(answer.body)
      expect(serialised).not.toContain(CREDENTIAL)
      expect(serialised).toContain('[redacted]')
      // The useful part survives: the reference and the length are how an
      // operator confirms which credential is configured.
      expect(serialised).toContain('env:JUMPCLOUD_API_KEY')
    } finally {
      redactor.clear()
    }
  })

  it('masks a credential echoed in a failed run report', async () => {
    createSecretHandle('env:JUMPCLOUD_API_KEY', CREDENTIAL)
    try {
      const ctx = context({
        pipeline: async () => ({
          runId: 'run-1',
          kind: 'pipeline',
          startedAt: '2026-03-03T09:00:00.000Z',
          finishedAt: '2026-03-03T09:00:01.000Z',
          dryRun: true,
          ok: false,
          counts: {},
          people: [],
          warnings: [],
          errors: ['the provider rejected key=' + CREDENTIAL],
        }),
      })
      await handle({ ...request('POST', '/v1/runs'), body: '{}' }, ctx)
      await ctx.jobs.idle()
      const polled = await handle(request('GET', '/v1/runs/run-1'), ctx)
      expect(JSON.stringify(polled.body)).not.toContain(CREDENTIAL)
    } finally {
      redactor.clear()
    }
  })
})
