/**
 * The setup wizard's layout: tagged lines, colour only at a real terminal.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { format, setColour, shouldUseColour, stepBanner } from '../../src/cli/commands/setup/ui.ts'

afterEach(() => setColour(false))

describe('the setup layout', () => {
  it('prints the same words without colour, indented as before', () => {
    setColour(false)
    expect(format('# Google Workspace')).toBe('\nGoogle Workspace')
    expect(format('~ a note')).toBe('  a note')
    expect(format('~ a second note')).toBe('  a second note')
    expect(format('! a warning')).toBe('  a warning')
    expect(format('+ it worked')).toBe('  it worked')
    expect(format('an ordinary line')).toBe('an ordinary line')
    expect(stepBanner(2, 7, 'Your organisation', 'what it does')).toBe('\n\n== Step 2 of 7 · Your organisation\n   what it does')
  })

  it('sets a note apart from what came before it, but keeps a run of notes together', () => {
    setColour(false)
    format('an ordinary line')
    expect(format('~ first note')).toBe('\n  first note')
    expect(format('~ second note')).toBe('  second note')
  })

  it('uses colour only for a person at a terminal who has not asked for none', () => {
    expect(shouldUseColour({ isTTY: true }, {})).toBe(true)
    expect(shouldUseColour({ isTTY: false }, {})).toBe(false)
    expect(shouldUseColour({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(shouldUseColour({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
    setColour(true)
    expect(format('# Heading')).toContain('\x1b[1m')
  })
})
