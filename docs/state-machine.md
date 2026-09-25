# The state machine

This is the page to read before you arm anything. It describes the only five
states a person can be in, who is allowed to move them between those states,
and what stops a run doing something you cannot undo.

Everything here is taken from [`src/core/transitions.ts`](../src/core/transitions.ts),
[`src/store/transitions-guard.ts`](../src/store/transitions-guard.ts),
[`src/engine/sync.ts`](../src/engine/sync.ts) and
[`src/engine/leaver/engine.ts`](../src/engine/leaver/engine.ts). Where a
safeguard exists because something once went wrong, the failure is named and
the regression test that holds the guard in place is linked.

Two things to be clear about before you trust any of it:

- **Nothing in this toolkit has ever run against a real tenant.** The
  behaviour below is covered by tests and by an offline demo. It has not been
  proven against live Google Workspace or a live JumpCloud organisation.
- The two device uninstall scripts have never run on real hardware. Their
  manifest records `provenOnHardware: false` and a handover is refused unless
  you name the machine you canaried on. See
  [canary a device script](runbooks/canary-a-device-script.md).

## The five statuses

| Status | Meaning | Entered by | What acts on it |
| --- | --- | --- | --- |
| `hired` | Start date is in the future | the HR sync | nothing; no access work runs |
| `active` | In the HR system's employed set | the HR sync | nothing, but the row protects its own account ids and addresses from other rows |
| `terminated` | Gone from the employed set, offboarding not started | the HR sync | the day-0 selection |
| `offboarding` | Day 0 has run and `suspendedAt` is set | the leaver engine | the day-6 and day-7 selections |
| `departed` | Terminal. A tombstone | the leaver engine, or a person | nothing, ever |

Employment is read from the snapshot's **employed set**, never from a status
word on the HR record. A lifecycle label means different things in different HR
systems; absence from the employed list is the one signal that travels. See
[`hris-employed-set-not-status-string`](../test/regression/hris-employed-set-not-status-string.test.ts).

## Ownership is checked on every write, not documented

Three kinds of caller exist: `sync`, `engine` and `human`. Each edge in the
table below names the one kind allowed to use it.

That rule is not advice. A status can only change through
`store.transition()`, which calls `guardTransition()`, which calls
`decideTransition()`. A write the table does not contain is refused with one of
three reasons:

| Refusal | Cause |
| --- | --- |
| `illegal_transition` | no such edge, or the row is terminal |
| `owner_forbidden` | the edge exists, but not for this kind of caller |
| `stale_status` | the row moved since the caller read it, so the compare-and-set failed |

`store.patch()` cannot write a status at all, and `store.upsert()` never
changes one. The sync may write only the fields the HR system owns
(`HRIS_OWNED_FIELDS`), which is an allowlist so that a field added to `Person`
later is out of the sync's reach by default. The earlier arrangement, where a
sync assumed to be patching names also carried account ids and the hold flag,
is the reason.

"The HR sync must never revive a row the offboarding engine owns" was a comment
in the automation this was ported from. Comments do not stop a bulk update.

## The transition table

Owned by the **HR sync**:

| From | Event | To | Why the edge exists |
| --- | --- | --- | --- |
| `hired` | `hris.active` | `active` | Start date reached and the person is in the HR active set. |
| `hired` | `hris.terminated` | `terminated` | Start date reached but the person never appeared as active: an offer that fell through. |
| `active` | `hris.hired` | `hired` | The HR system moved the start date into the future. |
| `active` | `hris.terminated` | `terminated` | The person left the HR active set. **The only route into offboarding.** |
| `terminated` | `hris.active` | `active` | Rehired, or the leaving date was cancelled, before any suspension. Once `suspendedAt` is set the sync may not do this. |
| `terminated` | `hris.hired` | `hired` | A cancelled leaver whose start date is now in the future. |
| `active` | `sync.role_change_tombstone` | `departed` | The same HR id reappeared as a genuinely different identity. Rare and heavily conditioned; see below. |

Owned by the **leaver engine**:

| From | Event | To | Why the edge exists |
| --- | --- | --- | --- |
| `terminated` | `engine.day0_suspended` | `offboarding` | Day 0 ran and `suspendedAt` was written. Written once; a row that has it is never selected for day 0 again. |
| `terminated` | `engine.phantom_departed` | `departed` | No account exists anywhere, so there is nothing to suspend. |
| `offboarding` | `engine.phantom_departed` | `departed` | A later phase found no accounts left to act on. |
| `offboarding` | `engine.day7_departed` | `departed` | Deletion completed **and was read back**. The end of the automatic path. |

Owned by a **human**:

| From | Event | To | Why the edge exists |
| --- | --- | --- | --- |
| `terminated` | `human.tombstone` | `departed` | Somebody decided this row needs no automated offboarding (historic, or handled by hand). |
| `offboarding` | `human.tombstone` | `departed` | Somebody finished the offboarding by hand and closed the row. |

There is no edge out of `departed` for anybody. Recreating a person means a new
HR record, which means a new `hrisId`, which means a new row.

```
                   HR sync                             leaver engine
                   =======                             =============

        hris.hired
   ┌──────────────────┐
   │                  ▼
   │              ┌────────┐   hris.active    ┌────────┐
   │              │ hired  │────────────────► │ active │ ◄──┐
   │              └────────┘                  └────────┘    │ hris.active
   │                  │                        │    │       │ (only while
   │  hris.terminated │       hris.terminated   │    │       │  suspendedAt
   │                  ▼                         ▼   │       │  is unset)
   │             ┌────────────────────────────────┐ │       │
   └─────────────│          terminated            │─┼───────┘
    hris.hired   └────────────────────────────────┘ │
                    │            │           │      │ sync.role_change_tombstone
     engine.day0_   │            │ human.    │      │ (all five conditions met)
     suspended      │            │ tombstone │      │
                    ▼            │           │      │
              ┌─────────────┐    │           │      │
              │ offboarding │    │           │ engine.phantom_departed
              └─────────────┘    │           │      │
                 │    │          │           │      │
   engine.day7_  │    │ human.   │           │      │
   departed      │    │ tombstone│           │      │
                 │    │  / engine.phantom_   │      │
                 ▼    ▼          ▼           ▼      ▼
              ┌──────────────────────────────────────────┐
              │      departed  (TERMINAL, no exit)       │
              └──────────────────────────────────────────┘

  hold = true          freezes a row against the sync AND the engine
  reviewReason != null excludes a row from every automatic selection
```

## Flags and markers

Statuses are coarse. The detail lives in flags on the person and markers inside
`offboarding`. Knowing who writes each one is how you read a row.

| Field | Set by | Cleared by | What it means |
| --- | --- | --- | --- |
| `hold` / `holdReason` | a human (`jml leaver hold --reason`) | a human (`jml leaver release`) | The row is frozen against every automation, the HR sync included |
| `hold` (auto) | the sync, on reinstatement after day 0 | a human | See [reinstatement](#reinstatement-is-a-human-decision) |
| `reviewReason` | the sync or the engine | a human (`jml leaver release`) | Parked. No automatic action, and the row is excluded from every selection |
| `offboarding.suspendedAt` | the engine, at the end of day 0 | **nothing, ever** | The day-0 idempotency key |
| `offboarding.legs` | the engine, every phase | nothing | Per-step state, `verified` flag and an attempt counter that accumulates across runs |
| `offboarding.transferredAt` / `transferId` / `transferRecipient` | the engine, day 6 | nothing | The provider reported the file handover finished |
| `offboarding.transferOverride` | a human | a human | Somebody waived the handover. The row is no longer selected for day 6 |
| `offboarding.deleteBlockedReason` | the engine, day 7 | the engine, when the deletion completes | Why the deletion was refused. Re-evaluated live on every run |
| `offboarding.boundDevices` | the engine, day 7 | the engine | The machines the identity provider said were bound at the moment of refusal |
| `offboarding.blockedFingerprint` | the engine, day 7 | the engine | Hash of `reason` plus the device ids, so the alert fires on change rather than on a timer |
| `offboarding.operatorAck` | a human (`jml leaver ack`) | nothing | Somebody agreed the deletion may proceed, recorded with their name and the time |
| `offboarding.departedAt` | the engine, or a human tombstone | nothing | The day the row closed |
| `googleAccountPresent` | the engine, from the Google directory | the engine | Read from Google, never inferred from the identity provider |
| `externalIds` | the engine, from a successful lookup | a human patch, to defuse a mistaken identity | Provider account ids |

Two of those need spelling out.

**`suspendedAt` is immutable by construction.** Clearing it, or dropping the
whole `offboarding` record while it holds a value, throws
`StoreWriteRefused('suspended_at_immutable')` rather than returning a refusal:
it is a programming error, not an operational outcome. A cleared marker makes
an already suspended person selectable for day 0 again. See
[`day0-marker-cleared-refires`](../test/regression/day0-marker-cleared-refires.test.ts).

**The blocked fingerprint is over the set, and nothing else.** No date, no
count, no rendered message. An earlier gate hashed its own message, the message
carried today's date, and the "notify on change" rule fired every day. So
silence about a blocked deletion means the same blockage, not a resolved one,
and that is said in the notification itself. Compare
[`blocked-renotify-every-run`](../test/regression/blocked-renotify-every-run.test.ts)
with
[`blocked-renotify-only-on-change`](../test/regression/blocked-renotify-only-on-change.test.ts).

## Why a row is parked

A parked row takes no automatic action and waits for a person. Over-suppression
is silent, so every parked row appears in the run summary and `jml doctor`
always prints the age of the oldest one.

| `reviewReason` | Set when | How it clears |
| --- | --- | --- |
| `termination_older_than_lookback` | The leaving date is missing, unparseable, or older than `leaver.terminationLookbackDays` | `jml leaver release`, or `jml leaver tombstone --reason` if it is historic |
| `identity_mismatch` | The provider record disagrees with what the row holds, or neither provider could confirm an account and at least one lookup failed | Fix the row, then release |
| `identity_claimed_by_live_person` | An employed person holds this account id or this address | Resolve the duplicate in the HR system, then release |
| `ambiguous_provider_match` | A provider lookup matched more than one account | Resolve the duplicate at the provider, then release |
| `no_transfer_recipient` | Nobody could be resolved to receive the leaver's files | Name a recipient, or waive the handover, then release |
| `max_leg_attempts` | A step failed `leaver.maxAttemptsPerLeg` times | Fix the cause, then release |
| `reinstated_after_day0` | The HR system reports this person as employed again, after suspension | A person decides; see below |

## Reinstatement is a human decision

After suspension the sync never revives a row. It freezes it and asks for
somebody.

The `terminated -> active` edge exists, and is exactly what you want for a
cancelled leaving date or a rehire **before** anything was suspended. Once
`suspendedAt` is set, the same HR signal takes a different path: the row keeps
its status, gains `hold: true` with a reason, gains
`reviewReason: reinstated_after_day0`, and is announced once.

The reason is in the code and worth repeating: the accounts may already be
deleted, the files may already have been handed to somebody else, and a sync
cannot know which. Restoring access is a decision.

Two details of that path matter:

- The protective write happens **before** the notification, and does not depend
  on a chat API being reachable. A failed notification makes the run not ok,
  which is reported. An unfrozen row would be acted on.
- The hold is itself the idempotency key for the announcement. The next run
  skips a held row before it reaches that decision, so there is no separate
  gate to get wrong.

A row that is already `departed` and whose person the HR system now reports as
employed is reported, not acted on. The tombstone is terminal, so they need a
new HR record, and somebody has to decide that.

See [`reinstated-after-day0-auto-holds`](../test/regression/reinstated-after-day0-auto-holds.test.ts)
and [`sync-revives-offboarding-row`](../test/regression/sync-revives-offboarding-row.test.ts).

## The leaving date

Two HR fields can describe when somebody leaves. The termination date is when the
contract ends. The last working day is the last day the person is actually in,
and it is often earlier: notice served away from work, garden leave, a contract
that ends on a Friday after a last shift midweek.

The toolkit uses the last working day where the HR system holds one and it is
not after the termination date, otherwise the termination date. Offboarding
starts the day **after** that date, while the HR system may still list the
person as employed. A date before the current start date belongs to an earlier
stint and is ignored, so a rehire is never offboarded on their first morning.
The rule lives in one place, `src/hris/leave-date.ts`, and every selection,
notification and lookback check reads it rather than the raw field.

Why: the automation this was ported from keyed on the employed list alone, and
left access open between somebody's last day in and the end of their contract.

## Who IT provisions for

An HR system holds people who never get a work account: drivers, hub staff,
contractors on their own kit. The HR system usually knows which is which, in a
field IT can read. The toolkit reads it into `inScope` and leans one way when it
cannot: a person wrongly in scope costs a lookup, a person wrongly out of scope
costs their accounts never being closed, so unknown reads as in scope.

`inScope = false` keeps a person out of joiner announcements and, in the next
phase, out of activation. It does not keep them out of the leaver set. Scope
decides whether accounts are created; it says nothing about accounts that
already exist from before the flag was set, and the engine's own provider
lookups decide what there is to close. Out-of-scope joiners are counted in the
run summary rather than dropped, so a run that announces nobody is
distinguishable from one that read nobody.

Why: every HR record was once treated as needing accounts, which announced a
joiner for each of them and would have tried to activate them.

## Selection: who is acted on today

The selections are pure functions over rows
([`src/engine/leaver/select.ts`](../src/engine/leaver/select.ts)), so "would
this person be suspended today" is answerable in a test, at any date, without a
database.

| Phase | Selected when | Not selected when |
| --- | --- | --- |
| Day 0 | `status = terminated`, a leaving date is present and on or after `today - terminationLookbackDays` | `suspendedAt` is set, `hold` is set, `reviewReason` is set, or there is no leaving date at all |
| Day 6 | `status = offboarding` and `suspendedAt <= today - transferDay` | `transferredAt` is set, `transferOverride` is set, `hold`, or parked |
| Day 7 | `status = offboarding` and `suspendedAt <= today - deleteDay` | `hold`, or parked |

Three properties of that table are deliberate.

**Day 6 and day 7 select on or before their day, never on the day exactly.**
Keying on "the leaving date is exactly six days ago" means a missed run skips
the handover silently, and the deletion then arrives anyway.

**A day-0 row with no leaving date at all is never selected.** It cannot be
aged, and acting on one is indistinguishable from acting on a record nobody has
looked at for years.

**Blocked rows are re-selected for day 7 every run, on purpose.** The gate is
evaluated live against the provider, so yesterday's blockage is not evidence
about today. What is change-only is the notification, not the check.

The day-0 store filter is the exported constant `DAY0_SELECTION`, shared by the
engine, `jml store verify` and the bootstrap check, so the three cannot drift
into slightly different ideas of the same set.

## The gates in front of a deletion

Day 7 evaluates four gates in cheapest-first order. The first shut gate is the
reason reported, and the reported reason is what an operator acts on.

| Gate | Blocked reason | Refuses when |
| --- | --- | --- |
| Handover | `transfer_incomplete` | The provider has not reported the file transfer finished, and no person waived it |
| Identity | `identity_mismatch` | Anybody who still works here claims this account id or any address on the row |
| Device | `devices_bound`, or `gate_error` | Any machine is still bound directly to the person, **or the list could not be read** |
| Acknowledgement | `awaiting_ack` | `leaver.requireOperatorAck` is on and nobody has run `jml leaver ack` |

**The device gate fails closed, and that is the most important line in the
file.** The automation this was ported from wrapped its device lookup in a
catch that logged and carried on. A provider error produced an empty list, an
empty list read as "nothing to block on", and the account was deleted while the
machine was still out there with the provider's escrowed disk-encryption key
going with the record. Here, only a successful read of zero devices opens the
gate. Everything else blocks:
[`device-gate-fails-closed-on-error`](../test/regression/device-gate-fails-closed-on-error.test.ts).

Two further properties of the device gate are marked in config as not
overridable (`leaver.deviceGate.directBindingsOnly` and
`leaver.deviceGate.failClosed`, both `literal(true)`): membership of a group
that grants access to a machine is not custody of it, and a gate that cannot be
read blocks.

The identity gate ignores the `hold` flag on the live rows it checks against,
which is not an oversight. Hold stops the automation acting on the person it is
set on. It must not stop that person being protected from another row's
offboarding, which is exactly the case somebody reaches for hold to contain.
See [`identity-claimed-by-live-person-parks`](../test/regression/identity-claimed-by-live-person-parks.test.ts).

## A lookup has three answers, never two

Provider resolution returns `found`, `absent` or `unreadable`.

"No such account" and "could not tell" are opposite facts that a nullable
result collapses into one, and collapsing them is how a failed read became a
deletion. On day 0, if neither provider confirms an account and at least one
lookup failed, the row parks. If both lookups succeeded and found nothing, the
row is closed as a phantom without touching any provider:
[`phantom-path-touches-nothing`](../test/regression/phantom-path-touches-nothing.test.ts).

`googleAccountPresent` is read from the Google directory and never inferred
from the identity provider. The earlier automation used "has an identity
provider account" as a proxy and was wrong in both directions:
[`google-account-proxy`](../test/regression/google-account-proxy.test.ts).

## A response is not an effect

Every leg records `verified: true` only when the effect was confirmed by
reading the provider back. A 2xx is not an effect, and this toolkit's ancestor
recorded a successful suspension from a 200 that had changed nothing.

The consequences on the state machine:

- The day-0 marker is written **only** if the suspension was read back. If it
  was not, the marker is absent, the row is selected again next run, and the
  report says so in words. The earlier automation wrote its progress marker
  whether the legs had failed or not, so a broken run looked finished and was
  never retried:
  [`day0-unverified-200-writes-nothing`](../test/regression/day0-unverified-200-writes-nothing.test.ts).
- Nothing is marked `departed` unless every applicable delete is verified. A
  leg that is `not_armed`, pending or failed leaves the row in `offboarding`.
- A leg that asks for the row to be parked stops every **destructive** leg
  after it, and only the destructive ones. `delete` is the whole of that list.
  A suspension is reversible and protective, so on day 6 the Google suspension
  still runs after the handover parks for want of a recipient. Stopping the
  phase outright there would leave a parked leaver's mailbox open for as long as
  the row waited for somebody to look at it. See
  [`delete-continues-after-a-park`](../test/regression/delete-continues-after-a-park.test.ts).

## A hold set mid-run wins

The row is re-read from the store immediately before each person, and again
before each leg, and once more immediately before any status write. A filter
alone cannot protect a row whose flag changes while a long run is in flight.

If a hold appears after the suspension has already run, the suspension stands
(it is the safe direction) and the marker is **not** written, because writing it
would move the row on while somebody has asked the automation to stop touching
it. See [`hold-flipped-mid-run-wins`](../test/regression/hold-flipped-mid-run-wins.test.ts)
and [`held-row-untouched`](../test/regression/held-row-untouched.test.ts).

## One HR id is one row: alias, not new person

An address change on a known HR id moves the old address into `aliasEmails` and
keeps **one** row with its provider account ids intact. A second row for a known
HR id once inherited an employed colleague's account ids and suspended them.

Treating a changed address as a genuinely new identity requires all of:

1. the new address is not another form of the one held (not an alias, not a
   domain alias);
2. it matches none of `hris.exitRenamePatterns`, the addresses an HR system
   renames a leaver to (the default is `\+(exit|leaver)@`);
3. the person carries no leaving date;
4. the HR system still reports them employed and the stored row is `active`;
5. no employed row holds the new address.

Anything less is an alias. An alias recorded in error leaves one row a person
can correct. A second identity recorded in error hands out somebody else's
account. See [`exit-rename-inherits-live-ids`](../test/regression/exit-rename-inherits-live-ids.test.ts)
and [`renamed-person-loses-old-address`](../test/regression/renamed-person-loses-old-address.test.ts).

The demo carries this case as a person renamed to a plus-addressed mailbox on
the way out, so you can watch the alias path run.

## The four layers against a mass re-fire

The worst failure on record for this class of automation: a data migration
removed the tombstone rows for people who had already left; the next HR sync
read a full history, saw several hundred historic leavers with no offboarding
marker, and concluded they were all brand new terminations; the offboarding
engine began suspending accounts that had been closed for years, and schedules
had to be turned off by hand while the rows were rebuilt.

Four independent defences now stand in the way. **All four have to fail for
that to happen again**, and each fails for a different reason, which is the
point of having four rather than one good one.

| Layer | Where | What it does |
| --- | --- | --- |
| 1. The interface cannot delete | [`src/store/types.ts`](../src/store/types.ts) | `PeopleStore` has no `delete` and no `prune`. The conformance suite asserts that no method name starting with delete, prune, remove, purge, drop, truncate, clear or reset exists on any adapter. Migrations are forward-only and additive: a migration may add a table, a column or an index, and may not drop or rewrite one |
| 2. The tombstone count cannot fall | [`src/store/bootstrap.ts`](../src/store/bootstrap.ts) | The pipeline records the `departed` count and refuses to run when the live count has dropped below it, **before any write, in a dry run too**. The baseline only ever moves upwards; writing a lower number would teach the next run that a loss of rows is normal |
| 3. A row is never created as `terminated` | [`src/engine/sync.ts`](../src/engine/sync.ts) | A leaver who has no row never had one, so there is nothing to offboard. Without this line the first run against a full HR history schedules offboarding for every leaver in the organisation's history |
| 4. The circuit breaker counts before writing | [`src/engine/leaver/engine.ts`](../src/engine/leaver/engine.ts) | More than `leaver.maxDay0PerRun` day-0 candidates aborts the **whole run**, including the later phases, with zero writes |

Regression tests:
[`tombstones-pruned-refire`](../test/regression/tombstones-pruned-refire.test.ts)
checks three of the four in the order they would fire,
[`tombstone-count-drop-aborts`](../test/regression/tombstone-count-drop-aborts.test.ts),
[`sync-never-creates-terminated`](../test/regression/sync-never-creates-terminated.test.ts),
[`circuit-breaker-aborts-before-writes`](../test/regression/circuit-breaker-aborts-before-writes.test.ts),
[`dry-run-writes-the-tombstone-baseline`](../test/regression/dry-run-writes-the-tombstone-baseline.test.ts).

Three things about the circuit breaker are worth knowing before you set the
number:

- It fires in a dry run as well. A rehearsal is exactly when you want to be
  told that today's selection is forty people rather than two.
- Raising it for one run needs `--allow-bulk` **and** a human actor. A system
  actor asking for the override is refused and audited as
  `circuit_breaker_override_needs_a_person`, so a scheduled workflow cannot
  raise its own limit. A bulk day is a decision somebody signs for, not a
  configuration value that quietly grows.
- The abort is announced once, naming the count and the first ten HR ids. A
  breaker that fired silently would look exactly like a quiet day.

## Two more layers in front of all four

The mass re-fire above needs a store that already holds bad rows. Two checks
sit further upstream, on the HR read itself, and both refuse before a single
row is examined.

| Check | Refuses when |
| --- | --- |
| Snapshot completeness | The adapter could not prove it read the whole list. Everybody missing from a partial snapshot would look like a leaver on this run |
| Plausibility floor | The snapshot holds fewer people than `hris.minPlausibleHeadcount`, **or the employed set does** |

The employed set is checked separately because it is usually a second read, so
it can be truncated on its own while the full list looks healthy. **A truncated
employed read looks exactly like a company where everybody left.**

State the floor comfortably below real headcount. A floor equal to your staff
list refuses the run the first time one person leaves. The floor is asserted by
the HR adapter and again by the sync, as defence in depth. See
[`hris-truncated-aborts`](../test/regression/hris-truncated-aborts.test.ts),
[`hris-truncated-read-aborts`](../test/regression/hris-truncated-read-aborts.test.ts)
and [`hris-implausible-headcount-aborts`](../test/regression/hris-implausible-headcount-aborts.test.ts).

One related behaviour that surprises people: a stored row the snapshot does not
mention **at all** is left exactly as it is, and a warning names it. Absence
from a snapshot is not a departure. Only absence from the employed set of a
snapshot that does contain the person is.

## Before you arm: import your history as tombstones

```
jml store bootstrap                 # rehearses, writes nothing
jml store bootstrap --armed
jml store verify
```

`bootstrap` creates a `departed` row for every person the HR system does not
list as employed. Rows go straight into `departed` rather than being created as
leavers and then transitioned, because creating them as leavers would open a
window, however short, in which a concurrent run could select several hundred
historic people for offboarding.

An existing row is never touched, whatever status it holds. Somebody who left
and was rehired is a live person, and a bootstrap that overwrote them would be
the same class of mistake in the opposite direction.

`jml store verify` prints the exact day-0 selection and the exact tombstone
count. Run it on both sides of any migration or cutover and compare the
numbers, not the impression. `--expect-day0` and `--expect-departed` turn that
comparison into an exit code.

## The four commands a person uses

| Command | Writes | Notes |
| --- | --- | --- |
| `jml leaver hold --hris-id <id> --reason <text>` | `hold`, `holdReason` | A reason is required: whoever finds the row later has only that to go on. Freezes the row against the sync as well as the engine |
| `jml leaver release --hris-id <id>` | clears `hold`, `holdReason` and `reviewReason` in one write | Clearing the hold and leaving the parked reason gives a row that looks released and is still excluded from every selection, which is indistinguishable from the automation being broken |
| `jml leaver ack --hris-id <id> --actor <you>` | `offboarding.operatorAck` | Records who agreed and when. Carries the existing offboarding record through, including the day-0 marker |
| `jml leaver tombstone --hris-id <id> --reason <text>` | status to `departed`, `departedAt` | Touches no account. Goes through `transition()`, so a row in the wrong state is refused rather than forced |

`jml leaver show --hris-id <id>` prints one person: status, markers, legs and
bound devices.

Every one of those is recorded in the audit log as an intent row before the
write and an outcome row after it, with your actor name on both.

## Watch it happen with no credentials

`jml demo` walks the whole lifecycle against fixtures and fake providers. No
network call, no credential, nothing written. The store table it prints after
each step is the state machine in motion:

```
=== Day 0  (2026-01-15) ===
  ...
  people store:
    p-1001  active      Jane Doe
    p-1002  hired       John Doe
    p-1003  offboarding Robin Ellis     suspendedAt=2026-01-15
    p-1004  offboarding Sam Rivera      suspendedAt=2026-01-15
    p-1005  offboarding Kit Marlowe     suspendedAt=2026-01-15
    p-1006  terminated  Lee Nakamura    parked=termination_older_than_lookback
```

Seven days later, one deletion is refused and two proceed:

```
run demo-delete  pipeline  armed  ok=true
  counts: blocked=1 day7=2 detect.joiner=1 detect.potentialLeaver=1 ...
  Robin Ellis     blocked offboarding -> offboarding  blocked: devices_bound
      1 device(s) are still bound to this person:
- Demo field laptop, windows, serial DEMOSERIAL1
  Sam Rivera      day7    offboarding -> departed
  Kit Marlowe     day7    offboarding -> departed
```

The laptop is then unbound and the same day's run is repeated. The deletion
proceeds, because the gate reads the provider live rather than trusting what it
recorded the first time.

## Related pages

- [Incident catalogue](incidents.md): the failures behind these safeguards, one entry each.
- [Architecture](architecture.md): what runs where, and why the workflows hold no logic.
- [Configuration reference](config-reference.md#keys): every key, generated from the schema.
- [Canary a device script](runbooks/canary-a-device-script.md): the procedure before any handover.
- [The n8n bundle](../n8n/README.md): the schedule, the two skips, and how to prove the schedule fires.
