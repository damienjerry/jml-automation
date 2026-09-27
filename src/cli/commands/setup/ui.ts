/**
 * How the setup wizard's output looks.
 *
 * The wizard's lines carry a one-character tag saying what they are:
 *
 *   "# text"   a section heading
 *   "~ text"   a note that explains the question below it
 *   "! text"   a warning
 *   "+ text"   something that worked
 *
 * `format` turns a tagged line into what is printed. In colour, headings are
 * bold, notes are dimmed, warnings yellow and successes green, and each group
 * is set apart by a blank line, so the question a note belongs to is easy to
 * find. Without colour (a pipe, a log, CI, NO_COLOR, or a test) the same text is
 * printed, indented the same way, so nothing depends on the colour.
 */

let colour = false
let lastKind: 'heading' | 'note' | 'other' | 'question' = 'other'

/** Colour only for a person at a terminal that has not asked for none. */
export function shouldUseColour(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(stream.isTTY) && !env['NO_COLOR'] && env['TERM'] !== 'dumb'
}

export function setColour(on: boolean): void {
  colour = on
  lastKind = 'other'
}

const paint = (code: string) => (text: string): string => (colour ? `\x1b[${code}m${text}\x1b[0m` : text)
export const bold = paint('1')
export const dim = paint('2')
export const cyan = paint('36')
export const green = paint('32')
export const yellow = paint('33')

/** Turn one tagged line into printed text, without the trailing newline. */
export function format(line: string): string {
  const tag = line.slice(0, 2)
  const text = line.slice(2)
  if (tag === '# ') {
    lastKind = 'heading'
    return '\n' + bold(cyan(text))
  }
  if (tag === '~ ') {
    const gap = lastKind === 'note' || lastKind === 'heading' ? '' : '\n'
    lastKind = 'note'
    return gap + dim('  ' + text)
  }
  if (tag === '! ') {
    lastKind = 'other'
    return yellow('  ' + text)
  }
  if (tag === '+ ') {
    lastKind = 'other'
    return green('  ' + text)
  }
  lastKind = 'other'
  return line
}

/** The banner at the start of each step. */
export function stepBanner(index: number, total: number, title: string, plan: string): string {
  lastKind = 'heading'
  const head = `Step ${index} of ${total} · ${title}`
  return '\n\n' + (colour ? bold(cyan('━━ ' + head + ' ━━')) : '== ' + head) + '\n' + dim('   ' + plan)
}

/**
 * Called by the prompter before it asks. A question straight after its note or
 * a heading stays with it; any other question gets a blank line above it, so
 * questions never run together.
 */
export function beforeQuestion(): string {
  const gap = lastKind === 'note' || lastKind === 'heading' ? '' : '\n'
  lastKind = 'question'
  return gap
}
