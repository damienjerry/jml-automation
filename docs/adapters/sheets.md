# A spreadsheet as the people store

Read this first: **the spreadsheet adapter is not implemented in this
release.** The configuration schema accepts it and the store interface is
written against it, but no code reads or writes a sheet. Configuring it stops
the CLI before anything runs:

```
$ jml doctor
store.adapter is "sheets", which this release ships as an interface only.
Use the sqlite store, or the memory store for a rehearsal.
see docs/config-reference.md#keys
```

Exit code 78, from `buildStore()` in
[`src/cli/commands/context.ts`](../../src/cli/commands/context.ts).

There is a second gap worth knowing about before anybody plans around this. The
shipped Google connector mints `https://www.googleapis.com/auth/spreadsheets.readonly`
and nothing wider
([`src/connectors/google/scopes.ts`](../../src/connectors/google/scopes.ts)),
with the service account acting as itself against a sheet shared with it. A
people store has to write. So this adapter needs a scope the toolkit does not
currently request, and `jml doctor` has no probe for it.

## You probably do not need this

The default store needs no setup at all:

```yaml
store:
  adapter: sqlite
  path: ./data/jml.sqlite
```

The file is created on first use, the schema is applied by the migration
ledger, and the shipped compose file mounts `./data` so it survives a container
rebuild. Nothing to provision, no token, no rate limit, no quota.

A spreadsheet is worth it only if somebody who will not open a terminal needs
to read these rows. It is the weakest of the three options on every other axis.

## What it would need: one tab, one row per person

```yaml
store:
  adapter: sheets
  spreadsheetId: env:PEOPLE_SHEET_ID
  tab: People
```

Row 1 is the header. One column per field, in any order, matched by header
name:

| Column | Field | Notes |
| --- | --- | --- |
| `hris_id` | `hrisId` | **The key.** Never the email address |
| `status` | `status` | One of `hired`, `active`, `terminated`, `offboarding`, `departed` |
| `primary_email` | `primaryEmail` | |
| `alias_emails` | `aliasEmails` | Every address this person has used |
| `display_name` | `displayName` | |
| `first_name`, `last_name` | `firstName`, `lastName` | |
| `department`, `job_title`, `site` | as named | |
| `manager_email` | `managerEmail` | The default transfer recipient |
| `start_date`, `termination_date` | as named | `YYYY-MM-DD`, always |
| `hold`, `hold_reason` | as named | The freeze a person sets |
| `review_reason` | `reviewReason` | One of the seven parked reasons, or blank |
| `external_ids` | `externalIds` | JSON |
| `google_account_present` | `googleAccountPresent` | Three states: yes, no, blank for unknown |
| `offboarding` | `offboarding` | JSON: day-0 marker, legs, transfer evidence, blocked reason, acknowledgement |
| `note`, `source`, `updated_at` | as named | |

Those are the column names the SQLite store already uses
([`src/store/sqlite/rows.ts`](../../src/store/sqlite/rows.ts)), which makes a
sheet exported from one and imported into the other readable without a mapping
table.

Four things a spreadsheet gets wrong unless the adapter is written carefully.

**Dates.** A sheet will happily hand back `15/01/2026`, or a serial number, or
whatever the viewer's locale renders. Every date in this toolkit is an ISO
`YYYY-MM-DD` string and is compared as a string. Format the date columns as
plain text and parse strictly, refusing anything that does not match. A locale
date that was never parsed is already a recorded failure:
[`hris-locale-date-never-parsed`](../../test/regression/hris-locale-date-never-parsed.test.ts).

**Booleans.** `hold` has to be `true`/`false` or a checkbox, and a blank cell
has to read as `false`. `google_account_present` has **three** states and a
blank cell must read as unknown, not as no. "No such account" and "could not
tell" are opposite facts, and collapsing them is how a failed read became a
deletion.

**The offboarding blob.** One JSON cell, not fifteen columns. It is written by
the engine and never edited by a person, and spreading it across columns
invites somebody to clear the day-0 marker by selecting a range and pressing
delete. That marker is the only thing stopping a suspension running a second
time.

**Empty trailing cells.** A sheets API commonly omits them, so a row can come
back shorter than the header. Pad to the header length before mapping, or every
field after the last populated cell reads as missing.

## Single writer, and why

`StoreCapabilities.singleWriterOnly` would be `true`, and `exactCounts` would
be `false` unless the adapter reads the whole tab to count.

A spreadsheet has no transactions, so it cannot offer either of the two things
the state machine depends on:

| Needed | A sheet gives you |
| --- | --- |
| Compare-and-set on a status write, so a stale read is refused | read a range, then write a range, with a gap in between |
| A lease, so two runs cannot act on the same person at once | a cell both runs can set |

Read-modify-write with a gap is not a compare-and-set, and a lock in a document
with no transactions is not a lock. Worse than Notion in one respect: a person
with the sheet open can write a cell in the same second the adapter does, and
the last write wins with no error.

So every write happens under the pipeline lease, and the lease lives elsewhere.
The toolkit's own bookkeeping is **always local SQLite** whatever the people
store is ([`src/store/types.ts`](../../src/store/types.ts)); with a sheet as
the people store it lands at `data/jml-state.sqlite`. Run the pipeline from one
place only.

Give the sheet to people as a viewer rather than an editor. A person editing a
row while a run is in flight is not a hypothetical, and the toolkit cannot
detect it.

## The contract an adapter has to meet

One conformance suite covers every people store, shipped as library code so an
adapter can be tested in one line
([`src/store/conformance.ts`](../../src/store/conformance.ts)):

```
import { describePeopleStoreConformance } from 'jml-automation/store/conformance'

describePeopleStoreConformance({
  name: 'sheets',
  create: async () => new SheetsPeopleStore({ /* ... */ }),
})
```

The cases a range-based API will fail first:

| Case | What it asserts |
| --- | --- |
| No delete, and no prune | The interface cannot remove a row. Tombstones are the only thing stopping a historic leaver being offboarded twice, and a `deleteRows` call is one keystroke away in every sheets client library |
| A selection returns every row | The suite inserts 1,200 rows by default, deliberately over a thousand: an earlier design read one hundred-row page and silently ignored everybody after it |
| A second identical sync performs no writes at all | Diff before writing. A store that rewrites the tab on every run burns quota and hides the day something did change |
| A blank incoming value never erases a populated stored one | Blank cells are everywhere in a sheet |
| The day-0 marker can never be cleared | Refuse the write, do not merely avoid making it |
| A patch that tries to set the status directly is refused | Status changes go through `transition()` and nowhere else |
| A stale read is refused | Compare-and-set. This is the case a sheet makes hard, and the honest answer is to re-read the row immediately before writing it and refuse if it moved |
| Finding by address matches every alias, ignoring case, and does not match an address that merely contains the one asked for | Substring matching finds the wrong person |

The write rules are not the adapter's to reimplement. They live in
[`src/store/transitions-guard.ts`](../../src/store/transitions-guard.ts): read
the row, call `guardTransition()`, write only when the outcome is allowed.

## Changing the sheet later

Add a column, never rename or retype one, and never delete one. A column that
has stopped being used stays in place and is ignored. The SQLite migrations
work the same way and say so
([`src/store/sqlite/migrations/index.ts`](../../src/store/sqlite/migrations/index.ts)).

Run `jml store verify` before and after any change and compare the tombstone
count and the exact day-0 selection as numbers rather than as an impression.
Sorting a sheet is enough to lose a row into a merged cell, and a lost
tombstone is the worst failure on record for this class of automation: see
[the four layers against a mass re-fire](../state-machine.md#the-four-layers-against-a-mass-re-fire).

## Related pages

- [Architecture: the store split](../architecture.md#the-store-split)
- [The state machine](../state-machine.md)
- [Notion as the people store](notion.md)
- [Configuration reference](../config-reference.md#keys)
