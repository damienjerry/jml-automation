#!/usr/bin/env node
/**
 * Ask Google which delegated scopes your service account actually has.
 *
 * This is the first thing to run when setting the toolkit up, and the first
 * thing to run when a Google step stops working. It mints one assertion per
 * scope and exchanges it at the OAuth token endpoint, which is itself the
 * authorisation check, so it reads nothing in your tenancy and changes
 * nothing. It is safe against production.
 *
 * It exists because a bundled multi-scope token fails wholesale when any one
 * scope is missing, and answers with a bare `unauthorized_client` that names
 * no scope. One assertion per scope turns "delegation is broken" into "this
 * one line is missing from the Admin console".
 *
 * Nothing secret is printed. The assertion and the returned token never leave
 * this process, and only the OAuth error CODE is shown, never the description,
 * because a description can quote parts of the request and these tables get
 * pasted into issues.
 *
 * Usage:
 *   node tools/probe-dwd-scopes.mjs --admin admin@example.com \
 *     --sender it.notifications@example.com [--mailbox jane.doe@example.com]
 *
 *   --sa-env NAME   environment variable holding the key file (default
 *                   GOOGLE_SERVICE_ACCOUNT_JSON)
 *   --sa-file PATH  read the key file from disk instead
 *   --json          machine-readable output for `jml doctor`
 *
 * Exit status is 1 when any required scope is refused, so it can gate a deploy.
 */

import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/**
 * The scopes to probe, and who each one is minted for.
 *
 * Duplicated from src/connectors/google/scopes.ts on purpose: this tool has to
 * run on a fresh clone with nothing built and no dependencies installed. A
 * test asserts the two lists are identical, so they cannot drift.
 */
export const PROBE_SCOPES = [
  {
    key: 'directoryUser',
    scope: 'https://www.googleapis.com/auth/admin.directory.user',
    subject: 'admin',
  },
  {
    key: 'directoryUserReadonly',
    scope: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    subject: 'admin',
  },
  { key: 'licensing', scope: 'https://www.googleapis.com/auth/apps.licensing', subject: 'admin' },
  {
    key: 'dataTransfer',
    scope: 'https://www.googleapis.com/auth/admin.datatransfer',
    subject: 'admin',
  },
  {
    key: 'gmailSettingsBasic',
    scope: 'https://www.googleapis.com/auth/gmail.settings.basic',
    subject: 'leaver',
  },
  { key: 'gmailSend', scope: 'https://www.googleapis.com/auth/gmail.send', subject: 'sender' },
]

/** Read the flags. Unknown flags are refused rather than ignored. */
export function parseArgs(argv) {
  const opts = { saEnv: 'GOOGLE_SERVICE_ACCOUNT_JSON', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--admin':
        opts.admin = value
        i += 1
        break
      case '--sender':
        opts.sender = value
        i += 1
        break
      case '--mailbox':
        opts.mailbox = value
        i += 1
        break
      case '--sa-env':
        opts.saEnv = value
        i += 1
        break
      case '--sa-file':
        opts.saFile = value
        i += 1
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new Error(`unknown flag ${flag}`)
    }
  }
  return opts
}

/** Which address each kind of subject resolves to for this run. */
export function subjectAddress(kind, opts) {
  if (kind === 'admin') return opts.admin
  if (kind === 'sender') return opts.sender ?? opts.admin
  // The mailbox-scoped row is worth probing with an ordinary mailbox: the
  // administrator proves the scope is delegated while saying nothing about
  // whether ordinary staff can be impersonated, and that is the half that
  // usually fails.
  if (kind === 'leaver') return opts.mailbox ?? opts.admin
  return null
}

function base64Url(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * Sign one assertion for exactly one scope.
 *
 * Exported for the tests, which assert the payload carries a single scope with
 * no space in it.
 */
export function mintAssertion(serviceAccount, scope, subject, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' }
  if (serviceAccount.private_key_id) header.kid = serviceAccount.private_key_id
  const claims = {
    iss: serviceAccount.client_email,
    scope,
    aud: serviceAccount.token_uri ?? DEFAULT_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }
  if (subject) claims.sub = subject
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(serviceAccount.private_key, 'base64url')
  return `${signingInput}.${signature}`
}

/**
 * Exchange one assertion and report only the status.
 *
 * The result deliberately carries no material from the response body beyond
 * the OAuth error code.
 */
export async function probeScope({ serviceAccount, scope, subject, fetchImpl, now }) {
  const assertion = mintAssertion(
    serviceAccount,
    scope,
    subject,
    Math.floor((now ?? Date.now()) / 1000),
  )
  const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion })
  try {
    const response = await fetchImpl(serviceAccount.token_uri ?? DEFAULT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const status = response.status
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      payload = {}
    }
    const ok = status === 200 && typeof payload.access_token === 'string'
    return { scope, subject, status, ok, error: ok ? undefined : payload.error }
  } catch (err) {
    return { scope, subject, status: 0, ok: false, error: err instanceof Error ? err.name : 'error' }
  }
}

/** The last path segment of a scope, which is what a person recognises. */
export function shortScope(scope) {
  const parts = scope.split('/')
  return parts[parts.length - 1] ?? scope
}

/**
 * Render the table.
 *
 * Fed only the probe results, so there is no path by which a token could reach
 * the output. A test asserts as much.
 */
export function formatTable(results) {
  const rows = results.map((r) => ({
    scope: shortScope(r.scope),
    subject: r.subject ?? '(service account itself)',
    status: r.status === 0 ? 'unreachable' : String(r.status),
    verdict: r.ok ? 'granted' : `REFUSED${r.error ? ` (${r.error})` : ''}`,
  }))
  const width = (pick) => Math.max(...rows.map((row) => pick(row).length), 1)
  const scopeWidth = width((row) => row.scope)
  const subjectWidth = width((row) => row.subject)
  const statusWidth = width((row) => row.status)

  const lines = rows.map(
    (row) =>
      `${row.scope.padEnd(scopeWidth)}  ${row.subject.padEnd(subjectWidth)}  ${row.status.padStart(statusWidth)}  ${row.verdict}`,
  )
  const refused = results.filter((r) => !r.ok)
  if (refused.length > 0) {
    lines.push('')
    lines.push(
      `${refused.length} scope(s) refused. Add each one, exactly as written, under`,
    )
    lines.push(
      'Google Admin > Security > Access and data control > API controls > Domain-wide delegation,',
    )
    lines.push('against the service account client id. Then run this again.')
    for (const r of refused) lines.push(`  ${r.scope}`)
  }
  return lines.join('\n')
}

function loadServiceAccount(opts, env) {
  const raw = opts.saFile ? readFileSync(opts.saFile, 'utf8') : env[opts.saEnv]
  if (!raw) {
    throw new Error(
      `no service account key found: set ${opts.saEnv} or pass --sa-file. Nothing was printed.`,
    )
  }
  const parsed = JSON.parse(raw)
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('that file is not a service account key: it has no client_email or private key')
  }
  return parsed
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`))
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const opts = parseArgs(argv)

  if (opts.help || !opts.admin) {
    out('Probe Google domain-wide delegation, one scope per token.')
    out('')
    out('  --admin ADDRESS    required: the administrator to impersonate')
    out('  --sender ADDRESS   the mailbox notifications are sent as')
    out('  --mailbox ADDRESS  an ordinary mailbox, to prove staff impersonation')
    out('  --sa-env NAME      environment variable holding the key file')
    out('  --sa-file PATH     read the key file from disk instead')
    out('  --json             machine-readable output')
    return opts.help ? 0 : 2
  }

  const serviceAccount = loadServiceAccount(opts, env)
  const results = []
  for (const row of PROBE_SCOPES) {
    results.push(
      await probeScope({
        serviceAccount,
        scope: row.scope,
        subject: subjectAddress(row.subject, opts),
        fetchImpl,
      }),
    )
  }

  if (opts.json) {
    out(
      JSON.stringify(
        results.map((r) => ({
          scope: r.scope,
          subject: r.subject,
          status: r.status,
          ok: r.ok,
          error: r.error ?? null,
        })),
        null,
        2,
      ),
    )
  } else {
    out(formatTable(results))
  }
  return results.every((r) => r.ok) ? 0 : 1
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : 'failed'}\n`)
      process.exit(2)
    })
}
