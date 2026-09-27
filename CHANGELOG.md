# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-09-27

Released as `v1.0c`, and what the installer builds by default. The same two
setups as `v1.0b` (1.0a and 1.0b), still experimental, with the installer
and the platforms made solid. Package 1.2.0, for npm's semantic versioning.

### Added

- **A preview of the setup** (`./install.sh --preview`, `jml setup --preview`).
- **The installer on Linux (apt or dnf) and on Windows through WSL2**, with the
  right advice for each platform.
- **CI on three platforms**: the full test suite on Ubuntu and on native
  Windows, both blocking, and the real installer with the whole setup preview
  run end to end on Ubuntu on every push.

### Fixed

Found by the first native Windows run:

- A key file could not be referenced by a Windows path (`file:C:\...`).
- A store that refused a newer database left the file open and locked.
- A Windows checkout's line endings made the generated files read as stale.
- `.env` cannot be made owner-only by file mode on Windows: documented, with
  the `icacls` command.

The details of each are in the sections below, which were written as the work
landed.

## [1.1.0] - 2026-09-26: setup 1.0b

Experimental, like 1.0.0: shared so a single IT person or a small team can
automate joiners and leavers without paying for a lifecycle product or tools
they do not otherwise need. Setup 1.0b has never run against a real tenant.

Released as `v1.0b`. It holds both setups: 1.0a (HiBob, JumpCloud and Google
Workspace, unchanged) and 1.0b (Google Workspace alone, with any HR source).
The package version is 1.1.0 because npm needs a semantic version; the setup
names are 1.0a and 1.0b. The same reference-toolkit statement applies: no
maintenance, support or compatibility updates are promised.

### Added

**Setup 1.0b: Google Workspace with no identity provider** (`identity.adapter:
none`). For a team whose HR system (or a person) creates the Google accounts.
Day 0 closes the Google account with `close_google`: a random password nobody
holds, a change required at next sign-in and read back, and every session
ended. It is not suspended then, because the day-6 hand-over is proven on an
active, unlicensed account; suspension stays after it. Starters get their
temporary password on Google, and an account counts as in use unless Google
reports that it has never signed in. There is no device inventory: every
deletion says no machine was checked. Arming a device step under this setup is
a configuration error. The sign-out step now also revokes app passwords.
Tested against fakes only.

**People from a CSV file or a Google Sheet** (`hris.adapter: csv` or `sheet`).
A column map, one stated date format, and status from the dates, so a leaver
keeps their row with a last working day filled in. One bad row refuses the
whole read and names every problem by row number. `hris.table.maxAgeHours`
refuses a stale table. A CSV needs no credential; a sheet is read as the
service account itself with the read-only Sheets scope, shared with it as a
viewer. See [docs/adapters/hris-table.md](docs/adapters/hris-table.md) and
[examples/people.csv](examples/people.csv).

**Your own message wording** (`notify.templatesDir`). A file named like a
built-in template replaces it. Checked at start-up: an unknown file name or a
placeholder the message does not supply refuses to start.

**The installer on Linux, and on Windows through WSL2.** `install.sh` detects
macOS, Linux (apt or dnf) and WSL2, and gives each the right advice: git
through the package manager on Linux, links for Node 22 and Docker Engine, and
the service and docker-group hints when Docker is installed but unreachable.
CI now runs the real installer and the whole setup preview on Ubuntu, and the
test suite on native Windows (experimental, not blocking).

**A preview of the setup** (`./install.sh --preview`, or `jml setup --preview`).
Every real question, asked in a temporary folder deleted at the end, including
on Ctrl-C. The steps that act (doctor, bootstrap, Docker, n8n) say what they
would do instead; nothing is read from 1Password and nothing is kept.

**`jml setup` asks which setup**: JumpCloud or none, and HiBob, a sheet, a CSV
or the demo file. It asks only for the credentials and prints only the Google
scopes that choice needs.

### Fixed

- **Messages stated a deletion date under a never-delete policy.** The day-0
  manager email, the day-0 and day-6 IT notes and the leaver ticket said the
  accounts would be deleted on a date even with `leaver.deletion: never`. The
  deletion sentence now follows the policy.
- **The README's host count was wrong** (nineteen; the source holds
  twenty-seven, including Notion, Suptask and a link `jml setup` prints). It
  now lists them by what is called and what is only printed.

## [1.0.0] - 2026-09-26

The first and fixed release. This is a versioned reference toolkit, shared for you to use and adapt. Ongoing maintenance, support and compatibility updates are not promised. If you deploy it, you own that deployment, including fixing it when a provider changes its API. What was tested,
and how, is in the README under "What this is".

First release. Phase 1 is the leaver path: read the HR system, keep a people
store, and on the leaving date suspend access, hand over files, and delete
accounts. Phase 1b adds the joiner half: activate the staged account, license
it, wait for the mailbox, and send the messages. Nothing is armed by default.

### Fixed after an outside review

An independent review before publishing found six things, all fixed:

- **Opening a Notion store could change its schema**, on every command
  including `jml doctor` and dry runs. It now only reads; `jml store migrate
  --armed` is the one schema change.
- **The docs said credentials are never written.** `jml setup` writes them to
  `.env` in plain text when Docker is used. The docs now say exactly that,
  and without Docker a 1Password reference stays a reference.
- **The container build ran dependency install scripts** and had no
  `.dockerignore`. Both fixed.
- **Development dependencies carried known vulnerabilities.** Vitest 2 to 5;
  `npm audit` reports 0.
- **Setup could carry on past a failed check.** A `doctor` override is
  recorded and the run finishes as incomplete; a failed bootstrap or verify
  stops it.
- **The installer built without pausing.** It now waits for a yes after
  printing the commit, and builds a pinned tag or commit.

A second pass by the same reviewer found two more, both reproduced and fixed:

- **Setup could report complete while somebody was still selected for
  offboarding** after the bootstrap. That is now recorded as unresolved, and
  setup finishes as incomplete until a bootstrap leaves nobody selected.
- **Moving a credential to a 1Password reference left the old plain-text value
  in `.env`.** Setup now offers to remove it, defaulting to yes, and says
  plainly when it stays.

A third pass looked at the project as a solo IT administrator would, and said
it promised more than it delivers. Fixed where the code or docs were wrong;
the larger product gaps it named are listed at the end.

- **Looking at your own HR data needed an identity provider and a Google key.**
  `jml sync` and `jml detect` opened the provider connectors, and every command
  resolved their credentials, so the adaptation guide told people to type
  placeholders into credential fields. Bootstrap, sync, detect and verify now
  need neither credential (unless notifications go by email, which sends
  through Google).
- **There was no supported way to never delete.** Leaving `delete` unarmed
  turned every armed run red for each leaver past day 7, for ever.
  `leaver.deletion: never` keeps the accounts, stops scheduling day 7, counts
  the retained leavers, and refuses `delete` in `armedActions`.
- **An empty store passed `jml store verify`.** A lost store, or a config
  pointed at the wrong path, printed "every stated expectation held" with
  nothing stated. It now warns on an empty store, and says when no expectation
  was given.
- **`jml store bootstrap` printed a stack trace** when the HR read failed. It
  now says the read failed and that nothing was imported.
- **The README promised joiner, mover and leaver automation.** It now opens
  with what it does, what it does not, and a compatibility table before any
  install step. The quickstart's step table listed three steps it had no
  section for, the demo used a plain `npm ci`, and the architecture page's run
  order predated the joiner, ticketing and owner steps. All corrected.

New pages: [docs/policy.md](docs/policy.md) (the leaver decisions to make before
arming, including what the toolkit does not check, such as a manager who has
also left), [docs/access-removal.md](docs/access-removal.md) (route by route,
what a suspension removes and what it does not, including what an unsuspended but unlicensed
Google account can still do), [docs/operating.md](docs/operating.md)
(daily checks, stopping, a backup and restore exercised on test data, updates,
removal, and what running it costs), and
[docs/ai-adaptation-brief.md](docs/ai-adaptation-brief.md).

Not done, and still true: no CSV import, no Google-only or Microsoft 365 path,
no read-only Sheets report, and no write validated
against a real provider.

### Added

**A day-0 Google sign-out.** Day 0 removes the licence, so Gmail and Drive go,
but the Google account stays active until it is suspended on day 6, and an
active account is still an identity: Sign in with Google into other apps keeps
working, and so does every grant already given to a third-party app. The new
`google_signout` action ends every session and revokes every grant, then lists
the grants again and counts the step done only when none remain. Sessions
cannot be read back from Google, so that half is reported as requested. It
needs `admin.directory.user.security`, which `jml doctor` probes only once the
action is armed, and a refused sign-out fails that step without holding the
rest of day 0 back.

**A guide to the idea, and to adapting it.** [docs/adapting.md](docs/adapting.md)
names the platform mix this was built for, says what it does not do (it
creates no accounts and does nothing for movers yet), explains each step and
safety rule in plain English, and rates every swap honestly: the HR system,
people store, scheduler and ticketing swap cleanly; the identity provider and
email platform are a fork today. It shows what can be tried against your own
HR data before building anything. Writing it found one bug: credentials for
an adapter that is not selected were still required at start-up, so using
the file adapter as a bridge to another HR system demanded HiBob keys. Fixed.

**A Mac installer.** `install.sh` checks for Node 22 and Docker, installs
dependencies with `--ignore-scripts`, builds from the clone and hands over to
`jml setup`, a resumable wizard: configuration, credentials with their minimum
access printed, `jml doctor` until it passes, a rehearsed tombstone bootstrap,
Docker Compose, and the n8n import. It prints every step with `--dry-run`,
never prints a secret, and arms nothing.

**`jml n8n import` works.** It creates the four n8n credentials and the six
workflows over the n8n API, error workflow first, everything bound by id and
created inactive, and is idempotent by name. It needs an API key with three
scopes: `workflow:list`, `workflow:create`, `credential:create`. Run against a
real instance, it found that n8n's Slack credential schema requires an empty
`notice` field, which no fake would have known.

**A grace period on the joiner side.** `joiner.graceDays` (default 7):
somebody who started longer ago than that with no activation recorded is an
existing employee to the selection, to the detect step and to the manager
nudge. Found on the first run against a real tenant, where a fresh store made
most of the employed set into starters and the run held nearly all of them over
the per-run cap for ever. `--hris-id` still activates a named person regardless.

**Notion people store.** One database, one row per person, single-writer
under the pipeline lease, read-verify-write on every status change, full
pagination. Passes the shared store conformance suite against a fake of the
Notion API. Department, role, source and manager may be select or email
columns, and `readOnly: true` turns the adapter into a reader for a database
another automation owns.

**Owner notifications.** Optional. The day after a leaving date, each
platform owner in a register file gets one message naming the platforms they
own. A required go-live date and a lookback stop the first run reaching
into the history.

**Ticketing.** Optional. With a ticketing adapter (Suptask shipped; the
interface is four methods), a joiner's manager is nudged once to raise the
starter form and reminded once the day before, a ticket on that form opens
the activation gate through `POST /v1/tickets/inbound` and the
`jml-ticket-inbound` workflow, and a leaver ticket is raised once when a
person becomes a day-0 candidate.

**The joiner half.** Three working days before a start date, a temporary
password with a forced reset on the staged identity account, a licence, a
poll until the mailbox exists, an organisational unit move, and the password
and welcome messages. Four separate arming actions. An account anybody has
ever used is refused, not reset. See docs/state-machine.md.

**The leaver lifecycle.** Five statuses assigned in one place
([src/core/transitions.ts](src/core/transitions.ts)), with `departed`
terminal and no route out of it. Three stages, configurable by day offset:
day 0 suspends the identity account, sets a mailbox auto-reply and revokes
licences; the hand-over day transfers files to the line manager and suspends
the mailbox; the deletion day deletes both accounts, if the gates open.

**Four deletion gates.** The hand-over gate, which waits for the provider to
report the transfer complete rather than for the request to be accepted; the
identity gate, which refuses to act on an account or address an employed
person claims; the device gate, which blocks while any machine is directly
bound to the person and which **fails closed** on any read it cannot
complete; and an optional acknowledgement gate for adopters who want a
person in the loop.

**Two arming locks, dry run by default.** Every command plans unless
`--armed`; every action stays inert unless `mode: armed` and `armedActions`
names it. `mode: armed` with an empty `armedActions` is a start-up failure.

**Circuit breakers.** A run aborts before any write when the day-0 candidate
count exceeds `leaver.maxDay0PerRun`, when the store's count of departed rows
has fallen, or when the HR snapshot is smaller than
`hris.minPlausibleHeadcount`. The first two fire in a dry run as well.

**A people store with no delete.** The interface offers no `delete` and no
`prune`, and keeps a monotonic count of departed rows. SQLite via
`node:sqlite` is the default and the only adapter shipped in this release;
the in-memory adapter exists for the demo and the tests.

**HRIS adapter.** One reference adapter (HiBob) plus a fixture adapter for
offline work. Employment is derived from absence in a second read of the
employed people, never from a lifecycle status word. Dates are read as ISO
values, never parsed out of formatted text. The read pages to exhaustion and
throws rather than returning a partial snapshot.

**Connectors.** JumpCloud for identity and devices; Google for the directory,
licensing, data transfer and Gmail. Every write is confirmed by a read-back
before it is recorded as done. Google tokens are minted one scope per JWT.
Outbound calls go through one HTTP client that returns the status and body of
a non-2xx rather than throwing them away.

**Device dispositions.** `return_to_pool`, `reassign`, `handover` and
`retain_unmanaged`, with a preflight that reports every reason an action would
be refused before anything is touched. A hand-over uninstalls agents, reads
the receipt from the detail endpoint, waits for the machine to fall silent,
and only then deletes the device record. Command associations are attached one
machine at a time, detached in a `finally`, and the detach is proved by
re-reading. A command bound to a device group, or already carrying another
machine, is refused.

**Human controls.** `hold` freezes a row against every automation including
the HR sync; `release` clears the freeze and the parked reason together; `ack`
records that a person agreed to a deletion; `tombstone` closes a row by hand
with no account work. Hold is re-read before each person, each leg and each
status write, so setting it during a run stops that run.

**Secret handling.** Credentials are referenced from configuration as
`env:NAME`, `file:/path` or `op://<vault>/<item>/<field>`, never written into
it. Every reference resolves once at start-up; an unresolvable one stops the
process. Resolved values are held in a closure whose string, JSON and inspect
forms are `[redacted]`, they register with a process-wide redactor in plain,
percent-encoded and base64 forms, and interpolating a secret is a lint error.

**Audit log.** Append-only JSONL, one file per day, hash-chained line to line,
fsynced. Two rows per action: the intent before the provider call and the
outcome after, and a failed intent append stops the call. Addresses are
stored as a salted hash by default. `jml audit verify` names the first line
that does not follow from its predecessor. An optional second sink pushes to
a log aggregator, and a failure there is a counted warning rather than an
abort.

**Change gate on notifications.** A note is sent when the set of affected
people changes, with a weekly re-raise that fires once on its weekday. The
fingerprint is taken over the set, never over a timestamp or a field the
toolkit writes itself. Recording happens after delivery is proven. Anything
that goes wrong in the gate announces rather than withholds.

**HTTP sidecar.** `jml serve`, bearer token compared in constant time, dry run
the default on every route, asynchronous runs with polling, a 64 KB body cap,
and every response passed through the redactor. It refuses to start with a
token under 32 characters, with an unwritable audit log, or with a fallen
tombstone count. The shipped compose file does not publish its port.

**Automation bundle.** Five hand-authored n8n workflow files, a validator that
refuses instance state, hardcoded URLs or an unasserted chat post, and
`jml n8n scrub` for making a live export committable. n8n holds the sidecar
token and no vendor credential.

**Offline demo.** `jml demo` walks a whole leaver lifecycle with no
credentials and no network: day 0, the hand-over day, a deletion refused
because a laptop is still bound, the laptop coming back, and the deletion then
proceeding because the gate reads the provider live rather than trusting what
it recorded.

**Documentation.** [docs/incidents.md](docs/incidents.md) records the failure
behind every safeguard, with a link to the regression test that holds each
one. [SECURITY.md](SECURITY.md) carries the threat model and a checkable trust
statement. [docs/config-reference.md](docs/config-reference.md) is generated
from the schema.

**Disclosure gate in CI.** A credential scan over history and an identifier
scan over the working tree run before anything else and block the build.
`npm run gate` runs the same checks locally, plus the generated-file check,
workflow validation, typecheck, lint and the test suite.

### Not in this release

- **Movers.** A role change updates the person's record and nothing else: no
  group, licence or access is changed because somebody moved.
- **The Microsoft Graph leg and Slack SCIM deactivation.** Interfaces only.
  `legs.azure` and `legs.slackScim` are literal `false`, and start-up refuses
  if `AZURE_CLIENT_SECRET` or `SLACK_SCIM_TOKEN` is set, because a credential
  present for a step that cannot run reads as coverage that does not exist.
- **The SaaS-register checklist.** Reserved.
- **The Notion and Google Sheets store adapters.** The configuration schema
  describes them, and choosing one refuses at start-up with a message saying
  the release ships them as an interface only. Use the SQLite store, or the
  memory store for a rehearsal.
- **A Linux device script.** A hand-over on a Linux machine is refused rather
  than being sent the Windows script.
- **A module manifest for automated readers.** [AGENTS.md](AGENTS.md) is a
  stub naming the three surfaces that are authoritative today.

### Not proven

Read this before arming anything.

- **Only the read-only half has run against a real tenant.** One shadow run before
  this release proved `jml doctor`, the HR read, the bootstrap, the dry-run sync
  and selection, and the Notion adapter as a reader, and found five defects the
  test suite had not (recorded above under Added and in
  `docs/incidents.md`). Every write path is still exercised only against a
  scripted HTTP double, written by hand from the vendors' documented behaviour
  rather than recorded from a real response.
- **Neither device uninstall script has ever run on real hardware.** The
  manifest at
  [src/engine/device/scripts/manifest.json](src/engine/device/scripts/manifest.json)
  records `provenOnHardware: false` for both. Service names, uninstall
  strings, launchd labels and paths were inferred rather than observed. A
  hand-over on an unproven platform is refused unless the operator names the
  machine they canaried it on: see
  [docs/runbooks/canary-a-device-script.md](docs/runbooks/canary-a-device-script.md).
- **The n8n bundle has been imported, not run.** It was imported into a real n8n of the pinned version by `jml n8n import` (six workflows inactive, the error workflow and every credential bound by id); no execution has been observed.
- **The installer has not run end to end on a fresh Mac.** `install.sh` has
  run in dry run and passes shellcheck; `jml setup` runs end to end against
  fakes of `jml`, the shell and n8n. Its Compose step has never started the
  real containers.
- **The Google Sheets credential pattern is documented from earlier private
  use**; that adapter does not ship.

Test coverage is not evidence about your tenant. 1541 tests across 159 files
pass on this checkout, and every one of them runs against a fake.

[1.2.0]: https://github.com/damienjerry/jml-automation/releases/tag/v1.0c
[1.1.0]: https://github.com/damienjerry/jml-automation/releases/tag/v1.0b
[1.0.0]: https://github.com/damienjerry/jml-automation/releases/tag/v1.0.0
