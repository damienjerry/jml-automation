#!/usr/bin/env node
/**
 * Maintainer tool: make a live n8n export committable.
 *
 * Editing a workflow in the n8n editor is the only comfortable way to change
 * one, but the file that comes back out is not publishable. It carries the ids
 * of credentials and workflows on that one instance, the webhook paths its
 * forms are reachable on, and staticData, which is a snapshot of whatever the
 * workflow last saw. In the automation this toolkit was extracted from, that
 * snapshot held a full list of employees.
 *
 * This tool removes all of it, rewrites the error-workflow reference back to a
 * name, and then REFUSES to write anything if the identifier gate or the
 * bundle validator still object. Refusing before writing matters: a scrub that
 * half worked would otherwise leave a file on disk that looks scrubbed.
 *
 * Usage:
 *   node n8n/scrub-export.mjs export.json                 # print to stdout
 *   node n8n/scrub-export.mjs export.json --out n8n/workflows/jml-doctor.json
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { CANONICAL_CREDENTIAL_NAMES, ERROR_WORKFLOW_NAME, FORBIDDEN_SETTINGS, validateWorkflow } from './validate.mjs'

const TOP_LEVEL_TO_DROP = [
  'id', 'versionId', 'staticData', 'pinData', 'meta', 'tags', 'shared',
  'createdAt', 'updatedAt', 'triggerCount', 'usedCredentials', 'homeProject',
  'sharedWithProjects', 'scopes', 'authors', 'author', 'owner', 'isArchived',
]
const NODE_LEVEL_TO_DROP = ['id', 'webhookId', 'createdAt', 'updatedAt']

export function parseArgs(argv) {
  const opts = { input: null, out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') {
      opts.out = argv[i + 1] ?? null
      i += 1
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`)
    } else if (opts.input === null) {
      opts.input = arg
    } else {
      throw new Error('one input file at a time')
    }
  }
  if (opts.input === null) throw new Error('give the path of an export to scrub')
  return opts
}

/** Remove the channel and resource names n8n caches from a live account. */
function dropLocatorCaches(value, nodeName, removed) {
  if (Array.isArray(value)) return value.map((v) => dropLocatorCaches(v, nodeName, removed))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (k === 'cachedResultName' || k === 'cachedResultUrl') {
      removed.push(`node "${nodeName}" ${k}`)
      continue
    }
    out[k] = dropLocatorCaches(v, nodeName, removed)
  }
  return out
}

/**
 * Returns the scrubbed workflow and the list of what was taken out, so the
 * maintainer reviews the removals rather than trusting them.
 */
export function scrub(doc) {
  const removed = []
  const clean = { ...doc }

  for (const field of TOP_LEVEL_TO_DROP) {
    if (field in clean) {
      removed.push(`top-level ${field}`)
      delete clean[field]
    }
  }

  if (clean.active !== false) {
    removed.push('active (forced to false so an import cannot arm a schedule)')
    clean.active = false
  }

  const hasErrorTrigger = (clean.nodes ?? []).some((n) => n?.type === 'n8n-nodes-base.errorTrigger')
  const settings = { ...(clean.settings ?? {}) }
  settings.executionOrder = 'v1'
  for (const field of FORBIDDEN_SETTINGS) {
    if (field in settings) {
      removed.push(`settings.${field}`)
      delete settings[field]
    }
  }
  if (hasErrorTrigger) {
    if ('errorWorkflow' in settings) {
      removed.push('settings.errorWorkflow (an error workflow must not name itself)')
      delete settings.errorWorkflow
    }
  } else if (settings.errorWorkflow !== ERROR_WORKFLOW_NAME) {
    // A live instance stores this as its own workflow id, which means nothing
    // anywhere else. The bundle ships the name and the import step resolves it.
    removed.push(`settings.errorWorkflow (instance id rewritten to "${ERROR_WORKFLOW_NAME}")`)
    settings.errorWorkflow = ERROR_WORKFLOW_NAME
  }
  clean.settings = settings

  clean.nodes = (clean.nodes ?? []).map((node) => {
    const out = { ...node }
    for (const field of NODE_LEVEL_TO_DROP) {
      if (field in out) {
        removed.push(`node "${node.name}" ${field}`)
        delete out[field]
      }
    }
    if (out.type === 'n8n-nodes-base.formTrigger' && out.parameters?.path) {
      removed.push(`node "${node.name}" form path`)
      out.parameters = { ...out.parameters }
      delete out.parameters.path
    }
    if (out.parameters) out.parameters = dropLocatorCaches(out.parameters, node.name, removed)
    if (out.credentials) {
      const credentials = {}
      for (const [kind, cred] of Object.entries(out.credentials)) {
        if (cred && 'id' in cred) removed.push(`node "${node.name}" credential ${kind} id`)
        // An instance names credentials after its live systems. The bundle
        // ships its own names; a type with several (header auth) keeps a name
        // only when it is already one of them, and takes the first otherwise.
        const allowed = CANONICAL_CREDENTIAL_NAMES[kind]
        const name = allowed ? (allowed.includes(cred?.name) ? cred.name : allowed[0]) : (cred?.name ?? kind)
        if (name !== cred?.name) removed.push(`node "${node.name}" credential ${kind} name (renamed to "${name}")`)
        credentials[kind] = { name }
      }
      out.credentials = credentials
    }
    return out
  })

  return { clean, removed }
}

/**
 * Run the repository identifier gate over a candidate file. The gate is the
 * same one CI runs, invoked from the repository root so the maintainer's local
 * denylist applies as well as the shape rules.
 */
function identifierGate(path) {
  try {
    execFileSync(process.execPath, ['tools/lint/check-identifiers.mjs', path], {
      cwd: process.cwd(),
      stdio: 'pipe',
    })
    return { ok: true, output: '' }
  } catch (err) {
    return { ok: false, output: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

export function main(argv = []) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(err.message)
    return 2
  }

  let doc
  try {
    doc = JSON.parse(readFileSync(opts.input, 'utf8'))
  } catch (err) {
    console.error(`cannot read ${opts.input} as JSON: ${err.message}`)
    return 2
  }

  const { clean, removed } = scrub(doc)
  const serialised = `${JSON.stringify(clean, null, 2)}\n`

  const scratch = mkdtempSync(join(tmpdir(), 'jml-scrub-'))
  const candidate = join(scratch, basename(opts.out ?? opts.input))
  try {
    writeFileSync(candidate, serialised)

    const findings = validateWorkflow(clean, opts.out ?? opts.input)
    const gate = identifierGate(candidate)

    for (const line of removed) console.error(`removed ${line}`)

    if (!gate.ok) {
      console.error('\nthe identifier gate still objects, so nothing was written:\n')
      console.error(gate.output.trim())
      console.error('\nReplace the value by hand with a placeholder such as jane.doe@example.com')
      console.error('or a ${ENV_VAR} reference, then scrub again.')
      return 1
    }
    if (findings.length > 0) {
      console.error('\nthe bundle validator still objects, so nothing was written:\n')
      for (const f of findings) console.error(`  [${f.rule}] ${f.message}`)
      return 1
    }

    if (opts.out) {
      writeFileSync(opts.out, serialised)
      console.error(`\nwrote ${opts.out} (${removed.length} removal(s), gate and validator clean)`)
    } else {
      process.stdout.write(serialised)
    }
    return 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
