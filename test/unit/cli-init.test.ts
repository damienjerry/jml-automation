/**
 * `jml init`.
 *
 * Two properties are worth a test. The configuration file it writes must carry
 * no credential value anywhere, because that file gets committed, pasted into
 * issues and copied between machines. And the sidecar token must be generated
 * rather than left for somebody to choose, because this service can delete
 * accounts and a memorable token is a guessable one.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.ts'
import { MIN_TOKEN_LENGTH } from '../../src/server/http.ts'

async function inTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jml-init-'))
}

function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  return main(argv, {
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    env: {},
    cwd,
    setProcessExitCode: false,
  }).then((code) => ({ code, out, err }))
}

describe('jml init', () => {
  it('writes both files and generates a token of at least 32 bytes', async () => {
    const dir = await inTempDir()
    const result = await run(['init', '--dir', dir], dir)
    expect(result.code).toBe(0)

    const config = await readFile(join(dir, 'jml.config.yaml'), 'utf8')
    const env = await readFile(join(dir, '.env'), 'utf8')

    const line = /^JML_API_TOKEN=(.+)$/m.exec(env)
    expect(line).not.toBeNull()
    const generated = (line as RegExpExecArray)[1] as string
    // 32 random bytes, hex encoded.
    expect(generated).toMatch(/^[0-9a-f]{64}$/)
    expect(generated.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)

    // The configuration references the credential; it never holds one.
    expect(config).toContain('env:JML_API_TOKEN')
    expect(config).not.toContain(generated)
  })

  it('starts with nothing armed, so a first run can only plan', async () => {
    const dir = await inTempDir()
    await run(['init', '--dir', dir], dir)
    const config = await readFile(join(dir, 'jml.config.yaml'), 'utf8')
    expect(config).toMatch(/mode:\s*dry-run/)
  })

  it('refuses to overwrite what is already there', async () => {
    const dir = await inTempDir()
    await writeFile(join(dir, 'jml.config.yaml'), 'version: 1\n', 'utf8')

    const result = await run(['init', '--dir', dir], dir)
    expect(result.code).toBe(2)
    expect(result.err).toContain('already exists')
    // Untouched: overwriting a configured file would discard whatever an
    // adopter has set up, and the token with it.
    expect(await readFile(join(dir, 'jml.config.yaml'), 'utf8')).toBe('version: 1\n')
  })

  it('overwrites only when asked, and says what that costs', async () => {
    const dir = await inTempDir()
    await writeFile(join(dir, 'jml.config.yaml'), 'version: 1\n', 'utf8')
    const result = await run(['init', '--dir', dir, '--force'], dir)
    expect(result.code).toBe(0)
    expect(await readFile(join(dir, 'jml.config.yaml'), 'utf8')).toContain('version: 1')
  })

  it('points a first-time reader at the demo before anything else', async () => {
    const dir = await inTempDir()
    const result = await run(['init', '--dir', dir], dir)
    expect(result.out).toContain('jml demo')
    expect(result.out).toContain('jml store bootstrap')
  })
})
