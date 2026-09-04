/**
 * `jml audit tail | verify`, and `jml config show`.
 *
 * The audit log is a local append-only file per day, hash-chained line to
 * line. `verify` walks the chain and names the first line that does not check
 * out, which is how an edited or removed row is detectable at all. It is worth
 * running before a migration, after restoring a backup, and any time somebody
 * asks what happened to an account.
 *
 * `config show` prints the shape of the configuration, every credential as a
 * reference and a length, and no value anywhere. It is built by redacting a
 * structural copy rather than by choosing which fields to print, so a
 * credential that reached the config object by some route this code does not
 * know about is masked anyway.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describeConfig, loadConfig } from '../../config/load.ts'
import type { AuditEvent } from '../../audit/types.ts'
import { CliError, openRuntime, type CliIo } from './context.ts'

const FILE_PATTERN = /^jml-\d{4}-\d{2}-\d{2}\.jsonl$/
const DEFAULT_TAIL = 20

export interface AuditCommandOptions {
  configPath?: string
  action: 'tail' | 'verify'
  lines?: number
  json?: boolean
}

export async function auditCommand(io: CliIo, opts: AuditCommandOptions): Promise<number> {
  const rt = await openRuntime({ io, ...(opts.configPath ? { configPath: opts.configPath } : {}) })
  const dir = rt.cfg.audit.jsonl.dir
  try {
    if (opts.action === 'verify') {
      if (!rt.audit.verify) {
        throw new CliError('this audit sink cannot verify its own chain', { exitCode: 2 })
      }
      // A directory that cannot be read is reported as itself rather than as a
      // broken chain. The two need opposite responses: one is a fresh install
      // or a volume that did not mount, the other is a row somebody edited.
      const result = await rt.audit.verify().catch((err: unknown) => {
        throw new CliError(
          'the audit log at ' +
            dir +
            ' could not be read: ' +
            (err instanceof Error ? err.message : String(err)) +
            '. On a fresh install nothing has been recorded yet. Otherwise the log is not where the ' +
            'configuration says it is, which on a container usually means the volume did not mount.',
          { exitCode: 1, docsAnchor: 'docs/runbooks/incident-recovery.md#the-audit-log-fails-verification' },
        )
      })
      if (result.ok) {
        io.out('the audit chain in ' + dir + ' is intact across ' + result.checkedLines + ' rows\n')
        return 0
      }
      io.err(
        'the audit chain in ' +
          dir +
          ' BREAKS at line ' +
          (result.firstBadLine ?? 0) +
          ' after ' +
          result.checkedLines +
          ' good rows.\n' +
          'A break means a row was edited or removed. Keep the files as they are and read ' +
          'docs/runbooks/incident-recovery.md#the-audit-log-fails-verification before doing anything else.\n',
      )
      return 1
    }

    const rows = await tail(dir, opts.lines ?? DEFAULT_TAIL)
    if (rows.length === 0) {
      io.out('no audit rows in ' + dir + ' yet\n')
      return 0
    }
    io.out(opts.json ? rows.map((row) => JSON.stringify(row)).join('\n') + '\n' : renderTail(rows) + '\n')
    return 0
  } finally {
    await rt.close()
  }
}

/** The last `count` rows across the daily files, oldest first. */
async function tail(dir: string, count: number): Promise<AuditEvent[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort()
  } catch {
    return []
  }
  const rows: AuditEvent[] = []
  // Newest file first, stopping as soon as there are enough rows, so a year of
  // logs is not read to print twenty lines.
  for (const name of names.reverse()) {
    const text = await readFile(join(dir, name), 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    for (const line of lines.reverse()) {
      try {
        rows.push(JSON.parse(line) as AuditEvent)
      } catch {
        // A corrupt line is left for `verify` to report. Skipping it here
        // keeps the tail readable; pretending the file is sound is `verify`'s
        // job to refuse, not this command's.
        continue
      }
      if (rows.length >= count) break
    }
    if (rows.length >= count) break
  }
  return rows.reverse()
}

function renderTail(rows: readonly AuditEvent[]): string {
  return rows
    .map((row) => {
      const state = row.phase === 'intent' ? 'intent ' : row.ok === undefined ? 'outcome' : row.ok ? 'ok     ' : 'FAILED '
      return (
        row.at +
        '  ' +
        state +
        '  ' +
        (row.dryRun ? 'dry-run ' : 'armed   ') +
        row.action.padEnd(26) +
        row.subject.kind +
        ':' +
        row.subject.id +
        '  by ' +
        row.actor.id +
        (row.verified === true ? '  verified' : '')
      )
    })
    .join('\n')
}

export async function configShowCommand(
  io: CliIo,
  opts: { configPath?: string; json?: boolean; resolveSecrets?: boolean },
): Promise<number> {
  const loaded = await loadConfig({
    ...(opts.configPath ? { path: opts.configPath } : {}),
    env: io.env,
    // Resolving proves the credentials are reachable and prints their lengths.
    // `--no-secrets` skips it so the command still works on a machine that
    // holds none of them.
    ...(opts.resolveSecrets === false ? { allowMissingSecrets: true } : {}),
  })
  const described = describeConfig(loaded)
  io.out(JSON.stringify(described, null, 2) + '\n')
  return 0
}
