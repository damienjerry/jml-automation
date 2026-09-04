import { describe, expect, it } from 'vitest'
import { acquireOrSkip, withLease } from '../../src/core/lease.ts'
import { nullLogger } from '../../src/core/logger.ts'
import { fakeStateStore } from './fake-state-store.ts'

describe('withLease', () => {
  it('runs the body and releases afterwards', async () => {
    const state = fakeStateStore()
    const out = await withLease({ state, job: 'pipeline', ttlSeconds: 600 }, async () => 'done')
    expect(out).toEqual({ ran: true, value: 'done' })
    expect(state.leases.size).toBe(0)
  })

  it('skips a second concurrent run rather than failing it', async () => {
    // An overlapping schedule is normal operation, not an incident. Turning it
    // into a red run trains people to ignore red runs.
    const state = fakeStateStore()
    let secondOutcome: unknown
    await withLease({ state, job: 'pipeline', ttlSeconds: 600, logger: nullLogger() }, async () => {
      secondOutcome = await withLease({ state, job: 'pipeline', ttlSeconds: 600, logger: nullLogger() }, async () => 'should not run')
    })
    expect(secondOutcome).toEqual({ ran: false, reason: 'lease_held' })
  })

  it('lets a different job run at the same time', async () => {
    const state = fakeStateStore()
    let inner: unknown
    await withLease({ state, job: 'pipeline', ttlSeconds: 600 }, async () => {
      inner = await withLease({ state, job: 'device', ttlSeconds: 600 }, async () => 'ran')
    })
    expect(inner).toEqual({ ran: true, value: 'ran' })
  })

  it('releases even when the body throws, and reports the body error', async () => {
    const state = fakeStateStore()
    await expect(
      withLease({ state, job: 'pipeline', ttlSeconds: 600 }, async () => {
        throw new Error('leg failed')
      }),
    ).rejects.toThrow('leg failed')
    expect(state.leases.size).toBe(0)
  })

  it('does not let a release failure replace the real error', async () => {
    const state = fakeStateStore()
    state.releaseLease = async () => {
      throw new Error('state store unavailable')
    }
    await expect(
      withLease({ state, job: 'pipeline', ttlSeconds: 600, logger: nullLogger() }, async () => {
        throw new Error('leg failed')
      }),
    ).rejects.toThrow('leg failed')
  })

  it('lets the next run in once the lease has expired', async () => {
    // A lease with no expiry is a lock somebody has to clear by hand after a
    // crash, at whatever hour the schedule runs.
    const state = fakeStateStore()
    await state.acquireLease('pipeline', 60)
    expect(await withLease({ state, job: 'pipeline', ttlSeconds: 60, logger: nullLogger() }, async () => 1)).toEqual({
      ran: false,
      reason: 'lease_held',
    })
    state.nowMs += 61_000
    expect(await withLease({ state, job: 'pipeline', ttlSeconds: 60 }, async () => 1)).toEqual({ ran: true, value: 1 })
  })
})

describe('acquireOrSkip', () => {
  it('hands back a release function for a run that outlives its request', async () => {
    const state = fakeStateStore()
    const held = await acquireOrSkip({ state, job: 'pipeline', ttlSeconds: 600 })
    expect(held).not.toBeNull()
    expect(await acquireOrSkip({ state, job: 'pipeline', ttlSeconds: 600 })).toBeNull()
    await held?.release()
    expect(state.leases.size).toBe(0)
  })

  it('ignores a second release, so a third run cannot slip in', async () => {
    const state = fakeStateStore()
    const held = await acquireOrSkip({ state, job: 'pipeline', ttlSeconds: 600 })
    await held?.release()
    const next = await acquireOrSkip({ state, job: 'pipeline', ttlSeconds: 600 })
    await held?.release()
    expect(state.leases.size).toBe(1)
    await next?.release()
  })
})
