# Running this alongside your own automation

For the case this toolkit was extracted from: you already have private
automation doing joiners and leavers, it works, and you want to move onto the
public code without a fork and without a flag day.

The shape is: keep every fact about your organisation out of the repository,
run this in dry run beside what you already have, diff the decisions rather
than the output, then arm one action at a time in an order chosen so that the
irreversible one comes last.

## Keep your estate out of the repository

Nothing about your organisation belongs in a file the repository tracks. Three
files carry it, all untracked, all created by you:

| File | Holds | Kept out by |
| --- | --- | --- |
| `.env` | Every credential value, the sidecar token, the audit salt | `.gitignore` (`.env`), and `jml init` writes it `0600` |
| `jml.config.yaml` | Your organisation name, domains, mailboxes, HR field map, device trigger names, and secret **references** | `.gitignore` (`/jml.config.yaml`) |
| `tools/lint/denylist.local.txt` | Literal strings you never want published: your domains, tenant ids, site names | `.gitignore` (`tools/lint/denylist.local.txt`) |

The split between the first two is the point. `jml.config.yaml` holds
references (`env:JUMPCLOUD_API_KEY`, `op://<vault>/<item>/<field>`) and never
values, so `jml config show` can print your whole configuration into a ticket
or a screen share without printing a credential. If you find yourself pasting
a value into the config file, the schema will refuse it.

Two habits that keep this working:

- Reference a secret-manager item by its stable id, never by its title. A
  title reference resolves until somebody renames the item, and then it fails
  at the next scheduled run with nobody watching.
- Run `jml init --dir <somewhere outside the checkout>` if you would rather
  keep the config and environment away from the repository entirely, and point
  the toolkit at it with `--config` or `JML_CONFIG`.

## The local denylist

The identifier gate in `tools/lint/check-identifiers.mjs` matches identifier
*shapes*: email addresses that are not approved examples, hex object ids,
chat ids, private addresses, fleet-style device names. Shapes catch the
accidents. They do not catch your organisation's name, or a domain that looks
like any other domain.

Put those in `tools/lint/denylist.local.txt`, one literal per line, comments
with `#`. Start from the example:

```
cp tools/lint/denylist.local.txt.example tools/lint/denylist.local.txt
# add your own names, domains, tenant ids, site names
npm run identifiers
```

Matching is case-insensitive and the file itself is skipped by the scan, so
the denylist cannot report itself. Keeping it untracked is deliberate: a
committed denylist publishes the very names it exists to block.

Run the gate before every commit you intend to push, and read a hit as a
question rather than an annoyance. The gate has already caught the two things
that actually leak: an address left in an example, and an id left in a
fixture.

## The shadow deployment

Run this toolkit against your live estate with nothing armed, on a schedule,
beside the automation you already have. It reads the HR system, keeps its own
store, and reports what it *would* do.

```
# 1. Prove the credentials before anything reads anything twice.
jml doctor

# 2. Import your whole HR history as tombstones. Rehearses without --armed.
jml store bootstrap
jml store bootstrap --armed

# 3. Confirm the numbers before a schedule exists.
jml store verify
```

Step 2 is not optional and it is not a nicety. Without it, every historic
leaver in your HR system looks like a brand new termination on the first run.
That exact failure is the first entry in
[incidents.md](incidents.md#pruned-tombstones-caused-a-mass-re-fire): several
hundred long-closed departures were treated as fresh, and five schedules had
to be turned off by hand.

`jml store verify` prints the tombstone count and the exact day-0 selection.
Write both numbers down. They are what you compare against after any change
to the store, and the pipeline refuses to run at all if the tombstone count
later falls.

Then run the pipeline in dry run, on the same cadence as your existing
automation and shortly after it:

```
jml run                      # plans, reports, touches nothing
jml leaver dry-run --hris-id <id>
jml leaver show --hris-id <id>
```

### Diff the decisions, not the output

Your existing automation and this toolkit will not produce comparable text.
Compare the decisions. For each day, four questions:

| Question | Where to read it |
| --- | --- |
| Which people did each system select for day 0? | `jml run --json`, count `selectedDay0`, and the names in the run report |
| Which did each one skip, and for the same reason? | the review reason on each row: `jml leaver show`, or the parked list in `jml doctor` |
| Which deletions did each one refuse, and why? | the blocked reason: `devices_bound`, `transfer_incomplete`, `identity_mismatch`, `awaiting_ack`, `gate_error` |
| What would each one have written? | the audit log: `jml audit tail --lines 200` |

Expect disagreements, and expect most of them to be this toolkit refusing
something your automation did. That is the interesting output of the shadow
run. Work through each one before arming anything:

- **This one parks and yours acted.** Read the review reason. A stale leaving
  date, a headcount below your floor, or an identifier an employed row claims
  are all deliberate refusals.
- **Yours acted and this one selected nobody.** Check the tombstone import
  first. A person your automation treats as a fresh leaver, and this toolkit
  treats as long departed, usually means the two disagree about when the
  leaving date landed.
- **Both selected the same person on different days.** Check `org.timezone`.
  Date-only arithmetic happens in that zone, and an off-by-one day here is a
  recorded incident.

Let the shadow run for at least one full leaver cycle, `leaver.deleteDay`
plus a few days, so you see a hand-over and a deletion decision rather than
only day 0. Two cycles is better, because the second one tells you whether the
second run of the same snapshot writes nothing.

## The cutover order

Arm one action at a time, least reversible last. `armedActions` exists for
this: an action that is not named records `not_armed` and moves on, so you can
stay at any step below for as long as you like.

| Step | `armedActions` | Watch for | Old automation |
| --- | --- | --- | --- |
| 1 | `suspend`, `autoreply`, `licence` | The day-0 report matches what the old automation did on the same people. Suspension is undone by hand in a minute, which is what makes it the right first step | Turn its day-0 stage off |
| 2 | observe, for at least one full cycle | Nothing new selected that you did not expect. The parked list in `jml doctor` not growing quietly | unchanged |
| 3 | add `transfer`, `google_suspend` | The transfer recorded as complete by the provider, not as requested. Managers receiving files they expect | Turn its hand-over stage off |
| 4 | add `device_unbind` | Bound devices clearing, and deletions unblocking as they do | unchanged |
| 5 | add `delete` | The first deletion. Consider `leaver.requireOperatorAck: true` for the first month, which stops every deletion until somebody runs `jml leaver ack` | Turn its deletion stage off |
| 6 | add `device_handover`, only after a canary | Nothing, until you have followed [runbooks/canary-a-device-script.md](runbooks/canary-a-device-script.md) on a machine you can afford to break | unchanged |

Step 6 is separated from the rest deliberately. Neither shipped uninstall
script has ever run on real hardware, the manifest says so, and a hand-over is
refused unless you name the machine you canaried it on. If you never enable
it, everything else works: a bound device blocks a deletion, the block names
the machine, and a person clears it.

Two settings worth keeping during the cutover, and reconsidering after:

- `leaver.maxDay0PerRun`. Set it to your ordinary weekly leaver count plus a
  couple, not to a comfortable large number. It aborts the whole run above the
  limit, and that abort is the last defence against a bad HR read.
- `leaver.requireOperatorAck`. Deletion waits for a person. Expensive on a
  large estate, cheap for a month.

### Rollback

Rollback is turning the old automation back on, not turning this one off. Two
moves, in this order:

1. **Disarm this toolkit.** Remove the action from `armedActions`, or set
   `mode: dry-run`, and restart the sidecar. If you drive it from a scheduler,
   deactivating the schedule is faster still. Nothing in flight is left half
   done: each leg is independent, records its own outcome, and is retried on
   the next run.
2. **Reactivate the stage of the old automation you turned off.** Then check
   for double action: this toolkit's markers are its own, so an account it has
   already suspended will look unsuspended to your old automation only if your
   old automation reads the provider rather than its own store.

Anything already done stays done. The engine never unsuspends and never
restores, by design: undoing a wrong suspension is a decision for a person,
because by the hand-over day somebody else may hold the files. The audit log
tells you exactly what happened, in order, with the intent row before each
provider call.

Keep the old automation's code and its schedule for a full quarter after
cutover. The failure this ordering protects against is not a bad deploy, it is
a disagreement you only notice on the one leaver whose case is unusual.

## What is deliberately not ported

If your private automation has these, this toolkit will not replace them yet.
Do not turn them off.

| Not here | Where it stands |
| --- | --- |
| Joiner provisioning and mover attribute changes | Phase 1 is leaver-only. `jml detect` announces joiners; nothing acts on them |
| A Microsoft Graph leg | Interface only. `legs.azure` is a literal `false`, and start-up refuses if `AZURE_CLIENT_SECRET` is set |
| Slack SCIM deactivation | Interface only, same treatment with `SLACK_SCIM_TOKEN`. Note that the SCIM token, a bot token and a user token are three different credentials on three different screens |
| A SaaS-register checklist | Reserved |
| Notion or Sheets as the people store | Schema describes them; choosing one refuses at start-up. Use SQLite |
| A Linux device script | None ships. A hand-over on a Linux machine is refused rather than being sent the Windows script |
| Asset registers, monitoring agents, patch compliance, anything device-shaped beyond disposition | Out of scope. The device code here exists to answer one question: may this account be deleted yet |

The reason for the refusals rather than best-effort stubs is in
[incidents.md](incidents.md): a credential present for a step that cannot run
reads as coverage that does not exist, and a step that quietly does nothing
while the run reports success is the failure mode that cost the most.

## Contributing back without publishing your estate

- Reproduce a defect as a test against a fake, never against your tenant.
  `test/fixtures/` holds the harnesses.
- If a vendor behaves differently on your tenant, that is worth a report. Say
  what you observed and what the code assumed. Redact ids by construction:
  read them into a variable and quote the shape, the length or the status
  code, never the value.
- Do not set `provenOnHardware: true` in a pull request. It is a statement
  about your fleet, not about the code. Set it in your own copy and record the
  machine and the date in your own change.
- `npm run gate` before you push. The disclosure gate runs first in CI and
  scans history, not only the working tree, so a credential committed and then
  removed still fails the build.
