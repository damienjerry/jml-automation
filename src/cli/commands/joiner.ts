/**
 * `jml joiner`: the activation half of the lifecycle from the command line.
 *
 * dry-run and run mirror the leaver commands. approve opens the gate for one
 * person when `joiner.gate` is manual or ticket, and is also the only way to
 * clear a refusal: an account the engine found already in use stays refused
 * until a person says they have checked which account it is.
 */

import { runJoinerEngine, type JoinerDeps } from '../../engine/joiner/engine.ts'
import type { Actor, Person } from '../../core/types.ts'
import { renderRunReport } from './render.ts'
import { leaverDeps, markActor, renderPerson } from './leaver.ts'
import { CliError, openRuntime, type CliIo, type Runtime } from './context.ts'

export interface JoinerCommandOptions {
  configPath?: string
  action: 'run' | 'dry-run' | 'show' | 'approve'
  hrisId?: string
  email?: string
  actor?: string
  note?: string
  armed?: boolean
  resetRefusal?: boolean
  json?: boolean
}

export function joinerDeps(rt: Runtime): JoinerDeps {
  if (!rt.providers) throw new Error('the joiner engine needs the provider connectors')
  return { ...leaverDeps(rt), idp: rt.providers.activation, google: rt.providers.google }
}

export async function joinerCommand(io: CliIo, opts: JoinerCommandOptions): Promise<number> {
  const needsProviders = opts.action === 'run' || opts.action === 'dry-run'
  const rt = await openRuntime({ io, withProviders: needsProviders, ...(opts.configPath ? { configPath: opts.configPath } : {}) })
  try {
    if (opts.action === 'run' || opts.action === 'dry-run') {
      const only = opts.hrisId || opts.email ? { ...(opts.hrisId ? { hrisId: opts.hrisId } : {}), ...(opts.email ? { email: opts.email } : {}) } : undefined
      const report = await runJoinerEngine(joinerDeps(rt), {
        dryRun: opts.action === 'dry-run' || opts.armed !== true,
        actor: actorFor(opts),
        runId: 'cli-joiner-' + rt.clock.nowIso(),
        ...(only ? { only } : {}),
      })
      io.out(opts.json ? JSON.stringify(report, null, 2) + '\n' : renderRunReport(report) + '\n')
      return report.ok ? 0 : 1
    }

    const person = await resolvePerson(rt, opts)
    if (opts.action === 'show') {
      io.out(opts.json ? JSON.stringify(person, null, 2) + '\n' : renderPerson(person) + '\n' + renderActivation(person) + '\n')
      return 0
    }

    const actor = markActor(opts, io)
    const updated = await approve(rt, person, actor, opts)
    io.out(opts.json ? JSON.stringify(updated, null, 2) + '\n' : renderActivation(updated) + '\n')
    return 0
  } finally {
    await rt.close()
  }
}

async function approve(rt: Runtime, person: Person, actor: Actor, opts: JoinerCommandOptions): Promise<Person> {
  const now = rt.clock.nowIso()
  const activation = { ...(person.activation ?? {}) }
  const changes: string[] = []
  if (opts.resetRefusal) {
    if (!activation.refusedReason) throw new CliError('nothing to reset: this row carries no refusal', { exitCode: 65 })
    delete activation.refusedReason
    changes.push('refusal cleared')
  }
  if (rt.cfg.joiner.gate !== 'none' && !activation.gateOpenedAt) {
    activation.gateOpenedAt = now
    activation.gateOpenedBy = actor.id
    changes.push('gate opened')
  }
  if (changes.length === 0) {
    throw new CliError(
      rt.cfg.joiner.gate === 'none'
        ? 'joiner.gate is none, so there is no gate to open. Use --reset-refusal to clear a refusal.'
        : 'the gate is already open for this person',
      { exitCode: 65 },
    )
  }
  await rt.audit.append({
    at: now,
    runId: 'cli-joiner-approve-' + now,
    phase: 'outcome',
    actor,
    action: 'joiner.approve',
    subject: { kind: 'person', id: person.hrisId, label: person.displayName },
    dryRun: false,
    ok: true,
    verified: true,
    detail: { changes, ...(opts.note ? { note: opts.note } : {}) },
  })
  return rt.store.patch(person.hrisId, { activation })
}

async function resolvePerson(rt: Runtime, opts: JoinerCommandOptions): Promise<Person> {
  if (opts.hrisId) {
    const found = await rt.store.get(opts.hrisId)
    if (!found) throw new CliError(`no person with HR id ${opts.hrisId}`, { exitCode: 65 })
    return found
  }
  if (opts.email) {
    const matches = await rt.store.findByEmail(opts.email)
    if (matches.length === 1 && matches[0]) return matches[0]
    throw new CliError(matches.length === 0 ? `no person holds the address ${opts.email}` : `${matches.length} people hold ${opts.email}; name the HR id instead`, { exitCode: 65 })
  }
  throw new CliError('name the person with --hris-id or --email', { exitCode: 64 })
}

function actorFor(opts: JoinerCommandOptions): Actor {
  return opts.actor ? { kind: 'human', id: opts.actor } : { kind: 'system', id: 'system:cli' }
}

export function renderActivation(person: Person): string {
  const a = person.activation ?? {}
  const legs = Object.entries(a.legs ?? {}).map(([name, leg]) => `    ${name.padEnd(15)} ${leg?.state ?? 'pending'}${leg?.verified ? ' (verified)' : ''}${leg?.error ? ': ' + leg.error : ''}`)
  return [
    '  activation',
    '    activated at    ' + (a.activatedAt ?? 'not yet') + (a.activatedBy ? ' by ' + a.activatedBy : ''),
    '    forced reset    ' + (a.passwordResetForced ? 'yes' : 'no'),
    '    licence         ' + (a.licenceAssignedAt ?? 'not yet'),
    '    mailbox ready   ' + (a.mailboxReadyAt ?? 'not yet'),
    '    org unit moved  ' + (a.ouMovedAt ?? 'not yet'),
    '    welcome sent    ' + (a.welcomeSentAt ?? 'not yet'),
    '    gate            ' + (a.gateOpenedAt ? 'opened ' + a.gateOpenedAt + ' by ' + (a.gateOpenedBy ?? 'unknown') : 'not opened'),
    '    refused         ' + (a.refusedReason ?? 'no'),
    ...(legs.length ? ['    legs', ...legs] : []),
  ].join('\n')
}
