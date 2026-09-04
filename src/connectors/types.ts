/**
 * Providers that hold accounts and devices.
 *
 * Every mutating method returns an `Outcome` carrying `verified`, and
 * `verified` may only be true when the connector has read the provider back and
 * seen the change. This is a contract rather than a convention because the
 * automation this replaces recorded successful suspensions from responses that
 * had changed nothing: the API accepted a request, ignored part of the body,
 * and answered 200.
 */

import type { BoundDevice, Outcome } from '../core/types.ts'
import type { ConnectionCheck } from '../hris/types.ts'

/** A provider account, as the provider reports it right now. */
export interface ProviderUser {
  id: string
  email: string
  displayName?: string | null
  suspended: boolean
  /** Provider-specific state string, for the audit detail. */
  rawState?: string | null
}

/** More than one account matched a lookup. Never guess; park the row. */
export class AmbiguousMatch extends Error {
  readonly code = 'ambiguous_provider_match'
  readonly matches: { id: string; email: string }[]
  constructor(message: string, matches: { id: string; email: string }[]) {
    super(message)
    this.matches = matches
  }
}

/**
 * A gate could not be evaluated.
 *
 * Thrown rather than returned, so a destructive step cannot proceed on a failed
 * read. The engine's ancestor treated an error listing a person's devices as
 * "no devices", which is the wrong way round: it deleted the account and
 * stranded the machine.
 */
export class GateError extends Error {
  readonly code = 'gate_unavailable'
}

export interface IdentityConnector {
  readonly name: string
  /**
   * Find the account for a person.
   *
   * Implementations look the stored id up first and verify the address matches,
   * because an address lookup alone once matched a different person with a
   * similar name. More than one match throws AmbiguousMatch.
   */
  findUser(opts: { storedId?: string | null; email: string; aliases?: string[] }): Promise<ProviderUser | null>
  suspendUser(id: string): Promise<Outcome>
  deleteUser(id: string): Promise<Outcome>
  testConnection(): Promise<ConnectionCheck>
}

/** Devices, kept separate because not every identity provider manages them. */
export interface DeviceConnector {
  /**
   * Devices bound directly to this person.
   *
   * Direct bindings only: membership of a group that grants access to a machine
   * is not custody of it. Throws GateError rather than returning an empty list
   * when the provider cannot be read.
   */
  listBoundDevices(userId: string): Promise<BoundDevice[]>
  unbindUser(userId: string, systemId: string): Promise<Outcome>
  bindUser(userId: string, systemId: string): Promise<Outcome>
  getDevice(systemId: string): Promise<BoundDevice | null>
  deleteDevice(systemId: string): Promise<Outcome>
}

/**
 * Running a script on one machine.
 *
 * The safety rules here are all scar tissue. A trigger fires on every
 * association the command holds, and ignores any list of targets in the request
 * body, so "run this on one device" is really: attach this device, read the
 * attachment back, fire, wait, detach in a finally, then assert the attachment
 * count is zero. A command that is attached to a group, or that already has
 * attachments belonging to somebody else, is refused rather than fired: a
 * group-attached uninstaller strips the fleet.
 */
export interface CommandTargeting {
  resolveCommand(trigger: string): Promise<{ id: string; name: string; launchType: string } | null>
  /** Refuses group bindings, pre-existing attachments and non-trigger commands. */
  preflightCommand(commandId: string): Promise<{ ok: boolean; refusal?: string; detail?: string }>
  runOnOneDevice(opts: {
    commandId: string
    systemId: string
    holdMs: number
    timeoutMs: number
  }): Promise<CommandReceipt>
}

export interface CommandReceipt {
  /**
   * True only when the result carried BOTH an exit code and a response time.
   * A result row appearing means the machine collected the command; it does not
   * mean the command finished.
   */
  completed: boolean
  exitCode: number | null
  output: string | null
  /** False when no result arrived inside the timeout. Never read as success. */
  received: boolean
  /**
   * Problems that did not stop the command but must reach a person, chiefly a
   * detach that could not be proven. A device left attached to a command gets
   * swept up by the next unrelated run of it, which is how a laptop was once
   * restarted daily for eleven days by a job that had nothing to do with it.
   * Reported rather than thrown, so a caller handling several devices records
   * the leak and still finishes the others.
   */
  warnings?: string[]
}

export interface GoogleWorkspaceConnector {
  readonly name: string
  getUser(email: string): Promise<ProviderUser | null>
  suspendUser(email: string): Promise<Outcome>
  deleteUser(email: string): Promise<Outcome>
  listLicences(email: string): Promise<{ productId: string; skuId: string }[]>
  revokeLicence(email: string, productId: string, skuId: string): Promise<Outcome>
  /** Hands the leaver's files to somebody who still works here. */
  transferDrive(fromEmail: string, toEmail: string): Promise<Outcome & { transferId?: string }>
  getTransferStatus(transferId: string): Promise<{ state: string; done: boolean }>
  setVacationResponder(email: string, subject: string, body: string): Promise<Outcome>
  sendMail(opts: { to: string[]; bcc?: string[]; subject: string; body: string }): Promise<Outcome>
  testConnection(): Promise<ConnectionCheck>
  /** Reports per-scope authorisation, so `jml doctor` can name the missing one. */
  probeScopes(): Promise<{ scope: string; ok: boolean }[]>
}
