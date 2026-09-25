/**
 * Switching on owner notifications must not tell every platform owner about
 * every leaver the store has ever held, and must tell each owner about each
 * leaver exactly once, the day after they left. An empty register is a
 * broken read, never a quiet day.
 */
import { describe, expect, it } from 'vitest'
import { runOwnerNotifications } from '../../src/engine/ownernotify/index.ts'
import { FakeRegister, REGISTER } from '../helpers/fake-register.ts'
import { joinerHarness } from '../helpers/joiner-harness.ts'
import { storedPerson } from '../helpers/sync-harness.ts'

const CFG = { ownerNotifications: { enabled: true, goLiveDate: '2026-01-20', lookbackDays: 14, register: { path: 'unused.csv' } } }
const ACTOR = { kind: 'system' as const, id: 'system:test' }
// TODAY in the harness is 2026-01-28.
const leaver = (overrides = {}) => storedPerson({ hrisId: 'hr-leaver', displayName: 'Sam Rivera', primaryEmail: 'sam.rivera@example.com', status: 'terminated', terminationDate: '2026-01-27', ...overrides })

async function run(h: Awaited<ReturnType<typeof joinerHarness>>, register = REGISTER, runId = 'r1') {
  return runOwnerNotifications({ ...h.deps, register }, { dryRun: false, actor: ACTOR, runId })
}

describe('owner notifications', () => {
  it('sends one message per owner, listing the platforms they own, and never the same pair twice', async () => {
    const h = await joinerHarness({ config: CFG, people: [leaver()] })
    await run(h)
    await run(h, REGISTER, 'r2')
    const sent = h.sent.filter((n) => n.kind === 'leaver.owner')
    expect(sent.map((n) => n.recipients)).toEqual([['owner.one@example.com'], ['owner.two@example.com']])
    expect(sent[0]?.body).toContain('Analytics, Design tool')
    // The retired platform's owner is never contacted.
    expect(sent.some((n) => n.recipients?.includes('owner.three@example.com'))).toBe(false)
    expect((await h.store.get('hr-leaver'))?.offboarding?.ownersNotified).toEqual({ 'owner.one@example.com': '2026-01-28', 'owner.two@example.com': '2026-01-28' })
  })

  it('waits until the day after the leaving date', async () => {
    const h = await joinerHarness({ config: CFG, people: [leaver({ terminationDate: '2026-01-28' })] })
    const report = await run(h)
    expect(report.counts.ownerMessages).toBe(0)
  })

  it('never notifies about a leaver whose leaving date is before go-live', async () => {
    const h = await joinerHarness({ config: CFG, people: [leaver({ terminationDate: '2026-01-19' })] })
    const report = await run(h)
    expect(report.counts.ownerMessages).toBe(0)
    expect(report.counts.ownerSkippedBeforeGoLive).toBe(1)
  })

  it('ignores a leaver older than the lookback and a person IT does not provision for', async () => {
    const old = await joinerHarness({ config: { ownerNotifications: { ...CFG.ownerNotifications, goLiveDate: '2025-01-01' } }, people: [leaver({ terminationDate: '2026-01-01' })] })
    expect((await run(old)).counts.ownerMessages).toBe(0)
    const driver = await joinerHarness({ config: CFG, people: [leaver({ inScope: false })] })
    expect((await run(driver)).counts.ownerMessages).toBe(0)
  })

  it('refuses an empty register rather than treating it as nothing to send', async () => {
    const h = await joinerHarness({ config: CFG, people: [leaver()] })
    const report = await run(h, new FakeRegister([{ name: 'X', owners: [], handling: 'Team-owned' }]))
    expect(report.ok).toBe(false)
    expect(report.errors[0]).toContain('refusing')
    expect(h.sent.filter((n) => n.kind === 'leaver.owner')).toEqual([])
  })

  it('records nothing for a message that was not delivered, so it is tried again', async () => {
    const h = await joinerHarness({ config: CFG, people: [leaver()], deliver: (n) => n.recipients?.[0] !== 'owner.two@example.com' })
    const report = await run(h)
    expect(report.ok).toBe(false)
    expect((await h.store.get('hr-leaver'))?.offboarding?.ownersNotified).toEqual({ 'owner.one@example.com': '2026-01-28' })
  })
})
