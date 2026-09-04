/**
 * Fakes for the device disposition package.
 *
 * The device state is real state rather than a scripted sequence: an unbind
 * really removes the binding, a delete really removes the record, and a read
 * back afterwards sees what the write did. Tests about read-backs are only
 * worth anything if the fake cannot accidentally agree with code that never
 * wrote anything.
 */

import { ConfigSchema, type JmlConfig } from '../../../src/config/schema.ts'
import type { AuditEvent, AuditRef, AuditSink } from '../../../src/audit/types.ts'
import { FakeClock } from '../../../src/core/clock.ts'
import type { BoundDevice, Outcome, Person } from '../../../src/core/types.ts'
import { GateError, type CommandReceipt, type CommandTargeting } from '../../../src/connectors/types.ts'
import type { Notification, NotificationResult, Notifier } from '../../../src/notify/types.ts'
import type {
  DeviceDeps,
  DeviceOps,
  DispositionRequest,
  ScriptManifest,
} from '../../../src/engine/device/preflight.ts'

export const SYSTEM_ID = 'sys-laptop-1'
export const LEAVER_USER_ID = 'user-leaver-1'
export const POOL_USER_ID = 'user-spares-1'
export const NEW_OWNER_USER_ID = 'user-newowner-1'
export const COMMAND_ID = 'cmd-uninstall-1'
export const WINDOWS_TRIGGER = 'uninstallagentswindows'
export const POOL_EMAIL = 'it.spares@example.com'
export const NEW_OWNER_EMAIL = 'john.doe@example.com'

export function deviceFixture(overrides: Partial<BoundDevice> = {}): BoundDevice {
  return {
    id: SYSTEM_ID,
    displayName: 'Field laptop 1',
    osFamily: 'windows',
    serial: 'SERIAL0001',
    lastContact: '2026-03-02T08:55:00.000Z',
    fdeKeyPresent: false,
    ...overrides,
  }
}

export interface FakeDevicesOptions {
  device?: BoundDevice | null
  owners?: string[]
  /** Make every owner read throw, so a fail-closed path can be asserted. */
  ownerReadThrows?: boolean
  /** Make the owner read throw only after this many calls. */
  ownerReadThrowsAfter?: number
  /** Accept an association write and change nothing, as a provider once did. */
  writesChangeNothing?: boolean
  /** Refuse the record delete. */
  deleteFails?: boolean
  /** Last-contact values handed out on successive reads, for the quiet check. */
  contactSequence?: (string | null)[]
}

export class FakeDevices implements DeviceOps {
  readonly calls: string[] = []
  private device: BoundDevice | null
  private readonly owners: Set<string>
  private readonly opts: FakeDevicesOptions
  private ownerReads = 0
  private deviceReads = 0

  constructor(opts: FakeDevicesOptions = {}) {
    this.opts = opts
    this.device = opts.device === undefined ? deviceFixture() : opts.device
    this.owners = new Set(opts.owners ?? [LEAVER_USER_ID])
  }

  ownerIds(): string[] {
    return [...this.owners]
  }

  recordExists(): boolean {
    return this.device !== null
  }

  async listBoundDevices(userId: string): Promise<BoundDevice[]> {
    return this.device && this.owners.has(userId) ? [this.device] : []
  }

  async listDeviceOwners(systemId: string): Promise<string[]> {
    this.calls.push('listDeviceOwners:' + systemId)
    this.ownerReads += 1
    const throwAfter = this.opts.ownerReadThrowsAfter
    if (this.opts.ownerReadThrows || (throwAfter !== undefined && this.ownerReads > throwAfter)) {
      throw new GateError('the bindings could not be read')
    }
    return [...this.owners]
  }

  async getDevice(systemId: string): Promise<BoundDevice | null> {
    this.calls.push('getDevice:' + systemId)
    const sequence = this.opts.contactSequence
    if (sequence && this.device) {
      const at = Math.min(this.deviceReads, sequence.length - 1)
      const lastContact = sequence[at] ?? null
      this.deviceReads += 1
      return { ...this.device, lastContact }
    }
    this.deviceReads += 1
    return this.device
  }

  async unbindUser(userId: string, systemId: string): Promise<Outcome> {
    this.calls.push('unbindUser:' + userId + ':' + systemId)
    if (this.opts.writesChangeNothing) {
      return { ok: false, verified: false, error: 'the write was accepted and changed nothing', retryable: true }
    }
    this.owners.delete(userId)
    return { ok: true, verified: true, detail: { directOwners: this.owners.size } }
  }

  async bindUser(userId: string, systemId: string): Promise<Outcome> {
    this.calls.push('bindUser:' + userId + ':' + systemId)
    if (this.opts.writesChangeNothing) {
      return { ok: false, verified: false, error: 'the write was accepted and changed nothing', retryable: true }
    }
    this.owners.add(userId)
    return { ok: true, verified: true, detail: { directOwners: this.owners.size } }
  }

  async deleteDevice(systemId: string): Promise<Outcome> {
    this.calls.push('deleteDevice:' + systemId)
    if (this.opts.deleteFails) {
      return { ok: false, verified: false, error: 'the delete answered 500', retryable: true }
    }
    this.device = null
    return { ok: true, verified: true }
  }
}

export interface FakeCommandsOptions {
  /** Null means no command answers to the trigger. */
  command?: { id: string; name: string; launchType: string } | null
  refusal?: { refusal: string; detail: string }
  receipt?: CommandReceipt
  /** Thrown from runOnOneDevice, for the leak and refusal paths. */
  throws?: Error
  resolveThrows?: Error
  preflightThrows?: Error
}

export class FakeCommands implements CommandTargeting {
  readonly fired: string[] = []
  private readonly opts: FakeCommandsOptions

  constructor(opts: FakeCommandsOptions = {}) {
    this.opts = opts
  }

  async resolveCommand(trigger: string): Promise<{ id: string; name: string; launchType: string } | null> {
    if (this.opts.resolveThrows) throw this.opts.resolveThrows
    if (this.opts.command === null) return null
    return this.opts.command ?? { id: COMMAND_ID, name: 'Offboard: remove agents', launchType: 'trigger' }
  }

  async preflightCommand(commandId: string): Promise<{ ok: boolean; refusal?: string; detail?: string }> {
    if (this.opts.preflightThrows) throw this.opts.preflightThrows
    if (this.opts.refusal) return { ok: false, ...this.opts.refusal }
    return { ok: true }
  }

  async runOnOneDevice(opts: { commandId: string; systemId: string; holdMs: number; timeoutMs: number }): Promise<CommandReceipt> {
    this.fired.push(opts.commandId + ':' + opts.systemId + ':hold=' + opts.holdMs)
    if (this.opts.throws) throw this.opts.throws
    return (
      this.opts.receipt ?? {
        received: true,
        completed: true,
        exitCode: 0,
        output: 'AGENTS_REMOVED telemetry=yes inventory=absent',
      }
    )
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly name = 'memory'
  readonly events: AuditEvent[] = []
  private seq = 0
  private readonly failPhase: AuditEvent['phase'] | null

  constructor(failPhase: AuditEvent['phase'] | null = null) {
    this.failPhase = failPhase
  }

  async append(event: AuditEvent): Promise<AuditRef> {
    if (this.failPhase && event.phase === this.failPhase) {
      throw new Error('the audit sink refused a ' + event.phase + ' row')
    }
    this.events.push(event)
    this.seq += 1
    return { seq: this.seq }
  }

  /** Actions in the order they were recorded, as `phase action` pairs. */
  trail(): string[] {
    return this.events.map((e) => e.phase + ' ' + e.action)
  }
}

export class FakeNotifier implements Notifier {
  readonly name = 'fake'
  readonly sent: Notification[] = []
  private readonly delivered: boolean

  constructor(delivered = true) {
    this.delivered = delivered
  }

  async send(n: Notification): Promise<NotificationResult> {
    this.sent.push(n)
    return this.delivered ? { delivered: true, channel: 'fake' } : { delivered: false, channel: 'fake', error: 'ok:false' }
  }

  async testConnection(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'fake' }
  }
}

/** An identity connector that resolves the two addresses the tests use. */
export function fakeIdentity(map: Record<string, string | null> = {}) {
  const table: Record<string, string | null> = {
    [POOL_EMAIL]: POOL_USER_ID,
    [NEW_OWNER_EMAIL]: NEW_OWNER_USER_ID,
    ...map,
  }
  return {
    async findUser(opts: { email: string }) {
      const id = table[opts.email]
      return id ? { id, email: opts.email, suspended: false } : null
    },
  }
}

export function fakePeople(person: Partial<Person> & { hrisId: string }) {
  const full: Person = {
    status: 'offboarding',
    primaryEmail: 'jane.doe@example.com',
    aliasEmails: [],
    displayName: 'Jane Doe',
    hold: false,
    externalIds: { jumpcloudUserId: LEAVER_USER_ID },
    ...person,
  }
  return {
    async get(hrisId: string): Promise<Person | null> {
      return hrisId === full.hrisId ? full : null
    },
  }
}

export const PROVEN_MANIFEST: ScriptManifest = {
  version: 1,
  provenOnHardware: true,
  scripts: [
    {
      os: 'windows',
      file: 'uninstall-agents.windows.ps1',
      receiptProtocol: 'AGENTS_REMOVED',
      provenOnHardware: true,
      canaryRunbook: 'docs/runbooks/canary-a-device-script.md',
    },
    {
      os: 'darwin',
      file: 'uninstall-agents.macos.sh',
      receiptProtocol: 'AGENTS_REMOVED',
      provenOnHardware: true,
      canaryRunbook: 'docs/runbooks/canary-a-device-script.md',
    },
  ],
}

export interface HarnessOptions {
  devices?: FakeDevicesOptions
  commands?: FakeCommandsOptions
  config?: Record<string, unknown>
  armed?: boolean
  notifier?: Notifier | null
  people?: DeviceDeps['people']
  manifest?: ScriptManifest | undefined
  audit?: MemoryAuditSink
}

/** A configuration with the device section filled in the way an adopter would. */
export function deviceConfig(overrides: Record<string, unknown> = {}, armed = false): JmlConfig {
  return ConfigSchema.parse({
    version: 1,
    org: {
      name: 'Example Organisation',
      primaryDomain: 'example.com',
      timezone: 'Europe/London',
      itTeamSignature: 'IT Team',
    },
    mode: armed ? 'armed' : 'dry-run',
    armedActions: armed ? ['device_unbind', 'device_handover'] : [],
    mail: { senderMailbox: 'it-noreply@example.com' },
    hris: { adapter: 'fixture', minPlausibleHeadcount: 5, fixture: { path: './src/cli/fixtures/demo.json' } },
    store: { adapter: 'memory' },
    audit: { minimisePii: false },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY', poolUserEmail: POOL_EMAIL } },
    google: { serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', adminEmail: 'admin@example.com' },
    devices: {
      uninstallTriggers: { windows: WINDOWS_TRIGGER, darwin: null, linux: null },
      agents: [
        {
          name: 'telemetry',
          windows: { services: ['ExampleTelemetry'], uninstallDisplayNames: ['Example Telemetry Agent'], paths: [] },
          darwin: { launchdLabels: ['com.example.telemetry'], paths: [] },
        },
        { name: 'inventory', windows: { services: ['ExampleInventory'] }, darwin: {} },
      ],
      agentQuietMinutes: 10,
      receipt: { holdMs: 120_000, pollMs: 15_000, timeoutMs: 600_000 },
      ...((overrides['devices'] as Record<string, unknown>) ?? {}),
    },
    server: { token: 'env:JML_API_TOKEN' },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'devices')),
  }) as JmlConfig
}

export interface Harness {
  deps: DeviceDeps
  devices: FakeDevices
  commands: FakeCommands
  audit: MemoryAuditSink
  notifier: FakeNotifier | null
  clock: FakeClock
  slept: number[]
}

export function harness(opts: HarnessOptions = {}): Harness {
  const devices = new FakeDevices(opts.devices)
  const commands = new FakeCommands(opts.commands)
  const audit = opts.audit ?? new MemoryAuditSink()
  const notifier = opts.notifier === null ? null : ((opts.notifier as FakeNotifier | undefined) ?? new FakeNotifier())
  const clock = new FakeClock('2026-03-02T09:00:00.000Z')
  const slept: number[] = []

  const deps: DeviceDeps = {
    config: deviceConfig(opts.config ?? {}, opts.armed === true),
    devices,
    commands,
    identity: fakeIdentity(),
    clock,
    audit,
    sleep: async (ms: number) => {
      slept.push(ms)
      clock.advanceMs(ms)
    },
    ...(opts.people ? { people: opts.people } : {}),
    ...(notifier ? { notifier } : {}),
    ...(opts.manifest ? { scriptManifest: opts.manifest } : {}),
  }
  return { deps, devices, commands, audit, notifier, clock, slept }
}

export function request(overrides: Partial<DispositionRequest> = {}): DispositionRequest {
  return {
    systemId: SYSTEM_ID,
    disposition: 'return_to_pool',
    actor: { kind: 'system', id: 'system:device-step' },
    runId: 'run-device-1',
    ...overrides,
  }
}
