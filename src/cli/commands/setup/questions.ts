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

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SCOPE_USES } from '../../../connectors/google/scopes.ts'
import { setConfig, setEnv, unsetEnv, type SetupState } from './files.ts'
import type { Prompter } from './prompter.ts'

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Ask for a time zone the way a person thinks of one: a city.
 *
 * Enter keeps the zone the machine reports. A city (London, New York, sao
 * paulo) is matched against the zones the runtime knows; one match is taken,
 * several are offered as a short list, none asks again. A full zone name such
 * as Europe/London is accepted as it is.
 */
export async function askTimeZone(p: Prompter, say: (l: string) => void, detected: string): Promise<string> {
  for (;;) {
    const answer = (await p.ask('Time zone', { default: detected })).trim()
    if (isTimeZone(answer)) return answer
    const matches = zonesForCity(answer)
    if (matches.length === 1) {
      say(`  using ${matches[0]}`)
      return matches[0] as string
    }
    if (matches.length > 1) {
      return p.choose(`More than one zone matches "${answer}"`, matches.slice(0, 9).map((z) => ({ value: z, label: z })), matches[0])
    }
    say(`  No time zone found for "${answer}". Type the nearest large city, for example London, New York or Sydney.`)
  }
}

/** Zones whose city part matches the text, ignoring case, spaces and underscores. */
export function zonesForCity(text: string): string[] {
  const wanted = text.trim().toLowerCase().replace(/[\s_]+/g, ' ')
  if (!wanted) return []
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const city = (zone: string) => (zone.split('/').pop() ?? '').toLowerCase().replace(/_/g, ' ')
  const exact = zones.filter((z) => city(z) === wanted)
  return exact.length > 0 ? exact : zones.filter((z) => city(z).startsWith(wanted))
}

/** True for a zone the runtime knows, such as Europe/London. */
export function isTimeZone(value: string): boolean {
  if (!value) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value })
    return true
  } catch {
    return false
  }
}
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

export async function askConfiguration(p: Prompter, say: (l: string) => void, configPath: string, envPath: string, opts: { docker?: boolean } = {}): Promise<Answers> {
  say('\nYour organisation. None of this is secret; it goes into jml.config.yaml.')
  const name = await p.ask("Your organisation's name, as it should read in emails", { validate: (a) => (a ? null : 'required') })
  const domain = (await p.ask('Your main email domain, e.g. example.com', { validate: (a) => (DOMAIN.test(a) ? null : 'a domain like example.com') })).toLowerCase()
  say('  Some organisations give the same people a second email domain, such as an old company name. Leave this blank if yours does not.')
  const aliases = (await p.ask('Other email domains your staff use, comma-separated', { default: '' }))
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
  say(`  Dates are counted in your time zone. This machine says ${detected}: press Enter to keep it, or type a city.`)
  const tz = await askTimeZone(p, say, detected)
  say('  Emails the toolkit sends to managers and new starters end with this name.')
  const signature = await p.ask('Sign emails as', { default: 'IT Team' })

  say('\nGoogle Workspace.')
  say('  The toolkit works in Google as one of your admins. Give a real admin account, not a group.')
  const admin = await p.ask('Google admin account to act as', { validate: (a) => (EMAIL.test(a) ? null : 'an email address') })
  say('  Emails from the toolkit come from this address. It must be a real mailbox, not a group or an alias; the admin account is fine.')
  const sender = await p.ask('Send emails from', { default: admin, validate: (a) => (EMAIL.test(a) ? null : 'an email address') })

  say('\nDo people sign in through JumpCloud, or straight into Google?')
  say('  Through JumpCloud (setup 1.0a): JumpCloud also looks after laptops, and an account is not deleted while a laptop is still linked to it.')
  say('  Straight into Google (setup 1.0b): the Google account is the only account. Your HR system, or you, create it and the toolkit does the rest. Laptops are not tracked.')
  const identity = await p.choose('Sign-in', [
    { value: 'jumpcloud', label: 'through JumpCloud (setup 1.0a)' },
    { value: 'none', label: 'straight into Google (setup 1.0b)' },
  ], 'jumpcloud')

  say('\nWhere the list of your people comes from. It is the source of truth: the toolkit follows it.')
  const hris = await p.choose('People list', [
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
      const range = await p.ask('Name of the tab with your people', { default: 'People' })
      say('  Share the sheet with the service account address as a viewer; it is printed with the Google key below.')
      table.push([['hris', 'table', 'spreadsheetId'], id], [['hris', 'table', 'range'], range])
    } else {
      let path = await p.ask('Path to the CSV file', { validate: (a) => (a ? null : 'required') })
      if (opts.docker !== false) path = await csvIntoData(p, say, path, dirname(configPath))
      table.push([['hris', 'table', 'path'], path])
    }
    const format = await p.choose('Date format used in the table', [
      { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' },
      { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' },
      { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' },
    ], 'YYYY-MM-DD')
    table.push([['hris', 'table', 'dateFormat'], format])
  }
  say('  A safety check. If a read of your people ever lists fewer than this, the run stops, because a broken read looks exactly like everybody leaving. About 80% of your current headcount is sensible.')
  const floor = await p.ask('Stop if fewer people than this are listed', { validate: (a) => (/^\d+$/.test(a) && Number(a) > 0 ? null : 'a whole number above 0') })

  say('\nWhere the toolkit keeps its own record of what it has done for each person.')
  const store = await p.choose('Records', [
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
  const slack = await p.confirm('Post summaries to Slack? No shows them on this screen only', false)
  if (slack) {
    const channel = await p.ask('Slack channel ID (in Slack, click the channel name; the ID is at the bottom, starting C or G)', { validate: (a) => (/^[CG][A-Z0-9]{8,}$/.test(a) ? null : 'a channel id starting with C or G') })
    values.push([['notify', 'adapters'], ['slack', 'console']], [['notify', 'slack', 'botToken'], 'env:SLACK_BOT_TOKEN'], [['notify', 'slack', 'itChannelId'], channel])
    await setEnv(envPath, 'SLACK_JML_CHANNEL_ID', channel)
  }
  await setConfig(configPath, values)
  say('\nwrote jml.config.yaml. Mode is dry-run and nothing is armed: every run plans and reports until you arm actions one at a time.')
  return { identity, hris, store, slack }
}

/**
 * With Docker, the sidecar sees only this install's data/ folder, mounted at
 * the same relative path, so a CSV anywhere else would read on this machine
 * during setup and be missing inside the container on the first scheduled run.
 * The one path both see the same way is ./data/<file>.
 */
async function csvIntoData(p: Prompter, say: (l: string) => void, given: string, installDir: string): Promise<string> {
  const dataDir = join(installDir, 'data')
  const absolute = isAbsolute(given) ? given : resolve(given)
  const rel = relative(dataDir, absolute)
  if (!rel.startsWith('..') && !isAbsolute(rel)) return './data/' + rel.split(sep).join('/')
  const target = './data/' + basename(absolute)
  say(`  With Docker, the scheduled runs happen inside a container that sees only this install's data/ folder, so the CSV has to live there: ${target}.`)
  if (existsSync(absolute) && (await p.confirm(`Copy ${given} to ${target} now? Point your export at ${target} from now on, or the runs read this copy for ever.`, true))) {
    await mkdir(dataDir, { recursive: true })
    await copyFile(absolute, join(dataDir, basename(absolute)))
    say(`  copied to ${target}`)
  } else {
    say(`  Put the file at ${target}, and point your export there.`)
  }
  return target
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
