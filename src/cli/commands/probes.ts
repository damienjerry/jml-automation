/**
 * The individual checks `jml doctor` runs.
 *
 * Each one answers with a row rather than throwing, because the table is worth
 * more than the first failure: an operator wants to see that the identity
 * provider is fine and Google is not, in one pass, with the documentation
 * anchor for the half that is broken.
 *
 * Two of these checks are here for reasons that are easy to lose. The state
 * store is probed under its own lease name, never the pipeline's, so a health
 * check cannot take the lease the next scheduled run needs. And the parked
 * rows are counted and aged because parking is silent by design: a parked row
 * takes no action and raises nothing after the first notice, so nobody is
 * reminded that a decision is still owed.
 */

import { access, constants, mkdir } from 'node:fs/promises'
import { daysBetween } from '../../core/clock.ts'
import type { Person, ReviewReason } from '../../core/types.ts'
import { REQUIRED_SCOPE_USES } from '../../connectors/google/index.ts'
import type { Runtime } from './context.ts'

/** Rows older than this make the parked-row check fail rather than inform. */
export const DEFAULT_PARKED_WARN_DAYS = 7

export interface DoctorRow {
  name: string
  ok: boolean
  /** What the probe learned. Never a credential value; lengths only. */
  detail: string
  remediation: string | null
  docsAnchor: string
  /** True when config does not use this thing, so nothing was probed. */
  skipped: boolean
}

export interface ParkedRow {
  hrisId: string
  displayName: string
  reviewReason: ReviewReason | null
  /** Whole days since the row was last written, or null when unknown. */
  ageDays: number | null
}

export function row(
  name: string,
  ok: boolean,
  detail: string,
  docsAnchor: string,
  remediation?: string | null,
): DoctorRow {
  return { name, ok, detail, docsAnchor, remediation: remediation ?? null, skipped: false }
}

export function skipped(name: string, detail: string, docsAnchor: string): DoctorRow {
  return { name, ok: true, detail, docsAnchor, remediation: null, skipped: true }
}

/** Turn a thrown probe into a failing row rather than losing the whole table. */
export async function probe(
  name: string,
  docsAnchor: string,
  fn: () => Promise<DoctorRow>,
): Promise<DoctorRow> {
  try {
    return await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return row(name, false, message, docsAnchor, 'the probe threw rather than answering; read the message above')
  }
}

/**
 * The audit directory has to be writable before anything else is attempted.
 *
 * A step whose intent cannot be recorded must not run, so an unwritable
 * directory is not a warning: it stops the sidecar starting and it is the
 * first thing this command checks.
 */
export async function probeAuditDirectory(rt: Runtime): Promise<DoctorRow> {
  const dir = rt.cfg.audit.jsonl.dir
  const anchor = 'docs/runbooks/incident-recovery.md#the-audit-log-fails-verification'
  try {
    await mkdir(dir, { recursive: true })
    await access(dir, constants.W_OK)
  } catch (err) {
    return row(
      'audit directory',
      false,
      `${dir} is not writable: ${err instanceof Error ? err.message : String(err)}`,
      anchor,
      'give the process write access to this directory, or point audit.jsonl.dir somewhere it has it',
    )
  }
  if (!rt.audit.verify) {
    return row('audit directory', true, `${dir} is writable; this sink cannot verify its own chain`, anchor)
  }
  const verified = await rt.audit.verify()
  return row(
    'audit chain',
    verified.ok,
    verified.ok
      ? `${dir}: ${verified.checkedLines} rows, chain intact`
      : `${dir}: chain breaks at line ${verified.firstBadLine ?? 0}`,
    anchor,
    verified.ok ? null : 'a broken chain means a row was edited or removed; keep the files and read the runbook',
  )
}

/**
 * Prove the state store by taking a lease and giving it straight back.
 *
 * Under its own name, never the pipeline's: probing with the pipeline lease
 * would either fail while a legitimate run holds it, or worse, take it and
 * make the next scheduled run skip.
 */
export async function probeStateStore(rt: Runtime): Promise<DoctorRow> {
  const anchor = 'docs/architecture.md'
  return probe('state store', anchor, async () => {
    const lease = await rt.state.acquireLease('doctor', 30)
    if (!lease) {
      return row('state store', true, 'another doctor run holds the probe lease, which is itself proof it works', anchor)
    }
    await rt.state.releaseLease(lease)
    const last = await rt.state.lastRun('pipeline')
    return row(
      'state store',
      true,
      last ? `leases work; last pipeline run ${last.at}: ${last.summary}` : 'leases work; no pipeline run recorded yet',
      anchor,
    )
  })
}

/**
 * One row per Google scope, so a missing authorisation names itself.
 *
 * A required scope that is not delegated fails the table. An optional one
 * reports as a failing row too, because a step that cannot run must not look
 * like a step that has nothing to do, but its remediation says what it costs.
 */
export async function probeGoogleScopes(
  google: NonNullable<Runtime['providers']>['google'],
): Promise<DoctorRow[]> {
  const anchor = 'docs/credentials.md#google-workspace'
  let reports: Awaited<ReturnType<typeof google.probeScopes>>
  try {
    reports = await google.probeScopes()
  } catch (err) {
    return [
      row(
        'google scopes',
        false,
        `the scope probe threw: ${err instanceof Error ? err.message : String(err)}`,
        anchor,
        'this probe asks the token endpoint only and changes nothing; a throw here is usually an unreadable key file',
      ),
    ]
  }
  if (reports.length === 0) {
    return [skipped('google scopes', 'this connector reports no scopes to probe', anchor)]
  }
  return reports.map((report) =>
    row(
      `google scope ${report.scope.replace('https://www.googleapis.com/auth/', '')}`,
      report.ok,
      report.ok
        ? `delegated${report.subject ? ` for ${report.subject}` : ''}`
        : `refused with ${report.error ?? `status ${report.status}`}`,
      anchor,
      report.ok
        ? null
        : `${report.breaksWithout}. ` +
          (REQUIRED_SCOPE_USES.length > 0 && report.required
            ? 'This scope is required: delegate it before arming anything.'
            : 'Delegate it, or leave the steps that need it unarmed.'),
    ),
  )
}

export async function parkedRows(rt: Runtime, warnDays: number): Promise<{ row: DoctorRow; count: number; oldest: ParkedRow | null }> {
  const anchor = 'docs/runbooks/hold-and-release.md'
  let people: Person[]
  try {
    people = await rt.store.list({ parked: true })
  } catch (err) {
    return {
      row: row(
        'parked rows',
        false,
        `the parked rows could not be read: ${err instanceof Error ? err.message : String(err)}`,
        anchor,
      ),
      count: 0,
      oldest: null,
    }
  }

  const today = rt.clock.today(rt.cfg.org.timezone)
  const aged: ParkedRow[] = people.map((person) => ({
    hrisId: person.hrisId,
    displayName: person.displayName || person.hrisId,
    reviewReason: person.reviewReason ?? null,
    ageDays: ageInDays(person, rt, today),
  }))
  aged.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
  const oldest = aged[0] ?? null

  if (!oldest) {
    return { row: row('parked rows', true, 'nothing is parked', anchor), count: 0, oldest: null }
  }
  const age = oldest.ageDays
  const stale = age !== null && age >= warnDays
  return {
    row: row(
      'parked rows',
      !stale,
      `${aged.length} parked; oldest is ${oldest.displayName} (${oldest.reviewReason ?? 'no reason recorded'})` +
        (age === null ? ', age unknown' : `, ${age} day(s)`),
      anchor,
      stale
        ? `a parked row takes no action and raises nothing, so nobody is reminded. Decide it, or release it with \`jml leaver release --hris-id ${oldest.hrisId}\`.`
        : null,
    ),
    count: aged.length,
    oldest,
  }
}

function ageInDays(person: Person, rt: Runtime, today: string): number | null {
  const stamp = person.updatedAt ?? person.terminationDate ?? null
  if (!stamp) return null
  try {
    const on = stamp.length > 10 ? rt.clock.dateOf(stamp, rt.cfg.org.timezone) : stamp
    return daysBetween(on, today)
  } catch {
    return null
  }
}

