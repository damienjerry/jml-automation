/**
 * Turning a report into something somebody reads.
 *
 * Kept in one module because the CLI, the demo and every runbook screenshot
 * have to show the same thing. Two copies of this drift, and then the
 * documentation shows output the tool no longer produces.
 *
 * Two rules. Counts are printed sorted and zeroes are dropped, so a run with
 * nothing to do says so in one line instead of a column of noughts. Legs print
 * their state and whether the effect was verified, because "done" and "the
 * provider accepted it and changed nothing" are the difference this whole
 * toolkit is about.
 */

import type { Person, RunReport } from '../../core/types.ts'

/** One run, in the shape somebody reads rather than the shape it is stored in. */
export function renderRunReport(report: RunReport): string {
  const lines: string[] = []
  lines.push(
    'run ' + report.runId + '  ' + report.kind + '  ' + (report.dryRun ? 'dry-run' : 'armed') + '  ok=' + report.ok,
  )
  if (report.aborted) lines.push('  ABORTED: ' + report.aborted.reason)
  const counts = Object.entries(report.counts)
    .filter(([, value]) => value !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => name + '=' + value)
  lines.push('  counts: ' + (counts.length > 0 ? counts.join(' ') : 'nothing to do'))
  for (const person of report.people) {
    const legs = Object.entries(person.legs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, leg]) => name + '=' + leg.state + (leg.verified ? '(verified)' : ''))
    lines.push(
      '  ' +
        person.displayName.padEnd(16) +
        person.phase.padEnd(15) +
        person.statusBefore +
        ' -> ' +
        person.statusAfter +
        (person.blockedReason ? '  blocked: ' + person.blockedReason : '') +
        (person.reviewReason ? '  parked: ' + person.reviewReason : ''),
    )
    if (legs.length > 0) lines.push('      ' + legs.join(' '))
    for (const note of person.notes ?? []) lines.push('      ' + note)
  }
  for (const warning of report.warnings) lines.push('  warning: ' + warning)
  for (const error of report.errors) lines.push('  error: ' + error)
  return lines.join('\n')
}

/** One person, one line. The state machine, printed. */
export function describePerson(person: Person): string {
  const marks: string[] = []
  if (person.offboarding?.suspendedAt) marks.push('suspendedAt=' + person.offboarding.suspendedAt)
  if (person.offboarding?.transferredAt) marks.push('transferred')
  if (person.offboarding?.deleteBlockedReason) marks.push('blocked=' + person.offboarding.deleteBlockedReason)
  if (person.reviewReason) marks.push('parked=' + person.reviewReason)
  if (person.hold) marks.push('hold')
  return person.hrisId + '  ' + person.status.padEnd(12) + person.displayName.padEnd(16) + marks.join(' ')
}
