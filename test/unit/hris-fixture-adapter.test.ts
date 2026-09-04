import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureHrisAdapter, readFixtureFile, validateFixture } from '../../src/hris/fixture.ts'
import { HrisImplausible, HrisIncomplete } from '../../src/hris/types.ts'

const DEMO = 'src/cli/fixtures/demo.json'

/** A one-off fixture on disk, for shapes not worth committing. */
async function writeTemp(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-hris-'))
  const path = join(dir, 'snapshot.json')
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

describe('the demo snapshot', () => {
  it('holds the seven people the demo needs', async () => {
    const snapshot = await new FixtureHrisAdapter({ path: DEMO }).fetchAll()

    expect(snapshot.all).toHaveLength(7)
    expect([...snapshot.activeIds].sort()).toEqual(['p-1001', 'p-1002', 'p-1007'])
    expect(snapshot.complete).toBe(true)
  })

  it('covers each case the lifecycle has to handle', async () => {
    const snapshot = await new FixtureHrisAdapter({ path: DEMO }).fetchAll()
    const byId = new Map(snapshot.all.map((p) => [p.hrisId, p]))
    const file = await readFixtureFile(DEMO)
    const today = file.demoToday ?? ''
    const dateOf = (id: string): string => byId.get(id)?.terminationDate ?? ''

    // An employee, and a starter whose first day is still ahead.
    expect(snapshot.activeIds.has('p-1001')).toBe(true)
    expect(byId.get('p-1002')?.startDate).toBe('2026-02-02')
    expect((byId.get('p-1002')?.startDate ?? '') > today).toBe(true)

    // A leaver on the day itself, and one far enough back to be mid-flight.
    expect(byId.get('p-1003')?.terminationDate).toBe(today)
    expect(dateOf('p-1004') < today).toBe(true)

    // The exit rename: the HR system now shows a plus-addressed mailbox while
    // the id is unchanged, which is what makes it an alias and not a new
    // person.
    expect(byId.get('p-1005')?.primaryEmail).toContain('+exit@')

    // A historic leaver, outside any sensible lookback window.
    expect(dateOf('p-1006') < '2025-11-16').toBe(true)

    // Somebody employed with no work mailbox at all.
    expect(byId.get('p-1007')?.primaryEmail).toBe('')
    expect(snapshot.activeIds.has('p-1007')).toBe(true)

    // Every leaver reports to somebody who is still employed, so the transfer
    // step has a recipient to resolve.
    for (const id of ['p-1003', 'p-1004', 'p-1005', 'p-1006']) {
      expect(byId.get(id)?.managerEmail).toBe('jane.doe@example.com')
    }
  })

  it('reports what it is without a credential', async () => {
    const check = await new FixtureHrisAdapter({ path: DEMO }).testConnection()

    expect(check.ok).toBe(true)
    expect(check.detail).toContain('no credential required')
  })
})

describe('a fixture that cannot be trusted', () => {
  it('throws on a read marked truncated', async () => {
    const adapter = new FixtureHrisAdapter({ path: 'test/fixtures/hris/truncated.json' })

    await expect(adapter.fetchAll()).rejects.toBeInstanceOf(HrisIncomplete)
  })

  it('aborts below the headcount floor', async () => {
    const error = await new FixtureHrisAdapter({ path: DEMO, minPlausibleHeadcount: 40 })
      .fetchAll()
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HrisImplausible)
    expect((error as HrisImplausible).detail).toEqual({ received: 7, floor: 40 })
  })

  it('refuses a file with no employed list', () => {
    // Neither default is safe: an empty one reads as everybody having left,
    // and a full one makes a leaver impossible to write down.
    expect(() => validateFixture({ people: [] }, 'x.json')).toThrow(HrisIncomplete)
  })

  it('refuses an employed id that is not in people', async () => {
    // A snapshot that contradicts itself cannot be reasoned about: the missing
    // person is either employed or gone, and guessing either way is a write.
    const path = await writeTemp({ people: [{ hrisId: 'p-1' }], activeIds: ['p-1', 'p-2'] })

    await expect(new FixtureHrisAdapter({ path }).fetchAll()).rejects.toBeInstanceOf(HrisIncomplete)
  })

  it('refuses a locale-formatted date', () => {
    expect(() =>
      validateFixture(
        { people: [{ hrisId: 'p-1', terminationDate: '09/01/2026' }], activeIds: [] },
        'x.json',
      ),
    ).toThrow(/ISO date/)
  })

  it('refuses a repeated id, because an id is one person', () => {
    expect(() =>
      validateFixture({ people: [{ hrisId: 'p-1' }, { hrisId: 'p-1' }], activeIds: [] }, 'x.json'),
    ).toThrow(/twice/)
  })

  it('reports a missing file as a failed check rather than throwing', async () => {
    const check = await new FixtureHrisAdapter({ path: 'test/fixtures/hris/absent.json' }).testConnection()

    expect(check.ok).toBe(false)
    expect(check.remediation).toContain('activeIds')
  })
})
