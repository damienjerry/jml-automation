/**
 * The configuration and credential steps of `jml setup`.
 *
 * Configuration writes only non-secret values into `jml.config.yaml`. Every
 * credential goes to `.env`, and the configuration keeps the `env:` reference
 * it was generated with, so the same file works for the CLI on this machine
 * and for the sidecar container, which reads `.env` through Compose.
 *
 * A 1Password reference typed at a credential prompt is read once, through the
 * `op` CLI, and its value written to `.env`. The reference is kept in the
 * setup state so a later run can pull a rotated value without anybody typing
 * it again. The container cannot run `op` itself, which is why the value has
 * to land in `.env` at all.
 */

import { readFile } from 'node:fs/promises'
import { SCOPE_USES } from '../../../connectors/google/scopes.ts'
import { setConfig, setEnv, unsetEnv, type SetupState } from './files.ts'
import type { Prompter } from './prompter.ts'

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const DOMAIN = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export interface Answers {
  identity: 'jumpcloud' | 'none'
  hris: 'hibob' | 'fixture' | 'csv' | 'sheet'
  store: 'sqlite' | 'notion'
  slack: boolean
}

export interface CredentialDeps {
  prompter: Prompter
  say(line: string): void
  envPath: string
  env: Record<string, string>
  state: SetupState
  configPath: string
  /**
   * True when nothing runs in a container (--no-docker). A 1Password
   * reference is then kept as a reference in jml.config.yaml and the value
   * never touches the disk. With Docker the sidecar cannot run the `op` CLI,
   * so the value has to be copied into .env.
   */
  keepReferences: boolean
  /** Runs `op read`. Returns stdout, which is never printed. */
  opRead(ref: string): Promise<{ ok: boolean; value: string; error: string }>
}

export async function askConfiguration(p: Prompter, say: (l: string) => void, configPath: string, envPath: string): Promise<Answers> {
  say('\nYour organisation. None of this is secret; it goes into jml.config.yaml.')
  const name = await p.ask('Organisation name', { validate: (a) => (a ? null : 'required') })
  const domain = (await p.ask('Primary email domain, e.g. example.com', { validate: (a) => (DOMAIN.test(a) ? null : 'a domain like example.com') })).toLowerCase()
  const aliases = (await p.ask('Other domains that deliver to the same mailboxes, comma-separated (blank for none)', { default: '' }))
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  const tz = await p.ask('Timezone (IANA name)', { default: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const signature = await p.ask('Sign-off on messages sent to people', { default: 'IT Team' })

  say('\nGoogle Workspace.')
  const admin = await p.ask('Admin the service account acts as', { validate: (a) => (EMAIL.test(a) ? null : 'an email address') })
  say('  Messages are sent AS the next mailbox, by impersonation, so it must be a real user rather than an alias or a group.')
  const sender = await p.ask('Mailbox notifications are sent as', { default: admin, validate: (a) => (EMAIL.test(a) ? null : 'an email address') })

  say('\nIs there an identity provider in front of Google?')
  say('  JumpCloud (setup 1.0a) also manages devices and remote support, and blocks a deletion while a laptop is still bound.')
  say('  None (setup 1.0b): the Google account is the only account. Your HR system or you create it; the toolkit does the rest. No device inventory is checked.')
  const identity = await p.choose('Identity provider', [
    { value: 'jumpcloud', label: 'JumpCloud (1.0a)' },
    { value: 'none', label: 'none: Google Workspace alone (1.0b)' },
  ], 'jumpcloud')

  say('\nThe HR system is the source of truth.')
  const hris = await p.choose('HR system', [
    { value: 'hibob', label: 'HiBob' },
    { value: 'sheet', label: 'a Google Sheet of people, kept up to date by a person or an HR report' },
    { value: 'csv', label: 'a CSV file, exported from any HR system' },
    { value: 'fixture', label: 'the offline demo file (no HR credentials; for a rehearsal)' },
  ], 'hibob')
  const table: [readonly (string | number)[], unknown][] = []
  if (hris === 'sheet' || hris === 'csv') {
    say('  Headings in the first row; defaults match examples/people.csv. A leaver keeps their row with a last working day filled in.')
    if (hris === 'sheet') {
      const id = await p.ask('Sheet id (the long part of its URL between /d/ and /edit)', { validate: (a) => (/^[A-Za-z0-9_-]{20,}$/.test(a) ? null : 'the id from the sheet URL') })
      const range = await p.ask('Tab holding the people', { default: 'People' })
      say('  Share the sheet with the service account address as a viewer; it is printed with the Google key below.')
      table.push([['hris', 'table', 'spreadsheetId'], id], [['hris', 'table', 'range'], range])
    } else {
      const path = await p.ask('Path to the CSV file', { validate: (a) => (a ? null : 'required') })
      table.push([['hris', 'table', 'path'], path])
    }
    const format = await p.choose('Date format used in the table', [
      { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
      { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
      { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
    ], 'YYYY-MM-DD')
    table.push([['hris', 'table', 'dateFormat'], format])
  }
  say('  A read smaller than this floor aborts the run: a truncated read looks exactly like everybody leaving.')
  const floor = await p.ask('Fewest employed people a real read could ever return', { validate: (a) => (/^\d+$/.test(a) && Number(a) > 0 ? null : 'a whole number above 0') })

  say('\nWhere the toolkit keeps one row per person.')
  const store = await p.choose('People store', [
    { value: 'sqlite', label: 'a local SQLite file (recommended: nothing to set up)' },
    { value: 'notion', label: 'an existing Notion database' },
  ], 'sqlite')
  const values: [readonly (string | number)[], unknown][] = [
    [['org', 'name'], name],
    [['org', 'primaryDomain'], domain],
    [['org', 'aliasDomains'], aliases],
    [['org', 'timezone'], tz],
    [['org', 'itTeamSignature'], signature],
    [['google', 'adminEmail'], admin],
    [['mail', 'senderMailbox'], sender],
    [['hris', 'adapter'], hris],
    ...table,
    [['identity', 'adapter'], identity],
    [['hris', 'minPlausibleHeadcount'], Number(floor)],
    [['mode'], 'dry-run'],
    [['armedActions'], []],
  ]
  if (store === 'notion') {
    const db = await p.ask('Notion database id (the 32 characters in its URL)', { validate: (a) => (/^[0-9a-f-]{32,36}$/i.test(a) ? null : 'a 32-character database id') })
    const shared = await p.confirm('Does another automation already write to this database? (answer yes and the toolkit will only ever read it)', true)
    values.push([['store'], { adapter: 'notion', token: 'env:NOTION_API_KEY', peopleDatabaseId: db.replace(/-/g, ''), readOnly: shared }])
  }

  say('\nNotifications.')
  const slack = await p.confirm('Post summaries to Slack? (no prints them here only)', false)
  if (slack) {
    const channel = await p.ask('Slack channel id: C or G followed by letters and digits (channel details, bottom of the About tab)', { validate: (a) => (/^[CG][A-Z0-9]{8,}$/.test(a) ? null : 'a channel id starting with C or G') })
    values.push([['notify', 'adapters'], ['slack', 'console']], [['notify', 'slack', 'botToken'], 'env:SLACK_BOT_TOKEN'], [['notify', 'slack', 'itChannelId'], channel])
    await setEnv(envPath, 'SLACK_JML_CHANNEL_ID', channel)
  }
  await setConfig(configPath, values)
  say('\nwrote jml.config.yaml. Mode is dry-run and nothing is armed: every run plans and reports until you arm actions one at a time.')
  return { identity, hris, store, slack }
}

interface Needed {
  key: string
  /** Where jml.config.yaml references this credential. */
  path: readonly string[]
  what: string
  minimum: string
  docs: string
  kind: 'text' | 'google-json'
}

export function neededCredentials(a: Answers): Needed[] {
  const out: Needed[] = []
  if (a.hris === 'hibob') {
    out.push(
      { key: 'HIBOB_SERVICE_USER_ID', path: ['hris', 'hibob', 'serviceUserId'], what: 'HiBob service user id', minimum: 'a service user with READ access to the people fields listed in the docs; the toolkit never writes to HiBob', docs: 'docs/credentials.md#the-hr-system', kind: 'text' },
      { key: 'HIBOB_SERVICE_TOKEN', path: ['hris', 'hibob', 'serviceToken'], what: 'HiBob service user token', minimum: 'the token of that same service user', docs: 'docs/credentials.md#the-hr-system', kind: 'text' },
    )
  }
  if (a.identity === 'jumpcloud') {
    out.push({ key: 'JUMPCLOUD_API_KEY', path: ['identity', 'jumpcloud', 'apiKey'], what: 'JumpCloud API key', minimum: "the key inherits its admin's role; a read-only admin is enough until you arm anything", docs: 'docs/credentials.md#jumpcloud', kind: 'text' })
  }
  out.push(
    { key: 'GOOGLE_SERVICE_ACCOUNT_JSON', path: ['google', 'serviceAccountJson'], what: 'Google service account key (JSON file)', minimum: 'domain-wide delegation for exactly the scopes printed below, granted one by one in the Admin console', docs: 'docs/credentials.md#google-workspace', kind: 'google-json' },
  )
  if (a.store === 'notion') out.push({ key: 'NOTION_API_KEY', path: ['store', 'token'], what: 'Notion internal integration token', minimum: 'an integration shared with the people database only', docs: 'docs/adapters/notion.md', kind: 'text' })
  if (a.slack) out.push({ key: 'SLACK_BOT_TOKEN', path: ['notify', 'slack', 'botToken'], what: 'Slack bot token (xoxb-...)', minimum: 'chat:write, invited to the channel; nothing that reads conversations', docs: 'docs/credentials.md#slack', kind: 'text' })
  return out
}

export async function askCredentials(d: CredentialDeps, answers: Answers): Promise<void> {
  d.say(
    d.keepReferences
      ? '\nCredentials. A 1Password reference stays a reference in jml.config.yaml and the value never touches the disk. A pasted value or key file is written to .env (mode 600, plain text). Nothing is printed.'
      : '\nCredentials. Values are written to .env in plain text, mode 600, because the sidecar container reads them from there and cannot run the 1Password CLI. A 1Password reference is read once and its value copied in; the reference is kept so a rotation is one re-run. Nothing is printed.',
  )
  for (const need of neededCredentials(answers)) {
    d.say(`\n${need.what}`)
    d.say(`  minimum access: ${need.minimum}`)
    d.say(`  details: ${need.docs}`)
    if (need.kind === 'google-json') printScopes(d.say, answers)
    const have = Boolean(d.env[need.key])
    const known = d.state.references[need.key]
    const options = [
      ...(have ? [{ value: 'keep' as const, label: 'keep the value already in .env' }] : []),
      ...(known ? [{ value: 'refresh' as const, label: `read it again from ${known}` }] : []),
      { value: 'op' as const, label: 'read it from 1Password (op://vault/item/field; use the item id, not its title)' },
      { value: need.kind === 'google-json' ? ('file' as const) : ('paste' as const), label: need.kind === 'google-json' ? 'read the downloaded JSON key file' : 'paste it (hidden)' },
    ]
    const how = await d.prompter.choose('  source', options, have ? 'keep' : undefined)
    if (how === 'keep') continue
    let value = ''
    if (how === 'op' || how === 'refresh') {
      const ref = how === 'refresh' && known ? known : await d.prompter.ask('  1Password reference', { validate: (a) => (/^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(a) ? null : 'op://vault/item/field') })
      const read = await d.opRead(ref)
      if (!read.ok || !read.value) throw new Error(`could not read ${ref}: ${read.error || 'empty value'}`)
      d.state.references[need.key] = ref
      if (d.keepReferences) {
        // Read once to prove the reference resolves, then keep only the reference.
        if (need.kind === 'google-json') checkGoogleKey(read.value, d.say)
        await setConfig(d.configPath, [[need.path, ref]])
        d.say(`  jml.config.yaml now references ${ref} (${read.value.trim().length} characters); nothing was written to disk`)
        if (d.env[need.key]) {
          // An earlier run left the value in plain text. It is no longer read.
          if (await d.prompter.confirm(`  .env still holds an old plain-text ${need.key}, which nothing reads now. Remove it?`, true)) {
            await unsetEnv(d.envPath, need.key)
            delete d.env[need.key]
            d.say(`  removed ${need.key} from .env`)
          } else {
            d.say(`  ${need.key} stays in .env in plain text. Nothing reads it; delete the line yourself when you are ready.`)
          }
        }
        continue
      }
      value = read.value
    } else if (how === 'file') {
      const path = await d.prompter.ask('  path to the JSON key file')
      value = await readFile(path.replace(/^~(?=\/)/, process.env['HOME'] ?? '~'), 'utf8')
    } else {
      value = await d.prompter.secret('  value')
    }
    if (need.kind === 'google-json') value = checkGoogleKey(value, d.say)
    if (!value.trim()) throw new Error(`${need.what} is empty`)
    await setEnv(d.envPath, need.key, value.trim())
    // The configuration points at the environment variable, whatever an
    // earlier run set it to.
    await setConfig(d.configPath, [[need.path, 'env:' + need.key]])
    d.env[need.key] = value.trim()
    d.say(`  stored ${need.key} in .env, plain text, mode 600 (${value.trim().length} characters)`)
  }
}

/** Check the key is a service account key and minify it onto one line. Prints the client id, which is needed for delegation and is not secret. */
function checkGoogleKey(text: string, say: (l: string) => void): string {
  let parsed: { type?: string; client_email?: string; client_id?: string; private_key?: string }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('that is not a JSON key file; download a JSON key for the service account in the Google Cloud console')
  }
  if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
    throw new Error('that JSON is not a service account key (it has no type "service_account" or no private key)')
  }
  say(`  service account ${parsed.client_email}, client id ${parsed.client_id ?? 'unknown'}: grant delegation to that client id`)
  return JSON.stringify(parsed)
}

function printScopes(say: (l: string) => void, answers: Answers): void {
  say('  scopes to delegate (Admin console, Security, API controls, Domain-wide delegation), exactly as written:')
  // With no identity provider, closing the Google account on day 0 ends its
  // sessions, which needs the security scope, so it is not optional there.
  const closesGoogle = answers.identity === 'none'
  for (const use of SCOPE_USES.filter((u) => u.required || (closesGoogle && u.armedBy?.includes('google_close')))) say(`    ${use.scope}`)
  if (answers.hris === 'sheet') {
    say('  and for the people sheet, no delegation at all: share the sheet with the service account address above as a viewer.')
  }
  const optional = SCOPE_USES.filter((u) => !u.required && u.armedBy && !(closesGoogle && u.armedBy.includes('google_close')))
  if (optional.length > 0) {
    say('  and only if you will arm the step that needs it:')
    for (const use of optional) say(`    ${use.scope}   (${(use.armedBy ?? []).filter((a) => a !== 'google_close').join(', ')}, and suspend when there is no identity provider)`)
  }
}
