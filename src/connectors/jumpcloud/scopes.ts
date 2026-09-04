/**
 * What the identity provider's API key must be able to do.
 *
 * The provider has no scope grammar: one admin key inherits whatever its
 * owner's admin role allows, so "scope" here means the set of calls this
 * toolkit actually makes. Writing them down has two uses. `jml doctor` names
 * the exact call an adopter's key was refused on rather than reporting a bare
 * 403, and docs/credentials.md is generated from this list so the documented
 * permissions cannot drift from the code.
 *
 * The split matters because a report-only deployment is a legitimate way to
 * adopt this toolkit. A read-only admin key satisfies the whole read set, and
 * every mutating leg then records itself as unarmed. Nothing in the read set
 * changes anything, so an adopter can run the sync, the detection and the
 * device gate before deciding to arm a single action.
 */

/** One call, and why it exists. */
export interface JumpCloudCapability {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path template, with the same placeholders the vendor's own docs use. */
  path: string
  /** What the toolkit uses it for, in an adopter's terms. */
  purpose: string
  /** The module that makes the call, so a refusal points somewhere. */
  usedBy: string
}

/**
 * Reads. A read-only admin key is enough for all of these.
 *
 * The device gate lives entirely in this set, which is the point: the check
 * that refuses to delete an account while somebody still holds a laptop needs
 * no write permission at all.
 */
export const JUMPCLOUD_READ_CAPABILITIES: readonly JumpCloudCapability[] = [
  {
    method: 'GET',
    path: '/systemusers',
    purpose: 'find an account by address, and prove the key can read the directory',
    usedBy: 'connectors/jumpcloud/users.ts',
  },
  {
    method: 'GET',
    path: '/systemusers/{id}',
    purpose: 'read a stored account id back, and verify a suspension actually applied',
    usedBy: 'connectors/jumpcloud/users.ts',
  },
  {
    method: 'GET',
    path: '/v2/users/{id}/systems',
    purpose: 'list the machines a person can reach, as the first half of the device gate',
    usedBy: 'connectors/jumpcloud/devices.ts',
  },
  {
    method: 'GET',
    path: '/v2/systems/{id}/associations?targets=user',
    purpose: 'tell custody of a machine from group-derived access, as the second half of the gate',
    usedBy: 'connectors/jumpcloud/devices.ts',
  },
  {
    method: 'GET',
    path: '/systems/{id}',
    purpose: 'name a device in an alert, and read its last contact and whether its recovery key is escrowed',
    usedBy: 'connectors/jumpcloud/devices.ts',
  },
  {
    method: 'GET',
    path: '/commands',
    purpose: 'resolve a configured trigger name to a command',
    usedBy: 'connectors/jumpcloud/commands.ts',
  },
  {
    method: 'GET',
    path: '/commands/{id}',
    purpose: 'read a command definition, to refuse one whose launch type cannot be triggered',
    usedBy: 'connectors/jumpcloud/commands.ts',
  },
  {
    method: 'GET',
    path: '/v2/commands/{id}/associations?targets=system',
    purpose: 'refuse a command that already holds device associations somebody else owns',
    usedBy: 'connectors/jumpcloud/commands.ts',
  },
  {
    method: 'GET',
    path: '/v2/commands/{id}/associations?targets=system_group',
    purpose: 'refuse a command bound to a device group, because a trigger fires on every member',
    usedBy: 'connectors/jumpcloud/commands.ts',
  },
  {
    method: 'GET',
    path: '/commandresults',
    purpose: "find this run's own result row",
    usedBy: 'connectors/jumpcloud/commands.ts',
  },
  {
    method: 'GET',
    path: '/commandresults/{id}',
    purpose: 'read the exit code and full output, which the list endpoint truncates and misreports',
    usedBy: 'connectors/jumpcloud/commands.ts',
  },
]

/**
 * Writes. Each one names the armed action that needs it.
 *
 * An adopter can therefore grant a writing key and still arm nothing, or arm
 * only the unbind and leave deletion to a human, and this table says exactly
 * what that costs.
 */
export const JUMPCLOUD_WRITE_CAPABILITIES: readonly (JumpCloudCapability & { armedAction: string })[] = [
  {
    method: 'PUT',
    path: '/systemusers/{id}',
    purpose: 'suspend an account on the leaving date',
    usedBy: 'connectors/jumpcloud/users.ts',
    armedAction: 'suspend',
  },
  {
    method: 'DELETE',
    path: '/systemusers/{id}',
    purpose: 'delete the account once the device gate is clear',
    usedBy: 'connectors/jumpcloud/users.ts',
    armedAction: 'delete',
  },
  {
    method: 'POST',
    path: '/v2/systems/{id}/associations',
    purpose: 'detach a leaver from a machine, or attach its next owner, so the device gate can clear',
    usedBy: 'connectors/jumpcloud/devices.ts',
    armedAction: 'device_unbind',
  },
  {
    method: 'POST',
    path: '/v2/commands/{id}/associations',
    purpose: 'attach exactly one machine to a command, and detach it again afterwards',
    usedBy: 'connectors/jumpcloud/commands.ts',
    armedAction: 'device_handover',
  },
  {
    method: 'POST',
    path: '/command/trigger/{name}',
    purpose: 'run the configured uninstall script on the attached machine',
    usedBy: 'connectors/jumpcloud/commands.ts',
    armedAction: 'device_handover',
  },
  {
    method: 'DELETE',
    path: '/systems/{id}',
    purpose: 'remove the device record after an on-device receipt has proved the agents are gone',
    usedBy: 'connectors/jumpcloud/devices.ts',
    armedAction: 'device_handover',
  },
]

/**
 * Calls this toolkit deliberately never makes, and why.
 *
 * Recorded here rather than only in a comment because both were real defects
 * that answered 200, and somebody reading the capability list is exactly the
 * person about to reintroduce them.
 */
export const JUMPCLOUD_FORBIDDEN_CALLS: readonly { call: string; reason: string }[] = [
  {
    call: 'PUT /commands/{id}',
    reason:
      'a write carrying only some fields answers 200 and resets the rest to defaults, which silently changes a command type and launch mode and leaves it unfireable',
  },
  {
    call: 'POST /command/trigger/{name} with a systems array in the body',
    reason:
      'the target list in the body is ignored, so it reads as targeting while the command fires on every association it holds',
  },
]

/** The capabilities a deployment needs, given what it has armed. */
export function capabilitiesFor(armedActions: readonly string[]): readonly JumpCloudCapability[] {
  const writes = JUMPCLOUD_WRITE_CAPABILITIES.filter((c) => armedActions.includes(c.armedAction))
  return [...JUMPCLOUD_READ_CAPABILITIES, ...writes]
}

/** What a detected key role can and cannot do, for the doctor table. */
export const JUMPCLOUD_KEY_ROLES = {
  reader: 'reads everything this toolkit needs, including the device gate; cannot arm any action',
  writer: 'reads and writes; required for suspend, delete, unbind and handover',
  unknown: 'the role probe was inconclusive, so treat an armed run as unproven until doctor passes',
} as const
