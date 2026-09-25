import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileRegisterAdapter, parseCsv, splitOwners } from '../../src/register/file.ts'

describe('the file register', () => {
  it('reads a CSV export with quoted cells and several owners in one cell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-register-'))
    const path = join(dir, 'register.csv')
    await writeFile(path, 'Software,Owner Email,Offboarding\r\n"Design, Inc",owner.one@example.com; Owner.Two@example.com,Team-owned\r\nOld CRM,owner.three@example.com,Retired\r\n,,\r\n')
    const rows = await new FileRegisterAdapter({ path }).listPlatforms()
    expect(rows).toEqual([
      { name: 'Design, Inc', owners: ['owner.one@example.com', 'owner.two@example.com'], handling: 'Team-owned' },
      { name: 'Old CRM', owners: ['owner.three@example.com'], handling: 'Retired' },
    ])
  })

  it('reads a JSON export and honours renamed columns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-register-'))
    const path = join(dir, 'register.json')
    await writeFile(path, JSON.stringify([{ Platform: 'Analytics', Owners: 'a@example.com', Handling: 'Team-owned' }]))
    const rows = await new FileRegisterAdapter({ path, nameColumn: 'Platform', ownerColumn: 'Owners', handlingColumn: 'Handling' }).listPlatforms()
    expect(rows).toEqual([{ name: 'Analytics', owners: ['a@example.com'], handling: 'Team-owned' }])
  })

  it('splits owners on commas, semicolons and spaces and drops non-addresses', () => {
    expect(splitOwners('A@example.com, b@example.com;c@example.com  nobody')).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    expect(parseCsv('')).toEqual([])
  })
})
