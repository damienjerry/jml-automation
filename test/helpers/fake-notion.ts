/**
 * An in-memory Notion, served through the real HTTP client's fetch hook.
 *
 * It implements exactly the calls the store makes, pages a hundred at a time
 * like the real one, and can be told to answer 429 once so the retry path is
 * exercised. Filters are evaluated for select and checkbox, which is all the
 * adapter sends; the adapter post-filters the rest, and a test that wants to
 * prove that reads the request log.
 */

import { createHttpClient, type HttpClient } from '../../src/core/http.ts'

type Props = Record<string, unknown>

export class FakeNotion {
  readonly database: { id: string; properties: Record<string, { type: string; select?: { options: { name: string }[] } }> }
  readonly pages = new Map<string, { id: string; archived: boolean; properties: Props }>()
  readonly requests: { method: string; path: string; body: unknown }[] = []
  rateLimitOnce = false
  private seq = 0

  constructor(databaseId = 'db-people', properties: Record<string, { type: string }> = { Name: { type: 'title' } }) {
    this.database = { id: databaseId, properties: { ...properties } }
  }

  http(): HttpClient {
    return createHttpClient({
      sleep: async () => undefined,
      fetchImpl: async (url, init) => {
        const u = new URL(url)
        const method = init.method ?? 'GET'
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        this.requests.push({ method, path: u.pathname, body })
        if (this.rateLimitOnce) {
          this.rateLimitOnce = false
          return new Response('{"message":"rate limited"}', { status: 429, headers: { 'retry-after': '0', 'content-type': 'application/json' } })
        }
        const r = this.route(method, u.pathname, body)
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
      },
    })
  }

  private route(method: string, path: string, body: Props | undefined): { status: number; body: unknown } {
    const db = this.database
    if (method === 'GET' && path === `/v1/databases/${db.id}`) return { status: 200, body: db }
    if (method === 'PATCH' && path === `/v1/databases/${db.id}`) {
      for (const [name, def] of Object.entries((body?.['properties'] as Record<string, Record<string, unknown>>) ?? {})) {
        const type = Object.keys(def)[0]!
        db.properties[name] = { type, ...(type === 'select' ? { select: (def[type] as { options: { name: string }[] }) } : {}) }
      }
      return { status: 200, body: db }
    }
    if (method === 'POST' && path === `/v1/databases/${db.id}/query`) {
      const all = [...this.pages.values()].filter((p) => !p.archived && this.matches(p.properties, body?.['filter']))
      const size = Number(body?.['page_size'] ?? 100)
      const start = body?.['start_cursor'] ? Number(body['start_cursor']) : 0
      const slice = all.slice(start, start + size)
      const hasMore = start + size < all.length
      return { status: 200, body: { results: slice, has_more: hasMore, next_cursor: hasMore ? String(start + size) : null } }
    }
    if (method === 'POST' && path === '/v1/pages') {
      const id = `page-${++this.seq}`
      const page = { id, archived: false, properties: this.normalise(body?.['properties'] as Props) }
      this.pages.set(id, page)
      return { status: 200, body: page }
    }
    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(path)
    if (pageMatch) {
      const page = this.pages.get(pageMatch[1]!)
      if (!page) return { status: 404, body: { message: 'not found' } }
      if (method === 'GET') return { status: 200, body: page }
      if (method === 'PATCH') {
        page.properties = { ...page.properties, ...this.normalise(body?.['properties'] as Props) }
        return { status: 200, body: page }
      }
    }
    return { status: 404, body: { message: `no route ${method} ${path}` } }
  }

  /** Turn write-shaped properties into read-shaped ones, as Notion does. */
  private normalise(props: Props | undefined): Props {
    const out: Props = {}
    for (const [name, value] of Object.entries(props ?? {})) {
      const v = value as Record<string, unknown>
      if (Array.isArray(v['rich_text'])) out[name] = { rich_text: (v['rich_text'] as { text: { content: string } }[]).map((t) => ({ plain_text: t.text.content, text: t.text })) }
      else if (Array.isArray(v['title'])) out[name] = { title: (v['title'] as { text: { content: string } }[]).map((t) => ({ plain_text: t.text.content, text: t.text })) }
      else out[name] = v
    }
    return out
  }

  private matches(props: Props, filter: unknown): boolean {
    if (!filter || typeof filter !== 'object') return true
    const f = filter as Record<string, unknown>
    if (Array.isArray(f['and'])) return (f['and'] as unknown[]).every((x) => this.matches(props, x))
    if (Array.isArray(f['or'])) return (f['or'] as unknown[]).some((x) => this.matches(props, x))
    const prop = props[String(f['property'])] as Record<string, unknown> | undefined
    if (f['select']) return ((prop?.['select'] as { name?: string } | null)?.name ?? null) === (f['select'] as { equals: string }).equals
    if (f['checkbox']) return (prop?.['checkbox'] === true) === (f['checkbox'] as { equals: boolean }).equals
    if (f['rich_text']) {
      const text = ((prop?.['rich_text'] as { plain_text?: string }[] | undefined) ?? []).map((t) => t.plain_text ?? '').join('')
      return text === (f['rich_text'] as { equals: string }).equals
    }
    return true
  }
}
