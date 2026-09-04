/**
 * Structured logging, through the redactor.
 *
 * One line of JSON per event on stdout, which is what a container platform and
 * a log aggregator both want, and what `docker logs` is readable as.
 *
 * Everything passes through `redactDeep` on the way out: the message, every
 * field, every nested object and every key name. This is the last line of
 * defence, and it is here because a credential rarely escapes through the line
 * that handles it. It escapes because somebody logged a whole request object
 * while debugging, and that line does not know it is handling a secret.
 */

import { redactDeep, redactError } from '../config/redact.ts'
import type { Clock } from './clock.ts'
import { SystemClock } from './clock.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type LogFields = Record<string, unknown>

export interface Logger {
  readonly level: LogLevel
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** A logger that carries these fields on every line, for example a runId. */
  child(fields: LogFields): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** Where lines go. Injected so tests capture instead of printing. */
  write?: (line: string) => void
  clock?: Clock
  /** Human-readable single lines instead of JSON, for interactive CLI use. */
  pretty?: boolean
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.JML_LOG_LEVEL as LogLevel | undefined) ?? 'info'
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'))
  const clock = options.clock ?? new SystemClock()
  const pretty = options.pretty ?? false

  function make(bound: LogFields): Logger {
    const emit = (at: LogLevel, message: string, fields?: LogFields): void => {
      if (ORDER[at] < ORDER[level]) return
      const merged = { ...bound, ...(fields ?? {}) }
      const safe = redactDeep({ message, ...merged }) as LogFields & { message: string }
      if (pretty) {
        const rest = Object.entries(safe)
          .filter(([k]) => k !== 'message')
          .map(([k, v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v)))
          .join(' ')
        write(at.toUpperCase().padEnd(5) + ' ' + safe.message + (rest ? ' ' + rest : ''))
        return
      }
      write(JSON.stringify({ at: clock.nowIso(), level: at, ...safe }, jsonReplacer))
    }
    return {
      level,
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (fields) => make({ ...bound, ...fields }),
    }
  }

  return make({})
}

/**
 * Serialise the shapes `JSON.stringify` gets wrong.
 *
 * An Error stringifies to `{}`, so a logged failure loses its message; a Set or
 * Map does the same and loses its contents. Both have hidden real causes in
 * logs before now.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const safe = redactError(value)
    return { name: safe.name, message: safe.message, stack: safe.stack }
  }
  if (value instanceof Set) return [...value]
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

/** Discards everything. For tests and for the library's default. */
export function nullLogger(): Logger {
  const self: Logger = {
    level: 'error',
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => self,
  }
  return self
}
