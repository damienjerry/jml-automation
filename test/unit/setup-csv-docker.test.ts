/**
 * A CSV given to the setup wizard must be readable inside the container.
 *
 * The sidecar container sees only the install's data/ folder. A CSV elsewhere
 * reads fine on the host during setup and is missing on the first scheduled
 * run. Found by an outside review.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askConfiguration } from '../../src/cli/commands/setup/questions.ts'
import { getConfig } from '../../src/cli/commands/setup/files.ts'
import { scriptedPrompter } from '../../src/cli/commands/setup/prompter.ts'

function install(): { dir: string; config: string; env: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jml-csv-docker-'))
  const config = join(dir, 'jml.config.yaml')
  writeFileSync(config, 'version: 1\n')
  writeFileSync(join(dir, '.env'), '')
  return { dir, config, env: join(dir, '.env') }
}

const before = ['Example Organisation', 'example.com', '', 'Europe/London', '', 'admin@example.com', '', 'none', 'csv']
const after = ['', '5', '', 'n']

describe('a CSV people file with Docker', () => {
  it('is copied into data/ and referenced there when it lives elsewhere', async () => {
    const { dir, config, env } = install()
    const outside = join(mkdtempSync(join(tmpdir(), 'jml-export-')), 'staff.csv')
    writeFileSync(outside, 'Employee ID,Work email\n')
    const said: string[] = []
    await askConfiguration(scriptedPrompter([...before, outside, 'y', ...after]), (l) => said.push(l), config, env, { docker: true })
    expect(await getConfig(config, ['hris', 'table', 'path'])).toBe('./data/staff.csv')
    expect(readFileSync(join(dir, 'data', 'staff.csv'), 'utf8')).toBe('Employee ID,Work email\n')
    expect(said.join('\n')).toMatch(/sees only this install's data\/ folder/)
  })

  it('is left where it is, as a relative path, when it is already under data/', async () => {
    const { dir, config, env } = install()
    mkdirSync(join(dir, 'data'))
    writeFileSync(join(dir, 'data', 'people.csv'), 'x\n')
    await askConfiguration(scriptedPrompter([...before, join(dir, 'data', 'people.csv'), ...after]), () => {}, config, env, { docker: true })
    expect(await getConfig(config, ['hris', 'table', 'path'])).toBe('./data/people.csv')
  })

  it('is taken as given without Docker', async () => {
    const { config, env } = install()
    await askConfiguration(scriptedPrompter([...before, '/srv/exports/staff.csv', ...after]), () => {}, config, env, { docker: false })
    expect(await getConfig(config, ['hris', 'table', 'path'])).toBe('/srv/exports/staff.csv')
  })
})
