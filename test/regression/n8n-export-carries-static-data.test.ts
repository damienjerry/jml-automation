/**
 * Failure this prevents: a workflow export that shipped a snapshot of real
 * people.
 *
 * An automation platform stores a workflow's own scratch state in the file it
 * exports. In an earlier design, that state accumulated the
 * last set of records the workflow had handled, so an export taken to share the
 * design carried a full staff list, several leaver addresses and a list of
 * device names. Nobody put them there on purpose and nothing in the file looked
 * unusual.
 *
 * The rule: the shipped bundle is hand-authored, and the gate refuses any file
 * carrying instance state. Making a live export committable is a separate,
 * explicit step that strips the state and then re-checks it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  bundleFiles,
  validateFiles,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/validate.mjs'
import {
  scrub,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/scrub-export.mjs'

interface Finding {
  rule: string
  message: string
}

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/n8n/${name}`, import.meta.url))

describe('an export carrying instance state', () => {
  it('is refused by the bundle gate', () => {
    const { findings } = validateFiles([fixture('bad-static-data.json')]) as { findings: Finding[] }
    expect(findings.map((f) => f.rule)).toContain('instance-metadata')
  })

  it('loses the state, not just the label, when it is scrubbed', () => {
    const dirty = JSON.parse(readFileSync(fixture('live-export-dirty.json'), 'utf8')) as Record<string, unknown>
    expect(JSON.stringify(dirty)).toContain('lastLeaver')

    const { clean } = scrub(dirty) as { clean: Record<string, unknown> }
    expect(JSON.stringify(clean)).not.toContain('lastLeaver')
  })

  it('is not what the toolkit ships', () => {
    for (const path of bundleFiles() as string[]) {
      const raw = readFileSync(path, 'utf8')
      for (const key of ['staticData', 'pinData', 'versionId', 'instanceId']) {
        expect(raw).not.toContain(key)
      }
    }
  })
})
