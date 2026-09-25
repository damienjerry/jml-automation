/**
 * `jml store bootstrap | verify | migrate | backup`.
 *
 * Bootstrap is the first command an adopter should run and the one most likely
 * to be skipped. It imports the whole HR history as tombstones, so a person
 * who left three years ago is already closed before the engine is ever armed.
 * Without it, the first run reads a full HR history, sees hundreds of people
 * with no offboarding marker, and concludes they are all brand new
 * terminations. That is not hypothetical: it happened, a migration removed the
 * tombstone rows, and accounts closed years earlier began to be suspended
 * again.
 *
 * Verify is the other half of the same lesson. It prints the exact day-0
 * selection and the exact tombstone count, so the two sides of a migration can
 * be compared as numbers rather than as an impression that the data looks
 * right.
 */

import { mkdir } from 'node:fs/promises'
import { openDatabase } from '../../store/sqlite/store.ts'
import { bootstrapTombstones, verifyStore, type BootstrapReport } from '../../store/bootstrap.ts'
import { CliError, openRuntime, statePath, type CliIo } from './context.ts'

export interface StoreCommandOptions {
  configPath?: string
  action: 'bootstrap' | 'verify' | 'migrate' | 'backup'
  armed?: boolean
  json?: boolean
  expectDay0?: number
  expectDeparted?: number
  /** Directory the backup copies are written into. */
  to?: string
}

export async function storeCommand(io: CliIo, opts: StoreCommandOptions): Promise<number> {
  const rt = await openRuntime({ io, ...(opts.configPath ? { configPath: opts.configPath } : {}) })
  try {
    if (opts.action === 'bootstrap') {
      const snapshot = await rt.hris.fetchAll()
      const report = await bootstrapTombstones({
        people: rt.store,
        snapshot,
        // Bootstrap writes hundreds of rows, so it is the one command where a
        // rehearsal is worth more than the run: `--armed` is required.
        dryRun: opts.armed !== true,
        today: rt.clock.today(rt.cfg.org.timezone),
        clock: rt.clock,
      })
      io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderBootstrap(report) + '\n')
      return report.ok ? 0 : 1
    }

    if (opts.action === 'verify') {
      const report = await verifyStore(rt.store, {
        ...(opts.expectDay0 === undefined ? {} : { day0Selection: opts.expectDay0 }),
        ...(opts.expectDeparted === undefined ? {} : { departed: opts.expectDeparted }),
      })
      io.out(
        opts.json
          ? JSON.stringify(report, null, 2) + '\n'
          : [
              '',
              'store          ' + rt.cfg.store.adapter,
              'total          ' + report.counts.total,
              'hired          ' + report.counts.hired,
              'active         ' + report.counts.active,
              'terminated     ' + report.counts.terminated,
              'offboarding    ' + report.counts.offboarding,
              'departed       ' + report.counts.departed + '   (tombstones: these are what stop a re-fire)',
              'held           ' + report.counts.held,
              'parked         ' + report.counts.parked,
              'day-0 today    ' + report.counts.day0Selection + '   (the set a run would act on)',
              '',
              ...report.mismatches.map((line) => 'MISMATCH: ' + line),
              report.mismatches.length > 0 ? '' : 'every stated expectation held',
              '',
            ].join('\n'),
      )
      return report.ok ? 0 : 1
    }

    if (opts.action === 'migrate') {
      // Opening the store applied every migration this build knows about, and
      // refused to open at all if the file carries one it does not know. So by
      // the time this line runs, the work is done and the only useful thing to
      // print is what the schema now holds.
      const report = await verifyStore(rt.store)
      io.out(
        'migrations for the ' +
          rt.cfg.store.adapter +
          ' store are applied; ' +
          report.counts.total +
          ' rows readable, ' +
          report.counts.departed +
          ' tombstones intact\n',
      )
      return 0
    }

    return backup(io, rt.cfg.store.adapter === 'sqlite' ? rt.cfg.store.path : null, statePath(rt.cfg), opts.to)
  } finally {
    await rt.close()
  }
}

function renderBootstrap(report: BootstrapReport): string {
  return [
    '',
    (report.dryRun ? 'BOOTSTRAP REHEARSAL (nothing was written)' : 'bootstrap applied') + '',
    '',
    'scanned          ' + report.scanned,
    'not employed     ' + report.inactive,
    'tombstoned       ' + report.tombstoned,
    'already present  ' + report.alreadyPresent + '   (left exactly as they were, whatever their status)',
    'skipped: employed ' + report.skippedActive,
    'skipped: not started yet ' + report.skippedHired,
    'skipped: no email ' + report.skippedNoEmail,
    '',
    'tombstones after   ' + report.departedAfter,
    'day-0 selection    ' + report.day0SelectionAfter + '   (this must be 0 before you arm anything)',
    '',
    ...report.warnings.map((line) => 'warning: ' + line),
    report.ok
      ? 'nothing would start offboarding, which is the whole point of this command'
      : 'SOMETHING WOULD STILL BE OFFBOARDED. Read those rows before arming the engine.',
    '',
  ].join('\n')
}

/**
 * A consistent copy of both databases.
 *
 * `VACUUM INTO` rather than a file copy. The store runs in write-ahead-log
 * mode, so copying the file while anything is writing produces a database that
 * opens and is missing the most recent transactions, which is the worst
 * possible outcome for a backup: it looks like it worked.
 *
 * The audit log is not copied. It is append-only JSONL and hash-chained, so
 * ordinary file backup handles it, and copying it here would silently split
 * the chain across two places.
 */
async function backup(io: CliIo, storeFile: string | null, stateFile: string, to: string | undefined): Promise<number> {
  if (!storeFile) {
    throw new CliError(
      'this configuration does not use the local SQLite people store, so there is no file to copy. ' +
        'Back the remote store up where it lives.',
      { exitCode: 2, docsAnchor: 'docs/runbooks/store-migration.md' },
    )
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = (to ?? 'data').replace(/\/+$/, '')
  // VACUUM INTO writes a new file and will not create the directory for it.
  await mkdir(dir, { recursive: true })
  const copies = [
    { from: storeFile, to: dir + '/jml-people-' + stamp + '.sqlite' },
    { from: stateFile, to: dir + '/jml-state-' + stamp + '.sqlite' },
  ]

  for (const copy of copies) {
    if (copy.from === ':memory:') continue
    const db = openDatabase(copy.from)
    try {
      // The destination is quoted as an SQL string literal, so a path holding
      // a quote cannot become part of the statement.
      db.exec("VACUUM INTO '" + copy.to.replace(/'/g, "''") + "'")
    } finally {
      db.close()
    }
    io.out('wrote ' + copy.to + '\n')
  }
  io.out(
    'The audit log is append-only and hash-chained, so it is not copied here. Back up the audit directory ' +
      'with your ordinary file backup, and run `jml audit verify` on the copy.\n',
  )
  return 0
}
