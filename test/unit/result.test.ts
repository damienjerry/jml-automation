import { describe, expect, it } from 'vitest'
import { HttpError } from '../../src/core/http.ts'
import {
  alreadyAbsent,
  failed,
  isRetryable,
  legFrom,
  legSettled,
  notApplicableLeg,
  notArmedLeg,
  outcomeFromError,
  outcomeFromResponse,
  pendingLeg,
  unverified,
  verified,
} from '../../src/core/result.ts'
import { redactor, REDACTED } from '../../src/config/redact.ts'

const AT = '2026-09-04T09:00:00Z'

describe('outcome constructors', () => {
  it('marks a read-back confirmation as verified', () => {
    expect(verified({ readBackState: 'suspended' })).toEqual({ ok: true, verified: true, detail: { readBackState: 'suspended' } })
  })

  it('marks an accepted but unconfirmed call as retryable and not verified', () => {
    const out = unverified('accepted but not read back')
    expect(out).toMatchObject({ ok: true, verified: false, retryable: true })
  })

  it('marks an absent thing as verified success', () => {
    expect(alreadyAbsent()).toMatchObject({ ok: true, verified: true, alreadyAbsent: true })
  })
})

describe('outcomeFromResponse', () => {
  it('never calls a 2xx verified on its own', () => {
    // A 2xx says the request was accepted. Only a read-back says the state
    // changed, and an earlier version of this code recorded successful suspensions
    // from responses that had changed nothing.
    const out = outcomeFromResponse({ ok: true, status: 200, body: '{}', attempts: 1 })
    expect(out.verified).toBe(false)
  })

  it('treats a 404 as already absent only when the caller says a 404 means that', () => {
    expect(outcomeFromResponse({ ok: false, status: 404, body: '', attempts: 1 }, { notFoundIsAbsent: true }).alreadyAbsent).toBe(true)
    expect(outcomeFromResponse({ ok: false, status: 404, body: '', attempts: 1 }).ok).toBe(false)
  })

  it('classifies a 429 and a 503 as retryable and a 403 as not', () => {
    expect(isRetryable(outcomeFromResponse({ ok: false, status: 429, body: '', attempts: 1 }))).toBe(true)
    expect(isRetryable(outcomeFromResponse({ ok: false, status: 503, body: '', attempts: 1 }))).toBe(true)
    expect(isRetryable(outcomeFromResponse({ ok: false, status: 403, body: '', attempts: 1 }))).toBe(false)
  })

  it('keeps the status and the body in the failure, truncated', () => {
    const out = outcomeFromResponse({ ok: false, status: 400, body: 'y'.repeat(2000), attempts: 2 }, { label: 'suspend user' })
    expect(out.error).toContain('suspend user returned 400')
    expect(out.error).toContain('[truncated]')
    expect(out.detail).toEqual({ status: 400, attempts: 2 })
  })

  it('redacts a credential echoed in a failing body', () => {
    redactor.register('credential-in-the-body')
    const out = outcomeFromResponse({ ok: false, status: 400, body: 'bad: credential-in-the-body', attempts: 1 })
    expect(out.error).not.toContain('credential-in-the-body')
    expect(out.error).toContain(REDACTED)
  })
})

describe('outcomeFromError', () => {
  it('carries a transport failure through as retryable', () => {
    const err = new HttpError(0, 'no response', { url: 'https://api.example.com/v1', attempts: 3, retryable: true })
    expect(outcomeFromError(err)).toMatchObject({ ok: false, retryable: true, detail: { status: 0, attempts: 3 } })
  })

  it('does not mark an unexpected throw retryable', () => {
    expect(outcomeFromError(new TypeError('undefined is not a function'))).toMatchObject({ ok: false, retryable: false })
  })
})

describe('legFrom', () => {
  it('records done only on a verified outcome', () => {
    expect(legFrom(verified(), { at: AT }).state).toBe('done')
  })

  it('records failed on an accepted but unverified outcome', () => {
    // This is the type-level form of "a 200 is not an effect": there is no way
    // for a caller to write done without a read-back.
    const leg = legFrom(unverified('not read back'), { at: AT })
    expect(leg.state).toBe('failed')
    expect(leg.verified).toBe(false)
  })

  it('records already_absent as its own settled state', () => {
    expect(legFrom(alreadyAbsent(), { at: AT }).state).toBe('already_absent')
  })

  it('accumulates attempts across runs so a standing failure eventually parks', () => {
    const first = legFrom(failed('nope', { retryable: true }), { at: AT })
    const second = legFrom(failed('nope', { retryable: true }), { at: AT, previous: first })
    const third = legFrom(verified(), { at: AT, previous: second })
    expect([first.attempts, second.attempts, third.attempts]).toEqual([1, 2, 3])
  })

  it('redacts a credential that reached the error text', () => {
    redactor.register('credential-in-an-error')
    expect(legFrom(failed('rejected credential-in-an-error'), { at: AT }).error).toContain(REDACTED)
  })
})

describe('non-attempt leg states', () => {
  it('does not count an unarmed action as an attempt', () => {
    // Counting it would park a row for never having been armed.
    const previous = legFrom(failed('nope'), { at: AT })
    expect(notArmedLeg(AT, previous).attempts).toBe(previous.attempts)
    expect(notArmedLeg(AT).attempts).toBe(0)
  })

  it('marks a leg that has nothing to do', () => {
    expect(notApplicableLeg(AT, 'no account with this provider')).toMatchObject({ state: 'not_applicable', attempts: 0 })
  })

  it('knows which states need no further attempt', () => {
    expect(legSettled(legFrom(verified(), { at: AT }))).toBe(true)
    expect(legSettled(legFrom(alreadyAbsent(), { at: AT }))).toBe(true)
    expect(legSettled(notApplicableLeg(AT))).toBe(true)
    expect(legSettled(legFrom(failed('nope'), { at: AT }))).toBe(false)
    expect(legSettled(notArmedLeg(AT))).toBe(false)
    expect(legSettled(pendingLeg())).toBe(false)
    expect(legSettled(undefined)).toBe(false)
  })
})
