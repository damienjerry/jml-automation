import { describe, expect, it } from 'vitest'
import {
  decideTransition,
  isPreservedBySync,
  PRESERVED_BY_SYNC,
  TERMINAL_STATUSES,
  TRANSITIONS,
  type TransitionEvent,
} from '../../src/core/transitions.ts'
import type { LifecycleStatus, TransitionOwner } from '../../src/core/types.ts'

const STATUSES: LifecycleStatus[] = ['hired', 'active', 'terminated', 'offboarding', 'departed']
const EVENTS: TransitionEvent[] = [
  'hris.hired',
  'hris.active',
  'hris.terminated',
  'sync.role_change_tombstone',
  'engine.day0_suspended',
  'engine.phantom_departed',
  'engine.day7_departed',
  'human.tombstone',
]
const OWNERS: TransitionOwner[] = ['sync', 'engine', 'human']

describe('the transition table is the whole contract', () => {
  it('allows exactly the combinations in the table and nothing else', () => {
    const allowed: string[] = []
    for (const from of STATUSES) {
      for (const event of EVENTS) {
        for (const owner of OWNERS) {
          const d = decideTransition(from, from, event, owner)
          if (d.allowed) allowed.push(`${from}|${event}|${owner}->${d.to}`)
        }
      }
    }
    const expected = TRANSITIONS.map((t) => `${t.from}|${t.event}|${t.owner}->${t.to}`).sort()
    expect(allowed.sort()).toEqual(expected)
  })

  it('gives every allowed transition a reason a reader can act on', () => {
    for (const t of TRANSITIONS) {
      expect(t.reason.length).toBeGreaterThan(20)
    }
  })
})

describe('departed is terminal', () => {
  it('has no outgoing transition in the table', () => {
    expect(TRANSITIONS.filter((t) => t.from === 'departed')).toEqual([])
  })

  // A pruned tombstone once let hundreds of historic leavers look like new
  // terminations, and the engine started suspending long-closed accounts.
  it('refuses every event from every owner, including a human', () => {
    for (const event of EVENTS) {
      for (const owner of OWNERS) {
        const d = decideTransition('departed', 'departed', event, owner)
        expect(d.allowed).toBe(false)
        expect(d.refusal).toBe('illegal_transition')
      }
    }
  })
})

describe('ownership is enforced, not documented', () => {
  it('refuses the sync the engine transitions', () => {
    const d = decideTransition('terminated', 'terminated', 'engine.day0_suspended', 'sync')
    expect(d.allowed).toBe(false)
    expect(d.refusal).toBe('owner_forbidden')
  })

  it('refuses the engine the sync transitions', () => {
    const d = decideTransition('active', 'active', 'hris.terminated', 'engine')
    expect(d.allowed).toBe(false)
    expect(d.refusal).toBe('owner_forbidden')
  })

  it('lets a human close a row the engine has started', () => {
    const d = decideTransition('offboarding', 'offboarding', 'human.tombstone', 'human')
    expect(d.allowed).toBe(true)
    expect(d.to).toBe('departed')
  })
})

describe('compare-and-set', () => {
  // Hold is re-read before every remote call, so the row can move mid-run.
  it('refuses a write based on a stale read', () => {
    const d = decideTransition('offboarding', 'terminated', 'engine.day0_suspended', 'engine')
    expect(d.allowed).toBe(false)
    expect(d.refusal).toBe('stale_status')
    expect(d.reason).toContain('offboarding')
  })
})

describe('what the sync may not overwrite', () => {
  it('preserves the statuses the offboarding engine owns', () => {
    expect([...PRESERVED_BY_SYNC].sort()).toEqual(['departed', 'offboarding'])
    expect(isPreservedBySync('offboarding')).toBe(true)
    expect(isPreservedBySync('departed')).toBe(true)
    expect(isPreservedBySync('active')).toBe(false)
  })

  it('treats every terminal status as preserved', () => {
    for (const s of TERMINAL_STATUSES) expect(isPreservedBySync(s)).toBe(true)
  })
})

describe('reinstatement before Day 0 only', () => {
  // Before suspension, a cancelled leaver is just an employee again.
  it('allows terminated back to active', () => {
    expect(decideTransition('terminated', 'terminated', 'hris.active', 'sync').allowed).toBe(true)
  })

  // After suspension the sync must not revive the row: the engine never
  // unsuspends anyone automatically. The sync sets hold and parks it instead.
  it('never allows offboarding back to active', () => {
    for (const owner of OWNERS) {
      expect(decideTransition('offboarding', 'offboarding', 'hris.active', owner).allowed).toBe(false)
    }
  })
})
