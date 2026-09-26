# Incident catalogue

Every safeguard in this toolkit exists because of a failure. This page is the
list, one entry per failure, with the test that holds the line.

The incidents happened in private automation that this toolkit was ported
from. They are described generically: no organisation, person or machine is
named, and the details that would identify one have been removed rather than
disguised. What is kept is the mechanism, because the mechanism is what
recurs.

The section that repays reading most is not "what went wrong". It is **why it
was not noticed**. Almost none of these were loud. A gate was present in the
configuration and inert in practice; a success was recorded from a response
that changed nothing; a report was wrong while the work was right. Silent
failure is the normal shape of a defect in lifecycle automation, and it is
why so much of this code spends its effort on reading back what it did.

Each entry ends with the file that would fail if the safeguard were removed.
There are 68 such files under [../test/regression/](../test/regression/), out of
1457 tests in total. One of the entries, the last one on this page, is a defect
found in this repository rather than in the automation it was ported from.

---

## The four that matter most

### Pruned tombstones caused a mass re-fire

A data migration moved a people database and, in the process, removed the rows
for people who had already left. Those rows were the only record that their
offboarding had happened. The next HR read included leavers, as an HR read
does; the sync created a row for each one; every one derived to "terminated"
with an empty day-0 marker; and the run that followed treated several hundred
long-closed departures as brand new. Accounts that had been closed for years
began to be suspended again. The schedules had to be turned off by hand and
the removed rows re-created.

**Why it was not noticed.** Nothing counted anything. The migration reported
success because it had copied every row it could see, and the rows it could
not see were the ones that mattered. The sync reported success because
creating rows is what a sync does. The offboarding engine reported success
because it suspended the accounts it was asked to suspend. Each component was
working correctly on the information it had.

**Rules now in force.** Four separate defences, each of which alone stops
this:

1. The store interface has no `delete` and no `prune`. Making the interface
   incapable of deletion is stronger than remembering not to call it.
2. The store keeps a monotonic count of departed rows and refuses to open on a
   count that has fallen.
3. The pipeline compares the tombstone count against the last run's **before
   the HR read**, so an abort means nothing was touched at all.
4. The sync never *creates* a row whose derived status is terminated. A leaver
   with no row never had one, so no account work is owed. This is one line and
   it is the most important line in the package.

Held by [tombstones-pruned-refire.test.ts](../test/regression/tombstones-pruned-refire.test.ts),
[tombstone-count-drop-aborts.test.ts](../test/regression/tombstone-count-drop-aborts.test.ts),
[sync-never-creates-terminated.test.ts](../test/regression/sync-never-creates-terminated.test.ts)
and, for the count check that runs before the port opens,
[serve-starts-with-an-unwritable-audit-log.test.ts](../test/regression/serve-starts-with-an-unwritable-audit-log.test.ts).

A fifth defence covers the general case rather than this one: the circuit
breaker in the entry below.

### A 200 was accepted as an effect

A provider accepted a write, ignored the part of it that mattered, and
answered HTTP 200. The automation wrote its day-0 progress marker from that
response. The record then said the account was suspended while the account was
still usable, and because the marker was set the row was never selected again.

**Why it was not noticed.** The marker is also the idempotency key. Writing it
from an unverified response closed the only route by which the mistake could
have been retried, so the failure erased its own evidence. Nothing in the
report was false: the request was made and the provider did answer 200.

**Rule now in force.** A leg is `done` only when a read-back saw the change,
and the day-0 marker is written only from a verified suspension. `verified`
means a second call observed the new state, never that the write returned 2xx.

Held by [day0-unverified-200.test.ts](../test/regression/day0-unverified-200.test.ts)
(the connector half) and
[day0-unverified-200-writes-nothing.test.ts](../test/regression/day0-unverified-200-writes-nothing.test.ts)
(the engine half).

The same principle appears in three other places on this page: a chat post
that answers 200 with a failure in the body, an accepted command trigger read
as a delivery, and a command result row read as an execution.

### A failed device read counted as no devices

Deletion of an account is refused while a machine is still bound to the
person, because deleting the account removes the only management channel to
that machine and takes its escrowed disk-encryption key with it. The lookup
that fed this gate was wrapped in a catch that logged and carried on. Any
provider error therefore produced an empty list, an empty list means "nothing
to block on", and one failed read deleted the account. The laptop carried on
running, unmanaged, with nothing left to reach it.

**Why it was not noticed.** The gate was in the code and read as present. Its
failure direction was invisible: a blocked deletion is an event somebody sees,
and an *unblocked* deletion looks exactly like a clean case. The catch had
been added to stop one broken row halting a whole run, which is a reasonable
thing to want.

**Rule now in force.** The device gate fails closed. The only thing that opens
it is a successful read of zero directly bound devices. A provider error, a
timeout, an ambiguous match and an unreadable account all block.
`leaver.deviceGate.failClosed` is a literal `true` in the schema and cannot be
overridden. Group membership does not count as custody, so only a direct
binding blocks, which is also not overridable.

Held by [device-gate-fails-closed-on-error.test.ts](../test/regression/device-gate-fails-closed-on-error.test.ts).

### A park stopped one deletion and the next leg proceeded anyway

The identity deletion carries a preflight: if the provider says the account is
not suspended, then either somebody restored it or this is the wrong account
on this row. Neither is something to delete, so the leg refuses and asks for
the row to be parked for a person.

The phase then went on and deleted the Google account. The leg loop stopped
only for a hold, and the park was read after every leg in the phase had
already run, so the refusal was recorded and disregarded in the same breath.

The Google deletion also had no suspension preflight of its own. Since an
adopter can arm `delete` without arming `google_suspend`, that left a working
mailbox to be deleted on the seventh day with nothing having ever closed it.

**Why it was not noticed.** The refusal was in the report. It said, correctly,
that the identity deletion had been refused and the row parked. The line below
it said the Google account had been deleted. Both statements were true and
nobody had written down that the second should not have been able to follow
the first.

**Rule now in force.** A guard whose conclusion is "do not delete this person"
stops the deletion of that person, not only the half of it that noticed. The
park is checked between legs, and the suspension preflight is enforced on both
deletions. A mailbox is the one thing in this sequence that cannot be restored
from anywhere else once the provider's retention window passes.

Held by [delete-continues-after-a-park.test.ts](../test/regression/delete-continues-after-a-park.test.ts).

---

## Reading the HR system

### A truncated read looks like a mass departure

Leaver detection works by absence: a person missing from the employed set has
left. That makes a short read indistinguishable from a company where everybody
left on the same day. A filtered credential, a paging bug and a provider
having a bad afternoon all produce the same signal.

**Rule now in force.** The adapter refuses to hand over a snapshot below
`hris.minPlausibleHeadcount`, a value with no default that the adopter has to
state themselves. The refusal happens before the snapshot is returned, so a
caller cannot write from something that was never produced. The sync refuses a
truncated snapshot as well, because a snapshot can also arrive from a fixture
file, a recorded replay or an adapter somebody else wrote, and a safeguard
that lives only in the adapter protects only the adapter's own path.

Held by [hris-implausible-headcount-aborts.test.ts](../test/regression/hris-implausible-headcount-aborts.test.ts)
and [hris-truncated-aborts.test.ts](../test/regression/hris-truncated-aborts.test.ts).

### Access stayed open until the contract ended

The HR system keeps a leaver on the employed list until the contract ends, and
holds the last day they were actually in as a separate field. The sync keyed on
the employed list alone, so somebody whose last shift was on a Wednesday kept a
working laptop and mailbox until the Friday, and for the whole notice period
where notice was served away from work.

**Rule now in force.** One function decides the leaving date: the last working
day where the HR system holds one and it is not after the termination date,
otherwise the termination date, with any date before the current start date
ignored as an earlier stint. The sync derives `terminated` the day after that
date even while the HR system still lists the person as employed, and every
selection, notification and lookback check reads the same function rather than
the raw field.

Held by [access-open-until-contract-end.test.ts](../test/regression/access-open-until-contract-end.test.ts).

### Every HR record was treated as needing accounts

The HR system holds frontline staff, seasonal workers and contractors on their own kit
alongside the people IT provisions for. The sync treated each record as
somebody needing a work account, so every one of them was announced as a
joiner and, once activation exists, would have been activated.

**Rule now in force.** The HR adapter reads the field that says whether IT
provisions for the person, configured per tenant because custom fields carry
generated ids. `false` keeps them out of joiner announcements and out of
activation; unknown reads as in scope, because the cheap mistake is a wasted
lookup and the expensive one is an account that is never closed. A configured
field with no in-scope values is refused at start-up, since it would put
everybody out of scope without a word. Scope never removes anybody from the
leaver set.

Held by [out-of-scope-joiner-announced.test.ts](../test/regression/out-of-scope-joiner-announced.test.ts).

### The HR read paged once

A `while (hasMore)` loop set `hasMore = false` after the first call and never
used the offset. It read one page of people and reported success. Everybody
past that page was absent from the snapshot, which is the same signal as
having left.

**Why it was not noticed.** A first page of people is a plausible-looking
result. Nothing about it says "there was more".

**Rule now in force.** The read finishes only on a short page, and a read that
cannot page throws rather than returning what it managed to collect.

Held by [hris-truncated-read-aborts.test.ts](../test/regression/hris-truncated-read-aborts.test.ts).

### The lifecycle status word was trusted

HR systems carry a status on each record and it is tempting to read. The
vocabulary is configurable per tenant, the same word covers different
situations in different accounts, and a person can hold a status of one kind
while the employed report already excludes them.

**Rule now in force.** Employment is derived from absence in a second read of
the employed people, never from a status string. The snapshot is keyed on the
stable HR id, never on the address.

Held by [hris-employed-set-not-status-string.test.ts](../test/regression/hris-employed-set-not-status-string.test.ts).

### A leaving date was parsed out of a human-readable string

The HR request asked for human-readable output and the code split the result
on slashes, treating the first component as the day. That is correct in one
locale and silently wrong in others, and this value decides which morning
somebody loses their accounts. The same code path also ran where the request
had not asked for human-readable output, so both behaviours coexisted.

**Rule now in force.** The adapter asks for machine-readable dates and treats
anything that is not an ISO date as a broken read of the whole snapshot.
Refusing the snapshot is deliberate: an unparseable date is a systemic fault,
either a field map pointing at the wrong field or a request that grew a
formatting flag, and neither is safe to work around one record at a time.

Held by [hris-locale-date-never-parsed.test.ts](../test/regression/hris-locale-date-never-parsed.test.ts).

---

## The sync writing over the engine

### The sync revived a row the engine owned

A person mid-offboarding was flipped back to employed by a sync that had read
them from a full history export. A closed row was reopened the same way. Two
runs then disagreed about whether the same accounts should exist.

**Rule now in force.** The store answers this, not the sync. The transition
table in [../src/core/transitions.ts](../src/core/transitions.ts) has no edge
out of `offboarding` for an HR event and none at all out of `departed`, so the
refusal happens on the write rather than in whichever caller remembered to
check. `departed` is terminal for the sync, the engine and a human alike.

Held by [sync-revives-offboarding-row.test.ts](../test/regression/sync-revives-offboarding-row.test.ts).

### A cancelled leaving date revived a suspended row

A leaving date was cancelled, or entered against the wrong person, and the HR
system started reporting them as employed again. The sync flipped the row back
to active. Nothing unsuspended the accounts, so the row and the accounts
disagreed, and because the row was active again it stopped being visible as an
offboarding in progress.

**Rule now in force.** Once the day-0 marker is written, the sync does not
change the status. It sets `hold`, sets a review reason of
`reinstated_after_day0`, and says so once. Restoring somebody's access is a
decision for a person, because by this point their files may already have been
handed to somebody else.

Held by [reinstated-after-day0-auto-holds.test.ts](../test/regression/reinstated-after-day0-auto-holds.test.ts).

### The sync wrote every field on every run

Three separate consequences from one habit. Values entered by hand were
erased, because the HR system carried nothing for those fields and a blank was
written over them. Every run looked like a change, so the change-only alerting
downstream fired constantly and was muted. And the audit log filled with rows
describing writes that changed nothing, so it stopped being a record of
anything.

**Rule now in force.** Diff before writing, and never let a blank incoming
value overwrite a populated stored one. The claim is measurable rather than
impressionistic: given the same snapshot twice, the second run performs zero
writes, and the store counts its own writes to prove it.

Held by [sync-erases-hand-entered-fields.test.ts](../test/regression/sync-erases-hand-entered-fields.test.ts)
and [second-sync-writes-nothing.test.ts](../test/regression/second-sync-writes-nothing.test.ts).

### A stale leaving date was treated as a fresh departure

Neither the status flip nor the offboarding selection had any cutoff on the
leaving date, so a row that arrived at "terminated" was a candidate for
suspension whether the person left last week or three years ago. That is the
mechanism behind two separate leaks, one of a few accounts and one of several
hundred.

**Rule now in force.** Entering terminated with a missing leaving date, or one
older than `leaver.terminationLookbackDays`, still writes terminated and sets
a review reason of `termination_older_than_lookback`, so nothing automatic
acts on the row.

The status deliberately stays truthful rather than being parked as active. Any
row in hired or active claims its own identifiers, and the engine refuses to
act on an identifier an employed row claims, so parking a leaver as active
would let them shield their own account from the check that protects
everybody else's.

Held by [termination-older-than-lookback-parks.test.ts](../test/regression/termination-older-than-lookback-parks.test.ts).

### An exit rename inherited a live colleague's account ids

The worst identity failure on record. An HR system renamed a leaver's work
address to a plus-addressed form on the way out. The sync joined on the email
address, did not recognise the new one, and took the branch for "this HR id
has been reused by a different person". That created a second row, and the row
was populated from a provider lookup that matched by address and landed on an
employed colleague's account. When the leaving date passed, the engine
suspended that colleague's live account.

**Why it was not noticed.** Somebody reached for the hold flag on the live
person's row to contain it, and it did nothing, because the flag was on a
different row from the one doing the damage. The check that would have
mattered did not exist.

**Rules now in force.** Three guards, all of which have to fail:

1. An address change that carries a leaving date, or matches
   `hris.exitRenamePatterns`, is an alias on the same person, never a new
   identity.
2. The join happens on the HR id, so there is only ever one row.
3. Before any provider call, the engine refuses to act on an account id or an
   address that a hired or active row claims. That check ignores the hold flag
   on those rows entirely, so holding a live row cannot expose it.

The store keeps every address a person has ever used, and a lookup by address
returns every row that claims it rather than the first one. Deciding whether a
new address is a rename or a different person is the identity module's job,
not the store's.

Held by [exit-rename-inherits-live-ids.test.ts](../test/regression/exit-rename-inherits-live-ids.test.ts),
[identity-claimed-by-live-person-parks.test.ts](../test/regression/identity-claimed-by-live-person-parks.test.ts)
and [renamed-person-loses-old-address.test.ts](../test/regression/renamed-person-loses-old-address.test.ts).

### A hold stopped the engine and not the sync

The hold flag is the kill switch for one person, added during the incident
above. A sync that went on patching a held row would rewrite the evidence
somebody was reading, and a sync that went on flipping its status would put it
back into the selection the hold exists to keep it out of.

**Rule now in force.** A held row is skipped entirely. No status writes and no
field patches, whatever the HR system now says.

Held by [held-row-untouched.test.ts](../test/regression/held-row-untouched.test.ts).

### A hold set during a run was ignored by that run

Hold was honoured in the query that selected people and then not looked at
again, so a run that had already selected somebody carried on through every
step after the flag went on. The person setting it watched the offboarding
continue.

**Rule now in force.** The row is re-read immediately before each person,
before each leg, and again before the status write. A selection made minutes
ago is not evidence about now.

Held by [hold-flipped-mid-run-wins.test.ts](../test/regression/hold-flipped-mid-run-wins.test.ts).

---

## Selecting people, and doing the work once

### A sudden crowd of leavers was processed rather than questioned

Nothing counted the candidates before acting, so the first anybody knew of the
tombstone incident was the accounts going out.

**Rule now in force.** The breaker counts day-0 candidates before any write
and aborts the whole run, later phases included, above
`leaver.maxDay0PerRun`. It fires in a dry run too, because a rehearsal is
exactly when somebody wants to be told the number is forty rather than two.

Held by [circuit-breaker-aborts-before-writes.test.ts](../test/regression/circuit-breaker-aborts-before-writes.test.ts).

### Selections read one page

Every selection read a single page of a hundred rows, using the default page
size of whatever store it was querying. Once the record count passed that,
everybody after the first page stopped being processed. Nothing errored, no
count looked wrong in isolation, and the people affected were never offboarded.

**Rule now in force.** Selections page to exhaustion. The store conformance
suite runs the check over a thousand rows, because a test with fifty rows
passes while the defect is present.

Held by [store-selection-reads-one-page.test.ts](../test/regression/store-selection-reads-one-page.test.ts).

### A directory read stopped after two hard-coded pages

The same shape against the identity provider. Accounts past the second page
came back with no provider id, which made those people look like leavers with
nothing to offboard, and the engine closed their rows without ever suspending
anything.

**Rule now in force.** Page until a page is shorter than the limit, and never
treat a full page as the end of a list.

Held by [jc-users-paging.test.ts](../test/regression/jc-users-paging.test.ts).

### The day-0 marker was lost and the stage ran again

The marker is the only thing making the first stage of offboarding run once.
When a row lost it, through a partial write, a field cleared by hand or a sync
overwriting the offboarding record, the person was selected again and the
whole stage ran a second time against accounts it had already changed.

**Rule now in force.** The marker is write-once at the store level, and the
two other routes by which it used to disappear are closed.

Held by [day0-marker-cleared-refires.test.ts](../test/regression/day0-marker-cleared-refires.test.ts).

### A failing step was either terminal or retried for ever

Both mistakes, in the same automation. A failed step was recorded once and
never tried again, so a transient provider error left an account open with the
record saying otherwise. Meanwhile a blocked deletion was re-evaluated every
five minutes indefinitely with nobody told, so a genuinely broken case sat
there for months.

**Rule now in force.** A failure is retried on every later run, the attempt
count lives on the leg record so it accumulates across runs, and at
`leaver.maxAttemptsPerLeg` the row parks for a person and is announced once. A
failing step does not stop its siblings: closing three doors of four beats
closing none.

Held by [leg-retry-then-parks.test.ts](../test/regression/leg-retry-then-parks.test.ts).

### A failed lookup was read as "no accounts"

A row can genuinely have nothing to offboard: the person never had an account,
or somebody closed it by hand. That row has to be closed without touching a
provider, or it is selected again for ever. It is also the inert landing zone
a mistaken identity is defused into, by clearing the account ids on the bad
row.

The dangerous version is a failed lookup. "No account" and "could not tell"
are opposite facts, and they were collapsed: a paging bug meant the account
list stopped short, so real leavers past that point looked accountless and
were closed as having had nothing to offboard while their accounts stayed
live.

**Rule now in force.** The phantom path is taken only when every lookup
succeeded in saying there is nothing there, and it is logged loudly.

Held by [phantom-path-touches-nothing.test.ts](../test/regression/phantom-path-touches-nothing.test.ts).

### A dry run wrote one thing

The claim made everywhere in this toolkit is that a rehearsal plans, reports
and touches nothing. It was true of every provider and every person row, and
not quite true of the toolkit's own bookkeeping: the tombstone invariant read
the recorded count and wrote today's back on the way past, in a dry run as
much as an armed one.

The direction was harmless, since that counter only moves upwards and a higher
baseline makes the next run stricter. It is still the wrong answer.
Somebody deciding whether to trust this with account deletion watches the
store, sees one write they did not expect, and now has to reason about which
writes are the safe kind. "No" is the only answer to "does a dry run write"
that needs no footnote.

**Rule now in force.** A dry run performs zero writes. Nothing is lost: an
absent baseline never aborts a run, and the armed run raises it afterwards.

Held by [dry-run-writes-the-tombstone-baseline.test.ts](../test/regression/dry-run-writes-the-tombstone-baseline.test.ts).

### Dates were computed by cutting the time off a UTC timestamp

"Today" was `toISOString().slice(0, 10)`. In a zone ahead of UTC, every moment
between local midnight and the offset falls on the previous UTC day, so for
the first hour of every summer day the pipeline believed it was yesterday.
Everything keyed on the day count since suspension moved with it, and a
leaver's deletion day arrived early for anybody whose offboarding started in
that window.

**Rule now in force.** All date-only arithmetic happens in `org.timezone`. The
regression pins 00:30 local time in a zone one hour ahead of UTC, which is the
exact case that failed. The audit sink takes its date function by injection
for the same reason: a local midnight formatted through UTC once filed a run's
evidence under the previous day.

Held by [bst-midnight-off-by-one.test.ts](../test/regression/bst-midnight-off-by-one.test.ts).

---

## Handing over files, and deleting accounts

### A file transfer was skipped and the account was deleted a week later

Three failures around the hand-over, in one shape. The transfer application id
was a numeric literal copied from one tenancy; it is per-tenancy, and a wrong
one is accepted without transferring anything. The recipient was resolved by
matching a manager's display name in a spreadsheet-like store, and when that
missed, the transfer was skipped, the account was suspended anyway, and a week
later it was deleted with the files still inside it. The insert was also not
idempotent, so a run interrupted between inserting the transfer and recording
its id would start a second one.

**Rules now in force.** The application id is resolved from the provider by
listing applications. The recipient is resolved from the directory, and a
hand-over that cannot find one parks loudly instead of being skipped. The
transfer id is persisted immediately after the insert, before the first poll
and before any later leg, and the connector also looks for an existing
transfer, so both halves have to fail before a duplicate can happen.

Held by [drive-transfer-hardcoded-application-id.test.ts](../test/regression/drive-transfer-hardcoded-application-id.test.ts)
and [transfer-id-persisted-before-suspend.test.ts](../test/regression/transfer-id-persisted-before-suspend.test.ts).

### A licence revoke named one SKU literally

An account holding a second edition kept a paid seat after its owner had left,
and the run reported the licence as revoked. Nothing in the report said which
SKU had been looked at, so the remaining seat was invisible.

**Rule now in force.** SKUs come from the provider: list what the account
holds, then revoke each one. A failed list must not read as "holds nothing",
because that is indistinguishable from a clean run and leaves the seat
billing silently.

Held by [licence-revoke-hardcoded-sku.test.ts](../test/regression/licence-revoke-hardcoded-sku.test.ts).

### Google presence was inferred from the identity provider

Whether a person had a Google account was inferred from their having an
account in the identity provider. The two are not the same set. People with no
mailbox were treated as having one, and the steps that only make sense for a
mailbox ran against nothing, reporting failures nobody could act on. In the
other direction, a person whose identity-provider record had already been
removed looked like they had no Google account, and their live mailbox was left
alone.

**Rule now in force.** Google presence is read from the Google directory and
from nowhere else. A 404 is the answer "no account"; any other failure is an
error, not an absence.

Held by [google-account-proxy.test.ts](../test/regression/google-account-proxy.test.ts).

### A 404 on delete was recorded as a deletion

Tolerating the 404 keeps a retried run idempotent, which is right. The audit
then could not tell "this run deleted the account" from "there was nothing
there", and the deletion ran even for people the record said had no Google
account at all. A year later there was no way to answer what had actually
happened to a given mailbox.

**Rule now in force.** The tolerance stays and the reporting changes. An
absent account is recorded as `alreadyAbsent`, never as a plain success, and
the state is confirmed by reading the account back either way.

Held by [google-delete-when-absent.test.ts](../test/regression/google-delete-when-absent.test.ts).

---

## Joiners

### A working colleague's password was reset by the joiner automation

A mis-entered HR field queued somebody who had been employed for years for
"activation". The only thing separating a staged account from a working one is
that nobody has ever set its password or enrolled MFA.

**Rule now in force.** Either sign of use refuses the activation with the
password untouched; the connector checks again seconds later before the write,
because two reads apart is long enough for the answer to change. With no gate
the row is recorded as seen; with a gate somebody opened, the refusal is
reported and stays until a person clears it.

Held by [activation-resets-a-working-account.test.ts](../test/regression/activation-resets-a-working-account.test.ts).

### Every starter was told to change a password nothing forced them to change

The forced-reset flag was sent in the same write as the password. The provider
answered 200, ignored the flag, and setting the password cleared it anyway.
The account was usable with the emailed password indefinitely while the email
said it must be changed, and the guard that noticed wrote to a container log
nobody read.

**Rule now in force.** The reset is its own action, after the password write,
verified from a fresh read. A reset that did not apply fails the activation leg
so it is retried and visible.

Held by [forced-reset-before-password-set.test.ts](../test/regression/forced-reset-before-password-set.test.ts).

### A starter's first message from IT was a bounce

A directory integration creates a Google account with no mailbox. The welcome
went to the work address minutes after the account appeared and bounced.

**Rule now in force.** The engine licenses the account, polls until the mailbox
exists, and withholds the work-address welcome rather than bouncing it when the
mailbox is not ready in time. The personal address still gets it and IT is told.

Held by [welcome-sent-before-mailbox-exists.test.ts](../test/regression/welcome-sent-before-mailbox-exists.test.ts).

### A temporary password landed in a colleague's inbox

The personal-address field held a company address, typed in by whoever filled
the form, and the manager field held a person's name where an address belonged.
The first put a credential in the wrong inbox; the second failed silently inside
a catch.

**Rule now in force.** Both recipients are validated at send time, against the
domain map rather than as written. An unusable address is dropped with a
warning, and the IT copy always goes.

Held by [temporary-password-sent-to-a-company-address.test.ts](../test/regression/temporary-password-sent-to-a-company-address.test.ts).

### Who is activated, and when

A calendar-day lead crossed a weekend and the password arrived late; a data
glitch queued a crowd; a starter with no account yet was reported as a failure
every run; and the form that said what a starter needed was not consulted.

**Rule now in force.** The lead is counted in working days on a calendar the
adopter supplies; a per-run cap holds and names the rest; a missing account is
looked at again next run without noise; and a configurable gate has to be open.

Held by [joiner-selection-and-gate.test.ts](../test/regression/joiner-selection-and-gate.test.ts).

## Ticketing

### The starter form was the gate, and nothing opened it

Activation depended on a form the manager had to raise, and the only thing
that read the form was a bridge matching tickets to people by name. Nobody was
told to raise it, so accounts sat staged past the start date; and the nudge
that was added fired on every run until the channel was muted.

**Rule now in force.** One nudge per person when the joiner is detected, one
reminder the day before, both recorded on the row. The bridge opens the gate
only for a ticket on the configured form that matches exactly one person still
waiting, by work address first and exact name second; ambiguity tells the
ticket and IT and opens nothing. Somebody already activated is never a match.

Held by [starter-form-never-consulted.test.ts](../test/regression/starter-form-never-consulted.test.ts).

### A leaver ticket per run

Ticket creation is not idempotent. Without a marker, every run that saw the
same day-0 candidate raised another ticket.

**Rule now in force.** The ticket reference is written to the row on success and
checked before every create; a failed create leaves no marker, so the next run
tries again.

Held by [leaver-ticket-raised-every-run.test.ts](../test/regression/leaver-ticket-raised-every-run.test.ts).

## Owners

### Every owner told about every leaver on day one

A feature that reads "everyone who left recently" from a store that holds
years of leavers, switched on for the first time, would message every owner
about every one of them.

**Rule now in force.** A go-live date is required and nothing before it is ever
notified; a lookback bounds what "recently" means; each leaver-owner pair is
recorded so it happens once; and a register that returns no owners refuses
rather than reading as nothing to send.

Held by [owner-notified-about-the-whole-history.test.ts](../test/regression/owner-notified-about-the-whole-history.test.ts).

## Devices

The device paths are the most dangerous code here. They run a script on
somebody's machine and then delete the record that is the only way to reach
it.

### An uninstaller bound to a device group

A command trigger fires on **every** association the command holds, and it
ignores any list of targets in the request body. An installer had been left
attached to a whole device group, so a push aimed at a handful of machines
produced twice as many results as targets, and nobody noticed until the counts
were compared. Another command carried dozens of stale device associations. On an installer that is a
puzzle. On an uninstaller it strips monitoring from the whole fleet in one
call.

**Rule now in force.** A command holding a device-group binding is refused
before anything is attached and before anything is fired. The refusal is a
hard stop, not a warning the run then continues past. The connector refuses
it, and the disposition refuses it too, so a dangerously bound command reaches
the operator as a refusal with a reason rather than as an exception in the
middle of a run. `devices.forbidGroupBoundCommands` is a literal `true` in the
schema.

Held by [group-bound-uninstaller-refused.test.ts](../test/regression/group-bound-uninstaller-refused.test.ts)
and [device-group-bound-uninstaller-refused.test.ts](../test/regression/device-group-bound-uninstaller-refused.test.ts).

### A command already carrying somebody else's machine

Stale associations accumulate: a run that timed out, a console experiment, an
older automation that never detached.

**Rule now in force.** Since the hand-over flow only ever fires an
uninstaller, pre-existing associations are an abort, not a line in a log that
the run carries on past.

Held by [collateral-on-uninstaller-refused.test.ts](../test/regression/collateral-on-uninstaller-refused.test.ts).

### A command left attached to somebody's laptop

The detach was the last statement of a happy path rather than a `finally`. A
read-back that threw, or a foreground timeout, returned with the command still
attached to a laptop. That machine then took the command every time anything
else fired it: a laptop was restarted repeatedly by jobs that had nothing to
do with it before the cause was found. The same
shape on an uninstaller would have stripped its agents.

**Rules now in force.** Detach in a `finally`, whatever happened. Prove the
detach by re-reading the associations. Treat an unproven detach as an alarm
rather than a successful run: the connector throws even when the work itself
succeeded, because a standing attachment outlives the run. The leak reaches a
person as a warning naming the machine, the run is not reported as ok, and
nothing is deleted, because a leak means the state of the attachment is
unknown and a delete on top of an unknown is the exact failure this package
exists to prevent.

Held by [command-association-left-bound.test.ts](../test/regression/command-association-left-bound.test.ts)
and [association-leak-reported.test.ts](../test/regression/association-leak-reported.test.ts).

### A device record deleted on hope

The hand-over fired the uninstall command, slept a blind two minutes, and
deleted the device record. Its own docstring promised a last-contact check
that was never implemented. When the uninstall had not in fact run, the record
went anyway, and with it the only channel that could reach the machine and the
escrowed disk-encryption key. The machine went on reporting telemetry
afterwards, with no channel left to reach it.

**Rule now in force.** The order is fixed and the tests assert the order
rather than the end state: uninstall, receipt, silence, and only then the
delete. Each of the first three failing stops the fourth.

Held by [record-deleted-only-after-receipt.test.ts](../test/regression/record-deleted-only-after-receipt.test.ts).

### A collected command was read as a finished one

The provider writes a result row when a device *collects* a command, and fills
in the exit code and the response time only when it completes. A weekly
coverage job counted any row as an execution, so an installer that a machine
collected and never finished was reported as a success for a week, on a device
that had no agent at all.

**Rules now in force.** A receipt counts as completed only when it carries
both an exit code and a response time. A timeout is never success. And the
receipt itself has to answer the question: every agent named in configuration
must come back as gone or absent, since a receipt mentioning none of them is
an unanswered question rather than a pass.

Held by [receipt-without-exitcode-is-not-completed.test.ts](../test/regression/receipt-without-exitcode-is-not-completed.test.ts).

### An unproven script ran because a claim was believed

Neither shipped uninstall script has ever run on a real machine. The manifest
says so, and a hand-over is refused unless the operator names the machine they
canaried it on. The check only tested that the field was present, so naming
the target machine itself satisfied it and the script ran.

That claim is self-contradictory: it says the script already ran somewhere and
was checked afterwards, and that this machine has not run it yet. The
realistic route in is not an operator arguing the point, it is an automation
template mapping both fields from the same expression, which passes a presence
test in silence.

**Rules now in force.** Two independent brakes stand in front of a hand-over.
`devices.uninstallTriggers` defaults to `null` on every platform, so a fresh
install cannot run one at all and nobody inherits a fleet-wide uninstaller
they did not create. A script whose manifest says `provenOnHardware: false`
cannot be executed without naming the canary machine, and that name may not be
the target. Planning is always allowed; firing is not. Both refusals name the
runbook, because a refusal that does not say what to do next gets worked
around rather than followed.

The toolkit still cannot verify that a canary happened. It refuses the one
claim it knows to be false.

Held by [handover-refused-without-canaried-trigger.test.ts](../test/regression/handover-refused-without-canaried-trigger.test.ts)
and [canary-claim-names-the-target.test.ts](../test/regression/canary-claim-names-the-target.test.ts).
Procedure: [runbooks/canary-a-device-script.md](runbooks/canary-a-device-script.md).

### A recovery key destroyed as a side effect of tidying up

Deleting a device record deletes the disk-encryption recovery key the provider
holds for that machine. That mattered twice: a leaver's laptop was about to be
handed over with its key escrowed nowhere else, and encrypted machines
were found to require no authentication at boot while the provider's own
"encrypted, key present" field said everything was fine.

**Rule now in force.** A hand-over on a machine whose key the provider holds
is refused until the caller says explicitly that losing the key is
understood, with `--acknowledge-fde-key-loss`. A machine whose key state the
provider does *not* report is treated the same way, because an unknown is not
a no: that field has meant something other than it appears to more than once.
The acknowledgement is recorded on the delete's audit row, so the decision is
attributable afterwards.

Held by [fde-key-needs-acknowledgement.test.ts](../test/regression/fde-key-needs-acknowledgement.test.ts).

### Retaining an unmanaged machine is not a resolution

A leaver kept their laptop. The device record was deleted to tidy up the fleet
view, which removed the machine from sight and not from the network: it went
on shipping telemetry for weeks, and because the record was the only command
channel there was no way left to stop it.

**Rule now in force.** The `retain_unmanaged` disposition writes nothing at
all, and the deletion block stays blocked. It is a report, not a resolution:
the case waits for a person to pick another disposition or record an explicit
override. A tidy fleet view is not worth an unreachable machine.

Held by [retain-unmanaged-keeps-gate-blocked.test.ts](../test/regression/retain-unmanaged-keeps-gate-blocked.test.ts).

### A device step bounded by the caller's HTTP timeout

A hand-over holds a command association for two minutes, waits up to ten
minutes for a receipt, then confirms the agents have gone quiet for another
ten. That is longer than any scheduler's HTTP node will wait. The failure mode
is nasty rather than annoying: the caller times out, the run is recorded as
failed, somebody retries, and now two runs are attaching and detaching the
same command on the same machine.

**Rule now in force.** No route waits for work. Starting a run answers
immediately with a run id and the caller polls.

Held by [device-run-bounded-by-an-http-timeout.test.ts](../test/regression/device-run-bounded-by-an-http-timeout.test.ts).

---

## Credentials, logs and the audit trail

### A credential pasted into the configuration file

Credentials were read from the environment inside each step, lazily, with no
validation at start-up. A missing one produced a step that skipped and a run
that reported success. The natural fix people reached for was to paste the
value into the config file, where it went into a backup, a screen share and
eventually a repository.

**Rules now in force.** A secret field holds a reference, never a value, and a
literal is a start-up failure. Every reference resolves once, at start-up, so
an unresolvable credential stops the process instead of becoming a step that
quietly does nothing.

Held by [literal-secret-in-config.test.ts](../test/regression/literal-secret-in-config.test.ts).

### A provider echoed the key back and three places stored it

A credential rarely escapes through the line that handles it. It escapes
because a provider answered `400 bad key: <the key>`, and that body was then
written into a log, attached to a run report and stored in an audit trail kept
for years, by three call sites none of which knew they were handling a secret.

**Rule now in force.** A registry rather than discipline at each call site.
Every resolved credential registers itself at start-up, in plain,
percent-encoded and base64 forms, and everything the toolkit emits passes
through the redactor: log lines, error messages and stacks, HTTP error bodies,
the run report, every audit row and every sidecar response. Redaction happens
on the way **into** a record, not when somebody remembers to look.

Held by [secret-echoed-in-error-body.test.ts](../test/regression/secret-echoed-in-error-body.test.ts),
[secret-in-error-redacted.test.ts](../test/regression/secret-in-error-redacted.test.ts)
and [api-response-carries-a-credential.test.ts](../test/regression/api-response-carries-a-credential.test.ts).

### One token was minted for every scope at once

When a single scope was missing from the delegation, the whole exchange failed
with a bare `unauthorized_client` naming no scope. A partial grant therefore
read as no delegation at all, and the search went looking for a broken key
instead of a missing line in an admin console.

**Rule now in force.** One token per scope, always, on every path.
`jml doctor` reports the outcome per scope.

Held by [bundled-scope-token.test.ts](../test/regression/bundled-scope-token.test.ts).

### Mail was sent by impersonating the administrator

Notifications were sent by minting a token for the administrator and then
posting to a shared mailbox's send path. That worked only because the
administrator happened to be that mailbox. Under domain-wide delegation the
provider ignores mailbox delegation for the sending identity, so the same
configuration fails on any other tenancy, and sharing the mailbox with the
administrator does not fix it.

**Rule now in force.** The connector impersonates `mail.senderMailbox`
directly. This is the single least portable line in the toolkit and it would
be easy to "simplify" back, so the subject is pinned by a test.

Held by [gmail-send-as-admin-not-mailbox.test.ts](../test/regression/gmail-send-as-admin-not-mailbox.test.ts).

### PII minimisation was configured and not implemented

The configuration shipped with minimisation on and the reference said
addresses were stored as a salted hash. Nothing read either key: the sink was
built with a log directory and a date function and no minimisation at all, so
every audit row held the leaver's address in clear.

**Why it was not noticed.** The log is append-only and kept for years, so the
file quietly became a permanent directory of everybody who had ever left,
while the operator believed otherwise because both the configuration they
wrote and the documentation they read said the addresses were hashed. A row
full of addresses looks exactly like a row full of hashes to anybody not
reading it.

**Rule now in force.** Minimisation is implemented, requires a salt (an
unsalted hash of an address is reversible by guessing), and runs **before**
the row hash is computed, or every minimised line would fail the chain
verification that exists to prove the log has not been edited. The order is
asserted as well as the behaviour.

Held by [audit-log-keeps-addresses-in-clear.test.ts](../test/regression/audit-log-keeps-addresses-in-clear.test.ts).

### An audit row written after the fact could not describe a lost call

A single row written after a provider call cannot describe the case that
matters most: a call that was made and whose result was never learned, because
the process died or the network went away between the request and the answer.

**Rule now in force.** Two rows per action, the intent before the provider
call and the outcome after, and a failed intent append **stops the call**. A
sink that cannot persist a row throws rather than degrading.

Held by [audit-intent-append-blocks-the-step.test.ts](../test/regression/audit-intent-append-blocks-the-step.test.ts).

### An append-only file is only evidence while nobody edits it

**Rule now in force.** Every line carries the hash of the line before it.
That does not stop anybody editing the file, but an edited or deleted line
cannot be hidden. `jml audit verify` walks the chain and fails **at** the
offending line rather than reporting that something somewhere is wrong.

Held by [audit-line-tampered.test.ts](../test/regression/audit-line-tampered.test.ts).

### The service started without the ability to record what it did

The contract everywhere else is that a step whose intent cannot be written
does not happen. A service that started anyway would honour that contract by
failing every run, one at a time, after each had already been accepted with a
202 and reported back as an internal error. The right moment to refuse is
before the port is open.

**Rule now in force.** `jml serve` refuses to start when the audit log
directory cannot be written, and refuses to start when the store's tombstone
count has fallen.

Held by [serve-starts-with-an-unwritable-audit-log.test.ts](../test/regression/serve-starts-with-an-unwritable-audit-log.test.ts).

### A fresh install wrote a configuration the next command refused

The audit log stores addresses as a salted hash, minimisation is on by
default, and the schema requires a salt whenever it is on. The generated
default carried no salt, so every command that loads configuration failed on a
fresh install, before anybody had typed a credential.

The error made it worse: any schema issue on a secret field was rewritten as
"holds a literal value where a secret reference is required", so a missing
salt was reported as a pasted credential. The obvious repair for the message
that was actually printed is to write a salt straight into the config file,
which is the one thing the split between configuration and environment exists
to prevent.

**Rules now in force.** `jml init` writes a file that loads, the salt is
generated rather than chosen, and it lives only in the environment file.

Held by [init-writes-an-unloadable-config.test.ts](../test/regression/init-writes-an-unloadable-config.test.ts).

---

## Notifications, and the shipped automation bundle

### A chat post that reached nobody while the run recorded a success

The chat API answers HTTP 200 and puts the failure in the body. Several
scheduled workflows posted nothing for weeks because the transport status was
checked and the body was not, so their reports went quietly missing while
every execution was green.

**Rule now in force.** A 2xx alone is not delivery. `delivered` is true only
when the body also says `ok: true`, and an undelivered notification makes the
run not ok, which is what turns a scheduled execution red.

Held by [slack-ok-false.test.ts](../test/regression/slack-ok-false.test.ts).

### A standing problem announced on every run

Blocked leavers were re-evaluated on every run and the same list posted
each time, because there was no notion of a change. Hundreds of identical
posts trained everybody to skip the channel, so the day the list actually
changed looked like all the others. The note was also never cleared when the
blockage resolved.

Two earlier attempts at a fix are pinned as well, because both looked correct
and neither worked: keying the gate on the rendered message, which carried
today's date and so changed every day; and keying the weekly reminder on the
weekday alone, which is true for every run of that weekday, so the fix
produced a whole day of repeat posts.

**Rules now in force.** The fingerprint is over the **set** of things being
reported, never over a timestamp and never over a field the toolkit writes
itself. A weekly re-raise fires once on its weekday. Recording happens after
the notification is proven delivered, so a failed post does not silence the
next run. The blocked fields are cleared in the same write that closes the
row. And because the failure direction is over-suppression, which is silent,
anything that goes wrong in the gate announces rather than withholds.

Held by [blocked-renotify-every-run.test.ts](../test/regression/blocked-renotify-every-run.test.ts)
and [blocked-renotify-only-on-change.test.ts](../test/regression/blocked-renotify-only-on-change.test.ts).

### A workflow export carried a snapshot of real people

An automation platform stores a workflow's own scratch state in the file it
exports. That state had accumulated the last set of records the workflow
handled, so an export taken to share the design carried a full staff list,
several leaver addresses and a list of device names. Nobody put them there on
purpose and nothing in the file looked unusual.

**Rule now in force.** The shipped bundle is hand-authored, and the gate
refuses any file carrying instance state. Making a live export committable is
a separate, explicit step that strips the state and then re-checks it
(`jml n8n scrub`).

Held by [n8n-export-carries-static-data.test.ts](../test/regression/n8n-export-carries-static-data.test.ts).

### A shipped workflow pointing at somebody else's host

The workflows this bundle replaces were full of literal addresses: an internal
service on a private network, a chat channel id, a tunnel hostname on a
domain the organisation did not control. Each was harmless where it was written and each is
a live endpoint owned by a stranger once the file is shared. The chat ids were
the worst of it, because a wrong-but-valid channel id succeeds: the post
lands, and not where the sender expected.

**Rule now in force.** Every request builds its URL from `$env.JML_API_URL`,
the chat channel comes from the environment too, and the gate allows no other
environment name, so a new hardcoded value cannot arrive wearing a variable's
clothes.

Held by [n8n-hardcoded-url-in-shipped-export.test.ts](../test/regression/n8n-hardcoded-url-in-shipped-export.test.ts).

### A failed scheduled run that alerted nobody

Not one workflow named an error workflow, so a red execution was visible only
to somebody already looking at the executions list, and nobody looks at a job
that usually works. A daily job failed on the same step for months and was
found by accident.

**Rule now in force.** The four working workflows must name the error
workflow. The error workflow itself must not name one, because it would name
itself and then spend its time alerting on being unable to alert; its own last
line of defence is the assertion on its chat post, which turns an undelivered
alert into a red execution.

Held by [n8n-red-execution-alerts-nobody.test.ts](../test/regression/n8n-red-execution-alerts-nobody.test.ts).

### A delivery assertion that stopped the work it was reporting on

Where one node feeds several branches, the platform runs them in order of
their position, topmost first, and an error anywhere ends the whole execution.
Adding a chat-delivery check to every workflow put a node that can throw at
the top of the canvas, so a rejected post also stopped the audit push and the
user notifications on the sibling branches. Those branches had been the
reliable half.

**Rules now in force.** The branch that posts to chat is the last one, so
everything else has already run by the time it can throw, and nothing is
queued behind the assertion: after it, only further assertions and terminal
nodes.

Held by [n8n-slack-assertion-kills-sibling-branch.test.ts](../test/regression/n8n-slack-assertion-kills-sibling-branch.test.ts).

---

## Packaging

### The build dropped a file the runtime reads

Two directories under `src/` hold files read at run time relative to the
compiled module. The TypeScript compiler emits only JavaScript, so each needs
an explicit copy step, and the build had a step for the notification templates
and none for the device scripts. The consequence was invisible in every test
and in the demo, because those run from source: only a built install failed,
and only on the first device hand-over, which is the one operation that runs a
script on somebody's machine.

**Rule now in force.** A test asserts that every module-relative asset
directory in the source is named in the build's copy step, so adding a third
one and forgetting the build fails there rather than in somebody's fleet.

Held by [build-drops-a-runtime-asset.test.ts](../test/regression/build-drops-a-runtime-asset.test.ts).

### The demo worked only in the repository it was written in

`jml demo` is the first thing `jml init` points a newcomer at, and the only
way to watch the state machine decide a suspension and a deletion without
pointing the toolkit at real accounts. It read its HR fixture from a path
relative to the working directory, and that path was under `test/`, which is
not a published directory. So it worked in the test runner and in the
repository root and nowhere else, and from an installed copy it could never
work.

**Why this one is a safety defect.** Somebody deciding whether to trust this
with account deletion runs the one command that proves it, gets a missing
file, and their next move is to arm it against a real tenant to see what it
does. A broken demo pushes people towards the dangerous path.

**Rule now in force.** The fixture ships inside the package and resolves
relative to the module, so the demo runs from any directory.

Held by [demo-only-runs-from-the-repo-root.test.ts](../test/regression/demo-only-runs-from-the-repo-root.test.ts).

### A stray control character took two files out of the secret scan

Found in this repository, not in the automation this was ported from, by
somebody reviewing the documentation rather than the code.

Two source files carried a literal NUL where an escape was meant: the cache key
that keeps one Google token per scope and subject, and the sanitiser for the
actor header on the sidecar. Neither behaved wrongly. What they did was make
their own files unreadable to the tools: `tools/lint/check-identifiers.mjs`
treats a file containing a NUL as binary and skipped both, while still counting
them in the number of files it reported as scanned, and `grep` did the same
without saying anything. So the token-minting code and the HTTP surface, the two
files where a leaked identifier would matter most, sat outside the secret scan,
and the scan reported that it had read them. The README invites a reader to prove
for themselves with `grep` that no host but the vendor APIs is compiled in; that
command was quietly skipping the file holding Google's OAuth token endpoint.

**Rule now in force.** Control characters are written as escapes, a test fails
on a NUL byte anywhere in the source, documentation or configuration, and the
identifier lint now reports the files it could not read instead of counting them
as scanned.

Held by [nul-byte-hides-a-source-file-from-the-linters.test.ts](../test/regression/nul-byte-hides-a-source-file-from-the-linters.test.ts).

---

## The shape these share

Reading the catalogue in one sitting, the same five mistakes keep recurring
under different names. They are worth naming, because the next defect in this
codebase will probably be one of them again.

| Shape | Examples above |
| --- | --- |
| A response was accepted as an effect | the unverified 200, the chat post with `ok: false`, the accepted trigger, the collected command result |
| A gate was present in the code and inert in practice | the device lookup wrapped in a catch, PII minimisation nothing read, the canary check satisfied by naming the target |
| Absence of evidence was read as evidence of absence | a failed device read as no devices, a failed lookup as no accounts, a truncated page as everybody having left |
| A guard was keyed on our own bookkeeping | the gate keyed on a rendered message, the weekly re-raise keyed on the weekday, the marker written from an unverified write |
| The work was right and the report was wrong | the licence revoke that named one SKU, the 404 recorded as a deletion, the transfer skipped in silence, the scan that counted two files it never read |

The failure direction is what makes these expensive. A gate that breaks loudly
gets fixed on the same day. A gate that breaks quietly looks exactly like a
week in which nothing went wrong.

## The first run against a real tenant

Everything above was ported from a private automation and covered by tests
against hand-written doubles. Before this release the read-only half was pointed at
a real HR system, identity provider, Google Workspace and a Notion database
for the first time. It found five defects in an afternoon that 1466 passing
tests had not. Each is now a regression test.

### The HR system refused every people search with 415

The adapter set `Content-Type: application/json`. The HTTP client set its own
`content-type` default beside it, because a plain object treats the two
spellings as different keys, and fetch folded them into
`application/json, application/json`. The fake HTTP layer in the tests never
merged headers, so every test passed. Header names are now folded to lower
case before any default applies.

### The bootstrap tombstoned the people who had not started yet

The HR system keeps a starter off the employed list until their first day.
The bootstrap read "not on the employed list" as "historic leaver" and wrote a
terminal tombstone for every future starter; the next sync then warned that
each was tombstoned while employed, and the only remedy it could offer was a
new HR record. The sync had always read a future start date before the
employed set. That derivation now lives in one place and the bootstrap uses it.

### `--json` produced a file nothing could parse

The console notifier wrote the run summary to stdout, in front of the report.
Under `--json` it now writes to stderr, with the log lines.

### Every employee was a joiner candidate

A fresh people store holds no activation marker for anybody, and the joiner
selection had no lower bound on the start date, so most of the people on the
books were starters whose account had never been activated. The run capped at
five and held the rest over the cap, for ever. With the gate at `none` that
is a temporary password issued to five long-serving people per run; with a
ticketing adapter wired in it is a starter-form nudge to most of the managers in the company.
`joiner.graceDays` now bounds the selection, the detect step and the nudge;
naming a person with `--hris-id` still looks at them.

### The Notion adapter could not read a database it did not create

Department and source were select columns, and the adapter accepted rich text
only. `init` would then have added a missing property to a database another
automation owned, which is a schema write nobody asked for. Select and email
columns are now accepted and written in their own shape, and
`store.readOnly: true` makes the adapter a reader that refuses every write and
reads a missing property as empty.

The pattern is the one this file keeps recording: a fake that agrees with the
code is not evidence about the vendor, and a first run against anything real
should be expected to fail in ways no test predicted. That is what `mode:
dry-run` and an empty `armedActions` list are for.
