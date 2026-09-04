import { describe, expect, it } from 'vitest'
import {
  capabilitiesFor,
  JUMPCLOUD_FORBIDDEN_CALLS,
  JUMPCLOUD_KEY_ROLES,
  JUMPCLOUD_READ_CAPABILITIES,
  JUMPCLOUD_WRITE_CAPABILITIES,
} from '../../src/connectors/jumpcloud/scopes.ts'

describe('the capability list is usable by doctor and by the docs', () => {
  it('describes every call it names', () => {
    for (const capability of [...JUMPCLOUD_READ_CAPABILITIES, ...JUMPCLOUD_WRITE_CAPABILITIES]) {
      expect(capability.path.startsWith('/')).toBe(true)
      expect(capability.purpose.length).toBeGreaterThan(10)
      expect(capability.usedBy).toMatch(/^connectors\/jumpcloud\//)
    }
  })

  it('keeps the reads read-only, so a report-only deployment is honest', () => {
    for (const capability of JUMPCLOUD_READ_CAPABILITIES) {
      expect(capability.method).toBe('GET')
    }
  })

  it('puts the whole device gate in the read set', () => {
    const gate = JUMPCLOUD_READ_CAPABILITIES.filter((c) => c.usedBy.endsWith('devices.ts'))
    expect(gate.length).toBeGreaterThanOrEqual(3)
  })

  it('names the armed action every write belongs to', () => {
    const actions = new Set(JUMPCLOUD_WRITE_CAPABILITIES.map((c) => c.armedAction))
    expect(actions).toEqual(new Set(['suspend', 'delete', 'device_unbind', 'device_handover']))
  })

  it('needs nothing beyond the reads when nothing is armed', () => {
    expect(capabilitiesFor([])).toEqual(JUMPCLOUD_READ_CAPABILITIES)
  })

  it('adds only the writes for the actions that are armed', () => {
    const forSuspendOnly = capabilitiesFor(['suspend'])
    const writes = forSuspendOnly.filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(1)
    expect(writes.at(0)?.path).toBe('/systemusers/{id}')
  })

  it('records the two calls this connector must never make', () => {
    const calls = JUMPCLOUD_FORBIDDEN_CALLS.map((f) => f.call)
    expect(calls.some((c) => c.startsWith('PUT /commands/'))).toBe(true)
    expect(calls.some((c) => c.includes('systems array in the body'))).toBe(true)
    for (const forbidden of JUMPCLOUD_FORBIDDEN_CALLS) {
      expect(forbidden.reason.length).toBeGreaterThan(20)
    }
  })

  it('explains each key role a doctor row can report', () => {
    expect(Object.keys(JUMPCLOUD_KEY_ROLES).sort()).toEqual(['reader', 'unknown', 'writer'])
  })
})
