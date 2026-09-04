# Quickstart: the first hour

Follow these steps in order. The order is the safeguard, not a convention: the bootstrap
step exists so that the first real run cannot mistake your HR history for a hundred fresh
departures, and the staged arming exists because each stage is reversible by hand and the
next one is less so.

Nothing here has ever run against a real tenant, so there is no passing `jml doctor`
transcript in this file. Every output below is real output from the offline paths.

| Step | Command | Touches a provider? |
| --- | --- | --- |
| 1 | `node bin/jml.mjs demo` | no. No credentials, no network, no files |
| 2 | `jml init` | no |
| 3 | fill in `.env` | no |
| 4 | `jml doctor` | reads only, one call per credential and per scope |
| 5 | `jml store bootstrap` | reads the HR system, writes your local store |
| 6 | `jml store verify` | no |
| 7 | `jml sync --armed` | reads the HR system, writes your local store |
| 8 | `jml detect` | reads only |
| 9 | `jml leaver dry-run --hris-id <id>` | reads only |
| 10 | arm `suspend`, watch one cycle | writes |
| 11 | arm `transfer` | writes |
| 12 | arm `delete` | writes, irreversibly |
| 13 | import the n8n bundle | schedules the above |

## 1. Run the demo

```
git clone <this-repository> jml-toolkit
cd jml-toolkit
npm ci
npm run build
node bin/jml.mjs demo
```

It ends with:

```
The demo finished with every run ok.
Nothing left this process: no network call, no credential, no file written.
```

Read the whole thing once. It walks day 0, day 6 and day 7, and the deletion it refuses
because a laptop is still bound is the behaviour worth understanding before you go further.
The [README](../README.md) quotes that refusal.

**If it fails:** `jml is not built yet` means `npm run build` did not run, or ran in a
different directory. A Node version message and exit code 78 means Node is older than
22.13; the CLI checks before loading anything, rather than failing halfway.

**`jml` on its own is not a command yet.** A clone puts nothing on your `PATH`, so every
step below that reads `jml <something>` is `node bin/jml.mjs <something>` run from the
clone. If you would rather type `jml`, either

```
npm link          # puts jml on your PATH, from this clone
```

or add the shorthand to your shell for the session:

```
alias jml="node $PWD/bin/jml.mjs"
```

Both leave the tool reading `jml.config.yaml` from whatever directory you run it in.

## 2. `jml init`

```
node bin/jml.mjs init
```

Real output:

```
wrote jml.config.yaml  (edit this: org, domains, timezone, headcount floor)
wrote .env        (mode 600; fill in the credentials. A random sidecar token and
                   audit salt are already set)

The generated files carry every key with its default and its documentation.
Nothing is armed: mode is dry-run and armedActions is empty, so a first run
plans and reports without touching a provider.

Next:
  jml demo                 watch the whole lifecycle with no credentials at all
  jml store bootstrap      import your HR history as tombstones BEFORE arming anything
  jml doctor               prove every credential and per-scope authorisation
```

Both files are generated from `src/config/schema.ts`, so they cannot drift from what the
code reads. `.env` is created mode 600 and already holds a random sidecar bearer token and
a random audit salt.

Now edit `jml.config.yaml`. Five values have no sensible default and one of them is a safety
floor:

| Key | Why you have to decide it |
| --- | --- |
| `hris.adapter` | The generated file says `fixture`, pointed at the seven-person demo file, so that a first run cannot read a real HR system by accident. Change it to `hibob` and fill in the `hris.hibob` block. Left on `fixture`, everything below runs against the demo people and tells you nothing about your own. |
| `org.primaryDomain`, `org.aliasDomains` | Two systems keyed on different domains for one person is how an identity join silently diverges. |
| `org.timezone` | An IANA zone. Every date-only calculation happens in it, never in UTC. A day boundary read in UTC is how a leaver is processed a day early or late. |
| `hris.minPlausibleHeadcount` | Required, with no default. A snapshot smaller than this aborts the run. A truncated HR read looks exactly like a company where everybody left, and the cost of believing it is suspending your whole staff, so you state your own floor rather than inheriting a guess. |
| `leaver.maxDay0PerRun` | Circuit breaker, default 5. More day-0 candidates than this aborts the whole run rather than processing the first few, because a sudden crowd of leavers is a data fault far more often than a redundancy round. Raising it for one run needs `--allow-bulk` and a named `--actor`. |

An unknown key is a start-up failure, so a typo in a safety flag cannot quietly disable it.

The shipped combination of `fixture` and a floor of 25 does not run: the demo file holds
seven people, so the first command that reads the HR system stops with
`holds 7 people, below the stated floor of 25`. That is deliberate. If you want to rehearse
the store and sync commands against the demo people before you have any credential, do it in
a separate configuration rather than the one you will point at your tenant:
[docs/adapters/hris-fixture.md](adapters/hris-fixture.md) has the four settings to change,
including pointing the rehearsal at its own store and audit directory so it cannot write into
the real one.

## 3. Fill in the credentials

`.env` holds the values. `jml.config.yaml` holds only references to them:

| Form | Meaning |
| --- | --- |
| `env:NAME` | the value of that environment variable |
| `file:/path` | the trimmed contents of that file |
| `op://<vault>/<item>/<field>` | read through the 1Password CLI |

Reference a secret-manager item by its **UUID, not its title**. A title reference works
until somebody renames the item, and then it fails at the next scheduled run with nobody
watching.

**The CLI does not read `.env` by itself.** Docker Compose does, through `env_file`. Running
the CLI directly, export it first:

```
set -a; . ./.env; set +a
```

What you need, in short. [docs/credentials.md](credentials.md) has the per-integration
console paths, the exact minimum permission set and the rotation procedure, and it is
cross-checked against `src/connectors/google/scopes.ts` and
`src/connectors/jumpcloud/scopes.ts` by a test.

| Integration | Credential | Note |
| --- | --- | --- |
| HR system (HiBob) | service user id and token | **Read only.** The toolkit needs no HiBob write at all. If your existing service user has write for an asset sync, that is a different consumer, not a requirement of this. |
| JumpCloud | one admin API key | The key inherits its owner's admin role. A read-only admin satisfies every read, including the device gate, so a report-only deployment needs nothing more. Some tenants answer only on `console.jumpcloud.com/api` and return 404 on the other host for every request, valid key or not. |
| Google | service account JSON, domain-wide delegation | `file:/path/to/key.json` is the usual reference form. Grant the scope strings from `src/connectors/google/scopes.ts` **exactly**, one at a time, in the Admin console. |
| Google, again | the subject matters | Six scopes are delegated to a person and the subject differs per scope: both directory scopes, licensing and transfer impersonate your admin; the leaver's auto-reply impersonates the leaver, because only their own token can change their own responder; outbound mail impersonates the sender mailbox. Two further scopes are optional and take no subject at all. |
| Slack | bot token, optional | Notifications only. `console` is the default notifier so a first run needs no credential. |

Google tokens are minted **one scope per JWT**. A bundled multi-scope JWT fails wholesale
when any single scope is undelegated, which is what makes a partial grant look identical to
no delegation at all. `jml doctor` probes them separately for that reason.

## 4. `jml doctor` until every row passes

```
jml doctor
```

Doctor turns a configuration error into failing rows rather than ending the command, because
the moment you most need the table is when a credential will not resolve. Before you fill
anything in, that is what you get:

```
jml doctor  2026-09-04T15:03:50.895Z

FAIL  hris.hibob.serviceUserId            could not resolve secret reference env:HIBOB_SERVICE_USER_ID: environment variable HIBOB_SERVICE_USER_ID is not set. See docs/config-reference.md#secret-references
                                          see docs/config-reference.md#secret-references
FAIL  hris.hibob.serviceToken             could not resolve secret reference env:HIBOB_SERVICE_TOKEN: environment variable HIBOB_SERVICE_TOKEN is not set. See docs/config-reference.md#secret-references
                                          see docs/config-reference.md#secret-references
FAIL  identity.jumpcloud.apiKey           could not resolve secret reference env:JUMPCLOUD_API_KEY: environment variable JUMPCLOUD_API_KEY is not set. See docs/config-reference.md#secret-references
                                          see docs/config-reference.md#secret-references
FAIL  google.serviceAccountJson           could not resolve secret reference env:GOOGLE_SERVICE_ACCOUNT_JSON: environment variable GOOGLE_SERVICE_ACCOUNT_JSON is not set. See docs/config-reference.md#secret-references
                                          see docs/config-reference.md#secret-references
FAIL  audit.salt                          could not resolve secret reference env:JML_AUDIT_SALT: environment variable JML_AUDIT_SALT is not set. See docs/config-reference.md#secret-references
                                          see docs/config-reference.md#secret-references
FAIL  server.token                        could not resolve secret reference env:JML_API_TOKEN: environment variable JML_API_TOKEN is not set. See docs/config-reference.md#secret-references
                                          see docs/config-reference.md#secret-references

6 check(s) failed
```

The exit code is 78: a configuration that will not load, as opposed to a configuration that
loaded and whose checks failed, which is 1. Once `.env` is exported, the two rows `jml init`
already filled in stop failing, and an empty variable is reported as a different thing from
a missing one:

```
FAIL  hris.hibob.serviceToken             could not resolve secret reference env:HIBOB_SERVICE_TOKEN: environment variable HIBOB_SERVICE_TOKEN is set but empty. See docs/config-reference.md#secret-references
```

Each row prints as `pass`, `FAIL` or `skip`, followed by the check name and the detail. A
failing row also prints its remediation and a documentation anchor. The rows are, in order:

| Row | What it means |
| --- | --- |
| `configuration` | Which file was loaded, the mode, and what is armed. |
| `credential <path>` | One row per resolved reference: where it came from and how many characters. Never the value. |
| audit directory, state store | Writable, and the hash chain readable. |
| `people store` | The adapter, the row count, the tombstone count, and how many rows would start offboarding today. |
| `HR system` | One live paged read plus the headcount plausibility check. |
| `identity provider` | Which host answered and what the key can do. |
| `google workspace`, then one row per scope | Each delegated scope probed separately, naming what breaks without it. |
| `notifications` | The configured notifier answered. |
| parked rows | Always printed, with the age of the oldest. |

That last row is not a formality. A parked row takes no action and raises nothing, so
over-suppression looks exactly like a quiet week. The age of the oldest parked row is the
one number that tells them apart.

`--probe-writes` adds the Slack write probe, which posts a message and deletes it.

**Common failures**

| Symptom | Cause |
| --- | --- |
| every JumpCloud call 404s, valid key | Wrong host. Set `identity.jumpcloud.baseUrl` to the console host. |
| Google `unauthorized_client` on one scope, others fine | That scope string is not delegated, or is mistyped in the Admin console. A mistyped scope is indistinguishable from an ungranted one, which is why the strings live in code. |
| Google fails on the auto-reply scope only | It is delegated for the wrong subject. That one is minted for the leaver, not for your admin. |
| HR system row fails the plausibility check | Either your `minPlausibleHeadcount` is too high, or the read really was truncated. Do not lower the floor to make the row green. |
| start-up refuses over an Azure or Slack SCIM credential | Those legs do not run in this release. Unset the variable. |

## 5. `jml store bootstrap` before you arm anything

Run this **before** anything is armed. Every historic leaver in your HR system is somebody
the toolkit has never seen. Without this step they are all new terminations on the first run.

That is not hypothetical. In the automation this was ported from, a data migration pruned the
tombstone rows, the next sync read hundreds of historic leavers as brand new terminations,
and the engine began suspending accounts that had been closed for years. The regression test
is `test/regression/tombstones-pruned-refire.test.ts`.

It rehearses unless you pass `--armed`:

```
BOOTSTRAP REHEARSAL (nothing was written)

scanned          7
not employed     4
tombstoned       4
already present  0   (left exactly as they were, whatever their status)
skipped: employed 3
skipped: no email 0

tombstones after   0
day-0 selection    0   (this must be 0 before you arm anything)

nothing would start offboarding, which is the whole point of this command
```

Read `day-0 selection` before you go on. If it is not 0, stop and find out why.

Then apply it:

```
jml store bootstrap --armed
```

```
bootstrap applied

scanned          7
not employed     4
tombstoned       4
already present  0   (left exactly as they were, whatever their status)
skipped: employed 3
skipped: no email 0

tombstones after   4
day-0 selection    0   (this must be 0 before you arm anything)

nothing would start offboarding, which is the whole point of this command
```

`already present` rows are left exactly as they were, whatever their status, so running this
twice is safe and running it on an established store changes nothing.

There is a second, independent guard behind this one. The sync never creates a row whose
derived status is `terminated`: a person who is not in the employed set and not already in
the store is recorded as `skipped_historic_leaver` and no row is made. You can see it in the
sync counts. Both guards exist because one of them can be undone by a migration and the
other cannot.

## 6. `jml store verify`

```
jml store verify
```

```
store          sqlite
total          4
hired          0
active         0
terminated     0
offboarding    0
departed       4   (tombstones: these are what stop a re-fire)
held           0
parked         0
day-0 today    0   (the set a run would act on)

every stated expectation held
```

State what you expect and let it check, rather than reading the numbers and forming an
impression:

```
jml store verify --expect-day0 0 --expect-departed 4
```

A mismatch prints the table, names the discrepancy and exits 1:

```
MISMATCH: Day-0 selection is 0, expected 2.
```

Run this on both sides of any store migration and compare the numbers.

## 7. `jml sync --armed`

```
jml sync --armed
```

The sync reads the HR system and writes your local people store. It touches no provider,
whatever `--armed` says, because provider work is armed separately per action in
`armedActions` and that list is still empty. `--armed` here means "write to my own store".

Without `--armed` the sync plans and writes nothing, which is worth knowing: a dry-run sync
followed by `jml leaver show` reports that the person does not exist, because no row was
created.

The counts line is the report:

```
run <run-id>  pipeline  armed  ok=true
  counts: hrisEmployed=4 hrisPeople=7 sync.created=3 sync.scanned=7 sync.skipped_historic_leaver=3 sync.skipped_no_email=1
```

| Count | Meaning |
| --- | --- |
| `sync.created`, `sync.updated`, `sync.unchanged` | Ordinary work. |
| `sync.status_changed` | A row moved through the state machine. The only route into offboarding is `active` to `terminated`. |
| `sync.preserved` | Status left alone because the offboarding engine owns the row. Names and departments are still patched. |
| `sync.skipped_historic_leaver` | The second re-fire guard, above. |
| `sync.skipped_no_email` | A person with no work address stays in the snapshot with an empty address. Dropping them here would look exactly like somebody leaving. |
| `sync.parked`, `sync.auto_held`, `sync.held`, `sync.refused` | Something needs a person. See the run summary. |

Run it once and read the numbers against your own headcount. `hrisPeople` is everybody the
HR system returned; `hrisEmployed` is the employed subset. If those two look wrong, stop.

## 8. `jml detect`

```
jml detect
```

Detection announces joiners and leavers, and only when the set has changed. A schedule
firing is not news, and a fact that has not changed is not a report. When there is nothing
new it says so and posts nothing:

```
INFO  lifecycle detect finished counts={"joiner":0,"leaver":0,"potentialLeaver":0,"actionable":0} gate=nothing_to_report announced=false
```

`gate` is the change gate's reason and is worth reading: `nothing_to_report`, `first_sight`,
`changed`, `unchanged`, `weekly_reraise`, or `state_unavailable`. The last one means the gate
could not read its own bookkeeping and announced rather than guessing. The failure direction
of a change-only gate is silence, and silence is indistinguishable from a fixed problem, so
everything that goes wrong here announces instead of withholding.

## 9. `jml leaver dry-run` for one real person

Pick one person who has actually left, get their HR id, and read the plan before you arm
anything.

```
jml leaver show --hris-id <id>
```

```
Robin Ellis  (p-1003)
  status          terminated
  address         robin.ellis@example.com
  also known as   nothing else recorded
  manager         jane.doe@example.com
  leaving date    2026-01-15
  hold            no
  parked          no
  google account  not read yet
  provider ids    none
```

Then:

```
jml leaver dry-run --hris-id <id>
```

A dry run reads the providers. It has to: the plan depends on which accounts exist, what the
transfer state is, and which devices are bound. It writes nothing and calls no mutating
endpoint.

This is what it looks like when the provider lookups fail, which on a first attempt usually
means a credential or a scope:

```
--- notification (leaver.parked) would be sent to IT ---
subject: [DRY RUN] Parked for review (identity_mismatch): Robin Ellis

Parked for review: Robin Ellis (robin.ellis@example.com)

- Reason: identity_mismatch
- HR id: p-1003
- Leaving date held by the HR system: 2026-01-15

No automatic action will be taken for this person until somebody clears the
reason. Parked rows are counted in every run summary, because the failure mode
of a safety rule is silence: a row that is quietly excluded looks exactly like a
row that has nothing to do.

neither provider could confirm an account, and at least one lookup failed, so nothing was touched

--- end notification ---
WARN  a row was parked for review hrisId=p-1003 reviewReason=identity_mismatch
run cli-leaver-<timestamp>  leaver  dry-run  ok=true
  counts: parked=1 selectedDay0=1
  Robin Ellis     parked  terminated -> terminated  parked: identity_mismatch
      neither provider could confirm an account, and at least one lookup failed, so nothing was touched
```

Note what it did not do. It did not treat a failed lookup as "no account exists" and move on.
"No such account" and "could not tell" are opposite facts, and collapsing them into one
nullable result is how a failed read becomes a deletion, so the resolver returns three cases
and an unreadable one parks the row.

**Reading a healthy plan.** Each leg prints as `name=state`, with `(verified)` when the
result was read back. `planned` is what a dry run records. `not_armed` means the leg would
have run but that action is not in `armedActions`. `blocked` on the person line names one of
`devices_bound`, `transfer_incomplete`, `identity_mismatch`, `awaiting_ack` or `gate_error`.
`parked` means a person has to look.

Do this for several real leavers before step 10. If a plan surprises you, that is the whole
value of the step.

## 10. Arm suspend, and only suspend

In `jml.config.yaml`:

```yaml
mode: armed
armedActions:
  - suspend
```

Then run it for one person:

```
jml leaver run --hris-id <id> --armed --actor "your.name"
```

Both locks now agree for `suspend` and for nothing else. The auto-reply, the licence, the
transfer and both deletions record `not_armed` and say what they left alone.

Watch one full cycle before going further, and check three things:

1. The identity provider account really is suspended, in the provider's own console. The leg
   reports `suspend_idp=done(verified)` because it read the account back, but read it
   yourself the first time.
2. The manager notification went where you expected.
3. `jml doctor` still shows no parked rows accumulating.

`--actor` puts your name on every audit row the run writes. Without it the actor is
`system:cli`, which is right for a cron entry and is also what refuses the circuit-breaker
override: raising the day-0 limit is a decision somebody signs for, so it needs a name.

**Suspension is the reversible stage, and the engine will not reverse it for you.** There is
no unsuspend path. If you suspend the wrong person, un-suspend them in the provider console,
then `jml leaver hold --hris-id <id> --reason "..."` so no further automation touches the
row. A hold freezes the row against every automation, including the HR sync.

Add `autoreply` and `licence` next, in the same way. Both are recoverable by hand.

## 11. Arm the hand-over

```yaml
armedActions:
  - suspend
  - autoreply
  - licence
  - transfer
  - google_suspend
```

The transfer hands the leaver's files to their manager through the Google data transfer API,
then suspends the Google account. Two things about it:

- **Completion means the provider said the job finished**, not that the toolkit asked. The
  transfer id is written to the row before the first poll, so a run that dies mid-transfer
  resumes the one it started rather than starting a second for the same person, and
  `transferredAt` is written only on a polled `completed`. Until then, deletion stays
  blocked, because deleting the account first destroys the files the transfer was meant to
  move.
- **If no manager resolves**, the row parks rather than guessing a recipient.
  `google.driveTransfer.fallbackRecipient` is `null` by default, and null means "a person
  decides".

One run does not wait indefinitely. `google.driveTransfer.pollTimeoutMinutes` (default 30)
bounds the wait, and the next run re-polls. A timeout is never read as success.

## 12. Arm deletion

```yaml
armedActions:
  - suspend
  - autoreply
  - licence
  - transfer
  - google_suspend
  - delete
```

This is the irreversible stage. Four gates stand in front of it, and each one is a recorded
failure written down as code:

| Gate | Blocks when | Why |
| --- | --- | --- |
| hand-over | the transfer is not confirmed complete | Deleting the account destroys every file it still owns. `leaver.requireTransferBeforeDelete`, default true. |
| identity | an address or account id is claimed by somebody who still works here | A leaver's row once inherited a live colleague's account id and suspended them on the day the leaving date passed. |
| device | a machine is directly bound to the person | Deleting the account removes the only channel to that machine and takes its escrowed disk-encryption key with it. |
| acknowledgement | `leaver.requireOperatorAck` is on and nobody has run `jml leaver ack` | For adopters who want a person in the loop on every deletion. |

Two of these are marked not overridable in the schema:

- `leaver.deviceGate.failClosed` is fixed true. A gate that cannot be read blocks. Reading an
  error as "no devices" is how an account gets deleted while the machine is still out there.
- `leaver.deviceGate.directBindingsOnly` is fixed true. Membership of a group that grants
  access to a machine is not custody of it, so only a direct binding blocks a deletion.

Before you arm this, decide two things:

- `leaver.deleteGoogleUser` false stops at suspension, so a mailbox can be archived by hand.
- `leaver.requireOperatorAck` true means no deletion happens without a named human ack.

`jml leaver tombstone --hris-id <id> --reason "..."` closes a row by hand without any account
work, for the rows you would rather finish yourself.

**Do not arm `device_unbind` or `device_handover` yet.** The handover path runs an uninstall
script on a machine, and neither shipped script has ever run on real hardware:
`src/engine/device/scripts/manifest.json` records `provenOnHardware: false` for both. A
handover is refused on an unproven platform unless you name the machine you canaried it on.
The procedure is [docs/runbooks/canary-a-device-script.md](runbooks/canary-a-device-script.md),
and `jml device preflight` reads a machine and prints every reason a disposition would be
refused, without changing anything.

## 13. Schedule it with the n8n bundle

Only after a full cycle has run by hand and you have read the audit log.

```
docker compose up -d
```

The compose file runs the sidecar and a version-pinned n8n side by side. The sidecar
publishes **no** port: it is reachable at `http://jml:8787` on a private network and from
nowhere else. Publishing it would put an endpoint that can delete accounts on your host
interface behind one bearer token.

Import the five workflow files through the n8n editor, in the order
[n8n/README.md](../n8n/README.md) gives. `jml n8n import` does not work in this release and
tells you so:

```
cannot find n8n/import.mjs. These scripts live in the repository rather than in the installed package, so run this from a clone. If the file is not in your checkout either, this release does not ship it and the workflow bundle documents doing that step by hand.
see n8n/README.md
```

Import `jml-on-error.json` first. The other four name it as their error workflow and n8n
stores that reference as an id, so the target has to exist before the reference means
anything. Then, for each of the four: Settings, Error Workflow, pick `jml-on-error`. Until
you do, a failure in that workflow alerts nobody, which is the state the original estate was
in for its whole life.

Everything imports inactive on purpose. Read a workflow, run it once by hand, then activate
it.

Three credentials in n8n, and only the first belongs to this toolkit: `JML Toolkit API`
(Header Auth, `Authorization` = `Bearer <JML_API_TOKEN>`), `JML Slack Alerts`, and
`JML Form Access` (Basic Auth). Match the names exactly; n8n binds them on import by name.
`JML Form Access` is not optional: a form trigger is reachable by anyone who can reach n8n,
and two of these forms suspend accounts and remove device records.

Two environment variables the workflows read for themselves: `JML_API_URL` and
`JML_DRY_RUN`. `JML_DRY_RUN` is read as `$env.JML_DRY_RUN !== 'false'`, so anything except
the exact string `false` means dry run. An unset or misspelt variable changes nothing on a
real tenant. Leave it alone until you have watched a scheduled run.

**Prove the schedule fires** rather than assuming it. Set a temporary `*/2` cron on the
pipeline workflow, watch two executions appear, then restore the real schedule. A schedule
that silently stopped firing looks exactly like a quiet week, and the n8n image is pinned to
an exact version in the compose file for the same reason.

The full bundle documentation, node by node, including how to read a red execution and the
two `409` skips that are normal operation rather than failures, is
[n8n/README.md](../n8n/README.md).

## After the first hour

- `jml audit tail` and `jml audit verify`. The chain check reports, for example,
  `the audit chain in ./audit is intact across 6 rows`, and names the first line that does
  not check out if one does not.
- `jml store backup` writes a consistent copy of the people and state databases.
- `jml doctor` daily, ahead of the scheduled run. The shipped doctor workflow runs fifteen
  minutes before the pipeline, so a credential that has stopped working is known before the
  run that needs it rather than after.
- Rotating a credential is: edit `.env`, restart the sidecar, re-run `jml doctor`. If you
  reference secrets through a secret manager, reference the item by UUID; a title reference
  breaks the moment somebody renames the item.
