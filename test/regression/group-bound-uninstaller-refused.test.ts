/**
 * Regression: an uninstaller bound to a device group.
 *
 * A trigger fires on every association a command holds, so a command attached
 * to a device group runs on every member of that group. In an earlier design, an installer left attached to a whole device group turned a
 * push aimed at a handful of machines into twice as many results, and nobody
 * noticed until the counts were compared. The same shape on an uninstaller strips monitoring
 * from the whole fleet in one call.
 *
 * The rule: refuse before anything is attached and before anything is fired.
 * The refusal is a hard stop, not a warning that the run then continues past.
 */

import { describe, expect, it } from 'vitest'
import { JumpCloudClient } from '../../src/connectors/jumpcloud/client.ts'
import { CommandRefused, JumpCloudCommands } from '../../src/connectors/jumpcloud/commands.ts'
import { FakeHttp, fakeSecret, fakeTime } from '../fixtures/http/fake-http.ts'
import { COMMAND_ID, commandScenario, SYSTEM_ID } from '../fixtures/http/jumpcloud-command-scenario.ts'

function commands(http: FakeHttp) {
  const time = fakeTime()
  return new JumpCloudCommands({
    client: new JumpCloudClient({ http, apiKey: fakeSecret() }),
    sleep: time.sleep,
    now: time.now,
  })
}

const RUN = { commandId: COMMAND_ID, systemId: SYSTEM_ID, holdMs: 120_000, timeoutMs: 300_000 }

describe('a group-bound command is refused', () => {
  it('names the refusal in the pre-flight, which is what a dry run prints', async () => {
    const { http } = commandScenario({ groups: ['grp-all-windows'] })
    const preflight = await commands(http).preflightCommand(COMMAND_ID)
    expect(preflight.ok).toBe(false)
    expect(preflight.refusal).toBe('group_bound')
    expect(preflight.detail).toContain('every member')
  })

  it('refuses the run without attaching, firing or detaching anything', async () => {
    const { http, attached } = commandScenario({ groups: ['grp-all-windows'] })
    const err = await commands(http)
      .runOnOneDevice(RUN)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CommandRefused)
    expect((err as CommandRefused).refusal).toBe('group_bound')
    expect([...attached]).toEqual([])
    expect(http.requests.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('refuses on several group bindings just the same', async () => {
    const { http } = commandScenario({ groups: ['grp-all-windows', 'grp-site-a'] })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toMatchObject({ refusal: 'group_bound' })
  })

  it('does not try to tidy the group binding away, because that is not ours to change', async () => {
    const { http, groups } = commandScenario({ groups: ['grp-all-windows'] })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toThrow()
    expect([...groups]).toEqual(['grp-all-windows'])
  })
})
