# Runbook: hold, release, acknowledge, tombstone

These four commands are the manual controls. They exist because the engine
refuses to guess: when it cannot decide, it parks a row and nothing in the
toolkit touches that person again until somebody says what should happen. So
there has to be a way for a person to say it, and it has to be recorded.

| Command | What it writes | Who may run it | Needs |
| --- | --- | --- | --- |
| `jml leaver hold` | `hold: true`, `holdReason` | a person | `--reason` |
| `jml leaver release` | clears `hold`, `holdReason` and `reviewReason` in one write | a person | - |
| `jml leaver ack` | `offboarding.operatorAck` with your name and the time | a person | - |
| `jml leaver tombstone` | moves the row to `departed`, touches no account | a person | `--reason` |

All four accept `--hris-id` or `--email`, plus `--actor` and `--note`. All four
are also on the sidecar as `POST /v1/leavers/{hold,release,ack,tombstone}`, so
an n8n form can drive them; the sidecar requires a reason on hold and tombstone
for the same reason the CLI does.

## Freeze one person: hold

Use it when you know something the HR system does not, and you need the
automation to stop before you have worked out the right answer.

```
jml leaver hold --hris-id p-1001 \
  --reason "on secondment, HR record wrong" \
  --actor jane.doe@example.com
```

```
Jane Doe  (p-1001)
  status          active
  address         jane.doe@example.com
  ...
  hold            YES: on secondment, HR record wrong
  parked          no
```

**A reason is required and the command refuses without one:**

```
$ jml leaver hold --hris-id p-1001
a hold needs a reason: whoever finds this row later has only that to go on
```

Exit code 2, nothing written. The row somebody finds in six months with a
freeze and no explanation is unusable, so the reason is not optional.

### What hold actually stops

The flag is honoured in the store query **and** again inside the run loop, and
the row is re-read from the store immediately before each person and before
each step. That double check is deliberate: a query filter alone cannot protect
a row whose flag is set while a run is already in flight.

It also freezes the **HR sync**, not only the leaver engine. The sync may not
change the status of a held row.

A held row falls out of the selection. It is not named in the run report,
because the run never selected it:

```
$ jml leaver dry-run --hris-id p-1003
run <runId>  leaver  dry-run  ok=true
  counts: nothing to do
```

The place a freeze is visible is the store:

```
$ jml store verify
store          sqlite
total          5
hired          0
active         2
terminated     3
offboarding    0
departed       0   (tombstones: these are what stop a re-fire)
held           1
parked         2
day-0 today    0   (the set a run would act on)
```

### The one thing hold does not do

**Hold on a live person does not stop that person being protected.** The
identity gate ignores the hold flag on employed rows on purpose. Hold stops the
automation acting on the person it is set on; it must not stop their account and
address being protected from somebody else's offboarding.

That case is exactly why the distinction exists. A leaver's row once inherited a
live colleague's account id, and the colleague's row being held was what
somebody had reached for as the emergency stop. If hold had suppressed the
protection, the hold would have made the damage possible instead of preventing
it.

## Unfreeze: release

```
jml leaver release --hris-id p-1001 --actor jane.doe@example.com --note "HR corrected the date"
```

```
Jane Doe  (p-1001)
  status          active
  ...
  hold            no
  parked          no
  note            HR corrected
```

Release clears the freeze **and** the parked reason in one write. They are
cleared together on purpose: a row with the hold cleared and the parked reason
left behind looks released and is still excluded from every selection, which is
indistinguishable from the automation being broken.

Releasing does not decide anything. The next run re-evaluates the row from
scratch, so if the underlying data is still wrong the row parks again, with the
same reason. That is the intended loop: fix the cause, then release.

Whatever the row was parked for is recorded on the audit row as
`previousReviewReason`, so a release does not erase the history of why it was
parked.

## Say a deletion may go ahead: ack

Only relevant when `leaver.requireOperatorAck: true`. With it on, day 7 is
refused with `awaiting_ack` until somebody says otherwise.

```
jml leaver ack --hris-id p-1004 --actor jane.doe@example.com --note "checked with the manager"
```

It writes `operatorAck` into the offboarding record with your name and the
timestamp, and carries the rest of that record through untouched, including the
day-0 marker. Dropping that marker would make an already-suspended person
selectable for day 0 all over again.

There is no un-ack command. To stop a deletion after acknowledging it, use
`hold`.

## Close a row without touching an account: tombstone

Use it for a leaver whose accounts were dealt with years ago, or by hand, and
who should never be selected again.

```
jml leaver tombstone --hris-id p-1006 \
  --reason "left in 2023, accounts closed at the time" \
  --actor jane.doe@example.com
```

It goes through the transition table like everything else, so it is refused
rather than forced when the row is in the wrong state:

```
$ jml leaver tombstone --hris-id p-1001 --reason "test" --actor jane.doe@example.com
refused: No transition from active on human.tombstone. A row that is already departed cannot be closed
again, and one the engine is part-way through has to finish or be released first.
```

Exit code 1, nothing written. `human.tombstone` exists only from `terminated`
and from `offboarding`.

**`departed` is terminal and has no way out.** Not by the sync, not by the
engine, not by any command here. That is what stops a historic leaver being
re-created and re-fired, and it is the guard whose absence caused the worst
incident in this family: a migration pruned the tombstone rows, the next sync
read a full HR history, and hundreds of people who had left years earlier looked
like brand new terminations.

So tombstone is close to irreversible. Recreating somebody means a new HR record
and therefore a new HR id and a new row. Use it when you mean it.

For importing a whole HR history at once, use `jml store bootstrap` rather than
this command one row at a time. See
[store-migration.md](store-migration.md).

## What appears in the audit log

Each command writes a pair of rows: an intent before the write and an outcome
after it. The pair is the point. A single row written afterwards cannot describe
a change that was started and whose result was never learnt.

```
$ jml audit tail --lines 4
2026-09-04T15:06:45.322Z  intent   armed   human.hold                person:p-1001  by it-oncall
2026-09-04T15:06:45.337Z  ok       armed   human.hold                person:p-1001  by it-oncall  verified
2026-09-04T15:06:51.623Z  intent   armed   human.tombstone           person:p-1001  by it-oncall
2026-09-04T15:06:51.636Z  FAILED   armed   human.tombstone           person:p-1001  by it-oncall
```

The actions are `human.hold`, `human.release`, `human.delete_ack` and
`human.tombstone`. The reason you gave is in the row's `detail`:

```
$ jml audit tail --lines 1 --json
{"action":"human.hold","actor":{"id":"it-oncall","kind":"human"}, ...
 "detail":{"reason":"checking actor rendering"},"phase":"outcome","ok":true, ...}
```

**With `audit.minimisePii: true`, which is the shipped default, an actor given
as an email address is stored as a salted hash** and prints as
`by sha256:f87019e16a76e309`. That is the same treatment every address gets: an
audit log is append-only and kept for years, and does not need to be a permanent
directory of everybody who has ever left. If you want the actor readable in the
log, pass a team name rather than an address, as above.

Without `--actor` the CLI records `cli:` plus your local account name. It is a
worse label than a real name and a better one than "the command line", which
nobody can follow up.

## Undoing each of these

| Did | Undo |
| --- | --- |
| `hold` | `jml leaver release` on the same id |
| `release` | `jml leaver hold` again, with a new reason |
| `ack` | `jml leaver hold`; there is no un-ack |
| `tombstone` | nothing. `departed` is terminal by design. |

The audit rows are never removed by any of this. They are the record that the
decision was made, and by whom.
