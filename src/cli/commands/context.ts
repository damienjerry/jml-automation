/**
 * Building everything a command needs from one configuration file.
 *
 * Every credential is resolved here, at start-up, before a command runs. That
 * is deliberate: a credential resolved lazily inside a step turns a missing
 * secret into a step that quietly does nothing, and the run still reports
 * success. Resolving up front means a missing credential stops the command
 * with a message naming the reference that failed.
 *
 * The provider half is optional because several commands never talk to a
 * provider. `jml store verify` and `jml audit verify` must work on a machine
 * that holds no keys at all, so asking for them is a per-command decision
 * rather than a property of loading the config.
 */

import { SuptaskAdapter } from '../../ticketing/suptask/adapter.ts'
import type { TicketingAdapter } from '../../ticketing/types.ts'
import { dirname, join } from 'node:path'
import { createFanoutAuditSink } from '../../audit/fanout.ts'
import { createJsonlAuditSink } from '../../audit/jsonl.ts'
import { createLokiAuditSink } from '../../audit/loki.ts'
import type { AuditSink } from '../../audit/types.ts'
import { loadConfig, type LoadedConfig } from '../../config/load.ts'
import type { JmlConfig } from '../../config/schema.ts'
import type { SecretRegistry } from '../../config/secrets.ts'
import { SystemClock, type Clock } from '../../core/clock.ts'
import { createDomainMap, type DomainMap } from '../../core/domain.ts'
import { createHttpClient, type HttpClient } from '../../core/http.ts'
import { createLogger, type Logger, type LogLevel } from '../../core/logger.ts'
import { createGoogleConnector, type GoogleConnector } from '../../connectors/google/index.ts'
import { JumpCloudClient } from '../../connectors/jumpcloud/client.ts'
import { JumpCloudCommands } from '../../connectors/jumpcloud/commands.ts'
import { JumpCloudDevices } from '../../connectors/jumpcloud/devices.ts'
import { JumpCloudUsers } from '../../connectors/jumpcloud/users.ts'
import type { CommandTargeting, IdentityConnector, IdentityActivationConnector } from '../../connectors/types.ts'
import type { DeviceOps } from '../../engine/device/preflight.ts'
import { HiBobAdapter } from '../../hris/hibob/adapter.ts'
import { FixtureHrisAdapter } from '../../hris/fixture.ts'
import type { HrisAdapter } from '../../hris/types.ts'
import { createConsoleNotifier } from '../../notify/console.ts'
import { createEmailNotifier } from '../../notify/email.ts'
import { createFanoutNotifier } from '../../notify/fanout.ts'
import { createSlackNotifier } from '../../notify/slack.ts'
import type { Notifier } from '../../notify/types.ts'
import { MemoryPeopleStore } from '../../store/memory/store.ts'
import { SqlitePeopleStore } from '../../store/sqlite/store.ts'
import { SqliteStateStore } from '../../store/state-sqlite.ts'
import type { PeopleStore, StateStore } from '../../store/types.ts'

/**
 * A failure with an exit code and somewhere to read about it.
 *
 * Thrown rather than printed at the point of failure so that one place in the
 * CLI decides how a failure is rendered, and so the same error can be turned
 * into an HTTP status by the sidecar without being reformatted.
 */
export class CliError extends Error {
  readonly exitCode: number
  readonly docsAnchor: string | null

  constructor(message: string, opts: { exitCode?: number; docsAnchor?: string } = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = opts.exitCode ?? 1
    this.docsAnchor = opts.docsAnchor ?? null
  }
}

/** Where the CLI writes. Injected so a test reads output instead of a terminal. */
export interface CliIo {
  out(text: string): void
  err(text: string): void
  env: NodeJS.ProcessEnv
  cwd: string
}

/** The provider surface, present only when a command asked for it. */
export interface Providers {
  idp: IdentityConnector & IdentityActivationConnector
  devices: DeviceOps
  google: GoogleConnector
  commands: CommandTargeting
}

export interface Runtime {
  cfg: JmlConfig
  secrets: SecretRegistry
  /** The file the configuration was read from, for `jml config show`. */
  source: string
  store: PeopleStore
  state: StateStore
  audit: AuditSink
  notifier: Notifier
  hris: HrisAdapter
  clock: Clock
  logger: Logger
  domain: DomainMap
  http: HttpClient
  providers: Providers | null
  ticketing: TicketingAdapter | null
  close(): Promise<void>
}

export interface OpenRuntimeOptions {
  io: CliIo
  configPath?: string
  /** Build the identity, device and Google connectors. Needs their credentials. */
  withProviders?: boolean
  /** Parse and open the stores without resolving any credential. */
  allowMissingSecrets?: boolean
  logLevel?: LogLevel
  clock?: Clock
}

export async function openRuntime(opts: OpenRuntimeOptions): Promise<Runtime> {
  const loaded = await loadConfig({
    ...(opts.configPath ? { path: opts.configPath } : {}),
    env: opts.io.env,
    ...(opts.allowMissingSecrets ? { allowMissingSecrets: true } : {}),
  })
  return openRuntimeFrom(loaded, opts)
}

/** The half that needs no file, so the demo can supply its own document. */
export async function openRuntimeFrom(loaded: LoadedConfig, opts: OpenRuntimeOptions): Promise<Runtime> {
  const cfg = loaded.config
  const clock = opts.clock ?? new SystemClock()
  const logger = createLogger({
    ...(opts.logLevel ? { level: opts.logLevel } : {}),
    pretty: true,
    // Log lines go to stderr so that stdout carries only the command's own
    // output. A caller piping a report into another tool must not have to
    // filter our diagnostics out of it.
    write: (line) => opts.io.err(line + '\n'),
    clock,
  })
  const domain = createDomainMap({ primaryDomain: cfg.org.primaryDomain, aliasDomains: cfg.org.aliasDomains })
  const http = createHttpClient()

  const store = buildStore(cfg, clock)
  await store.init()
  const state = new SqliteStateStore({ path: statePath(cfg), clock })
  await state.init()

  const audit = buildAudit(cfg, loaded.secrets, clock, http)
  const providers = opts.withProviders ? buildProviders(cfg, loaded.secrets, http) : null
  const notifier = buildNotifier(cfg, loaded.secrets, http, providers, opts.io)
  const ticketing = buildTicketing(cfg, loaded.secrets, http)

  return {
    cfg,
    secrets: loaded.secrets,
    source: loaded.source,
    store,
    state,
    audit,
    notifier,
    hris: buildHris(cfg, loaded.secrets, http),
    clock,
    logger,
    domain,
    http,
    providers,
    ticketing,
    async close() {
      // The audit sink is closed first and its failure is not swallowed: an
      // unflushed row is a step nobody can prove happened.
      if (audit.close) await audit.close()
      await state.close()
      await store.close()
    },
  }
}

function buildStore(cfg: JmlConfig, clock: Clock): PeopleStore {
  if (cfg.store.adapter === 'sqlite') return new SqlitePeopleStore({ path: cfg.store.path, clock })
  if (cfg.store.adapter === 'memory') return new MemoryPeopleStore({ clock })
  throw new CliError(
    `store.adapter is "${cfg.store.adapter}", which this release ships as an interface only. ` +
      `Use the sqlite store, or the memory store for a rehearsal.`,
    { exitCode: 78, docsAnchor: 'docs/config-reference.md#keys' },
  )
}

/**
 * Where the toolkit's own bookkeeping lives.
 *
 * Always local SQLite, whatever the people store is, because a lease that
 * lives in a remote document with no transactions is not a lease. It sits
 * beside the people database so a backup of one directory catches both.
 */
export function statePath(cfg: JmlConfig): string {
  if (cfg.store.adapter === 'sqlite') return join(dirname(cfg.store.path), 'jml-state.sqlite')
  if (cfg.store.adapter === 'memory') return ':memory:'
  return join('data', 'jml-state.sqlite')
}

function buildAudit(cfg: JmlConfig, secrets: SecretRegistry, clock: Clock, http: HttpClient): AuditSink {
  // The salt is read out of the registry rather than off the config object,
  // which holds the reference and not the value. Without this the sink was
  // built with neither flag, so `audit.minimisePii` was true in every shipped
  // configuration and did nothing: the documentation said addresses were
  // stored as a salted hash and the log held them in clear, permanently,
  // because the log is append-only.
  const salt = secrets.has('audit.salt') ? secrets.get('audit.salt').use((value) => value) : null
  const primary = createJsonlAuditSink({
    dir: cfg.audit.jsonl.dir,
    today: () => clock.today(cfg.org.timezone),
    minimisePii: cfg.audit.minimisePii,
    salt,
  })
  if (!cfg.audit.loki.enabled || !cfg.audit.loki.url) return primary
  const secondary = createLokiAuditSink({
    baseUrl: cfg.audit.loki.url,
    http,
    ...(secrets.has('audit.loki.authHeader')
      ? { auth: { kind: 'bearer' as const, secret: secrets.get('audit.loki.authHeader') } }
      : {}),
  })
  // The local file stays primary. A remote sink that went first could hold a
  // row for a step the local write then refused, which is worse than a missing
  // row: it is a false record.
  return createFanoutAuditSink({ primary, secondary: [secondary] })
}

function buildHris(cfg: JmlConfig, secrets: SecretRegistry, http: HttpClient): HrisAdapter {
  if (cfg.hris.adapter === 'fixture') {
    return new FixtureHrisAdapter({
      path: cfg.hris.fixture?.path ?? '',
      minPlausibleHeadcount: cfg.hris.minPlausibleHeadcount,
    })
  }
  const hibob = cfg.hris.hibob
  if (!hibob) {
    throw new CliError('hris.adapter is hibob but hris.hibob is missing', {
      exitCode: 78,
      docsAnchor: 'docs/config-reference.md#keys',
    })
  }
  return new HiBobAdapter({
    http,
    serviceUserId: secrets.get('hris.hibob.serviceUserId'),
    serviceToken: secrets.get('hris.hibob.serviceToken'),
    baseUrl: hibob.baseUrl,
    pageSize: hibob.pageSize,
    minPlausibleHeadcount: cfg.hris.minPlausibleHeadcount,
    fields: hibob.fields,
  })
}

function buildProviders(cfg: JmlConfig, secrets: SecretRegistry, http: HttpClient): Providers {
  const client = new JumpCloudClient({
    http,
    apiKey: secrets.get('identity.jumpcloud.apiKey'),
    baseUrl: cfg.identity.jumpcloud.baseUrl,
  })
  return {
    idp: new JumpCloudUsers(client),
    devices: new JumpCloudDevices(client),
    commands: new JumpCloudCommands({ client, pollMs: cfg.devices.receipt.pollMs }),
    google: createGoogleConnector(
      {
        serviceAccountJson: secrets.get('google.serviceAccountJson'),
        adminEmail: cfg.google.adminEmail,
        senderMailbox: cfg.mail.senderMailbox,
        bcc: cfg.mail.bcc,
        customer: cfg.google.customer,
        licenceProductIds: cfg.google.licenceProductIds,
        transferPrivacyLevels: cfg.google.driveTransfer.privacyLevels,
      },
      { http },
    ),
  }
}

/**
 * Route notifications to the audiences they are for.
 *
 * The manager route is mail only, and it is deliberately left empty when no
 * mail notifier is configured. The fan-out then sends the note to the IT route
 * and reports it as undelivered, which is the honest answer: the person it was
 * for was not told.
 */
function buildNotifier(
  cfg: JmlConfig,
  secrets: SecretRegistry,
  http: HttpClient,
  providers: Providers | null,
  io: CliIo,
): Notifier {
  const it: Notifier[] = []
  const manager: Notifier[] = []

  for (const adapter of cfg.notify.adapters) {
    if (adapter === 'console') {
      it.push(createConsoleNotifier({ write: (text) => io.out(text) }))
      continue
    }
    if (adapter === 'slack') {
      if (!cfg.notify.slack.itChannelId || !secrets.has('notify.slack.botToken')) continue
      it.push(
        createSlackNotifier({
          botToken: secrets.get('notify.slack.botToken'),
          itChannelId: cfg.notify.slack.itChannelId,
          http,
        }),
      )
      continue
    }
    if (adapter === 'email') {
      if (!providers || !cfg.notify.email.itMailbox) continue
      const mail = createEmailNotifier({ google: providers.google, itRecipients: [cfg.notify.email.itMailbox] })
      it.push(mail)
      manager.push(mail)
    }
  }

  return createFanoutNotifier({ it, manager })
}

/**
 * The ticketing adapter, or null when none is configured.
 *
 * Built even when the runtime has no providers: the inbound bridge only needs
 * the store and the adapter, and a dry-run pipeline still nudges managers.
 */
function buildTicketing(cfg: JmlConfig, secrets: SecretRegistry, http: HttpClient): TicketingAdapter | null {
  if (cfg.ticketing.adapter !== 'suptask') return null
  const st = cfg.ticketing.suptask
  if (!secrets.has('ticketing.suptask.apiToken') || !st.queueId || !st.requesterId) {
    throw new CliError('ticketing.adapter is suptask, so ticketing.suptask.apiToken, queueId and requesterId are required', {
      exitCode: 78,
      docsAnchor: 'docs/credentials.md#ticketing',
    })
  }
  return new SuptaskAdapter({
    http,
    apiToken: secrets.get('ticketing.suptask.apiToken'),
    baseUrl: st.baseUrl,
    queueId: st.queueId,
    requesterId: st.requesterId,
    starterFormId: st.starterFormId || null,
    leaverFormId: st.leaverFormId || null,
  })
}
