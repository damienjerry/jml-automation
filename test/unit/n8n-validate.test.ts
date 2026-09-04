import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  ALLOWED_ENV_VARS,
  ALLOWED_NODE_TYPES,
  DEVICE_ROUTE_TIMEOUT_MS,
  ERROR_WORKFLOW_NAME,
  bundleFiles,
  main,
  validateFiles,
  validateWorkflow,
  // The gate is plain JavaScript because CI runs it on a fresh clone with
  // nothing built, and because an adopter can read it without a toolchain.
  // @ts-expect-error - no type declarations for a .mjs tool
} from '../../n8n/validate.mjs'

interface Finding {
  file: string
  rule: string
  message: string
}

interface Workflow {
  name: string
  active: boolean
  settings: Record<string, unknown>
  nodes: Array<{
    name: string
    type: string
    parameters?: Record<string, unknown>
    credentials?: Record<string, Record<string, unknown>>
  }>
}

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/n8n/${name}`, import.meta.url))

const shipped = (): Workflow[] =>
  (bundleFiles() as string[]).map((path: string) => JSON.parse(readFileSync(path, 'utf8')) as Workflow)

const rulesFor = (name: string): string[] =>
  (validateFiles([fixture(name)]) as { findings: Finding[] }).findings.map((f) => f.rule)

describe('the shipped bundle', () => {
  it('passes its own gate', () => {
    const { checked, findings } = validateFiles(bundleFiles()) as { checked: number; findings: Finding[] }
    expect(checked).toBe(5)
    expect(findings).toEqual([])
  })

  it('ships the five workflows the documentation describes', () => {
    expect(shipped().map((w) => w.name).sort()).toEqual([
      'jml-device-disposition',
      'jml-doctor',
      'jml-leaver-manual',
      'jml-on-error',
      'jml-pipeline',
    ])
  })

  it('imports inactive, so an import cannot arm a schedule', () => {
    // A bundle that arms itself runs against a real tenant before anybody has
    // read what it does.
    expect(shipped().map((w) => w.active)).toEqual([false, false, false, false, false])
  })

  it('names the error workflow everywhere except in the error workflow itself', () => {
    for (const workflow of shipped()) {
      const isErrorWorkflow = workflow.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger')
      if (isErrorWorkflow) {
        expect(workflow.settings.errorWorkflow).toBeUndefined()
      } else {
        expect(workflow.settings.errorWorkflow).toBe(ERROR_WORKFLOW_NAME)
      }
    }
  })

  it('references every credential by name and never by id', () => {
    for (const workflow of shipped()) {
      for (const node of workflow.nodes) {
        for (const cred of Object.values(node.credentials ?? {})) {
          expect(Object.keys(cred)).toEqual(['name'])
        }
      }
    }
  })

  it('gives the device workflow the full receipt timeout on every request', () => {
    // A receipt can take ten minutes, and a request that gives up early leaves
    // an association attached to somebody's laptop.
    const device = shipped().find((w) => w.name === 'jml-device-disposition')
    const requests = (device?.nodes ?? []).filter((n) => n.type === 'n8n-nodes-base.httpRequest')
    expect(requests.length).toBeGreaterThan(1)
    for (const node of requests) {
      const options = node.parameters?.options as { timeout?: number } | undefined
      expect(options?.timeout).toBeGreaterThanOrEqual(DEVICE_ROUTE_TIMEOUT_MS)
    }
  })

  it('builds every URL from the environment', () => {
    for (const path of bundleFiles() as string[]) {
      const raw = readFileSync(path, 'utf8')
      expect(raw).not.toMatch(/"url":\s*"[^"]*https?:\/\//)
    }
  })
})

describe('the gate rejects each violation it exists for', () => {
  it('accepts the fixture the bad ones are derived from', () => {
    // Each bad fixture below is this file with exactly one thing changed, so a
    // rejection is attributable to that change and nothing else.
    expect(rulesFor('good-minimal.json')).toEqual([])
  })

  const cases: Array<[string, string]> = [
    ['bad-static-data.json', 'instance-metadata'],
    ['bad-credential-id.json', 'credential-by-name'],
    ['bad-hardcoded-url.json', 'api-url-from-env'],
    ['bad-missing-error-workflow.json', 'error-workflow'],
    ['bad-unasserted-slack.json', 'slack-post-asserted'],
    ['bad-short-device-timeout.json', 'device-route-timeout'],
    ['bad-code-node.json', 'no-code-node'],
    ['bad-slack-branch-first.json', 'slack-branch-last'],
    ['bad-env-not-allowlisted.json', 'env-allowlist'],
    ['bad-raw-json-body.json', 'body-as-fields'],
    ['bad-open-form.json', 'form-authenticated'],
    ['bad-blocking-run.json', 'run-route-polls'],
    ['bad-active-on-import.json', 'shipped-inactive'],
  ]

  for (const [file, rule] of cases) {
    it(`rejects ${file} as ${rule}`, () => {
      const rules = rulesFor(file)
      expect(rules).toContain(rule)
      // Nothing but the injected defect should fire, or the fixture is not
      // proving what its name claims.
      expect(new Set(rules)).toEqual(new Set([rule]))
    })
  }
})

describe('the gate itself', () => {
  it('refuses a Code node by name rather than as an unknown type', () => {
    expect(ALLOWED_NODE_TYPES.has('n8n-nodes-base.code')).toBe(false)
    const findings = validateWorkflow(
      {
        name: 'x',
        active: false,
        settings: { executionOrder: 'v1', errorWorkflow: ERROR_WORKFLOW_NAME },
        nodes: [{ name: 'Decide', type: 'n8n-nodes-base.code', parameters: {} }],
        connections: {},
      },
      'inline',
    ) as Finding[]
    expect(findings.map((f) => f.rule)).toEqual(['no-code-node'])
  })

  it('allows only the three documented environment variables', () => {
    expect([...(ALLOWED_ENV_VARS as Set<string>)].sort()).toEqual([
      'JML_API_URL',
      'JML_DRY_RUN',
      'SLACK_JML_CHANNEL_ID',
    ])
  })

  it('reports a file it cannot parse instead of skipping it', () => {
    const { findings } = validateFiles([fixture('nothing-here.json')]) as { findings: Finding[] }
    expect(findings.map((f) => f.rule)).toEqual(['shape'])
  })

  it('exits zero on the bundle and non-zero on a bad export', () => {
    expect(main([])).toBe(0)
    expect(main([fixture('bad-static-data.json')])).toBe(1)
  })
})
