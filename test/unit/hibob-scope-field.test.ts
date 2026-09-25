import { describe, expect, it } from 'vitest'
import { readPerson, resolveFieldMap } from '../../src/hris/hibob/fields.ts'

const RECORD = {
  id: 'hr-1',
  email: 'jane.doe@example.com',
  displayName: 'Jane Doe',
  custom: { provisioning: { it: 'Provision' } },
}

describe('reading whether IT provisions for a person', () => {
  it('reads nobody as out of scope when no field is configured', () => {
    const map = resolveFieldMap()
    expect(readPerson(RECORD, map).inScope).toBeNull()
  })

  it('reads the configured value as in scope', () => {
    const map = resolveFieldMap({ scopeField: 'custom.provisioning.it', scopeInValues: ['Provision'] })
    expect(readPerson(RECORD, map).inScope).toBe(true)
  })

  it('reads any other value as out of scope', () => {
    const map = resolveFieldMap({ scopeField: 'custom.provisioning.it', scopeInValues: ['Provision'] })
    const driver = { ...RECORD, custom: { provisioning: { it: 'Do not provision' } } }
    expect(readPerson(driver, map).inScope).toBe(false)
  })

  // A person wrongly in scope costs a lookup; a person wrongly out of scope
  // costs their accounts never being closed. Unknown must lean the cheap way.
  it('reads a record with nothing at the path as unknown, which is treated as in scope', () => {
    const map = resolveFieldMap({ scopeField: 'custom.provisioning.it', scopeInValues: ['Provision'] })
    const blank = { ...RECORD, custom: {} }
    expect(readPerson(blank, map).inScope).toBeNull()
  })

  it('refuses a field with no in-scope values, which would silence every joiner', () => {
    expect(() => resolveFieldMap({ scopeField: 'custom.provisioning.it', scopeInValues: [] })).toThrow(/scopeInValues/)
  })

  it('accepts the renamed config keys for the id and the address', () => {
    const map = resolveFieldMap({ hrisId: 'root.employeeId', primaryEmail: 'root.workEmail' })
    expect(map.hrisId).toBe('root.employeeId')
    expect(map.primaryEmail).toBe('root.workEmail')
  })
})
