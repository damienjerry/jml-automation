/**
 * A runnable joiner engine over the fakes, for the regression tests.
 *
 * The configuration arms every joiner action, so a test that wants a leg
 * not to run says so explicitly rather than inheriting a default.
 */
import { FakeClock } from '../../src/core/clock.ts'
import { createDomainMap } from '../../src/core/domain.ts'
import { nullLogger } from '../../src/core/logger.ts'
import type { Person } from '../../src/core/types.ts'
import { createFakeProviders, type FakeProvidersSeed } from '../../src/connectors/fake.ts'
import { loadConfig } from '../../src/config/load.ts'
import type { JmlConfig } from '../../src/config/schema.ts'
import { runJoinerEngine, type JoinerDeps, type JoinerRunOptions } from '../../src/engine/joiner/engine.ts'
import { MemoryPeopleStore } from '../../src/store/memory/store.ts'
import type { AuditEvent, AuditSink } from '../../src/audit/types.ts'
import type { Notification, NotificationResult, Notifier } from '../../src/notify/types.ts'
import { fakeStateStore } from '../unit/fake-state-store.ts'
import { FakeTicketing } from './fake-ticketing.ts'
import type { TicketingDeps } from '../../src/engine/ticketing/index.ts'
import { storedPerson } from './sync-harness.ts'

export const TODAY = '2026-01-28'

export function starter(overrides: Partial<Person> = {}): Person {
  return storedPerson({
    hrisId: 'hr-starter',
    displayName: 'John Doe',
    firstName: 'John',
    primaryEmail: 'john.doe@example.com',
    personalEmail: 'john.doe.home@example.net',
    managerEmail: 'jane.doe@example.com',
    status: 'hired',
    startDate: '2026-02-02',
    inScope: true,
    ...overrides,
  })
}

export const STAGED_SEED: FakeProvidersSeed = {
  idp: [{ id: 'idp-starter', email: 'john.doe@example.com', activated: false }],
  google: [{ id: 'goog-starter', email: 'john.doe@example.com', licences: [], mailboxReady: false, mailboxReadyAfterReads: 1, orgUnitPath: '/' }],
}

export interface JoinerHarness {
  deps: JoinerDeps
  ticketing: FakeTicketing
  ticketingDeps: TicketingDeps
  store: MemoryPeopleStore
  providers: ReturnType<typeof createFakeProviders>
  sent: Notification[]
  audit: AuditEvent[]
  run(opts?: Partial<JoinerRunOptions>): ReturnType<typeof runJoinerEngine>
}

export interface HarnessOptions {
  people?: Person[]
  seed?: FakeProvidersSeed
  config?: Record<string, unknown>
  deliver?: (n: Notification) => boolean
}

export async function joinerHarness(options: HarnessOptions = {}): Promise<JoinerHarness> {
  const cfg = await demoConfig(options.config ?? {})
  const store = new MemoryPeopleStore({ seed: options.people ?? [starter()] })
  await store.init()
  const providers = createFakeProviders(options.seed ?? STAGED_SEED)
  const sent: Notification[] = []
  const audit: AuditEvent[] = []
  const notifier: Notifier = {
    name: 'recording',
    async send(n): Promise<NotificationResult> {
      sent.push(n)
      const ok = options.deliver ? options.deliver(n) : true
      return ok ? { delivered: true, channel: 'recording' } : { delivered: false, channel: 'recording', error: 'refused by test' }
    },
    async testConnection() {
      return { ok: true, detail: 'test double' }
    },
  }
  const sink: AuditSink = {
    name: 'memory',
    async append(event) {
      audit.push(event)
      return { seq: audit.length }
    },
  }
  const deps: JoinerDeps = {
    cfg,
    store,
    state: fakeStateStore(),
    idp: providers.identity,
    devices: providers.devices,
    google: providers.google,
    notifier,
    audit: sink,
    clock: new FakeClock(`${TODAY}T09:00:00.000Z`),
    logger: nullLogger(),
    domain: createDomainMap({ primaryDomain: 'example.com', aliasDomains: [] }),
    sleep: async () => undefined,
    passwordGenerator: () => 'TEST-ONLY-NOT-A-PASSWORD',
  }
  const ticketing = new FakeTicketing()
  return {
    deps,
    ticketing,
    ticketingDeps: { ...deps, ticketing },
    store,
    providers,
    sent,
    audit,
    run: (opts = {}) => runJoinerEngine(deps, { dryRun: false, actor: { kind: 'system', id: 'system:test' }, runId: 'test-run', ...opts }),
  }
}

async function demoConfig(overrides: Record<string, unknown>): Promise<JmlConfig> {
  const doc: Record<string, unknown> = {
    version: 1,
    org: { name: 'Example Organisation', primaryDomain: 'example.com', timezone: 'Europe/London', itTeamSignature: 'The IT team' },
    mode: 'armed',
    armedActions: ['activate', 'joiner_licence', 'ou_move', 'welcome'],
    mail: { senderMailbox: 'it-noreply@example.com', managerOnDay0: true },
    hris: { adapter: 'fixture', minPlausibleHeadcount: 1, fixture: { path: 'unused.json' } },
    store: { adapter: 'memory' },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY' } },
    google: { serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', adminEmail: 'admin@example.com' },
    joiner: {
      leadWorkingDays: 3,
      targetOrgUnitPath: '/Managed users',
      licence: { productId: 'Example-Product', skuId: 'example-standard' },
      mailboxPoll: { tries: 3, intervalMs: 0 },
      itSupportEmail: 'it-support@example.com',
    },
    notify: { adapters: ['console'] },
    audit: { minimisePii: false },
    server: { token: 'env:JML_API_TOKEN' },
    ...overrides,
  }
  const loaded = await loadConfig({ document: doc, env: {}, allowMissingSecrets: true })
  return loaded.config
}
