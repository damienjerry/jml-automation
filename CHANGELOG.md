# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First release. Phase 1 is the leaver path: read the HR system, keep a people
store, and on the leaving date suspend access, hand over files, and delete
accounts. Phase 1b adds the joiner half: activate the staged account, license
it, wait for the mailbox, and send the messages. Nothing is armed by default.

### Added

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

- **Joiners and movers.** Phase 1 creates no accounts and changes no
  attributes. `jml detect` announces joiners; nothing acts on them.
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

- **Nothing in this toolkit has ever run against a real tenant.** Every
  connector is exercised against a scripted HTTP double, written by hand from
  the vendors' documented behaviour rather than recorded from a real response.
  The vendor behaviours the code guards against were established in the private
  automation this was ported from, not by this code.
- **Neither device uninstall script has ever run on real hardware.** The
  manifest at
  [src/engine/device/scripts/manifest.json](src/engine/device/scripts/manifest.json)
  records `provenOnHardware: false` for both. Service names, uninstall
  strings, launchd labels and paths were inferred rather than observed. A
  hand-over on an unproven platform is refused unless the operator names the
  machine they canaried it on: see
  [docs/runbooks/canary-a-device-script.md](docs/runbooks/canary-a-device-script.md).
- **The n8n bundle has never been imported into a running n8n.** The five
  files are validated for structure; no execution has been observed.
- **The Google Sheets and Notion credential patterns are documented from
  earlier private use, not from this code**, which does not ship those
  adapters.

Test coverage is not evidence about your tenant. 1419 tests across 148 files
pass on this checkout, and every one of them runs against a fake.

[0.1.0]: https://github.com/jml-toolkit/jml-toolkit/releases/tag/v0.1.0
