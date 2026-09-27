import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  main,
  parseArgs,
  scrub,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/scrub-export.mjs'
import {
  ERROR_WORKFLOW_NAME,
  validateWorkflow,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/validate.mjs'

interface Workflow {
  name: string
  active?: boolean
  settings?: Record<string, unknown>
  nodes: Array<Record<string, unknown>>
  connections: Record<string, unknown>
  [key: string]: unknown
}

const dirtyExport = (): Workflow =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../fixtures/n8n/live-export-dirty.json', import.meta.url)), 'utf8'),
  ) as Workflow

const scratches: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jml-scrub-test-'))
  scratches.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('scrubbing a live export', () => {
  it('removes everything that belongs to the instance it came from', () => {
    const { clean, removed } = scrub(dirtyExport()) as { clean: Workflow; removed: string[] }

    for (const key of ['id', 'versionId', 'staticData', 'pinData', 'meta', 'tags', 'shared', 'triggerCount']) {
      expect(clean[key]).toBeUndefined()
    }
    // staticData is the one that matters most: it is a snapshot of whatever the
    // workflow last handled, and in an earlier design it
    // held a list of real employees.
    expect(removed).toContain('top-level staticData')
    expect(JSON.stringify(clean)).not.toContain('lastLeaver')

    for (const node of clean.nodes) {
      expect(node.id).toBeUndefined()
      expect(node.webhookId).toBeUndefined()
      for (const cred of Object.values((node.credentials ?? {}) as Record<string, Record<string, unknown>>)) {
        expect(Object.keys(cred)).toEqual(['name'])
      }
    }
  })

  it('leaves a file the bundle gate accepts', () => {
    const { clean } = scrub(dirtyExport()) as { clean: Workflow }
    expect(validateWorkflow(clean, 'scrubbed')).toEqual([])
  })

  it('forces the workflow inactive', () => {
    const { clean } = scrub(dirtyExport()) as { clean: Workflow }
    expect(clean.active).toBe(false)
  })

  it('rewrites the error workflow reference from an instance id to the name', () => {
    // n8n stores this as its own workflow id, which resolves to nothing
    // anywhere else, so a shipped export that keeps it alerts nobody.
    const { clean } = scrub(dirtyExport()) as { clean: Workflow }
    expect(clean.settings?.errorWorkflow).toBe(ERROR_WORKFLOW_NAME)
  })

  it('strips the reference entirely from the error workflow itself', () => {
    const doc = dirtyExport()
    doc.nodes = [{ name: 'A toolkit workflow failed', type: 'n8n-nodes-base.errorTrigger', parameters: {} }]
    const { clean } = scrub(doc) as { clean: Workflow }
    expect(clean.settings?.errorWorkflow).toBeUndefined()
  })
})

describe('the scrub tool as a command', () => {
  it('writes the scrubbed file when the gates are clean', () => {
    const dir = scratchDir()
    const input = join(dir, 'export.json')
    const out = join(dir, 'jml-fixture.json')
    writeFileSync(input, JSON.stringify(dirtyExport()))

    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main([input, '--out', out])).toBe(0)
    expect(validateWorkflow(JSON.parse(readFileSync(out, 'utf8')), 'scrubbed')).toEqual([])
  })

  it('writes nothing when the identifier gate still objects', () => {
    const dir = scratchDir()
    const input = join(dir, 'export.json')
    const out = join(dir, 'refused.json')
    const doc = dirtyExport()
    // Assembled at run time rather than written as a literal, because the
    // identifier gate scans the tests too and would fail on this file.
    const leaked = ['a.leaver', 'staff.invalid'].join('@')
    doc.nodes = doc.nodes.map((node) =>
      node.name === 'Post' ? { ...node, notes: `escalate to ${leaked}` } : node,
    )
    writeFileSync(input, JSON.stringify(doc))

    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })

    expect(main([input, '--out', out])).toBe(1)
    // Refusing before writing is the point. A half-scrubbed file on disk looks
    // scrubbed to whoever commits it next.
    expect(existsSync(out)).toBe(false)
    expect(errors.join('\n')).toContain('identifier gate')
  })

  it('refuses a flag it does not know and an invocation with no file', () => {
    expect(() => parseArgs(['--nonsense'])).toThrow('unknown flag')
    expect(() => parseArgs([])).toThrow('give the path')
  })

  it('reports a file it cannot read as JSON rather than writing an empty one', () => {
    const dir = scratchDir()
    const input = join(dir, 'broken.json')
    const out = join(dir, 'out.json')
    writeFileSync(input, '{ not json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(main([input, '--out', out])).toBe(2)
    expect(existsSync(out)).toBe(false)
  })
})
