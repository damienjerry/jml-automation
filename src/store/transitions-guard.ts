/**
 * The write rules every people store shares.
 *
 * A store adapter's job is to persist rows. It is not allowed to decide what a
 * legal write looks like, because there will be several adapters (SQLite here,
 * a Notion database or a spreadsheet later) and a rule implemented three times
 * is a rule that holds in two places. Everything structural therefore lives in
 * this file and each adapter calls it:
 *
 *  - a status change is legal only if the transition table, the owner and the
 *    compare-and-set all agree;
 *  - the HR sync may write the fields the HR system owns and nothing else;
 *  - a blank incoming value never erases a populated stored one;
 *  - the Day-0 marker is written once and can never be cleared.
 *
 * Each of those exists because the automation this was ported from lost one of
 * them at some point and a real account was suspended, revived or deleted as a
 * result. See docs/incidents.md.
 */

import { decideTransition, type TransitionRefusal } from '../core/transitions.ts'
import type { ExternalIds, LifecycleStatus, OffboardingRecord, Person } from '../core/types.ts'
import type { TransitionRequest } from './types.ts'

/**
 * A write a store refused on structural grounds rather than on a transition
 * rule. It is a programming error, not an operational outcome, so it throws
 * instead of returning a refusal: nothing downstream can sensibly continue.
 */
export class StoreWriteRefused extends Error {
  readonly rule: string
  constructor(rule: string, message: string) {
    super(message)
    this.rule = rule
    this.name = 'StoreWriteRefused'
  }
}

/**
 * The fields the HR system owns, and therefore the only fields `upsert()` may
 * change on a row that already exists.
 *
 * An allowlist rather than a denylist: when a new field is added to `Person`
 * the safe default is that the sync cannot touch it. The alternative failed in
 * practice, where a sync that was assumed to be patching names also carried
 * the account ids and the hold flag along with it.
 */
export const HRIS_OWNED_FIELDS = [
  'primaryEmail',
  'aliasEmails',
  'displayName',
  'firstName',
  'lastName',
  'department',
  'jobTitle',
  'site',
  'managerEmail',
  'personalEmail',
  'startDate',
  'terminationDate',
  'lastWorkingDay',
  'inScope',
  'source',
] as const satisfies readonly (keyof Person)[]

/** Fields no caller may ever set through `patch()`. */
export const PATCH_FORBIDDEN_FIELDS = ['hrisId', 'status'] as const satisfies readonly (keyof Person)[]

export interface MergeDecision {
  changed: boolean
  /** Field names that differed, for the dry-run diff table. */
  changedFields: string[]
  merged: Person
}

export type GuardOutcome =
  | { allowed: true; to: LifecycleStatus; reason: string; merged: Person }
  | { allowed: false; refusal: TransitionRefusal; reason: string }

/** True for values that carry no information, so must not overwrite one that does. */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Lower-case and trim. Deliberately nothing more: alias-domain mapping and
 * exit-rename detection are identity concerns and live in the identity module,
 * so a store cannot quietly hold a second opinion about who somebody is.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Sorted, de-duplicated, normalised, and never containing the primary address. */
function normaliseAliases(aliases: readonly string[], primaryEmail: string): string[] {
  const primary = normaliseEmail(primaryEmail)
  const seen = new Set<string>()
  for (const alias of aliases) {
    if (isBlank(alias)) continue
    const normalised = normaliseEmail(alias)
    if (normalised === primary) continue
    seen.add(normalised)
  }
  return [...seen].sort()
}

function cloneOffboarding(record: OffboardingRecord | null | undefined): OffboardingRecord | null {
  if (!record) return null
  return structuredClone(record)
}

export function clonePerson(person: Person): Person {
  return structuredClone(person)
}

/**
 * Prepare a brand-new row.
 *
 * Creation is the one moment a caller chooses a status directly, because a row
 * has to start somewhere and there is no `from` state to consult. Which
 * statuses a given caller may create is that caller's rule, not the store's:
 * the HR sync refuses to create a leaver, and the bootstrap command creates
 * nothing but tombstones.
 */
export function normaliseNewPerson(incoming: Person, at: string): Person {
  if (isBlank(incoming.hrisId)) {
    throw new StoreWriteRefused('hrisId_required', 'A person needs the HR system id: it is the only join key.')
  }
  if (isBlank(incoming.primaryEmail)) {
    throw new StoreWriteRefused(
      'primary_email_required',
      `Person ${incoming.hrisId} has no primary email address, so nothing could be resolved for them later.`,
    )
  }
  const primaryEmail = normaliseEmail(incoming.primaryEmail)
  return {
    ...clonePerson(incoming),
    primaryEmail,
    aliasEmails: normaliseAliases(incoming.aliasEmails ?? [], primaryEmail),
    // A blank name is not a reason to lose a person. The address is a poor
    // label but it is a label, and a row dropped for a missing name is a
    // leaver nobody offboards.
    displayName: isBlank(incoming.displayName) ? primaryEmail : incoming.displayName,
    hold: incoming.hold === true,
    externalIds: { ...(incoming.externalIds ?? {}) },
    offboarding: cloneOffboarding(incoming.offboarding),
    updatedAt: at,
  }
}

/**
 * Merge an incoming HR record onto a stored row, HR-owned fields only.
 *
 * Diff before write: an unchanged sync must perform no writes at all. When it
 * writes unconditionally, every run looks like a change, so the change-only
 * alerting downstream fires every run and gets muted, and the audit log stops
 * being a record of anything.
 */
export function mergeHrisFields(stored: Person, incoming: Person, at: string): MergeDecision {
  const merged = clonePerson(stored)
  const changedFields: string[] = []

  const incomingPrimary = isBlank(incoming.primaryEmail) ? null : normaliseEmail(incoming.primaryEmail)
  // An address change keeps the old address as an alias. A renamed person is
  // the same person: dropping the previous address is what allows a later
  // lookup to miss them, or worse, to match somebody else.
  const aliasSource = [...(stored.aliasEmails ?? []), ...(incoming.aliasEmails ?? [])]
  if (incomingPrimary && incomingPrimary !== stored.primaryEmail) {
    aliasSource.push(stored.primaryEmail)
    merged.primaryEmail = incomingPrimary
    changedFields.push('primaryEmail')
  }
  const aliases = normaliseAliases(aliasSource, merged.primaryEmail)
  if (aliases.join('') !== normaliseAliases(stored.aliasEmails ?? [], stored.primaryEmail).join('')) {
    changedFields.push('aliasEmails')
  }
  merged.aliasEmails = aliases

  for (const field of HRIS_OWNED_FIELDS) {
    if (field === 'primaryEmail' || field === 'aliasEmails') continue
    const next = incoming[field]
    const current = stored[field]
    if (isBlank(next)) continue
    if (next === current) continue
    // Assigning through a narrowed index needs the cast; the allowlist above
    // is what makes it safe, not the type.
    ;(merged as unknown as Record<string, unknown>)[field] = next
    changedFields.push(field)
  }

  const changed = changedFields.length > 0
  if (changed) merged.updatedAt = at
  return { changed, changedFields: changedFields.sort(), merged }
}

/**
 * Apply an explicit patch.
 *
 * Unlike the sync merge this is literal: `undefined` leaves a field alone and
 * `null` sets it to null, because a caller clearing an account id is defusing
 * a mistaken identity on purpose. Two things it still refuses.
 */
export function applyPatch(stored: Person, patch: Partial<Person>, at: string): MergeDecision {
  for (const field of PATCH_FORBIDDEN_FIELDS) {
    if (field in patch) {
      throw new StoreWriteRefused(
        'patch_forbidden_field',
        `patch() may not write ${field}. A status change goes through transition() so the table, the owner and the compare-and-set are all checked.`,
      )
    }
  }

  const merged = clonePerson(stored)
  const changedFields: string[] = []

  for (const [rawField, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const field = rawField as keyof Person

    if (field === 'primaryEmail') {
      const next = normaliseEmail(String(value))
      if (next === merged.primaryEmail) continue
      merged.aliasEmails = normaliseAliases([...merged.aliasEmails, merged.primaryEmail], next)
      merged.primaryEmail = next
      changedFields.push('primaryEmail', 'aliasEmails')
      continue
    }

    if (field === 'aliasEmails') {
      // Aliases only ever grow. They are the record of who somebody used to
      // be, and shrinking that set is how a lookup loses a renamed person.
      const next = normaliseAliases([...merged.aliasEmails, ...(value as string[])], merged.primaryEmail)
      if (next.join('') === merged.aliasEmails.join('')) continue
      merged.aliasEmails = next
      changedFields.push('aliasEmails')
      continue
    }

    if (field === 'externalIds') {
      const next: ExternalIds = { ...merged.externalIds }
      for (const [provider, id] of Object.entries(value as ExternalIds)) {
        if (id === undefined) continue
        next[provider] = id
      }
      if (JSON.stringify(next) === JSON.stringify(merged.externalIds)) continue
      merged.externalIds = next
      changedFields.push('externalIds')
      continue
    }

    if (field === 'offboarding') {
      const next = mergeOffboarding(merged.offboarding, value as OffboardingRecord | null, stored.hrisId)
      if (JSON.stringify(next) === JSON.stringify(merged.offboarding)) continue
      merged.offboarding = next
      changedFields.push('offboarding')
      continue
    }

    if (JSON.stringify(value) === JSON.stringify(merged[field])) continue
    ;(merged as unknown as Record<string, unknown>)[field] = value
    changedFields.push(field)
  }

  const changed = changedFields.length > 0
  if (changed) merged.updatedAt = at
  return { changed, changedFields: [...new Set(changedFields)].sort(), merged }
}

/**
 * Merge one offboarding record onto another, leg by leg.
 *
 * Per-leg merging matters: a step that writes only its own leg result must not
 * carry a stale copy of its siblings. When it does, the record of what already
 * succeeded is silently replaced by whatever that step happened to be holding,
 * and the next run repeats work it has already done.
 */
function mergeOffboarding(
  stored: OffboardingRecord | null | undefined,
  incoming: OffboardingRecord | null,
  hrisId: string,
): OffboardingRecord | null {
  if (incoming === null) {
    if (stored?.suspendedAt) {
      throw new StoreWriteRefused(
        'suspended_at_immutable',
        `Refusing to drop the offboarding record for ${hrisId}: it holds the Day-0 marker, which is the only thing stopping the suspension running a second time.`,
      )
    }
    return null
  }
  const base = cloneOffboarding(stored)
  const next: OffboardingRecord = {
    ...(base ?? { suspendedAt: null, legs: {} }),
    ...structuredClone(incoming),
    legs: { ...(base?.legs ?? {}), ...(incoming.legs ?? {}) },
  }
  if (base?.suspendedAt && !next.suspendedAt) {
    throw new StoreWriteRefused(
      'suspended_at_immutable',
      `Refusing to clear the Day-0 marker on ${hrisId}. It is written once and never cleared: clearing it makes an already-suspended person selectable again.`,
    )
  }
  return next
}

/**
 * Decide a status change for a store.
 *
 * The adapter reads the row inside its own transaction, calls this, and writes
 * only when the outcome is allowed. Everything that can refuse a write refuses
 * here, so no adapter can be lenient by omission.
 */
export function guardTransition(current: Person | null, req: TransitionRequest, at: string): GuardOutcome {
  if (!current) {
    return {
      allowed: false,
      refusal: 'stale_status',
      reason: `No row for ${req.hrisId}; the caller expected ${req.expectFrom}. A transition never creates a person.`,
    }
  }

  const decision = decideTransition(current.status, req.expectFrom, req.event, req.owner)
  if (!decision.allowed || !decision.to) {
    return {
      allowed: false,
      refusal: decision.refusal ?? 'illegal_transition',
      reason: decision.reason ?? 'Refused by the transition table.',
    }
  }

  const patched = applyPatch(current, req.patch ?? {}, at)
  const merged = patched.merged
  merged.status = decision.to
  merged.updatedAt = at
  if (req.reason) merged.note = req.reason

  return { allowed: true, to: decision.to, reason: decision.reason ?? '', merged }
}
