/**
 * Failure this prevents: a delivery assertion that stopped the work it was
 * meant to report on.
 *
 * Where one node feeds several branches, the platform runs them in order of
 * their position, topmost first, and an error anywhere ends the whole
 * execution. In an earlier design, adding a chat-delivery check
 * to every workflow put a node that can throw at the top of the canvas, so a
 * rejected post also stopped the audit push and the user notifications on the
 * sibling branches. Those branches had been the reliable half.
 *
 * Two rules come out of it. The branch that posts to chat is the last one, so
 * anything else has already run by the time it can throw. And nothing is queued
 * behind the assertion: after it, only further assertions and terminal nodes.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ERROR_WORKFLOW_NAME,
  bundleFiles,
  validateFiles,
  validateWorkflow,
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/validate.mjs'

interface Finding {
  rule: string
  message: string
}

const fixtureUrl = new URL('../fixtures/n8n/bad-slack-branch-first.json', import.meta.url)

/** A chat post, its assertion, and then more work queued behind the assertion. */
const workQueuedAfterTheAssertion = {
  name: 'jml-inline-fixture',
  active: false,
  settings: { executionOrder: 'v1', errorWorkflow: ERROR_WORKFLOW_NAME },
  nodes: [
    { name: 'Trigger', type: 'n8n-nodes-base.scheduleTrigger', parameters: {}, position: [0, 0] },
    {
      name: 'Post',
      type: 'n8n-nodes-base.slack',
      parameters: { channelId: { value: '={{ $env.SLACK_JML_CHANNEL_ID }}' } },
      position: [200, 0],
      credentials: { slackApi: { name: 'JML Slack Alerts' } },
    },
    {
      name: 'Delivered?',
      type: 'n8n-nodes-base.if',
      position: [400, 0],
      parameters: {
        conditions: {
          conditions: [
            { leftValue: '={{ $json.ok }}', rightValue: '', operator: { type: 'boolean', operation: 'true' } },
          ],
          combinator: 'and',
        },
      },
    },
    { name: 'Stop', type: 'n8n-nodes-base.stopAndError', parameters: {}, position: [600, -200] },
    {
      name: 'Push the audit rows',
      type: 'n8n-nodes-base.httpRequest',
      position: [600, 0],
      parameters: { method: 'POST', url: '={{ $env.JML_API_URL }}/v1/runs', options: { timeout: 30000 } },
      credentials: { httpHeaderAuth: { name: 'JML Toolkit API' } },
    },
  ],
  connections: {
    Trigger: { main: [[{ node: 'Post', type: 'main', index: 0 }]] },
    Post: { main: [[{ node: 'Delivered?', type: 'main', index: 0 }]] },
    'Delivered?': {
      main: [
        [{ node: 'Push the audit rows', type: 'main', index: 0 }],
        [{ node: 'Stop', type: 'main', index: 0 }],
      ],
    },
  },
}

describe('branch order around a chat post', () => {
  it('refuses a chat branch that runs before a sibling', () => {
    const { findings } = validateFiles([fileURLToPath(fixtureUrl)]) as { findings: Finding[] }
    expect(findings.map((f) => f.rule)).toContain('slack-branch-last')
  })

  it('refuses work queued behind the delivery assertion', () => {
    const findings = validateWorkflow(workQueuedAfterTheAssertion, 'inline') as Finding[]
    expect(findings.map((f) => f.rule)).toContain('assertion-last')
    expect(findings.find((f) => f.rule === 'assertion-last')?.message).toContain('Push the audit rows')
  })

  it('is not how the shipped bundle is laid out', () => {
    const { findings } = validateFiles(bundleFiles()) as { findings: Finding[] }
    expect(findings).toEqual([])
  })
})
