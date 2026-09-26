/**
 * The gates that stand between a leaver's row and a permanent deletion.
 *
 * Four checks, and each one is a recorded failure written down as code.
 *
 *  - The hand-over gate. Deleting the account destroys every file it still
 *    owns, so the files have to be somewhere else first, and "somewhere else"
 *    means the provider reported the transfer finished, not that we asked for
 *    it.
 *  - The identity gate. An offboarding row must never act on an account or an
 *    address that somebody who still works here claims. A leaver's row once
 *    inherited a live colleague's account id and suspended them on the day the
 *    leaving date passed.
 *  - The device gate. While a machine is still bound to the person, deleting
 *    the account removes the only channel to that machine and takes its
 *    escrowed disk-encryption key with it. The laptop carries on running,
 *    unmanaged, with nothing left to reach it.
 *  - The acknowledgement gate, when an adopter wants a person in the loop.
 *
 * The device gate FAILS CLOSED, which is the single most important line in
 * this file. The automation this replaces wrapped its device lookup in a catch
 * that logged and carried on, so a provider error produced an empty list, and
 * an empty list reads as "nothing to block on". One failed read therefore
 * deleted the account. Here, anything that is not a successful read of zero
 * devices blocks.
 */

import { fingerprintOf } from '../../core/gate.ts'
import type { JmlConfig } from '../../config/schema.ts'
import type { DomainMap } from '../../core/domain.ts'
import { claimedByLivePerson, idClaimedByLivePerson } from '../../core/identity.ts'
import type { Logger } from '../../core/logger.ts'
import type { BoundDevice, Person, ReviewReason } from '../../core/types.ts'
import {
  AmbiguousMatch,
  type DeviceConnector,
  type GoogleWorkspaceConnector,
  type IdentityConnector,
  type ProviderUser,
} from '../../connectors/types.ts'

/** Why a deletion is refused. Stored on the row as `deleteBlockedReason`. */
export type BlockedReason =
  | 'devices_bound'
  | 'transfer_incomplete'
  | 'gate_error'
  | 'identity_mismatch'
  | 'awaiting_ack'

export type GateResult =
  | { open: true; detail: string }
  | {
      open: false
      reason: BlockedReason
      detail: string
      devices?: BoundDevice[]
      /** Set when the blockage is a data problem a person has to resolve. */
      park?: ReviewReason
    }

/**
 * What a provider lookup found.
 *
 * Three cases, never two. "No such account" and "could not tell" are opposite
 * facts that a nullable result collapses into one, and collapsing them is how
 * a failed read became a deletion.
 */
export type IdpResolution =
  | { kind: 'found'; user: ProviderUser }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

/** A machine's name for a message. Never a bare id: an id is not actionable. */
export function deviceLabel(device: BoundDevice): string {
  const name = device.displayName?.trim()
  if (name) return name
  const serial = device.serial?.trim()
  if (serial) return `serial ${serial}`
  return device.id
}

/** One line per machine, for the blocked note. */
export function describeDevices(devices: readonly BoundDevice[]): string {
  return devices
    .map((device) => {
      const parts = [deviceLabel(device)]
      if (device.osFamily && device.osFamily !== 'unknown') parts.push(device.osFamily)
      if (device.serial) parts.push(`serial ${device.serial}`)
      if (device.lastContact) parts.push(`last seen ${device.lastContact}`)
      return `- ${parts.join(', ')}`
    })
    .join('\n')
}

/**
 * The set a blocked notification is keyed on.
 *
 * Machine ids and the reason, and deliberately nothing else. No date, no
 * count, no rendered text: an earlier gate hashed its own message, the message
 * carried today's date, and the "notify on change" rule fired every day.
 */
export function blockedItems(reason: BlockedReason, devices: readonly BoundDevice[] = []): string[] {
  return [`reason:${reason}`, ...devices.map((d) => `device:${d.id}`)]
}

export function blockedFingerprint(reason: BlockedReason, devices: readonly BoundDevice[] = []): string {
  return fingerprintOf(blockedItems(reason, devices))
}

/**
 * Has the hand-over happened, or has a person accepted that it will not?
 *
 * `requireTransferBeforeDelete` and `deleteGoogleUser` both open this gate
 * because with either switched off there is no permanent deletion of files for
 * the transfer to protect.
 */
export function evaluateTransferGate(person: Person, cfg: JmlConfig): GateResult {
  if (!cfg.leaver.requireTransferBeforeDelete) {
    return { open: true, detail: 'the hand-over is not required before deletion by configuration' }
  }
  if (!cfg.leaver.deleteGoogleUser) {
    return { open: true, detail: 'the Google account is not deleted, so no files are destroyed' }
  }
  if (person.googleAccountPresent === false) {
    return { open: true, detail: 'this person has no Google account, so there is nothing to hand over' }
  }
  if (person.offboarding?.transferOverride) {
    return { open: true, detail: `a person waived the hand-over: ${person.offboarding.transferOverride}` }
  }
  if (person.offboarding?.transferredAt) {
    return { open: true, detail: `the hand-over completed on ${person.offboarding.transferredAt}` }
  }
  return {
    open: false,
    reason: 'transfer_incomplete',
    detail:
      'the file hand-over has not been reported complete by the provider. Deleting the account now destroys every file it still owns.',
  }
}

/**
 * Does anybody who still works here claim this account or this address?
 *
 * This check ignores the hold flag on the live rows, and that is deliberate.
 * Hold stops the automation acting on the person it is set on. It must not
 * stop that person being protected from another row's offboarding, which is
 * exactly the case somebody reaches for hold to contain.
 */
export function evaluateIdentityGate(
  person: Person,
  live: readonly Person[],
  domain: DomainMap,
): GateResult {
  for (const [provider, id] of Object.entries(person.externalIds ?? {})) {
    if (!id) continue
    const claimant = idClaimedByLivePerson(provider, id, live, { exceptHrisId: person.hrisId })
    if (claimant) {
      return {
        open: false,
        reason: 'identity_mismatch',
        park: 'identity_claimed_by_live_person',
        detail: `the ${provider} account on this row is also held by ${claimant.displayName}, who still works here (HR id ${claimant.hrisId}).`,
      }
    }
  }

  for (const address of [person.primaryEmail, ...(person.aliasEmails ?? [])]) {
    if (!address) continue
    const claimant = claimedByLivePerson(address, live, domain, { exceptHrisId: person.hrisId })
    if (claimant) {
      return {
        open: false,
        reason: 'identity_mismatch',
        park: 'identity_claimed_by_live_person',
        detail: `an address on this row is also held by ${claimant.displayName}, who still works here (HR id ${claimant.hrisId}).`,
      }
    }
  }

  return { open: true, detail: 'no employed person claims this account or address' }
}

export function evaluateAckGate(person: Person, cfg: JmlConfig): GateResult {
  if (!cfg.leaver.requireOperatorAck) return { open: true, detail: 'no acknowledgement is required' }
  const ack = person.offboarding?.operatorAck
  if (ack?.by) {
    return { open: true, detail: `${ack.by} acknowledged the deletion on ${ack.at}` }
  }
  return {
    open: false,
    reason: 'awaiting_ack',
    detail: 'deletion is waiting for a person to acknowledge it (`jml leaver ack <hrisId>`).',
  }
}

export interface DeviceGateInput {
  person: Person
  /** The lookup result, not an id: "absent" and "unreadable" differ here. */
  idp: IdpResolution
  devices: DeviceConnector
  logger?: Logger
  /** Read for `identity.adapter`: with no identity provider there is no device inventory. */
  cfg?: { identity: { adapter: string } }
}

/**
 * Is any machine still bound directly to this person?
 *
 * Never throws. Every failure path returns a closed gate, because the caller
 * is about to decide whether to delete an account and there is no answer this
 * function could return that should be read as "carry on" other than a
 * successful read of an empty list.
 */
export async function evaluateDeviceGate(input: DeviceGateInput): Promise<GateResult> {
  if (input.cfg?.identity.adapter === 'none') {
    // Chosen in configuration, never inferred from an empty read. Said on
    // every deletion, so nobody reads an open gate as "no machine is out there".
    return {
      open: true,
      detail: 'no device inventory in this setup (identity.adapter: none), so no bound machine was checked; recover the laptop by hand',
    }
  }
  if (input.idp.kind === 'unreadable') {
    return {
      open: false,
      reason: 'gate_error',
      detail: `the identity provider account could not be read, so bound devices are unknown: ${input.idp.detail}`,
    }
  }
  if (input.idp.kind === 'absent') {
    return { open: true, detail: 'there is no identity provider account, so no machine can be bound to it' }
  }

  try {
    const devices = await input.devices.listBoundDevices(input.idp.user.id)
    if (devices.length === 0) {
      return { open: true, detail: 'no device is bound to this person' }
    }
    return {
      open: false,
      reason: 'devices_bound',
      devices,
      detail: `${devices.length} device(s) are still bound to this person:\n${describeDevices(devices)}`,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Named at warn level rather than swallowed. Silence here would look
    // exactly like a clear gate, which is the failure being prevented.
    input.logger?.warn('the device gate could not be read, so deletion is blocked', {
      hrisId: input.person.hrisId,
      err: message,
    })
    return {
      open: false,
      reason: 'gate_error',
      detail: `the bound-device list could not be read, so deletion is refused: ${message}`,
    }
  }
}

export interface DeleteGateInput extends DeviceGateInput {
  cfg: JmlConfig
  live: readonly Person[]
  domain: DomainMap
}

/**
 * Every gate, in cheapest-first order.
 *
 * The two that need no network call run first, so a row that is already
 * blocked on its hand-over or on a shared identifier costs nothing to
 * evaluate. The order also fixes which reason is reported when more than one
 * gate is shut, and the reported reason is what an operator acts on.
 */
export async function evaluateDeleteGate(input: DeleteGateInput): Promise<GateResult> {
  const transfer = evaluateTransferGate(input.person, input.cfg)
  if (!transfer.open) return transfer

  const identity = evaluateIdentityGate(input.person, input.live, input.domain)
  if (!identity.open) return identity

  const devices = await evaluateDeviceGate(input)
  if (!devices.open) return devices

  const ack = evaluateAckGate(input.person, input.cfg)
  if (!ack.open) return ack

  return { open: true, detail: 'every deletion gate is open' }
}

/**
 * Resolve both provider accounts once per person.
 *
 * The three-way answer is the point. An account that is absent and an account
 * that could not be read look the same to a nullable result, and every serious
 * failure in this family came from treating the second as the first: a failed
 * lookup read as "no account", so the row was closed as having had nothing to
 * offboard while the account carried on working.
 *
 * The identity provider is asked by stored id first and the address on that
 * account is checked against this person's own addresses, which is the
 * connector's contract. Google is asked by address, and a clean 404 is the
 * only thing that counts as absent.
 */
export async function resolveProviderAccounts(
  idpConnector: IdentityConnector,
  googleConnector: GoogleWorkspaceConnector,
  person: Person,
): Promise<{ idp: IdpResolution; googleAccount: IdpResolution; ambiguous: boolean }> {
  let ambiguous = false
  let idp: IdpResolution
  try {
    const found = await idpConnector.findUser({
      storedId: person.externalIds?.jumpcloudUserId ?? null,
      email: person.primaryEmail,
      aliases: person.aliasEmails ?? [],
    })
    idp = found ? { kind: 'found', user: found } : { kind: 'absent' }
  } catch (err) {
    // Ambiguity is reported separately because it is never resolved by picking
    // the first match. Taking the first row of an address lookup is what wrote
    // to a different person with a similar name.
    ambiguous = err instanceof AmbiguousMatch
    idp = {
      kind: 'unreadable',
      detail: ambiguous
        ? 'more than one identity provider account matched this person'
        : err instanceof Error
          ? err.message
          : String(err),
    }
  }

  let googleAccount: IdpResolution
  try {
    const found = await googleConnector.getUser(person.primaryEmail)
    googleAccount = found ? { kind: 'found', user: found } : { kind: 'absent' }
  } catch (err) {
    googleAccount = { kind: 'unreadable', detail: err instanceof Error ? err.message : String(err) }
  }
  return { idp, googleAccount, ambiguous }
}
