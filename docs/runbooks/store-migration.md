# Runbook: migrate the people store

Use this when you move the people store: a new database file, a new machine, a
change of adapter, or a schema upgrade that arrives with a new release.

**The departed rows are the thing being protected.** A tombstone row is the only
thing that stops a person who left years ago being offboarded a second time, and
a migration that dropped them is the origin of the worst incident in this
catalogue: a data migration removed the tombstone rows, the next HR sync read a
full employment history, saw hundreds of leavers with no offboarding marker, and
concluded they were all brand new terminations. Accounts closed years earlier
began to be suspended again, and several schedules had to be turned off by hand
while the rows were rebuilt.

Everything below is built around one habit: **write the two numbers down before
you move anything, and assert them afterwards.** Not "the data looks right".
Numbers.

## The two numbers

```
jml store verify
```

```
store          sqlite
total          6
hired          0
active         2
terminated     1
offboarding    0
departed       3   (tombstones: these are what stop a re-fire)
held           0
parked         0
day-0 today    1   (the set a run would act on)
```

| Number | Why it is the one that matters |
| --- | --- |
| `departed` | the tombstone count. Losing tombstones re-fires historic leavers. |
| `day-0 today` | the exact set of people a run would start offboarding right now. |

`day-0 today` is computed from the same filter the engine uses, not a second
copy of the same conditions, so `jml store verify`, the engine and the bootstrap
check cannot drift into three slightly different ideas of the same set.

## Before you move anything

### 1. Disarm

The schedule stays disarmed until the counts match, not until the migration
finishes.

Either deactivate the `jml-pipeline` workflow in n8n, or set `mode: dry-run` in
`jml.config.yaml` and recreate the `jml` service.

### 2. Back both databases up

```
jml store backup --to ./backups
```

```
wrote ./backups/jml-people-<stamp>.sqlite
wrote ./backups/jml-state-<stamp>.sqlite
The audit log is append-only and hash-chained, so it is not copied here. Back up the audit directory
with your ordinary file backup, and run `jml audit verify` on the copy.
```

This uses `VACUUM INTO` rather than copying the file. The store runs in
write-ahead-log mode, so copying the file while anything is writing produces a
database that opens and is missing the most recent transactions, which is the
worst possible outcome for a backup: it looks like it worked.

The audit log is not copied here on purpose. Copying it would silently split the
hash chain across two places. Back up the audit directory with your ordinary
file backup and run `jml audit verify` against the copy.

`jml store backup` refuses when the people store is not local SQLite, because
there is no file to copy. Back a remote store up where it lives.

### 3. Record the numbers

```
jml store verify
```

Write down `departed` and `day-0 today`. You will assert both in step 6.

## Move it

### 4. Do the migration

For a file move or a new machine, copy `data/jml.sqlite` **and**
`data/jml-state.sqlite`. For an adapter change, follow the adapter's own page:
[../adapters/notion.md](../adapters/notion.md) or
[../adapters/sheets.md](../adapters/sheets.md).

Two things about the second file.

The state database holds this toolkit's own bookkeeping: leases, alert
fingerprints, invariant counters and run history. Nothing in it is a person. Its
location is derived from the people store rather than configured separately: for
the SQLite adapter it sits beside `store.path` as `jml-state.sqlite`, and for
every other adapter it is `data/jml-state.sqlite`.

**So changing `store.path` also changes where the invariant baseline is looked
for.** Leave the state database behind and the tombstone baseline reads as null,
which never aborts a run. That is safe by construction, and it also means the
one check that would have caught a pruned store is switched off for the first
run. Move both files.

### 5. Apply the schema migrations

```
jml store migrate
```

```
migrations for the sqlite store are applied; 6 rows readable, 4 tombstones intact
```

Opening the store applies every migration the build knows about, and refuses to
open a file carrying one it does not know, so this command mostly reports what
the schema now holds. Run it anyway: it is the cheapest way to find out that
your data file is newer than your build.

## Assert, then re-arm

### 6. The count assertions

```
jml store verify --expect-departed 3 --expect-day0 1
```

Correct output ends with the last line here, and nothing else will do:

```
departed       3   (tombstones: these are what stop a re-fire)
...
day-0 today    1   (the set a run would act on)

every stated expectation held
```

A number that moved is named. This is a different store from the one above, so
that the mismatch line is real rather than illustrative:

```
$ jml store verify --expect-departed 300
departed       4   (tombstones: these are what stop a re-fire)
...
MISMATCH: Tombstone (departed) count is 4, expected 300.
```

| Result | What it means | Do this |
| --- | --- | --- |
| `every stated expectation held` | both sides agree | go to step 7 |
| `MISMATCH` on `departed` | tombstones were lost | **stop.** Restore the backup, or rebuild the rows, before anything runs |
| `MISMATCH` on the day-0 selection | the set of people a run would act on has changed | read those rows before arming; a jump usually means lost tombstones showing up from the other side |
| `departed` higher than expected | normal if you tombstoned rows in between; suspicious otherwise | reconcile it deliberately, do not shrug at it |

`day-0 today` legitimately changes with the date: a person whose leaving date
passes overnight joins the selection. Run the two `verify` calls close together,
or expect and explain the difference.

### 7. Rebuild tombstones if they went

Two ways, and the first is almost always right.

**From the HR history.** This imports every person the HR system does not list
as employed straight into `departed`:

```
jml store bootstrap
```

```
BOOTSTRAP REHEARSAL (nothing was written)

scanned          7
not employed     4
tombstoned       1
already present  3   (left exactly as they were, whatever their status)
skipped: employed 3
skipped: no email 0

tombstones after   0
day-0 selection    0   (this must be 0 before you arm anything)

warning: p-1003 already has a row with status terminated; left untouched. Bootstrap never changes an existing status.
```

Read the rehearsal, then:

```
jml store bootstrap --armed
```

```
bootstrap applied
...
tombstones after   1
day-0 selection    0   (this must be 0 before you arm anything)

nothing would start offboarding, which is the whole point of this command
```

Three properties of `bootstrap` worth knowing before you rely on it:

- rows are created straight into `departed` rather than created as leavers and
  then transitioned. A window in which several hundred historic people are
  selectable, however short, is precisely the accident being defended against;
- **an existing row is never touched, whatever status it holds.** Somebody who
  left and was rehired is a live person, and a bootstrap that overwrote them
  would be the same class of mistake in the opposite direction. That is what the
  `already present` count and the warning above are telling you;
- it refuses to run at all from an incomplete HR snapshot, because the people
  missing from a partial history are exactly the ones who would later look like
  new terminations.

`day-0 selection` must be `0` before you arm anything. If it is not, those rows
are people a run will start offboarding, and they need reading first.

**Row by row**, where bootstrap left an existing row alone but it should be
closed:

```
jml leaver tombstone --hris-id p-1006 --reason "left in 2023, restoring a tombstone lost in the store move" --actor jane.doe@example.com
```

See [hold-and-release.md](hold-and-release.md).

### 8. Prove the whole thing, then re-arm

```
jml doctor
```

The people-store row restates the numbers from the runtime's own point of view:

```
pass  people store                        sqlite: 6 rows, 4 tombstones, 0 would start offboarding today
pass  audit chain                         ./audit: 11 rows, chain intact
pass  state store                         leases work; last pipeline run ... : ok armed ...
```

Then one full rehearsal before arming:

```
jml run
```

Expect `ok=true` with no `ABORTED:` line. Only then re-arm.

## What happens if you skip the assertions

The toolkit has one backstop, and it is not a substitute for the steps above.

Before any write, including in a dry run, the pipeline compares the tombstone
count against the last run's and refuses when it has fallen:

```
run <runId>  pipeline  dry-run  ok=false
  ABORTED: invariant_failed
  counts: nothing to do
  error: The tombstone count fell from 1 to 0. Tombstones are what stop a historic leaver being
  offboarded again, so this run is refusing to do anything. Restore the rows, or clear the counter
  deliberately once you know why they went.
```

`jml serve` refuses to start in the same state, for the same reason.

Two limits on that backstop, which is why it is a backstop:

- it compares against **the last run's** count, so it cannot see a loss that
  happened before the first run on a new store, where the baseline is null;
- on failure the recorded baseline is deliberately left alone. Writing the new,
  lower number would teach the next run that the loss is normal.

Recovery from that state is in
[incident-recovery.md](incident-recovery.md).

## A note on the non-SQLite adapters

SQLite is the default and the only transactional store. The Notion and
Spreadsheet adapters have no atomic conditional write, so a status change is a
read, a verify and a write under a lease, and each declares itself
single-writer. Do not run two schedules against one of them, and do not treat a
migration onto one as a like-for-like move: the count assertions above are the
same, and the concurrency guarantees are not.

The toolkit's own bookkeeping stays in local SQLite whichever people store you
choose. A lease held in a shared document with no transactions is not a lease,
and two overlapping runs both suspending the same person is exactly what a lease
exists to prevent.
