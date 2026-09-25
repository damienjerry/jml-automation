/**
 * `jml store bootstrap` and `jml store verify`.
 *
 * These two commands exist because of one incident, and it is the worst one on
 * record for this class of automation. A data migration removed the tombstone
 * rows for people who had already left. The next HR sync read a full history,
 * saw hundreds of leavers with no offboarding marker, and concluded they were
 * all brand new terminations. The offboarding engine then began suspending
 * accounts that had been closed for years, and several schedules had to be
 * turned off by hand while the rows were rebuilt.
 *
 * So the first thing anybody does with a new store is import their whole HR
 * history as tombstones, before the engine is ever armed. After that, `verify`
 * is what you run before a migration or a cutover: it prints the exact Day-0
 * selection and the exact tombstone count, so the two sides of a move can be
 * compared as numbers rather than as an impression.
 */

import { SystemClock, type Clock } from '../core/clock.ts'
import { deriveHrisStatus } from '../hris/status.ts'
import { HrisIncomplete, type HrisSnapshot } from '../hris/types.ts'
import type { Person } from '../core/types.ts'
import type { PeopleStore, PersonFilter, StateStore } from './types.ts'

/**
 * The one definition of "somebody the engine would start offboarding today".
 *
 * Exported so the engine, the bootstrap check and `verify` cannot drift into
 * three slightly different ideas of the same set. A held or parked row is
 * excluded here, which is why both flags are safe as a way to stop automation
 * on one person.
 */
export const DAY0_SELECTION: PersonFilter = {
  status: ['terminated'],
  excludeHeld: true,
  parked: false,
  suspendedAt: 'empty',
}

/** The invariant counter the pipeline compares before it does any work. */
export const DEPARTED_COUNTER = 'people.departed'

export interface BootstrapOptions {
  people: PeopleStore
  /** A full HR snapshot, including leavers. */
  snapshot: HrisSnapshot
  /** Report what it would do and write nothing. */
  dryRun?: boolean
  /**
   * Today's date in the organisation's own timezone. Pass it: the fallback is
   * the UTC date, which is the previous calendar day for part of the evening
   * in any zone ahead of UTC.
   */
  today?: string
  clock?: Clock
  /** Recorded on each row so a bootstrapped tombstone is distinguishable. */
  source?: string
}

export interface BootstrapReport {
  /** Everybody in the snapshot. */
  scanned: number
  /** People the HR system does not list as employed. */
  inactive: number
  tombstoned: number
  /** Rows that already existed, whose status was left exactly as it was. */
  alreadyPresent: number
  skippedActive: number
  /**
   * People whose start date is still ahead. HR systems keep them off the
   * employed list until their first day, so without this they read as
   * historic leavers and are tombstoned before they arrive.
   */
  skippedHired: number
  /** Inactive people carrying no address, which cannot be tombstoned. */
  skippedNoEmail: number
  day0SelectionAfter: number
  departedAfter: number
  dryRun: boolean
  /**
   * True when no offboarding case is selectable afterwards, which is the whole
   * promise of the command. Anything else worth a person's attention is in
   * `warnings`, which is never silently empty.
   */
  ok: boolean
  warnings: string[]
}

/**
 * Import every HR-inactive person as a tombstone.
 *
 * Rows are created straight into `departed` rather than being created as a
 * leaver and then transitioned. Creating them as leavers would mean a window,
 * however short, in which a concurrent run could select several hundred
 * historic people for offboarding, which is precisely the accident being
 * defended against.
 *
 * An existing row is never touched, whatever status it holds. Somebody who
 * left and was rehired is a live person, and a bootstrap that overwrote them
 * would be the same class of mistake in the opposite direction.
 */
export async function bootstrapTombstones(options: BootstrapOptions): Promise<BootstrapReport> {
  const { people, snapshot } = options
  const clock = options.clock ?? new SystemClock()
  const today = options.today ?? clock.today('UTC')
  const source = options.source ?? 'bootstrap'
  const dryRun = options.dryRun === true
  const warnings: string[] = []

  if (!snapshot.complete) {
    // A partial history is the dangerous case: the people missing from it are
    // exactly the ones who would later look like new terminations.
    throw new HrisIncomplete(
      'Refusing to bootstrap from an incomplete HR snapshot. Every person missing from it would look like a new leaver on the first run.',
    )
  }

  let inactive = 0
  let tombstoned = 0
  let alreadyPresent = 0
  let skippedActive = 0
  let skippedHired = 0
  let skippedNoEmail = 0

  for (const record of snapshot.all) {
    if (snapshot.activeIds.has(record.hrisId)) {
      skippedActive += 1
      continue
    }
    // The same rule the sync applies, so the two cannot disagree about who
    // has left. A future starter is off the employed list and is not a leaver.
    if (deriveHrisStatus(record, snapshot.activeIds, today) === 'hired') {
      skippedHired += 1
      continue
    }
    inactive += 1

    const existing = await people.get(record.hrisId)
    if (existing) {
      alreadyPresent += 1
      if (existing.status !== 'departed') {
        warnings.push(
          `${record.hrisId} already has a row with status ${existing.status}; left untouched. Bootstrap never changes an existing status.`,
        )
      }
      continue
    }

    if (!record.primaryEmail || record.primaryEmail.trim() === '') {
      skippedNoEmail += 1
      warnings.push(
        `${record.hrisId} has no email address in the HR system, so no tombstone was created. Nothing can be resolved for them in any provider either; check the HR record.`,
      )
      continue
    }

    if (!dryRun) {
      const tombstone: Person = {
        hrisId: record.hrisId,
        status: 'departed',
        primaryEmail: record.primaryEmail,
        aliasEmails: [],
        displayName: record.displayName,
        firstName: record.firstName ?? null,
        lastName: record.lastName ?? null,
        department: record.department ?? null,
        jobTitle: record.jobTitle ?? null,
        site: record.site ?? null,
        managerEmail: record.managerEmail ?? null,
        startDate: record.startDate ?? null,
        terminationDate: record.terminationDate ?? null,
        lastWorkingDay: record.lastWorkingDay ?? null,
        personalEmail: record.personalEmail ?? null,
        inScope: record.inScope ?? null,
        hold: false,
        holdReason: null,
        reviewReason: null,
        externalIds: {},
        googleAccountPresent: null,
        offboarding: {
          // No Day-0 marker: this person never went through the engine. The
          // tombstone status is what keeps them out of every selection.
          suspendedAt: null,
          legs: {},
          departedAt: today,
        },
        note: `Imported as a tombstone by store bootstrap on ${today}. No account work was done and none is owed.`,
        source,
      }
      await people.upsert(tombstone)
    }
    tombstoned += 1
  }

  const day0SelectionAfter = await people.countExact(DAY0_SELECTION)
  const departedAfter = await people.countExact({ status: ['departed'] })

  if (day0SelectionAfter > 0) {
    warnings.push(
      `${day0SelectionAfter} row(s) would still be selected for offboarding after bootstrap. Read them with \`jml store list --status terminated\` before arming the engine.`,
    )
  }

  return {
    scanned: snapshot.all.length,
    inactive,
    tombstoned,
    alreadyPresent,
    skippedActive,
    skippedHired,
    skippedNoEmail,
    day0SelectionAfter,
    departedAfter,
    dryRun,
    ok: day0SelectionAfter === 0,
    warnings,
  }
}

export interface VerifyExpectations {
  /** The number of rows that would be offboarded today. */
  day0Selection?: number
  /** The number of tombstones. */
  departed?: number
}

export interface VerifyReport {
  ok: boolean
  counts: {
    total: number
    hired: number
    active: number
    terminated: number
    offboarding: number
    departed: number
    held: number
    parked: number
    day0Selection: number
  }
  /** One line per expectation that was not met. Empty when ok. */
  mismatches: string[]
}

/**
 * Count the store, and compare against what the operator says it should be.
 *
 * Run this on both sides of a migration. The two numbers that matter are the
 * tombstone count, because losing tombstones re-fires historic leavers, and
 * the Day-0 selection, because that is the set of people something is about to
 * act on. An impression that "the data looks right" is what allowed the
 * original incident through.
 */
export async function verifyStore(people: PeopleStore, expected: VerifyExpectations = {}): Promise<VerifyReport> {
  const counts = {
    total: await people.countExact(),
    hired: await people.countExact({ status: ['hired'] }),
    active: await people.countExact({ status: ['active'] }),
    terminated: await people.countExact({ status: ['terminated'] }),
    offboarding: await people.countExact({ status: ['offboarding'] }),
    departed: await people.countExact({ status: ['departed'] }),
    // The filter can only exclude held rows, not select them, so this one is
    // counted from the rows themselves.
    held: (await people.list()).filter((person) => person.hold).length,
    parked: await people.countExact({ parked: true }),
    day0Selection: await people.countExact(DAY0_SELECTION),
  }

  const mismatches: string[] = []
  if (expected.day0Selection !== undefined && expected.day0Selection !== counts.day0Selection) {
    mismatches.push(`Day-0 selection is ${counts.day0Selection}, expected ${expected.day0Selection}.`)
  }
  if (expected.departed !== undefined && expected.departed !== counts.departed) {
    mismatches.push(`Tombstone (departed) count is ${counts.departed}, expected ${expected.departed}.`)
  }

  return { ok: mismatches.length === 0, counts, mismatches }
}

export interface DepartedInvariant {
  ok: boolean
  /** The count recorded on the last run, or null on a first run. */
  previous: number | null
  current: number
  /** Present when the check failed. Safe to put in an alert. */
  reason?: string
}

/**
 * Compare the tombstone count against the last run's, and refuse when it fell.
 *
 * Tombstones only ever accumulate, so a decrease means rows were removed by
 * something outside this toolkit. That is the exact signature of the migration
 * incident, and at that moment every removed person looks like a new leaver, so
 * the correct response is to do nothing at all until a human has looked.
 *
 * On failure the recorded baseline is deliberately left alone. Writing the new,
 * lower number would make the next run consider the loss normal and proceed.
 */
export async function checkDepartedInvariant(
  people: PeopleStore,
  state: StateStore,
  opts: { dryRun?: boolean } = {},
): Promise<DepartedInvariant> {
  const current = await people.countExact({ status: ['departed'] })
  const previous = await state.getCounter(DEPARTED_COUNTER)

  if (previous !== null && current < previous) {
    return {
      ok: false,
      previous,
      current,
      reason:
        `The tombstone count fell from ${previous} to ${current}. Tombstones are what stop a historic leaver being offboarded again, ` +
        `so this run is refusing to do anything. Restore the rows, or clear the counter deliberately once you know why they went.`,
    }
  }

  // A rehearsal reads the counter and leaves it alone. The claim made about
  // dry run is that it writes nothing, and a caller spying on the state store
  // to check that claim should not find this. Skipping it costs nothing: the
  // armed run raises the baseline afterwards, and a null baseline never
  // aborts. Raising it here was harmless in direction, since the write only
  // ever goes upwards, but "harmless in direction" is a worse answer to "does
  // a dry run write" than "no".
  if (opts.dryRun !== true) await state.setCounter(DEPARTED_COUNTER, current)
  return { ok: true, previous, current }
}
