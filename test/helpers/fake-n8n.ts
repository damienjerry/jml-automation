/**
 * An in-memory n8n public API, enough for the importer: list and create
 * workflows, create credentials, and the health endpoint. Every request is
 * recorded so a test can prove where things were sent and what was in them.
 */

import type { HttpClient, HttpRequest, HttpResponse } from '../../src/core/http.ts'

export interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

function response(status: number, body: unknown): HttpResponse {
  const text = body === undefined ? '' : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, headers: {}, body: text, json: <T>() => (text ? (JSON.parse(text) as T) : null), attempts: 1 }
}

export class FakeN8n {
  readonly requests: RecordedRequest[] = []
  readonly workflows = new Map<string, { id: string; name: string; body: Record<string, unknown> }>()
  readonly credentials = new Map<string, { id: string; name: string; type: string; data: Record<string, string> }>()
  apiKey = 'n8n-api-key-not-real'
  healthy = true
  private next = 1

  constructor(readonly baseUrl = 'http://127.0.0.1:5678') {}

  http(): HttpClient {
    const request = async (req: HttpRequest): Promise<HttpResponse> => this.handle(req)
    return {
      request,
      get: (url, r) => request({ ...r, method: 'GET', url }),
      post: (url, body, r) => request({ ...r, method: 'POST', url, ...(body === undefined ? {} : { body }) }),
      put: (url, body, r) => request({ ...r, method: 'PUT', url, ...(body === undefined ? {} : { body }) }),
      patch: (url, body, r) => request({ ...r, method: 'PATCH', url, ...(body === undefined ? {} : { body }) }),
      delete: (url, r) => request({ ...r, method: 'DELETE', url }),
    }
  }

  private handle(req: HttpRequest): HttpResponse {
    this.requests.push({ method: req.method, url: req.url, headers: { ...(req.headers ?? {}) }, body: req.body })
    const path = req.url.replace(this.baseUrl, '')
    if (path === '/healthz') return response(this.healthy ? 200 : 503, { status: 'ok' })
    if (req.headers?.['X-N8N-API-KEY'] !== this.apiKey) return response(401, { message: 'unauthorized' })
    if (req.method === 'GET' && path === '/api/v1/workflows') {
      return response(200, { data: [...this.workflows.values()].map((w) => ({ id: w.id, name: w.name })), nextCursor: null })
    }
    if (req.method === 'POST' && path === '/api/v1/workflows') {
      const body = req.body as Record<string, unknown>
      const id = `wf${this.next++}`
      this.workflows.set(String(body['name']), { id, name: String(body['name']), body })
      return response(200, { id, name: body['name'] })
    }
    if (req.method === 'POST' && path === '/api/v1/credentials') {
      const body = req.body as { name: string; type: string; data: Record<string, string> }
      const id = `cred${this.next++}`
      this.credentials.set(id, { id, ...body })
      return response(200, { id, name: body.name, type: body.type })
    }
    return response(404, { message: `no route ${req.method} ${path}` })
  }
}
