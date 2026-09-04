import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { generateArtefacts, parseMeta, walkSchema } from '../../src/config/generate.ts'
import { SECRET_PATHS } from '../../src/config/load.ts'

describe('field metadata grammar', () => {
  it('splits an env name, a secret marker and the prose', () => {
    expect(parseMeta('ORG_NAME|Organisation name.')).toEqual({ env: 'ORG_NAME', secret: false, doc: 'Organisation name.' })
    expect(parseMeta('!JUMPCLOUD_API_KEY|Key.')).toEqual({ env: 'JUMPCLOUD_API_KEY', secret: true, doc: 'Key.' })
    expect(parseMeta('|No environment override.').env).toBeNull()
    expect(parseMeta(undefined)).toEqual({ env: null, secret: false, doc: '' })
  })
})

describe('the schema is the single source of truth', () => {
  it('documents every key it defines', () => {
    const undocumented = walkSchema()
      .fields.filter((f) => f.type !== 'object' && !f.path.includes('[]') && f.doc === '')
      .map((f) => f.path)
    expect(undocumented).toEqual([])
  })

  it('marks exactly the secret fields the loader resolves', () => {
    // A new secret field in the schema that nobody added to SECRET_PATHS would
    // never be resolved, so it would silently be left as an unresolvable
    // reference string and handed to a provider as if it were a credential.
    const marked = [...new Set(walkSchema().fields.filter((f) => f.secret).map((f) => f.path))].sort()
    expect(marked).toEqual([...SECRET_PATHS].sort())
  })

  it('gives every environment name to exactly one key', () => {
    const seen = new Map<string, string[]>()
    for (const field of walkSchema().fields) {
      if (!field.env) continue
      seen.set(field.env, [...(seen.get(field.env) ?? []), field.path])
    }
    const shared = [...seen.entries()].filter(([, paths]) => new Set(paths).size > 1)
    expect(shared).toEqual([])
  })

  it('leaves the headcount floor with no default', () => {
    // A default here would be somebody else's headcount, and the guard would
    // pass for the wrong reason on a truncated read.
    const field = walkSchema().fields.find((f) => f.path === 'hris.minPlausibleHeadcount')
    expect(field?.hasDefault).toBe(false)
    expect(field?.required).toBe(true)
  })
})

describe('generated artefacts', () => {
  it('produces all four', () => {
    expect(generateArtefacts().map((a) => a.path)).toEqual([
      '.env.example',
      'jml.config.example.yaml',
      'schema/jml.config.schema.json',
      'docs/config-reference.md',
    ])
  })

  it('never writes a credential into the example environment file', () => {
    const envExample = generateArtefacts().find((a) => a.path === '.env.example')?.content ?? ''
    const assignments = envExample.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    expect(assignments.length).toBeGreaterThan(20)
    expect(assignments.every((l) => l.endsWith('='))).toBe(true)
  })

  it('refuses unknown keys in the JSON Schema it publishes', () => {
    const schema = JSON.parse(generateArtefacts().find((a) => a.path.endsWith('.json'))?.content ?? '{}')
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.org.additionalProperties).toBe(false)
  })

  it('matches what is committed, so the committed copies cannot go stale', async () => {
    for (const artefact of generateArtefacts()) {
      const committed = await readFile(artefact.path, 'utf8')
      expect(committed, artefact.path + ' is stale: run npm run generate').toBe(artefact.content)
    }
  })
})
