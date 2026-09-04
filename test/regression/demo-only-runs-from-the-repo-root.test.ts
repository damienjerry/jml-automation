/**
 * Prevents: the demo working only in the repository it was developed in.
 *
 * `jml demo` is the first thing `jml init` tells a newcomer to run, and the
 * only way to watch the state machine decide a suspension and a deletion
 * without pointing the toolkit at real accounts. It read its HR fixture from a
 * path relative to the working directory, and that path was under test/, which
 * is not a published directory. So it worked in the test runner and in the
 * repository root, and nowhere else: from any other directory it failed, and
 * from an installed copy it could never work, because the file was not there.
 *
 * The failure mode is worth naming. Somebody evaluating whether to trust this
 * with account deletion runs the one command that proves it, gets a missing
 * file, and their next move is to arm it against a real tenant to see what it
 * does. A broken demo pushes people towards the dangerous path.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_FIXTURE, DEMO_FIXTURE_LABEL, runDemo } from '../../src/cli/demo.ts'

const ROOT = join(import.meta.dirname, '..', '..')

describe('the demo fixture', () => {
  it('resolves against the module, not the working directory', () => {
    expect(isAbsolute(DEMO_FIXTURE)).toBe(true)
    expect(existsSync(DEMO_FIXTURE)).toBe(true)
  })

  it('lives under src, so the build copies it into the published package', () => {
    // Under test/ it is not published: package.json ships dist, bin, n8n,
    // schema and a handful of files, and nothing else.
    expect(DEMO_FIXTURE).toContain(join('src', 'cli', 'fixtures'))
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('dist')
    const copyStep = readFileSync(join(ROOT, 'tools', 'copy-assets.mjs'), 'utf8')
    expect(copyStep).toContain("dir: ['cli', 'fixtures']")
  })

  it('runs with the process working directory somewhere else entirely', async () => {
    const original = process.cwd()
    process.chdir(import.meta.dirname)
    try {
      const result = await runDemo({ write: () => {} })
      expect(result.ok).toBe(true)
      // The whole lifecycle, not just a clean start: a suspension, a
      // hand-over and a deletion.
      expect(result.reports.length).toBeGreaterThanOrEqual(4)
    } finally {
      process.chdir(original)
    }
  })

  it('names the fixture rather than printing a machine-specific path', async () => {
    const result = await runDemo({ write: () => {} })
    expect(result.output).toContain(DEMO_FIXTURE_LABEL)
    // An absolute install path in the output would differ per machine and make
    // the demo's own snapshot test unassertable, which is how the old relative
    // path survived: it looked stable because it was wrong everywhere equally.
    expect(result.output).not.toContain(ROOT)
  })
})
