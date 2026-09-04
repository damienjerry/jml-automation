/**
 * The redaction registry.
 *
 * Every resolved secret registers itself here at start-up, and everything this
 * toolkit emits goes through `redactDeep`: log lines, Error messages, HTTP
 * error bodies, the RunReport and every audit row.
 *
 * Why a registry rather than careful coding at each call site: a credential
 * does not usually escape through the line that handles it. It escapes because
 * a provider echoed the key back inside an error body, or because somebody
 * serialised a whole request object into a log while debugging. Neither of
 * those call sites knows it is handling a secret. A registry catches the value
 * wherever it turns up.
 */

/** Values shorter than this are not registered. See `register`. */
const MIN_REGISTERED_LENGTH = 6

export const REDACTED = '[redacted]'

export interface Redactor {
  /** Register a value so it is masked everywhere from now on. */
  register(value: string): void
  /** How many distinct values are registered. Safe to log. */
  readonly size: number
  redactString(text: string): string
  /** Deep copy with every registered value masked, in keys as well as values. */
  redactDeep<T>(value: T): T
  /** A new Error with the message and stack redacted. Keeps the original name. */
  redactError(err: unknown): Error
  /** Test-only. Production code registers and never unregisters. */
  clear(): void
}

class RegistryRedactor implements Redactor {
  /** Kept sorted longest-first so a value that contains another is masked whole. */
  #values: string[] = []
  #set = new Set<string>()

  get size(): number {
    return this.#set.size
  }

  register(value: string): void {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    // A short value would mask ordinary prose: registering a two-character
    // token turns every log line into asterisks and the operator switches
    // redaction off, which is worse than the gap it closed.
    if (trimmed.length < MIN_REGISTERED_LENGTH) return

    for (const form of formsOf(trimmed)) {
      if (form.length < MIN_REGISTERED_LENGTH || this.#set.has(form)) continue
      this.#set.add(form)
      this.#values.push(form)
    }
    this.#values.sort((a, b) => b.length - a.length)
  }

  redactString(text: string): string {
    if (typeof text !== 'string' || this.#values.length === 0) return text
    let out = text
    for (const value of this.#values) {
      if (out.includes(value)) out = out.split(value).join(REDACTED)
    }
    return out
  }

  redactDeep<T>(value: T): T {
    return this.#walk(value, new WeakMap()) as T
  }

  redactError(err: unknown): Error {
    if (!(err instanceof Error)) {
      const wrapped = new Error(this.redactString(String(err)))
      wrapped.name = 'NonError'
      return wrapped
    }
    const copy = new Error(this.redactString(err.message))
    copy.name = err.name
    copy.stack = err.stack ? this.redactString(err.stack) : undefined
    if (err.cause !== undefined) copy.cause = this.redactDeep(err.cause)
    return copy
  }

  clear(): void {
    this.#values = []
    this.#set.clear()
  }

  #walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === 'string') return this.redactString(value)
    if (value === null || typeof value !== 'object') return value
    if (value instanceof Error) return this.redactError(value)
    if (value instanceof Date) return value

    const existing = seen.get(value)
    if (existing !== undefined) return existing

    if (Array.isArray(value)) {
      const out: unknown[] = []
      seen.set(value, out)
      for (const item of value) out.push(this.#walk(item, seen))
      return out
    }

    // A Set or Map would otherwise serialise as {} and its contents escape
    // unredacted through a JSON.stringify further down the line.
    if (value instanceof Set) {
      const out = new Set<unknown>()
      seen.set(value, out)
      for (const item of value) out.add(this.#walk(item, seen))
      return out
    }
    if (value instanceof Map) {
      const out = new Map<unknown, unknown>()
      seen.set(value, out)
      for (const [k, v] of value) out.set(this.#walk(k, seen), this.#walk(v, seen))
      return out
    }

    const out: Record<string, unknown> = {}
    seen.set(value, out)
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[this.redactString(k)] = this.#walk(v, seen)
    }
    return out
  }
}

/**
 * The forms one secret can take on the wire.
 *
 * A credential put in a URL arrives percent-encoded, and one sent as a basic
 * auth header arrives base64. Registering only the plain value leaves both
 * readable in a log, so each is registered as well.
 */
function formsOf(value: string): string[] {
  const forms = new Set<string>([value])
  const encoded = encodeURIComponent(value)
  if (encoded !== value) forms.add(encoded)
  try {
    forms.add(Buffer.from(value, 'utf8').toString('base64'))
  } catch {
    // A value that cannot be encoded needs no extra form.
  }
  return [...forms]
}

export function createRedactor(): Redactor {
  return new RegistryRedactor()
}

/**
 * The process-wide registry.
 *
 * Deliberately a module singleton: the logger, the HTTP client and the audit
 * sink are constructed in different places and must all consult the same set of
 * values. Passing a redactor through every constructor was the alternative, and
 * the one place somebody forgot to pass it would be the leak.
 */
export const redactor: Redactor = createRedactor()

export function registerSecretValue(value: string): void {
  redactor.register(value)
}

export function redact(text: string): string {
  return redactor.redactString(text)
}

export function redactDeep<T>(value: T): T {
  return redactor.redactDeep(value)
}

export function redactError(err: unknown): Error {
  return redactor.redactError(err)
}
