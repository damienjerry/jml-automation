import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSecretHandle,
  defaultProviders,
  envProvider,
  fileProvider,
  isSecretHandle,
  isSecretRef,
  opProvider,
  resolveSecret,
  SecretResolutionError,
} from '../../src/config/secrets.ts'
import { redactor, REDACTED } from '../../src/config/redact.ts'

describe('secret reference grammar', () => {
  it('accepts the three supported schemes', () => {
    expect(isSecretRef('env:JUMPCLOUD_API_KEY')).toBe(true)
    expect(isSecretRef('file:/run/secrets/jml')).toBe(true)
    expect(isSecretRef('op://<vault>/<item-uuid>/<field>')).toBe(true)
  })

  it('rejects a bare value, a relative file and an unimplemented scheme', () => {
    expect(isSecretRef('plain-value-typed-in')).toBe(false)
    expect(isSecretRef('file:relative/path')).toBe(false)
    // Reserved for a later phase: an unimplemented scheme must fail the
    // grammar rather than resolve to nothing.
    expect(isSecretRef('keychain://login/jml')).toBe(false)
  })
})

describe('SecretHandle', () => {
  it('never reveals the value through toString, toJSON or inspection', () => {
    const handle = createSecretHandle('env:EXAMPLE_TOKEN', 'the-actual-value')
    expect(String(handle)).toBe(REDACTED)
    expect(JSON.stringify({ h: handle })).toBe('{"h":"' + REDACTED + '"}')
    expect(handle.use((v) => v)).toBe('the-actual-value')
    expect(handle.length).toBe('the-actual-value'.length)
    expect(isSecretHandle(handle)).toBe(true)
  })

  it('registers its value with the redactor on creation', () => {
    createSecretHandle('env:EXAMPLE_TOKEN', 'registered-on-creation')
    expect(redactor.redactString('body said registered-on-creation')).toBe('body said ' + REDACTED)
  })
})

describe('providers', () => {
  it('reads an environment variable', async () => {
    const handle = await resolveSecret('env:SOME_NAME', [envProvider({ SOME_NAME: 'value-from-env' })])
    expect(handle.use((v) => v)).toBe('value-from-env')
  })

  it('treats an unset variable as a start-up failure', async () => {
    await expect(resolveSecret('env:MISSING_NAME', [envProvider({})])).rejects.toBeInstanceOf(SecretResolutionError)
  })

  it('treats an empty variable as a failure, not as a value', async () => {
    // A name present with nothing after the equals sign is what a broken
    // deployment looks like, and authenticating with an empty credential is
    // worse than refusing to start.
    await expect(resolveSecret('env:BLANK_NAME', [envProvider({ BLANK_NAME: '   ' })])).rejects.toThrow(/set but empty/)
  })

  it('reads a file and drops the trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jml-secret-'))
    const path = join(dir, 'value')
    await writeFile(path, 'from-a-file\n', 'utf8')
    const handle = await resolveSecret('file:' + path, [fileProvider()])
    expect(handle.use((v) => v)).toBe('from-a-file')
  })

  it('reports the reference, not the value, when a file is missing', async () => {
    const err = await resolveSecret('file:/nonexistent/jml-secret', [fileProvider()]).catch((e) => e)
    expect(err).toBeInstanceOf(SecretResolutionError)
    expect(err.message).toContain('file:/nonexistent/jml-secret')
    expect(err.docsAnchor).toBe('docs/config-reference.md#secret-references')
  })

  it('resolves through the secret manager CLI without shelling out in tests', async () => {
    const calls: string[][] = []
    const provider = opProvider(async (command, args) => {
      calls.push([command, ...args])
      return { stdout: 'value-from-manager', stderr: '', code: 0 }
    })
    const handle = await resolveSecret('op://<vault>/<item-uuid>/<field>', [provider])
    expect(handle.use((v) => v)).toBe('value-from-manager')
    expect(calls[0]).toEqual(['op', 'read', '--no-newline', 'op://<vault>/<item-uuid>/<field>'])
  })

  it('surfaces one line of CLI stderr and no more', async () => {
    const provider = opProvider(async () => ({ stdout: '', stderr: 'item not found\nsecond line\n', code: 1 }))
    await expect(resolveSecret('op://<vault>/<item-uuid>/<field>', [provider])).rejects.toThrow(/item not found/)
  })

  it('refuses a reference no provider claims', async () => {
    await expect(resolveSecret('env:NAME', [fileProvider()])).rejects.toThrow(/no provider for this scheme/)
  })

  it('offers all three schemes by default', () => {
    expect(defaultProviders({}).map((p) => p.scheme)).toEqual(['env', 'file', 'op'])
  })
})
