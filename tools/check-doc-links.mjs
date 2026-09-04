#!/usr/bin/env node
/**
 * Fails when a link in the documentation points at nothing.
 *
 * The docs are not decoration here. A refusal message names the runbook that
 * explains it, the doctor names a docs anchor per failing probe, and the
 * quickstart is the only thing standing between an adopter and an armed
 * pipeline. A link that resolved when it was written and broke when a file was
 * renamed sends somebody looking for the one page that would have stopped them.
 *
 * Anchors are checked as well as paths, because a heading rename is the common
 * case and a dead anchor lands the reader at the top of a long page with no
 * indication that they are in the wrong place.
 *
 * Usage:
 *   node tools/check-doc-links.mjs            # every Markdown file in the repo
 *   node tools/check-doc-links.mjs docs       # a subtree
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

const REPO = process.cwd()
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'data', 'audit'])

/** Schemes that leave the repository and are somebody else's problem. */
const EXTERNAL = /^(https?:|mailto:|tel:|ftp:|data:|#!)/i

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (extname(entry).toLowerCase() === '.md') out.push(full)
  }
  return out
}

/**
 * Remove fenced blocks and inline code so an example link inside a code sample
 * is not reported. A gate that fires on documentation examples gets disabled.
 */
export function stripCode(markdown) {
  const lines = markdown.split('\n')
  const kept = []
  let fence = null
  for (const line of lines) {
    const open = /^\s*(```+|~~~+)/.exec(line)
    if (fence === null && open) {
      fence = open[1][0]
      kept.push('')
      continue
    }
    if (fence !== null) {
      if (open && open[1][0] === fence) fence = null
      kept.push('')
      continue
    }
    kept.push(line.replace(/`[^`]*`/g, ''))
  }
  return kept.join('\n')
}

/** GitHub's heading slug: lower-cased, punctuation dropped, spaces hyphenated. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
}

export function anchorsOf(markdown) {
  const body = stripCode(markdown)
  const seen = new Map()
  const anchors = new Set()
  for (const m of body.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1])
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  // An explicitly written anchor is legitimate and common in generated docs.
  for (const m of body.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(m[1].toLowerCase())
  for (const m of body.matchAll(/\{#([^}]+)\}/g)) anchors.add(m[1].toLowerCase())
  return anchors
}

export function linksOf(markdown) {
  const body = stripCode(markdown)
  const links = []
  for (const m of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push(m[1])
  for (const m of body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm)) links.push(m[1])
  return links
}

function checkFile(file, anchorCache) {
  const rel = relative(REPO, file)
  const text = readFileSync(file, 'utf8')
  const problems = []

  const anchorsFor = (path) => {
    if (!anchorCache.has(path)) anchorCache.set(path, anchorsOf(readFileSync(path, 'utf8')))
    return anchorCache.get(path)
  }

  for (const raw of linksOf(text)) {
    if (EXTERNAL.test(raw)) continue
    const [pathPart, anchor] = raw.split('#')

    if (pathPart === '') {
      if (anchor && !anchorsFor(file).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push({ file: rel, link: raw, why: 'no heading in this file matches the anchor' })
      }
      continue
    }

    const target = resolve(dirname(file), decodeURIComponent(pathPart))
    if (!existsSync(target)) {
      problems.push({ file: rel, link: raw, why: `nothing at ${relative(REPO, target)}` })
      continue
    }
    if (anchor && extname(target).toLowerCase() === '.md') {
      if (!anchorsFor(target).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push({ file: rel, link: raw, why: `no heading in ${relative(REPO, target)} matches the anchor` })
      }
    }
  }
  return problems
}

/**
 * Documentation paths named by the code, not by another document.
 *
 * Every refusal in this toolkit carries a `docsAnchor`, and the CLI prints it
 * as `see docs/...`. Those strings are the ones an adopter reads at the worst
 * moment, and nothing checked them: four pointed at pages that had never been
 * written, so a failing doctor row sent the reader to a file that was not
 * there. They are plain strings rather than Markdown links, so the link walk
 * above cannot see them.
 */
const SOURCE_DIRS = ['src', 'bin', 'tools', 'n8n']
const SOURCE_EXT = new Set(['.ts', '.mjs', '.js', '.json', '.ps1', '.sh'])

/**
 * `data` and `audit` in SKIP_DIRS are the runtime directories at the
 * repository root. Matching them at every level would skip `src/audit`, which
 * is real source, so this walk only skips build output and dependencies.
 */
const SKIP_SOURCE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage'])

function walkSource(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (SKIP_SOURCE_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkSource(full, out)
    else if (SOURCE_EXT.has(extname(entry).toLowerCase())) out.push(full)
  }
  return out
}

export function checkSourceDocRefs(anchorCache = new Map()) {
  const files = SOURCE_DIRS.flatMap((d) => walkSource(resolve(REPO, d)))
  const problems = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\bdocs\/[A-Za-z0-9._/-]+\.md(#[A-Za-z0-9._-]+)?/g)) {
      const [pathPart, anchor] = m[0].split('#')
      const target = resolve(REPO, pathPart)
      if (!existsSync(target)) {
        problems.push({ file: relative(REPO, file), link: m[0], why: `nothing at ${pathPart}` })
        continue
      }
      if (anchor) {
        if (!anchorCache.has(target)) anchorCache.set(target, anchorsOf(readFileSync(target, 'utf8')))
        if (!anchorCache.get(target).has(anchor.toLowerCase())) {
          problems.push({ file: relative(REPO, file), link: m[0], why: `no heading in ${pathPart} matches the anchor` })
        }
      }
    }
  }
  return { files: files.length, problems }
}

export function checkPaths(targets) {
  const files = targets.length
    ? targets.flatMap((t) => (statSync(t).isDirectory() ? walk(resolve(t)) : [resolve(t)]))
    : walk(REPO)
  const anchorCache = new Map()
  const problems = files.flatMap((f) => checkFile(f, anchorCache))
  return { files: files.length, problems }
}

export function main(argv = []) {
  const { files, problems } = checkPaths(argv)
  for (const p of problems) console.log(`BROKEN ${p.file}  ${p.link}: ${p.why}`)
  console.log(`\nchecked ${files} Markdown file(s): ${problems.length} broken link(s)`)

  // Only on a whole-repository run: a subtree argument means somebody is
  // checking their own edit, and the source references are not theirs.
  let refProblems = []
  if (argv.length === 0) {
    const refs = checkSourceDocRefs()
    refProblems = refs.problems
    for (const p of refProblems) console.log(`BROKEN ${p.file}  ${p.link}: ${p.why}`)
    console.log(`checked ${refs.files} source file(s) for documentation references: ${refProblems.length} broken`)
  }
  return problems.length + refProblems.length > 0 ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
