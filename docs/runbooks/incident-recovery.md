# Runbook: incident recovery

Six situations, and the commands for each. Read the one you are in; they are
independent. The failures behind them are catalogued in
[../incidents.md](../incidents.md); the rules that now prevent them are in
[../state-machine.md](../state-machine.md).

- [Somebody was suspended who should not have been](#somebody-was-suspended-who-should-not-have-been)
- [A run was armed by mistake](#a-run-was-armed-by-mistake)
- [The tombstone count invariant aborted a run](#the-tombstone-count-invariant-aborted-a-run)
- [The circuit breaker fired](#the-circuit-breaker-fired)
- [A deletion is blocked and the machine is genuinely gone](#a-deletion-is-blocked-and-the-machine-is-genuinely-gone)
- [The audit log fails verification](#the-audit-log-fails-verification)
- [Proving a run did nothing](#proving-a-run-did-nothing)

Two habits run through all of them. **Freeze before you investigate**, so the
next scheduled run cannot act while you are reading. And **read the audit log
rather than the report**: the report says what the run concluded, the audit says
what it asked a provider to do, in pairs, with the intent written before the
call.

## Somebody was suspended who should not have been

### 1. Freeze the row, first, before anything else

```
jml leaver hold --hris-id p-1004 \
  --reason "suspended in error, restoring by hand, do not touch" \
  --actor jane.doe@example.com
```

That one write stops every automation on that row, including the HR sync, and it
is honoured in the store query and again inside the run loop, so it takes effect
even against a run already in flight. Without it, day 6 arrives in five days and
hands their files to their manager while you are still working out what
happened.

Confirm it took:

```
jml leaver show --hris-id p-1004
```

`hold  YES: suspended in error, ...` and the `leg` lines telling you which
phases have run.

### 2. Why the toolkit will not unsuspend them for you

There is no unsuspend call in any connector. The identity provider port offers
`findUser`, `suspendUser` and `deleteUser`; the Google port offers suspend,
delete, licence list, licence revoke, transfer and the auto-reply. Nothing
assigns a licence and nothing reverses a suspension, in either.

That is a decision, not an omission. Once `suspendedAt` is set, the accounts may
be partly deleted, the files may already be somebody else's, and a sync cannot
know which. So the transition table refuses the revival outright, with the
reason written into it:

> Rehired, or the leaving date was cancelled, BEFORE any suspension. Once
> `suspendedAt` is set the sync may not do this: it sets hold and parks the row
> instead, because unsuspending somebody is a decision for a person.

If the HR system now reports that person as employed, the sync will freeze the
row itself and park it as `reinstated_after_day0`, and announce it once. That is
the tool telling you to do what follows by hand.

### 3. Find out exactly what was done to them

```
jml leaver show --hris-id p-1004
grep p-1004 audit/jml-*.jsonl | grep '"phase":"outcome"'
```

The actions to look for, in the order they happen:

| Action | Detail it carries | What you have to reverse |
| --- | --- | --- |
| `leaver.day0.suspend_idp` | the provider user id | the suspension on the identity provider |
| `leaver.day0.revoke_licence` | `skuId`, one row per seat | re-assign each of those SKUs |
| `leaver.day0.set_autoreply` | - | remove the vacation responder |
| `leaver.day0.signout_google` | - | nothing to restore: the person signs in again and re-authorises any third-party app |
| `leaver.day6.transfer_drive` | `recipient`, then a `transferId` | file ownership, which is now the recipient's |
| `leaver.day6.suspend_google` | - | the suspension on the Google account |
| `leaver.day7.delete_idp.snapshot` | `userId`, `suspended`, `providerState`, `externalIds` | nothing; this is the evidence row |
| `leaver.day7.delete_idp` | the provider user id | the account is gone |
| `leaver.day7.delete_google` | - | the account is gone |

Rows with `"dryRun":true` describe a rehearsal and changed nothing. Rows whose
`phase` is `intent` with no matching `outcome` are the dangerous case: a call was
made and its result was never learnt, so check the provider directly rather than
assuming either way.

The pre-delete snapshot row exists precisely for this moment. What was known
about the account goes into the audit before it is destroyed, because it cannot
be read afterwards.

### 4. Restore, in this order

Order matters: a licence has to exist before the mailbox works, and the identity
provider has to let them in before anything downstream will.

1. **Identity provider**: clear the suspension on the account id from the
   `suspend_idp` row.
2. **Google account**: clear the suspension, if `leaver.day6.suspend_google`
   ran.
3. **Licences**: re-assign each `skuId` from the `revoke_licence` rows. The
   toolkit revoked what the person actually held rather than a hard-coded
   product, so those rows are the complete list.
4. **Auto-reply**: turn the vacation responder off in the mailbox. Nothing in
   the toolkit clears it.
5. **Files, if day 6 ran**: the hand-over changed ownership. It is not
   reversible from here. Ask the recipient named in the `transfer_drive` row to
   transfer ownership back, and expect gaps.
6. **Tell the manager.** They received a message on day 0 naming a dated
   deletion. Somebody has to say it is not happening.

### 5. If the deletion already ran

The row is `departed`, which is terminal: nothing in the toolkit moves it, and
the accounts are gone.

Check whether your identity provider and Google can restore a recently deleted
account before doing anything else, and do that before the retention window
expires. Read the snapshot row for the ids you will need. Deleting an identity
provider record also destroys the disk-encryption recovery key it held for any
machine, and that cannot be restored with the account.

If the person is genuinely returning, they need a new HR record, which means a
new HR id and a new row. Do not attempt to reuse the tombstone; it is the thing
that stops their old row being offboarded all over again.

### 6. Release only when the cause is fixed

Fix the HR record first, then:

```
jml sync --armed --actor jane.doe@example.com
jml leaver show --hris-id p-1004
jml leaver release --hris-id p-1004 --actor jane.doe@example.com --note "HR corrected; access restored by hand"
```

Then rehearse before the schedule touches them again:

```
jml leaver dry-run --hris-id p-1004
```

If the row parks again, the cause is not fixed. Release does not decide
anything; it only lets the engine look again.

## A run was armed by mistake

### 1. What has already happened

Nothing was armed unless three things agreed: `--armed` (or `dryRun: false` on
the sidecar), `mode: armed`, and the action being named in `armedActions`. So
start by reading which of those were true:

```
jml config show --no-secrets
```

Then the audit log, which stamps every row `armed` or `dry-run`:

```
jml audit tail --lines 50
```

```
2026-09-04T15:06:37.145Z  intent   armed   notify.run.summary        person:run:<runId>  by system:cli
2026-09-04T15:06:45.322Z  intent   armed   human.hold                person:p-1001  by it-oncall
2026-09-04T15:06:45.337Z  ok       armed   human.hold                person:p-1001  by it-oncall  verified
```

Every provider write in that window:

```
grep '"dryRun":false' audit/jml-*.jsonl | grep -E '"action":"leaver\.day[067]\.' 
```

Each one names the person as `subject.id`, which is their HR id in clear. The
worst case is small and bounded: the circuit breaker caps a single run's day-0
selection at `leaver.maxDay0PerRun`, five by default.

### 2. Stop the next run

Fastest first.

| Action | Stops |
| --- | --- |
| deactivate the `jml-pipeline` workflow in n8n | the schedule |
| set `JML_DRY_RUN=true` on the n8n service, then recreate it | every workflow's writes |
| set `mode: dry-run` in `jml.config.yaml`, then `docker compose up -d jml` | every write, from any caller |
| empty `armedActions`, then `docker compose up -d jml` | each action individually, recording `not_armed` |
| `jml leaver hold` on a named row | that one person, immediately |

A run in flight cannot be stopped from outside. It holds the pipeline lease for
up to 15 minutes, and a second run started meanwhile skips rather than
overlapping. Wait for it, then read the audit.

### 3. Then decide per person

For anybody suspended who should not have been, go to the first section of this
runbook. For anybody who was going to be suspended and now must not be, hold the
row.

## The tombstone count invariant aborted a run

```
run <runId>  pipeline  dry-run  ok=false
  ABORTED: invariant_failed
  counts: nothing to do
  error: The tombstone count fell from 1 to 0. Tombstones are what stop a historic leaver being
  offboarded again, so this run is refusing to do anything. Restore the rows, or clear the counter
  deliberately once you know why they went.
```

### What it means

The pipeline compares the number of `departed` rows against the count recorded
by the last run, before it does anything else. Tombstones only ever accumulate,
so a fall means rows were removed by something outside this toolkit.

### Why it is protecting you

At that moment every removed person looks like a brand new termination, because
what marks them as already handled is the row that has gone. That is not
hypothetical. A migration pruned several hundred tombstone rows, the next sync
saw hundreds of historic leavers as new leavers, and the engine began suspending
accounts that had been closed for years.

Two details that make the check honest:

- it runs **before the HR system is even read**, so an abort really does mean
  nothing was touched;
- on failure the recorded baseline is **left alone**. Writing the new, lower
  number would teach the next run that the loss is normal and let it proceed.

`jml serve` refuses to start in the same state:

```
refusing to serve: the tombstone count has fallen from 1 to 0. Tombstones are what stop a historic
leaver being offboarded again, so nothing runs until somebody knows why they went.
```

### Restore the rows

This is the right answer in almost every case. Look first:

```
jml store verify
```

Then rebuild the tombstones from the HR history, rehearsal first:

```
jml store bootstrap
jml store bootstrap --armed
```

```
bootstrap applied

scanned          7
not employed     4
tombstoned       1
already present  3   (left exactly as they were, whatever their status)
skipped: employed 3
skipped: no email 0

tombstones after   1
day-0 selection    0   (this must be 0 before you arm anything)
```

Once the count is back at or above the baseline, the run proceeds on its own:

```
$ jml run
run <runId>  pipeline  dry-run  ok=true
  counts: detect.potentialLeaver=3 hrisEmployed=3 hrisPeople=7 sync.preserved=1 sync.scanned=7 ...
```

Bootstrap never changes an existing row, so a person whose row survived the loss
in some other status is reported as `already present` and left alone. Close
those individually where they should be closed:

```
jml leaver tombstone --hris-id p-1006 --reason "historic leaver, tombstone lost in a store move" --actor jane.doe@example.com
```

### Establishing the baseline deliberately, when the fall is real

Sometimes the count is legitimately lower: you split one estate into two, or
migrated to a store that genuinely holds fewer people. Do this only when you can
say, in a sentence, where each missing row went.

**There is no command that resets the counter in this release.** The invariant
baseline lives in the state database, which holds only this toolkit's own
bookkeeping and no person. A null baseline never aborts, so moving that file
aside establishes a new baseline on the next run:

```
jml store verify                       # write the new, correct numbers down
jml store backup --to ./backups        # both databases, including the state one
mv data/jml-state.sqlite data/jml-state.sqlite.superseded-$(date +%Y%m%d)
jml run                                # rehearsal: no ABORTED line, and the new count is recorded
```

What that costs, and it is deliberately small: the leases, the alert
fingerprints and the run history. In practice, one duplicate "deletion blocked"
notification and one skipped invariant check. It costs nobody's account.

Before you do it, run the rehearsal in the last line above and read
`day-0 today` from `jml store verify`. If that number is larger than the number
of people who actually left, the rows are missing rather than gone, and moving
the counter aside would arm exactly the incident this check exists for.

## The circuit breaker fired

```
run <runId>  leaver  dry-run  ok=false
  ABORTED: circuit_breaker
  counts: selectedDay0=3
  error: 3 day-0 candidates exceeds the limit of 1, so the run refused to touch anything
```

The audit row carries the ids so you can go and look:

```
{"reason":"3 day-0 candidates exceeds the limit of 1, so the run refused to touch anything",
 "candidates":3,"limit":1,"firstTen":["p-1003","p-1004","p-1005"]}
```

The whole run stops, later phases included. A count this far out means the
picture is wrong, and the safe response to a wrong picture is to touch nothing at
all. It fires in a dry run too, on purpose: a rehearsal is exactly when you want
to be told that today's selection is forty people rather than two.

### Which of the two it is

A genuine bulk departure and a truncated HR read look identical in the count.
They differ in the detail.

| Check | Genuine bulk departure | Truncated or broken HR read |
| --- | --- | --- |
| the named ids | people you can account for | a set nobody recognises, or historic names |
| `hrisPeople` and `hrisEmployed` in the counts | close to your real headcount | far too low |
| `jml leaver show` on two or three of the ids | recent, plausible leaving dates | dates from years ago |
| `jml store verify` `departed` | unchanged | lower than you expect |

```
jml store verify
jml leaver show --hris-id p-1003
jml leaver show --hris-id p-1004
```

Two other guards will usually have caught the read problem first, and their
absence is itself informative:

- `hris.minPlausibleHeadcount` aborts the run with `hris_implausible` when the
  snapshot is smaller than the floor you set. It has no default: a truncated
  read looks exactly like a company where everybody left, so you state your own
  floor rather than inheriting a guess.
- an incomplete snapshot aborts with `hris_incomplete` rather than being synced.

If the HR read is at fault, fix it there. Do not raise the limit to get past it:
the limit is the only thing standing between a bad read and a few hundred
suspensions.

### If it is genuine

Raise it for that one run, and sign for it:

```
jml run --armed --allow-bulk 40 --actor jane.doe@example.com
```

`--allow-bulk` requires a named human actor and is refused without one:

```
$ jml run --allow-bulk 10
run <runId>  pipeline  dry-run  ok=false
  ABORTED: circuit_breaker
  error: circuit_breaker
```

The audit row says why: `"reason":"circuit_breaker_override_needs_a_person"`. A
scheduled workflow cannot raise the limit on its own, and on the sidecar the
actor must arrive as `X-Jml-Actor: human:<name>`. The override itself is
recorded as `run.circuit_breaker_override` with the configured limit, the raised
limit and your name, so a bulk day is answerable afterwards.

Rehearse at the raised limit first, without `--armed`, and read the list of
people before arming it.

Raising `leaver.maxDay0PerRun` in the configuration instead is the wrong move
for a one-off. It is a permanent change made to solve a temporary problem, and
nobody signs for it.

## A deletion is blocked and the machine is genuinely gone

The block is `devices_bound`, and the laptop is not coming back: sold to the
leaver, lost, or written off.

**Do not switch the gate off.** `leaver.deviceGate.failClosed` and
`leaver.deviceGate.directBindingsOnly` are literal `true` in the schema and
cannot be overridden, so there is nothing to switch. What is available is a way
to record the decision, which is the point: the next person to ask why that
machine has no record should find an answer rather than a gap.

### If you can still reach the provider record

Best outcome. Remove the leaver's binding and leave the machine enrolled:

```
jml device preflight --system-id sys-a1b2c3 --disposition return_to_pool --owner-hris-id p-1004
jml device dispose --system-id sys-a1b2c3 --disposition return_to_pool --owner-hris-id p-1004 \
  --armed --actor jane.doe@example.com
```

The gate clears, the record survives, the recovery key stays escrowed, and
nothing was uninstalled. Whether to delete the record afterwards is a separate
decision, and the answer is usually no: see
[device-return-or-handover.md](device-return-or-handover.md).

### If the machine is out of your control entirely

Record that, then close the person's row. Two commands, and both leave a
sentence somebody can read in a year:

```
jml device dispose --system-id sys-a1b2c3 --disposition retain_unmanaged \
  --note "sold to the leaver on 2026-09-01; agents left installed; machine not recovered" \
  --actor jane.doe@example.com

jml leaver tombstone --hris-id p-1004 \
  --reason "accounts closed by hand; machine sold to the leaver and left enrolled, see the device note" \
  --actor jane.doe@example.com
```

`retain_unmanaged` writes nothing to any provider whatever you pass, and clears
nothing, deliberately. Its whole output is the record. The tombstone then closes
the row so no run selects the person again, and it does no account work at all,
so whatever state their accounts are in is what you left them in. Both write
audit pairs naming you.

What you have accepted by doing this, written down so it is a decision rather
than a side effect: the machine is still enrolled, still reporting, and still
holds your agents; its record still exists and can be found; and the person's
accounts are in whatever state the last run left them, which is suspended rather
than deleted unless you finished the job by hand.

## The audit log fails verification

```
$ jml audit verify
the audit chain in ./audit BREAKS at line 5 after 5 good rows.
A break means a row was edited or removed. Keep the files as they are and read
docs/runbooks/verify-the-audit-log.md before doing anything else.
```

Exit code 1.

### What it means

Every line carries the hash of the line before it. The chain does not stop
anybody editing the file; it means an edit or a deletion cannot be hidden.
`verify` walks the chain and names the first line that does not follow from its
predecessor, so:

- rows **before** the named line verify against each other;
- rows **after** it cannot be trusted to be the rows that were written.

A break is not proof of malice. A truncated write, a partial restore from
backup, a file edited to redact something, and a deliberate removal all look the
same from here. That is the point: the chain tells you the file is no longer the
one that was written, and nothing more.

### Preserve first, then investigate

In this order, and before you run anything that appends to the log. The
read-only commands add no rows, so investigating with them is safe: `jml store
verify`, `jml audit verify`, `jml audit tail` and `jml leaver show` all leave
the file byte for byte as it was. Anything that writes appends to it, including
`hold`, `release`, `ack`, `tombstone`, `run`, `sync` and `device dispose`, so
take the copy before you reach for one of those.

```
cp -R audit "audit.preserved-$(date +%Y%m%dT%H%M%SZ)"
chmod -R a-w "audit.preserved-$(date +%Y%m%dT%H%M%SZ)"
```

Then the rest of the evidence, which sits in three other places:

| Preserve | Why |
| --- | --- |
| both databases: `jml store backup --to ./backups` | the row states are the other half of the story |
| the n8n execution list | it records what was asked for, independently of the sidecar |
| your log aggregator, if `audit.loki.enabled` | a second copy of the same rows, written at the same time |

Then read the file directly rather than through the toolkit:

```
sed -n '1,12p' audit/jml-2026-09-04.jsonl
```

`jml audit tail` skips a corrupt line to stay readable, so it is the wrong tool
for this: the line you want to see is the one it drops.

### The other reason this command fails

A directory that cannot be read is reported as itself, not as a broken chain:

> the audit log at ./audit could not be read: ... On a fresh install nothing has
> been recorded yet. Otherwise the log is not where the configuration says it
> is, which on a container usually means the volume did not mount.

Those need opposite responses. One is a fresh install or an unmounted volume;
the other is a row somebody edited. Check `audit.jsonl.dir` and the volume
mount before assuming the worse one.

### After it is preserved

Restore the audit directory from your file backup and verify the copy. If the
break sits in the middle of a day's file, keep both versions: the file you have
is evidence even when it is not a valid chain, and deleting it to make the
command green is the one action that cannot be undone.

Run `jml audit verify` before a migration, after restoring any backup, and any
time somebody asks what happened to an account. It is the cheapest of the checks
here and the only one that tells you whether the answer you are about to give is
based on the record that was written.

## Proving a run did nothing

Asked "are you sure nothing happened?", answer with four commands rather than a
recollection.

```
jml audit tail --lines 40
jml store verify
jml audit verify
```

What to point at:

- **an aborted run.** `ABORTED:` in the report, and a `run.abort` row in the
  audit. The abort is written before the HR system is read, so nothing later in
  the run existed to touch anything;
- **`dry-run` on every row.** The audit stamps each row `armed` or `dry-run`.
  A dry run makes no provider call at all, and the notifications it would have
  sent carry a `[DRY RUN]` subject;
- **`counts: nothing to do`.** No person was selected;
- **the store counts.** `departed`, `held`, `parked` and `day-0 today` are the
  same as they were, and `jml store verify --expect-departed N --expect-day0 M`
  turns that into an assertion rather than a glance;
- **the chain is intact.** `jml audit verify` is what makes the three points
  above worth anything, because it says the rows are the rows that were written.

The demo is the reference for what "nothing happened" looks like end to end. It
runs the whole lifecycle offline and ends:

```
Nothing left this process: no network call, no credential, no file written.
```
