/**
 * The command table.
 *
 * Every command declares the flags it accepts, because an unknown flag has to
 * be a usage error rather than something ignored: `--dryrun` is not
 * `--dry-run`, and a tool that quietly ignores the difference arms a run
 * somebody thought they were rehearsing. Declaring value flags also stops
 * `jml leaver show --json p-1` swallowing the id as the value of `--json`.
 *
 * The summaries are the help text an adopter reads first, so they say what a
 * command does to their estate rather than which module it calls.
 */

import type { LogLevel } from '../../core/logger.ts'
import type { PipelineStepName } from '../../engine/pipeline.ts'
import { auditCommand, configShowCommand } from './audit.ts'
import type { CliIo } from './context.ts'
import { deviceCommand } from './device.ts'
import { generateCommand, initCommand } from './init.ts'
import { leaverCommand, type LeaverCommandOptions } from './leaver.ts'
import { joinerCommand, type JoinerCommandOptions } from './joiner.ts'
import { n8nCommand } from './n8n.ts'
import { runCommand } from './run.ts'
import { serveCommand } from './serve.ts'
import { storeCommand, type StoreCommandOptions } from './store.ts'
import { doctorCommand } from '../doctor.ts'
import { runDemo } from '../demo.ts'

export interface CommandSpec {
  /** Words the user types, for example `leaver run`. */
  path: readonly string[]
  summary: string
  /** Flags that take a value. Anything else is a boolean. */
  value?: readonly string[]
  bool?: readonly string[]
  /** Extra lines under the command in `--help`. */
  notes?: readonly string[]
  /**
   * Hand the arguments over untouched instead of parsing them.
   *
   * Only for a command that delegates to a script with its own options. The
   * flag table here would otherwise have to mirror that script's, and a
   * mirror drifts: the first flag the script gains would be rejected by this
   * tool as unknown.
   */
  passthrough?: boolean
  run(io: CliIo, args: ParsedArgs): Promise<number>
}

export interface ParsedArgs {
  words: string[]
  flags: Map<string, string | true>
  /** Everything after `--`, passed through to a delegated script untouched. */
  rest: string[]
}

export function value(args: ParsedArgs, name: string): string | undefined {
  const found = args.flags.get(name)
  return typeof found === 'string' ? found : undefined
}

export function bool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

export class UsageError extends Error {}

export function integer(args: ParsedArgs, name: string): number | undefined {
  const raw = value(args, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError('--' + name + ' must be a whole number')
  return parsed
}

/** The options shared by every command that opens a configuration. */
function common(args: ParsedArgs): { configPath?: string; json?: boolean; logLevel?: LogLevel } {
  const level = value(args, 'log-level') as LogLevel | undefined
  return {
    ...(value(args, 'config') ? { configPath: value(args, 'config') } : {}),
    ...(bool(args, 'json') ? { json: true } : {}),
    ...(level ? { logLevel: level } : {}),
  }
}

const RUN_VALUE_FLAGS = ['actor', 'allow-bulk', 'hris-id', 'email'] as const
const PERSON_VALUE_FLAGS = ['hris-id', 'email', 'reason', 'note', 'actor'] as const

function runSpec(path: readonly string[], summary: string, steps: readonly PipelineStepName[] | undefined, notes: readonly string[] = []): CommandSpec {
  return {
    path,
    summary,
    value: RUN_VALUE_FLAGS,
    bool: ['armed'],
    notes,
    run: (io, args) =>
      runCommand(io, {
        ...common(args),
        ...(steps ? { steps } : {}),
        armed: bool(args, 'armed'),
        ...(value(args, 'actor') ? { actor: value(args, 'actor') } : {}),
        ...(integer(args, 'allow-bulk') === undefined ? {} : { allowBulk: integer(args, 'allow-bulk') }),
        ...(value(args, 'hris-id') || value(args, 'email')
          ? {
              only: {
                ...(value(args, 'hris-id') ? { hrisId: value(args, 'hris-id') } : {}),
                ...(value(args, 'email') ? { email: value(args, 'email') } : {}),
              },
            }
          : {}),
      }),
  }
}

function leaverSpec(action: LeaverCommandOptions['action'], summary: string, notes: readonly string[] = []): CommandSpec {
  return {
    path: ['leaver', action],
    summary,
    value: PERSON_VALUE_FLAGS,
    bool: ['armed'],
    notes,
    run: (io, args) =>
      leaverCommand(io, {
        ...common(args),
        action,
        armed: bool(args, 'armed'),
        ...(value(args, 'hris-id') ? { hrisId: value(args, 'hris-id') } : {}),
        ...(value(args, 'email') ? { email: value(args, 'email') } : {}),
        ...(value(args, 'reason') ? { reason: value(args, 'reason') } : {}),
        ...(value(args, 'note') ? { note: value(args, 'note') } : {}),
        ...(value(args, 'actor') ? { actor: value(args, 'actor') } : {}),
      }),
  }
}

function joinerSpec(action: JoinerCommandOptions['action'], summary: string, notes: readonly string[] = []): CommandSpec {
  return {
    path: ['joiner', action],
    summary,
    value: PERSON_VALUE_FLAGS,
    bool: ['armed', 'reset-refusal'],
    notes,
    run: (io, args) =>
      joinerCommand(io, {
        ...common(args),
        action,
        armed: bool(args, 'armed'),
        resetRefusal: bool(args, 'reset-refusal'),
        ...(value(args, 'hris-id') ? { hrisId: value(args, 'hris-id') } : {}),
        ...(value(args, 'email') ? { email: value(args, 'email') } : {}),
        ...(value(args, 'note') ? { note: value(args, 'note') } : {}),
        ...(value(args, 'actor') ? { actor: value(args, 'actor') } : {}),
      }),
  }
}

function storeSpec(action: StoreCommandOptions['action'], summary: string, notes: readonly string[] = []): CommandSpec {
  return {
    path: ['store', action],
    summary,
    value: ['expect-day0', 'expect-departed', 'to'],
    bool: ['armed'],
    notes,
    run: (io, args) =>
      storeCommand(io, {
        ...common(args),
        action,
        armed: bool(args, 'armed'),
        ...(integer(args, 'expect-day0') === undefined ? {} : { expectDay0: integer(args, 'expect-day0') }),
        ...(integer(args, 'expect-departed') === undefined ? {} : { expectDeparted: integer(args, 'expect-departed') }),
        ...(value(args, 'to') ? { to: value(args, 'to') } : {}),
      }),
  }
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    path: ['init'],
    summary: 'write jml.config.yaml and .env, with a random sidecar token',
    value: ['dir'],
    bool: ['force'],
    run: (io, args) =>
      initCommand(io, {
        ...(value(args, 'dir') ? { dir: value(args, 'dir') } : {}),
        force: bool(args, 'force'),
      }),
  },
  {
    path: ['generate'],
    summary: 'regenerate the example config, .env.example, the JSON schema and the config reference',
    value: ['dir'],
    run: (io, args) => generateCommand(io, { ...(value(args, 'dir') ? { dir: value(args, 'dir') } : {}) }),
  },
  {
    path: ['config', 'show'],
    summary: 'print the configuration as shape, references and lengths, never values',
    bool: ['no-secrets'],
    run: (io, args) =>
      configShowCommand(io, {
        ...common(args),
        resolveSecrets: !bool(args, 'no-secrets'),
      }),
  },
  {
    path: ['doctor'],
    summary: 'probe every credential and scope, and report the oldest parked row',
    bool: ['probe-writes'],
    notes: [
      'A parked row takes no action and raises nothing, so over-suppression looks',
      'exactly like a quiet week. The age of the oldest one is always printed.',
    ],
    run: (io, args) => doctorCommand(io, { ...common(args), probeWrites: bool(args, 'probe-writes') }),
  },
  {
    path: ['demo'],
    summary: 'walk a whole leaver lifecycle offline, with no credentials and no network',
    value: ['fixture'],
    notes: ['Start here. It needs nothing configured and writes no files.'],
    run: async (io, args) => {
      const result = await runDemo({
        write: (text) => io.out(text),
        ...(value(args, 'fixture') ? { fixturePath: value(args, 'fixture') } : {}),
      })
      return result.ok ? 0 : 1
    },
  },
  runSpec(['run'], 'read the HR system, sync, detect, then run the leaver engine', undefined, [
    'The whole ordered run. Add --armed to let it touch a provider.',
  ]),
  runSpec(['sync'], 'read the HR system and update the people store only', ['sync']),
  runSpec(['detect'], 'announce joiners and leavers, when the set of people has changed', ['detect']),
  leaverSpec('dry-run', 'plan one person, or everybody due, without touching a provider'),
  leaverSpec('run', 'offboard one person, or everybody due (needs --armed)'),
  leaverSpec('show', 'print one person: status, markers, legs, bound devices'),
  leaverSpec('hold', 'freeze a row against every automation, including the HR sync (needs --reason)'),
  leaverSpec('release', 'clear the freeze and the parked reason together'),
  leaverSpec('ack', 'record that a person agrees the deletion may proceed'),
  leaverSpec('tombstone', 'close a row by hand without any account work (needs --reason)'),
  joinerSpec('dry-run', 'plan activation for one starter, or everybody due, without touching a provider'),
  joinerSpec('run', 'activate one starter, or everybody due (needs --armed, and each action armed in config)'),
  joinerSpec('show', 'print one person with their activation markers'),
  joinerSpec('approve', 'open the activation gate for one person, or clear a refusal with --reset-refusal', [
    'With joiner.gate: none there is no gate; the command only clears a refusal.',
  ]),
  {
    path: ['device', 'preflight'],
    summary: 'read a machine and print every reason a disposition could be refused',
    value: ['system-id', 'disposition', 'actor', 'owner-hris-id'],
    run: (io, args) =>
      deviceCommand(io, {
        ...common(args),
        action: 'preflight',
        ...(value(args, 'system-id') ? { systemId: value(args, 'system-id') } : {}),
        ...(value(args, 'disposition') ? { disposition: value(args, 'disposition') } : {}),
        ...(value(args, 'actor') ? { actor: value(args, 'actor') } : {}),
        ...(value(args, 'owner-hris-id') ? { expectedOwnerHrisId: value(args, 'owner-hris-id') } : {}),
      }),
  },
  {
    path: ['device', 'dispose'],
    summary: 'unbind, hand over or retire one machine (needs --armed)',
    value: ['system-id', 'disposition', 'actor', 'owner-hris-id', 'canaried-system-id', 'note'],
    bool: ['armed', 'acknowledge-fde-key-loss'],
    notes: [
      'Deleting a device record destroys the disk-encryption key the provider holds',
      'for it, so a handover needs --acknowledge-fde-key-loss said out loud.',
    ],
    run: (io, args) =>
      deviceCommand(io, {
        ...common(args),
        action: 'dispose',
        armed: bool(args, 'armed'),
        acknowledgeFdeKeyLoss: bool(args, 'acknowledge-fde-key-loss'),
        ...(value(args, 'system-id') ? { systemId: value(args, 'system-id') } : {}),
        ...(value(args, 'disposition') ? { disposition: value(args, 'disposition') } : {}),
        ...(value(args, 'actor') ? { actor: value(args, 'actor') } : {}),
        ...(value(args, 'owner-hris-id') ? { expectedOwnerHrisId: value(args, 'owner-hris-id') } : {}),
        ...(value(args, 'canaried-system-id') ? { canariedSystemId: value(args, 'canaried-system-id') } : {}),
        ...(value(args, 'note') ? { note: value(args, 'note') } : {}),
      }),
  },
  storeSpec('bootstrap', 'import the whole HR history as tombstones (rehearses unless --armed)', [
    'Run this BEFORE arming anything. Without it, every historic leaver in your HR',
    'system looks like a brand new termination on the first run.',
  ]),
  storeSpec('verify', 'print the exact day-0 selection and tombstone count', [
    'Run it on both sides of a migration and compare the numbers, not the impression.',
  ]),
  storeSpec('migrate', 'apply any pending store migration and report what the schema holds'),
  storeSpec('backup', 'write a consistent copy of the people and state databases'),
  {
    path: ['audit', 'tail'],
    summary: 'print the most recent audit rows',
    value: ['lines'],
    run: (io, args) =>
      auditCommand(io, {
        ...common(args),
        action: 'tail',
        ...(integer(args, 'lines') === undefined ? {} : { lines: integer(args, 'lines') }),
      }),
  },
  {
    path: ['audit', 'verify'],
    summary: 'walk the audit hash chain and name the first line that does not check out',
    run: (io, args) => auditCommand(io, { ...common(args), action: 'verify' }),
  },
  {
    path: ['n8n', 'scrub'],
    summary: 'strip credential ids, node ids and static data from an exported workflow',
    passthrough: true,
    notes: ['Everything after `scrub` is handed to the bundle script untouched.'],
    run: (io, args) => n8nCommand(io, { action: 'scrub', rest: args.rest }),
  },
  {
    path: ['n8n', 'import'],
    summary: 'import the shipped workflow bundle into a running automation tool',
    passthrough: true,
    run: (io, args) => n8nCommand(io, { action: 'import', rest: args.rest }),
  },
  {
    path: ['serve'],
    summary: 'run the authenticated HTTP sidecar',
    value: ['bind'],
    notes: [
      'The shipped compose file does not publish this port. Only the automation tool',
      'on the same private network can reach it, and it holds nothing but the token.',
    ],
    run: (io, args) =>
      serveCommand(io, { ...common(args), ...(value(args, 'bind') ? { bind: value(args, 'bind') } : {}) }),
  },
]

