# Notion as the people store

Read this first: **the Notion adapter is not implemented in this release.** The
configuration schema accepts it and the store interface is written against it,
but no code connects to Notion. Configuring it stops the CLI before anything
runs:

```
$ jml doctor
store.adapter is "notion", which this release ships as an interface only.
Use the sqlite store, or the memory store for a rehearsal.
see docs/config-reference.md#keys
```

Exit code 78. The refusal happens in `buildStore()` in
[`src/cli/commands/context.ts`](../../src/cli/commands/context.ts), before a
run starts, so there is no half-working state to discover later.

This page is here for two reasons: so you know what the shipped default is
instead, and so that anybody writing the adapter has the contract in one place
rather than reading it out of the SQLite implementation.

## You probably do not need this

The default people store needs no setup at all. `jml init` writes a
configuration with:

```yaml
store:
  adapter: sqlite
  path: ./data/jml.sqlite
```

The file is created on first use, the schema is applied by the migration
ledger, and the shipped compose file mounts `./data` so the database survives a
container rebuild. There is nothing to provision, no token to rotate, no rate
limit and no API to be deprecated under you.

The reason to want person records in Notion is that other people can read them
without a terminal. That is a real benefit. It is the only one.

## What it would need: one database, one row per person

| Toolkit field | Suggested property | Notion type | Notes |
| --- | --- | --- | --- |
| `hrisId` | HR id | Title | **The key.** Never the email address |
| `status` | Status | Select | One option per lifecycle status |
| `primaryEmail` | Email | Email | |
| `aliasEmails` | Previous emails | Multi-select or Text | Every address the person has used |
| `displayName` | Name | Text | |
| `firstName`, `lastName` | First name, Last name | Text | |
| `department`, `jobTitle`, `site` | Department, Job title, Site | Text or Select | |
| `managerEmail` | Manager | Email | The default transfer recipient |
| `startDate`, `terminationDate` | Start date, Leaving date | Date | |
| `hold` | Hold | Checkbox | Set by a person, honoured by every selection |
| `holdReason` | Hold reason | Text | |
| `reviewReason` | Review reason | Select | The seven parked reasons |
| `externalIds` | Provider ids | Text | JSON. Never edited by hand while a row is in `offboarding` |
| `googleAccountPresent` | Google account | Checkbox or Select | Three states, not two: yes, no, unknown |
| `offboarding` | Offboarding record | Text | JSON: the day-0 marker, the legs, the transfer evidence, the blocked reason, the acknowledgement |
| `note` | Note | Text | One slot. The history lives in the audit log |
| `source`, `updatedAt` | Source, Updated | Text, Date | |

Two of those are worth arguing about before anybody writes the code.

**`hrisId` is the title property, and the only key.** A person is keyed on the
identifier the HR system owns, never on their address. Email is an attribute
that changes: people marry, and people are renamed on the way out. Every
serious incident on record in the automation this was ported from came from
treating the address as the identity.

**`offboarding` is one JSON blob rather than fifteen properties.** It is
written and read by the engine and never edited by a person, and splitting it
into properties invites somebody to clear the day-0 marker from the Notion UI.
That marker is the only thing stopping a suspension running a second time.

Two config maps exist so you do not have to rename your properties:

```yaml
store:
  adapter: notion
  token: env:NOTION_API_KEY
  peopleDatabaseId: env:NOTION_PEOPLE_DB_ID
  properties:
    hrisId: Employee ID
    primaryEmail: Work email
  statusValues:
    offboarding: Leaving
    departed: Left
```

`properties` maps this toolkit's field names to your property names.
`statusValues` maps a lifecycle status to your select options. Both default to
empty, meaning the field name is the property name.

The token is a reference (`env:`, `file:` or `op://`), like every other
credential. A literal in the configuration file is a start-up failure.

## Single writer, and why

`StoreCapabilities.singleWriterOnly` would be `true` for this adapter. Notion
has no transactions, so it cannot offer the two things the state machine
depends on:

| Needed | Notion gives you |
| --- | --- |
| Compare-and-set on a status write, so a stale read is refused | read, then write, with a gap in between |
| A lease, so two runs cannot act on the same person at once | a page property that both runs can set |

Read-modify-write with a gap is not a compare-and-set, and a lock held in a
document with no transactions is not a lock. Every write therefore has to
happen under the pipeline lease, and the lease has to be somewhere else.

That is why the toolkit's own bookkeeping is **always local SQLite** whatever
the people store is
([`src/store/types.ts`](../../src/store/types.ts)). With a Notion people store
the state database lands at `data/jml-state.sqlite`. It holds leases, alert
fingerprints, invariant counters and run history, and nothing in it is a
person.

The practical consequence: run the pipeline from **one** place. A second
sidecar pointed at the same Notion database with its own state file has its own
lease, and the lease is the only thing serialising the writes.

## The contract an adapter has to meet

Every people store is held to one conformance suite, shipped as part of the
library so an adapter written for a system this project has never seen can be
tested in one line
([`src/store/conformance.ts`](../../src/store/conformance.ts)):

```
import { describePeopleStoreConformance } from 'jml-toolkit/store/conformance'

describePeopleStoreConformance({
  name: 'notion',
  create: async () => new NotionPeopleStore({ /* ... */ }),
})
```

The cases that will fail first on a page-based API:

| Case | What it asserts |
| --- | --- |
| No delete, and no prune | No method whose name starts with delete, prune, remove, purge, drop, truncate, clear or reset exists. Tombstones are the only thing stopping a historic leaver being offboarded twice |
| A selection returns every row | The suite inserts 1,200 rows by default. The engine this replaces read a single hundred-row page and silently ignored everybody after it. Notion paginates at 100 |
| A second identical sync performs no writes at all | Diff before writing. A store that rewrites every row on every run turns a read-only day into a thousand API calls, and hides the day something did change |
| A blank incoming value never erases a populated stored one | Empty properties are common in exported data |
| The day-0 marker can never be cleared | Refuse the write, do not merely avoid making it |
| A patch that tries to set the status directly is refused | Status changes go through `transition()` and nowhere else |
| A stale read is refused | Compare-and-set. This is the case Notion makes hard |
| A tombstone refuses everything | `departed` is terminal |
| Finding by address matches every alias, ignoring case, and does not match an address that merely contains the one asked for | Substring matching finds the wrong person |

Do not implement the write rules in the adapter. They live in
[`src/store/transitions-guard.ts`](../../src/store/transitions-guard.ts) and
every adapter calls them: read the row, call `guardTransition()`, write only
when the outcome is allowed. A rule implemented three times is a rule that
holds in two places.

## Adding a property to an existing database

The adapter should add a missing property and touch nothing else. That
behaviour does not exist yet, so treat this as the intended design rather than
a description of shipped code:

- add the property, never rename or retype an existing one;
- never delete a property, for the same reason the interface has no delete;
- leave a property that has stopped being used in place and ignore it.

The SQLite migrations already work that way and say so
([`src/store/sqlite/migrations/index.ts`](../../src/store/sqlite/migrations/index.ts)):
forward-only and additive, a migration may add a table, a column or an index,
and may not drop or rewrite one.

Run `jml store verify` before and after any change to the database, and compare
the tombstone count and the exact day-0 selection as numbers. A migration that
loses tombstone rows is the worst failure on record for this class of
automation: see
[the four layers against a mass re-fire](../state-machine.md#the-four-layers-against-a-mass-re-fire).

## Related pages

- [Architecture: the store split](../architecture.md#the-store-split)
- [The state machine](../state-machine.md)
- [A spreadsheet as the people store](sheets.md)
- [Configuration reference](../config-reference.md#keys)
