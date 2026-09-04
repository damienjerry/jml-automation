import { describe, expect, it } from 'vitest'
import { createHttpClient } from '../../src/core/http.ts'
import { createSecretHandle } from '../../src/config/secrets.ts'
import type { HttpLike, SecretLike as JumpCloudSecretLike } from '../../src/connectors/jumpcloud/client.ts'
import type { HrisHttpClient, SecretLike as HrisSecretLike } from '../../src/hris/hibob/adapter.ts'

/**
 * The connectors and the HR adapter each declare a narrow structural port for
 * the HTTP client and for a credential, rather than importing the shared
 * types, so each one can be tested without the real client. That is a
 * deliberate choice, and it has one failure mode: nothing makes the ports and
 * the real implementations agree. If the shared client changed shape, every
 * connector would still typecheck against its own local copy of the old
 * shape, and the mismatch would only appear when something finally wired them
 * together — a long way from the change that caused it.
 *
 * These assignments are the compile-time half of the check: they fail the
 * typecheck if a real implementation stops satisfying a port. The run-time
 * assertions below cover the part a type cannot state, which is that the
 * methods the ports promise are actually present on the object.
 */
describe('the shared HTTP client satisfies every connector port', () => {
  it('satisfies the JumpCloud port', () => {
    const http: HttpLike = createHttpClient()
    expect(typeof http.request).toBe('function')
  })

  it('satisfies the HR adapter port', () => {
    const http: HrisHttpClient = createHttpClient()
    expect(typeof http.request).toBe('function')
  })
})

describe('the real secret handle satisfies every connector port', () => {
  it('satisfies the JumpCloud port and never yields its value outside use()', () => {
    const secret: JumpCloudSecretLike = createSecretHandle('op://<vault>/<item-uuid>/<field>', 'value')
    expect(secret.use((v) => v.length)).toBe(5)
    expect(String(secret)).not.toContain('value')
  })

  it('satisfies the HR adapter port', () => {
    const secret: HrisSecretLike = createSecretHandle('op://<vault>/<item-uuid>/<field>', 'value')
    expect(secret.use((v) => v.length)).toBe(5)
  })
})
