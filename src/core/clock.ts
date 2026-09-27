/**
 * Time, and the one rule that matters about it.
 *
 * Every date in this toolkit is a calendar date in the organisation's declared
 * IANA zone, and calendar dates are never derived by taking `toISOString()` and
 * cutting off the time. In a zone ahead of UTC, a moment just after local
 * midnight is still the previous day in UTC, so an earlier version of this code
 * computed "today" as yesterday for the first hour of every summer day. A
 * leaver's day 7 arrived a day early for anybody whose offboarding started in
 * that window.
 *
 * The fix is in two halves. Deriving today's date from an instant goes through
 * `Intl.DateTimeFormat` with an explicit zone, and arithmetic on a date is done
 * on the calendar fields, which have no zone at all.
 */

/** A calendar date, `YYYY-MM-DD`, in the configured zone. */
export type IsoDate = string
/** An instant, RFC 3339 in UTC. */
export type IsoDateTime = string

export interface Clock {
  now(): Date
  nowIso(): IsoDateTime
  /** Today's calendar date in the given zone. */
  today(zone: string): IsoDate
  /** The calendar date an instant falls on in the given zone. */
  dateOf(instant: Date | IsoDateTime, zone: string): IsoDate
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
  nowIso(): IsoDateTime {
    return this.now().toISOString()
  }
  today(zone: string): IsoDate {
    return dateInZone(this.now(), zone)
  }
  dateOf(instant: Date | IsoDateTime, zone: string): IsoDate {
    return dateInZone(typeof instant === 'string' ? new Date(instant) : instant, zone)
  }
}

/**
 * A clock the tests control.
 *
 * Every date-dependent decision in this toolkit is testable because the clock
 * is injected. The day-6 and day-7 selections cannot be exercised honestly by
 * waiting a week.
 */
export class FakeClock implements Clock {
  #at: Date
  constructor(instant: Date | IsoDateTime) {
    this.#at = typeof instant === 'string' ? new Date(instant) : new Date(instant.getTime())
  }
  now(): Date {
    return new Date(this.#at.getTime())
  }
  nowIso(): IsoDateTime {
    return this.#at.toISOString()
  }
  today(zone: string): IsoDate {
    return dateInZone(this.#at, zone)
  }
  dateOf(instant: Date | IsoDateTime, zone: string): IsoDate {
    return dateInZone(typeof instant === 'string' ? new Date(instant) : instant, zone)
  }
  set(instant: Date | IsoDateTime): void {
    this.#at = typeof instant === 'string' ? new Date(instant) : new Date(instant.getTime())
  }
  advanceMs(ms: number): void {
    this.#at = new Date(this.#at.getTime() + ms)
  }
  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000)
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  const existing = formatters.get(zone)
  if (existing) return existing
  let created: Intl.DateTimeFormat
  try {
    created = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    throw new Error('unknown time zone ' + zone + ': org.timezone must be an IANA name such as Europe/London')
  }
  formatters.set(zone, created)
  return created
}

/**
 * The calendar date an instant falls on in a zone.
 *
 * Assembled from `formatToParts` rather than by parsing a formatted string,
 * because the order and separators of a formatted date depend on the locale
 * and slicing the wrong five characters is a bug nobody notices until the
 * clocks change.
 */
export function dateInZone(instant: Date, zone: string): IsoDate {
  if (Number.isNaN(instant.getTime())) throw new Error('cannot take the date of an invalid instant')
  const parts = formatterFor(zone).formatToParts(instant)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return get('year') + '-' + get('month') + '-' + get('day')
}

export function assertIsoDate(date: string): IsoDate {
  if (!ISO_DATE.test(date)) throw new Error('not an ISO calendar date (YYYY-MM-DD): ' + date)
  return date
}

/**
 * Calendar arithmetic, done on the fields.
 *
 * `Date.UTC` is used purely as a calendar: no zone is involved, so no daylight
 * saving transition can move the answer. Adding a day by adding 86,400,000
 * milliseconds to a local timestamp is the other way to write this, and it is
 * wrong twice a year.
 */
export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = splitDate(date)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return (
    String(shifted.getUTCFullYear()).padStart(4, '0') +
    '-' +
    String(shifted.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(shifted.getUTCDate()).padStart(2, '0')
  )
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const [fy, fm, fd] = splitDate(from)
  const [ty, tm, td] = splitDate(to)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

export function isBefore(a: IsoDate, b: IsoDate): boolean {
  return assertIsoDate(a) < assertIsoDate(b)
}

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

const WEEKDAYS: readonly Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * The weekday of a calendar date.
 *
 * Taken from the date rather than from an instant, so a caller cannot ask
 * "is it Monday" of a UTC timestamp and get the answer for a different day.
 */
export function weekdayOf(date: IsoDate): Weekday {
  const [y, m, d] = splitDate(date)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as Weekday
}

function splitDate(date: IsoDate): [number, number, number] {
  assertIsoDate(date)
  const parts = date.split('-').map(Number) as [number, number, number]
  if (parts.some((n) => !Number.isFinite(n))) throw new Error('not an ISO calendar date: ' + date)
  return parts
}
