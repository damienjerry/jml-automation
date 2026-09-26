/**
 * Failure this prevents: a shipped workflow posting an adopter's data to
 * somebody else's host.
 *
 * The workflows this bundle replaces were full of literal addresses: an
 * internal service on a private network, a chat channel id, a tunnel hostname
 * on a domain the organisation did not control. Each was harmless where it was written
 * and each is a live endpoint owned by a stranger once the file is shared. The
 * chat ids were the worst of it, because a wrong-but-valid channel id succeeds:
 * the post lands, just not where the sender expected.
 *
 * The rule: every request builds its URL from `$env.JML_API_URL`, the chat
 * channel comes from the environment too, and the gate allows no other
 * environment name so a new hardcoded value cannot arrive wearing a variable's
 * clothes.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ALLOWED_ENV_VARS,
  bundleFiles,
  validateFiles,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/validate.mjs'

interface Finding {
  rule: string
  message: string
}

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/n8n/${name}`, import.meta.url))

describe('a literal endpoint in a shipped export', () => {
  it('is refused', () => {
    const { findings } = validateFiles([fixture('bad-hardcoded-url.json')]) as { findings: Finding[] }
    expect(findings.map((f) => f.rule)).toEqual(['api-url-from-env', 'api-url-from-env'])
  })

  it('is refused even when it hides behind an unknown environment name', () => {
    const { findings } = validateFiles([fixture('bad-env-not-allowlisted.json')]) as { findings: Finding[] }
    expect(findings.map((f) => f.rule)).toEqual(['env-allowlist'])
    expect([...(ALLOWED_ENV_VARS as Set<string>)]).toHaveLength(3)
  })

  it('is not what the toolkit ships', () => {
    for (const path of bundleFiles() as string[]) {
      const raw = readFileSync(path, 'utf8')
      // Every request URL, and the chat channel, come from the environment.
      expect(raw).not.toMatch(/"url":\s*"[^"]*https?:\/\//)
      if (raw.includes('n8n-nodes-base.httpRequest')) expect(raw).toContain('$env.JML_API_URL')
      expect(raw).not.toMatch(/"value":\s*"C0/)
    }
  })
})
