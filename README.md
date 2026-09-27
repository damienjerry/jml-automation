# jml-automation

> **Experimental.** A reference toolkit, not a product. Setup 1.0a's read-only
> half has run against one real tenant; no write, in either setup, has ever run
> against a real provider, and setup 1.0b has never run against a real tenant
> at all. Read what was tested below before you rely on any of it.

**Why it exists.** So that one IT person, or a small IT team, can automate
joiners and leavers themselves, without paying for a lifecycle product or for
tools they do not otherwise need. It is shared as a working example to copy,
run and change, and the docs explain every step and safety rule so the idea
can be rebuilt on whatever you already use.

An HR-driven account lifecycle toolkit for Google Workspace. It reads your HR
system, or a spreadsheet of people, every day. When somebody leaves, it closes
their sign-in, sets an auto-reply, removes their paid licence, signs them out,
hands their files to their manager, and, only if you choose, deletes their
accounts, reading back every change it makes. When somebody is about to start,
it activates the account your HR system has already created. It is a command
line tool, an optional HTTP sidecar, and six n8n workflows that hold no logic.

It **does not create accounts** and it **does not change access for movers**.
The read-only half has run against one real tenant. **No write has ever run
against a real provider**: suspension, deletion and activation are tested
against fakes only.

## Two setups

| | Setup 1.0a | Setup 1.0b |
| --- | --- | --- |
| HR source | HiBob | any: HiBob, a Google Sheet, a CSV export, or one adapter file for another HR API |
| Accounts | JumpCloud in front of Google Workspace | Google Workspace alone |
| Who creates the accounts | HiBob's JumpCloud integration, then JumpCloud's Google one | your HR system's Google integration, or you |
| Day 0 closes sign-in by | suspending the JumpCloud account | replacing the Google password with one nobody holds, requiring a change at next sign-in, and ending every session |
| Laptops | deletion is blocked while a machine is bound in JumpCloud | no device inventory: every deletion says none was checked, and you recover the laptop by hand |
| Config | `identity.adapter: jumpcloud` | `identity.adapter: none` |

**Why 1.0a uses JumpCloud.** This was built for a team that uses JumpCloud to
manage devices, accounts and remote support in one place. That is a
preference, not a need: nothing is wrong with Google Workspace on its own, and
if you already use NinjaOne, a remote desktop tool or anything similar for
devices and support, 1.0b is very likely the better fit.

Both setups run from the same install; `jml setup` asks which one.

## What this is

**Version 1.0, a fixed release, in two setups.** This is a versioned reference toolkit, shared for you to use and adapt. Ongoing
maintenance, support and compatibility updates are not promised. If you deploy
it, you own that deployment, including fixing it when a provider changes its API.

What was tested, and how:

| Part | Status |
| --- | --- |
| `jml demo` | runs offline; its whole output is snapshot-tested |
| `jml doctor`: HiBob, JumpCloud and every Google scope | **run against a real tenant**, 2026-09-25 |
| HR read, history import, sync, detect, store verify | **run against a real tenant, read-only**, 2026-09-25 |
| Notion people store | **read against a live database**, read-only, 2026-09-25; writes tested against fakes |
| SQLite store, backup and restore | exercised on test data, 2026-09-26 |
| `jml n8n import` | **run against n8n 1.123.77**, 2026-09-26 |
| Leaver writes: suspend, auto-reply, licence, Google sign-out, hand-over, Google suspend, delete | tested against fakes only |
| Joiner writes: temporary password, licence, org unit, welcome | tested against fakes only |
| Setup 1.0b: closing the Google account, Google starter passwords, no device inventory | tested against fakes only |
| HR from a CSV file | tested offline, including the shipped [examples/people.csv](examples/people.csv) |
| HR from a Google Sheet | tested against a fake Sheets API only |
| Your own message wording (`notify.templatesDir`) | tested offline |
| Ticketing (Suptask), owner notifications, Slack and email notifications | tested against fakes only |
| Device unbind and handover | never run on real hardware; handover is refused until you canary it |
| `install.sh` and `jml setup` | on macOS and on Linux (CI, Ubuntu): clone, install, build and the whole setup preview, end to end. The Docker Compose step has never started the containers end to end |
| Native Windows | the full test suite runs in CI on every push and must pass; no installer, so still experimental as a way to run it |

The design comes from automation that runs these steps in production at one
organisation, on setup 1.0a. This code's own write paths have not run against a
real provider, and setup 1.0b has not run against a real tenant at all. The
first armed action you take is also a test of the toolkit, so take it on a
test account.

Tested with Node 22.22, n8n 1.123.77, the JumpCloud v1 and v2 APIs, the Google
Admin SDK Directory, Licensing and Data Transfer v1 APIs, the Gmail v1 API, the
Sheets v4 and Drive v3 APIs (1.0b, against fakes), the HiBob v1 API and the
Notion API version 2022-06-28.

Deletion, the device handover and every other destructive step are optional
and off by default. Suspension and reporting can be used indefinitely without
ever arming deletion ([docs/policy.md](docs/policy.md)).

**JML** is joiner, mover, leaver: the identity-management term for everything IT
does when somebody starts, changes role, or leaves. Audits, security
questionnaires and larger companies use it, and a small IT team that speaks it
has an easier time with all three.

## Does it fit what you run?

| Your setup | Today |
| --- | --- |
| HiBob, JumpCloud and Google Workspace | Setup 1.0a. What it was built for. Close to configuration only, once you have read [docs/policy.md](docs/policy.md) |
| Google Workspace, with any HR system that creates the Google accounts | Setup 1.0b |
| No HR API, only an export or a spreadsheet | Setup 1.0b with a CSV file or a Google Sheet: [docs/adapters/hris-table.md](docs/adapters/hris-table.md) |
| Another HR system with an API | a CSV or sheet export works today; a direct adapter is one file behind a small interface (HiBob's is about 650 lines) |
| Nothing creates the Google accounts | **Not covered.** The toolkit activates accounts; it does not create them |
| Microsoft 365 or Entra ID | **Not supported.** A fork, and a different lifecycle: sessions, mailbox retention, OneDrive and licences are separate decisions there |
| Okta or another identity provider in front of Google | **Not supported.** A fork. Setup 1.0b does not cover it: it closes the Google password, and a person who signs in to Google through another identity provider can still get in until that account is closed too |
| Where it keeps its own records | SQLite by default, or a Notion database |
| Scheduler | n8n, or cron |
| Notifications | Slack, email or the console, with your own wording from a folder of templates. Not Teams |
| Ticketing | Suptask, or none |

"Fork" means the change touches shared code, so plan it as a project.
[docs/adapting.md](docs/adapting.md) explains what every piece does and why, so
the idea can be rebuilt for any mix, including none of these tools.

What access a suspension does and does not remove is set out route by route in
[docs/access-removal.md](docs/access-removal.md). Read it before telling anybody
a leaver has no access.

## Three ways in

1. **Try it.** Fictional people, no credentials, no network, one command. The
   demo below.
2. **Look at your own organisation, changing nothing.** Point the HR adapter at
   your HR system with a read-only token, or at a CSV export or a Google Sheet, and run
   `jml store bootstrap`, `jml sync --armed`, `jml detect` and `jml store verify`.
   These read the HR system and write only a local file. They need no identity
   provider or Google credential. You see who the toolkit thinks has joined and
   left, and the exact set it would act on today. Add read-only provider keys and
   `jml leaver dry-run` shows, for everybody due, which accounts exist and what
   would be done to each.
3. **Automate one action.** Follow [docs/quickstart.md](docs/quickstart.md) to
   arm suspension alone, on one test account you created, and watch a cycle.

Running it day to day, stopping it, backups, updates and removal:
[docs/operating.md](docs/operating.md). It also covers what running it costs,
which is not nothing even though the code is free.

## Run the demo first. No credentials, no network

```
git clone https://github.com/damienjerry/jml-automation.git
cd jml-automation
npm ci --ignore-scripts
npm run build
node bin/jml.mjs demo
```

The demo walks a whole leaver lifecycle against a shipped fixture and shipped fake
providers. It reads no credentials, opens no socket and writes no files.

```
jml demo: a joiner/mover/leaver lifecycle with no credentials and no network.

HR system      the shipped demo fixture (7 people, 3 employed)
people store   in memory, empty at the start
providers      the shipped fakes; every call is recorded, nothing leaves this process
clock          pinned to 2026-01-15, then moved forward
one laptop     sys-demo-laptop bound to Robin Ellis, to show the deletion gate
```

On day 0 three people have left. Each leg reports what it did and that it read the result
back, rather than reporting that a call returned 200:

```
  Robin Ellis     day0    terminated -> offboarding
      revoke_licence=done(verified) set_autoreply=done(verified) signout_google=done(verified) suspend_idp=done(verified)
      identity provider account suspended, read back
      auto-reply set on the mailbox
      revoked 1 licence(s): example-standard
      sign-out of every Google session requested (Google cannot confirm it), and 0 third-party app grant(s) revoked, read back as none left
```

On day 7 the accounts are deleted. Two of the three go. The third is **refused**, because a
laptop is still bound to that person:

```
--- notification (leaver.blocked) would be sent to IT ---
subject: Deletion blocked (devices_bound): Robin Ellis

Deletion blocked: Robin Ellis (robin.ellis@example.com)

Reason: devices_bound

- Demo field laptop, windows, serial DEMOSERIAL1

Nothing has been deleted. The row stays in offboarding and the deletion is
attempted again on the next run once the reason clears.

This note is sent when the blocking set CHANGES, and re-raised once a week.
Silence therefore means the same blockage, not a resolved one. See docs/runbooks/clear-a-blocked-deletion.md.

--- end notification ---
```

The run report says the same thing in one line per person (trimmed here; a third person's
deletion also completed):

```
run demo-delete  pipeline  armed  ok=true
  counts: blocked=1 day7=2 detect.joiner=1 detect.potentialLeaver=1 hrisEmployed=3 hrisPeople=7 sync.preserved=3 sync.scanned=7 sync.skipped_no_email=1 sync.unchanged=3
  Robin Ellis     blocked offboarding -> offboarding  blocked: devices_bound
      1 device(s) are still bound to this person:
- Demo field laptop, windows, serial DEMOSERIAL1
  Sam Rivera      day7    offboarding -> departed
      delete_google=done(verified) delete_idp=done(verified)
      identity provider account deleted, confirmed gone
      Google account deleted, confirmed gone
```

Deleting that account would have taken away the only channel to the machine, along with the
disk-encryption key the provider held for it. The laptop would have carried on running,
unmanaged, with nothing left to reach it. So the gate blocks, the row stays in
`offboarding`, and the deletion is retried on a later run.

The laptop comes back and is unbound. Then the same run, on the same day, with nothing else
changed:

```
=== The deletion day, again  (2026-01-22) ===
Same day, same run, nothing else changed. The gate reads the provider live rather than
trusting what it recorded last time, so the deletion now proceeds.
```

```
  Robin Ellis     day7    offboarding -> departed
      delete_google=done(verified) delete_idp=done(verified)
      identity provider account deleted, confirmed gone
      Google account deleted, confirmed gone
```

```
The demo finished with every run ok.
Nothing left this process: no network call, no credential, no file written.
```

The gate re-reads the provider on every attempt rather than trusting what it recorded last
time, and it **fails closed**: anything that is not a successful read of zero bound devices
blocks the deletion. In the automation this was ported from, the device lookup was wrapped
in a catch that logged and carried on, so a provider error produced an empty list, an empty
list read as "nothing to block on", and one failed read deleted the account. That is
`leaver.deviceGate.failClosed` in [docs/config-reference.md](docs/config-reference.md), and
it is not overridable.

## Install on macOS, Linux, or Windows through WSL2

When the demo makes sense, the installer takes a machine from nothing to a scheduled first
dry run.

| Platform | Status |
| --- | --- |
| macOS | the reference. Offers Node and Docker Desktop through Homebrew, with a yes |
| Linux (apt or dnf) | the installer and the setup preview run end to end in CI on Ubuntu. Offers git through the package manager; points to Node 22 and Docker Engine rather than installing them, because distribution Node packages are often too old and nothing is piped from the internet into a shell. The best place for the scheduled job: a server or VM that is always on |
| Windows | **through WSL2**, which is Linux: install a distribution such as Ubuntu, then Docker Desktop with WSL integration, and run the installer inside it. **Native Windows has no installer**; the full test suite runs on it in CI on every push and must pass |

Neither Linux nor Windows has run a real setup end to end on a person's machine.

 To see the whole setup first, as a new user would, run `./install.sh --preview`:
it checks and builds as usual, then walks the wizard with every real question in a
temporary folder that is deleted at the end. Nothing is installed with Homebrew, nothing
is read from 1Password, and the steps that act say what they would do instead. Read `install.sh` before you run it: it is short, it prints every command before it
runs it, and `--dry-run` prints them without running any.

```
git clone https://github.com/damienjerry/jml-automation.git
cd jml-automation
./install.sh
```

It checks for Node 22 and Docker (offering Homebrew, and doing nothing without a yes),
clones, prints the exact commit and **stops until you say yes**, then installs dependencies
with `--ignore-scripts` so no third-party package runs code on your machine, builds from the
source you cloned, and hands over to `jml setup`. It builds the `v1.0c` tag by default, which
holds both setups; set `JML_REF` to another tag or a commit you have read to build that instead. That asks for your
organisation, HR system and people store; asks for each credential and prints its minimum
access; runs `jml doctor` until every check passes; rehearses the tombstone bootstrap before
writing it; starts the sidecar and n8n with Docker Compose; and imports the six workflows with
their credentials over the n8n API. It resumes where it stopped, and nothing is armed at the
end. `./install.sh --no-docker` sets up the command line tool alone.

**Where your credentials end up.** With Docker, every value is written to `.env` in plain
text, mode 600, because the sidecar container reads it from there and cannot run the
1Password CLI; a 1Password reference is read once and its value copied in. Without Docker, a
1Password reference stays a reference in `jml.config.yaml` and the value never touches the
disk. `jml.config.yaml` itself never holds a credential in either case.

## What it does

| Phase | When | What runs |
| --- | --- | --- |
| Sync | every run | Read the HR system, create and update rows, derive `hired`, `active` or `terminated`. Never touches a row the offboarding engine owns. |
| Detect | every run | Announce joiners and leavers, and only when the set has changed. |
| Activate | three working days before a start date, configurable | Set a temporary password with a forced reset on the staged identity account, license the Google account, wait for the mailbox, move the account into the managed organisational unit, then send the password to the personal address and the manager and the welcome to the work address. Never touches an account somebody is already using. |
| Day 0 | the day the HR system drops somebody from the employed set | Suspend the identity provider account, set the mailbox auto-reply, revoke paid licences, sign the Google account out of every session and revoke its third-party app grants, tell the manager and IT. |
| Day 6 | 6 days after suspension, configurable | Hand the files to the manager through the Google data transfer API, then suspend the Google account. |
| Day 7 | 7 days after suspension, configurable | Delete the identity provider account and the Google account, if every gate opens. Write a tombstone. With `leaver.deletion: never` this day is not scheduled and both accounts are kept. |
| Ticketing | with the detector, and on a webhook | Ask the manager to raise the starter form when a joiner is detected, remind once the day before, open the activation gate when a ticket on that form arrives, and raise a leaver ticket for the platforms IT does not administer. Suptask is the reference adapter; the interface is four methods. |
| Owners | the day after a leaving date | Tell each platform owner in the register, once, which of their platforms to check. For everything IT does not administer. Off until a go-live date is set, so switching it on cannot tell every owner about every leaver in the history. |
| Devices | on demand | Read a machine and report every reason a disposition would be refused. Unbind, reassign, hand over or retain. |

## What it does not do

- **It does not create accounts.** Your HR system's own integrations create the staged
  identity account and the unlicensed Google account. The toolkit takes over from there:
  activation, licence, mailbox, organisational unit and the messages. If your HR system
  does not create accounts, the joiner path has nothing to activate.
- **Only the read-only half has run against a real tenant.** One shadow run, before
  this release: `jml doctor` passed against a live HR system, identity provider and Google
  Workspace, the bootstrap and two dry cycles agreed with the estate's own records, and the
  Notion adapter read a live people database in read-only mode. It found five defects
  that 1466 passing tests had not, all fixed and now covered. **No write has ever run
  against a real provider**: not a suspension, a licence change, a transfer, a deletion,
  an activation or a sent message.
- **The two device uninstall scripts have never run on real hardware.**
  `src/engine/device/scripts/manifest.json` records `provenOnHardware: false` for both, and
  a handover is refused on any platform whose script is unproven unless you name the machine
  you canaried it on. See [docs/runbooks/canary-a-device-script.md](docs/runbooks/canary-a-device-script.md).
- **It never reverses anything.** There is no unsuspend and no undelete. `departed` is a
  terminal status with no outgoing transition, deliberately: it is what stops a historic
  leaver being re-created and offboarded again.
- **Azure and Slack SCIM do not run.** The interfaces exist and nothing behind them is
  implemented. If `AZURE_CLIENT_SECRET` or `SLACK_SCIM_TOKEN` is set, start-up refuses,
  because a credential present for a step that cannot run reads as coverage that does not
  exist.
- **No Linux device handover.** A handover on a Linux machine is refused rather than being
  sent the Windows script.
- **Self-hosted n8n only.** The bundle needs form triggers, environment variables and a
  private network to the sidecar.

### Nothing is armed by default, and there are two independent locks

Every run plans and reports. To make one real action happen, both of these must be true:

1. the configuration says `mode: armed` **and** lists that action in `armedActions`; and
2. the command was given `--armed`.

They are checked separately, per action, on every leg (`src/engine/leaver/legs.ts`, in that
order: dry run first, then `isArmed`). A leg whose action is not armed records `not_armed`
and says what it left alone, rather than vanishing from the report. The suspend leg's line
reads "suspension is not in armedActions, so the account was left alone"; each of the seven
legs has its own.

`armedActions` is a list, so you arm `suspend` first, watch a cycle, then arm `transfer`,
then `delete`. That order matters: each stage is reversible by hand and the next one is
less so. The staged path is written out in [docs/quickstart.md](docs/quickstart.md).

An unknown flag is a usage error, not something ignored. `--dryrun` is not `--dry-run`, and
a tool that quietly ignores the difference arms a run somebody thought they were rehearsing.

## Trust

- **No telemetry and no phone-home.** The only hosts compiled into the source are the vendor
  APIs the toolkit is for. You can check that in one command:

  ```
  grep -rhoE "https://[a-zA-Z0-9./-]+" src | sort -u
  ```

  It returns twenty-seven lines. Called: the Google Admin SDK, Licensing, Gmail, Sheets
  and Drive APIs, Google's OAuth token endpoint, and the JumpCloud, HiBob, Notion, Slack
  and Suptask APIs, each only when that piece is configured. Never fetched, only printed
  or written: the Google OAuth scope strings, the Google and JumpCloud sign-in pages named
  in starter messages, the Docker Desktop download page `jml setup` points to, and two JSON
  Schema identifiers in the generated schema file. Nothing else. The optional
  log-aggregator push and the dead-man ping go to URLs you configure, and both default to
  off.

  That command is only worth running because no source file contains a NUL byte: `grep`
  treats one as binary and skips the whole file without saying so, and
  `tools/lint/check-identifiers.mjs` skips it too. Two files did until this was found, one of
  them the token-minting code. `npm run identifiers` reports what it scanned.
- **Two runtime dependencies**, `yaml` and `zod`, with no transitive dependencies of their
  own. `npm ls --omit=dev --all` prints the whole tree in three lines.
- **Credentials never leave your machine or your n8n instance.** Config holds references
  (`env:NAME`, `file:/path`, `op://vault/item/field`), never values. References resolve once
  at start-up, register with the redactor, and are masked in logs, errors, the run report
  and the audit log. `jml config show` prints references and lengths only.
- **n8n never holds a vendor credential.** The workflows call the sidecar with one bearer
  token. The identity provider key, the Google service account and the HR token live in the
  sidecar. `docker compose config` shows the n8n service naming no vendor variable, and
  `grep -ri credential n8n/workflows` shows the exports carrying no credential material, so
  the claim is checkable rather than something to take on trust.
- **The sidecar publishes no port.** In the shipped [docker-compose.yml](docker-compose.yml)
  it is reachable at `http://jml:8787` on a private network and from nowhere else.
- **The audit log is append-only and hash-chained.** `jml audit verify` walks the chain and
  names the first line that does not check out. Addresses are stored as a salted hash by
  default: a log kept for years does not need to be a staff directory.
- **MIT licensed.** See [LICENSE](LICENSE).
- **Read the code.** Every safeguard carries a comment saying which failure it exists for,
  and `test/regression/` holds 89 files each named for one of them, for example
  `tombstones-pruned-refire.test.ts`, `exit-rename-inherits-live-ids.test.ts`,
  `device-gate-fails-closed-on-error.test.ts`. That reasoning is the main thing here worth
  having.

The threat model, what the sidecar exposes and to whom, and the full inventory of
destructive actions are in [SECURITY.md](SECURITY.md).

## Requirements

| | |
| --- | --- |
| Node | 22.13 or newer. `node:sqlite` is the default people store, and the CLI relies on type stripping. `bin/jml.mjs` checks the version and exits 78 rather than failing halfway. |
| HR system | HiBob with a **read-only** service user; or a CSV file or a Google Sheet ([docs/adapters/hris-table.md](docs/adapters/hris-table.md)). The adapter interface is deliberately small (one snapshot read), so another HR API is a single file. A JSON fixture adapter ships for rehearsal. |
| Identity provider | JumpCloud (setup 1.0a), or none (setup 1.0b). A read-only JumpCloud admin key satisfies the whole read set, including the device gate. |
| Google Workspace | A service account with domain-wide delegation, one scope string at a time. |
| n8n | Optional and recommended, self-hosted. Without it, run `jml run` from cron. |
| Docker | Optional. The compose file runs the sidecar and n8n side by side. |

## Modules

| Module | Status | Notes |
| --- | --- | --- |
| HR adapter: HiBob | required, or write your own | Read-only. No write, no time-off endpoints. |
| HR adapter: CSV file, Google Sheet | ships | One set of rules: a column map, one date format, a leaver keeps their row with a last working day, and one bad row refuses the whole read. See [docs/adapters/hris-table.md](docs/adapters/hris-table.md). |
| HR adapter: JSON fixture | ships | Rehearse the sync, the detection and the store commands offline against a file. It is what `jml init` selects, so a first run cannot read a real HR system by accident. See [docs/adapters/hris-fixture.md](docs/adapters/hris-fixture.md). |
| People store: SQLite | default | Transactional. `node:sqlite`, no native module. |
| People store: Notion | optional | One Notion database, one row per person. Single-writer under the pipeline lease; opening it never changes the database, and only `jml store migrate --armed` adds a missing property. Passes the same conformance suite as SQLite. |
| People store: Google Sheets | not implemented | Selecting it fails. Not the same as reading people from a sheet (the HR adapter above): this would keep the toolkit's own records in one. |
| People store: memory | demo and dry-run only | Nothing persists. |
| Identity provider: JumpCloud | setup 1.0a | Users, device bindings, commands, command results. |
| Identity provider: none | setup 1.0b | Google is the only account. Day 0 closes it; starters get their password on Google. |
| Google Workspace | required | Directory, licensing, data transfer, Gmail settings, Gmail send. |
| Device gate | read-only | Blocks a deletion while a machine is bound (1.0a). Not overridable. With no identity provider (1.0b) there is no inventory, and every deletion says so. |
| Device disposition | optional | Unbind, reassign, handover, retain. Handover is refused until canaried. |
| Notifications: console | default | So a first run needs no credential. |
| Notifications: email, Slack | optional | Gmail send as one named mailbox; a Slack bot token. |
| Audit: JSONL | always on | Hash-chained, one file per day. |
| Audit: log aggregator push | optional, off | Push endpoint plus an auth header. |
| HTTP sidecar | optional | Bearer token, at least 32 bytes, compared in constant time. |
| n8n bundle | optional | Six workflows, no logic, no credentials, no URLs. |
| Azure, Slack SCIM | reserved | Interfaces only. Start-up refuses if a credential is set. |

## Documentation

| | |
| --- | --- |
| [docs/adapting.md](docs/adapting.md) | The idea in plain English, the platform mix it was built for, and how to swap any piece of it for what you run. |
| [docs/policy.md](docs/policy.md) | The leaver decisions to make before arming: deletion or retention, approval, managers who have left, rehires, contractors, legal holds. |
| [docs/access-removal.md](docs/access-removal.md) | Route by route, what a suspension removes, what it does not, and what stays your job. |
| [docs/operating.md](docs/operating.md) | Daily checks, stopping it, backup and restore, updates, removal, and what running it costs. |
| [docs/ai-adaptation-brief.md](docs/ai-adaptation-brief.md) | A brief to give a coding assistant that adapts this to your stack, and what it cannot do for you. |
| [docs/quickstart.md](docs/quickstart.md) | From the demo to a scheduled run, in order, with real output and what to do when a step fails. |
| [docs/credentials.md](docs/credentials.md) | Every credential, the smallest permission set that works, and how `jml doctor` proves it. |
| [docs/state-machine.md](docs/state-machine.md) | The statuses, the transition table, the gates, and the failure each guard exists for. |
| [docs/incidents.md](docs/incidents.md) | The failure catalogue, each entry linked to the regression test that holds the line. |
| [docs/architecture.md](docs/architecture.md) | Library, sidecar and n8n: what runs where, and what was rejected. |
| [docs/config-reference.md](docs/config-reference.md) | Every configuration key, generated from the schema. Do not hand-edit. |
| [docs/runbooks/offboard-a-leaver.md](docs/runbooks/offboard-a-leaver.md) | Day 0, day 6 and day 7 in plain English, and how to stop it. |
| [docs/runbooks/canary-a-device-script.md](docs/runbooks/canary-a-device-script.md) | The mandatory procedure before a device handover is allowed. |
| [docs/adapters/hris-table.md](docs/adapters/hris-table.md) | People from a CSV file or a Google Sheet: the columns, how leavers work, dates, and what refuses a read. |
| [docs/adapters/hris-fixture.md](docs/adapters/hris-fixture.md) | The JSON fixture adapter: the file format, and how to rehearse offline without a credential. |
| [docs/adapters/notion.md](docs/adapters/notion.md) | The Notion people store: setup, the column contract, and why opening it never changes the database. |
| [docs/adapters/sheets.md](docs/adapters/sheets.md) | The design for a Google Sheets people store. Not implemented: selecting it fails. |
| [SECURITY.md](SECURITY.md) | Threat model, what the sidecar exposes, and the destructive-action inventory. |
| [n8n/README.md](n8n/README.md) | The workflow bundle, node by node, and why it holds no logic. |
| [jml.config.example.yaml](jml.config.example.yaml), [.env.example](.env.example) | Generated from the schema, with every key and its default. |

The rest of the runbooks: [hold and release](docs/runbooks/hold-and-release.md),
[clearing a blocked deletion](docs/runbooks/clear-a-blocked-deletion.md),
[device return or handover](docs/runbooks/device-return-or-handover.md),
[rotating a credential](docs/runbooks/rotate-a-credential.md),
[migrating the people store](docs/runbooks/store-migration.md) and
[incident recovery](docs/runbooks/incident-recovery.md). Maintainer notes are in
[docs/maintainer.md](docs/maintainer.md) and the release history in
[CHANGELOG.md](CHANGELOG.md). There is no separate `docs/n8n.md`: the bundle is documented
in [n8n/README.md](n8n/README.md), next to the files.

## Possible extensions

Not planned work and not commitments. [docs/plan-google-and-sheet-route.md](docs/plan-google-and-sheet-route.md)
set out a complete Google route. Setup 1.0b built two parts of it: Google
Workspace with no identity provider, and a sheet or CSV as the HR source. The
other two, creating accounts and department groups for movers, are written
down there for anybody who wants to build them in their own copy.

## Where to go next

1. [docs/quickstart.md](docs/quickstart.md), and follow it in order. The order is the
   safeguard.
2. `jml store bootstrap` before you arm anything. It imports your HR history as tombstones,
   so a first run cannot read hundreds of historic leavers as fresh departures.
3. `jml doctor` until every row passes. It probes each credential and each delegated Google
   scope one at a time, and it always prints the age of the oldest parked row: a parked row
   takes no action and raises nothing, so over-suppression looks exactly like a quiet week.
4. `jml leaver dry-run --hris-id <id>` for one real person, and read the plan.
