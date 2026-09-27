/**
 * Failure this prevents: a failed scheduled run that nobody heard about.
 *
 * In an earlier design, not one workflow named an error
 * workflow, so a red execution was visible only to somebody already looking at
 * the executions list, and nobody looks at a job that usually works. A daily
 * job failed on the same step for months and was found by accident.
 *
 * Two halves, and both are enforced. The four working workflows must name the
 * error workflow. The error workflow itself must not name one, because it would
 * name itself, and a failure inside it would then spend its time alerting on
 * being unable to alert. Its own last line of defence is the assertion on its
 * chat post, which turns an undelivered alert into a red execution.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

interface Workflow {
  name: string
  settings: Record<string, unknown>
  nodes: Array<{ name: string; type: string }>
  connections: Record<string, unknown>
  active: boolean
}

const read = (path: string): Workflow => JSON.parse(readFileSync(path, 'utf8')) as Workflow
const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/n8n/${name}`, import.meta.url))

describe('a workflow with nowhere to report a failure', () => {
  it('is refused', () => {
    const { findings } = validateFiles([fixture('bad-missing-error-workflow.json')]) as { findings: Finding[] }
    expect(findings.map((f) => f.rule)).toEqual(['error-workflow'])
  })

  it('is refused when it names itself instead', () => {
    const selfReferential = {
      name: 'jml-on-error',
      active: false,
      settings: { executionOrder: 'v1', errorWorkflow: ERROR_WORKFLOW_NAME },
      nodes: [{ name: 'Failed', type: 'n8n-nodes-base.errorTrigger', parameters: {}, position: [0, 0] }],
      connections: {},
    }
    const findings = validateWorkflow(selfReferential, 'inline') as Finding[]
    expect(findings.map((f) => f.rule)).toEqual(['error-workflow'])
  })

  it('is not what the toolkit ships', () => {
    const workflows = (bundleFiles() as string[]).map(read)
    const errorWorkflows = workflows.filter((w) => w.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger'))
    expect(errorWorkflows).toHaveLength(1)

    for (const workflow of workflows) {
      if (errorWorkflows.includes(workflow)) expect(workflow.settings.errorWorkflow).toBeUndefined()
      else expect(workflow.settings.errorWorkflow).toBe(ERROR_WORKFLOW_NAME)
    }
  })

  it('leaves the error workflow able to report its own failure', () => {
    const onError = (bundleFiles() as string[]).map(read).find((w) => w.name === ERROR_WORKFLOW_NAME)
    expect(onError?.nodes.map((n) => n.type)).toContain('n8n-nodes-base.stopAndError')
  })
})
