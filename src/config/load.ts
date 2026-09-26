/**
 * Loading configuration.
 *
 * The order is fixed and each step exists because of a way the previous
 * arrangement failed:
 *
 *  1. read the YAML file
 *  2. expand `${ENV}` references in every string, failing on an unset name
 *  3. parse through the schema, which refuses an unknown key and refuses a
 *     literal credential written into a secret field
 *  4. refuse a credential belonging to a step this release cannot run
 *  5. resolve every secret reference and register it with the redactor
 *
 * Step 5 happens at start-up rather than at the point of use. A credential
 * resolved lazily inside a step turns a missing secret into a step that quietly
 * does nothing, and the run still reports success. Resolving everything up
 * front means a missing credential stops the process with a message naming
 * which reference failed and where it is documented.
 */

import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { ConfigSchema, SECRET_MESSAGE, type JmlConfig } from './schema.ts'
import {
  createSecretRegistry,
  resolveSecret,
  defaultProviders,
  SECRETS_DOCS_ANCHOR,
  SecretResolutionError,
  type SecretHandle,
  type SecretProvider,
  type SecretRegistry,
} from './secrets.ts'
import { redactor } from './redact.ts'

export const DEFAULT_CONFIG_PATH = 'jml.config.yaml'
const CONFIG_DOCS = 'docs/config-reference.md'

export interface ConfigIssue {
  path: string
  message: string
  docsAnchor: string
}

export class ConfigError extends Error {
  readonly code = 'invalid_configuration'
  readonly issues: ConfigIssue[]

  constructor(issues: ConfigIssue[]) {
    super(
      'invalid configuration:\n' +
        issues.map((i) => '  - ' + (i.path || '(root)') + ': ' + i.message + '\n    see ' + i.docsAnchor).join('\n'),
    )
    this.name = 'ConfigError'
    this.issues = issues
  }
}

export interface LoadedConfig {
  config: JmlConfig
  /** Every resolved credential, addressed by its dotted config path. */
  secrets: SecretRegistry
  /** Where the document was read from, for `jml config show`. */
  source: string
}

export interface LoadOptions {
  path?: string
  env?: NodeJS.ProcessEnv
  providers?: SecretProvider[]
  /**
   * Parse and validate without resolving credentials. `jml generate` and the
   * config tests use it. Nothing that talks to a provider may set it.
   */
  allowMissingSecrets?: boolean
  /** Pre-read document, for tests and for the Phase 3 installer. */
  document?: unknown
}

/**
 * Environment variables that belong to a leg this phase ships as an interface
 * only. Their presence means somebody has configured something that cannot
 * run, so start-up says so rather than leaving them to look effective.
 */
const INERT_LEG_ENV: Record<string, string> = {
  AZURE_CLIENT_SECRET: 'legs.azure',
  SLACK_SCIM_TOKEN: 'legs.slackScim',
}

export async function loadConfig(opts: LoadOptions = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env
  const source = opts.path ?? env.JML_CONFIG ?? DEFAULT_CONFIG_PATH

  let document: unknown
  if (opts.document !== undefined) {
    document = opts.document
  } else {
    let text: string
    try {
      text = await readFile(source, 'utf8')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new ConfigError([
        { path: '', message: 'could not read ' + source + ': ' + reason + '. `jml init` writes a starting file.', docsAnchor: CONFIG_DOCS },
      ])
    }
    try {
      document = parseYaml(text)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new ConfigError([{ path: '', message: 'could not parse ' + source + ' as YAML: ' + reason, docsAnchor: CONFIG_DOCS }])
    }
  }

  const expanded = expandEnvReferences(document, env)
  const parsed = ConfigSchema.safeParse(expanded)
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => describeIssue(issue.path.join('.'), issue.message)))
  }

  const config = parsed.data
  const inert = Object.entries(INERT_LEG_ENV).filter(([name]) => (env[name] ?? '').trim() !== '')
  if (inert.length > 0) {
    throw new ConfigError(
      inert.map(([name, leg]) => ({
        path: leg,
        message:
          name +
          ' is set, but ' +
          leg +
          ' ships as an interface only in this release, so nothing reads it. Unset the variable so it is clear that step is not happening.',
        docsAnchor: CONFIG_DOCS + '#reserved-legs',
      })),
    )
  }

  const secretPaths = collectSecretFields(config)
  const resolved = new Map<string, SecretHandle>()
  if (!opts.allowMissingSecrets) {
    const providers = opts.providers ?? defaultProviders(env)
    const failures: ConfigIssue[] = []
    for (const field of secretPaths) {
      try {
        resolved.set(field.path, await resolveSecret(field.value, providers))
      } catch (err) {
        const message = err instanceof SecretResolutionError ? err.message : err instanceof Error ? err.message : String(err)
        failures.push({ path: field.path, message, docsAnchor: SECRETS_DOCS_ANCHOR })
      }
    }
    if (failures.length > 0) throw new ConfigError(failures)
  }

  return { config, secrets: createSecretRegistry(resolved), source }
}

/**
 * Fields whose value is a message template, not configuration.
 *
 * The auto-reply subject and body are rendered per person with their own
 * placeholder set (displayName, orgName, managerName, managerEmail), and that
 * set uses the same `${name}` spelling as an environment reference. Expanding
 * them here made a freshly generated configuration unloadable: `jml init`
 * writes the documented default, and the very next command refused it because
 * `displayName` is not an environment variable. Worse than the error is the
 * repair somebody reaches for first, which is to set displayName in the
 * environment, freezing one leaver's name into every future auto-reply.
 *
 * These paths are therefore left verbatim for the renderer. A credential can
 * never hide behind this exemption: neither path is a secret field, both are
 * asserted against SECRET_PATHS by a test, and the schema refuses a literal
 * credential in a secret field anyway.
 */
export const TEMPLATE_PATHS: readonly string[] = ['leaver.autoReply.subject', 'leaver.autoReply.bodyHtml']

/**
 * `${NAME}` in any string becomes the value of that environment variable.
 *
 * An unset name is an error rather than an empty string. The alternative
 * silently produced a config where, for example, a domain was blank, and a
 * blank domain matches nothing rather than failing.
 *
 * The exception is TEMPLATE_PATHS, where `${name}` belongs to the message
 * renderer rather than to the environment.
 */
export function expandEnvReferences(value: unknown, env: NodeJS.ProcessEnv, path: string[] = []): unknown {
  if (typeof value === 'string') {
    if (TEMPLATE_PATHS.includes(path.join('.'))) return value
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const found = env[name]
      if (found === undefined) {
        throw new ConfigError([
          {
            path: path.join('.'),
            message: 'references ${' + name + '} but that environment variable is not set',
            docsAnchor: CONFIG_DOCS + '#environment-references',
          },
        ])
      }
      return found
    })
  }
  if (Array.isArray(value)) return value.map((item, i) => expandEnvReferences(item, env, [...path, String(i)]))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvReferences(v, env, [...path, k])
    }
    return out
  }
  return value
}

/**
 * The secret fields present in this configuration, with their references.
 *
 * A field absent from the document (an optional notifier, the store adapter
 * that is not in use) yields nothing to resolve.
 */
export function collectSecretFields(config: JmlConfig): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  for (const path of SECRET_PATHS) {
    if (inactiveAdapterSecret(config, path)) continue
    const value = readPath(config, path)
    if (typeof value === 'string') out.push({ path, value })
  }
  return out
}

/**
 * A secret belonging to an adapter that is not selected is not resolved.
 *
 * The generated configuration carries every adapter's block, so an HR system
 * read from a file still had a HiBob block holding env references, and
 * start-up refused because HIBOB_SERVICE_USER_ID was unset. Somebody adapting
 * this to another HR system hit that before anything else. A credential for
 * an adapter that will never be built is not needed, and resolving it would
 * only make somebody put a real key where nothing reads it.
 */
function inactiveAdapterSecret(config: JmlConfig, path: string): boolean {
  if (path.startsWith('hris.hibob.')) return config.hris.adapter !== 'hibob'
  if (path.startsWith('ticketing.suptask.')) return config.ticketing.adapter !== 'suptask'
  return false
}

/**
 * The secret fields, as dotted paths.
 *
 * This list is asserted against the schema by a unit test that walks the zod
 * tree looking for the `!` metadata marker, so a new secret field cannot be
 * added to the schema without appearing here.
 */
export const SECRET_PATHS: readonly string[] = [
  'ticketing.suptask.apiToken',
  'hris.hibob.serviceUserId',
  'hris.hibob.serviceToken',
  'store.token',
  'identity.jumpcloud.apiKey',
  'google.serviceAccountJson',
  'devices.fleet.token',
  'notify.slack.botToken',
  'audit.salt',
  'audit.loki.authHeader',
  'liveness.healthchecksPingUrl',
  'server.token',
]

function readPath(root: unknown, path: string): unknown {
  let cursor: unknown = root
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Turn one schema issue into something an operator can act on.
 *
 * A PATTERN failure on a secret field gets its own wording, because the
 * schema's message describes a regular expression and the operator needs to be
 * told what they actually did: they wrote a credential into a file that gets
 * backed up, pasted and eventually committed. The message deliberately does
 * not echo the offending value, so an error about a misplaced credential does
 * not become a second copy of it.
 *
 * Only the pattern failure is rewritten. Rewriting every issue on a secret
 * path replaced unrelated advice with an accusation: a missing audit salt was
 * reported as a pasted credential, which sends the reader hunting for a leak
 * that is not there while hiding the one sentence that would have fixed it.
 */
function describeIssue(path: string, message: string): ConfigIssue {
  if (SECRET_PATHS.includes(path) && message === SECRET_MESSAGE) {
    return {
      path,
      message:
        'holds a literal value where a secret reference is required. Use env:NAME, file:/path or op://<vault>/<item>/<field>.',
      docsAnchor: SECRETS_DOCS_ANCHOR,
    }
  }
  return { path, message, docsAnchor: anchorFor(path) }
}

/**
 * Every key is documented in one generated table, so every non-secret issue
 * points at that table rather than at a per-key heading. A generated anchor
 * per key would read well and link nowhere, which is worse than a section
 * link: an operator following it finds nothing and stops following them.
 */
function anchorFor(path: string): string {
  return path ? CONFIG_DOCS + '#keys' : CONFIG_DOCS
}

/**
 * What `jml config show` prints: shape, references and lengths, never a value.
 *
 * Built by redacting a structural copy, so even a credential that reached the
 * config object by some route this function does not know about is masked.
 */
export function describeConfig(loaded: LoadedConfig): Record<string, unknown> {
  return redactor.redactDeep({
    source: loaded.source,
    version: loaded.config.version,
    mode: loaded.config.mode,
    armedActions: loaded.config.armedActions,
    org: { ...loaded.config.org },
    hris: { adapter: loaded.config.hris.adapter, minPlausibleHeadcount: loaded.config.hris.minPlausibleHeadcount },
    store: { adapter: loaded.config.store.adapter },
    notify: { adapters: loaded.config.notify.adapters, weeklyReraiseDay: loaded.config.notify.weeklyReraiseDay },
    leaver: {
      transferDay: loaded.config.leaver.transferDay,
      deleteDay: loaded.config.leaver.deleteDay,
      terminationLookbackDays: loaded.config.leaver.terminationLookbackDays,
      maxDay0PerRun: loaded.config.leaver.maxDay0PerRun,
      requireOperatorAck: loaded.config.leaver.requireOperatorAck,
    },
    secrets: loaded.secrets.describe(),
  })
}
