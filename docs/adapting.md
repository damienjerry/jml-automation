# The idea, and how to make it fit your stack

This repository is two things. It is a working tool for one exact mix of
platforms, and it is a worked example of an idea that fits almost any mix. If
you run the same platforms, it is close to copy and paste: your credentials,
your field names, and a dry run. If you do not, this page explains what each
piece does and why, says honestly how hard each swap is today, and gives you
the rules to keep whatever you build.

## The idea in one paragraph

**Your HR system already knows who works for you.** It knows when somebody
starts and when they leave. Every IT account follows from that: an identity, a
mailbox, licences, a laptop, access to apps. So the HR system becomes the one
source of truth, and IT follows it. When somebody appears in HR, their account
is made ready for their first day. When HR says they have gone, their access
stops the day after their last day in, their files go to their manager, and a
week later their accounts are deleted. Nobody has to remember, nobody raises a
ticket to start it, and nothing depends on a spreadsheet somebody forgot to
update.

The industry term is **JML: joiner, mover, leaver**. Audits, security
questionnaires and larger companies use it, and it is worth knowing.

## What it does not do

Read this first, because it decides whether the toolkit fits.

- **It does not create accounts.** Something else must create the identity
  account and the mailbox when a starter appears in HR. Here, HiBob's own
  integration creates the JumpCloud account and JumpCloud's integration
  creates the Google one. The toolkit takes over from there: it activates,
  licenses and welcomes. With other platforms, check that your HR system or
  identity provider already provisions accounts, for example an identity
  provider's import from your HR system.
- **It does nothing for movers yet.** A role change updates the person's record
  and nothing else. No group, licence or app access changes because somebody
  moved.
- **It does not manage group membership or app access.** Leaving is handled for
  the identity account, the mailbox and files, licences and laptops. For every
  other app, the owner is told (from an app register) and a ticket can be
  raised.

## The mix this was built for

| Role | The platform used here | What it is for |
| --- | --- | --- |
| HR system (the source of truth) | HiBob | Who works here, start and leaving dates, manager, personal email, whether IT provisions for them |
| Identity provider | JumpCloud | The account a person signs in with, and the laptops bound to it |
| Email and files | Google Workspace | Mailbox, licence, auto-reply, file handover, sending the notifications |
| People store (the toolkit's own record) | SQLite, or a Notion database | One row per person, and where each person is in their lifecycle |
| Scheduler | n8n | Runs the pipeline every morning, and hosts two forms and one webhook |
| Notifications | Slack, email or the console | Tells IT and managers what happened |
| Ticketing (optional) | Suptask | A starter form that opens the activation gate; a leaver ticket for the manual steps |
| App register (optional) | A CSV or JSON file | Who owns each other app, so they can be told when somebody leaves |

**Why a people store at all, when HR already has everybody?** HR records who
people are. The toolkit also needs to record what it has done to each of
them: suspended on this date, files handed over, deleted. It needs that record
even for people HR has long since archived. That is the people store. It is
never deleted from, and it is what stops a leaver being offboarded twice.

**What has actually run.** The read-only half has run against one live tenant
on exactly this mix: every credential and scope checked, the HR read, the
history import and the dry-run decisions, which agreed with that estate's own
records. **No write has run against a real provider yet.** Suspending,
deleting, activating and sending mail are covered by tests only.
[SECURITY.md](../SECURITY.md#what-is-not-proven) keeps the full list.

**If this is your stack:** follow the README's install section, or
[quickstart.md](quickstart.md) step by step. The work is filling in your
credentials, mapping your HR system's field names, and reading the dry run
before you arm anything.

## What it does, step by step

Every morning the scheduler runs one pipeline, in this order:

1. **Read the HR system**, all of it, leavers included. A short or broken read
   stops everything, because a truncated list looks exactly like everybody
   leaving.
2. **Sync the people store.** Each person's status is worked out from HR alone:
   *hired* (starts in future), *active*, or *terminated* (no longer on the
   employed list, or past their last working day).
3. **Announce what changed**: new joiners, leavers, anybody odd. Only when
   something changed; a quiet day posts nothing.
4. **Joiners.** A few working days before somebody starts, the account that
   already exists for them is activated. It gets a temporary password that
   must be changed at first sign-in, a licence, and (on Google) the right
   organisational unit. The password goes to the starter's personal address,
   their manager and IT. The welcome to their work mailbox waits until that
   mailbox exists. An account somebody is already using is never touched.
5. **Leavers**, on a fixed timetable counted from the day after their last day:
   - **Day 0:** suspend the identity account, so they can no longer sign in
     anywhere it controls; set an auto-reply naming their manager; release
     the paid licence; tell the manager.
   - **Day 6:** hand their files to their manager, then suspend the mailbox
     account. The handover comes first because it needs the account.
   - **Day 7:** delete the accounts. Refused while a laptop is still bound to
     them, or while the file handover is unconfirmed.
6. **Tell the app owners** in the register, the day after somebody leaves, once
   each.

### The safety rules, and why each exists

These rules are the part worth copying even if you copy nothing else. Each one
comes from a real failure, recorded in [incidents.md](incidents.md).

- **Nothing happens until you arm it, and arming has three locks.** The config
  must say `mode: armed`. It must list each action you are arming in
  `armedActions`, for example `suspend` but not yet `delete`. And the command
  must be run with `--armed`. Missing any one of the three means a dry run.
  Arm suspension first and watch it for a week before you arm deletion.
- **Import your whole HR history first, as closed records** (`jml store
  bootstrap`). The toolkit calls a closed record a *tombstone*. Without them,
  the first run sees every person who ever left as a brand-new leaver.
- **A 200 is not proof.** After every change the toolkit reads the account back
  and records success only if it really changed.
- **Too many leavers at once stops the run.** A sudden crowd is almost always a
  data fault, not a redundancy round.
- **A person can be put on hold** (`jml leaver hold --reason "..."`), and then
  nothing touches them, the HR sync included.
- **Every step is written to an append-only audit log** before it happens and
  again after, so you can always prove what happened and when.

## How hard each swap is today

Honestly: the HR system, the people store, the scheduler and the ticketing
tool swap cleanly. The identity provider and the email platform do not yet.
JumpCloud and Google are wired into the configuration, the stored account ids,
the action names and the audit labels, so replacing either is a fork of those
parts rather than an adapter. The sizes below are measured from the reference
implementations, to give a sense of scale.

| Piece | Swap today | What changing it involves | Reference size |
| --- | --- | --- | --- |
| HR system | **setting, or small adapter** | export to a file (no code), or a two-method adapter plus its own config block and a build branch | HiBob: 2 files, ~650 lines |
| Scheduler | **setting** | cron instead of n8n; nothing to write | none |
| People store | **adapter** | implement `PeopleStore`, add its own config block and a `buildStore` branch, pass the shared test suite | Notion: ~600 lines |
| Ticketing | **adapter** | implement `TicketingAdapter`, add its own config block for its credentials and a `buildTicketing` branch | Suptask: ~160 lines |
| Notifications | **setting** | Slack, email or console already ship | none |
| Identity provider | **fork** | new connector, plus config keys, stored id field and audit labels | JumpCloud: ~1,600 lines, including devices and remote commands |
| Email and files | **fork** | new connector covering the whole Google surface, plus config keys and labels | Google: ~1,800 lines across 7 files |

"Fork" is not a reason to give up. It means the change touches shared parts,
so plan for it as a project rather than an afternoon.

### What you can try before building anything

If your identity provider or email platform is not JumpCloud and Google, you
can still run the HR half today, which is enough to judge the idea against
your own people. Point the HR adapter at an export file, and give the JumpCloud
and Google keys placeholder values (`JUMPCLOUD_API_KEY=placeholder`), because
the configuration still requires them. With that, these all run and act on
your real HR data:

| Command | What you see |
| --- | --- |
| `jml store bootstrap --armed` | your history imported as closed records, and a count that must be 0 before arming |
| `jml sync --armed` | who the toolkit thinks is hired, active and terminated, written to the local store |
| `jml detect` | the joiners and leavers it would announce |
| `jml store verify` | the exact set it would act on today |

What does not run until both connectors exist: `jml doctor`, which really
contacts JumpCloud and Google and fails, and any leaver or joiner dry run once
somebody is due, because planning one means looking up their accounts. Do not
put a real key from another system in those placeholders.

### A different HR system (BambooHR, Personio, Rippling, Workday, and others)

This is the swap most people need, and there are two ways to do it.

**Without writing code: export to a file.** The toolkit already reads a JSON
file as its HR system; that is what the demo uses. If your HR system can
export people on a schedule (a report, a script against its API, or an
integration tool), write it to this shape. Then set `hris.adapter: fixture`
and `hris.fixture.path`:

```json
{
  "fetchedAt": "2026-01-15T08:00:00.000Z",
  "complete": true,
  "activeIds": ["p-1001", "p-1002"],
  "people": [
    {
      "hrisId": "p-1001",
      "primaryEmail": "jane.doe@example.com",
      "displayName": "Jane Doe",
      "managerEmail": "john.doe@example.com",
      "startDate": "2019-05-06",
      "terminationDate": null
    }
  ]
}
```

`people` must hold **everybody**, including people who left years ago.
`activeIds` lists who is employed today. Dates are `YYYY-MM-DD`. Set
`complete` to `false` whenever the export may be partial; the toolkit then
refuses to act on it. Optional fields switch on the features that need them:
`personalEmail` for sending a starter's password, `lastWorkingDay` for
stopping access on the last day in rather than the contract end, and `inScope`
for people IT does not provision for, such as contractors on their own kit.
The full list is `HrisPerson` in [src/hris/types.ts](../src/hris/types.ts); the
file format is in [adapters/hris-fixture.md](adapters/hris-fixture.md).

Two cautions. This file adapter was built for the demo, and nobody has yet run
it against a live export. And **the toolkit cannot tell a stale file from a
quiet day**: if the export stops refreshing, yesterday's list is read again and
nobody new is detected as leaving. Regenerate the file immediately before each
run, and make the export job fail loudly rather than leave the old file in
place.

**With code: write an adapter.** The HR adapter is an interface with two
methods. `fetchAll()` returns everybody plus the employed set, and
`testConnection()` proves the credential works. The HiBob one in
[src/hris/hibob/](../src/hris/hibob/) is the reference; most of it is paging
and field mapping. The rules it follows are the ones yours must follow:

- read **everybody**, including leavers, and **page until the end**;
- work out who is employed from the HR system's own **employed list**, never
  from a status word, because status words mean different things in different
  systems;
- ask for dates in ISO form, and **never parse a date formatted for display**;
- if anything went wrong, **fail rather than return what you managed to read**;
- use **read-only** access. This toolkit never writes to the HR system.

Then add your adapter's name to `hris.adapter` and a config block for its
credentials in [src/config/schema.ts](../src/config/schema.ts), following
`hris.hibob`, and build it in `buildHris` in
[src/cli/commands/context.ts](../src/cli/commands/context.ts).

### A different identity provider (Okta, Microsoft Entra ID)

What the toolkit needs from it:

- **Leavers:** find a person's account by id or email, suspend it, delete it.
- **Joiners:** read whether the account is already in use, set a temporary
  password, and force a reset at next sign-in.
- **Laptops:** list the devices bound to a person, unbind them, and run a
  removal script on one machine. The code requires a device connector and a
  command connector even if you have no device management; see the caution
  below before you write one that does nothing.

The interfaces are `IdentityConnector`, `IdentityActivationConnector`,
`DeviceConnector` and `CommandTargeting` in
[src/connectors/types.ts](../src/connectors/types.ts). The JumpCloud
implementation in [src/connectors/jumpcloud/](../src/connectors/jumpcloud/) is
the reference. Beyond the connector, a swap has to touch:

- the `identity.jumpcloud` block in [src/config/schema.ts](../src/config/schema.ts);
- `buildProviders` in [src/cli/commands/context.ts](../src/cli/commands/context.ts),
  which builds JumpCloud unconditionally today;
- the stored id field `jumpcloudUserId` in [src/core/types.ts](../src/core/types.ts);
- the `'jumpcloud'` audit label in [src/engine/leaver/legs.ts](../src/engine/leaver/legs.ts).

**Laptops need care.** The deletion gate refuses to delete an account while a
laptop is bound to it, and it treats "could not check" as a refusal. If your
identity provider does not manage laptops, a device connector that honestly
reports "no devices" lets deletions through, and the gate then protects
nothing. If your laptops are managed somewhere else, that is where the device
connector should read from.

### Microsoft 365 instead of Google Workspace

What the toolkit needs: suspend the mailbox account, release licences, set an
auto-reply, hand files to the manager, delete the account, and send the
notification mail. For joiners, also assign a licence and say when the mailbox
exists.

The contract is the full `GoogleConnector` in
[src/connectors/google/index.ts](../src/connectors/google/index.ts), which
extends `GoogleWorkspaceConnector` and `GoogleProvisioningConnector` in
[src/connectors/types.ts](../src/connectors/types.ts). As with the identity
provider, the config keys, the stored `googleUserId` and the audit labels
assume Google. Most methods map directly to Microsoft Graph, with four
differences to plan for:

- **Files.** Microsoft has no single "transfer all files" call. The handover
  means granting the manager access to the leaver's OneDrive, which completes
  at once, where the Google transfer is a job the toolkit polls.
- **Organisational units.** Microsoft 365 has none. Leave
  `joiner.targetOrgUnitPath` blank and the move is skipped.
- **Licences** are Microsoft SKU ids, not Google's product and SKU pair.
- **Suspension.** If your identity provider signs people in to Microsoft 365,
  day 0 already stops them signing in. The day-6 suspension is then mailbox
  housekeeping rather than the moment access ends.

### No n8n

n8n only runs the schedule and hosts two forms; it holds no logic. Without it,
run `jml run --armed` each morning from cron, launchd or any scheduler. It
still needs `mode: armed` and `armedActions` in the config, so it is a dry run
until you arm actions there. Use the command line for the manual leaver and
device steps. [architecture.md](architecture.md#why-the-workflows-contain-no-logic)
explains why the logic lives in the toolkit rather than in the workflows.

### A different ticketing tool, or none

Ticketing is optional and off by default. Without it, joiner activation needs
no approval, or a person approves each one with `jml joiner approve`.
To use another tool, implement the four methods of `TicketingAdapter` in
[src/ticketing/types.ts](../src/ticketing/types.ts), with the Suptask one as
the reference. Then add it to `ticketing.adapter` in
[src/config/schema.ts](../src/config/schema.ts) and to `buildTicketing` in
[src/cli/commands/context.ts](../src/cli/commands/context.ts). Most of the
work is reading your tool's webhook for "a starter form was submitted".

### A different people store

SQLite needs no setup and is the right choice for almost everyone. Notion is
there for teams that already keep people records in Notion. A spreadsheet
store is designed but not built; [adapters/sheets.md](adapters/sheets.md)
describes it. Any other store means implementing `PeopleStore` in
[src/store/types.ts](../src/store/types.ts) and adding it to `buildStore` in
[src/cli/commands/context.ts](../src/cli/commands/context.ts). The shared test
suite in [src/store/conformance.ts](../src/store/conformance.ts) tells you
when it is right; [test/unit/store-notion.test.ts](../test/unit/store-notion.test.ts)
shows how to run it against your store.

## None of these tools

If you use none of these platforms, take the idea and the rules, not the code:

1. **Pick your source of truth**, and make sure you can read *everybody* from
   it, including leavers, with a clear "employed today" list.
2. **Make sure something creates accounts** when a starter appears. This
   toolkit's job starts after that.
3. **Keep your own record of each person** and where they are in the
   lifecycle, separate from the HR system. Never delete a closed record.
4. **Import your history as closed records** before anything runs.
5. **Work out each person's status from HR alone** each morning, and act only
   on what changed.
6. **Run leavers on a fixed timetable:** suspend, then hand over, then delete.
   Only delete once the handover is confirmed and no laptop is outstanding.
7. **Prove every change by reading it back**, and log both the intent and the
   outcome.
8. **Default to a dry run**, and arm one action at a time.

[state-machine.md](state-machine.md) sets out the lifecycle in full, and
[incidents.md](incidents.md) explains why each rule exists.

## Keeping your version current

If you adapt it, keep your adapters in their own files and change as little of
the shared code as you can. That keeps pulling upstream fixes a small merge
rather than a rewrite. The shared test suites (the store conformance suite,
and the regression tests in `test/regression/`) are how you know a fix from
upstream still holds in your version.

## Using an AI assistant to adapt it

The repository is written to be read by coding assistants as well as people.
Point Claude, Codex or Gemini at [AGENTS.md](../AGENTS.md) and this page, then
say what you run, for example "we use BambooHR, Okta and Microsoft 365". Ask
for a plan first, not code. Check its plan against the table above, so you know
where it is proposing a fork. Keep the dry run and the three arming locks in
whatever it builds.
