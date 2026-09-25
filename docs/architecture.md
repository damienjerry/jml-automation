# Architecture

Three pieces. A TypeScript library that holds every decision, an authenticated
HTTP sidecar that exposes a few of them, and five n8n workflows that do nothing
but call the sidecar on a schedule and post the result.

```
  ┌──────────────────────────────┐        ┌────────────────────────────────────┐
  │  n8n  (stock, pinned)        │        │  jml  (this repository)            │
  │                              │        │                                    │
  │  schedule 07:00 ─────────────┼───────►│  POST /v1/runs        202 + runId  │
  │  schedule 06:45 ─────────────┼───────►│  GET  /v1/doctor      200 or 503   │
  │  form (authenticated) ───────┼───────►│  POST /v1/leavers/run              │
  │  form (authenticated) ───────┼───────►│  POST /v1/devices/disposition      │
  │  error trigger ──► chat post │        │                                    │
  │                              │◄───────┤  poll GET /v1/runs/{runId}         │
  │  holds ONE toolkit secret:   │        │                                    │
  │  Authorization: Bearer ...   │        │  holds EVERY vendor credential,    │
  │                              │        │  the config, the people store and  │
  └──────────────────────────────┘        │  the audit log                     │
        no vendor credential              └────────────────────────────────────┘
                                              │            │           │
                                     ┌────────┘            │           └────────┐
                                     ▼                     ▼                    ▼
                              HR system (read)    identity provider      Google Workspace
                                                  + device channel       (directory, Gmail,
                                                                          licensing, transfer)
```

Only the read-only half of this toolkit has run against a real tenant (one
shadow run, 2026-09-25), no write has, and the n8n bundle has never been
imported into a running n8n instance. The claims below are about the code and
its tests.

## What runs where

| Piece | Lives in | Holds | Runnable on its own |
| --- | --- | --- | --- |
| Library | [`src/`](../src), published surface in [`src/index.ts`](../src/index.ts) | every decision, every refusal, the state machine | yes, through the `jml` CLI |
| Sidecar | [`src/server/`](../src/server) | one bearer token, plus whatever the library holds | `jml serve`, or the `jml` container |
| Workflows | [`n8n/workflows/`](../n8n/workflows) | schedule, forms, chat post, error trigger | no; they call the sidecar |

The CLI is the whole library. Everything the sidecar can do can be done from a
terminal, and one route is deliberately not exposed at all: reassigning a
device to a named person is `jml device dispose` only, because the API route
does not yet pass a new owner through. An option that silently did something
other than what it says is worse than an option that is not there.

## Why the workflows contain no logic

The version of this automation these files were extracted from ran its engine
inside n8n Code nodes. Each of the following is a property of that choice
rather than bad luck:

- the task-runner sandbox has no global `fetch`, and its HTTP helper discards
  the body of a non-2xx response, so a 401 read as a network error for hours;
- a chat post that answered `200` with `ok:false` was believed by three
  workflows for weeks, because nothing checked the body;
- an expression written into a raw JSON body was sent as literal characters, so
  a channel id arrived as the text of the expression;
- a variable used above its own declaration threw only on the runs that had
  work to do, so the workflow looked healthy for an hour;
- `staticData` accumulated a snapshot of real people and went into every
  export;
- a node caps out well below the ten minutes a device receipt can take.

None of that can be typechecked, unit-tested or secret-scanned. In a library
all of it can. `npm run validate:workflows` rejects a Code node outright, along
with a hardcoded URL, a credential id, `staticData`, a raw JSON body, an
unasserted chat post and a missing error workflow. Regression tests hold the
same line:
[`slack-ok-false`](../test/regression/slack-ok-false.test.ts),
[`n8n-export-carries-static-data`](../test/regression/n8n-export-carries-static-data.test.ts),
[`n8n-hardcoded-url-in-shipped-export`](../test/regression/n8n-hardcoded-url-in-shipped-export.test.ts),
[`n8n-red-execution-alerts-nobody`](../test/regression/n8n-red-execution-alerts-nobody.test.ts),
[`n8n-slack-assertion-kills-sibling-branch`](../test/regression/n8n-slack-assertion-kills-sibling-branch.test.ts).

n8n is still the front door, because it is the runtime most IT teams already
run and a schedule with a visible execution list is easier to trust than a cron
line on a box. Full detail of the bundle, including how to prove the schedule
actually fires, is in [`n8n/README.md`](../n8n/README.md).

## One pipeline run, in order

`jml run`, or `POST /v1/runs`, does this and in this sequence
([`src/engine/pipeline.ts`](../src/engine/pipeline.ts)):

| # | Step | On failure |
| --- | --- | --- |
| 1 | Take the pipeline lease, or skip | a skip, reported, exit 0 |
| 2 | Write a `run.start` intent row to the audit log | abort |
| 3 | Assert the tombstone count has not fallen below the recorded baseline | abort, `invariant_failed` |
| 4 | Read the HR system **once** | abort, `hris_incomplete`, `hris_implausible` or `hris_unavailable` |
| 5 | Sync: reconcile the snapshot into the people store | run continues, marked not ok |
| 6 | Detect: announce joiners and leavers, if the set of people changed | run continues, marked not ok |
| 7 | Leaver engine: day 0, then day 6, then day 7, per person in day order | abort on the circuit breaker or an unwritable audit log |
| 8 | Flush the audit sink | run marked not ok |
| 9 | Send the run summary | run marked not ok |
| 10 | Ping the dead-man, **only if step 9 was delivered** | warning |
| 11 | Raise the tombstone baseline, record the run, release the lease | warning |

Steps 3 and 10 are the two worth arguing about.

**The tombstone check runs before anything else writes, including in a dry
run.** A drop in the number of `departed` rows means somebody removed them
outside this toolkit, and at that moment every removed person looks like a
brand new leaver. The correct response to a picture that cannot be trusted is
to touch nothing at all. A dry run is exactly when an adopter wants to be told.

**The liveness ping is last, and only after the notification is proven
delivered.** A dead-man that is pinged whatever happened proves the process
ran. A dead-man pinged after delivery proves the alerting path works too, which
is the part that has failed silently before. An aborted run pings nothing: a
dead-man fed by a refusing run reports a healthy schedule while nothing is
happening.

The ping URL is itself the credential, so it is a secret reference and is only
ever read inside `SecretHandle.use`. Only the resulting status reaches the
report.

## Why one process rather than several schedules

The arrangement this was ported from had five schedules whose ordering lived in
a comment: the HR sync ran fifteen minutes before the offboarding engine, so
that a leaver flipped to terminated in the morning was visible to the same
day's day-0 run.

That is not an ordering. It is a hope, and the day the sync ran late the engine
acted on yesterday's picture. Clock offsets between separate jobs are a race
whose losing case is silent.

So sync, detect and the engine are one process, under one lease, reading one HR
snapshot. Within the engine a person's phases run in day order in the same run,
so a handover that was missed yesterday happens before today's deletion gate is
evaluated.

The lease is why overlap is safe. `withLease` and `acquireOrSkip`
([`src/core/lease.ts`](../src/core/lease.ts)) take a named lease in the state
store with a TTL of 900 seconds: long enough for a slow run, short enough that
a crashed process does not lock the job out until somebody notices. A lease
with no expiry is a lock somebody has to clear by hand at three in the morning.

**A second concurrent run is a skip, not a failure.** It reports the skip and
exits 0, both on the CLI and as HTTP 409. A schedule that overlaps itself is
normal operation, and turning it into a red run teaches people to ignore red
runs. The same shape once queued the same device restart four times in three
minutes because four overlapping runs each read the same pending row.

## The store split

Two stores, deliberately separate
([`src/store/types.ts`](../src/store/types.ts)):

| Store | Holds | Backing | Swappable |
| --- | --- | --- | --- |
| `PeopleStore` | the canonical person records | SQLite (default), or an adapter over something your team already reads | yes |
| `StateStore` | leases, alert fingerprints, invariant counters, run history | **always local SQLite** | no |

The state store is always local because **a lease that lives in a remote
document with no transactions is not a lease.** It is a hope, and two
overlapping runs both suspending the same person is the failure the lease
exists to prevent. A compare-and-set needs the same thing.

Keeping them separate is what makes the people store a free choice. An IT team
that wants person records in a Notion database or a spreadsheet, where people
can read them without a terminal, does not weaken the concurrency guarantees by
choosing that.

Nothing in the state store is a person. It is safe to delete the file and start
again: the run loses its fingerprints and counters, which costs one duplicate
alert and one skipped invariant check, not somebody's account.

The people store has no `delete` and no `prune`, by construction, and its
migrations are forward-only and additive. See
[the state machine](state-machine.md#the-four-layers-against-a-mass-re-fire)
for why.

Any adapter is held to the same behaviour by a conformance suite that ships as
part of the library rather than as a test file
([`src/store/conformance.ts`](../src/store/conformance.ts)):

```
describePeopleStoreConformance({ name: 'my-adapter', create: () => makeStore() })
```

That matters because the guarantees are the ones an account depends on. An
adapter that quietly loses a tombstone, or that reads one page of a selection,
does not fail loudly. It fails by offboarding somebody who left years ago, or
by never offboarding somebody at all, and neither shows up until afterwards.

## Recording the decision: node:sqlite

The default people store uses `node:sqlite`, the module that ships with Node
itself.

| Considered | Why not |
| --- | --- |
| A hosted database | The toolkit has to be runnable by one person on one machine in an hour |
| A document store as the only store | A lease and a compare-and-set need a real transaction |
| A native SQLite driver | A native module to compile is a support burden on every platform an adopter runs |

The cost of `node:sqlite` is a single `ExperimentalWarning` on first use, which
reads as a fault to somebody running this for the first time. The CLI entry
point filters that one warning and nothing else
([`bin/jml.mjs`](../bin/jml.mjs)), and refuses to start below Node 22.13 with
an actionable message.

Verified while writing this page, on Node 22.22.1: the store opens with
`journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout = 5000`, and
transactions use `BEGIN IMMEDIATE` so two concurrent runs collide at the start
rather than one of them discovering halfway through that it cannot upgrade its
lock. WAL is there so a read (`jml doctor`, or a second terminal) cannot block
the run that is writing.

The store sits behind the `PeopleStore` interface and is built in one place,
`buildStore()` in [`src/cli/commands/context.ts`](../src/cli/commands/context.ts),
so swapping it is a one-file change plus a conformance run.

## The two locks on arming

Arming needs two separate decisions, in two different places, and neither one
implies the other.

| Lock | Where | Default | Effect when absent |
| --- | --- | --- | --- |
| Per run | `--armed` on the CLI, or an explicit `dryRun: false` in an API body | dry run | The run plans and reports, touching no provider |
| Per action | `mode: armed` plus `armedActions` in the configuration | `dry-run`, empty list | An action not in the list records `not_armed` on the leg rather than running |

`mode: armed` with an empty `armedActions` is refused at start-up by the schema:
"one switch that arms everything is how a rehearsal becomes a mass
suspension". The eight actions are `suspend`, `autoreply`, `licence`,
`transfer`, `google_suspend`, `delete`, `device_unbind` and `device_handover`,
so you can arm suspension, watch a cycle, then arm the handover, then arm
deletion, and see at each stage exactly what was declined.

An unarmed leg records `not_armed` rather than vanishing, which is the
difference between a report you can read and a silence you have to interpret.

Both ends of the API fail safe in the same direction. `dryRun` must be the
boolean `false`; the string `"false"` stays a dry run, because a caller sending
the wrong type should get the safe reading. In the workflows, `JML_DRY_RUN` is
read as `!== 'false'`, so an unset or misspelt variable changes nothing on a
real tenant.

Every object in the configuration schema is `.strict()`, so an unknown key is a
start-up failure rather than a silently ignored typo in a safety flag. Two
device-gate flags are declared as `literal(true)` and cannot be turned off at
all. Full list of keys: [configuration reference](config-reference.md#keys).

## The sidecar

`jml serve` runs an HTTP listener whose routing is a pure function of a request
([`src/server/routes.ts`](../src/server/routes.ts)); the socket handling is the
thin part ([`src/server/http.ts`](../src/server/http.ts)).

| Route | Answers |
| --- | --- |
| `GET /v1/health` | `200 {ok:true}`. The only unauthenticated route, and it answers one field |
| `GET /v1/doctor` | `200` when every probe passed, `503` when one did not |
| `POST /v1/runs` | `202` with a `runId` and a `poll` path, or `409` if a run of that kind is in flight |
| `GET /v1/runs` | the recent run list |
| `GET /v1/runs/{runId}` | `202` while running, `200` with the report when done, `500` when the job threw, `409` when the run skipped on the lease |
| `POST /v1/leavers/run` | `202` with a `runId` |
| `GET /v1/leavers/{hrisId}` | one person, or `404` |
| `POST /v1/leavers/hold`, `/release`, `/ack`, `/tombstone` | `200` with the updated person |
| `POST /v1/devices/preflight` | every reason a disposition could be refused |
| `POST /v1/devices/disposition` | `202` with a `runId` |

Five properties are load-bearing:

- **Runs are asynchronous.** Every route that starts work answers 202 and the
  caller polls. This is not a preference: the device paths hold a command
  association for two minutes, wait up to ten minutes for a receipt and then
  confirm silence for another ten, which is longer than any automation tool's
  HTTP node will wait. A synchronous route would have made the timeout the
  limit on what the toolkit could do. It also removes the first-run problem,
  where a backlog of leavers takes longer than any HTTP timeout allows. See
  [`device-run-bounded-by-an-http-timeout`](../test/regression/device-run-bounded-by-an-http-timeout.test.ts).
- **The token comparison is constant-time over fixed-length digests.** A plain
  string comparison leaks the length of the matching prefix through timing, and
  a comparison over raw bytes throws on a length mismatch, which leaks the
  length. Both sides are hashed first so every comparison is the same shape.
  A 401 carries no detail: no token and a wrong token look the same from
  outside.
- **The body is capped at 64 KB** and the connection is dropped past that. A
  service with no cap can be held open by one request until it runs out of
  memory, and this process is the one holding every credential.
- **Every response goes out through the redaction registry**, so a body that is
  safe by construction cannot be made unsafe by a later change to what a report
  carries. See
  [`api-response-carries-a-credential`](../test/regression/api-response-carries-a-credential.test.ts)
  and [`secret-in-error-redacted`](../test/regression/secret-in-error-redacted.test.ts).
- **The shipped compose file publishes no port for the sidecar.** It is
  reachable as `http://jml:8787` on the private network and from nowhere else,
  so the bearer token is the second line of defence rather than the only one.

The actor comes from an `X-JML-Actor` header. A value prefixed `human:` is
recorded as a person; anything else is a system actor. That distinction is
load-bearing rather than cosmetic: the circuit-breaker override is refused to a
system actor, so a scheduled workflow cannot raise the day-0 limit on its own.

The service refuses to start if the audit log cannot be written, rather than
starting and discovering it later:
[`serve-starts-with-an-unwritable-audit-log`](../test/regression/serve-starts-with-an-unwritable-audit-log.test.ts).

## The audit log

Two rows per action, not one
([`src/audit/types.ts`](../src/audit/types.ts),
[`src/audit/jsonl.ts`](../src/audit/jsonl.ts)):

| Phase | When | Effect of a failed write |
| --- | --- | --- |
| `intent` | **before** the provider call | the call does not happen |
| `outcome` | after it, citing the intent row's sequence number | the run stops |

A single row written afterwards cannot describe the case that matters most,
which is a call that was made and whose result was never learned. An unwritable
log aborts the whole run rather than one person: without the log there is no
record of what a destructive step did, and the remaining people would be acted
on unrecorded too. See
[`audit-intent-append-blocks-the-step`](../test/regression/audit-intent-append-blocks-the-step.test.ts).

The outcome row carries the intent row's sequence number in `intentSeq`.
Correlating on run id, action and subject instead almost works, and stops
working precisely when a step is retried within one run.

**The default sink is a local append-only JSONL file, one per day.** The
automation this was ported from pushed its only record of what it had done to a
log service on a best-effort basis, inside an empty catch. An audit log that
depends on a network service is unavailable exactly when it is most needed. So
the file is opened with `O_APPEND`, every line is fsynced before the call it
describes is allowed to happen, and a write that fails throws rather than
degrading.

A remote sink is optional and always secondary. The local file stays primary,
because a remote sink that went first could hold a row for a step the local
write then refused, which is worse than a missing row: it is a false record.
The fan-out sink counts the secondary failures it tolerated and they appear in
the run summary.

**Every line carries the hash of the line before it.** That does not stop
anybody editing the file, but it does mean an edited or deleted line cannot be
hidden. `jml audit verify` walks the chain and names the first line that does
not follow from its predecessor:
[`audit-line-tampered`](../test/regression/audit-line-tampered.test.ts).

Addresses are replaced with a salted hash when `audit.minimisePii` is on, which
is the shipped default, and the schema refuses that setting without a salt: an
unsalted hash of an address is reversible by guessing a name. This was
previously not implemented at all. The key existed, the documentation said
addresses were stored as a hash, and the sink wrote them in clear, permanently,
because the log is append-only. A quiet failure there builds a permanent
directory of everybody who has ever left, in a file whose whole point is that
nothing can be removed from it. See
[`audit-log-keeps-addresses-in-clear`](../test/regression/audit-log-keeps-addresses-in-clear.test.ts).

Back the `audit/` directory up with your ordinary file backup, and run
`jml audit verify` against the copy.

## Where credentials live

Every vendor credential is in the sidecar: the identity provider key, the
Google service account, the HR system token. n8n holds one toolkit secret, the
bearer token, plus whatever credential it needs for its own error
notifications.

So an n8n workflow export cannot carry your Google service-account key, because
n8n never had it. That claim is checkable rather than something to take on
trust: `docker compose config` prints the resolved environment of both services
and the n8n service names no vendor variable, and
`grep -ri credential n8n/workflows` shows the exports carrying no credential
material.

Configuration never holds a secret value. Every credential field is a
reference, matched against a pattern at load time, in one of three forms:
`env:NAME`, `file:/path` or `op://<vault>/<item>/<field>`. A literal in the
configuration file is a start-up failure:
[`literal-secret-in-config`](../test/regression/literal-secret-in-config.test.ts).
Resolved values live behind a `SecretHandle` whose only operation is `use`, and
each one registers itself with a process-wide redactor that every log line,
error body and API response passes through.

`jml config show` prints the configuration as shape, references and lengths,
never values. `jml doctor` probes every credential and every authorised scope
with a live call, and also prints the age of the oldest parked row, because a
parked row takes no action and raises nothing, so over-suppression looks
exactly like a quiet week.

## Related pages

- [The state machine](state-machine.md): the five statuses, the gates, and the failure each safeguard prevents.
- [Incident catalogue](incidents.md): the failures behind the design decisions above.
- [Configuration reference](config-reference.md#keys): generated from the schema.
- [Notion as the people store](adapters/notion.md) and [a spreadsheet as the people store](adapters/sheets.md).
- [The n8n bundle](../n8n/README.md).
