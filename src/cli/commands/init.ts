/**
 * `jml init` and `jml generate`.
 *
 * Init writes the two files an adopter edits and nothing else. It never writes
 * a credential into the configuration file: every secret field holds a
 * reference, and the values go in `.env`, which is gitignored. That split is
 * the whole reason a leaked configuration file is not an incident.
 *
 * Two values it does generate, both random and both written only to `.env`.
 * The sidecar's bearer token, because a token somebody chooses by hand is a
 * token somebody can guess and this service can delete accounts. And the
 * audit hash salt, because the audit log stores addresses as a salted hash and
 * an unsalted hash of an address is reversible by guessing a name. Neither is
 * rotated by a later `jml init`, which would break a running container in a
 * way that looks like an authentication bug rather than a rotation.
 *
 * The salt is why this command edits the configuration file at all. The schema
 * requires a salt whenever PII minimisation is on, minimisation is on by
 * default, and the generated default carries no salt because "not configured"
 * is a legitimate state for anyone who turns minimisation off. Written
 * verbatim, that default produced a configuration that could not load, so the
 * very first command after `jml init` failed on a fresh install before
 * anybody had typed a credential. So init points the field at the reference
 * and puts the generated value in `.env`, which is the same split it uses for
 * the token: the configuration names the credential, the environment holds it.
 */

import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateArtefacts, writeArtefacts } from '../../config/generate.ts'
import { CliError, type CliIo } from './context.ts'

export const CONFIG_FILE = 'jml.config.yaml'
export const ENV_FILE = '.env'
/** 32 bytes, hex encoded. The sidecar refuses anything shorter. */
const TOKEN_BYTES = 32
/** 32 bytes, hex encoded. Wide enough that the hash cannot be attacked by guessing names. */
const SALT_BYTES = 32

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/**
 * Set one key in the generated `.env`, and fail loudly if the key is not there.
 *
 * A silent no-op here is the dangerous outcome: the file would ship with an
 * empty token, the sidecar would refuse every request, and the cause would
 * look like a credential problem rather than a missing line in a template.
 */
function fill(env: string, name: string, generated: string): string {
  const pattern = new RegExp('^' + name + '=.*$', 'm')
  if (!pattern.test(env)) {
    throw new CliError('the generated .env has no ' + name + ' line, which is a defect in this build', { exitCode: 70 })
  }
  // A function replacer, so a `$` sequence in the generated value is never
  // read as a replacement pattern and silently mangled.
  return env.replace(pattern, () => name + '=' + generated)
}

/**
 * Point audit.salt at the environment reference rather than leaving it unset.
 *
 * The schema demands a salt while minimisePii is true, and the generated
 * default is null, so this one line is the difference between a configuration
 * that loads and one that is refused. Failing loudly when the line is absent
 * matters more than it looks: silently writing the unmodified default hands
 * somebody a broken install and an error message about credentials.
 */
function referenceAuditSalt(config: string): string {
  const pattern = /^(\s*)salt:\s*null\s*$/m
  if (!pattern.test(config)) {
    throw new CliError('the generated configuration has no audit salt line, which is a defect in this build', {
      exitCode: 70,
    })
  }
  return config.replace(pattern, (_match, indent: string) => indent + 'salt: env:JML_AUDIT_SALT')
}

function artefact(name: string): string {
  const found = generateArtefacts().find((entry) => entry.path === name)
  if (!found) throw new CliError(`the generator produced no ${name}, which is a defect in this build`, { exitCode: 70 })
  return found.content
}

export async function initCommand(io: CliIo, opts: { dir?: string; force?: boolean }): Promise<number> {
  const dir = opts.dir ?? io.cwd
  const configPath = join(dir, CONFIG_FILE)
  const envPath = join(dir, ENV_FILE)

  const configExists = await exists(configPath)
  const envExists = await exists(envPath)
  if ((configExists || envExists) && !opts.force) {
    io.err(
      `${configExists ? CONFIG_FILE : ENV_FILE} already exists. ` +
        `Nothing was written; pass --force to overwrite, which discards whatever you have configured.\n`,
    )
    return 2
  }

  await writeFile(
    configPath,
    '# Written by `jml init`. Every secret field holds a REFERENCE (env:NAME, file:/path\n' +
      '# or op://vault/item/field), never a value, so this file is safe to commit.\n' +
      referenceAuditSalt(artefact('jml.config.example.yaml')),
    'utf8',
  )

  // Both values are generated once and kept. Rotating either on every init
  // would silently break a sidecar already running with the old token, and
  // change the salt so that yesterday's audit rows no longer hash to the same
  // value as today's, which is what makes an audit log searchable at all.
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const envContent = fill(fill(artefact('.env.example'), 'JML_API_TOKEN', token), 'JML_AUDIT_SALT', salt)
  await writeFile(envPath, envContent, { encoding: 'utf8', mode: 0o600 })

  io.out(
    [
      '',
      'wrote ' + CONFIG_FILE + '  (edit this: org, domains, timezone, headcount floor)',
      'wrote ' + ENV_FILE + '        (mode 600; fill in the credentials. A random sidecar token and',
      '                   audit salt are already set)',
      '',
      'The generated files carry every key with its default and its documentation.',
      'Nothing is armed: mode is dry-run and armedActions is empty, so a first run',
      'plans and reports without touching a provider.',
      '',
      'Next:',
      '  jml demo                 watch the whole lifecycle with no credentials at all',
      '  jml store bootstrap      import your HR history as tombstones BEFORE arming anything',
      '  jml doctor               prove every credential and per-scope authorisation',
      '',
    ].join('\n') + '\n',
  )
  return 0
}

export async function generateCommand(io: CliIo, opts: { dir?: string }): Promise<number> {
  const written = await writeArtefacts(opts.dir ?? io.cwd)
  io.out('generated ' + written.length + ' artefacts:\n' + written.map((path) => '  ' + path).join('\n') + '\n')
  return 0
}
