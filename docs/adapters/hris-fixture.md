# A JSON file as the HR system

The fixture adapter reads a snapshot out of a file instead of an HR API. It is
the only way to exercise the sync, the detection and the store commands without
a live tenant, and it is what `jml demo` runs against.

It needs no credential. `hris.adapter: fixture` is what `jml init` writes, and
the shipped `jml.config.yaml` points it at
[`src/cli/fixtures/demo.json`](../../src/cli/fixtures/demo.json).

Two things it is not. It is not a way to rehearse against your own people
without a credential: something has to produce the file, and a hand-written one
proves your file, not your tenant. And it is not a store: the file is read, never
written. Everything the toolkit records goes to the people store.

## Getting past the shipped defaults

The generated configuration deliberately does not run out of the box.
`hris.minPlausibleHeadcount` defaults to 25 and the demo fixture holds seven
people, so the first command that reads the HR system stops:

```
./src/cli/fixtures/demo.json holds 7 people, below the stated floor of 25. Nothing is written from a snapshot that small.
```

That is the plausibility floor doing its job on a snapshot that really is too
small. To rehearse against the shipped fixture, lower the floor **in a scratch
copy of the configuration**, not in the one you will point at your tenant:

```
node bin/jml.mjs init --dir ./rehearsal
```

Then in `rehearsal/jml.config.yaml` set `hris.minPlausibleHeadcount: 3`, and run
with `--config`:

```
node bin/jml.mjs store bootstrap --config ./rehearsal/jml.config.yaml
node bin/jml.mjs store verify   --config ./rehearsal/jml.config.yaml
```

The pipeline applies the same floor a second time, to the **employed** subset, so
a floor above three still aborts `jml sync` on this fixture with
`hris_implausible`. Both refusals are the point of the floor: lower it for a
rehearsal, and set it to your real headcount before you arm anything.

**Point the rehearsal at its own store and audit directory.** A relative
`store.path` or `audit.jsonl.dir` resolves against the working directory, not
against the configuration file, so a second configuration file left on the
defaults writes into the same `./data/jml.sqlite` and `./audit` as the first one.
Set both in the scratch copy:

```yaml
store:
  adapter: sqlite
  path: ./rehearsal/data/jml.sqlite
audit:
  jsonl:
    dir: ./rehearsal/audit
```

Every secret reference in the file still has to resolve, whichever adapter is
selected: references are resolved once at start-up, so the identity, Google and
HR rows all fail even on a fixture run. The generated file keeps its `hris.hibob`
block whichever adapter is chosen, so its two references are among them. They do
not have to be real. Nothing on this path calls a provider, so an obvious
placeholder is enough to get moving, and it cannot be mistaken for a working
credential later:

```
set -a; . ./rehearsal/.env; set +a          # the generated token and audit salt
export HIBOB_SERVICE_USER_ID=placeholder
export HIBOB_SERVICE_TOKEN=placeholder
export JUMPCLOUD_API_KEY=placeholder-not-a-key
export GOOGLE_SERVICE_ACCOUNT_JSON='{}'
```

## The file

```json
{
  "_readme": ["Free text. Read by nothing, printed by nothing."],
  "demoToday": "2026-01-15",
  "fetchedAt": "2026-01-15T08:00:00.000Z",
  "complete": true,
  "activeIds": ["p-1001"],
  "people": [
    {
      "hrisId": "p-1001",
      "primaryEmail": "jane.doe@example.com",
      "displayName": "Jane Doe",
      "firstName": "Jane",
      "lastName": "Doe",
      "department": "Technology",
      "jobTitle": "IT Manager",
      "site": "Head Office",
      "managerEmail": null,
      "managerName": null,
      "startDate": "2019-05-06",
      "terminationDate": null
    }
  ]
}
```

| Field | Required | What it does |
| --- | --- | --- |
| `people[]` | yes | Everybody the HR system knows, leavers included. |
| `activeIds[]` | yes | The ids reported as **employed**. Absence from this list is what makes somebody a leaver. |
| `complete` | no | `false` replays a truncated read: the adapter throws and no snapshot is produced. |
| `fetchedAt` | no | Stamped into the snapshot. Defaults to now. |
| `demoToday` | no | The date the file is written around. This adapter ignores it; `jml demo` pins its clock to it. |
| `_readme` | no | A string or an array of strings. Nothing reads it. |

`activeIds` has no default in either direction on purpose. An empty default reads
as everybody having left, and a full default means a fixture could never express
a leaver at all.

Per person, only `hrisId`, `primaryEmail` and `displayName` carry weight;
everything else is optional and may be `null`. A person with no work mailbox
keeps an empty address rather than being dropped, because dropping them here
would look exactly like somebody leaving.

Dates are ISO, never locale-formatted. `terminationDate` is the contract end the
HR system holds and `lastWorkingDay` is the last day the person is in. Where both
are present the earlier one decides, and offboarding starts the day after it: a
person whose last shift is on the Wednesday should not keep a working laptop until
the contract ends on the Friday. A date before `startDate` is treated as an
earlier stint and ignored. The day-0 selection is derived from that leaving date
and from `leaver.terminationLookbackDays`.

`inScope` says whether IT provisions accounts for the person: `true`, `false`, or
absent for "the HR system did not say", which is treated as `true`. A person
marked `false` is never announced as a joiner and, in the next phase, never
activated. They stay in the leaver set, because scope decides whether accounts
are created and says nothing about accounts that already exist.

## What it refuses

Each of these throws rather than returning a partial snapshot, because a
half-read HR system and a company where everybody left look identical:

| Refusal | Cause |
| --- | --- |
| `is not valid JSON` | the file does not parse |
| `has no people array` | `people` missing or not an array |
| `has no activeIds array` | `activeIds` missing or not an array |
| `people[N] has no hrisId` | the id is the only key a person has |
| `lists hrisId X twice` | an id is one person |
| `activeIds[N] is not a non-empty string` | a blank or non-string id |
| `lists N employed id(s) that are not in people` | the snapshot contradicts itself |
| `is marked as a truncated read` | `complete: false` |
| `holds N people, below the stated floor` | the plausibility floor |

## Writing your own fixture

Give every person a comment in `_readme` saying which rule they are there to
make visible. The demo fixture does that, and it is why it is still readable:
seven people, one rule each, including the plus-addressed leaver whose rename
must be read as an alias rather than a new identity, and the historic leaver
that has to park rather than be offboarded.

The behaviour is covered by
[`test/unit/hris-fixture-adapter.test.ts`](../../test/unit/hris-fixture-adapter.test.ts) and the
regression tests named in [docs/incidents.md](../incidents.md).

## Writing an adapter for your own HR system

The interface is one snapshot read plus a connection check
([`src/hris/types.ts`](../../src/hris/types.ts)). HiBob is the reference
implementation in [`src/hris/hibob/`](../../src/hris/hibob/). Three rules the
fixture adapter follows and a new adapter has to follow too:

- A partial read throws `HrisIncomplete`. It never returns what it managed to
  get.
- An implausibly small snapshot throws `HrisImplausible` with the floor and the
  count, so the message names both.
- A record-level oddity, such as a missing address, goes in the snapshot's
  `oddities` rather than being dropped or aborting the run for everybody.
