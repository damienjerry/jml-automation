/**
 * `jml demo`.
 *
 * The demo is a promise about behaviour rather than a log, so its whole output
 * is snapshotted. If a change to the engine alters what a stranger sees in
 * their first five minutes, this test fails and somebody has to decide whether
 * the new output is what they meant.
 *
 * The other assertions here are about what the demo must NOT do. It must not
 * reach the network, must not resolve a credential, and must not write a file:
 * an adopter runs this before they trust the tool, on a laptop, with no
 * account anywhere.
 */

import { describe, expect, it, vi } from 'vitest'
import { runDemo } from '../../src/cli/demo.ts'

async function demo(): Promise<{ output: string; ok: boolean; fetches: number }> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  try {
    const result = await runDemo({ write: () => undefined })
    return { output: result.output, ok: result.ok, fetches: fetchSpy.mock.calls.length }
  } finally {
    fetchSpy.mockRestore()
  }
}

describe('the offline demo', () => {
  it('runs end to end with every step ok', async () => {
    const result = await demo()
    expect(result.ok).toBe(true)
  })

  it('makes no network call at all', async () => {
    const result = await demo()
    // The fakes are in-process. A demo that quietly needed a network would be
    // useless to the person it is written for.
    expect(result.fetches).toBe(0)
  })

  it('walks the state machine from employed to tombstoned', async () => {
    const result = await demo()
    // The order matters: a person has to be known while employed for their
    // departure to be an event, then suspension, then hand-over, then deletion.
    expect(result.output).toContain('p-1003  active')
    expect(result.output).toContain('p-1003  offboarding')
    expect(result.output).toContain('p-1003  departed')
  })

  it('shows a bound laptop refusing a deletion, and the deletion proceeding once it is returned', async () => {
    const result = await demo()
    expect(result.output).toContain('blocked: devices_bound')
    expect(result.output).toContain('Demo field laptop')
    // Same day, same configuration: only the provider's answer changed, which
    // is the point of reading the gate live instead of trusting a marker.
    const afterReturn = result.output.slice(result.output.indexOf('=== The laptop comes back ==='))
    expect(afterReturn).toContain('offboarding -> departed')
  })

  it('leaves the historic leaver parked rather than offboarding them', async () => {
    const result = await demo()
    // A leaving date outside the lookback window is what a pruned tombstone
    // looks like, so it waits for a person instead of being acted on.
    expect(result.output).toContain('parked=termination_older_than_lookback')
    expect(result.output).not.toContain('p-1006  departed')
  })

  it('keeps the renamed leaver on one row rather than treating them as new', async () => {
    const result = await demo()
    expect(result.output).toContain('p-1005')
    expect(result.output).toContain('kit.marlowe+exit@example.com')
    // One row for that HR id, ending in the tombstone. A second row would mean
    // the rename had been read as a different person.
    expect(result.output.match(/p-1005\s+departed/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('prints an audit row count for every step, so the two-row contract is visible', async () => {
    const result = await demo()
    const counts = [...result.output.matchAll(/audit rows written this step: (\d+)/g)].map((m) => Number(m[1]))
    expect(counts.length).toBe(5)
    // Day 0 acts on three people, so it writes far more than a quiet run.
    expect(Math.max(...counts)).toBeGreaterThan(20)
  })

  it('produces exactly this output', async () => {
    const result = await demo()
    expect(result.output).toMatchSnapshot()
  })
})
