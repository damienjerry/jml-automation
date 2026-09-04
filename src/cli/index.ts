/**
 * The command line: parsing, dispatch and exit codes.
 *
 * Three decisions here shape how safe the tool is to use.
 *
 * An unknown flag is a usage error rather than something ignored. `--dryrun`
 * is not `--dry-run`, and a tool that silently ignores the difference is a
 * tool that arms a run somebody thought they were rehearsing.
 *
 * Nothing is armed without `--armed`. Every run command plans by default, even
 * when the configuration says armed, so the two have to agree before a
 * provider is touched.
 *
 * Diagnostics go to stderr and results to stdout, so a report can be piped
 * into another tool without the log lines mixed into it.
 */

import { ConfigError } from '../config/load.ts'
import { redactError } from '../config/redact.ts'
import { CliError, type CliIo } from './commands/context.ts'
import {
  COMMANDS,
  UsageError,
  type CommandSpec,
  type ParsedArgs,
} from './commands/registry.ts'

export interface MainOptions {
  out?: (text: string) => void
  err?: (text: string) => void
  env?: NodeJS.ProcessEnv
  cwd?: string
  /**
   * Set process.exitCode from the result. On by default so the shell sees a
   * failure; a test passes false, because a test runner reads that same
   * property and would report the whole suite as failed.
   */
  setProcessExitCode?: boolean
}

/** Flags every command understands. */
const GLOBAL_VALUE_FLAGS = ['config', 'log-level'] as const
const GLOBAL_BOOL_FLAGS = ['json', 'help'] as const

/**
 * Parse arguments against the flags the chosen command declares.
 *
 * Value flags are declared rather than guessed. Guessing means
 * `jml leaver show --json p-1` swallows the id as the value of `--json`, and
 * the command then reports on nobody while looking like it worked.
 */
export function parseArgs(
  argv: readonly string[],
  spec: { value?: readonly string[]; bool?: readonly string[] },
): ParsedArgs {
  const valueFlags = new Set<string>([...GLOBAL_VALUE_FLAGS, ...(spec.value ?? [])])
  const boolFlags = new Set<string>([...GLOBAL_BOOL_FLAGS, ...(spec.bool ?? [])])
  const words: string[] = []
  const flags = new Map<string, string | true>()
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith('--')) {
      words.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals)
    const inline = equals < 0 ? null : token.slice(equals + 1)

    if (boolFlags.has(name)) {
      if (inline !== null) throw new UsageError('--' + name + ' is a flag and takes no value')
      flags.set(name, true)
      continue
    }
    if (!valueFlags.has(name)) {
      throw new UsageError(
        'unknown option --' + name + '. Run `jml --help`, or `jml <command> --help`, for what this command accepts.',
      )
    }
    if (inline !== null) {
      flags.set(name, inline)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) throw new UsageError('--' + name + ' needs a value')
    flags.set(name, next)
    i++
  }
  return { words, flags, rest }
}

/** The longest command path that matches the words given, so groups work. */
function match(argv: readonly string[]): CommandSpec | null {
  const words = argv.filter((token) => !token.startsWith('--'))
  let best: CommandSpec | null = null
  for (const spec of COMMANDS) {
    if (spec.path.every((word, i) => words[i] === word)) {
      if (!best || spec.path.length > best.path.length) best = spec
    }
  }
  return best
}

export function helpText(spec?: CommandSpec): string {
  if (spec) {
    const lines = ['', 'jml ' + spec.path.join(' ') + '  -  ' + spec.summary, '']
    for (const note of spec.notes ?? []) lines.push('  ' + note)
    if (spec.notes?.length) lines.push('')
    const flags = [
      ...(spec.value ?? []).map((name) => '--' + name + ' <value>'),
      ...(spec.bool ?? []).map((name) => '--' + name),
      '--config <path>',
      '--json',
    ]
    lines.push('  options: ' + flags.join('  '))
    lines.push('')
    return lines.join('\n')
  }

  const width = Math.max(...COMMANDS.map((command) => command.path.join(' ').length)) + 2
  const lines = [
    '',
    'jml  -  joiner, mover and leaver automation driven by your HR system',
    '',
    'Nothing is armed by default. Every run plans and reports until you pass --armed,',
    'and the configuration has to arm each action separately as well.',
    '',
    'commands:',
  ]
  for (const command of COMMANDS) lines.push('  ' + command.path.join(' ').padEnd(width) + command.summary)
  lines.push('')
  lines.push('global options:')
  lines.push('  --config <path>   configuration file (default jml.config.yaml, or JML_CONFIG)')
  lines.push('  --json            print the report as JSON instead of a table')
  lines.push('  --log-level       debug, info, warn or error')
  lines.push('  --help            this text, or the options one command accepts')
  lines.push('')
  lines.push('start with:  jml demo')
  lines.push('')
  return lines.join('\n')
}

export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  const io: CliIo = {
    out: options.out ?? ((text) => process.stdout.write(text)),
    err: options.err ?? ((text) => process.stderr.write(text)),
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  }
  const code = await dispatch(io, argv)
  if (options.setProcessExitCode !== false) process.exitCode = code
  return code
}

async function dispatch(io: CliIo, argv: readonly string[]): Promise<number> {
  const spec = match(argv)
  const wantsHelp = argv.includes('--help') || argv.includes('-h') || argv.length === 0

  if (wantsHelp) {
    io.out(helpText(spec ?? undefined))
    return 0
  }
  if (!spec) {
    const words = argv.filter((token) => !token.startsWith('--'))
    io.err('unknown command: ' + (words.join(' ') || '(none)') + '\n')
    io.out(helpText())
    return 2
  }

  try {
    // A delegating command is handed its arguments untouched: mirroring
    // another script's options here would reject the first one it gains.
    const args = spec.passthrough
      ? { words: [...spec.path], flags: new Map<string, string | true>(), rest: [...argv.slice(spec.path.length)] }
      : parseArgs(argv, spec)
    return await spec.run(io, args)
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(err.message + '\n')
      io.out(helpText(spec))
      return 2
    }
    if (err instanceof CliError) {
      io.err(err.message + '\n' + (err.docsAnchor ? 'see ' + err.docsAnchor + '\n' : ''))
      return err.exitCode
    }
    if (err instanceof ConfigError) {
      io.err(err.message + '\n')
      return 78
    }
    // Anything else is a defect. It is redacted before printing, because the
    // one place a credential most often escapes is an unexpected stack trace.
    const safe = redactError(err)
    io.err(safe.message + '\n' + (safe.stack ?? '') + '\n')
    return 70
  }
}
