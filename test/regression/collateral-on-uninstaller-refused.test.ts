/**
 * Regression: firing a command that already had somebody else's machine on it.
 *
 * Stale associations accumulate. A run that timed out, a console experiment, an
 * older automation that never detached: in an earlier design one
 * command had dozens of machines still attached to it. Firing that command
 * would have run its script on all of them.
 *
 * The device handover flow in this toolkit only ever fires an uninstaller, so
 * pre-existing associations are treated as an abort rather than being logged
 * and carried on past, which is what the source pipeline did.
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

describe('collateral associations abort the run', () => {
  it('names how many machines would have been hit', async () => {
    const { http } = commandScenario({ collateral: ['sys-90', 'sys-91'] })
    const preflight = await commands(http).preflightCommand(COMMAND_ID)
    expect(preflight.refusal).toBe('collateral_associations')
    expect(preflight.detail).toContain('2 device association')
  })

  it('refuses to fire, and leaves the other machines attached rather than detaching them', async () => {
    const { http, attached } = commandScenario({ collateral: ['sys-90'] })
    const err = await commands(http)
      .runOnOneDevice(RUN)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CommandRefused)
    expect((err as CommandRefused).refusal).toBe('collateral_associations')
    expect(http.sent('/command/trigger/')).toEqual([])
    // Somebody else's association may be a live job of theirs. Removing it to
    // clear our own path would be the same class of mistake in reverse.
    expect([...attached]).toEqual(['sys-90'])
  })

  it('refuses even when the collateral association is the machine we wanted', async () => {
    // A command already attached to our target is not a shortcut: something
    // else attached it, so something else may be about to fire it, and this run
    // could not tell its own receipt from theirs.
    const { http } = commandScenario({ collateral: [SYSTEM_ID] })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toMatchObject({
      refusal: 'collateral_associations',
    })
    expect(http.sent('/command/trigger/')).toEqual([])
  })
})
