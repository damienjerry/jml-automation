/**
 * Your own wording for the messages, from a folder.
 *
 * A file named like a built-in template replaces it and nothing else changes.
 * Checked at start-up, because the alternatives are both bad: a placeholder
 * the message does not supply throws in the middle of a run, and a misspelt
 * file name silently changes nothing.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadTemplate, renderNotification, useTemplateOverrides } from '../../src/notify/fanout.ts'

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jml-templates-'))
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
  return dir
}

afterEach(() => {
  useTemplateOverrides(null)
})

describe('message templates from a folder', () => {
  it('uses your wording where you gave it, and the built-in everywhere else', async () => {
    const builtInIt = loadTemplate('day0-it')
    const dir = await folder({ 'joiner-welcome.md': 'Hi ${firstName}, sign in at ${identityConsoleUrl}.\n' })
    expect(useTemplateOverrides(dir)).toEqual([])
    expect(renderNotification('joiner-welcome', { firstName: 'Jane', identityConsoleUrl: 'https://accounts.google.com' })).toBe('Hi Jane, sign in at https://accounts.google.com.\n')
    expect(loadTemplate('day0-it')).toBe(builtInIt)
  })

  it('refuses a file that is not one of the messages, and uses none of the folder', async () => {
    const dir = await folder({ 'day0-manger.md': 'typo\n', 'joiner-welcome.md': 'Hi ${firstName}\n' })
    const problems = useTemplateOverrides(dir)
    expect(problems.join(' ')).toMatch(/day0-manger.md is not a message this toolkit sends/)
    expect(loadTemplate('joiner-welcome')).not.toBe('Hi ${firstName}\n')
  })

  it('refuses a placeholder the message does not supply, and names the ones it does', async () => {
    const dir = await folder({ 'joiner-welcome.md': 'Hi ${firstName}, your manager is ${managerName}\n' })
    const problems = useTemplateOverrides(dir)
    expect(problems.join(' ')).toMatch(/uses \$\{managerName\}, which this message does not supply/)
    expect(problems.join(' ')).toMatch(/\$\{firstName\}/)
  })

  it('reports a folder that cannot be read', () => {
    expect(useTemplateOverrides('/no/such/folder/for/this/test').join(' ')).toMatch(/could not be read/)
  })
})
