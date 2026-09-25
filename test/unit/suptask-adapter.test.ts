import { describe, expect, it } from 'vitest'
import { createHttpClient } from '../../src/core/http.ts'
import { SuptaskAdapter } from '../../src/ticketing/suptask/adapter.ts'
import { storedPerson } from '../helpers/sync-harness.ts'

function adapter(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const http = createHttpClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      const r = handler(url, init)
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
    },
    sleep: async () => undefined,
  })
  const a = new SuptaskAdapter({ http, apiToken: { use: (fn) => fn('token-value-not-real') }, queueId: 'q-1', requesterId: 'U-it', starterFormId: 'form-starter', leaverFormId: 'form-leaver' })
  return { a, calls }
}

describe('the Suptask adapter', () => {
  it('creates a leaver ticket with the shape the API requires, then patches the due date separately', async () => {
    const { a, calls } = adapter((url) => (url.endsWith('/ticket') ? { status: 201, body: { oldTicket: { id: 'abc', ticketNumber: 77, responderThreadPermalink: 'https://chat.example.com/t/77' } } } : { status: 200, body: {} }))
    const res = await a.createTicket({ kind: 'leaver', person: storedPerson(), subject: 'Leaver: Jane Doe', description: 'plan', dueDate: '2026-04-01', tags: ['Offboard'] })
    expect(res.ticket).toEqual({ id: 'abc', number: '77', url: 'https://chat.example.com/t/77' })
    const create = JSON.parse(String(calls[0]?.init.body))
    // requesterChannel is required and is the same chat user as the requester.
    expect(create).toMatchObject({ queueId: 'q-1', formId: 'form-leaver', requesterId: 'U-it', requesterChannel: 'U-it' })
    expect(String((calls[0]?.init.headers as Record<string, string>)['authorization'] ?? (calls[0]?.init.headers as Record<string, string>)['Authorization'])).toBe('Api-Token token-value-not-real')
    expect(calls[1]?.init.method).toBe('PATCH')
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ dueDate: '2026-04-01', tags: ['Offboard'] })
  })

  it('reports a failed create without a ticket, and never retries it', async () => {
    const { a, calls } = adapter(() => ({ status: 500, body: { error: 'boom' } }))
    const res = await a.createTicket({ kind: 'leaver', person: storedPerson(), subject: 's', description: 'd' })
    expect(res.ticket).toBeNull()
    expect(res.outcome.ok).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('parses the webhook body into the generic event, and refuses anything else', () => {
    const { a } = adapter(() => ({ status: 200, body: {} }))
    const event = a.parseInbound({ eventType: 'created', ticket: { id: 'abc', ticketNumber: 9, formId: 'form-starter', customFields: [{ fieldName: 'First Name', value: 'John' }, { fieldName: 'Additional App Access', value: ['A', 'B'] }] } })
    expect(event).toEqual({ eventType: 'created', ticket: { id: 'abc', number: '9', url: null }, formId: 'form-starter', fields: { 'First Name': 'John', 'Additional App Access': ['A', 'B'] }, requesterEmail: null })
    expect(a.parseInbound('nonsense')).toBeNull()
    expect(a.parseInbound({ hello: 'world' })).toBeNull()
  })
})
