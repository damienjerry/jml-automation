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
      say(`+ Using ${matches[0]}.`)
      return matches[0] as string
    }
    if (matches.length > 1) {
      return p.choose(`Which "${answer}" do you mean?`, matches.slice(0, 9).map((z) => ({ value: z, label: z })), matches[0])
    }
    say(`! No time zone found for "${answer}". Type the nearest large city, such as London, New York or Sydney.`)
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
  say('~ None of these answers is secret. They are saved in jml.config.yaml in this folder.')
  const name = await p.ask('What is your organisation called? (as it should appear in emails)', { validate: (a) => (a ? null : 'a name is needed') })
  say('~ The part of your staff email addresses after the @. For jane@example.com, that is example.com.')
  const domain = (await p.ask('Your staff email domain', { validate: (a) => (DOMAIN.test(a) ? null : 'a domain like example.com, without the @') })).toLowerCase()
  say('~ Only if the same people also have addresses on a second domain, such as an old company name. Most organisations do not: press Enter.')
  const aliases = (await p.ask('Any other email domains for the same people? (separate with commas)', { default: '' }))
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
  say(`~ Leaving dates are counted in this time zone. This computer is set to ${detected}. To use another, type a city, such as London or New York.`)
  const tz = await askTimeZone(p, say, detected)
  say('~ The name at the bottom of the emails the toolkit sends to managers and new starters.')
  const signature = await p.ask('Sign the emails as', { default: 'IT Team' })

  say('# Google Workspace')
  say('~ The toolkit makes its changes in Google on behalf of one admin. Give the email address of a real Google admin account, not a group.')
  const admin = await p.ask('Google admin email address', { validate: (a) => (EMAIL.test(a) ? null : 'an email address, such as it-admin@example.com') })
  say('~ The toolkit sends its emails from this address. It must be a real mailbox, not a group or an alias. The admin address is fine.')
  const sender = await p.ask('Send the emails from', { default: admin, validate: (a) => (EMAIL.test(a) ? null : 'an email address, such as it@example.com') })

  say('# How your people sign in')
  say('~ 1: through JumpCloud (setup 1.0a). JumpCloud also looks after laptops, and an account is never deleted while a laptop is still linked to it.')
  say('~ 2: straight into Google (setup 1.0b). The Google account is the only account; your HR system, or you, create it. Laptops are not tracked.')
  const identity = await p.choose('How do your people sign in to work apps?', [
    { value: 'jumpcloud', label: 'Through JumpCloud (setup 1.0a)' },
    { value: 'none', label: 'Straight into Google (setup 1.0b)' },
  ], 'jumpcloud')

  say('# Your list of people')
  say('~ The toolkit follows this list: when someone appears they are a starter, and when their last working day passes they are a leaver.')
  const hris = await p.choose('Where is your list of people kept?', [
    { value: 'hibob', label: 'In HiBob' },
    { value: 'sheet', label: 'In a Google Sheet that someone keeps up to date' },
    { value: 'csv', label: 'In a CSV file, exported from an HR system' },
    { value: 'fixture', label: 'Nowhere yet: use the made-up demo people, to try things out' },
  ], 'hibob')
  const table: [readonly (string | number)[], unknown][] = []
  if (hris === 'sheet' || hris === 'csv') {
    say('~ The first row must be the column headings. examples/people.csv shows the headings expected. When someone leaves, keep their row and fill in their last working day.')
    if (hris === 'sheet') {
      say("~ The sheet's ID is the long code in its web address, between /d/ and /edit.")
      const id = await p.ask('Google Sheet ID', { validate: (a) => (/^[A-Za-z0-9_-]{20,}$/.test(a) ? null : 'the long code from the sheet web address, between /d/ and /edit') })
      const range = await p.ask('Name of the tab that holds the people', { default: 'People' })
      say('~ You will need to share the sheet with the service account address, as a viewer. The address is shown when you add the Google key in the next step.')
      table.push([['hris', 'table', 'spreadsheetId'], id], [['hris', 'table', 'range'], range])
    } else {
      let path = await p.ask('Where is the CSV file on this computer? (the full path)', { validate: (a) => (a ? null : 'a file path, such as /Users/jane/Documents/people.csv') })
      if (opts.docker !== false) path = await csvIntoData(p, say, path, dirname(configPath))
      table.push([['hris', 'table', 'path'], path])
    }
    const format = await p.choose('How are dates written in it?', [
      { value: 'YYYY-MM-DD', label: '2026-09-27  (year-month-day)' },
      { value: 'DD/MM/YYYY', label: '27/09/2026  (day/month/year)' },
      { value: 'MM/DD/YYYY', label: '09/27/2026  (month/day/year)' },
    ], 'YYYY-MM-DD')
    table.push([['hris', 'table', 'dateFormat'], format])
  }
  say('~ A safety check. If a read of your list ever comes back with fewer people than this, the run stops and changes nothing, because a broken read looks exactly like everyone leaving. About 80% of your current headcount is right.')
  const floor = await p.ask('Stop if fewer than this many people are listed', { validate: (a) => (/^\d+$/.test(a) && Number(a) > 0 ? null : 'a whole number above 0, such as 40') })

  say("# The toolkit's own records")
  say('~ Where the toolkit notes what it has done for each person. A local file needs no setup.')
  const store = await p.choose('Where should the toolkit keep its records?', [
    { value: 'sqlite', label: 'In a local file on this computer (recommended)' },
    { value: 'notion', label: 'In a Notion database you already have' },
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
    say('~ The database ID is the 32 characters in its web address.')
    const db = await p.ask('Notion database ID', { validate: (a) => (/^[0-9a-f-]{32,36}$/i.test(a) ? null : 'the 32 characters from the database web address') })
    say('~ If something else already writes to this database, the toolkit will only ever read it.')
    const shared = await p.confirm('Does another automation already write to this database?', true)
    values.push([['store'], { adapter: 'notion', token: 'env:NOTION_API_KEY', peopleDatabaseId: db.replace(/-/g, ''), readOnly: shared }])
  }

  say('# Summaries')
  say('~ After each run the toolkit writes a summary. It can also post it to a Slack channel; if not, you read it on screen or in the log.')
  const slack = await p.confirm('Post the summaries to Slack as well?', false)
  if (slack) {
    say('~ In Slack, click the channel name; the channel ID is at the bottom of the window that opens. It starts with C or G.')
    const channel = await p.ask('Slack channel ID', { validate: (a) => (/^[CG][A-Z0-9]{8,}$/.test(a) ? null : 'an ID that starts with C or G, followed by letters and numbers') })
    values.push([['notify', 'adapters'], ['slack', 'console']], [['notify', 'slack', 'botToken'], 'env:SLACK_BOT_TOKEN'], [['notify', 'slack', 'itChannelId'], channel])
    await setEnv(envPath, 'SLACK_JML_CHANNEL_ID', channel)
  }
  await setConfig(configPath, values)
  say('+ Saved jml.config.yaml. Nothing is switched on: every run only reports what it would do, until you switch actions on one at a time.')
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
  say(`~ The scheduled runs happen inside Docker, which can only see this install's data folder. So the CSV has to be at ${target}.`)
  say(`~ From now on, save or export the file to ${target}. A copy made now is read for ever if the export keeps going somewhere else.`)
  if (existsSync(absolute) && (await p.confirm(`Copy the file to ${target} now?`, true))) {
    await mkdir(dataDir, { recursive: true })
    await copyFile(absolute, join(dataDir, basename(absolute)))
    say(`+ Copied to ${target}.`)
  } else {
    say(`! Put the file at ${target} before the first run.`)
  }
  return target
}

interface Needed {
  key: string
  /** Where jml.config.yaml references this credential. */
  path: readonly string[]
  what: string
  /** One line: what this key is and where it comes from, for somebody who has never made one. */
  explain: string
  minimum: string
  docs: string
  kind: 'text' | 'google-json'
}

export function neededCredentials(a: Answers): Needed[] {
  const out: Needed[] = []
  if (a.hris === 'hibob') {
    out.push(
      { key: 'HIBOB_SERVICE_USER_ID', path: ['hris', 'hibob', 'serviceUserId'], what: 'HiBob service user ID', explain: 'The ID of a login made for the toolkit in HiBob: Settings, then Integrations, then Service users.', minimum: 'a service user with READ access to the people fields listed in the docs; the toolkit never writes to HiBob', docs: 'docs/credentials.md#the-hr-system', kind: 'text' },
      { key: 'HIBOB_SERVICE_TOKEN', path: ['hris', 'hibob', 'serviceToken'], what: 'HiBob service user token', explain: 'The token HiBob shows once, when you create that same service user.', minimum: 'the token of that same service user', docs: 'docs/credentials.md#the-hr-system', kind: 'text' },
    )
  }
  if (a.identity === 'jumpcloud') {
    out.push({ key: 'JUMPCLOUD_API_KEY', path: ['identity', 'jumpcloud', 'apiKey'], what: 'JumpCloud API key', explain: 'In the JumpCloud admin console, open your profile menu (top right), then API Settings. The key belongs to that admin, so a separate admin just for the toolkit is best.', minimum: "the key inherits its admin's role; a read-only admin is enough until you arm anything", docs: 'docs/credentials.md#jumpcloud', kind: 'text' })
  }
  out.push(
    { key: 'GOOGLE_SERVICE_ACCOUNT_JSON', path: ['google', 'serviceAccountJson'], what: 'Google service account key (JSON file)', explain: 'A key file for a Google Cloud service account, which lets the toolkit act in your Workspace. You create the service account in Google Cloud, add a key, and download it as JSON.', minimum: 'domain-wide delegation for exactly the scopes listed below, added in the Google Admin console', docs: 'docs/credentials.md#google-workspace', kind: 'google-json' },
  )
  if (a.store === 'notion') out.push({ key: 'NOTION_API_KEY', path: ['store', 'token'], what: 'Notion integration secret', explain: 'The secret of a Notion internal integration (notion.so/my-integrations) that has been given access to the database.', minimum: 'an integration shared with the people database only', docs: 'docs/adapters/notion.md', kind: 'text' })
  if (a.slack) out.push({ key: 'SLACK_BOT_TOKEN', path: ['notify', 'slack', 'botToken'], what: 'Slack bot token', explain: 'The Bot User OAuth Token of a Slack app installed in your workspace (api.slack.com/apps, then OAuth and Permissions). It starts xoxb-.', minimum: 'chat:write, invited to the channel; nothing that reads conversations', docs: 'docs/credentials.md#slack', kind: 'text' })
  return out
}

export async function askCredentials(d: CredentialDeps, answers: Answers): Promise<void> {
  d.say(
    d.keepReferences
      ? '~ Nothing you enter here is shown on screen. A 1Password reference is saved as a reference, and the key itself is never written to disk. A pasted key or key file is saved in plain text in .env in this folder, readable only by you.'
      : '~ Nothing you enter here is shown on screen. Keys are saved in plain text in .env in this folder, readable only by you, because the toolkit runs inside Docker, which cannot use 1Password. A 1Password reference is read once and remembered, so updating a key later is one re-run.',
  )
  for (const need of neededCredentials(answers)) {
    const [docFile, docSection] = need.docs.split('#')
    d.say(`# ${need.what}`)
    d.say(`~ What it is: ${need.explain}`)
    d.say(`~ Access it needs: ${need.minimum}`)
    d.say(`~ Step by step: ${docFile}${docSection ? `, in the section "${docSection.replace(/-/g, ' ')}"` : ''}`)
    if (need.kind === 'google-json') printScopes(d.say, answers)
    const have = Boolean(d.env[need.key])
    const known = d.state.references[need.key]
    const options = [
      ...(have ? [{ value: 'keep' as const, label: 'Keep the one already saved' }] : []),
      ...(known ? [{ value: 'refresh' as const, label: `Read it again from 1Password (${known})` }] : []),
      { value: 'op' as const, label: 'Read it from 1Password' },
      { value: need.kind === 'google-json' ? ('file' as const) : ('paste' as const), label: need.kind === 'google-json' ? 'Use the JSON key file you downloaded from Google' : 'Paste it' },
    ]
    const how = await d.prompter.choose(`How will you give the ${need.what}?`, options, have ? 'keep' : undefined)
    if (how === 'keep') continue
    let value = ''
    if (how === 'op' || how === 'refresh') {
      if (!(how === 'refresh' && known)) {
        d.say('~ In 1Password, open the item, click the field, and choose Copy Secret Reference. It looks like op://Vault/item/field. Using the item ID rather than its name keeps it working if the item is renamed.')
      }
      const ref = how === 'refresh' && known ? known : await d.prompter.ask('1Password secret reference', { validate: (a) => (/^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(a) ? null : 'a reference in the form op://Vault/item/field') })
      const read = await d.opRead(ref)
      if (!read.ok || !read.value) throw new Error(`could not read ${ref}: ${read.error || 'empty value'}`)
      d.state.references[need.key] = ref
      if (d.keepReferences) {
        // Read once to prove the reference resolves, then keep only the reference.
        if (need.kind === 'google-json') checkGoogleKey(read.value, d.say)
        await setConfig(d.configPath, [[need.path, ref]])
        d.say(`+ Saved the reference ${ref} in jml.config.yaml. The key itself was not written to disk.`)
        if (d.env[need.key]) {
          // An earlier run left the value in plain text. It is no longer read.
          d.say(`~ An older copy of this key is still saved in .env in plain text. Nothing uses it now.`)
          if (await d.prompter.confirm('Delete the old copy from .env?', true)) {
            await unsetEnv(d.envPath, need.key)
            delete d.env[need.key]
            d.say(`+ Deleted ${need.key} from .env.`)
          } else {
            d.say(`! ${need.key} stays in .env in plain text. Nothing reads it; delete the line yourself when you are ready.`)
          }
        }
        continue
      }
      value = read.value
    } else if (how === 'file') {
      const path = await d.prompter.ask('Where is the JSON key file? (the full path, such as ~/Downloads/key.json)')
      value = await readFile(path.replace(/^~(?=\/)/, process.env['HOME'] ?? '~'), 'utf8')
    } else {
      value = await d.prompter.secret(`Paste the ${need.what}`)
    }
    if (need.kind === 'google-json') value = checkGoogleKey(value, d.say)
    if (!value.trim()) throw new Error(`${need.what} is empty`)
    await setEnv(d.envPath, need.key, value.trim())
    // The configuration points at the environment variable, whatever an
    // earlier run set it to.
    await setConfig(d.configPath, [[need.path, 'env:' + need.key]])
    d.env[need.key] = value.trim()
    d.say(`+ Saved in .env, in plain text, readable only by you.`)
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
  say(`+ This key belongs to ${parsed.client_email}.`)
  say(`~ In the Google Admin console, give domain-wide delegation to client ID ${parsed.client_id ?? 'unknown'}, with the scopes listed above.`)
  return JSON.stringify(parsed)
}

function printScopes(say: (l: string) => void, answers: Answers): void {
  say('~ In the Google Admin console: Security, then Access and data control, then API controls, then Manage domain-wide delegation. Add the client ID that is shown once you give the key, with these scopes, exactly as written:')
  // With no identity provider, closing the Google account on day 0 ends its
  // sessions, which needs the security scope, so it is not optional there.
  const closesGoogle = answers.identity === 'none'
  for (const use of SCOPE_USES.filter((u) => u.required || (closesGoogle && u.armedBy?.includes('google_close')))) say(`    ${use.scope}`)
  if (answers.hris === 'sheet') {
    say("~ The people sheet needs no delegation: share the sheet, as a viewer, with the key's address, which is shown once you give the key.")
  }
  const optional = SCOPE_USES.filter((u) => !u.required && u.armedBy && !(closesGoogle && u.armedBy.includes('google_close')))
  if (optional.length > 0) {
    say('~ Add this one too only if you will switch on the step named in brackets:')
    for (const use of optional) say(`    ${use.scope}   (${(use.armedBy ?? []).filter((a) => a !== 'google_close').join(', ')}, and suspend when there is no identity provider)`)
  }
}
