/**
 * A StateStore for the tests in this package.
 *
 * The real one is local SQLite and belongs to the store package. This one
 * implements the same interface in memory, and can be told to fail its reads or
 * its writes, because how the change gate and the lease behave when their own
 * bookkeeping is unavailable is the part worth testing.
 */

import type { Lease, StateStore } from '../../src/store/types.ts'

export interface FakeStateStore extends StateStore {
  fingerprints: Map<string, { value: string; at: string }>
  counters: Map<string, number>
  leases: Map<string, { token: string; expiresAt: number }>
  /** Wall-clock override, so lease expiry is testable without waiting. */
  nowMs: number
}

export function fakeStateStore(opts: { failReads?: boolean; failWrites?: boolean } = {}): FakeStateStore {
  const fingerprints = new Map<string, { value: string; at: string }>()
  const counters = new Map<string, number>()
  const leases = new Map<string, { token: string; expiresAt: number }>()
  const runs: { runId: string; kind: string; at: string; summary: string }[] = []

  const store: FakeStateStore = {
    fingerprints,
    counters,
    leases,
    nowMs: 0,

    async init() {},
    async close() {},

    async acquireLease(name, ttlSeconds) {
      const held = leases.get(name)
      if (held && held.expiresAt > store.nowMs) return null
      const lease: Lease = {
        name,
        token: name + ':' + String(store.nowMs) + ':' + String(leases.size),
        expiresAt: new Date(store.nowMs + ttlSeconds * 1000).toISOString(),
      }
      leases.set(name, { token: lease.token, expiresAt: store.nowMs + ttlSeconds * 1000 })
      return lease
    },

    async releaseLease(lease) {
      // Only the holder may release, so a stale handle cannot let a third run in.
      if (leases.get(lease.name)?.token === lease.token) leases.delete(lease.name)
    },

    async getFingerprint(name) {
      if (opts.failReads) throw new Error('state store unavailable')
      return fingerprints.get(name) ?? null
    },

    async setFingerprint(name, value) {
      if (opts.failWrites) throw new Error('state store unavailable')
      fingerprints.set(name, { value, at: new Date(store.nowMs).toISOString() })
    },

    async getCounter(name) {
      if (opts.failReads) throw new Error('state store unavailable')
      return counters.get(name) ?? null
    },

    async setCounter(name, value) {
      if (opts.failWrites) throw new Error('state store unavailable')
      counters.set(name, value)
    },

    async recordRun(runId, kind, summary) {
      runs.push({ runId, kind, at: new Date(store.nowMs).toISOString(), summary })
    },

    async lastRun(kind) {
      const found = [...runs].reverse().find((r) => r.kind === kind)
      return found ? { runId: found.runId, at: found.at, summary: found.summary } : null
    },
  }

  return store
}
