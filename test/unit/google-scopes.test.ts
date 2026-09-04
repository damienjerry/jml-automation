import { describe, expect, it } from 'vitest'

import {
  GOOGLE_SCOPES,
  REQUIRED_SCOPE_USES,
  SCOPE_USES,
  scopeUseForKey,
  scopeUsesForMethod,
} from '../../src/connectors/google/scopes.ts'

describe('the scope table', () => {
  it('holds the exact strings Google expects, with no duplicates', () => {
    const scopes = Object.values(GOOGLE_SCOPES)
    expect(new Set(scopes).size).toBe(scopes.length)
    for (const scope of scopes) {
      expect(scope.startsWith('https://www.googleapis.com/auth/')).toBe(true)
      expect(scope).toBe(scope.trim())
    }
  })

  it('names the Phase 1 required set', () => {
    expect(REQUIRED_SCOPE_USES.map((use) => use.key)).toEqual([
      'directoryUser',
      'directoryUserReadonly',
      'licensing',
      'dataTransfer',
      'gmailSettingsBasic',
      'gmailSend',
    ])
  })

  it('keeps the as-itself scopes out of the delegated set', () => {
    for (const use of SCOPE_USES.filter((u) => u.subject === 'self')) {
      expect(use.required).toBe(false)
    }
  })

  it('mints the mailbox setting as the leaver and the send as the sender', () => {
    expect(scopeUsesForMethod('setVacationResponder').map((u) => u.subject)).toEqual(['leaver'])
    expect(scopeUsesForMethod('sendMail').map((u) => u.subject)).toEqual(['sender'])
  })

  it('explains what breaks without each scope, because the docs are built from it', () => {
    for (const use of SCOPE_USES) {
      expect(use.breaksWithout.length).toBeGreaterThan(20)
      expect(use.breaksWithout.endsWith('.')).toBe(true)
      expect(use.methods.length).toBeGreaterThan(0)
    }
  })

  it('has one entry per scope string', () => {
    expect(SCOPE_USES).toHaveLength(Object.keys(GOOGLE_SCOPES).length)
    for (const use of SCOPE_USES) expect(GOOGLE_SCOPES[use.key]).toBe(use.scope)
  })

  it('refuses an unknown key rather than returning nothing', () => {
    expect(scopeUseForKey('licensing').scope).toBe(GOOGLE_SCOPES.licensing)
    // A silent undefined here would mint a token with no scope at all.
    expect(() => scopeUseForKey('not-a-scope' as 'licensing')).toThrow()
  })
})
