import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvValueError, getConfig, parseEnv, setConfig, setEnv } from '../../src/cli/commands/setup/files.ts'

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'jml-setup-files-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

// Shaped like a service account key: minified JSON, escaped newlines and a dollar sign.
const KEY_LIKE = JSON.stringify({ type: 'service_account', client_email: 'svc@example.com', private_key: 'line-one\nline-two$1$&' })

describe('.env', () => {
  it('writes single-quoted values that a shell and parseEnv both read back byte for byte', async () => {
    const path = join(temp(), '.env')
    writeFileSync(path, 'JML_API_TOKEN=abc\nHIBOB_SERVICE_TOKEN=\n')
    await setEnv(path, 'HIBOB_SERVICE_TOKEN', 'tok$en&not|real')
    await setEnv(path, 'GOOGLE_SERVICE_ACCOUNT_JSON', KEY_LIKE)
    const parsed = parseEnv(readFileSync(path, 'utf8'))
    expect(parsed['JML_API_TOKEN']).toBe('abc')
    expect(parsed['HIBOB_SERVICE_TOKEN']).toBe('tok$en&not|real')
    expect(parsed['GOOGLE_SERVICE_ACCOUNT_JSON']).toBe(KEY_LIKE)
    const viaShell = execFileSync('bash', ['-c', `set -a; . "${path}"; set +a; printf %s "$GOOGLE_SERVICE_ACCOUNT_JSON"`]).toString()
    expect(viaShell).toBe(KEY_LIKE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('refuses a value with a quote or a line break rather than guessing an escape', async () => {
    const path = join(temp(), '.env')
    await expect(setEnv(path, 'X_TOKEN', "it's")).rejects.toThrow(EnvValueError)
    await expect(setEnv(path, 'X_TOKEN', 'a\nb')).rejects.toThrow(EnvValueError)
  })

  it('creates the file mode 600 when it did not exist', async () => {
    const path = join(temp(), '.env')
    await setEnv(path, 'N8N_FORM_USER', 'jml')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('jml.config.yaml', () => {
  it('sets values in place and keeps every comment', async () => {
    const path = join(temp(), 'jml.config.yaml')
    writeFileSync(path, 'org:\n  # Organisation name.\n  name: "Example Organisation"\n  # The domain.\n  primaryDomain: example.com\n')
    await setConfig(path, [[['org', 'name'], 'Other Example'], [['org', 'aliasDomains'], ['legacy.example.com']]])
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# Organisation name.')
    expect(text).toContain('# The domain.')
    expect(await getConfig(path, ['org', 'name'])).toBe('Other Example')
    expect(await getConfig(path, ['org', 'aliasDomains'])).toEqual(['legacy.example.com'])
  })
})
