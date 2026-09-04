/**
 * A NUL byte in a source file exempts that file from the checks, silently.
 *
 * `tools/lint/check-identifiers.mjs` treats a file containing a NUL as binary
 * and skips it, while still counting it in the number it reports as scanned.
 * `grep` does the same and says nothing, which matters because the README
 * invites a reader to prove for themselves that no host but the vendor APIs is
 * compiled in, using grep.
 *
 * Two files had one, written as a literal control character where an escape
 * was meant: the Google token cache key and the actor header sanitiser. One of
 * those two is the token-minting code. Nothing was wrong with the behaviour;
 * what was wrong is that the two most security-relevant files in the
 * repository were exempt from the secret scan and invisible to grep, and
 * nothing said so.
 *
 * Write control characters as escapes.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '../..')
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'data', 'audit'])
const EXT = new Set(['.ts', '.mjs', '.js', '.json', '.md', '.yaml', '.yml', '.ps1', '.sh'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (EXT.has(extname(entry).toLowerCase())) out.push(full)
  }
  return out
}

describe('the files the linters read', () => {
  it('has no NUL byte in any source, documentation or configuration file', () => {
    const offenders = walk(REPO)
      .filter((file) => readFileSync(file, 'utf8').includes('\u0000'))
      .map((file) => relative(REPO, file))
    expect(offenders).toEqual([])
  })
})
