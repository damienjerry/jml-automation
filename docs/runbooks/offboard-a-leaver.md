# Runbook: offboard a leaver

Use this when somebody has left and the HR system knows it. If the HR record is
right, there is nothing for you to type: the scheduled run picks the person up
on the day their leaving date passes and works through three phases over a week.
This runbook is here so you can tell what is about to happen, read the
notifications, and stop it.

**No write in this toolkit has ever run against a real tenant.** Reads have (one
shadow run before this release); suspensions, transfers and deletions have not. Every
output quoted below is real, produced by the offline demo or by the CLI against
a file-based HR fixture and unreachable providers. Treat the first week on your
own estate as a rehearsal: `mode: dry-run` and an empty `armedActions` list are
the shipped defaults, and they exist so that the first thing you see is a plan.

The statuses, flags and markers used below are defined once, in
[../state-machine.md](../state-machine.md). Every key named here is in
[../config-reference.md](../config-reference.md).

## The three phases

`suspendedAt` is the clock. It is written once, on day 0, and every later phase
is counted from it rather than from the leaving date, so a run missed on a
Sunday does not skip a phase.

| Phase | Due | Steps, in order | Config |
| --- | --- | --- | --- |
| Day 0 | leaving date has passed | `suspend_idp`, `set_autoreply`, `revoke_licence`, `signout_google` | `leaver.terminationLookbackDays` |
| Day 6 | 6 days after `suspendedAt` | `transfer_drive`, `suspend_google` | `leaver.transferDay` |
| Day 7 | 7 days after `suspendedAt` | `delete_idp`, `delete_google` | `leaver.deleteDay` |

Day 6 and day 7 select **on or before** their day, never on the day exactly. A
missed run means the hand-over happens late, not that it is skipped while the
deletion arrives anyway.

Day 7 is refused unless every gate is open. See
[clear-a-blocked-deletion.md](clear-a-blocked-deletion.md).

## Look at one person first

```
jml leaver show --hris-id p-1004
```

```
Sam Rivera  (p-1004)
  status          terminated
  address         sam.rivera@example.com
  also known as   nothing else recorded
  manager         jane.doe@example.com
  leaving date    2026-09-04
  hold            no
  parked          identity_mismatch
  google account  not read yet
  provider ids    none
  note            neither provider could confirm an account, and at least one lookup failed, so nothing was touched
```

`--email jane.doe@example.com` works too, and is refused rather than guessed
when more than one row holds that address. The HR id is the identity the
toolkit uses; a name is never an id.

Read three fields before anything else:

- **status** `terminated` means day 0 is due. `offboarding` means day 0 has
  run. `departed` is the end, and nothing can move a row out of it.
- **hold** and **parked**. Either one excludes the person from every selection.
  A parked or held row is silent, so `jml store verify` and `jml doctor` both
  print the counts whether you asked or not.

## Rehearse it

```
jml leaver dry-run --hris-id p-1004
```

A dry run touches no provider, writes no status and sends no mail. The
notifications it would have sent are printed with a `[DRY RUN]` subject. This is
what a day-0 rehearsal looked like against providers that answered 401:

```
--- notification (leaver.parked) would be sent to IT ---
subject: [DRY RUN] Parked for review (identity_mismatch): Sam Rivera

Parked for review: Sam Rivera (sam.rivera@example.com)

- Reason: identity_mismatch
- HR id: p-1004
- Leaving date held by the HR system: 2026-09-04
...
neither provider could confirm an account, and at least one lookup failed, so nothing was touched

--- end notification ---
run <runId>  leaver  dry-run  ok=true
  counts: parked=1 selectedDay0=1
  Sam Rivera      parked  terminated -> terminated  parked: identity_mismatch
      neither provider could confirm an account, and at least one lookup failed, so nothing was touched
```

That is the behaviour to expect from a broken credential: the row parks and
nothing is touched. A failed lookup is never read as "this person has no
account".

Drop `--hris-id` to rehearse everybody who is due. The circuit breaker counts
the day-0 selection first and aborts the whole run if it is larger than
`leaver.maxDay0PerRun`, **including in a dry run**, because a rehearsal is
exactly when you want to be told that today's selection is forty people.

## Run it

The scheduled path is the whole pipeline, in one lease, in order:

```
jml run --armed
```

Sync, then detect, then the leaver engine. They are one run rather than three
schedules because the ordering is the thing that matters: the engine must act on
the picture this run read, not on yesterday's.

One person, out of schedule:

```
jml leaver run --hris-id p-1004 --armed --actor jane.doe@example.com
```

`--armed` is not enough on its own. `mode` must be `armed` and each action must
be listed in `armedActions`, so you can arm `suspend` alone and leave `delete`
off for a month. An action that is not armed records `not_armed` and does
nothing. `--actor` names you on every audit row this run writes; without it the
run is recorded as `system:cli`.

### What a real day-0 run prints

From the offline demo, which uses fake providers that record every call:

```
run demo-day0  pipeline  armed  ok=true
  counts: day0=3 detect.actionable=3 detect.leaver=3 detect.potentialLeaver=1 hrisEmployed=3 hrisPeople=7 selectedDay0=3 sync.scanned=7 sync.skipped_no_email=1 sync.status_changed=4 sync.unchanged=2
  Robin Ellis     day0    terminated -> offboarding
      revoke_licence=done(verified) set_autoreply=done(verified) signout_google=done(verified) suspend_idp=done(verified)
      identity provider account suspended, read back
      auto-reply set on the mailbox
      revoked 1 licence(s): example-standard
      sign-out of every Google session requested (Google cannot confirm it), and 0 third-party app grant(s) revoked, read back as none left
```

`done(verified)` is the only outcome that counts. `verified` means the write was
read back from the provider afterwards. A 200 from an API is not an effect, and
the day-0 marker is written only when the suspension was read back: an earlier
generation of this automation wrote its progress marker even when every step had
failed, so a broken run looked finished and was never retried. That one and the
rest of the catalogue are in [../incidents.md](../incidents.md).

One step is only half readable. For `signout_google`, `verified` means a fresh list
of the account's third-party grants came back empty; Google has no way to read
sessions back, so the sign-out itself is requested, and the line says so.

## The manager email, and the dated deletion line

On day 0 the line manager gets this. It is the only message a person outside IT
receives, and the two dates in it are the ones you will be asked about:

```
jane.doe@example.com,

Robin Ellis has left Example Organisation, so their IT access was suspended today,
2026-01-15.

What has been done:

- suspend_idp: identity provider account suspended, read back
- set_autoreply: auto-reply set on the mailbox
- revoke_licence: revoked 1 licence(s): example-standard
- signout_google: sign-out of every Google session requested (Google cannot confirm it), and 0 third-party app grant(s) revoked, read back as none left
```

The rest of the template says that on the transfer day the leaver's Drive
contents become the manager's, and that on the deletion day the accounts go
permanently. **Both dates are computed from `suspendedAt`, not from the leaving
date**, so a person suspended late has a late deletion date, and the date in the
email is the real one.

Turn this message off with `mail.managerOnDay0: false`. The IT copy is separate
and is not affected.

## How to tell it went wrong

Read the counts line, not the absence of noise.

| Signal | Meaning | Where to go |
| --- | --- | --- |
| `ok=false` and `ABORTED:` | the run refused before doing anything | [incident-recovery.md](incident-recovery.md) |
| `parked=` above zero | a row needs a person to decide; nothing automatic will touch it again | [hold-and-release.md](hold-and-release.md) |
| `blocked=` above zero | day 7 was refused by a gate | [clear-a-blocked-deletion.md](clear-a-blocked-deletion.md) |
| `failedLegs=` above zero | a step failed and will be retried; `leaver.maxAttemptsPerLeg` failures park the row | `jml leaver show` |
| a warning naming a notification | the work happened and nobody was told | check the notifier with `jml doctor` |

Two silences are not the same and both matter:

- A **parked** row raises one notice and then nothing. Over-suppression looks
  exactly like a quiet week, so `jml doctor` always prints the age of the oldest
  parked row.
- A **blocked** deletion is announced when the blocking set changes and
  re-raised once a week. Silence means the same blockage, not a resolved one.

Then read the audit log, which is the record of what was asked for rather than
what was reported:

```
jml audit tail --lines 20
jml audit verify
```

## How to stop it

Fastest first.

| Scope | Action | Effect |
| --- | --- | --- |
| One person | `jml leaver hold --hris-id p-1004 --reason "..."` | that row is frozen against every automation, including the HR sync |
| The next scheduled run | deactivate the `jml-pipeline` workflow in n8n | no run starts |
| Every write, everywhere | set `JML_DRY_RUN=true` for n8n, or `mode: dry-run` in `jml.config.yaml`, then recreate the `jml` service | runs continue and plan only |
| One action | remove it from `armedActions` and recreate the `jml` service | that step records `not_armed` |

A run already in flight is not interruptible from outside. It holds a lease for
up to 15 minutes; a second run started meanwhile skips rather than overlapping.

## What this will not do

- **It never unsuspends anybody.** There is no unsuspend call in any connector.
  If the HR system says a suspended person is employed again, the row is frozen
  and parked as `reinstated_after_day0` and a person decides. See
  [incident-recovery.md](incident-recovery.md).
- **It does not create or change accounts.** This release is leaver-only.
  Joiners and movers are recorded and announced; nothing is provisioned.
- **It does not unbind or wipe devices as part of offboarding.** A bound machine
  blocks the deletion and waits for you. See
  [device-return-or-handover.md](device-return-or-handover.md).
- **The Azure and Slack SCIM legs do not run.** They are interfaces only, fixed
  to `false` in the schema, and start-up refuses if you supply their
  credentials: a credential present for a step that cannot run reads as
  coverage that does not exist.
