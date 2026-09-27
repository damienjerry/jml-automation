/**
 * The time zone question wanted a name nobody types, and checked nothing.
 *
 * The wizard asked for an "IANA name" with no example and no check, so
 * "London" or "Europe/Londn" was written to the configuration, and the first
 * date calculation threw. Found by trying the setup preview. The wizard now
 * keeps the machine's own zone on Enter and takes a city otherwise, and the
 * configuration loader refuses a zone the runtime does not know.
 */
import { describe, expect, it } from 'vitest'
import { askTimeZone, isTimeZone } from '../../src/cli/commands/setup/questions.ts'
import { scriptedPrompter } from '../../src/cli/commands/setup/prompter.ts'
import { leaverConfig } from '../fixtures/leaver/harness.ts'

const ORG = { name: 'Example Organisation', primaryDomain: 'example.com', itTeamSignature: 'IT Team' }

describe('the time zone', () => {
  it('is accepted as Region/City, and refused as a city alone or a typo', () => {
    for (const zone of ['Europe/London', 'America/New_York', 'Australia/Sydney']) expect(isTimeZone(zone)).toBe(true)
    for (const zone of ['London', 'Europe/Londn', 'GMT+1 London', '']) expect(isTimeZone(zone)).toBe(false)
  })

  it('is asked as a city: Enter keeps the detected zone, a city is looked up, an unknown one asks again', async () => {
    const ask = (answers: string[]) => askTimeZone(scriptedPrompter(answers), () => {}, 'Europe/London')
    expect(await ask([''])).toBe('Europe/London')
    expect(await ask(['new york'])).toBe('America/New_York')
    expect(await ask(['Atlantis', 'Paris'])).toBe('Europe/Paris')
    expect(await ask(['sao', '2'])).toBe('America/Sao_Paulo')
  })

  it('refuses to load a configuration that names an unknown zone', () => {
    expect(() => leaverConfig({ org: { ...ORG, timezone: 'London' } })).toThrow(/Region\/City/)
    expect(() => leaverConfig({ org: { ...ORG, timezone: 'Europe/London' } })).not.toThrow()
  })
})
