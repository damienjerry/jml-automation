import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  anchorsOf,
  checkPaths,
  linksOf,
  main,
  slug,
  stripCode,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../tools/check-doc-links.mjs'

interface Problem {
  file: string
  link: string
  why: string
}

const scratches: string[] = []
function docsTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jml-docs-'))
  scratches.push(dir)
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

const problemsIn = (dir: string): Problem[] => (checkPaths([dir]) as { problems: Problem[] }).problems

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the documentation in this repository', () => {
  it('has no broken relative link or anchor', () => {
    // The docs carry load here: a refusal message names the runbook that
    // explains it, and the doctor names an anchor per failing probe. A link
    // that broke on a rename sends the reader looking for the one page that
    // would have stopped them.
    const { problems } = checkPaths([]) as { problems: Problem[] }
    expect(problems).toEqual([])
  })
})

describe('finding links', () => {
  it('reports a link to a file that is not there', () => {
    const dir = docsTree({ 'a.md': '# A\n\nSee [the runbook](runbooks/missing.md).\n' })
    expect(problemsIn(dir).map((p) => p.link)).toEqual(['runbooks/missing.md'])
  })

  it('accepts a link that resolves across directories', () => {
    const dir = docsTree({
      'a.md': '# A\n\nSee [the runbook](runbooks/canary.md).\n',
      'runbooks/canary.md': '# Canary\n\nBack to [A](../a.md).\n',
    })
    expect(problemsIn(dir)).toEqual([])
  })

  it('reads a reference-style definition as well as an inline link', () => {
    const dir = docsTree({ 'a.md': '# A\n\nSee [the runbook][rb].\n\n[rb]: runbooks/missing.md\n' })
    expect(problemsIn(dir).map((p) => p.link)).toEqual(['runbooks/missing.md'])
  })

  it('ignores an external link, which is somebody else to keep working', () => {
    const dir = docsTree({ 'a.md': '# A\n\n[docs](https://example.com/x) and [mail](mailto:jane.doe@example.com)\n' })
    expect(problemsIn(dir)).toEqual([])
  })

  it('ignores a link inside a code sample', () => {
    // A gate that fires on documentation examples is a gate somebody turns off.
    const dir = docsTree({ 'a.md': '# A\n\n```\nsee [nowhere](nowhere.md)\n```\n\nand `[also](gone.md)` inline.\n' })
    expect(problemsIn(dir)).toEqual([])
  })

  it('picks links out of prose without a code fence confusing it', () => {
    expect(linksOf('[a](one.md) ![b](two.png)\n\n[c]: three.md\n')).toEqual(['one.md', 'two.png', 'three.md'])
    expect(stripCode('before\n```\n[x](y.md)\n```\nafter')).not.toContain('y.md')
  })
})

describe('anchors', () => {
  it('reports an anchor no heading matches', () => {
    const dir = docsTree({
      'a.md': '# A\n\nSee [the check](b.md#no-such-heading).\n',
      'b.md': '# B\n\n## A real heading\n',
    })
    const problems = problemsIn(dir)
    expect(problems).toHaveLength(1)
    expect(problems[0]?.link).toBe('b.md#no-such-heading')
    expect(problems[0]?.why).toContain('matches the anchor')
  })

  it('accepts an anchor that matches a heading, including within the same file', () => {
    const dir = docsTree({
      'a.md': '# A\n\n## Set the token\n\nJump to [the token](#set-the-token) and [B](b.md#other-half).\n',
      'b.md': '# B\n\n## Other half\n',
    })
    expect(problemsIn(dir)).toEqual([])
  })

  it('numbers repeated headings the way a Markdown renderer does', () => {
    expect([...(anchorsOf('# Set up\n\n## Notes\n\n## Notes\n') as Set<string>)]).toEqual(['set-up', 'notes', 'notes-1'])
  })

  it('slugs a heading with punctuation in it', () => {
    expect(slug('Why there is no logic here')).toBe('why-there-is-no-logic-here')
    expect(slug('`jml doctor`, and the dead man')).toBe('jml-doctor-and-the-dead-man')
  })
})

describe('the checker as a command', () => {
  it('exits non-zero when a link is broken and zero when none is', () => {
    const broken = docsTree({ 'a.md': '[x](gone.md)\n' })
    const fine = docsTree({ 'a.md': '# A\n' })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(main([broken])).toBe(1)
    expect(main([fine])).toBe(0)
  })
})
