/**
 * Failure this prevents: a scrubbed export that still says which estate it came
 * from.
 *
 * The first scrub tool removed ids, static data and pinned data and passed the
 * rest through. A recheck before publishing found what an export still
 * carries after that: the instance timezone and caller policy in `settings`,
 * credentials named after the live systems they authenticate to, the channel
 * name and workspace URL a chat node caches when a channel is picked from a
 * list, and a fixed form path. None of it is a secret and all of it names the
 * estate. The inbound ticket webhook also shipped asking for header auth with
 * no credential, so it imported unbound. The scrub tool now removes or renames
 * each of these, and the validator rejects every one, so a hand-edited file
 * cannot bring them back.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error - no type declarations for a .mjs tool
import { scrub } from '../../n8n/scrub-export.mjs'
// @ts-expect-error - no type declarations for a .mjs tool
import { validateWorkflow } from '../../n8n/validate.mjs'

type Finding = { rule: string; message: string }
type Node = { name: string; parameters: Record<string, unknown>; credentials: Record<string, { name: string }> }
type Scrubbed = { clean: { settings: Record<string, unknown>; nodes: Node[] }; removed: string[] }

function fingerprinted(): Record<string, unknown> {
  return {
    name: 'jml-leaver-manual',
    active: false,
    settings: {
      executionOrder: 'v1',
      errorWorkflow: 'jml-on-error',
      timezone: 'Europe/London',
      callerPolicy: 'workflowsFromSameOwner',
      callerIds: '12,14',
      timeSavedPerExecution: 5,
    },
    nodes: [
      {
        name: 'Leaver request',
        type: 'n8n-nodes-base.formTrigger',
        typeVersion: 2,
        position: [0, 0],
        parameters: { path: 'offboard-now', authentication: 'basicAuth', formTitle: 'Offboard' },
        credentials: { httpBasicAuth: { name: 'Ticketing Bridge Live' } },
      },
      {
        name: 'Inbound',
        type: 'n8n-nodes-base.webhook',
        typeVersion: 2,
        position: [0, 200],
        parameters: { httpMethod: 'POST', path: 'jml-ticket-inbound', authentication: 'headerAuth' },
      },
      {
        name: 'Tell IT',
        type: 'n8n-nodes-base.slack',
        typeVersion: 2,
        position: [200, 0],
        parameters: {
          channelId: { __rl: true, mode: 'list', value: '={{ $env.SLACK_JML_CHANNEL_ID }}', cachedResultName: 'it-leavers', cachedResultUrl: 'https://workspace.slack.com/archives/X' },
        },
        credentials: { slackApi: { name: 'IT Bot (prod)' } },
      },
    ],
    connections: {},
  }
}

const rules = (doc: unknown): string[] => (validateWorkflow(doc, 'test') as Finding[]).map((f) => f.rule)

describe('an export carrying instance fingerprints', () => {
  it('is rejected by the validator on every one', () => {
    const found = rules(fingerprinted())
    expect(found).toEqual(expect.arrayContaining(['instance-settings', 'credential-name', 'no-locator-cache', 'no-form-path', 'form-authenticated']))
  })

  it('comes out of the scrub tool without them', () => {
    const { clean, removed } = scrub(fingerprinted()) as Scrubbed
    expect(Object.keys(clean.settings).sort()).toEqual(['errorWorkflow', 'executionOrder'])
    const form = clean.nodes.find((n) => n.name === 'Leaver request')!
    expect(form.parameters['path']).toBeUndefined()
    expect(form.credentials['httpBasicAuth']?.name).toBe('JML Form Access')
    const slack = clean.nodes.find((n) => n.name === 'Tell IT')!
    expect(JSON.stringify(slack.parameters)).not.toMatch(/cachedResult/)
    expect(slack.credentials['slackApi']?.name).toBe('JML Slack Alerts')
    expect(removed.join('\n')).toMatch(/settings\.timezone/)
    expect(JSON.stringify(clean)).not.toMatch(/Ticketing Bridge Live|IT Bot \(prod\)|it-leavers|Europe\/London/)
  })

  it('still needs a credential on an authenticated webhook, which the scrub cannot invent', () => {
    const { clean } = scrub(fingerprinted()) as { clean: unknown }
    const left = (validateWorkflow(clean, 'test') as Finding[]).filter((f) => f.rule === 'form-authenticated')
    expect(left.map((f) => f.message).join(' ')).toMatch(/names no credential/)
  })
})
