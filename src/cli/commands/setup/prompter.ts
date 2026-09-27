/**
 * How `jml setup` asks questions.
 *
 * An interface so the wizard is tested with a script of answers rather than a
 * terminal, and so nothing in the wizard can print what was typed into a
 * secret prompt: the terminal implementation mutes the echo, and the value
 * goes straight back to the caller, which writes it to `.env` and nowhere else.
 */

import { createInterface } from 'node:readline'
import { beforeQuestion, bold, cyan, dim, yellow } from './ui.ts'
import { Writable } from 'node:stream'

export interface Prompter {
  /** Free text. An empty answer takes the default when there is one. */
  ask(question: string, opts?: { default?: string; validate?: (answer: string) => string | null }): Promise<string>
  /** Typed without echo. Never has a default, and is never printed. */
  secret(question: string): Promise<string>
  choose<T extends string>(question: string, options: readonly { value: T; label: string }[], defaultValue?: T): Promise<T>
  confirm(question: string, defaultValue?: boolean): Promise<boolean>
  close(): void
}

export function terminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  let muted = false
  const sink = new Writable({
    write(chunk, _enc, done) {
      if (!muted) output.write(chunk)
      done()
    },
  })
  const rl = createInterface({ input, output: sink, terminal: true })
  const line = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())))

  const prompter: Prompter = {
    async ask(question, opts = {}) {
      output.write(beforeQuestion())
      for (;;) {
        const suffix = opts.default !== undefined && opts.default !== '' ? ' ' + dim('(Enter for ') + cyan(opts.default) + dim(')') : ''
        const answer = (await line(`${bold(question)}${suffix}: `)) || opts.default || ''
        const problem = opts.validate?.(answer) ?? null
        if (!problem) return answer
        output.write(yellow(`  That is not right: ${problem}. Try again.`) + '\n')
      }
    },
    async secret(question) {
      output.write(beforeQuestion())
      output.write(`${bold(question)} ${dim('(hidden as you type)')}: `)
      muted = true
      try {
        return await line('')
      } finally {
        muted = false
        output.write('\n')
      }
    },
    async choose(question, options, defaultValue) {
      output.write(beforeQuestion())
      output.write(`${bold(question)}\n`)
      const defaultIndex = options.findIndex((o) => o.value === defaultValue)
      options.forEach((o, i) => output.write(`  ${cyan(String(i + 1))}  ${o.label}\n`))
      const hint = defaultIndex >= 0 ? `Type a number from 1 to ${options.length}, or press Enter for ${defaultIndex + 1}` : `Type a number from 1 to ${options.length}`
      for (;;) {
        const answer = await line(`  ${dim(hint)}: `)
        if (!answer && defaultValue !== undefined) return defaultValue
        const picked = options[Number(answer) - 1]
        if (picked) return picked.value
        output.write(yellow(`  Type a number from 1 to ${options.length}.`) + '\n')
      }
    },
    async confirm(question, defaultValue = false) {
      output.write(beforeQuestion())
      for (;;) {
        const answer = (await line(`${bold(question)} ${dim(`(y or n, Enter for ${defaultValue ? 'yes' : 'no'})`)}: `)).toLowerCase()
        if (!answer) return defaultValue
        if (answer === 'y' || answer === 'yes') return true
        if (answer === 'n' || answer === 'no') return false
        output.write(yellow('  Type y for yes or n for no.') + '\n')
      }
    },
    close() {
      rl.close()
    },
  }
  return prompter
}

/** A prompter that answers from a list, for tests and for `--answers`. Fails loudly when it runs out. */
export function scriptedPrompter(answers: readonly string[], transcript: string[] = []): Prompter {
  const queue = [...answers]
  const next = (question: string): string => {
    if (queue.length === 0) throw new Error(`scripted prompter ran out of answers at: ${question}`)
    const answer = queue.shift() as string
    transcript.push(`${question} -> ${answer}`)
    return answer
  }
  return {
    async ask(question, opts = {}) {
      const answer = next(question) || opts.default || ''
      const problem = opts.validate?.(answer) ?? null
      if (problem) throw new Error(`scripted answer "${answer}" to "${question}" was refused: ${problem}`)
      return answer
    },
    async secret(question) {
      const value = next(question)
      transcript[transcript.length - 1] = `${question} -> <hidden>`
      return value
    },
    async choose(question, options, defaultValue) {
      const answer = next(question)
      if (!answer && defaultValue !== undefined) return defaultValue
      const picked = options.find((o) => o.value === answer) ?? options[Number(answer) - 1]
      if (!picked) throw new Error(`scripted answer "${answer}" is not an option for "${question}"`)
      return picked.value
    },
    async confirm(question, defaultValue = false) {
      const answer = next(question).toLowerCase()
      return answer ? answer === 'y' || answer === 'yes' : defaultValue
    },
    close() {},
  }
}
