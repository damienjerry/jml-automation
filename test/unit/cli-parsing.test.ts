/**
 * Argument parsing and dispatch.
 *
 * The subject of most of these is refusal. A command line that quietly ignores
 * what it does not understand is the interface equivalent of a gate that
 * always opens: somebody types `--dryrun`, sees a clean exit, and believes
 * they rehearsed a run that in fact never planned anything.
 */

import { describe, expect, it } from 'vitest'
import { helpText, main, parseArgs } from '../../src/cli/index.ts'
import { COMMANDS } from '../../src/cli/commands/registry.ts'

function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
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
    cwd: process.cwd(),
    // The test runner reads process.exitCode too, so a command that returns a
    // failure must not fail the whole suite.
    setProcessExitCode: false,
  }).then((code) => ({ code, out, err }))
}

describe('parseArgs', () => {
  const spec = { value: ['hris-id', 'reason'], bool: ['armed'] }

  it('reads a value flag written either way round', () => {
    expect(parseArgs(['--hris-id', 'hr-1'], spec).flags.get('hris-id')).toBe('hr-1')
    expect(parseArgs(['--hris-id=hr-1'], spec).flags.get('hris-id')).toBe('hr-1')
  })

  it('does not let a boolean flag swallow the next word', () => {
    // `jml leaver show --json hr-1` has to keep hr-1 as a word. A parser that
    // guesses which flags take values reports on nobody and looks like it
    // worked.
    const args = parseArgs(['show', '--json', 'hr-1'], spec)
    expect(args.flags.get('json')).toBe(true)
    expect(args.words).toEqual(['show', 'hr-1'])
  })

  it('refuses an unknown option rather than ignoring it', () => {
    expect(() => parseArgs(['--dryrun'], spec)).toThrow(/unknown option --dryrun/)
  })

  it('refuses a value flag with nothing after it', () => {
    expect(() => parseArgs(['--reason'], spec)).toThrow(/needs a value/)
  })

  it('refuses a value given to a boolean flag', () => {
    expect(() => parseArgs(['--armed=yes'], spec)).toThrow(/takes no value/)
  })

  it('passes everything after a bare -- through untouched', () => {
    expect(parseArgs(['scrub', '--', '--force', 'file.json'], spec).rest).toEqual(['--force', 'file.json'])
  })
})

describe('the command table', () => {
  it('declares every command the documentation promises', () => {
    const paths = COMMANDS.map((command) => command.path.join(' '))
    for (const expected of [
      'init',
      'generate',
      'config show',
      'doctor',
      'demo',
      'run',
      'sync',
      'detect',
      'leaver dry-run',
      'leaver run',
      'leaver show',
      'leaver hold',
      'leaver release',
      'leaver ack',
      'leaver tombstone',
      'device preflight',
      'device dispose',
      'store bootstrap',
      'store verify',
      'store migrate',
      'store backup',
      'audit tail',
      'audit verify',
      'n8n scrub',
      'n8n import',
      'serve',
    ]) {
      expect(paths).toContain(expected)
    }
  })

  it('gives every command a summary that says what it does', () => {
    for (const command of COMMANDS) expect(command.summary.length).toBeGreaterThan(20)
  })

  it('never arms anything by default: --armed is a flag on every command that writes', () => {
    for (const command of COMMANDS) {
      const writes = ['run', 'sync', 'detect', 'leaver run', 'device dispose', 'store bootstrap'].includes(
        command.path.join(' '),
      )
      if (writes) expect(command.bool ?? []).toContain('armed')
    }
  })
})

describe('help and dispatch', () => {
  it('prints help with no arguments at all', async () => {
    const result = await run([])
    expect(result.code).toBe(0)
    expect(result.out).toContain('jml  -  joiner, mover and leaver automation')
    expect(result.out).toContain('start with:  jml demo')
  })

  it('says nothing is armed by default, in the help a first-time reader sees', async () => {
    expect(helpText()).toContain('Nothing is armed by default')
  })

  it('prints a command`s own options for --help', async () => {
    const result = await run(['device', 'dispose', '--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('--acknowledge-fde-key-loss')
    expect(result.out).toContain('destroys the disk-encryption key')
  })

  it('exits 2 on an unknown command and shows what there is', async () => {
    const result = await run(['offboard-everyone'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('unknown command: offboard-everyone')
    expect(result.out).toContain('commands:')
  })

  it('exits 2 on an unknown option without opening a configuration file', async () => {
    const result = await run(['run', '--dryrun'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('unknown option --dryrun')
  })
})
