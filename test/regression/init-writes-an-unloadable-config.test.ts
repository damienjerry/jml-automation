/**
 * Prevents: `jml init` writing a configuration that the next command refuses.
 *
 * The audit log stores addresses as a salted hash, PII minimisation is on by
 * default, and the schema requires a salt whenever it is on. The generated
 * default carried no salt, so every command that loads configuration failed on
 * a fresh install, before anybody had typed a credential.
 *
 * The error made it worse. Any schema issue on a secret field was rewritten as
 * "holds a literal value where a secret reference is required", so a missing
 * salt was reported as a pasted credential. The obvious repair for the message
 * that was actually printed is to write a salt straight into the file, which is
 * the one thing the split between the configuration and the environment exists
 * to prevent.
 *
 * So this asserts three things together: the file loads, the salt is generated
 * rather than chosen, and it lives only in the environment file.
 */

import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.ts'
import { ConfigError, loadConfig } from '../../src/config/load.ts'

async function initInTemp(): Promise<{ dir: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-init-loads-'))
  const code = await main(['init', '--dir', dir], {
    out: () => {},
    err: () => {},
    env: {},
    cwd: dir,
    setProcessExitCode: false,
  })
  expect(code).toBe(0)

  // Read .env the way a container would: every non-empty assignment.
  const env: Record<string, string> = {}
  for (const line of (await readFile(join(dir, '.env'), 'utf8')).split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (match?.[1] && match[2] !== '') env[match[1]] = match[2] as string
  }
  return { dir, env }
}

/**
 * The configuration `jml init` writes, as a parsed document, with the audit
 * salt replaced. Starting from the real generated file rather than a
 * hand-written minimum keeps these two cases about the salt: a partial
 * document fails on the twenty other required keys instead.
 */
async function documentWithSalt(salt: string | null): Promise<Record<string, unknown>> {
  const { dir } = await initInTemp()
  const doc = parseYaml(await readFile(join(dir, 'jml.config.yaml'), 'utf8')) as Record<string, unknown>
  doc.audit = { ...(doc.audit as Record<string, unknown>), minimisePii: true, salt }
  return doc
}

describe('the configuration jml init writes', () => {
  it('parses through the schema, so the failure is a missing credential and nothing else', async () => {
    const { dir, env } = await initInTemp()

    // allowMissingSecrets stops at the schema: an adopter has not filled in a
    // provider credential yet, and that is not what this test is about.
    const { config } = await loadConfig({ path: join(dir, 'jml.config.yaml'), env, allowMissingSecrets: true })

    expect(config.audit.minimisePii).toBe(true)
    expect(config.audit.salt).toBe('env:JML_AUDIT_SALT')
  })

  it('resolves the audit salt from the environment file it wrote alongside', async () => {
    const { dir, env } = await initInTemp()
    expect(env.JML_AUDIT_SALT).toMatch(/^[0-9a-f]{64}$/)

    // No provider is configured yet, so resolution fails only on those fields.
    // The salt must not be among them.
    let failedPaths: string[] = []
    try {
      await loadConfig({ path: join(dir, 'jml.config.yaml'), env })
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      failedPaths = (err as ConfigError).issues.map((i) => i.path)
    }
    expect(failedPaths).not.toContain('audit.salt')
  })

  it('keeps the generated salt out of the configuration file', async () => {
    const { dir, env } = await initInTemp()
    const text = await readFile(join(dir, 'jml.config.yaml'), 'utf8')
    expect(text).toContain('env:JML_AUDIT_SALT')
    expect(text).not.toContain(env.JML_AUDIT_SALT as string)
  })

  it('writes the environment file readable only by its owner', async () => {
    const { dir } = await initInTemp()
    // The file holds a bearer token for a service that can delete accounts.
    // Group and world readable is how a shared host leaks one.
    const mode = (await stat(join(dir, '.env'))).mode & 0o777
    // Windows has no Unix file mode, so this cannot hold there; see the
    // native Windows note in docs/operating.md.
    if (process.platform !== 'win32') expect(mode & 0o077).toBe(0)
  })

  it('reports a missing salt as a missing salt, not as a pasted credential', async () => {
    // The rewrite that hid this: every issue on a secret path became the
    // literal-value accusation, whatever the real problem was.
    let message = ''
    try {
      await loadConfig({
        path: 'unused',
        env: {},
        allowMissingSecrets: true,
        document: await documentWithSalt(null),
      })
    } catch (err) {
      message = (err as ConfigError).issues.map((i) => `${i.path}: ${i.message}`).join('\n')
    }
    expect(message).toContain('audit.salt')
    expect(message).toContain('must reference a salt')
    expect(message).not.toContain('holds a literal value')
  })

  it('still calls a genuinely pasted credential what it is', async () => {
    let message = ''
    try {
      await loadConfig({
        path: 'unused',
        env: {},
        allowMissingSecrets: true,
        document: await documentWithSalt('this-is-the-actual-salt-value'),
      })
    } catch (err) {
      message = (err as ConfigError).issues.map((i) => `${i.path}: ${i.message}`).join('\n')
    }
    expect(message).toContain('holds a literal value')
    // And it does not echo the credential back into the error.
    expect(message).not.toContain('this-is-the-actual-salt-value')
  })
})
