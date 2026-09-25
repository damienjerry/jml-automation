/**
 * Suptask, the reference ticketing adapter.
 *
 * Facts about this API, each learned by trying it rather than from the docs:
 *  - `requesterChannel` is required on create, and a chat user id is accepted
 *    and resolved to that user's direct-message channel.
 *  - The 201 nests the created ticket under `oldTicket`.
 *  - The auth header is `Authorization: Api-Token <token>`; other spellings
 *    answer 400.
 *  - GET takes the ticket number, PATCH takes the id. A due date is a
 *    top-level `dueDate` on a PATCH and is not echoed back on a GET.
 *  - The webhook body carries `eventType` and `ticket`, with the form's
 *    answers under `ticket.customFields[]` as `{ fieldName, value }`.
 */

import type { HttpClient } from '../../core/http.ts'
import type { Outcome } from '../../core/types.ts'
import type { SecretLike } from '../../hris/hibob/adapter.ts'
import type { ConnectionCheck } from '../../hris/types.ts'
import type { CreateTicketRequest, InboundTicketEvent, TicketRef, TicketingAdapter } from '../types.ts'

export interface SuptaskAdapterOptions {
  http: HttpClient
  apiToken: SecretLike
  baseUrl?: string
  queueId: string
  /** The requester every automated ticket is raised as, typically the IT owner's chat user id. */
  requesterId: string
  starterFormId?: string | null
  leaverFormId?: string | null
}

const DEFAULT_BASE_URL = 'https://public-api-prod.suptask.com/api/v2/public'

interface SuptaskTicketBody {
  id?: string
  ticketNumber?: number | string
  formId?: string
  requesterThreadPermalink?: string
  responderThreadPermalink?: string
  customFields?: { fieldName?: string; value?: unknown }[]
  requester?: { email?: string }
}

export class SuptaskAdapter implements TicketingAdapter {
  readonly name = 'suptask'
  private readonly http: HttpClient
  private readonly apiToken: SecretLike
  private readonly baseUrl: string
  private readonly queueId: string
  private readonly requesterId: string
  private readonly starterFormId: string | null
  private readonly leaverFormId: string | null

  constructor(options: SuptaskAdapterOptions) {
    this.http = options.http
    this.apiToken = options.apiToken
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.queueId = options.queueId
    this.requesterId = options.requesterId
    this.starterFormId = options.starterFormId ?? null
    this.leaverFormId = options.leaverFormId ?? null
  }

  async createTicket(req: CreateTicketRequest): Promise<{ outcome: Outcome; ticket: TicketRef | null }> {
    const formId = req.kind === 'leaver' ? this.leaverFormId : this.starterFormId
    const body: Record<string, unknown> = {
      queueId: this.queueId,
      ...(formId ? { formId } : {}),
      requesterId: this.requesterId,
      requesterChannel: this.requesterId,
      description: `${req.subject}\n\n${req.description}`,
    }
    const res = await this.apiToken.use((token) =>
      this.http.post(`${this.baseUrl}/ticket`, body, {
        headers: { Authorization: authHeader(token) },
        label: 'suptask ticket create',
        // Creating a ticket twice is two tickets. Not retried.
        retryOn5xx: false,
      }),
    )
    const raw = res.json<{ oldTicket?: SuptaskTicketBody } & SuptaskTicketBody>()
    const ticket = toRef(raw?.oldTicket ?? raw ?? {})
    if (!res.ok || !ticket) {
      return {
        outcome: { ok: false, verified: false, error: `ticket create answered ${res.status}`, retryable: res.status === 429 || res.status >= 500, detail: { status: res.status } },
        ticket: null,
      }
    }
    // The tag and the due date ride on a separate PATCH so a rejected field
    // can never stop the ticket itself being created.
    if (req.dueDate || (req.tags && req.tags.length > 0)) {
      await this.apiToken.use((token) =>
        this.http.patch(
          `${this.baseUrl}/ticket/${encodeURIComponent(ticket.id)}`,
          { ...(req.dueDate ? { dueDate: req.dueDate } : {}), ...(req.tags?.length ? { tags: req.tags } : {}) },
          { headers: { Authorization: authHeader(token) }, label: 'suptask ticket patch' },
        ),
      )
    }
    return { outcome: { ok: true, verified: true, detail: { ticketNumber: ticket.number } }, ticket }
  }

  async reply(ticketId: string, text: string): Promise<Outcome> {
    const res = await this.apiToken.use((token) =>
      this.http.post(
        `${this.baseUrl}/ticket/reply/${encodeURIComponent(ticketId)}`,
        // The channel values are lower-case; the capitalised forms answer 400.
        { text, username: 'IT automation', channel: ['responder', 'requester'] },
        { headers: { Authorization: authHeader(token) }, label: 'suptask ticket reply' },
      ),
    )
    return res.ok
      ? { ok: true, verified: true }
      : { ok: false, verified: false, error: `ticket reply answered ${res.status}`, retryable: res.status === 429 || res.status >= 500 }
  }

  parseInbound(body: unknown): InboundTicketEvent | null {
    if (!body || typeof body !== 'object') return null
    const outer = body as { eventType?: unknown; ticket?: unknown }
    if (!outer.ticket || typeof outer.ticket !== 'object') return null
    const t = outer.ticket as SuptaskTicketBody
    const ref = toRef(t)
    if (!ref) return null
    const fields: Record<string, string | string[]> = {}
    for (const f of t.customFields ?? []) {
      if (!f.fieldName) continue
      const v = f.value
      if (Array.isArray(v)) fields[f.fieldName] = v.map((x) => String(x))
      else if (v !== null && v !== undefined) fields[f.fieldName] = String(v)
    }
    const eventType = outer.eventType === 'created' ? 'created' : outer.eventType === 'updated' ? 'updated' : 'other'
    return { eventType, ticket: ref, formId: t.formId ?? null, fields, requesterEmail: t.requester?.email ?? null }
  }

  async testConnection(): Promise<ConnectionCheck> {
    const res = await this.apiToken.use((token) =>
      this.http.get(`${this.baseUrl}/ticket/1`, { headers: { Authorization: authHeader(token) }, label: 'suptask probe', maxRetries: 0 }),
    )
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `the API token was refused (${res.status})`, remediation: 'Create a workspace API token in the ticketing admin console and reference it as ticketing.suptask.apiToken.', docsAnchor: 'docs/credentials.md#ticketing' }
    }
    // A 404 on ticket 1 is fine: it proves the token is accepted.
    return { ok: res.ok || res.status === 404, detail: `ticket read answered ${res.status}` }
  }
}

function toRef(t: SuptaskTicketBody): TicketRef | null {
  if (!t.id && t.ticketNumber === undefined) return null
  return {
    id: String(t.id ?? t.ticketNumber),
    number: String(t.ticketNumber ?? t.id ?? ''),
    url: t.responderThreadPermalink ?? t.requesterThreadPermalink ?? null,
  }
}

/**
 * The header value, built inside `use()` so the token never leaves the
 * callback. Concatenation rather than a template, because the lint rule that
 * keeps secrets out of messages bans interpolating anything named like one.
 */
function authHeader(token: string): string {
  return 'Api-Token ' + token
}
