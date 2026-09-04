import { describe, expect, it } from 'vitest'
import { JumpCloudClient } from '../../src/connectors/jumpcloud/client.ts'
import {
  AssociationLeak,
  CommandRefused,
  DuplicateTrigger,
  JumpCloudCommands,
  toCommand,
} from '../../src/connectors/jumpcloud/commands.ts'
import { GateError } from '../../src/connectors/types.ts'
import { FakeHttp, fakeSecret, fakeTime } from '../fixtures/http/fake-http.ts'
import { COMMAND_ID, commandScenario, SYSTEM_ID, TRIGGER } from '../fixtures/http/jumpcloud-command-scenario.ts'

function commands(http: FakeHttp, time = fakeTime(), onLeak?: (l: { reason: string }) => void) {
  return new JumpCloudCommands({
    client: new JumpCloudClient({ http, apiKey: fakeSecret() }),
    sleep: time.sleep,
    now: time.now,
    pollMs: 15_000,
    ...(onLeak ? { onLeak } : {}),
  })
}

const RUN = { commandId: COMMAND_ID, systemId: SYSTEM_ID, holdMs: 120_000, timeoutMs: 600_000 }

describe('resolveCommand', () => {
  it('finds the command an adopter named by trigger', async () => {
    const http = new FakeHttp().on('GET', '/api/commands', {
      status: 200,
      body: { results: [{ _id: COMMAND_ID, name: 'Remove agents', launchType: 'trigger', trigger: TRIGGER }] },
    })
    expect(await commands(http).resolveCommand(TRIGGER)).toMatchObject({ id: COMMAND_ID, launchType: 'trigger' })
  })

  it('is null when nothing carries that trigger', async () => {
    const http = new FakeHttp().on('GET', '/api/commands', { status: 200, body: { results: [] } })
    expect(await commands(http).resolveCommand(TRIGGER)).toBeNull()
  })

  it('throws when two commands share a trigger, because one might be the uninstaller', async () => {
    const http = new FakeHttp().on('GET', '/api/commands', {
      status: 200,
      body: {
        results: [
          { _id: 'cmd-a', name: 'A', launchType: 'trigger', trigger: TRIGGER },
          { _id: 'cmd-b', name: 'B', launchType: 'trigger', trigger: TRIGGER },
        ],
      },
    })
    const err = await commands(http)
      .resolveCommand(TRIGGER)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DuplicateTrigger)
    expect((err as DuplicateTrigger).matches).toHaveLength(2)
  })

  it('ignores a row that carries no id', () => {
    expect(toCommand({ name: 'no id' })).toBeNull()
    expect(toCommand(null)).toBeNull()
    expect(toCommand({ _id: 'cmd-x' })).toMatchObject({ name: 'cmd-x', launchType: '', trigger: null })
  })
})

describe('preflightCommand', () => {
  it('passes a trigger command with no bindings at all', async () => {
    const { http } = commandScenario()
    expect(await commands(http).preflightCommand(COMMAND_ID)).toEqual({ ok: true })
  })

  it('refuses a command bound to a device group', async () => {
    const { http } = commandScenario({ groups: ['grp-all-windows'] })
    expect(await commands(http).preflightCommand(COMMAND_ID)).toMatchObject({ ok: false, refusal: 'group_bound' })
  })

  it("refuses a command that already holds somebody else's machine", async () => {
    const { http } = commandScenario({ collateral: ['sys-99'] })
    expect(await commands(http).preflightCommand(COMMAND_ID)).toMatchObject({
      ok: false,
      refusal: 'collateral_associations',
    })
  })

  it('refuses a command that cannot be fired by trigger', async () => {
    const { http } = commandScenario({ launchType: 'manual' })
    expect(await commands(http).preflightCommand(COMMAND_ID)).toMatchObject({ ok: false, refusal: 'not_a_trigger' })
  })

  it('reports a command that is not there', async () => {
    const http = new FakeHttp().on('GET', `/api/commands/${COMMAND_ID}`, { status: 404, body: null })
    expect(await commands(http).preflightCommand(COMMAND_ID)).toMatchObject({ refusal: 'command_not_found' })
  })

  it('throws when a refusal cannot be evaluated, rather than passing', async () => {
    const http = new FakeHttp()
      .on('GET', `/api/commands/${COMMAND_ID}`, { status: 200, body: { _id: COMMAND_ID, launchType: 'trigger' } })
      .on('GET', `/api/v2/commands/${COMMAND_ID}/associations`, { status: 500, text: 'boom' })
    await expect(commands(http).preflightCommand(COMMAND_ID)).rejects.toBeInstanceOf(GateError)
  })

  it('throws when the command itself cannot be read', async () => {
    const http = new FakeHttp().on('GET', `/api/commands/${COMMAND_ID}`, { status: 503, text: 'boom' })
    await expect(commands(http).preflightCommand(COMMAND_ID)).rejects.toBeInstanceOf(GateError)
  })
})

describe('runOnOneDevice, the sequence in full', () => {
  it('attaches, fires, reads the receipt from the detail endpoint and detaches', async () => {
    const { http, attached } = commandScenario()
    const receipt = await commands(http).runOnOneDevice(RUN)

    expect(receipt).toEqual({
      received: true,
      completed: true,
      exitCode: 0,
      output: 'AGENTS_REMOVED alloy=yes fleetd=absent',
    })
    expect([...attached]).toEqual([])
  })

  it('never sends a target list in the trigger body, because the provider ignores it', async () => {
    const { http } = commandScenario()
    await commands(http).runOnOneDevice(RUN)
    const fired = http.sent(`/command/trigger/${TRIGGER}`)
    expect(fired).toHaveLength(1)
    expect(fired.at(0)?.body).toEqual({})
    expect(JSON.stringify(fired.at(0)?.body)).not.toContain('systems')
  })

  it('never writes to the command definition, which a partial write would disarm', async () => {
    const { http } = commandScenario()
    await commands(http).runOnOneDevice(RUN)
    expect(http.requests.filter((r) => r.method === 'PUT')).toEqual([])
  })

  it('holds the attachment for the configured time before detaching', async () => {
    const time = fakeTime()
    const { http } = commandScenario()
    await commands(http, time).runOnOneDevice(RUN)
    // A completed receipt arrives on the first poll here, so the whole hold
    // has to come from the deliberate wait rather than from polling.
    expect(time.total()).toBeGreaterThanOrEqual(120_000)
  })

  it('refuses before attaching anything when the command is group-bound', async () => {
    const { http, attached } = commandScenario({ groups: ['grp-all-windows'] })
    const err = await commands(http)
      .runOnOneDevice(RUN)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CommandRefused)
    expect((err as CommandRefused).refusal).toBe('group_bound')
    expect([...attached]).toEqual([])
    expect(http.sent('/command/trigger/')).toEqual([])
  })

  it('refuses a command with no trigger name', async () => {
    const { http } = commandScenario({ trigger: null })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toMatchObject({ refusal: 'no_trigger_name' })
  })

  it('refuses a command that is not there', async () => {
    const http = new FakeHttp().on('GET', `/api/commands/${COMMAND_ID}`, { status: 404, body: null })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toMatchObject({ refusal: 'command_not_found' })
  })

  it('aborts without firing when the attachment did not persist, and still detaches', async () => {
    const { http } = commandScenario({ readBackEmptyAfterAttach: true })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toBeInstanceOf(GateError)
    expect(http.sent('/command/trigger/')).toEqual([])
    const detaches = http.requests.filter((r) => r.method === 'POST' && (r.body as { op?: string }).op === 'remove')
    expect(detaches).toHaveLength(1)
  })

  it('aborts when the attach itself is refused', async () => {
    const http = new FakeHttp()
      .on('GET', `/api/commands/${COMMAND_ID}`, {
        status: 200,
        body: { _id: COMMAND_ID, launchType: 'trigger', trigger: TRIGGER },
      })
      .on('GET', `/api/v2/commands/${COMMAND_ID}/associations`, { status: 200, body: [] })
      .on('POST', `/api/v2/commands/${COMMAND_ID}/associations`, { status: 403, text: 'read only' })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toBeInstanceOf(GateError)
    // Nothing was attached, so nothing needed detaching and nothing fired.
    expect(http.sent('/command/trigger/')).toEqual([])
  })

  it('treats a trigger that dispatched nothing as a failure', async () => {
    const { http, attached } = commandScenario({ triggered: [] })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toBeInstanceOf(GateError)
    expect([...attached]).toEqual([])
  })
})

describe('receipts', () => {
  it('reports a collected command as received but not completed', async () => {
    // A result row exists the moment the machine collects the command. The
    // exit code and the response time only appear when the script finishes,
    // and a collected install that never returned once read as a success.
    const { http } = commandScenario({
      result: { requestTime: '2026-01-05T09:00:10.000Z', responseTime: null, exitCode: null },
    })
    const receipt = await commands(http).runOnOneDevice({ ...RUN, timeoutMs: 60_000 })
    expect(receipt).toMatchObject({ received: true, completed: false, exitCode: null })
  })

  it('reports nothing received when the machine never answers', async () => {
    const { http } = commandScenario({ result: null })
    const receipt = await commands(http).runOnOneDevice({ ...RUN, timeoutMs: 45_000 })
    expect(receipt).toEqual({ received: false, completed: false, exitCode: null, output: null })
  })

  it('ignores a result row from before this run fired', async () => {
    const { http } = commandScenario({ result: { requestTime: '2026-01-05T08:00:00.000Z' } })
    expect(await commands(http).runOnOneDevice({ ...RUN, timeoutMs: 30_000 })).toMatchObject({ received: false })
  })

  it('ignores a result row belonging to another command on the same machine', async () => {
    // A payload from an unrelated command on the same machine was once
    // reported as this run's success, which is why the command id is part of
    // the match and not just the machine and the time.
    const { http } = commandScenario({
      resultRows: [
        {
          _id: 'res-other',
          workflowId: 'cmd-something-else',
          systemId: SYSTEM_ID,
          requestTime: '2026-01-05T09:00:10.000Z',
        },
      ],
    })
    expect(await commands(http).runOnOneDevice({ ...RUN, timeoutMs: 20_000 })).toMatchObject({ received: false })
    expect(http.sent('/api/commandresults/res-other')).toEqual([])
  })

  it('ignores a result row for a different machine', async () => {
    const { http } = commandScenario({
      resultRows: [
        { _id: 'res-2', workflowId: COMMAND_ID, systemId: 'sys-2', requestTime: '2026-01-05T09:00:10.000Z' },
      ],
    })
    expect(await commands(http).runOnOneDevice({ ...RUN, timeoutMs: 20_000 })).toMatchObject({ received: false })
  })

  it('throws when the result poll cannot be read', async () => {
    const { http } = commandScenario({ resultsStatus: 503 })
    await expect(commands(http).runOnOneDevice(RUN)).rejects.toBeInstanceOf(GateError)
  })
})

describe('the leak alarm', () => {
  it('throws and reports when the detach was refused', async () => {
    const leaks: { reason: string }[] = []
    const { http } = commandScenario({ detachStatus: 500 })
    const err = await commands(http, fakeTime(), (l) => leaks.push(l))
      .runOnOneDevice(RUN)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AssociationLeak)
    expect(leaks).toHaveLength(1)
    expect(leaks.at(0)?.reason).toContain('500')
  })
})
