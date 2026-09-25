import type { Outcome } from '../../src/core/types.ts'
import type { CreateTicketRequest, InboundTicketEvent, TicketRef, TicketingAdapter } from '../../src/ticketing/types.ts'

/** A ticketing system that remembers what it was asked. */
export class FakeTicketing implements TicketingAdapter {
  readonly name = 'fake-ticketing'
  readonly created: CreateTicketRequest[] = []
  readonly replies: { ticketId: string; text: string }[] = []
  failCreate = false
  private seq = 100

  async createTicket(req: CreateTicketRequest): Promise<{ outcome: Outcome; ticket: TicketRef | null }> {
    this.created.push(req)
    if (this.failCreate) return { outcome: { ok: false, verified: false, error: 'refused by test', retryable: true }, ticket: null }
    this.seq += 1
    return { outcome: { ok: true, verified: true }, ticket: { id: `t-${this.seq}`, number: String(this.seq), url: null } }
  }

  async reply(ticketId: string, text: string): Promise<Outcome> {
    this.replies.push({ ticketId, text })
    return { ok: true, verified: true }
  }

  parseInbound(body: unknown): InboundTicketEvent | null {
    return body && typeof body === 'object' && 'ticket' in body ? (body as InboundTicketEvent) : null
  }

  async testConnection() {
    return { ok: true, detail: 'fake' }
  }
}

export function starterTicket(fields: Record<string, string>, formId = 'form-starter', number = '42'): InboundTicketEvent {
  return { eventType: 'created', ticket: { id: `t-${number}`, number, url: null }, formId, fields }
}
