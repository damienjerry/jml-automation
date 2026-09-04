#!/usr/bin/env node
/**
 * Identifier gate for a public repository.
 *
 * The toolkit must ship with no trace of any real organisation: no live email
 * addresses, no tenant or directory ids, no chat channel ids, no hostnames.
 * Substituting those by hand is unreliable, so this check runs in CI and fails
 * the build when a real-looking identifier appears.
 *
 * The rules below match identifier SHAPES, not any particular organisation, so
 * this file is safe to publish. An operator porting private automation can add
 * their own literal strings to tools/lint/denylist.local.txt, which is
 * gitignored and therefore never becomes part of the public history.
 *
 * Usage:
 *   node tools/lint/check-identifiers.mjs [paths...]     # defaults to the repo
 *   ALLOW_TODO=1 node tools/lint/check-identifiers.mjs   # downgrade TODO markers
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'

const REPO = process.cwd()

/** Directories never worth scanning. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.terraform', 'data',
])

/**
 * Dependency lockfiles are written by the package manager, not by an author.
 * Their contents come from the public registry and include third-party
 * maintainer email addresses, which cannot be redacted without breaking
 * `npm ci`. Scanning them for identifier shapes therefore produces failures
 * nobody can act on, in a file nobody edits, which is how a gate becomes
 * something people learn to skip.
 *
 * They are not simply ignored. The one way a lockfile CAN expose an
 * organisation is by resolving packages through a private registry, so that
 * is checked directly in `auditLockfile` below.
 */
const VENDOR_LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'])

/** Binary-ish extensions the scanner cannot usefully read. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.tgz', '.woff', '.woff2', '.ttf', '.mp4', '.mov', '.sqlite', '.db',
])

/**
 * Placeholders that are deliberately allowed anywhere. Everything the docs and
 * examples use must come from this list, so a reviewer can tell an intentional
 * example from a leaked value at a glance.
 */
const ALLOWED = [
  /\$\{[A-Z0-9_]+\}/g,                    // ${ORG_PRIMARY_DOMAIN}
  /<[a-z][a-z0-9-]*>/g,                   // <your-domain>
  /\bexample\.(com|org|net)\b/g,
  /\bexample\.test\b/g,
  /\blegacy\.example\.com\b/g,
  /\bcontoso\.onmicrosoft\.com\b/g,       // Microsoft's own documentation tenant
  /\bmy_customer\b/g,                     // Google Admin SDK literal
  /\bjane\.doe\b/g,
  /\bjohn\.doe\b/g,
  /\blocalhost\b/g,
  /\b127\.0\.0\.1\b/g,
  /\b0\.0\.0\.0\b/g,
]

const RULES = [
  {
    id: 'email-address',
    severity: 'error',
    describe: 'email address that is not an approved example',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    ignore: (m) =>
      /@(example\.(com|org|net)|example\.test|legacy\.example\.com|contoso\.onmicrosoft\.com)$/i.test(m) ||
      /@\$\{[A-Z0-9_]+\}/.test(m),
  },
  {
    id: 'jumpcloud-object-id',
    severity: 'error',
    describe: '24-character hex id (JumpCloud org, user, system or command)',
    regex: /\b[0-9a-f]{24}\b/g,
  },
  {
    id: 'notion-uuid',
    severity: 'error',
    describe: '32-character hex or dashed UUID (Notion database or page id)',
    regex: /\b([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
    ignore: (m) => /^0+$/.test(m.replace(/-/g, '')),
  },
  {
    id: 'slack-object-id',
    severity: 'error',
    describe: 'Slack team, channel, user, bot or app id',
    regex: /\b(?:[CUBA]0[A-Z0-9]{8,}|T[A-Z0-9]{8,})\b/g,
    // Slack ids are base-encoded counters and always carry at least one digit.
    // Without this, any long SCREAMING_CASE identifier starting with T matches
    // (TRANSITIONS was the first casualty). A shape rule that fires on ordinary
    // code gets switched off by whoever it annoys, which is worse than a gap.
    ignore: (m) => !/\d/.test(m),
  },
  {
    id: 'private-ip',
    severity: 'error',
    describe: 'private network address',
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'public-ip-literal',
    severity: 'warn',
    describe: 'IPv4 literal, which may be a real host',
    regex: /\b(?!0\.0\.0\.0|127\.0\.0\.1|255\.255\.255\.255)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    ignore: (m) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(m),
  },
  {
    id: 'device-hostname',
    severity: 'error',
    describe: 'device hostname following a fleet naming convention',
    regex: /\b(?:WIN|MAC|LIN)-[A-Z0-9]{6,}\b/g,
  },
  {
    id: 'gcp-project-id',
    severity: 'warn',
    describe: 'value that looks like a Google Cloud project id',
    regex: /\b[a-z][a-z0-9-]{4,28}-\d{4,8}\b/g,
  },
  {
    id: 'google-customer-id',
    severity: 'error',
    describe: 'Google Workspace customer id',
    regex: /\bC0[0-9a-z]{7,8}\b/g,
  },
  {
    id: 'onmicrosoft-tenant',
    severity: 'error',
    describe: 'Azure tenant domain',
    regex: /\b[a-z0-9-]+\.onmicrosoft\.com\b/g,
    ignore: (m) => m === 'contoso.onmicrosoft.com',
  },
  {
    id: 'todo-placeholder',
    severity: process.env.ALLOW_TODO ? 'warn' : 'error',
    describe: 'unresolved placeholder marker left in a published file',
    regex: /\b(?:TODO_REPLACE|FIXME_ORG|XXX_ORG)\b/g,
  },
]

/** Literal strings an operator wants blocked, kept out of the repository. */
function localDenylist() {
  const file = join(REPO, 'tools/lint/denylist.local.txt')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (!SKIP_EXT.has(extname(entry).toLowerCase()) && st.size < 2_000_000) out.push(full)
  }
  return out
}

/** Blank out every approved placeholder so it cannot trip a shape rule. */
function mask(line) {
  let masked = line
  for (const re of ALLOWED) masked = masked.replace(re, (m) => ' '.repeat(m.length))
  return masked
}

/** A file is treated as binary when it contains a NUL byte. */
function isBinary(text) {
  return text.includes('\u0000')
}

function scan(files, denylist) {
  const findings = []
  const denyRules = denylist.map((word) => ({
    id: 'local-denylist',
    severity: 'error',
    describe: `string on the local denylist (${word.length} chars)`,
    regex: new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
  }))

  for (const file of files) {
    const rel = relative(REPO, file)
    if (rel === 'tools/lint/check-identifiers.mjs') continue // this file defines the patterns
    if (basename(rel).startsWith('denylist.local')) continue
    if (VENDOR_LOCKFILES.has(basename(rel))) continue // audited separately, see auditLockfile
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (isBinary(text)) continue

    text.split('\n').forEach((raw, i) => {
      if (/identifier-lint:\s*ignore/.test(raw)) return
      const line = mask(raw)
      for (const rule of [...RULES, ...denyRules]) {
        for (const m of line.matchAll(rule.regex)) {
          const value = m[0]
          if (rule.ignore?.(value)) continue
          findings.push({
            file: rel,
            line: i + 1,
            rule: rule.id,
            severity: rule.severity,
            describe: rule.describe,
            // Report the shape and length, never the whole value, so CI logs
            // stay safe to read in a public pull request.
            preview: value.length > 12 ? `${value.slice(0, 6)}...(${value.length} chars)` : value,
          })
        }
      }
    })
  }
  return findings
}

/**
 * A lockfile must resolve every package from a public registry.
 *
 * A private registry host in a lockfile names the organisation that published
 * through it, and it also means a clean clone cannot install: whoever tries
 * gets an authentication failure against a host they have never heard of.
 */
const PUBLIC_REGISTRIES = [/^https:\/\/registry\.npmjs\.org\//, /^https:\/\/registry\.yarnpkg\.com\//]

function auditLockfile(file) {
  const rel = relative(REPO, file)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const findings = []
  for (const [i, raw] of text.split('\n').entries()) {
    for (const m of raw.matchAll(/"resolved":\s*"([^"]+)"/g)) {
      const url = m[1]
      if (!url.startsWith('http')) continue // a file: or link: target is local
      if (PUBLIC_REGISTRIES.some((re) => re.test(url))) continue
      findings.push({
        file: rel,
        line: i + 1,
        rule: 'private-registry',
        severity: 'error',
        describe: 'package resolved from a host that is not a public registry',
        preview: new URL(url).host,
      })
    }
  }
  return findings
}

const targets = process.argv.slice(2)
const files = targets.length
  ? targets.flatMap((t) => (statSync(t).isDirectory() ? walk(t) : [t]))
  : walk(REPO)

const denylist = localDenylist()
const findings = [
  ...scan(files, denylist),
  ...files.filter((f) => VENDOR_LOCKFILES.has(basename(f))).flatMap(auditLockfile),
]
const errors = findings.filter((f) => f.severity === 'error')
const warns = findings.filter((f) => f.severity === 'warn')

for (const f of [...errors, ...warns]) {
  const level = f.severity === 'error' ? 'ERROR' : 'warn '
  console.log(`${level} ${f.file}:${f.line}  [${f.rule}] ${f.describe}: ${f.preview}`)
}

const denyNote = denylist.length
  ? ` with ${denylist.length} local denylist entries`
  : ' (no local denylist present)'
console.log(`\nscanned ${files.length} files${denyNote}: ${errors.length} error(s), ${warns.length} warning(s)`)

if (errors.length) {
  console.log('\nEvery identifier must be an approved placeholder, for example')
  console.log('jane.doe@example.com or a ${ENV_VAR} reference. Add "identifier-lint: ignore"')
  console.log('to a line only when the match is genuinely a documented vendor constant.')
  process.exit(1)
}
