/**
 * Bootstrapping from a CSV or a sheet imported no history, and said ok.
 *
 * A table source lists everybody on its employed list and lets the dates say
 * who has gone. Bootstrap skipped anybody on the employed list before looking
 * at a date, so a person who left in 2020 was counted as active, nothing was
 * imported, and the report read ok. Sync has its own guard (it never creates a
 * row for a leaver it has not seen), so this was not a mass offboarding, but
 * the history bootstrap exists to record was silently never recorded.
 *
 * Bootstrap now decides who has left by the same rule as the sync. Found by an
 * outside review, which reproduced it.
 */
import { describe, expect, it } from 'vitest'
import { snapshotFromRows, type TableColumns } from '../../src/hris/table.ts'
import { bootstrapTombstones } from '../../src/store/bootstrap.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'

const COLUMNS: TableColumns = {
  hrisId: 'Employee ID', primaryEmail: 'Work email', firstName: 'First name', lastName: 'Last name', displayName: null,
  department: null, jobTitle: null, managerEmail: null, personalEmail: null,
  startDate: 'Start date', lastWorkingDay: 'Last working day', terminationDate: null, inScope: null,
}
const rows = [
  ['Employee ID', 'First name', 'Last name', 'Work email', 'Start date', 'Last working day'],
  ['E1', 'Alex', 'Morgan', 'alex.morgan@example.com', '2019-01-07', '2020-05-29'],
  ['E2', 'Robin', 'Ellis', 'robin.ellis@example.com', '2021-03-01', ''],
  ['E3', 'Sam', 'Rivera', 'sam.rivera@example.com', '2026-10-05', ''],
  ['E4', 'Jo', 'Patel', 'jo.patel@example.com', '2022-02-01', '2026-09-20'],
]

async function run() {
  const people = new MemoryPeopleStore()
  await people.init()
  const snapshot = snapshotFromRows(rows, { source: 'people.csv', columns: COLUMNS, dateFormat: 'YYYY-MM-DD', inScopeValues: [], minPlausibleHeadcount: 1 })
  const report = await bootstrapTombstones({ people, snapshot, today: '2026-09-27', recentLeaverDays: 30 })
  return { people, report }
}

describe('bootstrap from a table source', () => {
  it('imports the people who have left, and leaves the employed and the starters alone', async () => {
    const { people, report } = await run()
    expect(report.tombstoned).toBe(2)
    expect((await people.get('E1'))?.status).toBe('departed')
    expect((await people.get('E4'))?.status).toBe('departed')
    expect(await people.get('E2')).toBeNull()
    expect(await people.get('E3')).toBeNull()
    expect(report).toMatchObject({ skippedActive: 1, skippedHired: 1 })
  })

  it('names a recent leaver, whose accounts the toolkit will now never close', async () => {
    const { report } = await run()
    const warning = report.warnings.join(' ')
    expect(warning).toMatch(/1 leaver\(s\) left within the last 30 days/)
    expect(warning).toContain('Jo Patel (E4, last day 2026-09-20)')
    expect(warning).not.toContain('Alex Morgan')
  })
})
