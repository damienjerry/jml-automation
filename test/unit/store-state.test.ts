/**
 * The state store: leases, fingerprints, counters and run history.
 *
 * These are the mechanisms that stop two runs acting on the same person, stop
 * an alert repeating a fact that has not changed, and stop a run proceeding
 * after the tombstone count has fallen.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeClock } from '../../src/core/clock.ts'
import { SqliteStateStore } from '../../src/store/state-sqlite.ts'

const clock = new FakeClock('2026-03-31T09:00:00.000Z')
const open = async (): Promise<SqliteStateStore> => {
  const store = new SqliteStateStore({ path: ':memory:', clock })
  await store.init()
  return store
}

afterEach(() => {
  clock.set('2026-03-31T09:00:00.000Z')
})

describe('leases', () => {
  it('refuses a second holder while the first is live', async () => {
    const store = await open()
    const first = await store.acquireLease('pipeline', 600)
    expect(first).not.toBeNull()

    // A second run starting while the first is still working must do nothing
    // at all, rather than suspending the same people a second time.
    expect(await store.acquireLease('pipeline', 600)).toBeNull()
    await store.close()
  })

  it('hands the lease over once it has expired', async () => {
    const store = await open()
    const first = await store.acquireLease('pipeline', 60)
    expect(first).not.toBeNull()

    // Expiry exists because a killed run releases nothing. Without it the
    // first crash stops every later run for ever, silently.
    clock.advanceMs(120_000)
    const second = await store.acquireLease('pipeline', 60)
    expect(second).not.toBeNull()
    expect(second?.token).not.toBe(first?.token)
    await store.close()
  })

  it('does not let a stale holder evict the current one', async () => {
    const store = await open()
    const stale = await store.acquireLease('pipeline', 60)
    clock.advanceMs(120_000)
    const current = await store.acquireLease('pipeline', 600)

    if (stale) await store.releaseLease(stale)

    // The late tidy-up of the crashed run must not open the door while the
    // run that took over is mid-flight.
    expect(await store.acquireLease('pipeline', 600)).toBeNull()
    if (current) await store.releaseLease(current)
    expect(await store.acquireLease('pipeline', 600)).not.toBeNull()
    await store.close()
  })

  it('refuses a second process, not merely a second call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jml-lease-'))
    try {
      const path = join(directory, 'state.sqlite')
      // A real overlap is two runs with their own handle on the same file, so
      // the lease has to live in the database rather than in the process.
      const first = new SqliteStateStore({ path, clock })
      await first.init()
      const second = new SqliteStateStore({ path, clock })
      await second.init()

      expect(await first.acquireLease('pipeline', 600)).not.toBeNull()
      expect(await second.acquireLease('pipeline', 600)).toBeNull()

      await first.close()
      await second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps separate leases separate', async () => {
    const store = await open()
    expect(await store.acquireLease('pipeline', 600)).not.toBeNull()
    expect(await store.acquireLease('device-disposition', 600)).not.toBeNull()
    await store.close()
  })

  it('refuses a lease that would be expired at birth', async () => {
    const store = await open()
    await expect(store.acquireLease('pipeline', 0)).rejects.toThrow(/positive/)
    await store.close()
  })
})

describe('fingerprints', () => {
  it('returns null before anything has been recorded', async () => {
    const store = await open()
    expect(await store.getFingerprint('day7.blocked')).toBeNull()
    await store.close()
  })

  it('stores the latest value with the time it was set', async () => {
    const store = await open()
    await store.setFingerprint('day7.blocked', 'set-of-two-devices')
    expect(await store.getFingerprint('day7.blocked')).toEqual({
      value: 'set-of-two-devices',
      at: '2026-03-31T09:00:00.000Z',
    })

    clock.advanceDays(1)
    await store.setFingerprint('day7.blocked', 'set-of-three-devices')
    expect((await store.getFingerprint('day7.blocked'))?.value).toBe('set-of-three-devices')
    await store.close()
  })
})

describe('counters', () => {
  it('tells a first run apart from a recorded zero', async () => {
    const store = await open()
    // Null means no baseline yet, which is a first run. Zero is a fact worth
    // comparing against. Conflating them either disarms the invariant or
    // blocks the very first run.
    expect(await store.getCounter('people.departed')).toBeNull()
    await store.setCounter('people.departed', 0)
    expect(await store.getCounter('people.departed')).toBe(0)
    await store.close()
  })

  it('refuses a non-integer count', async () => {
    const store = await open()
    await expect(store.setCounter('people.departed', 1.5)).rejects.toThrow(/integer/)
    await store.close()
  })
})

describe('run history', () => {
  it('returns the most recent run of a kind, and nothing for an unknown one', async () => {
    const store = await open()
    await store.recordRun('run-1', 'pipeline', 'day0: 1 person')
    clock.advanceMs(6 * 3_600_000)
    await store.recordRun('run-2', 'pipeline', 'day0: 0 people')
    await store.recordRun('run-3', 'sync', '160 people, 1 change')

    expect(await store.lastRun('pipeline')).toEqual({
      runId: 'run-2',
      at: '2026-03-31T15:00:00.000Z',
      summary: 'day0: 0 people',
    })
    expect(await store.lastRun('device')).toBeNull()
    await store.close()
  })

  it('orders two runs recorded in the same second deterministically', async () => {
    const store = await open()
    await store.recordRun('run-1', 'pipeline', 'first')
    await store.recordRun('run-2', 'pipeline', 'second')
    expect((await store.lastRun('pipeline'))?.runId).toBe('run-2')
    await store.close()
  })
})

describe('opening the state store', () => {
  it('will not answer before init', async () => {
    const store = new SqliteStateStore({ path: ':memory:', clock })
    await expect(store.getCounter('people.departed')).rejects.toThrow(/init/)
  })

  it('closes twice without complaint', async () => {
    const store = await open()
    await store.close()
    await expect(store.close()).resolves.toBeUndefined()
  })
})
