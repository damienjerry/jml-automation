import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every source file must load under `node --experimental-strip-types`.
 *
 * Type stripping removes annotations without rewriting code, so any construct
 * that needs real emit is rejected outright — parameter properties, enums and
 * namespaces among them. The failure is a SyntaxError at load, before a single
 * line runs, and it does not show up in the typecheck, the linter or the test
 * suite: the compiler is perfectly happy with syntax the runtime refuses.
 *
 * That matters because this toolkit is meant to be readable and runnable from
 * source, and it already runs one entry point that way (the config generator).
 * A file can therefore sit in the tree for weeks looking correct and only fail
 * when somebody points a new strip-mode entry point at it — most likely while
 * setting up, which is the worst moment to meet a syntax error in somebody
 * else's code.
 */
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const srcDir = join(root, 'src')

function typescriptSources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...typescriptSources(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found.sort()
}

const sources = typescriptSources(srcDir)

describe('every source file loads under type stripping', () => {
  it('finds the sources to check', () => {
    expect(sources.length).toBeGreaterThan(30)
  })

  for (const file of sources) {
    const name = relative(root, file)
    it(`loads ${name}`, () => {
      try {
        execFileSync(
          process.execPath,
          ['--experimental-strip-types', '--input-type=module', '-e', `await import(${JSON.stringify(file)})`],
          { stdio: 'pipe', encoding: 'utf8' },
        )
      } catch (err) {
        const output = String((err as { stderr?: string }).stderr ?? err)
        // A module that throws on import for its own reasons is not this
        // test's concern. Only syntax the runtime cannot strip is.
        expect(output).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
      }
    })
  }
})
