/**
 * Scriptable stand-ins for the identity provider and for Google Workspace.
 *
 * These are a shipped part of the toolkit rather than a test fixture, for two
 * reasons. `jml demo` walks a whole leaver through days 0 to 8 against them, so
 * somebody can watch the state machine work before they hold a single
 * credential. And the engine's safety rules are all about what happens when a
 * provider misbehaves, which cannot be demonstrated against a provider that is
 * behaving.
 *
 * So every method can be told to misbehave in the exact ways that caused real
 * incidents: accept a write and change nothing, answer an error, throw while
 * listing somebody's devices, or match two accounts for one address. A rule
 * that is only ever exercised on the happy path is not a rule.
 *
 * Every call is appended to `calls` in order. That list is asserted in the
 * tests, because "the run made no writes" and "the run made the writes in the
 * wrong order" are both invisible if you only look at the final state.
 */

import type { BoundDevice, Outcome } from '../core/types.ts'
import type { ConnectionCheck } from '../hris/types.ts'
import {
  AmbiguousMatch,
  GateError,
  type DeviceConnector,
  type GoogleWorkspaceConnector,
  type IdentityConnector,
  type ProviderUser,
  type IdentityActivationConnector,
  type GoogleProvisioningConnector,
} from './types.ts'

/** An account in the fake identity provider. */
export interface FakeIdpAccount {
  id: string
  email: string
  displayName?: string | null
  suspended?: boolean
  /** Machines bound directly to this account. Ids of `FakeDevice` entries. */
  devices?: string[]
  /** The person has set their own password. Defaults to true: an unstaged account. */
  activated?: boolean
  mfaConfigured?: boolean
  passwordExpired?: boolean
}

/** An account in the fake Google tenancy. */
export interface FakeGoogleAccount {
  id: string
  email: string
  suspended?: boolean
  licences?: { productId: string; skuId: string }[]
  /** Set when the mailbox has been built. The fake flips it on licence assignment after `mailboxReadyAfterReads` reads. */
  mailboxReady?: boolean
  mailboxReadyAfterReads?: number
  orgUnitPath?: string
}

export interface FakeDevice {
  id: string
  displayName?: string | null
  osFamily?: BoundDevice['osFamily']
  serial?: string | null
  lastContact?: string | null
  fdeKeyPresent?: boolean | null
}

export type FakeTransferState = 'inProgress' | 'completed' | 'failed' | 'unknown'

/**
 * The ways a provider is allowed to go wrong here.
 *
 * `unverified` is the one worth naming: the call answers success and the
 * read-back shows nothing changed. It is the shape of the incident the whole
 * `verified` contract exists for, and it is invisible to a fake that only
 * knows how to succeed or fail.
 */
export type FakeFaultKind = 'error' | 'unverified' | 'gate_error' | 'ambiguous' | 'throw'

export interface FakeFault {
  kind: FakeFaultKind
  message?: string
  retryable?: boolean
  /** How many calls it applies to. Omitted means every call from now on. */
  times?: number
}

/** Every method a fault can be attached to. */
export type FakeMethod =
  | 'idp.findUser'
  | 'idp.suspendUser'
  | 'idp.deleteUser'
  | 'idp.getActivationState'
  | 'idp.setTemporaryPassword'
  | 'idp.expirePassword'
  | 'devices.listBoundDevices'
  | 'devices.unbindUser'
  | 'devices.bindUser'
  | 'devices.deleteDevice'
  | 'google.getUser'
  | 'google.suspendUser'
  | 'google.deleteUser'
  | 'google.listLicences'
  | 'google.revokeLicence'
  | 'google.transferDrive'
  | 'google.getTransferStatus'
  | 'google.setVacationResponder'
  | 'google.signOutUser'
  | 'google.sendMail'
  | 'google.getMailboxState'
  | 'google.assignLicence'
  | 'google.moveToOrgUnit'

export interface FakeProvidersSeed {
  idp?: FakeIdpAccount[]
  google?: FakeGoogleAccount[]
  devices?: FakeDevice[]
  /**
   * States `getTransferStatus` reports, in order, one per call. The last is
   * repeated once the list runs out, so a test can describe a transfer that is
   * in progress for two runs and complete on the third.
   */
  transferStates?: FakeTransferState[]
}

function normalise(email: string): string {
  return email.trim().toLowerCase()
}

export class FakeProviders {
  /** Every provider call this run made, in order, as `method(argument)`. */
  readonly calls: string[] = []

  readonly identity: IdentityConnector & IdentityActivationConnector
  readonly devices: DeviceConnector
  readonly google: GoogleWorkspaceConnector & GoogleProvisioningConnector

  private readonly idpAccounts: FakeIdpAccount[]
  private readonly googleAccounts: FakeGoogleAccount[]
  private readonly deviceRecords: FakeDevice[]
  private readonly bindings = new Map<string, Set<string>>()
  private readonly faults = new Map<FakeMethod, FakeFault[]>()
  private readonly transferStates: FakeTransferState[]
  private transferSeq = 0

  constructor(seed: FakeProvidersSeed = {}) {
    this.idpAccounts = (seed.idp ?? []).map((a) => ({ ...a }))
    this.googleAccounts = (seed.google ?? []).map((a) => ({ ...a, licences: [...(a.licences ?? [])] }))
    this.deviceRecords = (seed.devices ?? []).map((d) => ({ ...d }))
    this.transferStates = [...(seed.transferStates ?? ['completed'])]
    for (const account of this.idpAccounts) {
      this.bindings.set(account.id, new Set(account.devices ?? []))
    }
    this.identity = this.buildIdentity()
    this.devices = this.buildDevices()
    this.google = this.buildGoogle()
  }

  /** Attach a fault to one method. Chainable, so a seed reads as a scenario. */
  fault(method: FakeMethod, fault: FakeFault): this {
    const existing = this.faults.get(method) ?? []
    existing.push({ ...fault })
    this.faults.set(method, existing)
    return this
  }

  /** Machines still bound to an account, for asserting an unbind really happened. */
  boundDeviceIds(userId: string): string[] {
    return [...(this.bindings.get(userId) ?? [])]
  }

  /** Bind a machine after construction, for a test that changes the world mid-run. */
  bind(userId: string, deviceId: string): void {
    const set = this.bindings.get(userId) ?? new Set<string>()
    set.add(deviceId)
    this.bindings.set(userId, set)
  }

  idpAccount(id: string): FakeIdpAccount | undefined {
    return this.idpAccounts.find((a) => a.id === id)
  }

  googleAccount(email: string): FakeGoogleAccount | undefined {
    return this.googleAccounts.find((a) => normalise(a.email) === normalise(email))
  }

  /** Consume one fault for this method, if any is still owed. */
  private take(method: FakeMethod): FakeFault | null {
    const queue = this.faults.get(method)
    const next = queue?.[0]
    if (!next) return null
    if (next.times !== undefined) {
      next.times -= 1
      if (next.times <= 0) queue?.shift()
    }
    return next
  }

  private record(method: FakeMethod, argument: string): void {
    this.calls.push(`${method}(${argument})`)
  }

  /**
   * Apply a fault, or return null to carry on.
   *
   * `unverified` is deliberately built here rather than by each method: it has
   * to look exactly like a provider that accepted the request, which means ok
   * true and verified false, and a method that built it itself could get that
   * pairing subtly wrong.
   */
  private applyFault(method: FakeMethod, argument: string): Outcome | null {
    const fault = this.take(method)
    if (!fault) return null
    if (fault.kind === 'throw') throw new Error(fault.message ?? `${method} threw`)
    if (fault.kind === 'gate_error') {
      throw new GateError(fault.message ?? `${method} could not be read, so the gate is unsafe`)
    }
    if (fault.kind === 'ambiguous') {
      throw new AmbiguousMatch(fault.message ?? 'more than one account matched one address', [
        { id: 'fake-a', email: argument },
        { id: 'fake-b', email: argument },
      ])
    }
    if (fault.kind === 'unverified') {
      return {
        ok: true,
        verified: false,
        error: `${method} was accepted and changed nothing`,
        retryable: true,
      }
    }
    return {
      ok: false,
      verified: false,
      error: fault.message ?? `${method} answered an error`,
      retryable: fault.retryable ?? true,
    }
  }

  private buildIdentity(): IdentityConnector & IdentityActivationConnector {
    // Arrow properties, so `this` is the instance without aliasing it. The
    // connectors have to be plain objects because that is what the interfaces
    // are, and the state they read lives on the class.
    return {
      name: 'fake-identity',

      findUser: async (opts) => {
        this.record('idp.findUser', opts.email)
        const faulted = this.applyFault('idp.findUser', opts.email)
        if (faulted) throw new Error(faulted.error ?? 'the account lookup failed')
        const owned = new Set([opts.email, ...(opts.aliases ?? [])].map(normalise))
        if (opts.storedId) {
          const stored = this.idpAccount(opts.storedId)
          // The stored id is only evidence about this person while the account
          // it points at still carries an address they own. Ids get copied
          // between rows by accident, and acting on one that has drifted is
          // how a live colleague's account was suspended.
          if (stored && owned.has(normalise(stored.email))) return toIdpUser(stored)
        }
        const matches = this.idpAccounts.filter((a) => owned.has(normalise(a.email)))
        if (matches.length > 1) {
          throw new AmbiguousMatch(
            'more than one identity provider account matched one address',
            matches.map((a) => ({ id: a.id, email: a.email })),
          )
        }
        const [only] = matches
        return only ? toIdpUser(only) : null
      },

      suspendUser: async (id) => {
        this.record('idp.suspendUser', id)
        const faulted = this.applyFault('idp.suspendUser', id)
        if (faulted) return faulted
        const account = this.idpAccount(id)
        if (!account) return { ok: true, verified: true, alreadyAbsent: true }
        if (account.suspended) return { ok: true, verified: true, detail: { readBackState: 'SUSPENDED' } }
        account.suspended = true
        return { ok: true, verified: true, detail: { readBackState: 'SUSPENDED' } }
      },

      getActivationState: async (id) => {
        this.record('idp.getActivationState', id)
        const faulted = this.applyFault('idp.getActivationState', id)
        if (faulted) throw new Error(faulted.error ?? 'the account could not be read')
        const account = this.idpAccount(id)
        if (!account) return null
        return {
          activated: account.activated !== false,
          mfaConfigured: account.mfaConfigured === true,
          suspended: account.suspended === true,
          passwordExpired: account.passwordExpired === true,
        }
      },

      setTemporaryPassword: async (id, password) => {
        // The password is never recorded, even by a fake: a call log with a
        // credential in it is the thing the real audit sink is built to avoid.
        this.record('idp.setTemporaryPassword', id)
        const faulted = this.applyFault('idp.setTemporaryPassword', id)
        if (faulted) return faulted
        const account = this.idpAccount(id)
        if (!account) return { ok: false, verified: false, error: 'no such account', retryable: false }
        if (account.activated !== false || account.mfaConfigured) {
          return { ok: false, verified: false, error: 'the account is already in use; refusing to reset its password', retryable: false, detail: { reason: 'already_in_use' } }
        }
        if (password.length < 12) return { ok: false, verified: false, error: 'password too short', retryable: false }
        // Setting a password clears a pending reset, exactly as the real
        // provider does. The engine has to expire AFTER this, or the flag is lost.
        account.passwordExpired = false
        return { ok: true, verified: true, detail: { readBackState: 'ACTIVATED' } }
      },

      expirePassword: async (id) => {
        this.record('idp.expirePassword', id)
        const faulted = this.applyFault('idp.expirePassword', id)
        if (faulted) return faulted
        const account = this.idpAccount(id)
        if (!account) return { ok: false, verified: false, error: 'no such account', retryable: false }
        account.passwordExpired = true
        return { ok: true, verified: true, detail: { passwordExpired: true } }
      },

      deleteUser: async (id) => {
        this.record('idp.deleteUser', id)
        const faulted = this.applyFault('idp.deleteUser', id)
        if (faulted) return faulted
        const index = this.idpAccounts.findIndex((a) => a.id === id)
        if (index < 0) return { ok: true, verified: true, alreadyAbsent: true }
        this.idpAccounts.splice(index, 1)
        return { ok: true, verified: true }
      },

      testConnection: async (): Promise<ConnectionCheck> => ({
        ok: true,
        detail: 'fake identity provider; nothing leaves this process',
      }),
    }
  }

  private buildDevices(): DeviceConnector {
    return {
      listBoundDevices: async (userId) => {
        this.record('devices.listBoundDevices', userId)
        const faulted = this.applyFault('devices.listBoundDevices', userId)
        // A fault here has to throw rather than return an empty list. An
        // unreadable device list that reads as "no devices" is what deleted an
        // account and stranded the machine.
        if (faulted) throw new GateError(faulted.error ?? 'the device list could not be read')
        const ids = [...(this.bindings.get(userId) ?? [])]
        return ids.map((id) => toBoundDevice(this.deviceRecords.find((d) => d.id === id) ?? { id }))
      },

      unbindUser: async (userId, systemId) => {
        this.record('devices.unbindUser', `${userId},${systemId}`)
        const faulted = this.applyFault('devices.unbindUser', systemId)
        if (faulted) return faulted
        this.bindings.get(userId)?.delete(systemId)
        return { ok: true, verified: true }
      },

      bindUser: async (userId, systemId) => {
        this.record('devices.bindUser', `${userId},${systemId}`)
        const faulted = this.applyFault('devices.bindUser', systemId)
        if (faulted) return faulted
        this.bind(userId, systemId)
        return { ok: true, verified: true }
      },

      getDevice: async (systemId) => {
        const found = this.deviceRecords.find((d) => d.id === systemId)
        return found ? toBoundDevice(found) : null
      },

      deleteDevice: async (systemId) => {
        this.record('devices.deleteDevice', systemId)
        const faulted = this.applyFault('devices.deleteDevice', systemId)
        if (faulted) return faulted
        const index = this.deviceRecords.findIndex((d) => d.id === systemId)
        if (index < 0) return { ok: true, verified: true, alreadyAbsent: true }
        this.deviceRecords.splice(index, 1)
        for (const set of this.bindings.values()) set.delete(systemId)
        return { ok: true, verified: true }
      },
    }
  }

  private buildGoogle(): GoogleWorkspaceConnector & GoogleProvisioningConnector {
    return {
      name: 'fake-google',

      getUser: async (email) => {
        this.record('google.getUser', email)
        const faulted = this.applyFault('google.getUser', email)
        // The real connector throws on anything that is not a clean 404, and
        // the engine needs that difference: "no account" is a fact to act on,
        // "cannot tell" is not.
        if (faulted) throw new Error(faulted.error ?? 'the Google account could not be read')
        const account = this.googleAccount(email)
        return account ? toGoogleUser(account) : null
      },

      suspendUser: async (email) => {
        this.record('google.suspendUser', email)
        const faulted = this.applyFault('google.suspendUser', email)
        if (faulted) return faulted
        const account = this.googleAccount(email)
        if (!account) return { ok: true, verified: true, alreadyAbsent: true }
        account.suspended = true
        return { ok: true, verified: true }
      },

      deleteUser: async (email) => {
        this.record('google.deleteUser', email)
        const faulted = this.applyFault('google.deleteUser', email)
        if (faulted) return faulted
        const index = this.googleAccounts.findIndex((a) => normalise(a.email) === normalise(email))
        if (index < 0) return { ok: true, verified: true, alreadyAbsent: true }
        this.googleAccounts.splice(index, 1)
        return { ok: true, verified: true }
      },

      listLicences: async (email) => {
        this.record('google.listLicences', email)
        const faulted = this.applyFault('google.listLicences', email)
        if (faulted) throw new Error(faulted.error ?? 'the licence list could not be read')
        return [...(this.googleAccount(email)?.licences ?? [])]
      },

      revokeLicence: async (email, productId, skuId) => {
        this.record('google.revokeLicence', `${email},${skuId}`)
        const faulted = this.applyFault('google.revokeLicence', skuId)
        if (faulted) return faulted
        const account = this.googleAccount(email)
        const before = account?.licences?.length ?? 0
        if (account) {
          account.licences = (account.licences ?? []).filter(
            (l) => !(l.productId === productId && l.skuId === skuId),
          )
        }
        if (before === (account?.licences?.length ?? 0)) {
          return { ok: true, verified: true, alreadyAbsent: true, detail: { productId, skuId } }
        }
        return { ok: true, verified: true, detail: { productId, skuId } }
      },

      signOutUser: async (email) => {
        this.record('google.signOutUser', email)
        const faulted = this.applyFault('google.signOutUser', email)
        if (faulted) return faulted
        if (!this.googleAccount(email)) return { ok: true, verified: true, alreadyAbsent: true }
        return { ok: true, verified: true, detail: { sessionsReset: 'requested', grantsRevoked: 0, grantsRemaining: 0 } }
      },

      transferDrive: async (fromEmail, toEmail) => {
        this.record('google.transferDrive', `${fromEmail}->${toEmail}`)
        const faulted = this.applyFault('google.transferDrive', toEmail)
        if (faulted) return faulted
        if (!this.googleAccount(toEmail)) {
          return {
            ok: false,
            verified: false,
            error: 'the hand-over recipient has no Google account, so no transfer was started',
          }
        }
        this.transferSeq += 1
        const transferId = `transfer-${this.transferSeq}`
        const state = this.transferStates[0] ?? 'completed'
        return { ok: true, verified: state === 'completed', transferId, detail: { state } }
      },

      getTransferStatus: async (transferId) => {
        this.record('google.getTransferStatus', transferId)
        const faulted = this.applyFault('google.getTransferStatus', transferId)
        // Unknown is not done: an unreadable transfer must never open the
        // deletion gate on a hand-over that may have failed.
        if (faulted) return { state: 'unknown', done: false }
        const state =
          this.transferStates.length > 1
            ? (this.transferStates.shift() as FakeTransferState)
            : (this.transferStates[0] ?? 'completed')
        return { state, done: state === 'completed' || state === 'failed' }
      },

      setVacationResponder: async (email) => {
        this.record('google.setVacationResponder', email)
        const faulted = this.applyFault('google.setVacationResponder', email)
        if (faulted) return faulted
        return { ok: true, verified: true }
      },

      getMailboxState: async (email) => {
        this.record('google.getMailboxState', email)
        const faulted = this.applyFault('google.getMailboxState', email)
        if (faulted) throw new Error(faulted.error ?? 'the Google account could not be read')
        const account = this.googleAccount(email)
        if (!account) return null
        // A mailbox takes a few reads to appear after licensing, like the real
        // one, so a poll that gives up too early can be tested.
        if (!account.mailboxReady && (account.licences?.length ?? 0) > 0) {
          const left = account.mailboxReadyAfterReads ?? 0
          if (left <= 0) account.mailboxReady = true
          else account.mailboxReadyAfterReads = left - 1
        }
        return {
          exists: true,
          mailboxReady: account.mailboxReady === true,
          orgUnitPath: account.orgUnitPath ?? '/',
          suspended: account.suspended === true,
        }
      },

      assignLicence: async (email, productId, skuId) => {
        this.record('google.assignLicence', email)
        const faulted = this.applyFault('google.assignLicence', email)
        if (faulted) return faulted
        const account = this.googleAccount(email)
        if (!account) return { ok: false, verified: false, error: 'no Google account to license', retryable: false }
        account.licences = account.licences ?? []
        if (account.licences.some((l) => l.productId === productId && l.skuId === skuId)) {
          return { ok: true, verified: true, alreadyAbsent: true, detail: { productId, skuId, reason: 'already_licensed' } }
        }
        account.licences.push({ productId, skuId })
        return { ok: true, verified: true, detail: { productId, skuId } }
      },

      moveToOrgUnit: async (email, orgUnitPath) => {
        this.record('google.moveToOrgUnit', email)
        const faulted = this.applyFault('google.moveToOrgUnit', email)
        if (faulted) return faulted
        const account = this.googleAccount(email)
        if (!account) return { ok: false, verified: false, error: 'no Google account to move', retryable: false }
        account.orgUnitPath = orgUnitPath
        return { ok: true, verified: true, detail: { orgUnitPath } }
      },

      sendMail: async (opts) => {
        this.record('google.sendMail', opts.to.join(','))
        const faulted = this.applyFault('google.sendMail', opts.to.join(','))
        if (faulted) return faulted
        return { ok: true, verified: true }
      },

      testConnection: async (): Promise<ConnectionCheck> => ({
        ok: true,
        detail: 'fake Google tenancy; nothing leaves this process',
      }),

      probeScopes: async () => [],
    }
  }
}

function toIdpUser(account: FakeIdpAccount): ProviderUser {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName ?? null,
    suspended: account.suspended === true,
    rawState: account.suspended === true ? 'SUSPENDED' : 'ACTIVATED',
  }
}

function toGoogleUser(account: FakeGoogleAccount): ProviderUser {
  return {
    id: account.id,
    email: account.email,
    displayName: null,
    suspended: account.suspended === true,
    rawState: account.suspended === true ? 'suspended' : 'active',
  }
}

function toBoundDevice(device: FakeDevice): BoundDevice {
  return {
    id: device.id,
    // Falls back to the id so a message can always name something, but the
    // engine still prefers a real name: an alert full of raw ids is an alert
    // nobody can act on.
    displayName: device.displayName ?? null,
    osFamily: device.osFamily ?? 'unknown',
    serial: device.serial ?? null,
    lastContact: device.lastContact ?? null,
    fdeKeyPresent: device.fdeKeyPresent ?? null,
  }
}

export function createFakeProviders(seed: FakeProvidersSeed = {}): FakeProviders {
  return new FakeProviders(seed)
}
