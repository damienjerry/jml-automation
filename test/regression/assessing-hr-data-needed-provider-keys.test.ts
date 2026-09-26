/**
 * Looking at your own HR data needed an identity provider and a Google key.
 *
 * Every command resolved every provider credential at start-up, and `jml sync`
 * and `jml detect` opened the provider connectors although neither step calls
 * them. So somebody who only wanted to see who the toolkit thinks has joined
 * and left had to type in a JumpCloud key and a Google service account, or, as
 * the adaptation guide used to tell them, a placeholder for each. A placeholder
 * in a credential field is one paste away from a real key from another system.
 *
 * The HR-only commands now resolve neither credential. Everything that reads
 * or changes an account still requires both, and a sync-only run still builds
 * the Google connector when email notification is on, because the detector
 * announces through it and an announcement sent nowhere looks like a quiet day.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.ts'

const FIXTURE = resolve('src/cli/fixtures/demo.json')

async function setUp(notify: string[] = ['console']): Promise<{ config: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-report-only-'))
  const quiet = { out: () => {}, err: () => {}, env: {}, cwd: dir, setProcessExitCode: false }
  expect(await main(['init', '--dir', dir], quiet)).toBe(0)
  const env: Record<string, string> = {}
  for (const line of (await readFile(join(dir, '.env'), 'utf8')).split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m?.[1] && m[2]) env[m[1]] = m[2]
  }
  type Doc = { hris: { fixture: { path: string }; minPlausibleHeadcount: number }; store: { path: string }; audit: { jsonl: { dir: string } }; notify: { adapters: string[]; email?: Record<string, unknown> } }
  const doc = parseYaml(await readFile(join(dir, 'jml.config.yaml'), 'utf8')) as Doc
  doc.hris.fixture.path = FIXTURE
  doc.hris.minPlausibleHeadcount = 1
  doc.store.path = join(dir, 'jml.sqlite')
  doc.audit.jsonl.dir = join(dir, 'audit')
  doc.notify.adapters = notify
  if (notify.includes('email')) doc.notify.email = { ...(doc.notify.email ?? {}), itMailbox: 'it@example.com' }
  const config = join(dir, 'jml.config.yaml')
  await writeFile(config, stringify(doc))
  // Neither provider credential is present.
  delete env.JUMPCLOUD_API_KEY
  delete env.GOOGLE_SERVICE_ACCOUNT_JSON
  return { config, env }
}

async function jml(args: string[], env: Record<string, string>): Promise<{ code: number; err: string }> {
  let err = ''
  const code = await main(args, { out: () => {}, err: (t: string) => { err += t }, env, cwd: process.cwd(), setProcessExitCode: false })
  return { code, err }
}

describe('assessing HR data before granting provider access', () => {
  it('bootstrap, sync, detect and verify run with no identity provider or Google key', async () => {
    const { config, env } = await setUp()
    for (const args of [['store', 'bootstrap', '--armed'], ['sync', '--armed'], ['detect'], ['store', 'verify']]) {
      const r = await jml([...args, '--config', config], env)
      expect(r.err).not.toMatch(/JUMPCLOUD_API_KEY|GOOGLE_SERVICE_ACCOUNT_JSON/)
      expect([args.join(' '), r.code]).toEqual([args.join(' '), 0])
    }
  })

  it('a full run and a leaver plan still require both keys', async () => {
    const { config, env } = await setUp()
    for (const args of [['run'], ['leaver', 'dry-run', '--hris-id', 'p-1']]) {
      const r = await jml([...args, '--config', config], env)
      expect(r.code).not.toBe(0)
      expect(r.err).toMatch(/JUMPCLOUD_API_KEY/)
      expect(r.err).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON/)
    }
  })

  it('detect still needs the Google key when announcements go by email', async () => {
    const { config, env } = await setUp(['console', 'email'])
    const r = await jml(['detect', '--config', config], env)
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON/)
  })
})
