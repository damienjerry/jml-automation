/**
 * The few Notion calls the people store needs, over the shared HTTP client.
 *
 * Pagination is the whole reason this file exists rather than three inline
 * requests: a database query answers one hundred rows and a cursor, and an earlier design read one page and silently dropped everybody past
 * it. Every read here pages until `has_more` is false.
 *
 * Rate limits come back as 429 with Retry-After, which the HTTP client
 * already honours; nothing here retries on its own.
 */

import type { HttpClient } from '../../core/http.ts'
import type { SecretLike } from '../../hris/hibob/adapter.ts'

const NOTION_VERSION = '2022-06-28'
const BASE = 'https://api.notion.com/v1'

export type NotionProperties = Record<string, unknown>

export interface NotionPage {
  id: string
  url?: string
  archived?: boolean
  properties: NotionProperties
}

export interface NotionDatabase {
  id: string
  properties: Record<string, { type: string; name?: string; select?: { options?: { name: string }[] } }>
}

export class NotionApiError extends Error {
  readonly code = 'notion_api_error'
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export class NotionClient {
  private readonly http: HttpClient
  private readonly token: SecretLike

  constructor(options: { http: HttpClient; token: SecretLike }) {
    this.http = options.http
    this.token = options.token
  }

  getDatabase(id: string): Promise<NotionDatabase> {
    return this.call<NotionDatabase>('GET', `/databases/${id}`)
  }

  /** Adds properties. Notion treats a PATCH as a merge, so nothing here can remove one. */
  addDatabaseProperties(id: string, properties: Record<string, unknown>): Promise<NotionDatabase> {
    return this.call<NotionDatabase>('PATCH', `/databases/${id}`, { properties })
  }

  async queryAll(databaseId: string, filter?: unknown): Promise<NotionPage[]> {
    const pages: NotionPage[] = []
    let cursor: string | undefined
    // A hard ceiling so a cursor that never advances cannot loop for ever; a
    // thousand pages is a hundred thousand people.
    for (let n = 0; n < 1000; n += 1) {
      const body = await this.call<{ results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null }>(
        'POST',
        `/databases/${databaseId}/query`,
        { page_size: 100, ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) },
      )
      pages.push(...(body.results ?? []))
      if (!body.has_more || !body.next_cursor) return pages
      cursor = body.next_cursor
    }
    throw new NotionApiError('the database query never stopped paging', 0)
  }

  getPage(id: string): Promise<NotionPage> {
    return this.call<NotionPage>('GET', `/pages/${id}`)
  }

  createPage(databaseId: string, properties: NotionProperties): Promise<NotionPage> {
    return this.call<NotionPage>('POST', '/pages', { parent: { database_id: databaseId }, properties })
  }

  updatePage(id: string, properties: NotionProperties): Promise<NotionPage> {
    return this.call<NotionPage>('PATCH', `/pages/${id}`, { properties })
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await this.token.use((value) =>
      this.http.request({
        method,
        url: BASE + path,
        headers: { Authorization: 'Bearer ' + value, 'Notion-Version': NOTION_VERSION },
        ...(body ? { body } : {}),
        label: 'notion ' + method + ' ' + path.split('/')[1],
      }),
    )
    if (!res.ok) throw new NotionApiError(`Notion answered ${res.status} to ${method} ${path}`, res.status)
    const json = res.json<T>()
    if (json === null) throw new NotionApiError(`Notion answered ${method} ${path} with a body that is not JSON`, res.status)
    return json
  }
}
