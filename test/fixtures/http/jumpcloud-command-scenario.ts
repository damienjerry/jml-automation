/**
 * A stand-in for one command and one machine.
 *
 * The association list is real state rather than a scripted sequence: the POST
 * that attaches actually adds to it and the POST that detaches actually
 * removes from it. Tests about association hygiene are only worth anything if
 * the fake cannot accidentally agree with a connector that never detached.
 */

import { FakeHttp } from './fake-http.ts'

export const COMMAND_ID = 'cmd-uninstall-win'
export const TRIGGER = 'uninstallagentswindows'
export const SYSTEM_ID = 'sys-1'

export interface ScenarioOptions {
  /** Anything already attached, which the pre-flight must refuse. */
  collateral?: string[]
  /** Device groups the command is bound to, which the pre-flight must refuse. */
  groups?: string[]
  launchType?: string
  trigger?: string | null
  /** Make the detach fail, so a leak can be asserted. */
  detachStatus?: number
  /** Make the attach read-back lie, so the abort path can be asserted. */
  readBackEmptyAfterAttach?: boolean
  /** Result row and detail, or null for a machine that never answers. */
  result?: {
    requestTime: string
    responseTime?: string | null
    exitCode?: number | null
    output?: string
    /** For the case where the list endpoint disagrees with the detail. */
    listExitCode?: number | null
  } | null
  triggered?: string[]
  /** Replaces the result list entirely, for the wrong-row cases. */
  resultRows?: Record<string, unknown>[]
  /** Make the result poll fail, so the abort path can be asserted. */
  resultsStatus?: number
}

export function commandScenario(opts: ScenarioOptions = {}) {
  const attached = new Set<string>(opts.collateral ?? [])
  const groups = new Set<string>(opts.groups ?? [])
  const http = new FakeHttp()
  let attachedOnce = false

  http.on('GET', `/api/commands/${COMMAND_ID}`, {
    status: 200,
    body: {
      _id: COMMAND_ID,
      name: 'Offboard: remove monitoring agents (Windows)',
      launchType: opts.launchType ?? 'trigger',
      trigger: opts.trigger === undefined ? TRIGGER : opts.trigger,
      commandType: 'windows',
    },
  })

  // Registered before the plain system route, because the query string of one
  // is a prefix of the other.
  http.on('GET', `/api/v2/commands/${COMMAND_ID}/associations?targets=system_group`, () => ({
    status: 200,
    body: [...groups].map((id) => ({ to: { id, type: 'system_group' } })),
  }))

  http.on('GET', `/api/v2/commands/${COMMAND_ID}/associations?targets=system`, () => {
    if (opts.readBackEmptyAfterAttach && attachedOnce) return { status: 200, body: [] }
    return { status: 200, body: [...attached].map((id) => ({ to: { id, type: 'system' } })) }
  })

  http.on('POST', `/api/v2/commands/${COMMAND_ID}/associations`, (req) => {
    const body = req.body as { op: string; id: string }
    if (body.op === 'add') {
      attached.add(body.id)
      attachedOnce = true
      return { status: 204 }
    }
    if (opts.detachStatus && opts.detachStatus >= 300) return { status: opts.detachStatus }
    attached.delete(body.id)
    return { status: 204 }
  })

  http.on('POST', `/api/command/trigger/`, {
    status: 200,
    body: { triggered: opts.triggered ?? ['Offboard: remove monitoring agents (Windows)'] },
  })

  const result = opts.result === undefined ? DEFAULT_RESULT : opts.result
  const rows =
    opts.resultRows ??
    (result
      ? [
          {
            _id: 'res-1',
            workflowId: COMMAND_ID,
            systemId: SYSTEM_ID,
            requestTime: result.requestTime,
            // The list endpoint is deliberately allowed to disagree with the
            // detail endpoint, because in practice it does.
            exitCode: result.listExitCode ?? 0,
            output: 'AGENTS_REMOVED alloy=y...',
          },
        ]
      : [])
  http.on('GET', '/api/commandresults?', {
    status: opts.resultsStatus ?? 200,
    body: { results: rows },
  })

  http.on('GET', '/api/commandresults/res-1', () => ({
    status: 200,
    body: {
      _id: 'res-1',
      workflowId: COMMAND_ID,
      systemId: SYSTEM_ID,
      requestTime: result?.requestTime,
      responseTime: result?.responseTime === undefined ? '2026-01-05T09:00:20.000Z' : result.responseTime,
      response: {
        data: {
          exitCode: result?.exitCode === undefined ? 0 : result.exitCode,
          output: result?.output ?? 'AGENTS_REMOVED alloy=yes fleetd=absent',
        },
      },
    },
  }))

  return { http, attached, groups }
}

const DEFAULT_RESULT: NonNullable<ScenarioOptions['result']> = { requestTime: '2026-01-05T09:00:10.000Z' }
