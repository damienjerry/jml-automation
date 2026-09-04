#!/usr/bin/env node
/**
 * Fails when a generated artefact in the working tree is stale.
 *
 * `.env.example`, `jml.config.example.yaml`, `schema/jml.config.schema.json`
 * and `docs/config-reference.md` are all projections of src/config/schema.ts.
 * Without this check they drift, and the drift is silent in the worst possible
 * way: an operator copies a documented environment variable name that nothing
 * reads, and the setting they think they applied is not applied.
 *
 * The generator is run into a temporary directory and the output compared byte
 * for byte, so this cannot pass by regenerating over the top of a mistake.
 *
 * Usage:
 *   node tools/check-generated.mjs
 *   node tools/check-generated.mjs --write    # regenerate in place
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const GENERATOR = 'src/config/generate.ts'
const ARTEFACTS = [
  '.env.example',
  'jml.config.example.yaml',
  'schema/jml.config.schema.json',
  'docs/config-reference.md',
]

const write = process.argv.includes('--write')

function generateInto(dir) {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', GENERATOR, dir], {
      cwd: REPO,
      stdio: 'pipe',
    })
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : ''
    console.error('the generator failed to run:\n' + stderr)
    process.exit(1)
  }
}

if (write) {
  generateInto(REPO)
  console.log('regenerated ' + ARTEFACTS.length + ' artefacts in place')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'jml-generated-'))
try {
  generateInto(scratch)

  const stale = []
  for (const artefact of ARTEFACTS) {
    const expected = readFileSync(join(scratch, artefact), 'utf8')
    const committedPath = join(REPO, artefact)
    if (!existsSync(committedPath)) {
      stale.push({ artefact, why: 'missing from the working tree' })
      continue
    }
    const actual = readFileSync(committedPath, 'utf8')
    if (actual !== expected) {
      stale.push({ artefact, why: 'differs from what the schema generates (' + actual.length + ' vs ' + expected.length + ' bytes)' })
    }
  }

  if (stale.length > 0) {
    for (const item of stale) console.log('STALE ' + item.artefact + ': ' + item.why)
    console.log('\nRun `npm run generate` and commit the result.')
    process.exit(1)
  }
  console.log('checked ' + ARTEFACTS.length + ' generated artefacts: all current')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
