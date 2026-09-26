import { describe, expect, it } from 'vitest'
import { deletionPlan } from '../../src/engine/leaver/notify.ts'
import { leaverConfig } from '../fixtures/leaver/harness.ts'
import {
  loadTemplate,
  placeholdersIn,
  renderNotification,
  renderTemplate,
  TEMPLATE_NAMES,
  TemplateError,
} from '../../src/notify/fanout.ts'

/** Anything that would make a template a small programming language. */
const TEMPLATE_LANGUAGE = [/\{\{/, /\{%/, /<%/, /\$\{[^}]*[.[(]/]

describe('the notification templates', () => {
  it('ships one file per named template', () => {
    for (const name of TEMPLATE_NAMES) {
      expect(loadTemplate(name).length, name).toBeGreaterThan(50)
    }
  })

  it('uses plain ${name} substitution and nothing else', () => {
    for (const name of TEMPLATE_NAMES) {
      const text = loadTemplate(name)
      for (const pattern of TEMPLATE_LANGUAGE) {
        expect(pattern.test(text), `${name} contains ${String(pattern)}`).toBe(false)
      }
    }
  })

  it('carries no address, hostname or identifier of its own', () => {
    for (const name of TEMPLATE_NAMES) {
      const text = loadTemplate(name)
      // Every value comes from the engine at render time, which is what keeps
      // one organisation's identifiers out of a published file.
      expect(text, name).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      expect(text, name).not.toMatch(/\bhttps?:\/\//)
    }
  })

  it('renders every placeholder it declares', () => {
    for (const name of TEMPLATE_NAMES) {
      const values = Object.fromEntries(
        placeholdersIn(loadTemplate(name)).map((p) => [p, `value-for-${p}`]),
      )
      const rendered = renderNotification(name, values)
      expect(rendered, name).not.toMatch(/\$\{/)
    }
  })

  it('refuses to render a note with a placeholder left unresolved', () => {
    expect(() => renderTemplate('deleted on ${deleteOn}', {})).toThrow(TemplateError)
    // An empty string counts as missing: a manager note reading "deleted on"
    // with no date is worse than an error nobody can ignore.
    expect(() => renderTemplate('deleted on ${deleteOn}', { deleteOn: '' })).toThrow(/deleteOn/)
  })

  it('tells the day-0 manager what was done, when the files arrive and when deletion happens', () => {
    const text = loadTemplate('day0-manager')
    expect(placeholdersIn(text)).toEqual(
      expect.arrayContaining([
        'personName',
        'actionsTaken',
        'suspendedOn',
        'transferOn',
        'deletionPlan',
        'itTeamSignature',
      ]),
    )
    expect(text).toMatch(/transferred to you/)
  })

  it('tells the manager the deletion date, or that the accounts are kept, by the policy in force', () => {
    const automatic = deletionPlan(leaverConfig(), '2026-03-10', 'manager')
    expect(automatic).toMatch(/On 2026-03-10 their accounts are deleted permanently/)
    const kept = deletionPlan(leaverConfig({ leaver: { deletion: 'never' } }), '2026-03-10', 'manager')
    expect(kept).toMatch(/kept, not deleted/)
    expect(kept).not.toMatch(/2026-03-10|deleted permanently/)
    expect(deletionPlan(leaverConfig({ leaver: { deletion: 'never' } }), '2026-03-10', 'ticket')).not.toMatch(/2026-03-10/)
  })

  it('explains in the blocked note that silence means the same blockage', () => {
    expect(loadTemplate('blocked')).toMatch(/Silence therefore means the same blockage/)
  })

  it('states in the aborted note that nothing was changed', () => {
    expect(loadTemplate('run-aborted')).toMatch(/nothing was changed/)
  })
})
