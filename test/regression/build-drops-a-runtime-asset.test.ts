/**
 * Prevents: code that reads a file beside itself shipping without that file.
 *
 * Two directories under src/ hold files read at run time relative to the
 * compiled module. The TypeScript compiler emits only JavaScript, so each one
 * needs an explicit copy step, and the build originally had a step for the
 * notification templates and none for the device scripts. The consequence was
 * invisible in every test and in the demo, because those run from src: only a
 * built install failed, and only on the first device hand-over, which is the
 * one operation that runs a script on somebody's machine.
 *
 * This test does not read dist. It asserts that every module-relative asset
 * directory in the source is named in the build's copy step, so adding a third
 * one and forgetting the build fails here rather than in somebody's fleet.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', '..')
const SRC = join(ROOT, 'src')

/** Every .ts file under src/, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return name.endsWith('.ts') ? [full] : []
  })
}

/**
 * Directories a module resolves against its own location. Matches the two
 * shapes in the source: a `join(dirname(fileURLToPath(import.meta.url)), 'x')`
 * constant and an `import.meta.dirname` equivalent.
 */
function moduleRelativeDirs(text: string): string[] {
  const found: string[] = []
  const pattern =
    /join\(\s*(?:dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dirname)\s*,\s*((?:'[^']+'\s*,?\s*)+)\)/g
  for (const match of text.matchAll(pattern)) {
    const segments = [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    if (segments.length > 0) found.push(segments.join('/'))
  }
  return found
}

describe('the build step and the files the source reads at run time', () => {
  const copyStep = readFileSync(join(ROOT, 'tools', 'copy-assets.mjs'), 'utf8')

  /**
   * A module-relative reference can name a directory (the templates) or a
   * single file (the demo fixture). Both need the same copy step, so a file
   * reference is reduced to the directory that has to survive the build.
   */
  const referenced = [
    ...new Map(
      sources(SRC)
        .flatMap((file) => {
          const dirOfFile = relative(SRC, join(file, '..')).replaceAll('\\', '/')
          return moduleRelativeDirs(readFileSync(file, 'utf8')).map((suffix) => {
            const full = dirOfFile === '' ? suffix : `${dirOfFile}/${suffix}`
            const onDisk = join(SRC, ...full.split('/'))
            const isFile = existsSync(onDisk) && statSync(onDisk).isFile()
            return {
              file: relative(ROOT, file),
              path: isFile ? full.slice(0, full.lastIndexOf('/')) : full,
            }
          })
        })
        .map((entry) => [entry.path, entry] as const),
    ).values(),
  ]

  it('finds the asset directories the source actually reads', () => {
    // A rewrite that stops matching would make every assertion below vacuous.
    expect(referenced.map((r) => r.path).sort()).toEqual([
      'cli/fixtures',
      'engine/device/scripts',
      'notify/templates',
    ])
  })

  it.each(referenced)('copies $path, read by $file', ({ path }) => {
    const segments = path.split('/').map((s) => `'${s}'`).join(', ')
    expect(copyStep).toContain(`dir: [${segments}]`)
  })

  it('names every extension present in each copied directory', () => {
    for (const { path } of referenced) {
      for (const name of readdirSync(join(SRC, ...path.split('/')))) {
        const ext = name.slice(name.lastIndexOf('.'))
        expect(copyStep, `${path}/${name} would not survive the build`).toContain(`'${ext}'`)
      }
    }
  })

  it('is wired into the build script, not just present on disk', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      files: string[]
    }
    expect(pkg.scripts.build).toContain('tools/copy-assets.mjs')
    // The copy writes into dist, so dist has to be a published directory.
    expect(pkg.files).toContain('dist')
  })
})
