/**
 * A team on Google Workspace alone could not use the toolkit.
 *
 * Every leaver step assumed an identity provider in front of Google: day 0
 * suspended a JumpCloud account and would not write its marker until that
 * suspension read back, day 7 deleted it, and the device gate read JumpCloud's
 * bindings. With `identity.adapter: none` (setup 1.0b) the Google account is
 * the door. Day 0 closes it (a password nobody holds, a change at next sign-in
 * that reads back, every session ended), day 7 deletes only Google, and the
 * device gate says on every deletion that no inventory was checked, rather
 * than reading an absent inventory as "nothing bound".
 */
import { describe, expect, it } from 'vitest'
import { NoIdentityProvider } from '../../src/connectors/google/identity.ts'
import { addDays } from '../../src/core/clock.ts'
import { runLeaverEngine } from '../../src/engine/leaver/engine.ts'
import { LEAVER_ID, TODAY, defaultSeed, harness, leaverConfig, suspendedPersonFixture } from '../fixtures/leaver/harness.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:leaver-engine' }, runId: 'run-1' }
const GOOGLE_ONLY = { identity: { adapter: 'none' } }
const ARMED = ['suspend', 'autoreply', 'licence', 'transfer', 'google_suspend', 'delete']

function googleOnly(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ ...opts, config: { ...GOOGLE_ONLY, ...(opts.config ?? {}) } })
  h.deps.idp = new NoIdentityProvider()
  return h
}

describe('setup 1.0b: Google Workspace with no identity provider', () => {
  it('day 0 closes the Google account, touches no identity provider, and moves the row on', async () => {
    const h = googleOnly({ armed: ARMED })
    await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('idp.'))).toEqual([])
    expect(h.calls.filter((c) => c.startsWith('google.closeUser'))).toHaveLength(1)
    const row = await h.store.get(LEAVER_ID)
    expect(row?.status).toBe('offboarding')
    expect(row?.offboarding?.legs?.['close_google']).toMatchObject({ state: 'done', verified: true })
    expect(row?.offboarding?.legs?.['suspend_idp']).toBeUndefined()
  })

  it('day 0 writes no marker when the close does not read back', async () => {
    const h = googleOnly({ armed: ARMED })
    h.providers.fault('google.closeUser', { kind: 'unverified' })
    const report = await runLeaverEngine(h.deps, RUN)
    expect((await h.store.get(LEAVER_ID))?.status).not.toBe('offboarding')
    expect(report.ok).toBe(false)
  })

  it('day 7 deletes only Google, and says no device inventory was checked', async () => {
    const suspended = addDays(TODAY, -8)
    const person = suspendedPersonFixture(suspended, {
      terminationDate: addDays(TODAY, -9),
      offboarding: { suspendedAt: suspended, transferredAt: suspended, legs: {} },
    })
    const seed = { ...defaultSeed(), google: (defaultSeed().google ?? []).map((a) => ({ ...a, suspended: true })) }
    const h = googleOnly({ people: [person], seed, armed: ARMED })
    const report = await runLeaverEngine(h.deps, RUN)

    expect(h.calls.filter((c) => c.startsWith('idp.') || c.startsWith('devices.'))).toEqual([])
    expect(h.calls.filter((c) => c.startsWith('google.deleteUser'))).toHaveLength(1)
    expect((await h.store.get(LEAVER_ID))?.status).toBe('departed')
    expect(JSON.stringify(report)).toContain('no device inventory')
  })

  it('the device gate does not read devices under a none setup, even if an account turns up', async () => {
    // A left-over JumpCloud account must not bring the device read back: the
    // setup says there is no inventory, and an inventory read that can fail
    // would block every deletion.
    const suspended = addDays(TODAY, -8)
    const person = suspendedPersonFixture(suspended, {
      terminationDate: addDays(TODAY, -9),
      offboarding: { suspendedAt: suspended, transferredAt: suspended, legs: {} },
    })
    const seed = defaultSeed()
    const h = harness({ people: [person], seed: { ...seed, google: (seed.google ?? []).map((a) => ({ ...a, suspended: true })) }, armed: ARMED, config: GOOGLE_ONLY })
    await runLeaverEngine(h.deps, RUN)
    expect(h.calls.filter((c) => c.startsWith('devices.'))).toEqual([])
    expect((await h.store.get(LEAVER_ID))?.status).toBe('departed')
  })

  it('refuses a JumpCloud setup with no JumpCloud block, and device steps with no inventory', () => {
    expect(() => leaverConfig({ identity: { adapter: 'jumpcloud' } })).toThrow(/identity.jumpcloud/)
    expect(() => leaverConfig(GOOGLE_ONLY, ['suspend', 'device_unbind'])).toThrow(/no device inventory/)
    expect(() => leaverConfig(GOOGLE_ONLY, ARMED)).not.toThrow()
  })
})
