/**
 * The wiring the leaver-engine tests share.
 *
 * Everything is real except the providers and the clock: a real people store
 * with its real write guards, the real change gate over a real state store,
 * real templates. That matters because most of the rules being tested are
 * enforced by the store or by the gate rather than by the engine, and a test
 * against fakes of those would pass while production refused the write.
 */

import { ConfigSchema, type JmlConfig } from '../../../src/config/schema.ts'
import type { AuditEvent, AuditRef, AuditSink } from '../../../src/audit/types.ts'
import { FakeClock } from '../../../src/core/clock.ts'
import { createDomainMap } from '../../../src/core/domain.ts'
import { nullLogger } from '../../../src/core/logger.ts'
import type { Person } from '../../../src/core/types.ts'
import { createFakeProviders, type FakeProviders, type FakeProvidersSeed } from '../../../src/connectors/fake.ts'
import type { Notification, NotificationResult, Notifier } from '../../../src/notify/types.ts'
import { MemoryPeopleStore } from '../../../src/store/memory/store.ts'
import type { HrisAdapter, HrisSnapshot } from '../../../src/hris/types.ts'
import type { LeaverDeps } from '../../../src/engine/leaver/legs.ts'
import { fakeStateStore, type FakeStateStore } from '../../unit/fake-state-store.ts'

export const LEAVER_ID = 'hris-0001'
export const LEAVER_EMAIL = 'jane.doe@example.com'
export const MANAGER_EMAIL = 'john.doe@example.com'
export const IDP_USER_ID = 'usr-leaver-1'
export const GOOGLE_USER_ID = 'goog-leaver-1'
export const DEVICE_ID = 'sys-laptop-1'
export const SKU = 'sku-standard'
export const PRODUCT = 'Example-Product'

/**
 * Fixed instant, so every date in a test is deliberate.
 *
 * A Tuesday, deliberately: the change gate re-raises a standing problem once
 * on its configured weekday, so a test about "announced once" would otherwise
 * be measuring the re-raise as well.
 */
export const NOW = '2026-03-03T09:00:00.000Z'
export const TODAY = '2026-03-03'
/** The following Monday, for the weekly re-raise. */
export const NEXT_RERAISE_DAY = '2026-03-09'

/** Every action armed. Individual tests narrow it. */
export const ALL_ACTIONS = ['suspend', 'autoreply', 'licence', 'transfer', 'google_suspend', 'delete'] as const

export function leaverConfig(overrides: Record<string, unknown> = {}, armed: readonly string[] | boolean = false): JmlConfig {
  const armedActions = armed === true ? [...ALL_ACTIONS] : armed === false ? [] : [...armed]
  return ConfigSchema.parse({
    version: 1,
    org: { name: 'Example Organisation', primaryDomain: 'example.com', timezone: 'Europe/London', itTeamSignature: 'IT Team' },
    mode: armedActions.length > 0 ? 'armed' : 'dry-run',
    armedActions,
    mail: { senderMailbox: 'it-noreply@example.com' },
    hris: { adapter: 'fixture', minPlausibleHeadcount: 3, fixture: { path: './src/cli/fixtures/demo.json' } },
    store: { adapter: 'memory' },
    audit: { minimisePii: false },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY' } },
    google: {
      serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON',
      adminEmail: 'admin@example.com',
      licenceProductIds: [PRODUCT],
    },
    server: { token: 'env:JML_API_TOKEN' },
    ...overrides,
  })
}

export class MemoryAuditSink implements AuditSink {
  readonly name = 'memory'
  readonly events: AuditEvent[] = []
  private seq = 0
  private readonly failOn: ((event: AuditEvent) => boolean) | null

  constructor(failOn: ((event: AuditEvent) => boolean) | null = null) {
    this.failOn = failOn
  }

  async append(event: AuditEvent): Promise<AuditRef> {
    if (this.failOn?.(event)) {
      const err = new Error(`the audit sink refused a ${event.phase} row for ${event.action}`) as Error & { code: string }
      err.code = 'audit_unavailable'
      throw err
    }
    this.events.push(event)
    this.seq += 1
    return { seq: this.seq }
  }

  /** `phase action` in the order recorded, which is what an ordering test needs. */
  trail(): string[] {
    return this.events.map((e) => `${e.phase} ${e.action}`)
  }

  actions(): string[] {
    return [...new Set(this.events.map((e) => e.action))]
  }
}

export class CapturingNotifier implements Notifier {
  readonly name = 'capturing'
  readonly sent: Notification[] = []
  private readonly delivered: boolean

  constructor(delivered = true) {
    this.delivered = delivered
  }

  async send(n: Notification): Promise<NotificationResult> {
    this.sent.push(n)
    // A chat API answering 200 with a failure in the body is the shape this
    // false case reproduces.
    return this.delivered ? { delivered: true, channel: 'capturing' } : { delivered: false, channel: 'capturing', error: 'ok:false' }
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'captures notifications in memory' }
  }

  kinds(): string[] {
    return this.sent.map((n) => n.kind)
  }

  bodies(): string {
    return this.sent.map((n) => `${n.subject}\n${n.body}`).join('\n---\n')
  }
}

export function personFixture(overrides: Partial<Person> = {}): Person {
  return {
    hrisId: LEAVER_ID,
    status: 'terminated',
    primaryEmail: LEAVER_EMAIL,
    aliasEmails: [],
    displayName: 'Jane Doe',
    managerEmail: MANAGER_EMAIL,
    terminationDate: TODAY,
    hold: false,
    externalIds: { jumpcloudUserId: IDP_USER_ID },
    googleAccountPresent: true,
    offboarding: { suspendedAt: null, legs: {} },
    ...overrides,
  }
}

/** A person already through day 0, ready for the later phases. */
export function suspendedPersonFixture(suspendedAt: string, overrides: Partial<Person> = {}): Person {
  return personFixture({
    status: 'offboarding',
    offboarding: {
      suspendedAt,
      legs: {
        suspend_idp: { state: 'done', verified: true, attempts: 1, at: `${suspendedAt}T09:00:00.000Z` },
      },
      transferredAt: null,
      ...(overrides.offboarding ?? {}),
    },
    ...overrides,
  })
}

export function defaultSeed(): FakeProvidersSeed {
  return {
    idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL, displayName: 'Jane Doe', devices: [] }],
    google: [{ id: GOOGLE_USER_ID, email: LEAVER_EMAIL, licences: [{ productId: PRODUCT, skuId: SKU }] }],
    devices: [{ id: DEVICE_ID, displayName: 'Field laptop 1', osFamily: 'windows', serial: 'SERIAL0001' }],
  }
}

export interface HarnessOptions {
  people?: readonly Person[]
  seed?: FakeProvidersSeed
  config?: Record<string, unknown>
  armed?: readonly string[] | boolean
  notifier?: CapturingNotifier
  audit?: MemoryAuditSink
}

export interface LeaverHarness {
  deps: LeaverDeps
  store: MemoryPeopleStore
  state: FakeStateStore
  providers: FakeProviders
  audit: MemoryAuditSink
  notifier: CapturingNotifier
  clock: FakeClock
  /** Every provider call, in order. */
  calls: string[]
  /** How long the hand-over poll was asked to wait. */
  slept: number[]
}

export function harness(opts: HarnessOptions = {}): LeaverHarness {
  const store = new MemoryPeopleStore({ seed: opts.people ?? [personFixture()] })
  const state = fakeStateStore()
  const providers = createFakeProviders(opts.seed ?? defaultSeed())
  const audit = opts.audit ?? new MemoryAuditSink()
  const notifier = opts.notifier ?? new CapturingNotifier()
  const clock = new FakeClock(NOW)
  const slept: number[] = []

  const deps: LeaverDeps = {
    cfg: leaverConfig(opts.config ?? {}, opts.armed ?? false),
    store,
    state,
    idp: providers.identity,
    devices: providers.devices,
    google: providers.google,
    notifier,
    audit,
    clock,
    logger: nullLogger(),
    domain: createDomainMap({ primaryDomain: 'example.com' }),
    // No real waiting: the poll budget is asserted through this list instead.
    sleep: async (ms: number) => {
      slept.push(ms)
    },
  }
  return { deps, store, state, providers, audit, notifier, clock, calls: providers.calls, slept }
}

/** A one-person HR snapshot, for the pipeline tests. */
export function fixtureHris(people: readonly Person[], employed: readonly string[] = []): HrisAdapter {
  const snapshot: HrisSnapshot = {
    all: people.map((p) => ({
      hrisId: p.hrisId,
      primaryEmail: p.primaryEmail,
      displayName: p.displayName,
      terminationDate: p.terminationDate ?? null,
      managerEmail: p.managerEmail ?? null,
    })),
    activeIds: new Set(employed),
    fetchedAt: NOW,
    complete: true,
  }
  return {
    name: 'fixture',
    fetchAll: async () => snapshot,
    testConnection: async () => ({ ok: true, detail: 'fixture' }),
  }
}
