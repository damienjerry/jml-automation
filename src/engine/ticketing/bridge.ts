/**
 * Opening the activation gate from a ticket.
 *
 * The rules, each from an earlier design:
 *  - Only a ticket raised on the configured starter form counts. The webhook
 *    on the other side should already be scoped to that form; this checks
 *    again, because a trigger scoped wrongly once forwarded every ticket.
 *  - Match by work address when the form asks for one, else by exact name
 *    among the people still waiting for a gate. A name match against somebody
 *    already activated is a coincidence, not this starter.
 *  - Ambiguity never opens a gate. Two candidates means a person decides,
 *    and both the ticket and IT are told.
 */

import type { Actor, Person } from '../../core/types.ts'
import type { InboundTicketEvent } from '../../ticketing/types.ts'
import type { TicketingDeps } from './index.ts'

export interface BridgeResult {
  outcome: 'opened' | 'ignored' | 'unmatched' | 'ambiguous' | 'already_open' | 'no_name'
  hrisId?: string
  detail: string
}

export async function openGateFromTicket(deps: TicketingDeps, event: InboundTicketEvent, actor: Actor): Promise<BridgeResult> {
  const cfg = deps.cfg.ticketing
  const now = deps.clock.nowIso()
  const starterFormId = cfg.suptask.starterFormId
  if (event.eventType !== 'created') return { outcome: 'ignored', detail: `event type ${event.eventType} is not a creation` }
  if (!starterFormId || event.formId !== starterFormId) return { outcome: 'ignored', detail: 'not the configured starter form' }

  const f = cfg.starterForm
  const text = (label: string) => {
    const v = event.fields[label]
    return (Array.isArray(v) ? v.join(' ') : (v ?? '')).trim()
  }
  const email = text(f.emailField).toLowerCase()
  const fullName = `${text(f.firstNameField)} ${text(f.lastNameField)}`.trim().toLowerCase()
  const personal = text(f.personalEmailField).toLowerCase() || null
  if (!email && !fullName) {
    await tellIt(deps, event, `Ticket #${event.ticket.number} carries neither a work address nor a name, so it cannot be matched to anybody.`)
    return { outcome: 'no_name', detail: 'no address and no name on the form' }
  }

  const waiting = (await deps.store.list({ status: ['hired', 'active'], excludeHeld: true })).filter(
    (p) => !p.activation?.activatedAt && !p.activation?.refusedReason && p.inScope !== false,
  )
  let matches: Person[] = email ? waiting.filter((p) => p.primaryEmail.toLowerCase() === email) : []
  if (matches.length === 0 && fullName) matches = waiting.filter((p) => p.displayName.trim().toLowerCase() === fullName)

  if (matches.length !== 1) {
    const what = matches.length === 0 ? 'nobody waiting for a gate matches' : `${matches.length} people waiting for a gate match`
    const who = email || fullName
    await tellIt(deps, event, `Ticket #${event.ticket.number}: ${what} "${who}". The gate was not opened. Link it by hand with \`jml joiner approve\`.`)
    if (deps.ticketing) await deps.ticketing.reply(event.ticket.id, `IT: this could not be matched to a starter automatically (${what}). Somebody from IT will link it by hand.`).catch(() => undefined)
    return { outcome: matches.length === 0 ? 'unmatched' : 'ambiguous', detail: `${what} "${who}"` }
  }

  const person = matches[0]!
  if (person.activation?.gateOpenedAt) return { outcome: 'already_open', hrisId: person.hrisId, detail: `gate already opened ${person.activation.gateOpenedAt}` }

  const activation = {
    ...(person.activation ?? {}),
    gateOpenedAt: now,
    gateOpenedBy: `ticket:${event.ticket.number}`,
    ticketRef: event.ticket,
  }
  await deps.audit.append({
    at: now,
    runId: `ticket-${event.ticket.number}`,
    phase: 'outcome',
    actor,
    action: 'joiner.gate.opened_by_ticket',
    subject: { kind: 'person', id: person.hrisId, label: person.displayName },
    dryRun: false,
    ok: true,
    verified: true,
    detail: { ticketNumber: event.ticket.number, matchedBy: email ? 'email' : 'name', personalEmailProvided: personal !== null },
  })
  // A personal address from the form is written as given; the activation
  // engine validates it at send time, as it does the HR system's value.
  await deps.store.patch(person.hrisId, { activation, ...(personal ? { personalEmail: personal } : {}) })
  if (deps.ticketing) {
    await deps.ticketing.reply(event.ticket.id, `IT: matched to ${person.displayName} (start ${person.startDate ?? 'unknown'}). The account will be activated ${deps.cfg.joiner.leadWorkingDays} working day(s) before the start date.`).catch(() => undefined)
  }
  return { outcome: 'opened', hrisId: person.hrisId, detail: `matched by ${email ? 'address' : 'name'}` }
}

async function tellIt(deps: TicketingDeps, event: InboundTicketEvent, body: string): Promise<void> {
  await deps.notifier.send({ kind: 'ticket.unmatched', subject: `Starter form ticket #${event.ticket.number} needs a hand`, body: `${body}${event.ticket.url ? `\n\n${event.ticket.url}` : ''}`, audience: 'it', detail: { ticketNumber: event.ticket.number } })
}
