/**
 * Routing a notification to the people it is for, and rendering its body.
 *
 * Two audiences, and they are not interchangeable. An IT note is an operational
 * record and belongs wherever the team already looks. A manager note is a
 * message to one person about somebody who worked for them, and it belongs in
 * their mail, addressed to them.
 *
 * The routing rules are all about the same failure: a notification that goes
 * nowhere. A manager note with no resolvable address is still sent, to the IT
 * route, so the information is not lost, and it is reported as UNDELIVERED,
 * because the person it was for was not told and that is a data problem
 * somebody has to fix. An audience with no notifier configured behaves the same
 * way. A partial delivery across a route counts as undelivered too: a run that
 * looks fine while one channel is silently broken is the exact condition this
 * toolkit exists to stop.
 *
 * Deduplication is deliberately NOT here. The engine decides whether a standing
 * problem is news, because only the engine knows the set of people and devices
 * a notice is about. A notifier that deduplicated on its own would suppress
 * things the engine had already decided were worth saying.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Notification, NotificationResult, Notifier } from './types.ts'

export interface FanoutNotifierOptions {
  /** Notifiers for the IT audience. All must deliver for a notification to be delivered. */
  it: readonly Notifier[]
  /** Notifiers for the manager audience. Usually mail alone. */
  manager: readonly Notifier[]
}

export class FanoutNotifier implements Notifier {
  readonly name = 'fanout'
  private readonly routes: { it: readonly Notifier[]; manager: readonly Notifier[] }

  constructor(options: FanoutNotifierOptions) {
    this.routes = { it: options.it, manager: options.manager }
  }

  async send(n: Notification): Promise<NotificationResult> {
    let route = n.audience === 'manager' ? this.routes.manager : this.routes.it
    let undeliverable: string | null = null

    if (n.audience === 'manager' && !n.managerEmail?.trim()) {
      route = this.routes.it
      undeliverable = 'no manager address was resolved, so this went to the IT route instead'
    } else if (route.length === 0) {
      route = this.routes.it
      undeliverable = `no notifier is configured for the ${n.audience} audience, so this went to the IT route instead`
    }

    if (route.length === 0) {
      return {
        delivered: false,
        channel: 'fanout',
        error: 'no notifier is configured at all, so this notification was not sent anywhere',
      }
    }

    const results: NotificationResult[] = []
    for (const notifier of route) {
      try {
        results.push(await notifier.send(n))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push({ delivered: false, channel: notifier.name, error: `threw: ${message}` })
      }
    }

    const failed = results.filter((r) => !r.delivered)
    const channels = results.map((r) => r.channel).join(', ')
    const reasons = failed.map((r) => `${r.channel}: ${r.error ?? 'no reason given'}`)
    if (undeliverable) reasons.unshift(undeliverable)
    if (reasons.length > 0) {
      return { delivered: false, channel: channels, error: reasons.join('; ') }
    }
    return { delivered: true, channel: channels }
  }

  async testConnection(): Promise<{ ok: boolean; detail: string; remediation?: string }> {
    const seen = new Map<string, Notifier>()
    for (const notifier of [...this.routes.it, ...this.routes.manager]) {
      seen.set(notifier.name, notifier)
    }
    if (seen.size === 0) {
      return {
        ok: false,
        detail: 'no notifier is configured',
        remediation: 'the console notifier needs no credential and is the safe default',
      }
    }
    const details: string[] = []
    let ok = true
    for (const [name, notifier] of seen) {
      const check = await notifier.testConnection()
      if (!check.ok) ok = false
      details.push(`${name}: ${check.detail}`)
    }
    return { ok, detail: details.join(' | ') }
  }
}

export function createFanoutNotifier(options: FanoutNotifierOptions): FanoutNotifier {
  return new FanoutNotifier(options)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * The notification bodies live beside this file as Markdown with `${name}`
 * placeholders and nothing else: no conditionals, no loops, no expressions. An
 * adopter will edit these, and a template language is a way for an edit to
 * throw at three in the morning. Anything that needs a decision is decided in
 * the engine and passed in as a rendered string.
 */
export const TEMPLATE_NAMES = [
  'day0-manager',
  'day0-it',
  'day6',
  'day7',
  'blocked',
  'parked',
  'run-summary',
  'run-aborted',
  'device-report',
] as const

export type TemplateName = (typeof TEMPLATE_NAMES)[number]

const PLACEHOLDER = /\$\{([A-Za-z][A-Za-z0-9_]*)\}/g
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates')
const cache = new Map<TemplateName, string>()

export class TemplateError extends Error {
  readonly code = 'template_error'
}

/** Read a template from disk, once per process. */
export function loadTemplate(name: TemplateName): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  let text: string
  try {
    text = readFileSync(join(TEMPLATE_DIR, `${name}.md`), 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new TemplateError(`could not read the ${name} template: ${message}`)
  }
  cache.set(name, text)
  return text
}

/** Every placeholder a template expects, in first-appearance order. */
export function placeholdersIn(template: string): string[] {
  const names: string[] = []
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * Substitute values into a template.
 *
 * A placeholder with no value throws. A rendered note that still reads
 * `${deleteOn}` is worse than an error, because it reaches a manager looking
 * like a working message with the important date missing.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  const missing: string[] = []
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name]
    if (value === undefined || value === null || value === '') {
      missing.push(name)
      return ''
    }
    return String(value)
  })
  if (missing.length > 0) {
    throw new TemplateError(`no value supplied for: ${[...new Set(missing)].join(', ')}`)
  }
  return rendered
}

/** Load and render in one step. */
export function renderNotification(
  name: TemplateName,
  values: Readonly<Record<string, string | number>>,
): string {
  return renderTemplate(loadTemplate(name), values)
}
