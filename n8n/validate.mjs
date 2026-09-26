#!/usr/bin/env node
/**
 * Gate for the shipped n8n workflow bundle.
 *
 * The files in n8n/workflows are hand-authored, not exported from a
 * running instance, and every rule below exists because an export that looked
 * fine caused a failure somebody had to diagnose in production:
 *
 *  - a credential id or an instance id in a shipped file points a new adopter
 *    at an object that does not exist on their instance, and staticData in
 *    particular once carried a snapshot of real people into an export;
 *  - a hardcoded URL means an adopter posts their own leaver data to whoever
 *    owns the host that was left in the file;
 *  - a chat post that nobody asserts on is silently discarded, because the
 *    chat API answers 200 with the failure in the body;
 *  - an assertion placed before a sibling branch stops that branch from
 *    running at all, because a throw ends the whole execution;
 *  - a workflow with no error workflow fails to nobody;
 *  - an HTTP timeout shorter than a device receipt turns a slow success into a
 *    reported failure, and the device is then acted on twice.
 *
 * Usage:
 *   node n8n/validate.mjs                       # the shipped bundle
 *   node n8n/validate.mjs path/to/export.json   # any file, for a fixture
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const REPO = process.cwd()
export const BUNDLE_DIR = 'n8n/workflows'
export const ERROR_WORKFLOW_NAME = 'jml-on-error'
export const DEVICE_ROUTE_TIMEOUT_MS = 600_000

/**
 * Every node type the bundle is allowed to use. `code` is deliberately absent:
 * logic lives in the sidecar where it can be typechecked, unit-tested and
 * secret-scanned. A Code node also cannot load a native module, loses the body
 * of a non-2xx response, and caps out well below the time a device receipt
 * takes.
 */
export const ALLOWED_NODE_TYPES = new Set([
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.set',
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.if',
  'n8n-nodes-base.slack',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.stopAndError',
])

/** The only environment variables a shipped workflow may read. */
export const ALLOWED_ENV_VARS = new Set(['JML_API_URL', 'JML_DRY_RUN', 'SLACK_JML_CHANNEL_ID'])

/** Keys n8n writes into an export that describe the instance, not the workflow. */
const FORBIDDEN_TOP_LEVEL = [
  'id', 'versionId', 'staticData', 'pinData', 'meta', 'tags', 'shared',
  'createdAt', 'updatedAt', 'triggerCount', 'usedCredentials', 'homeProject',
  'sharedWithProjects', 'scopes', 'authors', 'author', 'owner',
]
const FORBIDDEN_NODE_LEVEL = ['id', 'webhookId', 'createdAt', 'updatedAt']

/**
 * Settings n8n writes that describe the instance rather than the workflow: its
 * timezone, who may call it, and its own bookkeeping. Each fingerprints the
 * estate an export came from.
 */
export const FORBIDDEN_SETTINGS = ['timezone', 'callerIds', 'callerPolicy', 'timeSavedPerExecution', 'saveManualExecutions']

/**
 * The credential names the bundle ships, by credential type. An export carries
 * whatever the instance called them, which is usually the name of a live
 * system; the bundle ships these instead and n8n binds them by name on import.
 */
export const CANONICAL_CREDENTIAL_NAMES = {
  httpHeaderAuth: ['JML Toolkit API', 'JML Inbound Webhook'],
  httpBasicAuth: ['JML Form Access'],
  slackApi: ['JML Slack Alerts'],
}

/** A resource-locator value that still carries the cache n8n fills in from a live account. */
export function findLocatorCaches(value, path = 'parameters', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findLocatorCaches(v, path + '[' + i + ']', out))
  else if (value && typeof value === 'object') {
    for (const key of ['cachedResultName', 'cachedResultUrl']) if (key in value) out.push(path + '.' + key)
    for (const [k, v] of Object.entries(value)) findLocatorCaches(v, path + '.' + k, out)
  }
  return out
}

const IS = {
  http: (n) => n.type === 'n8n-nodes-base.httpRequest',
  slack: (n) => n.type === 'n8n-nodes-base.slack',
  if: (n) => n.type === 'n8n-nodes-base.if',
  wait: (n) => n.type === 'n8n-nodes-base.wait',
  form: (n) => n.type === 'n8n-nodes-base.formTrigger',
  webhook: (n) => n.type === 'n8n-nodes-base.webhook',
  errorTrigger: (n) => n.type === 'n8n-nodes-base.errorTrigger',
  terminal: (n) => n.type === 'n8n-nodes-base.noOp' || n.type === 'n8n-nodes-base.stopAndError',
  stop: (n) => n.type === 'n8n-nodes-base.stopAndError',
}

const text = (value) => JSON.stringify(value ?? null)

/** Flat outgoing edges, carrying the output index so a fan-out is visible. */
function edges(doc, nodeName) {
  const groups = doc.connections?.[nodeName]?.main ?? []
  const out = []
  groups.forEach((group, outputIndex) => {
    for (const conn of group ?? []) out.push({ target: conn.node, outputIndex })
  })
  return out
}

/** Every node reachable from a starting node, excluding the start itself. */
function downstream(doc, nodeName) {
  const seen = new Set()
  const queue = edges(doc, nodeName).map((e) => e.target)
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    for (const e of edges(doc, name)) queue.push(e.target)
  }
  seen.delete(nodeName)
  return seen
}

/**
 * An ok assertion is an If node that reads an `ok` field and requires it to be
 * literally true. Anything looser passes an undefined field, which is how a
 * rejected post reads as a delivered one.
 */
function isOkAssertion(node) {
  if (!IS.if(node)) return false
  const body = text(node.parameters)
  return /\.ok\b/.test(body) && /"operation":\s*"true"/.test(body)
}

function collectEnvVars(doc) {
  const found = new Set()
  const body = text(doc)
  for (const m of body.matchAll(/\$env\.([A-Za-z0-9_]+)/g)) found.add(m[1])
  for (const m of body.matchAll(/\$env\[['"]([A-Za-z0-9_]+)['"]\]/g)) found.add(m[1])
  return found
}

function timeoutOf(node) {
  const t = node.parameters?.options?.timeout
  return typeof t === 'number' ? t : null
}

/**
 * Validate one parsed workflow. Returns a finding per violation; an empty
 * array means the file may ship.
 */
export function validateWorkflow(doc, label = 'workflow') {
  const findings = []
  const add = (rule, message) => findings.push({ file: label, rule, message })

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    add('shape', 'not a workflow object')
    return findings
  }
  if (!Array.isArray(doc.nodes)) {
    add('shape', 'no nodes array')
    return findings
  }
  if (doc.connections === undefined || typeof doc.connections !== 'object') {
    add('shape', 'no connections object')
    return findings
  }
  if (typeof doc.name !== 'string' || doc.name.length === 0) add('shape', 'no workflow name')

  // Instance metadata. Everything here is either meaningless on another
  // instance or, in the case of staticData, a copy of real data.
  for (const field of FORBIDDEN_TOP_LEVEL) {
    if (field in doc) add('instance-metadata', `top-level "${field}" belongs to the instance it was exported from`)
  }
  if (doc.active !== false) {
    add('shipped-inactive', 'active must be false so importing the bundle cannot arm a schedule before it has been read')
  }
  for (const field of FORBIDDEN_SETTINGS) {
    if (doc.settings && field in doc.settings) add('instance-settings', `settings.${field} describes the instance the export came from; remove it`)
  }
  if (doc.settings?.executionOrder !== 'v1') {
    add('execution-order', 'settings.executionOrder must be "v1"; branch order differs under v0')
  }

  const byName = new Map()
  for (const node of doc.nodes) {
    const where = `node "${node?.name ?? '(unnamed)'}"`
    if (typeof node?.name !== 'string' || node.name.length === 0) {
      add('shape', 'a node has no name, and connections are keyed by name')
      continue
    }
    if (byName.has(node.name)) add('shape', `${where} is defined twice`)
    byName.set(node.name, node)

    for (const field of FORBIDDEN_NODE_LEVEL) {
      if (field in node) add('instance-metadata', `${where} carries "${field}", which n8n regenerates on import`)
    }
    if (node.type === 'n8n-nodes-base.code') {
      add('no-code-node', `${where} is a Code node: decisions belong in the sidecar, where they are typechecked and tested`)
    } else if (!ALLOWED_NODE_TYPES.has(node.type)) {
      add('node-type-allowlist', `${where} has type ${node.type}, which the bundle does not use`)
    }

    for (const [kind, cred] of Object.entries(node.credentials ?? {})) {
      const extra = Object.keys(cred ?? {}).filter((k) => k !== 'name')
      if (extra.length > 0) {
        add('credential-by-name', `${where} references credential ${kind} by ${extra.join(', ')}; ship the name only`)
      }
      if (typeof cred?.name !== 'string' || cred.name.length === 0) {
        add('credential-by-name', `${where} references credential ${kind} with no name`)
      }
    }

    if ((IS.form(node) || IS.webhook(node)) && (node.parameters?.authentication ?? 'none') === 'none') {
      add('form-authenticated', `${where} is an open ${IS.form(node) ? 'form' : 'webhook'}; anyone who can reach n8n could run it`)
    }
    if (IS.webhook(node) && (node.parameters?.authentication ?? 'none') !== 'none' && Object.keys(node.credentials ?? {}).length === 0) {
      add('form-authenticated', `${where} asks for authentication but names no credential, so it imports unbound`)
    }
    if (IS.form(node) && node.parameters?.path) {
      add('no-form-path', `${where} ships a fixed form path; n8n assigns one on activation, and a public path is a URL everybody knows`)
    }
    for (const [kind, cred] of Object.entries(node.credentials ?? {})) {
      const allowed = CANONICAL_CREDENTIAL_NAMES[kind]
      if (!allowed) add('credential-name', `${where} uses credential type ${kind}, which the bundle does not ship`)
      else if (!allowed.includes(cred?.name)) add('credential-name', `${where} names credential ${kind} "${cred?.name}"; ship one of ${allowed.join(', ')}`)
    }
    for (const hit of findLocatorCaches(node.parameters)) {
      add('no-locator-cache', `${where} carries ${hit}, a channel or resource name cached from a live account`)
    }

    if (IS.http(node)) {
      const url = String(node.parameters?.url ?? '')
      if (!url.includes('$env.JML_API_URL')) {
        add('api-url-from-env', `${where} does not build its URL from $env.JML_API_URL`)
      }
      if (/https?:\/\//.test(url)) {
        add('api-url-from-env', `${where} contains a literal host, which points every adopter at one instance`)
      }
      if (node.parameters?.sendBody === true) {
        if (node.parameters?.specifyBody !== 'keypair') {
          add('body-as-fields', `${where} does not send its body as fields; a raw JSON body ships expressions unevaluated`)
        }
        if (/\{\{/.test(text(node.parameters?.jsonBody))) {
          add('body-as-fields', `${where} has an expression inside a raw JSON body, which n8n sends as literal characters`)
        }
      }
    }
  }

  for (const from of Object.keys(doc.connections)) {
    if (!byName.has(from)) add('shape', `connections name "${from}", which is not a node`)
    for (const e of edges(doc, from)) {
      if (!byName.has(e.target)) add('shape', `"${from}" connects to "${e.target}", which is not a node`)
    }
  }

  const nodes = [...byName.values()]
  const hasErrorTrigger = nodes.some(IS.errorTrigger)
  const errorWorkflow = doc.settings?.errorWorkflow
  if (hasErrorTrigger) {
    // The error workflow must not name itself. A failure inside it would then
    // trigger itself, and the alert path would spend its time alerting on
    // being unable to alert.
    if (errorWorkflow !== undefined) {
      add('error-workflow', 'the error workflow must not name an error workflow of its own')
    }
  } else if (errorWorkflow !== ERROR_WORKFLOW_NAME) {
    add('error-workflow', `settings.errorWorkflow must be "${ERROR_WORKFLOW_NAME}"; without it a red execution alerts nobody`)
  }

  for (const name of collectEnvVars(doc)) {
    if (!ALLOWED_ENV_VARS.has(name)) {
      add('env-allowlist', `reads $env.${name}, which is not one of ${[...ALLOWED_ENV_VARS].join(', ')}`)
    }
  }

  findings.push(...checkSlackAssertions(doc, nodes, label))
  findings.push(...checkSlackBranchLast(doc, byName, label))
  findings.push(...checkDeviceTimeouts(nodes, label))
  findings.push(...checkPollLoop(doc, nodes, label))
  return findings
}

/**
 * A chat post must be judged, and nothing may run after the judgement except
 * terminals and further ok assertions. Both halves matter: without the
 * assertion a rejected post is invisible, and with work still queued behind it
 * the throw takes that work down with it.
 */
function checkSlackAssertions(doc, nodes, label) {
  const findings = []
  const add = (rule, message) => findings.push({ file: label, rule, message })
  for (const node of nodes.filter(IS.slack)) {
    const successors = edges(doc, node.name).map((e) => doc.nodes.find((n) => n.name === e.target))
    if (successors.length !== 1 || !successors[0] || !isOkAssertion(successors[0])) {
      add('slack-post-asserted', `node "${node.name}" is not followed by a single ok assertion; a 200 with ok:false would pass`)
      continue
    }
    const assertion = successors[0]
    const falseBranch = edges(doc, assertion.name).filter((e) => e.outputIndex === 1)
    const reachesStop = falseBranch.some((e) => {
      const target = doc.nodes.find((n) => n.name === e.target)
      return target !== undefined && (IS.stop(target) || [...downstream(doc, e.target)].some((d) => IS.stop(doc.nodes.find((n) => n.name === d) ?? {})))
    })
    if (!reachesStop) {
      add('slack-post-asserted', `the assertion after "${node.name}" does not stop the execution when delivery failed`)
    }
    for (const name of downstream(doc, assertion.name)) {
      const later = doc.nodes.find((n) => n.name === name)
      if (!later) continue
      if (IS.terminal(later) || isOkAssertion(later)) continue
      add('assertion-last', `node "${name}" runs after the delivery assertion; a throw there would skip it`)
    }
  }
  return findings
}

/**
 * Where one output feeds several branches, v1 runs them top to bottom, so the
 * branch that can throw has to be the last one. Keeping the chat branch lowest
 * is what stops an assertion killing the audit and notification branches that
 * should still have run.
 */
function checkSlackBranchLast(doc, byName, label) {
  const findings = []
  for (const [from, conn] of Object.entries(doc.connections)) {
    const groups = conn?.main ?? []
    groups.forEach((group, outputIndex) => {
      const targets = (group ?? []).map((c) => c.node)
      if (targets.length < 2) return
      const withSlack = []
      const without = []
      for (const t of targets) {
        const node = byName.get(t)
        if (!node) continue
        const subtree = [t, ...downstream(doc, t)]
        const carriesSlack = subtree.some((n) => IS.slack(byName.get(n) ?? {}))
        ;(carriesSlack ? withSlack : without).push(node)
      }
      const y = (n) => n.position?.[1] ?? 0
      for (const slackHead of withSlack) {
        for (const other of without) {
          if (y(slackHead) < y(other)) {
            findings.push({
              file: label,
              rule: 'slack-branch-last',
              message: `at "${from}" output ${outputIndex}, the branch through "${slackHead.name}" posts to chat but runs before "${other.name}"`,
            })
          }
        }
      }
    })
  }
  return findings
}

/**
 * A device receipt can take ten minutes, and the agent-quiet confirmation adds
 * more. Any workflow touching a device route carries the long timeout on every
 * request in it, so a later edit cannot leave one short.
 */
function checkDeviceTimeouts(nodes, label) {
  const https = nodes.filter(IS.http)
  const touchesDevices = https.some((n) => String(n.parameters?.url ?? '').includes('/v1/devices/'))
  if (!touchesDevices) return []
  return https
    .filter((n) => (timeoutOf(n) ?? 0) < DEVICE_ROUTE_TIMEOUT_MS)
    .map((n) => ({
      file: label,
      rule: 'device-route-timeout',
      message: `node "${n.name}" has a timeout of ${timeoutOf(n) ?? 'none'}ms on a device workflow; ${DEVICE_ROUTE_TIMEOUT_MS}ms is the floor`,
    }))
}

/**
 * A workflow that starts a run must poll for the result. Blocking on the
 * request instead means the run is bounded by an n8n task timeout, which no
 * device path fits inside.
 */
function checkPollLoop(doc, nodes, label) {
  const startsRun = nodes.some(
    (n) => IS.http(n) && n.parameters?.method === 'POST' && /\/v1\/(runs|leavers|devices)/.test(String(n.parameters?.url ?? '')),
  )
  if (!startsRun) return []
  const waits = nodes.filter(IS.wait)
  const loops = waits.some((w) => [...downstream(doc, w.name)].some((n) => edges(doc, n).some((e) => e.target === w.name)))
  if (waits.length > 0 && loops) return []
  return [
    {
      file: label,
      rule: 'run-route-polls',
      message: 'starts a run but has no wait node the graph returns to, so it blocks on one request instead of polling',
    },
  ]
}

/** Read and validate a list of files. */
export function validateFiles(paths) {
  const findings = []
  for (const path of paths) {
    const label = relative(REPO, path) || basename(path)
    let doc
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      findings.push({ file: label, rule: 'shape', message: `not readable as JSON: ${err.message}` })
      continue
    }
    findings.push(...validateWorkflow(doc, label))
  }
  return { checked: paths.length, findings }
}

export function bundleFiles(dir = join(REPO, BUNDLE_DIR)) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f))
}

export function main(argv = []) {
  const paths = argv.length > 0 ? argv : bundleFiles()
  const { checked, findings } = validateFiles(paths)
  for (const f of findings) console.log(`FAIL ${f.file}  [${f.rule}] ${f.message}`)
  console.log(`\nvalidated ${checked} workflow file(s): ${findings.length} problem(s)`)
  if (findings.length > 0) {
    console.log('\nThe bundle is hand-authored. Run `node n8n/scrub-export.mjs` on a live')
    console.log('export before committing it, and keep every decision in the sidecar.')
    return 1
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
