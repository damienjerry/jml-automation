/**
 * Devices, and the gate that stops a leaver's account being deleted while they
 * still hold a machine.
 *
 * Two rules here are the reason this file exists.
 *
 * It fails closed. An earlier design wrapped the device lookup in a
 * catch that only logged, so any provider error produced an empty list, and an
 * empty list means "no devices to block on". A single failed read therefore
 * deleted the account, which destroys the only management channel to the
 * machine: the laptop carries on running, still reporting, with no way left to
 * reach it and its escrowed disk-encryption key gone with the record. So every
 * unreadable answer throws GateError, and an empty list is returned only when
 * every read succeeded.
 *
 * It counts direct bindings only. The endpoint that lists a person's machines
 * reports effective access, which includes anything reachable through a group.
 * Membership of a group that grants a machine is not custody of it, and a
 * group-derived binding cannot be cleared by unbinding the person, so counting
 * those blocks a deletion for ever with no action that resolves it.
 */

import type { BoundDevice, Outcome } from '../../core/types.ts'
import { GateError, type DeviceConnector } from '../types.ts'
import {
  associationId,
  isDirectAssociation,
  isRetryableStatus,
  preview,
  type JumpCloudClient,
} from './client.ts'

export class JumpCloudDevices implements DeviceConnector {
  private readonly client: JumpCloudClient
  constructor(client: JumpCloudClient) {
    this.client = client
  }

  /**
   * The machines bound directly to this person.
   *
   * Two steps, because neither endpoint answers the question on its own. The
   * first lists the systems the person can reach, including through groups. The
   * second asks each of those systems who is bound to it directly, which is the
   * only way to tell custody from group-derived access.
   */
  async listBoundDevices(userId: string): Promise<BoundDevice[]> {
    const candidates = await this.candidateSystemIds(userId)
    const devices: BoundDevice[] = []

    for (const systemId of candidates) {
      if (!(await this.hasDirectUserBinding(systemId, userId))) continue
      const device = await this.getDevice(systemId)
      // A system that vanished between the two reads is not a reason to
      // unblock: the person was bound to something a moment ago, and a
      // disappearing record is exactly the state this gate exists to notice.
      if (!device) {
        throw new GateError(`a system bound to this person could not be read back, so the device gate is unsafe`)
      }
      devices.push(device)
    }
    return devices
  }

  /**
   * Detach a person from a machine, then prove they are detached.
   *
   * This is the primitive an earlier design never had: its blocked-device
   * message told operators to unbind in the console because no code could do
   * it. Unbinding clears the gate at no risk to the machine, which stays
   * enrolled, managed, and with its recovery key still escrowed.
   */
  async unbindUser(userId: string, systemId: string): Promise<Outcome> {
    return this.writeUserAssociation('remove', userId, systemId)
  }

  /** Bind a person to a machine, then prove they are bound. */
  async bindUser(userId: string, systemId: string): Promise<Outcome> {
    return this.writeUserAssociation('add', userId, systemId)
  }

  async getDevice(systemId: string): Promise<BoundDevice | null> {
    const res = await this.client.call('GET', `/systems/${encodeURIComponent(systemId)}`)
    if (res.status === 404) return null
    if (res.status < 200 || res.status >= 300) {
      throw new GateError(`reading a device answered ${res.status}`)
    }
    return toBoundDevice(res.json())
  }

  /**
   * Remove the device record, then confirm it is gone.
   *
   * Deleting the record removes the machine from our view, not from the
   * network, and takes the escrowed disk-encryption key with it. The engine
   * only reaches this after an on-device receipt has proved the agents are
   * off; the read-back here is the last check that the record really went.
   */
  async deleteDevice(systemId: string): Promise<Outcome> {
    const res = await this.client.call('DELETE', `/systems/${encodeURIComponent(systemId)}`)
    if (res.status === 404) {
      return { ok: true, verified: true, alreadyAbsent: true, detail: { reason: 'no_such_device' } }
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        verified: false,
        error: `deleting the device answered ${res.status}`,
        retryable: isRetryableStatus(res.status),
        detail: { status: res.status, body: preview(res) },
      }
    }

    const check = await this.client.call('GET', `/systems/${encodeURIComponent(systemId)}`)
    if (check.status === 404) return { ok: true, verified: true }
    if (check.status >= 200 && check.status < 300) {
      return {
        ok: false,
        verified: false,
        error: 'the delete was accepted and the device record is still readable',
        retryable: true,
      }
    }
    return {
      ok: false,
      verified: false,
      error: `the delete could not be confirmed: read-back answered ${check.status}`,
      retryable: true,
    }
  }

  /** Direct user bindings on one machine, named rather than counted. */
  async listDeviceOwners(systemId: string): Promise<string[]> {
    const rows = await this.readAssociationsOrThrow(`/v2/systems/${encodeURIComponent(systemId)}/associations`, {
      targets: 'user',
    })
    const ids: string[] = []
    for (const row of rows) {
      if (!isDirectAssociation(row)) continue
      const id = associationId(row)
      if (id) ids.push(id)
    }
    return [...new Set(ids)]
  }

  private async candidateSystemIds(userId: string): Promise<string[]> {
    const rows = await this.readAssociationsOrThrow(`/v2/users/${encodeURIComponent(userId)}/systems`)
    const ids: string[] = []
    for (const row of rows) {
      const id = associationId(row)
      // An element with no readable id means this endpoint changed shape.
      // Skipping it silently would shrink the blocking set, so it throws.
      if (!id) {
        throw new GateError('a device association carried no readable id, so the device gate cannot be trusted')
      }
      ids.push(id)
    }
    return [...new Set(ids)]
  }

  private async hasDirectUserBinding(systemId: string, userId: string): Promise<boolean> {
    const owners = await this.listDeviceOwners(systemId)
    return owners.includes(userId)
  }

  private async writeUserAssociation(
    op: 'add' | 'remove',
    userId: string,
    systemId: string,
  ): Promise<Outcome> {
    const res = await this.client.call('POST', `/v2/systems/${encodeURIComponent(systemId)}/associations`, {
      body: { op, type: 'user', id: userId },
    })
    // A 404 on an add means the machine or the person is gone; on a remove it
    // means there was nothing to remove, which is the desired state.
    if (res.status === 404 && op === 'remove') {
      return { ok: true, verified: true, alreadyAbsent: true, detail: { reason: 'no_such_association' } }
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        verified: false,
        error: `association ${op} answered ${res.status}`,
        retryable: isRetryableStatus(res.status),
        detail: { status: res.status, body: preview(res) },
      }
    }

    let owners: string[]
    try {
      owners = await this.listDeviceOwners(systemId)
    } catch {
      return {
        ok: false,
        verified: false,
        error: `association ${op} was accepted but could not be read back`,
        retryable: true,
      }
    }
    const bound = owners.includes(userId)
    const wanted = op === 'add'
    if (bound !== wanted) {
      return {
        ok: false,
        verified: false,
        error: `association ${op} was accepted and changed nothing`,
        retryable: true,
        detail: { directOwners: owners.length },
      }
    }
    return { ok: true, verified: true, detail: { directOwners: owners.length } }
  }

  /**
   * A list read whose failure must never look like an empty result.
   *
   * Both the transport error and a non-2xx become GateError, so a caller
   * deciding whether anything is bound cannot be handed a false "nothing".
   */
  private async readAssociationsOrThrow(path: string, query: Record<string, string> = {}): Promise<unknown[]> {
    try {
      return await this.client.listV2(path, query)
    } catch (err) {
      throw new GateError(`the device gate could not read ${path}: ${describe(err)}`)
    }
  }
}

/** Map a provider system record onto the shared shape. */
export function toBoundDevice(raw: unknown): BoundDevice | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = record['_id'] ?? record['id']
  if (typeof id !== 'string' || id.length === 0) return null

  const displayName = str(record['displayName']) ?? str(record['hostname'])
  const fde = record['fde']
  const keyPresent =
    fde && typeof fde === 'object' ? asBool((fde as Record<string, unknown>)['keyPresent']) : null

  return {
    id,
    // Never a bare id: an alert naming an id gives the reader nothing to go
    // and look for, and these messages are read by people holding a laptop.
    displayName: displayName ?? null,
    osFamily: osFamilyOf(record),
    serial: str(record['serialNumber']) ?? str(record['serial']) ?? null,
    lastContact: str(record['lastContact']) ?? null,
    fdeKeyPresent: keyPresent,
  }
}

/**
 * Which family of operating system this is.
 *
 * Explicit and closed: anything unrecognised is 'unknown' rather than being
 * folded into a default. An earlier design classified anything that
 * was not a Mac as Windows, which sent a Windows uninstaller to a Linux box.
 */
export function osFamilyOf(record: Record<string, unknown>): BoundDevice['osFamily'] {
  const declared = str(record['osFamily'])?.toLowerCase()
  if (declared === 'windows') return 'windows'
  if (declared === 'darwin' || declared === 'macos') return 'macos'
  if (declared === 'linux') return 'linux'

  const os = (str(record['os']) ?? '').toLowerCase()
  if (os.includes('windows')) return 'windows'
  if (os.includes('mac') || os.includes('darwin')) return 'macos'
  if (os.includes('linux') || os.includes('ubuntu') || os.includes('debian') || os.includes('centos')) {
    return 'linux'
  }
  return 'unknown'
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'an unreadable error'
}
