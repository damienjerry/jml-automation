/**
 * Import the workflow bundle into a running n8n over its public API.
 *
 * The bundle ships credentials by name and the error workflow by name, because
 * an id means nothing on another instance. n8n's API binds neither by name, so
 * this does the binding: create the credentials the bundle names, create the
 * error workflow first, then create every other workflow with its credential
 * ids and its error workflow id filled in. Everything is created inactive; a
 * person reads a workflow and runs it once before switching it on.
 *
 * Idempotent by name. A workflow that already exists is left exactly as it is,
 * because it may have been edited since. A credential is reused when the
 * caller already holds its id from an earlier run, since n8n allows two
 * credentials with one name and a second import must not make a duplicate.
 *
 * What this sends where, so it can be checked rather than trusted: every
 * request goes to the n8n base URL the caller gives, and nowhere else. The only
 * secret values sent are the four the n8n credentials exist to hold.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HttpClient } from '../core/http.ts'

export const ERROR_WORKFLOW = 'jml-on-error'

/** The credentials the bundle references, by name, with the n8n type each one is. */
export const BUNDLE_CREDENTIALS = {
  'JML Toolkit API': 'httpHeaderAuth',
  'JML Inbound Webhook': 'httpHeaderAuth',
  'JML Form Access': 'httpBasicAuth',
  'JML Slack Alerts': 'slackApi',
} as const

export type BundleCredentialName = keyof typeof BUNDLE_CREDENTIALS

export interface CredentialValues {
  /** The sidecar bearer token, sent as `Authorization: Bearer <token>`. */
  apiToken: string
  /** The token a ticketing tool sends to the inbound webhook. */
  inboundToken: string
  /** Basic auth guarding the two forms. */
  formUser: string
  formPassword: string
  /** Absent when no Slack bot is configured; the workflows that post then fail visibly, not silently. */
  slackBotToken?: string | null
}

export interface ImportOptions {
  http: HttpClient
  /** For example http://127.0.0.1:5678. */
  baseUrl: string
  apiKey: string
  bundleDir: string
  values: CredentialValues
  /** Credential ids from an earlier import, by name, so a re-run reuses rather than duplicates. */
  knownCredentialIds?: Partial<Record<BundleCredentialName, string>>
  log?: (line: string) => void
}

export interface ImportReport {
  ok: boolean
  credentials: Partial<Record<BundleCredentialName, { id: string; created: boolean }>>
  workflows: { name: string; id: string | null; state: 'created' | 'already_present' | 'failed'; detail?: string }[]
  skippedCredentials: string[]
  errors: string[]
}

interface WorkflowFile {
  name: string
  nodes: { name: string; credentials?: Record<string, { name: string; id?: string }> }[]
  connections: unknown
  settings?: Record<string, unknown>
}

export class N8nApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'N8nApiError'
    this.status = status
  }
}

export async function importBundle(opts: ImportOptions): Promise<ImportReport> {
  const log = opts.log ?? (() => {})
  const base = opts.baseUrl.replace(/\/+$/, '')
  const headers = { 'X-N8N-API-KEY': opts.apiKey }
  const report: ImportReport = { ok: true, credentials: {}, workflows: [], skippedCredentials: [], errors: [] }

  const files = await readBundle(opts.bundleDir)
  const existing = await listWorkflowNames(opts.http, base, headers)

  // Credentials first, so every workflow can be created already bound.
  const wanted = new Set<BundleCredentialName>()
  for (const wf of files) for (const node of wf.nodes) for (const cred of Object.values(node.credentials ?? {})) {
    if (cred.name in BUNDLE_CREDENTIALS) wanted.add(cred.name as BundleCredentialName)
  }
  for (const name of [...wanted].sort()) {
    const known = opts.knownCredentialIds?.[name]
    if (known) {
      report.credentials[name] = { id: known, created: false }
      continue
    }
    const data = credentialData(name, opts.values)
    if (!data) {
      report.skippedCredentials.push(name)
      log(`skipped credential "${name}": no value configured`)
      continue
    }
    const res = await opts.http.post(`${base}/api/v1/credentials`, { name, type: BUNDLE_CREDENTIALS[name], data }, { headers, label: 'n8n create credential', maxRetries: 0, retryOn5xx: false })
    const id = res.json<{ id?: string }>()?.id
    if (!res.ok || !id) {
      report.ok = false
      report.errors.push(`credential "${name}" was not created: HTTP ${res.status} ${res.body.slice(0, 200)}`)
      continue
    }
    report.credentials[name] = { id, created: true }
    log(`created credential "${name}"`)
  }

  // The error workflow first, because every other workflow names it by id.
  const ordered = [...files].sort((a, b) => (a.name === ERROR_WORKFLOW ? -1 : b.name === ERROR_WORKFLOW ? 1 : a.name.localeCompare(b.name)))
  let errorWorkflowId = existing.get(ERROR_WORKFLOW) ?? null
  for (const wf of ordered) {
    const present = existing.get(wf.name)
    if (present) {
      report.workflows.push({ name: wf.name, id: present, state: 'already_present' })
      continue
    }
    const body = bind(wf, report.credentials, errorWorkflowId)
    const res = await opts.http.post(`${base}/api/v1/workflows`, body, { headers, label: 'n8n create workflow', maxRetries: 0, retryOn5xx: false })
    const id = res.json<{ id?: string }>()?.id ?? null
    if (!res.ok || !id) {
      report.ok = false
      const detail = `HTTP ${res.status} ${res.body.slice(0, 200)}`
      report.workflows.push({ name: wf.name, id: null, state: 'failed', detail })
      report.errors.push(`workflow "${wf.name}" was not created: ${detail}`)
      continue
    }
    if (wf.name === ERROR_WORKFLOW) errorWorkflowId = id
    report.workflows.push({ name: wf.name, id, state: 'created' })
    log(`created workflow "${wf.name}" (inactive)`)
  }
  if (!errorWorkflowId) {
    report.ok = false
    report.errors.push(`the error workflow "${ERROR_WORKFLOW}" does not exist, so a failure in any other workflow alerts nobody`)
  }
  return report
}

/** Credential values in the shape n8n stores for each type. */
function credentialData(name: BundleCredentialName, v: CredentialValues): Record<string, string> | null {
  switch (name) {
    case 'JML Toolkit API':
      return { name: 'Authorization', value: 'Bearer ' + v.apiToken }
    case 'JML Inbound Webhook':
      return { name: 'Authorization', value: 'Bearer ' + v.inboundToken }
    case 'JML Form Access':
      return { user: v.formUser, password: v.formPassword }
    case 'JML Slack Alerts':
      // n8n's schema for this type requires an empty `notice` whenever no
      // signing secret is given. Found against a real instance: without it the
      // create answers 400 and names a property nobody would guess.
      return v.slackBotToken ? { accessToken: v.slackBotToken, notice: '' } : null
  }
}

/** Fill in credential ids and the error workflow id; keep only the fields the create endpoint accepts. */
function bind(wf: WorkflowFile, creds: ImportReport['credentials'], errorWorkflowId: string | null): Record<string, unknown> {
  const nodes = wf.nodes.map((node) => {
    if (!node.credentials) return node
    const bound: Record<string, { id?: string; name: string }> = {}
    for (const [kind, cred] of Object.entries(node.credentials)) {
      const id = creds[cred.name as BundleCredentialName]?.id
      bound[kind] = id ? { id, name: cred.name } : { name: cred.name }
    }
    return { ...node, credentials: bound }
  })
  const settings: Record<string, unknown> = { ...(wf.settings ?? {}) }
  if (wf.name === ERROR_WORKFLOW) delete settings['errorWorkflow']
  else if (errorWorkflowId) settings['errorWorkflow'] = errorWorkflowId
  else delete settings['errorWorkflow']
  return { name: wf.name, nodes, connections: wf.connections, settings }
}

async function readBundle(dir: string): Promise<WorkflowFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  if (names.length === 0) throw new Error(`no workflow files in ${dir}`)
  return Promise.all(names.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as WorkflowFile))
}

async function listWorkflowNames(http: HttpClient, base: string, headers: Record<string, string>): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  let cursor: string | null = null
  for (let page = 0; page < 50; page += 1) {
    const res = await http.get(`${base}/api/v1/workflows`, { headers, label: 'n8n list workflows', query: { limit: 250, ...(cursor ? { cursor } : {}) } })
    if (res.status === 401 || res.status === 403) throw new N8nApiError(`n8n refused the API key (HTTP ${res.status}). Create one under Settings, n8n API, and paste it again.`, res.status)
    if (!res.ok) throw new N8nApiError(`n8n answered HTTP ${res.status} listing workflows: ${res.body.slice(0, 200)}`, res.status)
    const body = res.json<{ data?: { id: string; name: string }[]; nextCursor?: string | null }>()
    for (const wf of body?.data ?? []) found.set(wf.name, wf.id)
    cursor = body?.nextCursor ?? null
    if (!cursor) return found
  }
  throw new N8nApiError('n8n returned more than fifty pages of workflows; refusing to guess which already exist', 0)
}

/** True once the n8n at this URL answers its health endpoint. */
export async function n8nHealthy(http: HttpClient, baseUrl: string): Promise<boolean> {
  try {
    const res = await http.get(`${baseUrl.replace(/\/+$/, '')}/healthz`, { label: 'n8n health', maxRetries: 0, timeoutMs: 5_000 })
    return res.ok
  } catch {
    return false
  }
}
