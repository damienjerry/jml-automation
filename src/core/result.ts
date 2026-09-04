/**
 * Building the results of provider calls.
 *
 * One rule is enforced here rather than trusted to each call site: a leg
 * cannot reach the state `done` unless the outcome was verified by reading the
 * provider back. The automation this replaces recorded successful suspensions
 * from responses that had changed nothing, because a provider accepted a
 * request, ignored the part of the body that mattered, and answered 200.
 *
 * `legFrom` is therefore the only way a `LegRecord` is built, and it refuses to
 * write `done` on an unverified outcome no matter what the caller passes.
 */

import type { LegRecord, Outcome } from './types.ts'
import { HttpError, type HttpResponse, retryableStatus } from './http.ts'
import { redact } from '../config/redact.ts'

/** A confirmed effect: the provider was read back and the change was there. */
export function verified(detail?: Record<string, unknown>): Outcome {
  return { ok: true, verified: true, ...(detail ? { detail } : {}) }
}

/**
 * The call succeeded but the effect was not confirmed.
 *
 * Not an error, and not success either. A caller must treat this as a failed
 * leg and try again, which is exactly what the ancestor of this code did not
 * do.
 */
export function unverified(reason: string, detail?: Record<string, unknown>): Outcome {
  return { ok: true, verified: false, error: reason, retryable: true, ...(detail ? { detail } : {}) }
}

/** The thing we were going to remove is already gone. Success, and idempotent. */
export function alreadyAbsent(detail?: Record<string, unknown>): Outcome {
  return { ok: true, verified: true, alreadyAbsent: true, ...(detail ? { detail } : {}) }
}

export function failed(error: string, opts: { retryable?: boolean; detail?: Record<string, unknown> } = {}): Outcome {
  return {
    ok: false,
    verified: false,
    error: redact(error),
    retryable: opts.retryable ?? false,
    ...(opts.detail ? { detail: opts.detail } : {}),
  }
}

/**
 * Classify a response this client did not throw on.
 *
 * `notFoundIsAbsent` exists because a 404 means opposite things in different
 * places: deleting an account that is already gone is success, while looking
 * up an account we are about to delete and getting a 404 is a fact the caller
 * has to act on, not an error to swallow.
 */
export function outcomeFromResponse(
  res: Pick<HttpResponse, 'ok' | 'status' | 'body' | 'attempts'>,
  opts: { notFoundIsAbsent?: boolean; label?: string } = {},
): Outcome {
  if (res.ok) {
    // Deliberately not verified. A 2xx says the request was accepted; only a
    // read-back says the state changed, and only the caller can do that.
    return unverified('accepted with status ' + res.status + ' but not yet read back', { status: res.status })
  }
  if (res.status === 404 && opts.notFoundIsAbsent) return alreadyAbsent({ status: 404 })
  return failed((opts.label ?? 'request') + ' returned ' + res.status + ': ' + truncate(res.body), {
    retryable: retryableStatus(res.status, true),
    detail: { status: res.status, attempts: res.attempts },
  })
}

/** Classify a thrown error. Transport failures are retryable; bugs are not. */
export function outcomeFromError(err: unknown, opts: { label?: string } = {}): Outcome {
  if (err instanceof HttpError) {
    return failed((opts.label ?? 'request') + ': ' + err.message, {
      retryable: err.detail.retryable,
      detail: { status: err.status, attempts: err.detail.attempts, url: err.detail.url },
    })
  }
  const message = err instanceof Error ? err.message : String(err)
  return failed((opts.label ?? 'step') + ' threw: ' + message, { retryable: false })
}

export function isRetryable(outcome: Outcome): boolean {
  return outcome.retryable === true
}

export interface LegFromOptions {
  /** The record from the previous run, so attempts accumulate across runs. */
  previous?: LegRecord | undefined
  at: string
}

/**
 * Turn an outcome into the record stored on the person.
 *
 * The attempt counter accumulates across runs on purpose. A leg that has
 * failed six times is not a transient problem, and the row parks for a human
 * rather than retrying for ever with nobody watching.
 */
export function legFrom(outcome: Outcome, opts: LegFromOptions): LegRecord {
  const attempts = (opts.previous?.attempts ?? 0) + 1
  if (outcome.ok && outcome.verified) {
    return {
      state: outcome.alreadyAbsent ? 'already_absent' : 'done',
      verified: true,
      attempts,
      at: opts.at,
    }
  }
  // ok-but-unverified lands here as well, which is the whole point: an
  // accepted request that was never confirmed is a failed leg.
  return {
    state: 'failed',
    verified: false,
    attempts,
    at: opts.at,
    ...(outcome.error ? { error: redact(outcome.error) } : {}),
  }
}

/** The leg is implemented but this action is not in `armedActions`. */
export function notArmedLeg(at: string, previous?: LegRecord): LegRecord {
  // Attempts are NOT incremented: declining to act is not an attempt, and
  // counting it would park a row for never having been armed.
  return { state: 'not_armed', verified: false, attempts: previous?.attempts ?? 0, at }
}

/** There is nothing for this leg to do for this person. */
export function notApplicableLeg(at: string, reason?: string): LegRecord {
  return { state: 'not_applicable', verified: false, attempts: 0, at, ...(reason ? { error: reason } : {}) }
}

export function pendingLeg(): LegRecord {
  return { state: 'pending', verified: false, attempts: 0 }
}

/** True when a leg has reached a state that needs no further attempt. */
export function legSettled(leg: LegRecord | undefined): boolean {
  return leg?.state === 'done' || leg?.state === 'already_absent' || leg?.state === 'not_applicable'
}

function truncate(text: string, max = 512): string {
  return text.length > max ? text.slice(0, max) + '...[truncated]' : text
}
