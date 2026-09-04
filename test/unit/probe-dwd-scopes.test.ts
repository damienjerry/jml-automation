import { describe, expect, it } from 'vitest'

import {
  PROBE_SCOPES,
  formatTable,
  main,
  mintAssertion,
  parseArgs,
  probeScope,
  shortScope,
  subjectAddress,
  // The adopter tool is plain JavaScript on purpose: it has to run on a fresh
  // clone with nothing built.
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../tools/probe-dwd-scopes.mjs'
import { REQUIRED_SCOPE_USES } from '../../src/connectors/google/scopes.ts'
import { serviceAccountJson } from '../fixtures/google/harness.ts'

/** A fetch that answers the token endpoint and records the bodies it was sent. */
function fakeFetch(answer: (body: URLSearchParams) => { status: number; payload: unknown }) {
  const bodies: URLSearchParams[] = []
  const impl = (_url: string, init: { body: string }) => {
    const body = new URLSearchParams(init.body)
    bodies.push(body)
    const { status, payload } = answer(body)
    return Promise.resolve({ status, json: () => Promise.resolve(payload) })
  }
  return { impl, bodies }
}

function claimsOf(assertion: string): Record<string, unknown> {
  const parts = assertion.split('.')
  return JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8'))
}

describe('the delegation probe tool', () => {
  it('probes exactly the scopes the connector requires', () => {
    // If these drift, an adopter grants what the tool asks for and the
    // connector still fails on a scope nobody probed.
    expect(PROBE_SCOPES.map((row: { scope: string }) => row.scope)).toEqual(
      REQUIRED_SCOPE_USES.map((use) => use.scope),
    )
    expect(PROBE_SCOPES.map((row: { subject: string }) => row.subject)).toEqual(
      REQUIRED_SCOPE_USES.map((use) => use.subject),
    )
  })

  it('reads its flags and refuses one it does not know', () => {
    expect(parseArgs(['--admin', 'admin@example.com', '--json'])).toMatchObject({
      admin: 'admin@example.com',
      json: true,
      saEnv: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    })
    expect(() => parseArgs(['--nonsense'])).toThrow('unknown flag')
  })

  it('probes the mailbox scope as an ordinary mailbox when one is given', () => {
    const opts = { admin: 'admin@example.com', sender: 'it.notifications@example.com' }
    expect(subjectAddress('leaver', { ...opts, mailbox: 'jane.doe@example.com' })).toBe(
      'jane.doe@example.com',
    )
    expect(subjectAddress('leaver', opts)).toBe('admin@example.com')
    expect(subjectAddress('sender', opts)).toBe('it.notifications@example.com')
    expect(subjectAddress('self', opts)).toBeNull()
  })

  it('mints one scope per assertion', () => {
    const serviceAccount = JSON.parse(serviceAccountJson())
    const assertion = mintAssertion(
      serviceAccount,
      'https://www.googleapis.com/auth/apps.licensing',
      'admin@example.com',
      1_700_000_000,
    )

    const claims = claimsOf(assertion)
    expect(claims.scope).toBe('https://www.googleapis.com/auth/apps.licensing')
    expect(String(claims.scope)).not.toContain(' ')
    expect(claims.sub).toBe('admin@example.com')
  })

  it('reports a refusal by code and keeps the description out', async () => {
    const serviceAccount = JSON.parse(serviceAccountJson())
    const { impl } = fakeFetch(() => ({
      status: 401,
      payload: { error: 'unauthorized_client', error_description: 'Client is unauthorized' },
    }))

    const result = await probeScope({
      serviceAccount,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      subject: 'it.notifications@example.com',
      fetchImpl: impl,
    })

    expect(result).toMatchObject({ ok: false, status: 401, error: 'unauthorized_client' })
    // The code is diagnostic; the description can quote the request.
    expect(JSON.stringify(result)).not.toContain('Client is unauthorized')
  })

  it('prints no credential material, only statuses', async () => {
    const serviceAccount = serviceAccountJson()
    const granted = 'granted-value-that-must-not-be-printed'
    const { impl, bodies } = fakeFetch(() => ({
      status: 200,
      payload: { access_token: granted, expires_in: 3600 },
    }))
    const lines: string[] = []

    const code = await main(
      ['--admin', 'admin@example.com', '--sender', 'it.notifications@example.com'],
      {
        env: { GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount },
        out: (line: string) => lines.push(line),
        fetchImpl: impl,
      },
    )

    const printed = lines.join('\n')
    expect(code).toBe(0)
    expect(printed).toContain('granted')
    expect(printed).toContain('admin.directory.user')
    // Nothing signed and nothing granted reaches the output.
    expect(printed).not.toContain(granted)
    expect(printed).not.toContain('-----BEGIN')
    for (const body of bodies) {
      expect(printed).not.toContain(String(body.get('assertion')))
    }
    // A three-part dot-separated blob is what a leaked assertion looks like.
    expect(printed).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/)
  })

  it('exits non-zero when a scope is refused, so it can gate a deploy', async () => {
    const lines: string[] = []
    const { impl } = fakeFetch((body) => {
      const claims = claimsOf(String(body.get('assertion')))
      return claims.scope === 'https://www.googleapis.com/auth/admin.datatransfer'
        ? { status: 401, payload: { error: 'unauthorized_client' } }
        : { status: 200, payload: { access_token: 'granted', expires_in: 3600 } }
    })

    const code = await main(['--admin', 'admin@example.com'], {
      env: { GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson() },
      out: (line: string) => lines.push(line),
      fetchImpl: impl,
    })

    const printed = lines.join('\n')
    expect(code).toBe(1)
    expect(printed).toContain('REFUSED (unauthorized_client)')
    expect(printed).toContain('https://www.googleapis.com/auth/admin.datatransfer')
    expect(printed).toContain('Domain-wide delegation')
  })

  it('asks for help rather than probing when the administrator is missing', async () => {
    const lines: string[] = []
    const code = await main([], { env: {}, out: (line: string) => lines.push(line) })

    expect(code).toBe(2)
    expect(lines.join('\n')).toContain('--admin')
  })

  it('says what to set when no key is present, without printing anything', async () => {
    await expect(
      main(['--admin', 'admin@example.com'], { env: {}, out: () => {} }),
    ).rejects.toThrow('GOOGLE_SERVICE_ACCOUNT_JSON')
  })

  it('shortens a scope to the part a person recognises', () => {
    expect(shortScope('https://www.googleapis.com/auth/gmail.send')).toBe('gmail.send')
  })

  it('lines the table up', () => {
    const table = formatTable([
      { scope: 'https://www.googleapis.com/auth/gmail.send', subject: 'a@example.com', status: 200, ok: true },
      { scope: 'https://www.googleapis.com/auth/apps.licensing', subject: null, status: 0, ok: false },
    ])

    expect(table).toContain('gmail.send')
    expect(table).toContain('(service account itself)')
    expect(table).toContain('unreachable')
  })
})
