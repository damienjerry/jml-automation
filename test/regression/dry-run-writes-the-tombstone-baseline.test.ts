/**
 * Prevents: a dry run writing anything at all.
 *
 * The claim made everywhere in this toolkit is that a rehearsal plans and
 * reports and touches nothing. It was true of every provider and of every
 * person row, and not quite true of the toolkit's own bookkeeping: the
 * tombstone invariant read the recorded count and wrote today's back on the
 * way past, in a dry run as much as an armed one.
 *
 * The direction was harmless, because that counter only ever moves upwards and
 * a higher baseline makes the next run stricter rather than looser. It is
 * still the wrong answer to the question. Somebody deciding whether to trust
 * this with account deletion spies on the store and the connectors, sees one
 * write they did not expect, and now has to reason about which writes are the
 * safe kind. "No" is the only answer to "does a dry run write" that does not
 * need a footnote.
 *
 * Nothing is lost by skipping it: an absent baseline never aborts a run, and
 * the armed run raises it afterwards.
 */

import { describe, expect, it } from 'vitest'
import { DEPARTED_COUNTER, checkDepartedInvariant } from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import { fakeStateStore } from '../unit/fake-state-store.ts'
import { personFixture } from '../fixtures/leaver/harness.ts'

function departed(count: number) {
  return Array.from({ length: count }, (_, i) =>
    personFixture({
      hrisId: `gone-${i}`,
      primaryEmail: `gone${i}@example.com`,
      status: 'departed',
      offboarding: { suspendedAt: '2026-01-01', legs: {} },
    }),
  )
}

describe('the tombstone invariant during a rehearsal', () => {
  it('reads the baseline and does not write it', async () => {
    const people = new MemoryPeopleStore({ seed: departed(3) })
    const state = fakeStateStore()

    const result = await checkDepartedInvariant(people, state, { dryRun: true })

    expect(result).toMatchObject({ ok: true, previous: null, current: 3 })
    expect(await state.getCounter(DEPARTED_COUNTER)).toBeNull()
  })

  it('still refuses when the count has fallen, which is the whole point of it', async () => {
    const people = new MemoryPeopleStore({ seed: departed(2) })
    const state = fakeStateStore()
    await state.setCounter(DEPARTED_COUNTER, 10)

    const result = await checkDepartedInvariant(people, state, { dryRun: true })

    expect(result.ok).toBe(false)
    // And it leaves the higher baseline in place, so the next run refuses too.
    expect(await state.getCounter(DEPARTED_COUNTER)).toBe(10)
  })

  it('writes the baseline on an armed run, so the check has something to compare', async () => {
    const people = new MemoryPeopleStore({ seed: departed(4) })
    const state = fakeStateStore()

    await checkDepartedInvariant(people, state)

    expect(await state.getCounter(DEPARTED_COUNTER)).toBe(4)
  })

  it('defaults to writing, so an existing caller is unchanged', async () => {
    const people = new MemoryPeopleStore({ seed: departed(1) })
    const state = fakeStateStore()

    await checkDepartedInvariant(people, state, {})

    expect(await state.getCounter(DEPARTED_COUNTER)).toBe(1)
  })
})
