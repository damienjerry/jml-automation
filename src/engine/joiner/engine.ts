/**
 * Bringing a starter's accounts to life.
 *
 * The HR system's own integrations create the identity account (staged) and
 * the Google account (unlicensed). This engine does what comes after: a
 * temporary password with a forced reset, a licence, a mailbox that has
 * actually been built, the right organisational unit, and the emails that
 * tell the starter and their manager. Each of those is a leg with its own
 * arming switch and its own read-back, like the leaver legs.
 *
 * Rules, each from a recorded failure in an earlier design:
 *
 *  - NEVER reset the password of an account somebody is using. A staged
 *    account has never been activated and has no MFA; anything else is a
 *    working colleague. A mis-entered HR field once queued one for activation.
 *  - The forced reset runs AFTER the password is set and is verified from a
 *    fresh read. Setting a password clears the flag, and the flag is not
 *    writable on the account, so the wrong order produces a password nobody
 *    has to change while the email says they must.
 *  - The work-address welcome waits for the mailbox. An account created by a
 *    directory integration has no mailbox until it is licensed and built;
 *    mail sent before that bounces. Withhold rather than bounce.
 *  - The temporary password goes to the personal address and the manager,
 *    and both are validated at send time: the personal address must not be a
 *    company one, the manager's must. A company address in the personal slot
 *    once sent a starter's credential to a colleague's inbox. An unusable
 *    address is dropped with a warning; the IT copy is always sent, so the
 *    password is re-routed to a person rather than lost.
 *  - `activatedAt` is written only once the password and the reset are both
 *    read back. It is the idempotency key: a row with it is never activated
 *    again, whatever the later legs did.
 */

import type { IsoDate } from '../../core/clock.ts'
import type { ActivationLegName, ActivationRecord, LegRecord, Person, PersonRunResult, RunReport } from '../../core/types.ts'
import type { IdentityActivationConnector, GoogleProvisioningConnector, ProviderUser } from '../../connectors/types.ts'
import { auditedCall, isArmed, type AuditCtx, type LeaverDeps } from '../leaver/legs.ts'
import { createActivationGate, type ActivationGate } from './gate.ts'
import { notifyJoinerManager, notifyJoinerPassword, notifyJoinerRefused, notifyJoinerWelcome, notifyJoinerWithheld } from './notify.ts'
import { temporaryPassword } from './password.ts'
import { joinerSkipReason, selectJoiners, type JoinerSkipReason } from './select.ts'

export interface JoinerDeps extends LeaverDeps {
  idp: LeaverDeps['idp'] & IdentityActivationConnector
  google: LeaverDeps['google'] & GoogleProvisioningConnector
  gate?: ActivationGate
  /**
   * Replaces the random generator. Only the demo uses it, so its output is
   * stable and visibly fake; nothing else has a reason to.
   */
  passwordGenerator?: (length: number) => string
}

export interface JoinerRunOptions {
  dryRun: boolean
  actor: AuditCtx['actor']
  runId: string
  /** One person, for `jml joiner run --email ...`. */
  only?: { hrisId?: string; email?: string }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export async function runJoinerEngine(deps: JoinerDeps, opts: JoinerRunOptions): Promise<RunReport> {
  const today = deps.clock.today(deps.cfg.org.timezone)
  const report: RunReport = {
    runId: opts.runId,
    kind: 'joiner',
    startedAt: deps.clock.nowIso(),
    finishedAt: deps.clock.nowIso(),
    dryRun: opts.dryRun,
    ok: true,
    counts: { joinerCandidates: 0, activated: 0, joinerHeld: 0, joinerRefused: 0, joinerSkipped: 0, joinerGateClosed: 0, joinerNoAccount: 0, joinerFailed: 0 },
    people: [],
    warnings: [],
    errors: [],
  }
  const gate = deps.gate ?? createActivationGate(deps.cfg.joiner.gate)
  const holidays = new Set(deps.cfg.joiner.holidays)
  const selection = { today, leadWorkingDays: deps.cfg.joiner.leadWorkingDays, graceDays: deps.cfg.joiner.graceDays, holidays }

  let rows = await deps.store.list({ status: ['hired', 'active'], excludeHeld: true })
  if (opts.only) {
    const wanted = opts.only
    rows = rows.filter((p) => (wanted.hrisId && p.hrisId === wanted.hrisId) || (wanted.email && p.primaryEmail.toLowerCase() === wanted.email.toLowerCase()))
    if (rows.length === 0) {
      report.ok = false
      report.errors.push('no employed person matches the requested id or address')
      return finish(deps, report)
    }
    // A named person is looked at even when the lead window or the grace
    // period would skip them, but every other rule still applies: naming
    // somebody is not permission to reset a working account.
    const skip = rows[0] ? joinerSkipReason(rows[0], { ...selection, leadWorkingDays: 3650, graceDays: 36_500 }) : 'not_employed'
    if (skip) {
      report.people.push(result(rows[0]!, 'joiner_skipped', `not a candidate: ${describeSkip(skip)}`))
      report.counts.joinerSkipped = 1
      return finish(deps, report)
    }
  }

  const candidates = opts.only ? rows : selectJoiners(rows, selection)
  report.counts.joinerCandidates = candidates.length
  const cap = deps.cfg.joiner.maxActivationsPerRun
  const todo = candidates.slice(0, cap)
  const held = candidates.slice(cap)
  report.counts.joinerHeld = held.length
  if (held.length > 0) {
    // Named, not just counted. A crowd of joiners is a data fault more often
    // than a hiring round, and the person reading the summary needs the names
    // to tell which.
    report.warnings.push(`${held.length} more joiner(s) held over the per-run cap of ${cap}: ${held.map((p) => p.displayName).join(', ')}`)
  }

  for (const person of todo) {
    const ctx: AuditCtx = { person, runId: opts.runId, actor: opts.actor, dryRun: opts.dryRun }
    try {
      const outcome = await activateOne(deps, ctx, gate, today)
      report.people.push(outcome)
      bump(report, outcome)
      if (outcome.phase === 'activated' && Object.values(outcome.legs).some((l) => l?.state === 'failed')) report.ok = false
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report.ok = false
      report.errors.push(`${person.displayName} (${person.hrisId}): ${message}`)
      report.counts.joinerFailed = (report.counts.joinerFailed ?? 0) + 1
    }
  }
  return finish(deps, report)
}

function finish(deps: JoinerDeps, report: RunReport): RunReport {
  report.finishedAt = deps.clock.nowIso()
  return report
}

function bump(report: RunReport, outcome: PersonRunResult): void {
  const key =
    outcome.phase === 'activated' ? 'activated'
    : outcome.phase === 'joiner_refused' ? 'joinerRefused'
    : outcome.notes?.some((n) => n.startsWith('gate closed')) ? 'joinerGateClosed'
    : outcome.notes?.some((n) => n.startsWith('no identity account')) ? 'joinerNoAccount'
    : 'joinerSkipped'
  report.counts[key] = (report.counts[key] ?? 0) + 1
}

function result(person: Person, phase: PersonRunResult['phase'], note: string): PersonRunResult {
  return { hrisId: person.hrisId, displayName: person.displayName, phase, legs: {}, statusBefore: person.status, statusAfter: person.status, notes: [note] }
}

function describeSkip(reason: JoinerSkipReason): string {
  const text: Record<JoinerSkipReason, string> = {
    not_employed: 'the HR system does not list them as employed',
    held: 'the row is on hold',
    parked: 'the row is parked for review',
    already_activated: 'already activated',
    refused: 'activation was refused earlier and a person has not cleared it',
    out_of_scope: 'the HR system says IT does not provision for them',
    no_start_date: 'no start date held',
    starts_later: 'the start date is outside the lead window',
    started_before_grace: 'started longer ago than joiner.graceDays with no activation recorded, so they are treated as an existing employee; name them with --hris-id to activate anyway',
    no_address: 'no work address held',
  }
  return text[reason]
}

/**
 * One person, all legs.
 *
 * Every leg is independently try/caught and recorded, and a failed leg does
 * not stop the ones after it, except that nothing is emailed for an account
 * that did not activate: a welcome for an account with no password is a
 * message about something that has not happened.
 */
async function activateOne(deps: JoinerDeps, ctx: AuditCtx, gate: ActivationGate, today: IsoDate): Promise<PersonRunResult> {
  const person = ctx.person
  const out = result(person, 'joiner_skipped', '')
  const notes: string[] = []
  out.notes = notes
  const legs: Partial<Record<ActivationLegName, LegRecord>> = { ...(person.activation?.legs ?? {}) }
  out.legs = legs

  // The hold flag is re-read immediately before any work, like the leaver
  // engine: a flag flipped mid-run wins.
  const fresh = await deps.store.get(person.hrisId)
  if (!fresh || fresh.hold) { notes.push('stopped: the row is on hold'); return out }

  const verdict = await gate.isOpen(fresh)
  if (!verdict.open) { notes.push(`gate closed: ${verdict.reason}`); return out }

  const user = await deps.idp.findUser({ storedId: fresh.externalIds[idField(deps)] ?? null, email: fresh.primaryEmail, aliases: fresh.aliasEmails })
  if (!user) {
    // The HR system's own integration creates the account, usually within a
    // day. Not an error and not a park: the row is looked at again next run.
    notes.push('no identity account yet; the HR integration has not created it. Will look again next run.')
    return out
  }

  const state = await deps.idp.getActivationState(user.id)
  if (!state) { notes.push('no identity account yet; it disappeared between lookup and read'); return out }
  if (state.suspended) { notes.push('skipped: the identity account is suspended'); return out }

  if (state.activated || state.mfaConfigured) {
    // In use. Never touched. Whether that is worth telling anybody depends on
    // whether somebody expected an activation: with a gate somebody opened,
    // yes; otherwise this is every existing employee on a first install, and
    // a hundred alerts saying "nothing to do" would get the channel muted.
    const expected = gate.mode !== 'none'
    const activation: ActivationRecord = { ...(fresh.activation ?? {}), activatedAt: today, activatedBy: 'observed', legs }
    if (expected) {
      activation.refusedReason = 'already_in_use'
      delete activation.activatedAt
      delete activation.activatedBy
    }
    if (!ctx.dryRun) await deps.store.patch(fresh.hrisId, { activation, externalIds: { ...fresh.externalIds, [idField(deps)]: user.id } })
    if (expected) {
      out.phase = 'joiner_refused'
      notes.push('refused: the identity account is already in use (activated or MFA enrolled). Its password was not touched. Clear with `jml joiner approve --reset-refusal` only if you are sure.')
      await notifyJoinerRefused(deps, ctx)
    } else {
      notes.push('already in use at first sight; recorded as activated by observation, nothing touched')
    }
    return out
  }

  // ---- activate: password, then forced reset, both read back ----
  const password = (deps.passwordGenerator ?? temporaryPassword)(deps.cfg.joiner.temporaryPasswordLength)
  const activate = await runLeg(deps, ctx, legs, 'activate', 'activate', async () => {
    const set = await auditedCall(deps, ctx, { action: 'joiner.activate.set_password', target: deps.idp.name === 'google' ? 'google' : 'jumpcloud', detail: { userId: user.id } }, () => deps.idp.setTemporaryPassword(user.id, password))
    if (!set.ok || !set.verified) return set
    const expire = await auditedCall(deps, ctx, { action: 'joiner.activate.expire_password', target: deps.idp.name === 'google' ? 'google' : 'jumpcloud', detail: { userId: user.id } }, () => deps.idp.expirePassword(user.id))
    if (!expire.ok || !expire.verified) {
      // The account is usable with the temporary password and nothing forces
      // a change. Reported as a failed leg so it is retried and visible, not
      // buried in a log nobody reads, which is where it lived before.
      return { ...expire, error: `password set, but the forced reset did not apply: ${expire.error ?? 'unknown'}` }
    }
    return { ok: true, verified: true, detail: { passwordExpired: true } }
  })
  if (activate.state !== 'done') {
    notes.push(`activation did not complete: ${activate.error ?? activate.state}`)
    await persist(deps, ctx, fresh, { legs, attempts: (fresh.activation?.attempts ?? 0) + 1 }, user)
    return out
  }
  out.phase = 'activated'
  const activation: ActivationRecord = { ...(fresh.activation ?? {}), activatedAt: today, activatedBy: 'engine', passwordResetForced: true, legs, attempts: (fresh.activation?.attempts ?? 0) + 1 }
  await persist(deps, ctx, fresh, activation, user)

  // ---- licence and mailbox ----
  const licence = deps.cfg.joiner.licence
  let mailboxReady = false
  if (licence.skuId) {
    const lic = await runLeg(deps, ctx, legs, 'joiner_licence', 'joiner_licence', async () => {
      const mailbox = await deps.google.getMailboxState(fresh.primaryEmail)
      if (!mailbox) return { ok: false, verified: false, error: 'no Google account to license', retryable: true }
      const assigned = await auditedCall(deps, ctx, { action: 'joiner.licence.assign', target: 'google', detail: { skuId: licence.skuId } }, () => deps.google.assignLicence(fresh.primaryEmail, licence.productId, licence.skuId))
      if (!assigned.ok) return assigned
      for (let attempt = 0; attempt < deps.cfg.joiner.mailboxPoll.tries; attempt += 1) {
        const again = await deps.google.getMailboxState(fresh.primaryEmail)
        if (again?.mailboxReady) { mailboxReady = true; break }
        if (attempt < deps.cfg.joiner.mailboxPoll.tries - 1) await (deps.sleep ?? defaultSleep)(deps.cfg.joiner.mailboxPoll.intervalMs)
      }
      return mailboxReady
        ? { ok: true, verified: true, detail: { skuId: licence.skuId, mailboxReady: true, alreadyLicensed: assigned.alreadyAbsent === true } }
        : { ok: true, verified: true, detail: { skuId: licence.skuId, mailboxReady: false }, error: 'licensed, but the mailbox was not ready in time' }
    })
    if (lic.state === 'done' || lic.state === 'already_absent') activation.licenceAssignedAt = today
    if (mailboxReady) activation.mailboxReadyAt = today
  } else {
    legs.joiner_licence = { state: 'not_applicable', verified: false, attempts: 0 }
    const mailbox = await deps.google.getMailboxState(fresh.primaryEmail).catch(() => null)
    mailboxReady = mailbox?.mailboxReady === true
  }

  // ---- organisational unit ----
  const ou = deps.cfg.joiner.targetOrgUnitPath
  if (ou) {
    const moved = await runLeg(deps, ctx, legs, 'ou_move', 'ou_move', () =>
      auditedCall(deps, ctx, { action: 'joiner.ou_move', target: 'google', detail: { orgUnitPath: ou } }, () => deps.google.moveToOrgUnit(fresh.primaryEmail, ou)))
    if (moved.state === 'done') activation.ouMovedAt = today
  } else {
    legs.ou_move = { state: 'not_applicable', verified: false, attempts: 0 }
  }

  // ---- emails ----
  const recipients = passwordRecipients(deps, fresh)
  if (recipients.withheld.length > 0) {
    notes.push(...recipients.withheld.map((w) => `temporary password withheld from ${w}`))
    await notifyJoinerWithheld(deps, ctx, recipients.withheld)
  }
  const welcome = await runLeg(deps, ctx, legs, 'welcome', 'welcome', async () => {
    const sent = await notifyJoinerPassword(deps, ctx, recipients.to, password)
    if (!sent.delivered) return { ok: false, verified: false, error: `temporary password not delivered: ${sent.reasons.join('; ')}`, retryable: true }
    activation.passwordSentTo = recipients.to
    const welcomeTo = [recipients.personal, mailboxReady ? fresh.primaryEmail : null].filter((a): a is string => !!a)
    if (!mailboxReady) {
      notes.push('welcome email withheld from the work address: the mailbox is not ready, so it would bounce')
      await notifyJoinerWithheld(deps, ctx, [`the work address (mailbox not ready)`])
    }
    if (welcomeTo.length > 0) {
      const w = await notifyJoinerWelcome(deps, ctx, welcomeTo)
      if (!w.delivered) return { ok: false, verified: false, error: `welcome not delivered: ${w.reasons.join('; ')}`, retryable: true }
    }
    if (recipients.manager) await notifyJoinerManager(deps, ctx, recipients.manager, mailboxReady)
    return { ok: true, verified: true, detail: { passwordSentTo: recipients.to.length, welcomeSentTo: welcomeTo.length } }
  })
  if (welcome.state === 'done' && mailboxReady) activation.welcomeSentAt = today
  await persist(deps, ctx, fresh, activation, user)
  return out
}

async function persist(deps: JoinerDeps, ctx: AuditCtx, person: Person, activation: Partial<ActivationRecord>, user: ProviderUser): Promise<void> {
  if (ctx.dryRun) return
  await deps.store.patch(person.hrisId, {
    activation: { ...(person.activation ?? {}), ...activation },
    externalIds: { ...person.externalIds, [idField(deps)]: user.id },
  })
}

async function runLeg(
  deps: JoinerDeps,
  ctx: AuditCtx,
  legs: Partial<Record<ActivationLegName, LegRecord>>,
  name: ActivationLegName,
  action: 'activate' | 'joiner_licence' | 'ou_move' | 'welcome',
  run: () => Promise<{ ok: boolean; verified: boolean; alreadyAbsent?: boolean; error?: string; retryable?: boolean }>,
): Promise<LegRecord> {
  const previous = legs[name]
  const attempts = (previous?.attempts ?? 0) + 1
  if (ctx.dryRun) {
    const record: LegRecord = { state: 'pending', verified: false, attempts: previous?.attempts ?? 0, at: deps.clock.nowIso() }
    legs[name] = record
    return record
  }
  if (!isArmed(deps.cfg, action)) {
    const record: LegRecord = { state: 'not_armed', verified: false, attempts: previous?.attempts ?? 0, at: deps.clock.nowIso() }
    legs[name] = record
    return record
  }
  let outcome: Awaited<ReturnType<typeof run>>
  try {
    outcome = await run()
  } catch (err) {
    outcome = { ok: false, verified: false, error: err instanceof Error ? err.message : String(err), retryable: true }
  }
  const record: LegRecord = {
    state: !outcome.ok ? 'failed' : outcome.alreadyAbsent ? 'already_absent' : outcome.verified ? 'done' : 'failed',
    verified: outcome.verified,
    attempts,
    at: deps.clock.nowIso(),
    ...(outcome.error && !outcome.ok ? { error: outcome.error } : {}),
  }
  legs[name] = record
  return record
}

/**
 * Where the temporary password may go.
 *
 * The personal address must not be a company one and the manager's must be.
 * Both are re-read from the row at send time rather than trusted as written,
 * because four different producers fill those fields in an earlier design and two of them put a person's name where an address belongs.
 */
function passwordRecipients(deps: JoinerDeps, person: Person): { to: string[]; personal: string | null; manager: string | null; withheld: string[] } {
  const withheld: string[] = []
  const company = (a: string) => deps.domain.isOurs(a)
  const personalRaw = person.personalEmail?.trim() || null
  let personal: string | null = null
  if (!personalRaw) withheld.push('the personal address (none held)')
  else if (!EMAIL.test(personalRaw)) withheld.push('the personal address (not an address)')
  else if (company(personalRaw)) withheld.push('the personal address (it is a company address, so the credential would land in a colleague\'s inbox)')
  else personal = personalRaw

  const managerRaw = person.managerEmail?.trim() || null
  let manager: string | null = null
  if (!managerRaw) withheld.push('the manager (no address held)')
  else if (!EMAIL.test(managerRaw)) withheld.push('the manager (not an address)')
  else if (!company(managerRaw)) withheld.push('the manager (not a company address)')
  else manager = managerRaw

  const it = deps.cfg.joiner.itSupportEmail
  const to = [personal, manager, it].filter((a): a is string => !!a)
  return { to, personal, manager, withheld }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Which stored id the account belongs under. With no identity provider the
 * activated account is the Google one, and writing its id into the identity
 * provider field would later be read as a JumpCloud id.
 */
function idField(deps: { idp: { name: string } }): 'jumpcloudUserId' | 'googleUserId' {
  return deps.idp.name === 'google' ? 'googleUserId' : 'jumpcloudUserId'
}
