/**
 * `jml n8n scrub | import`.
 *
 * The workflow bundle is a set of hand-authored JSON files, and an export
 * taken back out of a running automation tool carries things that must never
 * be committed: credential ids, node uuids, and static data holding the real
 * people the workflow last ran against. Scrubbing is therefore part of the
 * contribution path rather than an afterthought.
 *
 * Both actions run the scripts that ship beside the workflows rather than
 * reimplementing them here. There is exactly one definition of what a clean
 * export looks like, and it is the one the continuous integration job runs; a
 * second copy inside the CLI would drift from it and start passing files the
 * build rejects.
 */

import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError, type CliIo } from './context.ts'

/** The scripts this command drives, relative to the repository root. */
export const N8N_SCRIPTS: Record<'scrub' | 'import' | 'validate', string> = {
  scrub: join('n8n', 'scrub-export.mjs'),
  import: join('n8n', 'import.mjs'),
  validate: join('n8n', 'validate.mjs'),
}

export interface N8nCommandOptions {
  action: 'scrub' | 'import'
  /** Everything after the subcommand, passed through untouched. */
  rest: readonly string[]
  dir?: string
}

export async function n8nCommand(io: CliIo, opts: N8nCommandOptions): Promise<number> {
  const root = opts.dir ?? io.cwd
  const script = join(root, N8N_SCRIPTS[opts.action])
  try {
    await access(script, constants.R_OK)
  } catch {
    // Two different causes, and the operator cannot tell them apart from
    // here: they are running from an installed package rather than a clone,
    // or this release does not ship that script at all.
    throw new CliError(
      'cannot find ' +
        N8N_SCRIPTS[opts.action] +
        '. These scripts live in the repository rather than in the installed package, so run this from a ' +
        'clone. If the file is not in your checkout either, this release does not ship it and the workflow ' +
        'bundle documents doing that step by hand.',
      { exitCode: 2, docsAnchor: 'n8n/README.md' },
    )
  }
  return runNode(io, script, opts.rest)
}

/**
 * Run a script and pass its exit code straight through.
 *
 * `stdio: inherit` on purpose: the validator's output is what the operator
 * needs to read, and buffering it here would mean losing it if this process
 * were interrupted.
 */
function runNode(io: CliIo, script: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', cwd: io.cwd })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 70))
  })
}
