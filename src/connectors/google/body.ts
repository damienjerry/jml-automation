/**
 * Reading a Google response body without guessing.
 *
 * `HttpResponse.json()` answers null for a body that is not JSON, and the
 * natural next step, `?.items ?? []`, turns that into an empty list. An empty
 * list is a conclusion ("no grants remain", "no licence is held", "no transfer
 * exists"), and a conclusion drawn from a body nobody could read is how a
 * check reports verified after reading nothing. These helpers refuse instead.
 *
 * Google omits a list field when the list is empty, so an absent field is an
 * empty list. A field that is present and not a list is unreadable.
 */

import type { HttpResponse } from '../../core/http.ts'

export class UnreadableResponse extends Error {
  readonly code = 'unreadable_response'
}

/** The body as a JSON object, or a refusal naming what was being read. */
export function objectBody<T extends object>(response: HttpResponse, what: string): T {
  const body = response.json<unknown>()
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new UnreadableResponse(`${what} answered ${response.status} with a body that is not a JSON object, so nothing can be concluded from it`)
  }
  return body as T
}

/** A list field of that body: absent means empty, anything other than a list is a refusal. */
export function listField<T>(body: object, field: string, what: string): T[] {
  const value = (body as Record<string, unknown>)[field]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new UnreadableResponse(`${what} answered with "${field}" that is not a list, so nothing can be concluded from it`)
  return value as T[]
}
