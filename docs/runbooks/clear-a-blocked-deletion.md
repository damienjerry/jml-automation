# Runbook: clear a blocked deletion

Day 7 deletes a leaver's accounts. Four gates stand in front of it and each one
is a recorded failure written down as code. When one is shut the row stays in
`offboarding`, nothing is deleted, and the reason is stored on the row as
`deleteBlockedReason`.

Use this runbook when a run reports `blocked=` above zero, or when
`jml leaver show` prints a `deletion BLOCKED:` line. The gates themselves are
described in [../state-machine.md](../state-machine.md), and the failures behind
them in [../incidents.md](../incidents.md).

## Read the block first

```
jml leaver show --hris-id p-1004
```

The row prints `deletion        BLOCKED: <reason>` and, for a device block, one
line per machine naming it rather than giving you an id.

The notification says the same thing, and its last paragraph is the part people
miss:

```
Deletion blocked: Robin Ellis (robin.ellis@example.com)

Reason: devices_bound

- Demo field laptop, windows, serial DEMOSERIAL1

Nothing has been deleted. The row stays in offboarding and the deletion is
attempted again on the next run once the reason clears.

This note is sent when the blocking set CHANGES, and re-raised once a week.
Silence therefore means the same blockage, not a resolved one.
```

**Silence is not resolution.** The notification is keyed on the reason and the
set of machine ids, and on nothing else: no date, no count, no rendered text. An
earlier gate hashed its own message, the message carried today's date, and the
"tell me when it changes" rule fired every single day until people stopped
reading it.

## The five reasons

Four gates, five reasons: the device gate reports `devices_bound` when it read
the provider and found a machine, and `gate_error` when it could not read the
provider at all. Those are opposite facts and they get different answers, which
is why they are not one reason.

The gates are evaluated cheapest first, and the first shut one is the reason you
are shown. So a row can have more than one problem, and clearing the reported
one can reveal another.

| Reason | Means | Clear it with |
| --- | --- | --- |
| `transfer_incomplete` | the provider has not reported the file hand-over finished | [below](#transfer_incomplete) |
| `identity_mismatch` | somebody who still works here holds this account or address | [below](#identity_mismatch) |
| `devices_bound` | a machine is still bound directly to this person | [device-return-or-handover.md](device-return-or-handover.md) |
| `gate_error` | a provider could not be read, so the answer is unknown | [below](#gate_error) |
| `awaiting_ack` | `leaver.requireOperatorAck` is on and nobody has acknowledged | `jml leaver ack` |

Blocked rows are re-selected on **every** run, deliberately. The gate is
evaluated live against the provider each time, because yesterday's blockage is
not evidence about today, and a row that has quietly become deletable must not
wait for somebody to notice. What is change-only is the notification, not the
check.

That is visible in the demo: a laptop is unbound and the same run, on the same
day, proceeds.

```
run demo-delete   ... Robin Ellis     blocked offboarding -> offboarding  blocked: devices_bound
unbind sys-demo-laptop from Robin Ellis: ok=true verified=true
run demo-delete-2 ... Robin Ellis     day7    offboarding -> departed
      delete_google=done(verified) delete_idp=done(verified)
```

## transfer_incomplete

The block says: the file hand-over has not been reported complete by the
provider, and deleting the account now destroys every file it still owns.

`transferredAt` is written **only** when the transfer job is polled and comes
back `completed`. Asking for a transfer is not the same as the transfer having
happened, and this gate is the difference.

Try the hand-over again. Day 6 re-selects any `offboarding` row whose
`transferredAt` is still empty, so a plain run is the retry:

```
jml leaver dry-run --hris-id p-1004
jml leaver run --hris-id p-1004 --armed --actor jane.doe@example.com
```

Correct output names the recipient and says the provider confirmed it:

```
  Sam Rivera      day6    offboarding -> offboarding
      suspend_google=done(verified) transfer_drive=done(verified)
      files handed to jane.doe@example.com, confirmed complete by the provider
```

If the row parks as `no_transfer_recipient` instead, nobody could be resolved to
hand the files to. Two fixes, in order of preference:

1. Correct the manager on the HR record, then `jml sync --armed` and re-run.
2. Set `google.driveTransfer.fallbackRecipient` in `jml.config.yaml` and
   recreate the `jml` service. Null is the default and parks the row rather than
   guessing a recipient.

If the transfer is genuinely never going to happen, the honest options are
configuration rather than a per-person override:

- `leaver.requireTransferBeforeDelete: false` opens this gate for every row.
- `leaver.deleteGoogleUser: false` stops at suspension, so no files are
  destroyed and the gate opens for that reason instead.

Both are estate-wide and both should be a deliberate decision, not a way past
one awkward row. **This release ships no command that waives the hand-over for a
single person.** The field the gate reads (`offboarding.transferOverride`) has
no writer in the CLI or the sidecar, so if you need a per-person waiver today the
answer is `jml leaver tombstone` with a reason, which closes the row and does no
account work at all.

## identity_mismatch

The block reads, with the real names filled in:

> the jumpcloudUserId account on this row is also held by Jane Doe, who still
> works here (HR id p-1001).

The gate compares every provider id and every address on the leaver's row
against everybody whose status is `hired` or `active`. Any collision shuts it,
and the row is also parked as `identity_claimed_by_live_person`.

**Do not clear this one by removing the block.** This is the gate that exists
because of the worst near-miss in the catalogue: an HR system renamed a leaver on
the way out, a role-change branch read the new address as a brand new person, the
new row inherited a live colleague's provider account id, and when the leaving
date passed the colleague's account was suspended.

Work out which of the two rows is wrong, then fix the source:

```
jml leaver show --hris-id p-1004         # the leaver
jml leaver show --email jane.doe@example.com   # whoever the message named
```

- **If the live person's row is wrong**, correct their HR record and run
  `jml sync --armed`.
- **If the leaver's row carries a provider id that is not theirs**, that id has
  to come off the row. There is no command for editing a row's provider ids in
  this release. On the default SQLite store, with the schedule disarmed and a
  backup taken:

  ```
  jml leaver hold --hris-id p-1004 --reason "wrong provider id, correcting by hand" --actor jane.doe@example.com
  jml store backup --to ./backups
  sqlite3 ./data/jml.sqlite "UPDATE people SET external_ids = '{}' WHERE hris_id = 'p-1004';"
  jml leaver show --hris-id p-1004
  jml leaver release --hris-id p-1004 --actor jane.doe@example.com --note "cleared an inherited provider id"
  ```

  A row with no provider ids and no accounts findable anywhere takes the phantom
  path: it is recorded as `departed` with nothing touched. That is the inert
  landing zone this case is defused into, and it is why blanking the ids is the
  fix rather than deleting the row.

Then rehearse before arming: `jml leaver dry-run --hris-id p-1004` should no
longer park.

## gate_error

The block says a provider could not be read, so the bound-device list or the
account state is unknown.

**This is a refusal, not a failure to check.** The device gate never throws and
never returns an empty list on error: anything that is not a successful read of
zero devices blocks. The automation this replaces wrapped its device lookup in a
catch that logged and carried on, so a provider error produced an empty list, an
empty list read as "nothing to block on", and the account was deleted while the
machine was still out there.

`failClosed` and `directBindingsOnly` are literal `true` in the schema and cannot
be overridden.

Fix the credential, prove it, then re-run:

```
jml doctor
```

```
FAIL  identity provider                   the directory read answered 401 on https://console.jumpcloud.com/api
                                          Check the API key. A key belonging to a deleted admin answers 401 on every path.
```

See [rotate-a-credential.md](rotate-a-credential.md). When every row passes,
`jml leaver dry-run --hris-id p-1004` re-reads the provider and the gate answers
properly.

## awaiting_ack

```
jml leaver ack --hris-id p-1004 --actor jane.doe@example.com --note "manager confirmed"
jml leaver run --hris-id p-1004 --armed --actor jane.doe@example.com
```

Details and the fact that there is no un-ack are in
[hold-and-release.md](hold-and-release.md).

## If you want the deletion to stop rather than proceed

Clearing a block is not the only answer. A blocked row is doing no harm: the
accounts are already suspended, the licences are already revoked, and nothing
further happens until you act.

```
jml leaver hold --hris-id p-1004 --reason "deletion deferred pending a legal request" --actor jane.doe@example.com
```

A held row falls out of every selection, so the weekly re-raise stops too. Use
`jml leaver tombstone` when the row should be closed permanently with no
account work.

## Undo

| Did | Undo |
| --- | --- |
| cleared a block and the row deleted | nothing. `departed` is terminal and the accounts are gone. Check whether your provider can restore a recently deleted account before doing anything else. |
| edited `external_ids` by hand | restore the copy `jml store backup` wrote and re-run `jml store verify` |
| changed `requireTransferBeforeDelete` or `deleteGoogleUser` | put the value back and recreate the `jml` service |
| held the row | `jml leaver release` |

Because the last row of that table is the only reversible one, do the dry run
first. Every time.
