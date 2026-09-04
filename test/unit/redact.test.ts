import { describe, expect, it } from 'vitest'
import { createRedactor, REDACTED } from '../../src/config/redact.ts'

describe('redactor', () => {
  it('masks a registered value in a plain string', () => {
    const r = createRedactor()
    r.register('super-secret-value')
    expect(r.redactString('auth failed for super-secret-value')).toBe('auth failed for ' + REDACTED)
  })

  it('ignores a value too short to be a credential', () => {
    // Registering a two-character value would mask ordinary prose, and an
    // operator whose logs are all asterisks turns redaction off.
    const r = createRedactor()
    r.register('ab')
    expect(r.size).toBe(0)
    expect(r.redactString('able')).toBe('able')
  })

  it('masks the percent-encoded form, because a URL carries one', () => {
    const r = createRedactor()
    r.register('pa ss/word+value')
    expect(r.redactString('GET /ping?t=pa%20ss%2Fword%2Bvalue')).toContain(REDACTED)
  })

  it('masks the base64 form, because a basic auth header carries one', () => {
    const r = createRedactor()
    r.register('service-user-token')
    const encoded = Buffer.from('service-user-token', 'utf8').toString('base64')
    expect(r.redactString('authorization: Basic ' + encoded)).toBe('authorization: Basic ' + REDACTED)
  })

  it('masks the longest registered value first', () => {
    const r = createRedactor()
    r.register('abcdef')
    r.register('abcdefghijkl')
    expect(r.redactString('abcdefghijkl')).toBe(REDACTED)
  })

  it('redacts nested values and key names', () => {
    const r = createRedactor()
    r.register('leaked-credential')
    const out = r.redactDeep({ outer: { list: ['leaked-credential'], 'k-leaked-credential': 1 } })
    expect(out).toEqual({ outer: { list: [REDACTED], ['k-' + REDACTED]: 1 } })
  })

  it('redacts a Set and a Map rather than losing their contents', () => {
    const r = createRedactor()
    r.register('leaked-credential')
    const out = r.redactDeep({ s: new Set(['leaked-credential']), m: new Map([['a', 'leaked-credential']]) })
    expect([...(out.s as Set<string>)]).toEqual([REDACTED])
    expect((out.m as Map<string, string>).get('a')).toBe(REDACTED)
  })

  it('survives a cycle', () => {
    const r = createRedactor()
    const node: Record<string, unknown> = { name: 'x' }
    node.self = node
    const out = r.redactDeep(node) as Record<string, unknown>
    expect(out.self).toBe(out)
  })

  it('redacts an Error message and stack but keeps the name', () => {
    const r = createRedactor()
    r.register('leaked-credential')
    const err = new TypeError('rejected leaked-credential')
    const out = r.redactError(err)
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe('rejected ' + REDACTED)
    expect(out.stack).not.toContain('leaked-credential')
  })
})
