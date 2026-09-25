/**
 * Which date decides when somebody's access ends.
 *
 * The HR system can hold two dates for a leaver: the day the contract ends and
 * the last day the person is actually in. They differ more often than not,
 * and it is the second one that matters, because a laptop and a mailbox
 * should stop working when the person stops coming in, not when the paperwork
 * says the employment ended. The automation this was ported from originally
 * keyed on the contract date and left access open for the gap.
 *
 * The rule, in order:
 *  1. Last working day, when it is held and is not after the termination
 *     date. A last working day after the contract end is a data error, and the
 *     contract end wins.
 *  2. Otherwise the termination date.
 *  3. A date before the current start date belongs to an earlier stint: the
 *     person left once and came back. Each date is judged on its own, so a
 *     stale last working day from the previous stint cannot drag a genuine
 *     current termination date down with it, and a rehire is never offboarded
 *     on their first morning.
 *
 * Absence of both dates is not an error here. The sync falls back to the HR
 * system's employed set, which is the one signal every HR system has.
 */

export interface LeaveDates {
  startDate?: string | null
  terminationDate?: string | null
  lastWorkingDay?: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function iso(value: string | null | undefined): string | null {
  return typeof value === 'string' && ISO_DATE.test(value) ? value : null
}

/** The date after which access ends, or null when the HR system holds none. */
export function leaveDateOf(p: LeaveDates): string | null {
  const start = iso(p.startDate)
  const current = (value: string | null): string | null =>
    value !== null && start !== null && value < start ? null : value
  const lwd = current(iso(p.lastWorkingDay))
  const term = current(iso(p.terminationDate))

  return lwd !== null && (term === null || lwd <= term) ? lwd : term
}

/** Which field the leave date came from, for reports and audit rows. */
export function leaveDateSource(p: LeaveDates): 'lastWorkingDay' | 'terminationDate' | null {
  const leave = leaveDateOf(p)
  if (leave === null) return null
  return leave === iso(p.lastWorkingDay) ? 'lastWorkingDay' : 'terminationDate'
}
