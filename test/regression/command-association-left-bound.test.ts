/**
 * Regression: an uninstall command left attached to somebody's machine.
 *
 * In the automation this was ported from, the detach was the last statement of
 * a happy path rather than a `finally`. A read-back that threw, or a foreground
 * timeout, therefore returned with the command still attached to a laptop. That
 * machine then took the command every time anything else fired it: one laptop
 * was restarted daily for over a week before the cause was found, and the same
 * shape on an uninstaller would have stripped its agents.
 *
 * The rules this file protects: detach in a `finally` whatever happened, prove
 * the detach by re-reading the associations, and treat an unproven detach as an
 * alarm rather than as a successful run.
 */

import { describe, expect, it } from 'vitest'
import { AssociationLeak, JumpCloudCommands } from '../../src/connectors/jumpcloud/commands.ts'
import { JumpCloudClient } from '../../src/connectors/jumpcloud/client.ts'
import { FakeHttp, fakeSecret, fakeTime } from '../fixtures/http/fake-http.ts'
import { COMMAND_ID, commandScenario, SYSTEM_ID } from '../fixtures/http/jumpcloud-command-scenario.ts'

const RUN = { commandId: COMMAND_ID, systemId: SYSTEM_ID, holdMs: 120_000, timeoutMs: 300_000 }

function commands(http: FakeHttp, onLeak?: (l: { reason: string }) => void) {
  const time = fakeTime()
  return new JumpCloudCommands({
    client: new JumpCloudClient({ http, apiKey: fakeSecret() }),
    sleep: time.sleep,
    now: time.now,
    pollMs: 15_000,
    ...(onLeak ? { onLeak } : {}),
  })
}

describe('the association always comes off', () => {
  it('detaches after a successful run', async () => {
    const { http, attached } = commandScenario()
    await commands(http).runOnOneDevice(RUN)
    expect([...attached]).toEqual([])
  })

  it('detaches when the machine never answered and the wait timed out', async () => {
    const { http, attached } = commandScenario({ result: null })
    const receipt = await commands(http).runOnOneDevice({ ...RUN, timeoutMs: 60_000 })
    expect(receipt.received).toBe(false)
    expect([...attached]).toEqual([])
  })

  it('detaches when something threw between attaching and firing', async () => {
    const { http, attached } = commandScenario({ readBackEmptyAfterAttach: true })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toThrow()
    expect([...attached]).toEqual([])
  })

  it('detaches when the trigger itself failed', async () => {
    const { http, attached } = commandScenario({ triggered: [] })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toThrow()
    expect([...attached]).toEqual([])
  })
})

describe('an unproven detach is an alarm, not a quiet success', () => {
  it('throws and reports when the detach was refused', async () => {
    const leaks: { reason: string }[] = []
    const { http, attached } = commandScenario({ detachStatus: 503 })
    await expect(commands(http, (l) => leaks.push(l)).runOnOneDevice(RUN)).rejects.toBeInstanceOf(AssociationLeak)
    // The machine is genuinely still attached, which is exactly what the
    // caller has to be told rather than being handed a receipt.
    expect([...attached]).toEqual([SYSTEM_ID])
    expect(leaks.at(0)?.reason).toContain('503')
  })

  it('throws when the detach was accepted and the machine is still listed', async () => {
    const http = new FakeHttp()
      .on('GET', `/api/commands/${COMMAND_ID}`, {
        status: 200,
        body: { _id: COMMAND_ID, name: 'Remove agents', launchType: 'trigger', trigger: 'uninstallagentswindows' },
      })
      .on('GET', `/api/v2/commands/${COMMAND_ID}/associations?targets=system_group`, { status: 200, body: [] })
      .on('GET', `/api/v2/commands/${COMMAND_ID}/associations?targets=system`, (_req, hit) =>
        // Empty at pre-flight, then attached for ever afterwards: an accepted
        // remove that changed nothing, which is the 200-is-not-an-effect case
        // applied to associations.
        hit === 1 ? { status: 200, body: [] } : { status: 200, body: [{ to: { id: SYSTEM_ID } }] },
      )
      .on('POST', `/api/v2/commands/${COMMAND_ID}/associations`, { status: 204 })
      .on('POST', '/api/command/trigger/', { status: 200, body: { triggered: ['Remove agents'] } })
      .on('GET', '/api/commandresults?', { status: 200, body: { results: [] } })

    const leaks: { reason: string }[] = []
    await expect(commands(http, (l) => leaks.push(l)).runOnOneDevice({ ...RUN, timeoutMs: 30_000 })).rejects.toBeInstanceOf(
      AssociationLeak,
    )
    expect(leaks.at(0)?.reason).toContain('still listed')
  })

  it('reports a leak even when the run failed for another reason', async () => {
    const leaks: { reason: string }[] = []
    const { http } = commandScenario({ triggered: [], detachStatus: 500 })
    await expect(commands(http, (l) => leaks.push(l)).runOnOneDevice(RUN)).rejects.toThrow()
    // The trigger failure is what propagates, so the leak has to be announced
    // through the callback or it is lost entirely.
    expect(leaks).toHaveLength(1)
  })
})
