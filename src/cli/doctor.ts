/**
 * `jml doctor`: prove every credential, then say what is stuck.
 *
 * Two halves, and the second is the one adopters do not expect.
 *
 * The first half probes each configured credential and each per-scope
 * authorisation, and prints a pass or fail row naming the documentation
 * anchor for anything that failed. It exists because a partially authorised
 * credential is the worst kind: it works for the read the connector does at
 * start-up and fails on the one write that matters, a week later, at three in
 * the morning. In the automation this was ported from, one service account was
 * authorised for user administration and not for group administration, and
 * that was discovered by a step silently doing nothing for months.
 *
 * The second half reports the age of the oldest parked row. Parking a person
 * is how this toolkit refuses to guess, and it is silent by design: a parked
 * row takes no action and raises nothing after the first notice. Over
 * suppression therefore looks exactly like a quiet week, so the age of the
 * oldest one is printed whether anybody asked or not.
 */

import { ConfigError } from '../config/load.ts'
import { verifyStore, type VerifyReport } from '../store/bootstrap.ts'
import { CliError, openRuntime, type CliIo, type Runtime } from './commands/context.ts'
import {
  DEFAULT_PARKED_WARN_DAYS,
  parkedRows,
  probe,
  probeAuditDirectory,
  probeGoogleScopes,
  probeStateStore,
  row,
  skipped,
  type DoctorRow,
  type ParkedRow,
} from './commands/probes.ts'

export { DEFAULT_PARKED_WARN_DAYS } from './commands/probes.ts'
export type { DoctorRow, ParkedRow } from './commands/probes.ts'

export interface DoctorReport {
  ok: boolean
  at: string
  mode: 'dry-run' | 'armed'
  armedActions: readonly string[]
  rows: DoctorRow[]
  /** Every resolved credential as a location and a length, never a value. */
  secrets: { path: string; ref: string; length: number }[]
  parkedCount: number
  oldestParked: ParkedRow | null
  storeCounts: VerifyReport['counts'] | null
  failures: string[]
}

export interface DoctorOptions {
  /** Includes the Slack write probe, which posts and deletes a message. */
  probeWrites?: boolean
  parkedWarnDays?: number
}

export async function runDoctor(rt: Runtime, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const rows: DoctorRow[] = []
  const cfg = rt.cfg

  rows.push(
    row(
      'configuration',
      true,
      `${rt.source}: mode ${cfg.mode}, ` +
        (cfg.armedActions.length > 0 ? `armed for ${cfg.armedActions.join(', ')}` : 'nothing armed'),
      'docs/config-reference.md',
    ),
  )

  for (const entry of rt.secrets.describe()) {
    rows.push(
      row(
        `credential ${entry.path}`,
        true,
        `resolved from ${entry.ref}, ${entry.length} characters`,
        'docs/config-reference.md#secret-references',
      ),
    )
  }

  rows.push(await probeAuditDirectory(rt))
  rows.push(await probeStateStore(rt))

  let storeCounts: VerifyReport['counts'] | null = null
  const store = await probe('people store', 'docs/runbooks/store-migration.md', async () => {
    const counts = (await verifyStore(rt.store)).counts
    storeCounts = counts
    return row(
      'people store',
      true,
      `${cfg.store.adapter}: ${counts.total} rows, ${counts.departed} tombstones, ` +
        `${counts.day0Selection} would start offboarding today`,
      'docs/runbooks/store-migration.md',
    )
  })
  rows.push(store)

  rows.push(
    await probe('HR system', 'docs/credentials.md', async () => {
      const check = await rt.hris.testConnection()
      return row('HR system', check.ok, check.detail, check.docsAnchor ?? 'docs/credentials.md', check.remediation)
    }),
  )

  if (!rt.providers) {
    rows.push(
      skipped(
        'identity provider',
        'not probed: this command was opened without provider credentials',
        'docs/credentials.md',
      ),
    )
  } else {
    const providers = rt.providers
    rows.push(
      await probe('identity provider', 'docs/credentials.md', async () => {
        const check = await providers.idp.testConnection()
        return row(
          'identity provider',
          check.ok,
          check.detail,
          check.docsAnchor ?? 'docs/credentials.md',
          check.remediation,
        )
      }),
    )
    rows.push(
      await probe('google workspace', 'docs/credentials.md', async () => {
        const check = await providers.google.testConnection()
        return row(
          'google workspace',
          check.ok,
          check.detail,
          check.docsAnchor ?? 'docs/credentials.md',
          check.remediation,
        )
      }),
    )
    rows.push(...(await probeGoogleScopes(providers.google)))
  }

  rows.push(
    await probe('notifications', 'docs/config-reference.md#keys', async () => {
      const check = await rt.notifier.testConnection()
      return row('notifications', check.ok, check.detail, 'docs/config-reference.md#keys', check.remediation)
    }),
  )

  const parked = await parkedRows(rt, opts.parkedWarnDays ?? DEFAULT_PARKED_WARN_DAYS)
  rows.push(parked.row)

  const failures = rows.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)
  return {
    ok: failures.length === 0,
    at: rt.clock.nowIso(),
    mode: cfg.mode,
    armedActions: cfg.armedActions,
    rows,
    secrets: rt.secrets.describe(),
    parkedCount: parked.count,
    oldestParked: parked.oldest,
    storeCounts,
    failures,
  }
}

const COLUMN = 34

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ['', `jml doctor  ${report.at}`, '']
  for (const line of report.rows) {
    const mark = line.skipped ? 'skip' : line.ok ? 'pass' : 'FAIL'
    lines.push(`${mark}  ${line.name.padEnd(COLUMN)}  ${line.detail}`)
    if (!line.ok) {
      if (line.remediation) lines.push(`      ${''.padEnd(COLUMN)}  ${line.remediation}`)
      lines.push(`      ${''.padEnd(COLUMN)}  see ${line.docsAnchor}`)
    }
  }
  lines.push('')
  lines.push(report.ok ? 'every check passed' : `${report.failures.length} check(s) failed`)
  lines.push('')
  return lines.join('\n')
}

/**
 * The command wrapper.
 *
 * A configuration error is turned into failing rows rather than being allowed
 * to end the command, because the one time an operator most needs the table is
 * when a credential will not resolve.
 */
export async function doctorCommand(
  io: CliIo,
  opts: { configPath?: string; json?: boolean; probeWrites?: boolean },
): Promise<number> {
  let rt: Runtime
  try {
    rt = await openRuntime({ io, withProviders: true, ...(opts.configPath ? { configPath: opts.configPath } : {}) })
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    const rows = err.issues.map((issue) =>
      row(issue.path || 'configuration', false, issue.message, issue.docsAnchor),
    )
    const report: DoctorReport = {
      ok: false,
      at: new Date().toISOString(),
      mode: 'dry-run',
      armedActions: [],
      rows,
      secrets: [],
      parkedCount: 0,
      oldestParked: null,
      storeCounts: null,
      failures: rows.map((r) => `${r.name}: ${r.detail}`),
    }
    io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderDoctor(report))
    return 78
  }

  try {
    const report = await runDoctor(rt, opts.probeWrites ? { probeWrites: true } : {})
    io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderDoctor(report))
    return report.ok ? 0 : 1
  } finally {
    await rt.close()
  }
}

/** Refuse to start the sidecar when the things it cannot work without are broken. */
export async function assertServable(rt: Runtime): Promise<void> {
  const audit = await probeAuditDirectory(rt)
  if (!audit.ok) {
    throw new CliError(
      `refusing to serve: ${audit.detail}. A step whose intent cannot be recorded must not run, ` +
        `so the sidecar does not start without a writable audit log.`,
      { exitCode: 78, docsAnchor: audit.docsAnchor },
    )
  }
  // Read-only on purpose. The pipeline is what raises the tombstone baseline;
  // a health check that wrote it could record an empty store as normal, which
  // is precisely the picture a missing volume produces.
  let departed: number
  try {
    departed = await rt.store.countExact({ status: ['departed'] })
  } catch (err) {
    throw new CliError(
      `refusing to serve: the people store could not be counted: ${err instanceof Error ? err.message : String(err)}`,
      { exitCode: 78, docsAnchor: 'docs/runbooks/store-migration.md' },
    )
  }
  const baseline = await rt.state.getCounter('people.departed')
  if (baseline !== null && departed < baseline) {
    throw new CliError(
      `refusing to serve: the tombstone count has fallen from ${baseline} to ${departed}. ` +
        `Tombstones are what stop a historic leaver being offboarded again, so nothing runs until somebody ` +
        `knows why they went.`,
      { exitCode: 78, docsAnchor: 'docs/runbooks/store-migration.md' },
    )
  }
}
