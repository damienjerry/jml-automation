/**
 * Skip if already running.
 *
 * The arrangement this replaces had five schedules that could overlap, and
 * they did: the same restart was queued four times in three minutes because
 * four runs each read the same pending row and each acted on it. Two runs
 * offboarding the same person at once is the same shape with a worse outcome.
 *
 * A lease in the state store is the fix, and it is stronger than a flag in
 * process memory for the reason that matters here: the runs are separate
 * processes, and often separate containers.
 *
 * The second run does not fail. It skips, reports that it skipped, and exits
 * successfully. An overlapping schedule is normal operation, not an incident,
 * and turning it into a red run trains people to ignore red runs.
 */

import type { Lease, StateStore } from '../store/types.ts'
import type { Logger } from './logger.ts'

export interface LeaseOptions {
  state: StateStore
  /** The job being serialised, for example `pipeline`. */
  job: string
  /**
   * How long the lease lives.
   *
   * Long enough to cover the slowest legitimate run, short enough that a
   * crashed process does not lock the job out until somebody notices. A lease
   * with no expiry is a lock somebody has to clear by hand at three in the
   * morning.
   */
  ttlSeconds: number
  logger?: Logger
}

export type LeaseOutcome<T> = { ran: true; value: T } | { ran: false; reason: 'lease_held' }

/**
 * Run `fn` under the lease, or report that somebody else holds it.
 *
 * Release happens in a `finally` and its own failure is logged rather than
 * thrown, so a release problem cannot replace the real error with a less
 * useful one.
 */
export async function withLease<T>(options: LeaseOptions, fn: (lease: Lease) => Promise<T>): Promise<LeaseOutcome<T>> {
  const lease = await options.state.acquireLease(options.job, options.ttlSeconds)
  if (!lease) {
    options.logger?.info('another run holds the lease, skipping', { job: options.job })
    return { ran: false, reason: 'lease_held' }
  }
  try {
    return { ran: true, value: await fn(lease) }
  } finally {
    try {
      await options.state.releaseLease(lease)
    } catch (err) {
      options.logger?.warn('could not release the lease; it will expire on its own', {
        job: options.job,
        ttlSeconds: options.ttlSeconds,
        err,
      })
    }
  }
}

/**
 * Take the lease and hand back a release function.
 *
 * For the sidecar, where the run outlives the request that started it and so
 * cannot be wrapped in a single call.
 */
export async function acquireOrSkip(options: LeaseOptions): Promise<{ lease: Lease; release: () => Promise<void> } | null> {
  const lease = await options.state.acquireLease(options.job, options.ttlSeconds)
  if (!lease) return null
  let released = false
  return {
    lease,
    release: async () => {
      // Releasing twice would let a third run in while the second still holds
      // what it thinks is the lease.
      if (released) return
      released = true
      try {
        await options.state.releaseLease(lease)
      } catch (err) {
        options.logger?.warn('could not release the lease; it will expire on its own', { job: options.job, err })
      }
    },
  }
}
