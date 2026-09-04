/**
 * `jml demo`: the whole lifecycle, offline, in about a minute.
 *
 * This is the first thing a stranger should run. It needs no credential, no
 * network and no database file: a JSON file stands in for the HR system, the
 * people store is in memory, and the providers are the shipped fakes. The
 * clock is pinned to the date the fixture is written around, then moved
 * forward, so the day-0, hand-over and deletion phases can all be watched in
 * one sitting rather than over a week.
 *
 * It is deliberately armed. Running the demo in dry-run mode would show the
 * plan and never the state machine, and the state machine is the thing worth
 * seeing: a row moves from terminated to offboarding only when a suspension
 * was read back, and a bound laptop refuses the deletion until the machine is
 * accounted for. Nothing leaves the process, so armed here costs nothing.
 *
 * The output is asserted by a snapshot test. If a change to the engine alters
 * what an adopter sees, that test fails, which is the point: this output is a
 * promise about behaviour, not a log.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuditEvent, AuditRef, AuditSink } from '../audit/types.ts'
import { loadConfig } from '../config/load.ts'
import { addDays, FakeClock } from '../core/clock.ts'
import { createDomainMap } from '../core/domain.ts'
import { nullLogger } from '../core/logger.ts'
import type { RunReport } from '../core/types.ts'
import { createFakeProviders, type FakeProvidersSeed } from '../connectors/fake.ts'
import { runPipeline, type PipelineDeps } from '../engine/pipeline.ts'
import { FixtureHrisAdapter, readFixtureFile, type HrisFixtureFile } from '../hris/fixture.ts'
import { HrisIncomplete, type HrisAdapter } from '../hris/types.ts'
import { createConsoleNotifier } from '../notify/console.ts'
import { createFanoutNotifier } from '../notify/fanout.ts'
import { MemoryPeopleStore } from '../store/memory/store.ts'
import { SqliteStateStore } from '../store/state-sqlite.ts'
import { CliError } from './commands/context.ts'
import { describePerson, renderRunReport } from './commands/render.ts'

/**
 * The HR fixture the demo reads, resolved against this module rather than the
 * working directory.
 *
 * It used to be a path relative to the repository root, which worked in the
 * test runner and nowhere else: `jml demo` from any other directory failed,
 * and a published install failed always, because the file lived under test/
 * and was never packaged. The demo is the first thing `jml init` tells a
 * newcomer to run and the only way to watch the state machine without
 * credentials, so it has to work from an installed copy.
 */
export const DEMO_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'demo.json')

/**
 * What the demo prints instead of the resolved path.
 *
 * The resolved path contains the install directory, which differs per machine
 * and would make the demo's own output unassertable.
 */
export const DEMO_FIXTURE_LABEL = 'the shipped demo fixture'

/** Wall-clock time of day the demo starts, so every printed stamp is stable. */
const DEMO_TIME = 'T09:00:00.000Z'

export interface DemoOptions {
  fixturePath?: string
  /** Defaults to stdout. A test passes a collector and asserts the whole run. */
  write?: (text: string) => void
}

export interface DemoResult {
  ok: boolean
  reports: RunReport[]
  output: string
}

/**
 * Every audit row, in memory.
 *
 * The demo writes no files, so it cannot use the shipped JSONL sink. The
 * counts it prints still make the two-row contract visible: an intent row
 * before every provider call and an outcome row after it.
 */
class DemoAuditSink implements AuditSink {
  readonly name = 'demo'
  readonly events: AuditEvent[] = []
  private seq = 0

  async append(event: AuditEvent): Promise<AuditRef> {
    this.events.push(event)
    this.seq += 1
    return { seq: this.seq }
  }
}

export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  const lines: string[] = []
  const collect = (text: string): void => {
    lines.push(text)
  }
  const write = opts.write ?? ((text: string) => process.stdout.write(text))
  const say = (text = ''): void => {
    collect(text + '\n')
    write(text + '\n')
  }
  const path = opts.fixturePath ?? DEMO_FIXTURE

  const fixture = await readDemoFixture(path)
  const demoToday = fixture.demoToday
  if (!demoToday) {
    // Without a pinned date the leaving dates in the file mean nothing: the
    // day-0 person would be months in the past and the demo would show a
    // parked row and no lifecycle at all.
    throw new CliError(
      `${path} has no demoToday, so there is no date to pin the clock to. ` +
        `Add demoToday (the date the file is written around) and run this again.`,
      { exitCode: 78, docsAnchor: 'docs/adapters/hris-fixture.md' },
    )
  }

  const clock = new FakeClock(demoToday + DEMO_TIME)
  const audit = new DemoAuditSink()
  const store = new MemoryPeopleStore({ clock })
  await store.init()
  const state = new SqliteStateStore({ path: ':memory:', clock })
  await state.init()

  const loaded = await loadConfig({
    document: demoConfigDocument(path, fixture),
    env: {},
    // Nothing here talks to a provider, so there is no credential to resolve.
    // The references are still parsed, so the demo config is the same shape an
    // adopter will write.
    allowMissingSecrets: true,
  })
  const cfg = loaded.config

  const owner = deviceOwner(fixture, demoToday, cfg.leaver.terminationLookbackDays)
  const providers = createFakeProviders(seedFrom(fixture, owner))
  // Both audiences print to the console here, so the note a leaver's manager
  // would receive is visible as well as the operational one. In a real
  // deployment the manager route is mail: a message to one person about
  // somebody who worked for them does not belong in a team channel.
  const printer = createConsoleNotifier({
    write: (text) => {
      collect(text)
      write(text)
    },
    full: false,
  })
  const notifier = createFanoutNotifier({ it: [printer], manager: [printer] })

  // The first step runs against a snapshot in which nobody has left yet, and
  // every later step against the file as written. That sequence is not window
  // dressing: the sync REFUSES to create a row whose derived status is already
  // terminated, because a first run against a full HR history would otherwise
  // create every historic leaver and offboard them. So a person has to be
  // known while they are employed for their departure to be an event at all.
  const nobodyHasLeftYet = { value: true }
  const fixtureAdapter = new FixtureHrisAdapter({ path, minPlausibleHeadcount: cfg.hris.minPlausibleHeadcount })
  const hris: HrisAdapter = {
    name: fixtureAdapter.name,
    testConnection: () => fixtureAdapter.testConnection(),
    fetchAll: async () => {
      const snapshot = await fixtureAdapter.fetchAll()
      if (!nobodyHasLeftYet.value) return snapshot
      return { ...snapshot, activeIds: new Set(snapshot.all.map((person) => person.hrisId)) }
    },
  }

  const deps: PipelineDeps = {
    cfg,
    hris,
    store,
    state,
    idp: providers.identity,
    devices: providers.devices,
    google: providers.google,
    notifier,
    audit,
    clock,
    logger: nullLogger(),
    domain: createDomainMap({ primaryDomain: cfg.org.primaryDomain, aliasDomains: cfg.org.aliasDomains }),
    // The hand-over poll and the device quiet window are the two places this
    // toolkit waits. A demo that really waited would teach nobody anything.
    sleep: async () => undefined,
  }

  header(say, fixture, path, demoToday, owner)

  const reports: RunReport[] = []
  const step = async (title: string, note: string, date: string, runId: string): Promise<RunReport> => {
    clock.set(date + DEMO_TIME)
    say('')
    say('=== ' + title + '  (' + date + ') ===')
    say(note)
    say('')
    const before = audit.events.length
    const report = await runPipeline(deps, {
      dryRun: false,
      actor: { kind: 'system', id: 'system:demo' },
      runId,
    })
    reports.push(report)
    say(renderRunReport(report))
    say('audit rows written this step: ' + (audit.events.length - before))
    say('')
    say(await renderStore(store))
    return report
  }

  await step(
    'The day before anybody left',
    'The HR system says everybody is employed. The sync creates a row for each of them,\n' +
      'and derives hired rather than active for anybody whose start date is still ahead.\n' +
      'Nothing else happens: there is nobody to offboard.',
    addDays(demoToday, -1),
    'demo-before',
  )

  nobodyHasLeftYet.value = false

  await step(
    'Day 0',
    'The HR read, the sync, the detector and the leaver engine, in one run and in that order.\n' +
      'Anybody whose leaving date has passed is suspended, told to their manager, and marked.',
    demoToday,
    'demo-day0',
  )

  await step(
    'The hand-over day',
    'Nothing new has left. The people suspended on day 0 have reached the hand-over day,\n' +
      'so their files go to their manager and their mailbox is suspended.',
    addDays(demoToday, cfg.leaver.transferDay),
    'demo-transfer',
  )

  await step(
    'The deletion day',
    'Accounts are deleted, but only where the gate opens: a confirmed hand-over, no laptop\n' +
      'still bound to the person, and no identity a live colleague claims.',
    addDays(demoToday, cfg.leaver.deleteDay),
    'demo-delete',
  )

  say('')
  say('=== The laptop comes back ===')
  say(
    'One deletion was refused because a machine is still bound to the leaver. In a real\n' +
      'estate this is where `jml device dispose --disposition return_to_pool` runs, which\n' +
      'unbinds the machine only after an uninstall receipt. The demo unbinds it directly:\n' +
      'the fake providers have no command channel to fire a script down.',
  )
  if (owner) {
    const unbound = await providers.devices.unbindUser(idpIdFor(owner.hrisId), DEMO_DEVICE_ID)
    say('')
    say('unbind ' + DEMO_DEVICE_ID + ' from ' + owner.displayName + ': ok=' + unbound.ok + ' verified=' + unbound.verified)
  }

  await step(
    'The deletion day, again',
    'Same day, same run, nothing else changed. The gate reads the provider live rather than\n' +
      'trusting what it recorded last time, so the deletion now proceeds.',
    addDays(demoToday, cfg.leaver.deleteDay),
    'demo-delete-2',
  )

  const ok = reports.every((report) => report.ok)
  say('')
  say(ok ? 'The demo finished with every run ok.' : 'The demo finished with at least one run not ok.')
  say('Nothing left this process: no network call, no credential, no file written.')
  say('')

  await state.close()
  await store.close()
  return { ok, reports, output: lines.join('') }
}

async function readDemoFixture(path: string): Promise<HrisFixtureFile> {
  try {
    return await readFixtureFile(path)
  } catch (err) {
    if (err instanceof HrisIncomplete) {
      throw new CliError(err.message + ' The demo needs a readable fixture; pass --fixture to point at one.', {
        exitCode: 78,
        docsAnchor: 'docs/adapters/hris-fixture.md',
      })
    }
    throw err
  }
}

/**
 * The demo's configuration, built as a document and parsed by the real schema.
 *
 * Written out in full rather than assembled from defaults, because an adopter
 * reading this file is reading the smallest configuration that works.
 */
function demoConfigDocument(fixturePath: string, fixture: HrisFixtureFile): Record<string, unknown> {
  return {
    version: 1,
    org: {
      name: 'Example Organisation',
      primaryDomain: 'example.com',
      timezone: 'Europe/London',
      itTeamSignature: 'The IT team',
    },
    mode: 'armed',
    armedActions: ['suspend', 'autoreply', 'licence', 'transfer', 'google_suspend', 'delete'],
    mail: { senderMailbox: 'it-noreply@example.com', managerOnDay0: true },
    hris: {
      adapter: 'fixture',
      // The floor is checked against the employed set as well as the whole
      // file, so it has to sit at or below the number of people the fixture
      // says are employed or the demo refuses its own snapshot.
      minPlausibleHeadcount: Math.max(1, Math.min(3, fixture.activeIds.length)),
      fixture: { path: fixturePath },
    },
    store: { adapter: 'memory' },
    identity: { jumpcloud: { apiKey: 'env:JUMPCLOUD_API_KEY' } },
    google: { serviceAccountJson: 'env:GOOGLE_SERVICE_ACCOUNT_JSON', adminEmail: 'admin@example.com' },
    notify: { adapters: ['console'] },
    // A salted hash would make the demo's own audit counts unreadable, and
    // nothing here is a real address.
    audit: { minimisePii: false },
    server: { token: 'env:JML_API_TOKEN' },
  }
}

export const DEMO_DEVICE_ID = 'sys-demo-laptop'

function idpIdFor(hrisId: string): string {
  return 'idp-' + hrisId
}

/**
 * Which leaver holds the laptop.
 *
 * The one with the most recent leaving date inside the lookback window, so the
 * demo always has a bound device on somebody who really reaches the deletion
 * day. Choosing by position in the file would silently pick a historic leaver
 * who is parked and never gets there.
 */
function deviceOwner(fixture: HrisFixtureFile, today: string, lookbackDays: number): HrisFixtureFile['people'][number] | null {
  const employed = new Set(fixture.activeIds)
  const cutoff = addDays(today, -lookbackDays)
  const candidates = fixture.people
    .filter((person) => !employed.has(person.hrisId))
    .filter((person) => person.primaryEmail.trim() !== '')
    .filter((person) => typeof person.terminationDate === 'string' && person.terminationDate >= cutoff)
    .sort((a, b) => {
      const left = a.terminationDate ?? ''
      const right = b.terminationDate ?? ''
      return left === right ? a.hrisId.localeCompare(b.hrisId) : right.localeCompare(left)
    })
  return candidates[0] ?? null
}

/**
 * Accounts for everybody the fixture gives an address to.
 *
 * Including the people who have not left: the hand-over needs a manager with a
 * live mailbox to put the files in, and a demo where the transfer fails for
 * want of a recipient teaches the wrong lesson.
 */
function seedFrom(fixture: HrisFixtureFile, owner: HrisFixtureFile['people'][number] | null): FakeProvidersSeed {
  const withMailbox = fixture.people.filter((person) => person.primaryEmail.trim() !== '')
  return {
    idp: withMailbox.map((person) => ({
      id: idpIdFor(person.hrisId),
      email: person.primaryEmail,
      displayName: person.displayName,
      devices: owner && person.hrisId === owner.hrisId ? [DEMO_DEVICE_ID] : [],
    })),
    google: withMailbox.map((person) => ({
      id: 'goog-' + person.hrisId,
      email: person.primaryEmail,
      licences: [{ productId: 'Example-Product', skuId: 'example-standard' }],
    })),
    devices: [
      {
        id: DEMO_DEVICE_ID,
        displayName: 'Demo field laptop',
        osFamily: 'windows',
        serial: 'DEMOSERIAL1',
        lastContact: null,
        fdeKeyPresent: true,
      },
    ],
  }
}

function header(
  say: (text?: string) => void,
  fixture: HrisFixtureFile,
  path: string,
  demoToday: string,
  owner: HrisFixtureFile['people'][number] | null,
): void {
  say('')
  say('jml demo: a joiner/mover/leaver lifecycle with no credentials and no network.')
  say('')
  // The shipped fixture is named rather than pathed, because its resolved
  // location is the install directory and differs per machine.
  const label = path === DEMO_FIXTURE ? DEMO_FIXTURE_LABEL : path
  say('HR system      ' + label + ' (' + fixture.people.length + ' people, ' + fixture.activeIds.length + ' employed)')
  say('people store   in memory, empty at the start')
  say('providers      the shipped fakes; every call is recorded, nothing leaves this process')
  say('clock          pinned to ' + demoToday + ', then moved forward')
  if (owner) say('one laptop     ' + DEMO_DEVICE_ID + ' bound to ' + owner.displayName + ', to show the deletion gate')
  say('')
  if (fixture._readme) {
    say('The fixture explains what each person is there to demonstrate:')
    for (const line of fixture._readme.split('\n')) say('  ' + line)
  }
}

/** The store after a step. This is the state machine, printed. */
export async function renderStore(store: MemoryPeopleStore): Promise<string> {
  const people = [...(await store.list())].sort((a, b) => a.hrisId.localeCompare(b.hrisId))
  const lines = ['  people store:']
  for (const person of people) lines.push('    ' + describePerson(person))
  return lines.join('\n')
}
