/**
 * Projects the schema into the four artefacts that ship with the toolkit:
 * `.env.example`, `jml.config.example.yaml`, `schema/jml.config.schema.json`
 * and `docs/config-reference.md`.
 *
 * They are generated rather than maintained because the alternative was tried
 * and it does not hold. Documented environment variable names drifted from the
 * ones the code read, and the example file kept a key that had been renamed, so
 * an operator copied a setting that did nothing. `npm run check:generated`
 * fails the build when any of these is stale, which makes the schema the only
 * place a key can be defined.
 *
 * Run directly: `node --experimental-strip-types src/config/generate.ts [dir]`
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ConfigObject } from './schema.ts'

const HEADER = 'GENERATED FILE. Edit src/config/schema.ts and run `npm run generate`.'

/** One leaf or container in the schema, with its metadata already parsed. */
export interface Field {
  path: string
  env: string | null
  secret: boolean
  doc: string
  /** A short human type, for the reference table. */
  type: string
  required: boolean
  defaultValue: unknown
  hasDefault: boolean
  /** Which store or HRIS variant this field belongs to, when it is in a union. */
  variant: string | null
}

interface Walked {
  fields: Field[]
  jsonSchema: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Reading the schema
// ---------------------------------------------------------------------------

/**
 * Metadata grammar: `ENV_VAR|prose`, with a leading `!` marking a secret.
 * See the header of schema.ts.
 */
export function parseMeta(description: string | undefined): { env: string | null; secret: boolean; doc: string } {
  if (!description) return { env: null, secret: false, doc: '' }
  const bar = description.indexOf('|')
  if (bar < 0) return { env: null, secret: false, doc: description }
  const name = description.slice(0, bar)
  const secret = name.startsWith('!')
  const env = (secret ? name.slice(1) : name) || null
  return { env, secret, doc: description.slice(bar + 1) }
}

type AnyZod = z.ZodTypeAny

/** Peel `.optional()`, `.nullable()` and `.default()` off, keeping what we learn. */
function unwrap(schema: AnyZod): {
  inner: AnyZod
  optional: boolean
  nullable: boolean
  hasDefault: boolean
  defaultValue: unknown
  description: string | undefined
} {
  let inner = schema
  let optional = false
  let nullable = false
  let hasDefault = false
  let defaultValue: unknown
  let description = schema.description

  for (;;) {
    const def = inner._def as { typeName: string; innerType?: AnyZod; defaultValue?: () => unknown }
    if (def.typeName === z.ZodFirstPartyTypeKind.ZodOptional && def.innerType) {
      optional = true
      inner = def.innerType
    } else if (def.typeName === z.ZodFirstPartyTypeKind.ZodNullable && def.innerType) {
      nullable = true
      inner = def.innerType
    } else if (def.typeName === z.ZodFirstPartyTypeKind.ZodDefault && def.innerType) {
      hasDefault = true
      defaultValue = def.defaultValue?.()
      inner = def.innerType
    } else {
      break
    }
    // A description may sit on any level, since `.describe()` can be called
    // before or after `.default()`. The innermost one wins.
    description = inner.description ?? description
  }
  return { inner, optional, nullable, hasDefault, defaultValue, description }
}

function humanType(schema: AnyZod, nullable: boolean): string {
  const def = schema._def as { typeName: string; values?: string[]; value?: unknown; type?: AnyZod; options?: AnyZod[] }
  const base = (() => {
    switch (def.typeName) {
      case z.ZodFirstPartyTypeKind.ZodString:
        return 'string'
      case z.ZodFirstPartyTypeKind.ZodNumber:
        return 'integer'
      case z.ZodFirstPartyTypeKind.ZodBoolean:
        return 'boolean'
      case z.ZodFirstPartyTypeKind.ZodLiteral:
        return 'literal ' + JSON.stringify(def.value)
      case z.ZodFirstPartyTypeKind.ZodEnum:
        return (def.values ?? []).join(' | ')
      case z.ZodFirstPartyTypeKind.ZodArray:
        return def.type ? humanType(unwrap(def.type).inner, false) + '[]' : 'list'
      case z.ZodFirstPartyTypeKind.ZodRecord:
        return 'map'
      case z.ZodFirstPartyTypeKind.ZodUnion:
        return (def.options ?? []).map((o) => humanType(unwrap(o).inner, false)).join(' | ')
      case z.ZodFirstPartyTypeKind.ZodObject:
        return 'object'
      default:
        return 'value'
    }
  })()
  return nullable ? base + ' | null' : base
}

/**
 * `pushSelf` is false for the branches of a union. A union's options all sit at
 * the same path as the union itself, so recording each of them as a field
 * produced one duplicate key per branch in the example YAML, and a YAML
 * document with a repeated key is not valid configuration.
 */
function walk(
  schema: AnyZod,
  path: string,
  variant: string | null,
  out: Field[],
  pushSelf = true,
): Record<string, unknown> {
  const { inner, optional, nullable, hasDefault, defaultValue, description } = unwrap(schema)
  const metaOf = parseMeta(description)
  const def = inner._def as {
    typeName: string
    shape?: () => Record<string, AnyZod>
    type?: AnyZod
    options?: AnyZod[] | Map<string, AnyZod>
    discriminator?: string
    values?: string[]
    value?: unknown
    valueType?: AnyZod
    checks?: { kind: string }[]
  }

  const record = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const node: Record<string, unknown> = { ...extra }
    if (metaOf.doc) node.description = metaOf.doc
    if (hasDefault) node.default = defaultValue
    return node
  }

  if (path !== '' && pushSelf) {
    out.push({
      path,
      env: metaOf.env,
      secret: metaOf.secret,
      doc: metaOf.doc,
      // A discriminated union is a container in every artefact: the branches
      // carry the detail, tagged with which adapter they belong to.
      type: def.typeName === z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion ? 'object' : humanType(inner, nullable),
      required: !optional && !hasDefault,
      defaultValue,
      hasDefault,
      variant,
    })
  }

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = def.shape?.() ?? {}
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [name, child] of Object.entries(shape)) {
        properties[name] = walk(child, path ? path + '.' + name : name, variant, out)
        const info = unwrap(child)
        if (!info.optional && !info.hasDefault) required.push(name)
      }
      return record({ type: 'object', properties, required, additionalProperties: false })
    }
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = def.options instanceof Map ? [...def.options.values()] : (def.options ?? [])
      const oneOf = options.map((option) => {
        const shape = (option._def as { shape?: () => Record<string, AnyZod> }).shape?.() ?? {}
        const tagSchema = shape[def.discriminator ?? 'adapter'] ?? z.string()
        const tag = (unwrap(tagSchema).inner._def as { value?: unknown }).value
        return walk(option, path, String(tag), out, false)
      })
      return record({ oneOf })
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const items = def.type ? walk(def.type, path + '[]', variant, out) : {}
      return record({ type: nullable ? ['array', 'null'] : 'array', items })
    }
    case z.ZodFirstPartyTypeKind.ZodRecord:
      return record({ type: 'object', additionalProperties: { type: 'string' } })
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return record({ type: nullable ? ['string', 'null'] : 'string', enum: def.values ?? [] })
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return record({ const: def.value })
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return record({ type: nullable ? ['integer', 'null'] : 'integer' })
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return record({ type: nullable ? ['boolean', 'null'] : 'boolean' })
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = (def.options as AnyZod[] | undefined) ?? []
      return record({ anyOf: options.map((o) => walk(o, path, variant, out, false)) })
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const node: Record<string, unknown> = { type: nullable ? ['string', 'null'] : 'string' }
      for (const check of def.checks ?? []) {
        if (check.kind === 'email') node.format = 'email'
        if (check.kind === 'url') node.format = 'uri'
        if (check.kind === 'regex') node.pattern = String((check as { regex?: RegExp }).regex?.source ?? '')
      }
      return record(node)
    }
    default:
      return record({})
  }
}

export function walkSchema(): Walked {
  const fields: Field[] = []
  const jsonSchema = walk(ConfigObject, '', null, fields)
  return {
    fields,
    jsonSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://github.com/jml-toolkit/schema/jml.config.schema.json',
      title: 'jml-toolkit configuration',
      description: HEADER,
      ...jsonSchema,
    },
  }
}

// ---------------------------------------------------------------------------
// The artefacts
// ---------------------------------------------------------------------------

function envExample(fields: Field[]): string {
  const lines = [
    '# ' + HEADER,
    '#',
    '# Names only. This file never carries a value, so it is safe to commit and',
    '# safe to read in a pull request. Copy it to .env and fill it in there.',
    '#',
    '# A name marked SECRET is referenced from jml.config.yaml as env:NAME.',
    '',
  ]
  const seen = new Set<string>()
  for (const field of fields) {
    if (!field.env || seen.has(field.env)) continue
    seen.add(field.env)
    lines.push('# ' + field.path + (field.variant ? ' (' + field.variant + ')' : '') + ': ' + field.doc)
    if (field.secret) lines.push('# SECRET: the value belongs in your secret manager, not in a repository.')
    if (field.hasDefault) lines.push('# default: ' + JSON.stringify(field.defaultValue))
    lines.push(field.env + '=')
    lines.push('')
  }
  return lines.join('\n')
}

/** Renders a YAML scalar without pulling in a serialiser for four shapes. */
function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return '[' + value.map((v) => yamlScalar(v)).join(', ') + ']'
  if (typeof value === 'object') return '{}'
  const text = String(value)
  return /^[A-Za-z0-9._/-]+$/.test(text) ? text : JSON.stringify(text)
}

/** A placeholder for a field with no default, chosen so the file stays lintable. */
function placeholderFor(field: Field): string {
  if (field.secret) return 'env:' + (field.env ?? 'CHANGE_ME')
  // A literal has exactly one legal value, so there is nothing to choose.
  if (field.type.startsWith('literal ')) return yamlScalar(JSON.parse(field.type.slice('literal '.length)))
  if (field.type.includes('email')) return 'jane.doe@example.com'
  switch (field.path) {
    case 'org.name':
      return '"Example Organisation"'
    case 'org.primaryDomain':
      return 'example.com'
    case 'org.timezone':
      return 'Europe/London'
    case 'org.itTeamSignature':
      return '"IT Team"'
    case 'mail.senderMailbox':
      return 'it-noreply@example.com'
    case 'google.adminEmail':
      return 'admin@example.com'
    case 'hris.adapter':
      return 'fixture'
    case 'hris.minPlausibleHeadcount':
      return '25'
    case 'hris.fixture.path':
      return './src/cli/fixtures/demo.json'
    case 'store.adapter':
      return 'sqlite'
    default:
      return field.type === 'integer' ? '0' : '""'
  }
}

function exampleYaml(fields: Field[]): string {
  const lines = [
    '# ' + HEADER,
    '#',
    '# Copy to jml.config.yaml and edit. Both files are gitignored.',
    '# Every string may use ${ENV_VAR}; every secret MUST be a reference',
    '# (env:NAME, file:/path or op://<vault>/<item>/<field>), never a value.',
    '',
  ]
  // Only the default store variant is written out; the others are listed as
  // comments, because a YAML document cannot hold two variants of one key.
  const shown = fields.filter((f) => !f.path.includes('[]') && (f.variant === null || f.variant === 'sqlite'))
  let lastTop = ''
  for (const field of shown) {
    const segments = field.path.split('.')
    const indent = '  '.repeat(segments.length - 1)
    const leaf = segments[segments.length - 1] as string
    if (segments.length === 1 && lastTop !== leaf) {
      lines.push('')
      lastTop = leaf
    }
    if (field.doc) lines.push(indent + '# ' + field.doc)
    if (field.type === 'object' || field.type === 'map') {
      lines.push(indent + leaf + ':')
      continue
    }
    const value = field.hasDefault ? yamlScalar(field.defaultValue) : placeholderFor(field)
    lines.push(indent + leaf + ': ' + value)
  }
  lines.push('')
  lines.push('# Other store adapters, one at a time, replacing the store block above:')
  for (const field of fields.filter((f) => f.variant && f.variant !== 'sqlite')) {
    lines.push('#   ' + field.path + ': ' + (field.hasDefault ? yamlScalar(field.defaultValue) : placeholderFor(field)))
  }
  lines.push('')
  return lines.join('\n')
}

function configReference(fields: Field[]): string {
  const lines = [
    '<!-- ' + HEADER + ' -->',
    '',
    '# Configuration reference',
    '',
    'Every key `jml.config.yaml` accepts. An unknown key is a start-up failure,',
    'so a typo in a safety flag cannot silently disable it.',
    '',
    '## Environment references',
    '',
    'Any string may contain `${NAME}`, which is replaced with that environment',
    'variable at load time. An unset name is a start-up failure rather than an',
    'empty string, because a blank domain or a blank mailbox matches nothing and',
    'fails quietly instead of loudly.',
    '',
    '## Secret references',
    '',
    'A field marked **secret** below holds a reference, never a value:',
    '',
    '| Form | Meaning |',
    '| --- | --- |',
    '| `env:NAME` | the value of that environment variable |',
    '| `file:/path` | the trimmed contents of that file |',
    '| `op://<vault>/<item>/<field>` | read through the 1Password CLI |',
    '',
    'Reference a secret-manager item by its UUID, not its title. A title',
    'reference works until somebody renames the item, and then it fails at the',
    'next scheduled run with nobody watching.',
    '',
    'Every reference resolves once, at start-up. A credential that cannot be',
    'resolved stops the process; it never becomes a step that quietly does',
    'nothing while the run reports success. Resolved values register with the',
    'redactor, so they are masked in logs, error messages, the run report and',
    'the audit log. `jml config show` prints references and lengths only.',
    '',
    '## Reserved legs',
    '',
    'This release ships the Azure and Slack SCIM legs as interfaces only. If',
    '`AZURE_CLIENT_SECRET` or `SLACK_SCIM_TOKEN` is set, start-up refuses: a',
    'credential present for a step that cannot run reads as coverage that does',
    'not exist.',
    '',
    '## Keys',
    '',
    '| Key | Env | Type | Default | Secret | Notes |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const field of fields) {
    if (field.type === 'object') continue
    // An array's item schema carries no documentation of its own, so a row for
    // it would say nothing the array's own row has not already said.
    if (field.path.includes('[]') && field.doc === '') continue
    const rendered = field.hasDefault ? '`' + yamlScalar(field.defaultValue) + '`' : field.required ? '**required**' : 'unset'
    const def = rendered.replace(/\|/g, '\\|')
    lines.push(
      '| `' +
        field.path +
        '`' +
        (field.variant ? ' (' + field.variant + ')' : '') +
        ' | ' +
        (field.env ? '`' + field.env + '`' : '-') +
        ' | ' +
        // A pipe inside a cell ends the cell, and an enum type is full of them.
        field.type.replace(/\|/g, '\\|') +
        ' | ' +
        def +
        ' | ' +
        (field.secret ? 'yes' : '-') +
        ' | ' +
        field.doc.replace(/\|/g, '\\|') +
        ' |',
    )
  }
  lines.push('')
  return lines.join('\n')
}

export function generateArtefacts(): { path: string; content: string }[] {
  const { fields, jsonSchema } = walkSchema()
  return [
    { path: '.env.example', content: envExample(fields) },
    { path: 'jml.config.example.yaml', content: exampleYaml(fields) },
    { path: 'schema/jml.config.schema.json', content: JSON.stringify(jsonSchema, null, 2) + '\n' },
    { path: 'docs/config-reference.md', content: configReference(fields) },
  ]
}

export async function writeArtefacts(root: string): Promise<string[]> {
  const written: string[] = []
  for (const artefact of generateArtefacts()) {
    const full = join(root, artefact.path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, artefact.content, 'utf8')
    written.push(artefact.path)
  }
  return written
}

// Only when run as a script. A test importing this module must not write files.
const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry && fileURLToPath(import.meta.url) === entry) {
  const root = process.argv[2] ?? process.cwd()
  const written = await writeArtefacts(root)
  process.stdout.write('generated ' + written.length + ' artefacts:\n' + written.map((w) => '  ' + w).join('\n') + '\n')
}
