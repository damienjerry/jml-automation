/**
 * The units of offboarding work, and the rules they all obey.
 *
 * A leg is one provider action for one person. Five properties are enforced
 * here rather than being left to each leg to remember:
 *
 *  - Idempotent. Every leg is safe to run again, because a failed leg is
 *    retried on every later run until it succeeds or the row parks.
 *  - Verified or failed. `legFrom` refuses to write `done` on an outcome the
 *    provider was not read back for, so an accepted request that changed
 *    nothing is a failure and gets retried.
 *  - Audited in two rows. The intent is appended before the call and the
 *    outcome after, and if the intent cannot be written the call does not
 *    happen. One row written afterwards cannot describe the case that matters
 *    most: a call that was made and whose result was never learned.
 *  - Armed explicitly. A leg whose action is not in `armedActions` records
 *    `not_armed` rather than vanishing, so an adopter can arm suspension,
 *    watch a cycle, then arm the hand-over, then arm deletion, and see at each
 *    stage exactly what was declined.
 *  - Independently caught by the caller. A failing suspension must not stop
 *    the licence revoke: closing three doors of four beats closing none.
 */

import type { ArmedAction, JmlConfig } from '../../config/schema.ts'
import type { AuditSink } from '../../audit/types.ts'
import type { Clock } from '../../core/clock.ts'
import type { DomainMap } from '../../core/domain.ts'
import type { Logger } from '../../core/logger.ts'
import { legFrom, notApplicableLeg, notArmedLeg } from '../../core/result.ts'
import type { Actor, LegName, LegRecord, Outcome, Person, ReviewReason } from '../../core/types.ts'
import type {
  DeviceConnector,
  GoogleWorkspaceConnector,
  IdentityConnector,
  ProviderUser,
} from '../../connectors/types.ts'
import type { Notifier } from '../../notify/types.ts'
import type { PeopleStore, StateStore } from '../../store/types.ts'
import { renderTemplate } from '../../notify/fanout.ts'
import type { IdpResolution } from './gate.ts'

/** Everything the leaver engine needs. Injected, so nothing reaches for a global. */
export interface LeaverDeps {
  cfg: JmlConfig
  store: PeopleStore
  state: StateStore
  idp: IdentityConnector
  devices: DeviceConnector
  google: GoogleWorkspaceConnector
  notifier: Notifier
  audit: AuditSink
  clock: Clock
  logger: Logger
  domain: DomainMap
  /** Replaces the hand-over poll delay in tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface LegContext {
  person: Person
  /** Resolved once per person, so no leg looks an account up a second time. */
  idp: IdpResolution
  /** The same three-way answer for Google: found, absent, or unreadable. */
  googleAccount: IdpResolution
  runId: string
  actor: Actor
  dryRun: boolean
  today: string
}

export interface LegResult {
  name: LegName
  record: LegRecord
  /** One line for the report and for the notification. */
  note: string
  /** Fields the engine writes onto the row outside the leg record. */
  evidence?: { transferId?: string; transferRecipient?: string; transferredAt?: string }
  /** Set when this outcome means a person has to look at the row. */
  park?: ReviewReason
}

export interface Leg {
  name: LegName
  phase: 'day0' | 'day6' | 'day7'
  /** The `armedActions` entry that arms it. */
  action: ArmedAction
  run(deps: LeaverDeps, ctx: LegContext): Promise<LegResult>
}

/** True when config arms this action for real. */
export function isArmed(cfg: JmlConfig, action: ArmedAction): boolean {
  return cfg.mode === 'armed' && cfg.armedActions.includes(action)
}

function previous(ctx: LegContext, name: LegName): LegRecord | undefined {
  return ctx.person.offboarding?.legs?.[name]
}

function attempts(ctx: LegContext, name: LegName): number {
  return previous(ctx, name)?.attempts ?? 0
}

function result(name: LegName, record: LegRecord, note: string, extra: Partial<LegResult> = {}): LegResult {
  return { name, record, note, ...extra }
}

function failedLeg(ctx: LegContext, name: LegName, at: string, error: string, retryable = true): LegRecord {
  return legFrom({ ok: false, verified: false, error, retryable }, { at, previous: previous(ctx, name) })
}

/**
 * A planned leg in a dry run.
 *
 * `pending`, not `done`: a dry run must never leave a record that reads like
 * completed work, and there is no separate "would have done" state to hide
 * behind. Attempts are not incremented either, because planning is not
 * attempting.
 */
function plannedLeg(ctx: LegContext, name: LegName, at: string): LegRecord {
  return { state: 'pending', verified: false, attempts: attempts(ctx, name), at }
}

function absentLeg(ctx: LegContext, name: LegName, at: string): LegRecord {
  return { state: 'already_absent', verified: true, attempts: attempts(ctx, name), at }
}

function verdict(record: LegRecord, done: string, failed: string): string {
  return record.state === 'done' || record.state === 'already_absent'
    ? done
    : `${failed}: ${record.error ?? 'no reason given'}`
}

/** The part of a leg context an audit row needs, so notifications can use it too. */
export type AuditCtx = Pick<LegContext, 'person' | 'runId' | 'actor' | 'dryRun'>

/**
 * Run one provider call with an intent row before it and an outcome row after.
 *
 * The intent append is deliberately not caught. An audit sink that cannot be
 * written is an abort condition for the whole run rather than one failed leg:
 * without the log there is no record of what a destructive step did, so the
 * caller treats the thrown error as a reason to stop.
 */
export async function auditedCall(
  deps: LeaverDeps,
  ctx: AuditCtx,
  step: { action: string; target: 'jumpcloud' | 'google' | 'notify' | 'store'; detail?: Record<string, unknown> },
  call: () => Promise<Outcome>,
): Promise<Outcome> {
  const base = {
    runId: ctx.runId,
    actor: ctx.actor,
    action: step.action,
    subject: { kind: 'person' as const, id: ctx.person.hrisId, label: ctx.person.displayName },
    dryRun: ctx.dryRun,
  }
  const intent = await deps.audit.append({
    ...base,
    at: deps.clock.nowIso(),
    phase: 'intent',
    detail: { target: step.target, ...(step.detail ?? {}) },
  })

  let outcome: Outcome
  try {
    outcome = await call()
  } catch (err) {
    outcome = { ok: false, verified: false, error: err instanceof Error ? err.message : String(err), retryable: true }
  }

  await deps.audit.append({
    ...base,
    at: deps.clock.nowIso(),
    phase: 'outcome',
    ok: outcome.ok,
    verified: outcome.verified,
    intentSeq: intent.seq,
    detail: { target: step.target, ...(outcome.detail ?? {}), ...(outcome.error ? { error: outcome.error } : {}) },
  })
  return outcome
}

type Preamble = { go: true; user: ProviderUser } | { go: false; halt: LegResult }

interface PrepareOptions {
  at: string
  /** What an account that genuinely does not exist means for this leg. */
  absent: 'fail' | 'not_applicable' | 'already_absent'
  absentNote: string
  planned: (user: ProviderUser) => string
  declined: string
  /** A leg's own check, after the account resolves and before any write. */
  guard?: (user: ProviderUser) => Promise<LegResult | null>
}

/**
 * The checks every provider leg makes before it touches anything.
 *
 * One implementation rather than seven, because the order matters and getting
 * it wrong in one leg is invisible: an unreadable account must never be
 * treated as an absent one, a dry run must never reach a write, and a leg that
 * is not armed must still leave a record saying so.
 */
async function prepare(
  deps: LeaverDeps,
  ctx: LegContext,
  leg: { name: LegName; action: ArmedAction },
  resolution: IdpResolution,
  opts: PrepareOptions,
): Promise<Preamble> {
  const { at, absentNote } = opts
  if (resolution.kind === 'unreadable') {
    const record = failedLeg(ctx, leg.name, at, `the account could not be read: ${resolution.detail}`)
    return { go: false, halt: result(leg.name, record, `the account could not be read, so ${leg.name} did nothing`) }
  }
  if (resolution.kind === 'absent') {
    // A failure, never "skipped", where the leg needs the account to exist. A
    // leaver we cannot find while they still hold another account is a broken
    // join, and calling that skipped is how a silent no-op read as done work.
    const record =
      opts.absent === 'fail'
        ? failedLeg(ctx, leg.name, at, absentNote)
        : opts.absent === 'already_absent'
          ? absentLeg(ctx, leg.name, at)
          : notApplicableLeg(at, absentNote)
    return { go: false, halt: result(leg.name, record, absentNote) }
  }
  const guarded = opts.guard ? await opts.guard(resolution.user) : null
  if (guarded) return { go: false, halt: guarded }
  if (ctx.dryRun) {
    return { go: false, halt: result(leg.name, plannedLeg(ctx, leg.name, at), opts.planned(resolution.user)) }
  }
  if (!isArmed(deps.cfg, leg.action)) {
    return { go: false, halt: result(leg.name, notArmedLeg(at, previous(ctx, leg.name)), opts.declined) }
  }
  return { go: true, user: resolution.user }
}

// ---------------------------------------------------------------------------
// Day 0: close access
// ---------------------------------------------------------------------------

const suspendIdp: Leg = {
  name: 'suspend_idp',
  phase: 'day0',
  action: 'suspend',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const pre = await prepare(deps, ctx, suspendIdp, ctx.idp, {
      at,
      absent: 'fail',
      absentNote: 'no identity provider account matched this person by id, address or alias',
      planned: (user) => `would suspend the identity provider account ${user.id}`,
      declined: 'suspension is not in armedActions, so the account was left alone',
    })
    if (!pre.go) return pre.halt

    const user = pre.user
    const outcome = await auditedCall(
      deps,
      ctx,
      { action: 'leaver.day0.suspend_idp', target: 'jumpcloud', detail: { userId: user.id } },
      () => deps.idp.suspendUser(user.id),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'suspend_idp') })
    return result('suspend_idp', record, verdict(record, 'identity provider account suspended, read back', 'the suspension failed'))
  },
}

const setAutoreply: Leg = {
  name: 'set_autoreply',
  phase: 'day0',
  action: 'autoreply',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const pre = await prepare(deps, ctx, setAutoreply, ctx.googleAccount, {
      at,
      absent: 'not_applicable',
      absentNote: 'no Google mailbox, so no auto-reply was set',
      planned: (user) => `would set an auto-reply on ${user.email}`,
      declined: 'the auto-reply is not in armedActions, so the mailbox was left alone',
    })
    if (!pre.go) return pre.halt

    const mailbox = pre.user.email
    const values = autoReplyValues(deps.cfg, ctx.person)
    const subject = renderTemplate(deps.cfg.leaver.autoReply.subject, values)
    const body = renderTemplate(deps.cfg.leaver.autoReply.bodyHtml, values)
    const outcome = await auditedCall(
      deps,
      ctx,
      // The rendered body is not audited. It names a leaver and a manager, it
      // is reproducible from the configured template, and an audit log kept
      // for years does not need to be a staff directory.
      { action: 'leaver.day0.set_autoreply', target: 'google', detail: { subjectLength: subject.length } },
      () => deps.google.setVacationResponder(mailbox, subject, body),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'set_autoreply') })
    return result('set_autoreply', record, verdict(record, 'auto-reply set on the mailbox', 'the auto-reply failed'))
  },
}

const revokeLicences: Leg = {
  name: 'revoke_licence',
  phase: 'day0',
  action: 'licence',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    let targets: { productId: string; skuId: string }[] = []
    const pre = await prepare(deps, ctx, revokeLicences, ctx.googleAccount, {
      at,
      absent: 'not_applicable',
      absentNote: 'no Google account, so no licence was revoked',
      planned: () => `would revoke ${targets.length} licence(s): ${skus(targets)}`,
      declined: 'licence revocation is not in armedActions, so the seats were left assigned',
      guard: async (user) => {
        let held: { productId: string; skuId: string }[]
        try {
          held = await deps.google.listLicences(user.email)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          return result('revoke_licence', failedLeg(ctx, 'revoke_licence', at, why), `the licence list could not be read: ${why}`)
        }
        // List then revoke, rather than assuming which product a leaver holds.
        // The automation this replaces had one product id written into it, so
        // every other seat stayed assigned and paid for.
        const wanted = deps.cfg.leaver.revokeLicences
        targets = wanted === 'all' ? held : held.filter((l) => wanted.includes(l.skuId))
        if (targets.length > 0) return null
        return result('revoke_licence', absentLeg(ctx, 'revoke_licence', at), 'no licence was assigned to revoke')
      },
    })
    if (!pre.go) return pre.halt

    const email = pre.user.email
    const outcomes: Outcome[] = []
    for (const target of targets) {
      outcomes.push(
        await auditedCall(
          deps,
          ctx,
          { action: 'leaver.day0.revoke_licence', target: 'google', detail: { skuId: target.skuId } },
          () => deps.google.revokeLicence(email, target.productId, target.skuId),
        ),
      )
    }
    const failures = outcomes.filter((o) => !o.ok || !o.verified)
    if (failures.length === 0) {
      const allWereGone = outcomes.every((o) => o.alreadyAbsent)
      const done = legFrom(
        { ok: true, verified: true, ...(allWereGone ? { alreadyAbsent: true } : {}) },
        { at, previous: previous(ctx, 'revoke_licence') },
      )
      return result('revoke_licence', done, `revoked ${targets.length} licence(s): ${skus(targets)}`)
    }
    const record = failedLeg(
      ctx,
      'revoke_licence',
      at,
      `${failures.length} of ${outcomes.length} licence revocations failed`,
      failures.some((f) => f.retryable === true),
    )
    return result('revoke_licence', record, `licence revocation failed for ${failures.length} of ${targets.length} seat(s)`)
  },
}

/**
 * Day 0 with no identity provider: the Google account is the door.
 *
 * It is not suspended here. The day-6 hand-over is proven on an active,
 * unlicensed account, and suspension stays after it, as on the reference
 * setup. What closes the door instead is a random password nobody holds, a
 * change required at next sign-in, which reads back, and every session ended.
 * Armed by `suspend`, because it is what suspension means in this setup.
 */
const closeGoogle: Leg = {
  name: 'close_google',
  phase: 'day0',
  action: 'suspend',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const pre = await prepare(deps, ctx, closeGoogle, ctx.googleAccount, {
      at,
      absent: 'fail',
      absentNote: 'no Google account matched this person by address or alias',
      planned: (user) => `would replace the password on ${user.email} with one nobody holds, require a change at next sign-in, and end every session`,
      declined: 'closing the account is armed by suspend, which is not in armedActions, so the account was left alone',
    })
    if (!pre.go) return pre.halt

    const email = pre.user.email
    const outcome = await auditedCall(
      deps,
      ctx,
      // The password is never audited, logged or returned: it exists only
      // inside the connector call.
      { action: 'leaver.day0.close_google', target: 'google', detail: {} },
      () => deps.google.closeUser(email),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'close_google') })
    return result(
      'close_google',
      record,
      verdict(record, 'Google password sign-in closed: password replaced with one nobody holds, change at next sign-in read back, every session ended (passkey sign-in and recovery are not closed until the account is suspended)', 'closing the Google account failed'),
    )
  },
}

const signOutGoogle: Leg = {
  name: 'signout_google',
  phase: 'day0',
  action: 'google_signout',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const pre = await prepare(deps, ctx, signOutGoogle, ctx.googleAccount, {
      at,
      absent: 'not_applicable',
      absentNote: 'no Google account, so there was nothing to sign out',
      planned: (user) => `would sign ${user.email} out of every Google session and revoke its third-party app grants`,
      declined: 'the Google sign-out is not in armedActions, so existing sessions and app grants were left in place',
    })
    if (!pre.go) return pre.halt

    // The licence is gone by now, so Gmail and Drive already are. What this
    // closes is the account as an identity: Sign in with Google into other
    // apps, and grants already given to them, which last until day 6 otherwise.
    const email = pre.user.email
    const outcome = await auditedCall(
      deps,
      ctx,
      { action: 'leaver.day0.signout_google', target: 'google', detail: {} },
      () => deps.google.signOutUser(email),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'signout_google') })
    const revoked = typeof outcome.detail?.['grantsRevoked'] === 'number' ? outcome.detail['grantsRevoked'] : 0
    return result(
      'signout_google',
      record,
      verdict(
        record,
        `sign-out of every Google session requested (Google cannot confirm it), and ${revoked} third-party app grant(s) revoked, read back as none left`,
        'the Google sign-out failed',
      ),
    )
  },
}

function skus(licences: readonly { skuId: string }[]): string {
  return licences.map((l) => l.skuId).join(', ')
}

// ---------------------------------------------------------------------------
// Day 6: hand the files over, then close the Google account
// ---------------------------------------------------------------------------

/** How long one run will sit waiting for a hand-over before leaving it. */
const MAX_IN_RUN_POLL_MS = 120_000
const POLL_INTERVAL_MS = 15_000

const transferDrive: Leg = {
  name: 'transfer_drive',
  phase: 'day6',
  action: 'transfer',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const existingId = ctx.person.offboarding?.transferId
    const resolved = ctx.person.managerEmail?.trim() || deps.cfg.google.driveTransfer.fallbackRecipient
    let recipient = ''
    const pre = await prepare(deps, ctx, transferDrive, ctx.googleAccount, {
      at,
      absent: 'not_applicable',
      absentNote: 'no Google account, so there is nothing to hand over',
      planned: () => `would hand the files to ${recipient}`,
      declined: 'the hand-over is not in armedActions, so no transfer was started',
      guard: async () => {
        // Re-polled, never re-inserted. A second insert makes a second
        // transfer, and the id is persisted the moment the first one starts
        // precisely so an interrupted run resumes instead of starting again.
        if (existingId) return pollExistingTransfer(deps, ctx, existingId, at)
        if (!resolved) {
          const why = 'no hand-over recipient resolved from the manager address or the configured fallback'
          return result('transfer_drive', failedLeg(ctx, 'transfer_drive', at, why, false), why, {
            park: 'no_transfer_recipient',
          })
        }
        recipient = resolved
        return null
      },
    })
    if (!pre.go) return pre.halt

    const from = pre.user.email
    const started = await auditedCall(
      deps,
      ctx,
      { action: 'leaver.day6.transfer_drive', target: 'google', detail: { recipient } },
      () => deps.google.transferDrive(from, recipient),
    )
    const transferId = (started as Outcome & { transferId?: string }).transferId
    if (!started.ok || !transferId) {
      const record = legFrom(started, { at, previous: previous(ctx, 'transfer_drive') })
      return result('transfer_drive', record, `the hand-over could not be started: ${started.error ?? 'no reason given'}`)
    }

    // Persisted before anything else happens, including before the first poll.
    // A run that dies here has to resume the transfer it started rather than
    // start a second one for the same person.
    await deps.store.patch(ctx.person.hrisId, {
      offboarding: {
        ...(ctx.person.offboarding ?? { suspendedAt: null, legs: {} }),
        transferId,
        transferRecipient: recipient,
      },
    })

    const polled = await waitForTransfer(deps, transferId)
    if (polled.state === 'completed') {
      const record = legFrom({ ok: true, verified: true, detail: { transferId } }, { at, previous: previous(ctx, 'transfer_drive') })
      return result('transfer_drive', record, `files handed to ${recipient}, confirmed complete by the provider`, {
        evidence: { transferId, transferRecipient: recipient, transferredAt: deps.clock.nowIso() },
      })
    }
    return result(
      'transfer_drive',
      { state: 'pending', verified: false, attempts: attempts(ctx, 'transfer_drive'), at, error: `the hand-over is ${polled.state}` },
      `hand-over ${transferId} to ${recipient} is ${polled.state}; it is polled again on the next run`,
      { evidence: { transferId, transferRecipient: recipient } },
    )
  },
}

async function pollExistingTransfer(
  deps: LeaverDeps,
  ctx: LegContext,
  transferId: string,
  at: string,
): Promise<LegResult> {
  const polled = await waitForTransfer(deps, transferId)
  const soFar = Math.max(1, attempts(ctx, 'transfer_drive'))
  if (polled.state === 'completed') {
    return result('transfer_drive', { state: 'done', verified: true, attempts: soFar, at }, `hand-over ${transferId} completed`, {
      evidence: { transferId, transferredAt: deps.clock.nowIso() },
    })
  }
  if (polled.state === 'failed') {
    const record = failedLeg(ctx, 'transfer_drive', at, `the provider reported hand-over ${transferId} failed`)
    return result('transfer_drive', record, `hand-over ${transferId} failed, so deletion stays blocked`, {
      evidence: { transferId },
    })
  }
  // Still running. Not an attempt and not a failure: the attempt counter is
  // what parks a row, and a hand-over that is simply taking hours must not
  // park anybody.
  return result(
    'transfer_drive',
    { state: 'pending', verified: false, attempts: soFar, at, error: `the hand-over is ${polled.state}` },
    `hand-over ${transferId} is ${polled.state}; it is polled again on the next run`,
    { evidence: { transferId } },
  )
}

/**
 * Poll a hand-over for a bounded part of this run.
 *
 * Bounded on purpose. A hand-over can take hours, the run holds a lease that
 * expires, and a run that outlives its own lease lets a second run start
 * alongside it. So the wait is capped and an unfinished transfer is left to
 * the next run, which is what the persisted transfer id is for.
 */
async function waitForTransfer(deps: LeaverDeps, transferId: string): Promise<{ state: string; done: boolean }> {
  const budgetMs = Math.min(deps.cfg.google.driveTransfer.pollTimeoutMinutes * 60_000, MAX_IN_RUN_POLL_MS)
  const rounds = Math.max(1, Math.floor(budgetMs / POLL_INTERVAL_MS))
  const wait = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let last = { state: 'unknown', done: false }
  for (let round = 0; round < rounds; round += 1) {
    last = await deps.google.getTransferStatus(transferId)
    if (last.done) return last
    if (round + 1 < rounds) await wait(POLL_INTERVAL_MS)
  }
  return last
}

const suspendGoogle: Leg = {
  name: 'suspend_google',
  phase: 'day6',
  action: 'google_suspend',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const pre = await prepare(deps, ctx, suspendGoogle, ctx.googleAccount, {
      at,
      absent: 'not_applicable',
      absentNote: 'no Google account, so nothing was suspended',
      planned: (user) => `would suspend the Google account ${user.email}`,
      declined: 'the Google suspension is not in armedActions, so the account was left alone',
    })
    if (!pre.go) return pre.halt

    // Runs whether or not a recipient was found for the files. Access closes
    // on the day it is due; a hand-over that needs a person to decide is a
    // separate problem and must not hold the door open.
    const email = pre.user.email
    const outcome = await auditedCall(deps, ctx, { action: 'leaver.day6.suspend_google', target: 'google' }, () =>
      deps.google.suspendUser(email),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'suspend_google') })
    return result('suspend_google', record, verdict(record, 'Google account suspended, read back', 'the Google suspension failed'))
  },
}

// ---------------------------------------------------------------------------
// Day 7: delete
// ---------------------------------------------------------------------------

const deleteIdp: Leg = {
  name: 'delete_idp',
  phase: 'day7',
  action: 'delete',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    const pre = await prepare(deps, ctx, deleteIdp, ctx.idp, {
      at,
      absent: 'already_absent',
      absentNote: 'the identity provider account was already gone',
      planned: (user) => `would delete the identity provider account ${user.id}`,
      declined: 'deletion is not in armedActions, so the account was left suspended',
      guard: async (user) => {
        if (user.suspended) return null
        // The account is usable again. Either somebody restored access or the
        // wrong account is on this row, and neither is something to delete.
        const why = 'the account is not suspended, so the deletion preflight refused it'
        return result('delete_idp', failedLeg(ctx, 'delete_idp', at, why, false), why, {
          park: 'reinstated_after_day0',
        })
      },
    })
    if (!pre.go) return pre.halt
    const user = pre.user

    // What we knew about the account goes into the audit before it is
    // destroyed. It cannot be read afterwards, and deleting it also destroys
    // the escrowed disk-encryption key.
    await deps.audit.append({
      at: deps.clock.nowIso(),
      runId: ctx.runId,
      phase: 'intent',
      actor: ctx.actor,
      action: 'leaver.day7.delete_idp.snapshot',
      subject: { kind: 'person', id: ctx.person.hrisId, label: ctx.person.displayName },
      dryRun: ctx.dryRun,
      detail: {
        userId: user.id,
        suspended: user.suspended,
        providerState: user.rawState,
        externalIds: ctx.person.externalIds,
        boundDevices: 0,
      },
    })

    const outcome = await auditedCall(
      deps,
      ctx,
      { action: 'leaver.day7.delete_idp', target: 'jumpcloud', detail: { userId: user.id } },
      () => deps.idp.deleteUser(user.id),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'delete_idp') })
    return result('delete_idp', record, verdict(record, 'identity provider account deleted, confirmed gone', 'the deletion failed'))
  },
}

const deleteGoogle: Leg = {
  name: 'delete_google',
  phase: 'day7',
  action: 'delete',
  async run(deps, ctx) {
    const at = deps.clock.nowIso()
    if (!deps.cfg.leaver.deleteGoogleUser) {
      const note = 'the Google account was left suspended rather than deleted, by configuration'
      return result('delete_google', notApplicableLeg(at, 'leaver.deleteGoogleUser is false'), note)
    }
    const pre = await prepare(deps, ctx, deleteGoogle, ctx.googleAccount, {
      at,
      // Already absent, not a deletion we performed. The automation this
      // replaces deleted unconditionally and read the provider's 404 as
      // success, so its log could not answer "did this run delete an account".
      absent: 'already_absent',
      absentNote: 'the Google account was already gone',
      planned: (user) => `would delete the Google account ${user.email}`,
      declined: 'deletion is not in armedActions, so the Google account was left suspended',
      // The same preflight the identity deletion carries, and for the same
      // reason. A mailbox that still answers is either one somebody restored,
      // or the wrong mailbox on this row, and neither is something to delete.
      // This half had no such check: an adopter can arm `delete` without
      // arming `google_suspend`, which left a working mailbox to be deleted on
      // day 7 with nothing having ever closed it. A mailbox is also the least
      // recoverable thing in this whole sequence.
      guard: async (user) => {
        if (user.suspended) return null
        const why = 'the Google account is not suspended, so the deletion preflight refused it'
        return result('delete_google', failedLeg(ctx, 'delete_google', at, why, false), why, {
          park: 'reinstated_after_day0',
        })
      },
    })
    if (!pre.go) return pre.halt

    const email = pre.user.email
    const outcome = await auditedCall(deps, ctx, { action: 'leaver.day7.delete_google', target: 'google' }, () =>
      deps.google.deleteUser(email),
    )
    const record = legFrom(outcome, { at, previous: previous(ctx, 'delete_google') })
    return result('delete_google', record, verdict(record, 'Google account deleted, confirmed gone', 'the Google deletion failed'))
  },
}

export const DAY0_LEGS: readonly Leg[] = [suspendIdp, setAutoreply, revokeLicences, signOutGoogle]
export const DAY6_LEGS: readonly Leg[] = [transferDrive, suspendGoogle]
export const DAY7_LEGS: readonly Leg[] = [deleteIdp, deleteGoogle]

/**
 * The steps for this setup. With no identity provider the Google account is
 * closed on day 0 instead of an identity provider account being suspended, and
 * only the Google account is deleted on day 7.
 */
export function day0Legs(cfg: { identity: { adapter: string } }): readonly Leg[] {
  return cfg.identity.adapter === 'none' ? [closeGoogle, setAutoreply, revokeLicences, signOutGoogle] : DAY0_LEGS
}
export function day7Legs(cfg: { identity: { adapter: string } }): readonly Leg[] {
  return cfg.identity.adapter === 'none' ? [deleteGoogle] : DAY7_LEGS
}
/** The step whose verified result is what lets day 0 write its marker. */
export function doorLegName(cfg: { identity: { adapter: string } }): LegName {
  return cfg.identity.adapter === 'none' ? 'close_google' : 'suspend_idp'
}

/**
 * Values for the auto-reply template.
 *
 * The manager is named by address because the person row carries no manager
 * display name today. An address is a poor label and a truthful one; deriving
 * a name from it would put a guess in front of whoever writes to the leaver.
 */
export function autoReplyValues(cfg: JmlConfig, person: Person): Record<string, string> {
  const managerEmail = person.managerEmail?.trim() || cfg.mail.senderMailbox
  return {
    displayName: person.displayName || person.primaryEmail,
    orgName: cfg.org.name,
    managerName: managerEmail,
    managerEmail,
  }
}
