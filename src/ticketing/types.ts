/**
 * A ticketing system, as the lifecycle needs it.
 *
 * Two directions. Outbound: create a ticket for a leaver so the long tail of
 * platforms IT does not administer has somewhere to be worked through. Inbound:
 * a ticket raised on the new-starter form opens the activation gate, because
 * in the estate this came from the manager's form was the only thing that said
 * what a starter needed, and nothing else may open that gate.
 *
 * The interface is small on purpose. Every ticketing product has a create call
 * and a webhook; the shape of both is the adapter's problem, and the engine
 * only ever sees the generic event.
 */

import type { Outcome, Person } from '../core/types.ts'
import type { ConnectionCheck } from '../hris/types.ts'

export interface TicketRef {
  id: string
  /** The human-facing number, for messages. */
  number: string
  url: string | null
}

export interface CreateTicketRequest {
  kind: 'leaver' | 'starter'
  person: Person
  subject: string
  description: string
  /** ISO date. Adapters that have no due-date field ignore it. */
  dueDate?: string | null
  tags?: string[]
}

/**
 * A ticket event, whatever the product called it.
 *
 * `formId` is what the bridge keys on: only a ticket raised on the configured
 * new-starter form may open a gate. `fields` is the form's answers keyed by
 * the field label as the product reports it.
 */
export interface InboundTicketEvent {
  eventType: 'created' | 'updated' | 'other'
  ticket: TicketRef
  formId: string | null
  fields: Record<string, string | string[]>
  requesterEmail?: string | null
}

export interface TicketingAdapter {
  readonly name: string
  createTicket(req: CreateTicketRequest): Promise<{ outcome: Outcome; ticket: TicketRef | null }>
  /** A note on the ticket, visible to whoever raised it and to the responders. */
  reply(ticketId: string, text: string): Promise<Outcome>
  /**
   * Turn a raw webhook body into the generic event, or null when it is not
   * one this adapter recognises. Never throws on a strange body: an inbound
   * endpoint that throws on unexpected input is a way to fill the error
   * workflow with noise from somebody else's automation.
   */
  parseInbound(body: unknown): InboundTicketEvent | null
  testConnection(): Promise<ConnectionCheck>
}
