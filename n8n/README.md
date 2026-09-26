# The n8n bundle

Six workflows that drive the toolkit. They are the front door: n8n is the
runtime most IT teams already run, and a schedule with a visible execution list
is easier to trust than a cron line on a box.

The workflows contain no logic. Every decision, every credential and every
write lives in the `jml` sidecar, which the workflows reach over HTTP. That
split is the whole design, and most of this page is about why.

| File | Trigger | What it calls |
| --- | --- | --- |
| `workflows/jml-pipeline.json` | schedule, 07:00 daily | `POST /v1/runs`, then polls `GET /v1/runs/{runId}` |
| `workflows/jml-doctor.json` | schedule, 06:45 daily | `GET /v1/doctor` |
| `workflows/jml-leaver-manual.json` | form | `POST /v1/leavers/run` |
| `workflows/jml-device-disposition.json` | form | `POST /v1/devices/disposition` |
| `workflows/jml-on-error.json` | error trigger | nothing; it posts the failure |

## Why there is no logic here

The version of this automation these files were extracted from ran its engine
inside n8n Code nodes. Every one of the failures below is a property of that
choice rather than bad luck:

- the task-runner sandbox has no global `fetch`, and its HTTP helper discards
  the body of a non-2xx response, so a 401 read as a network error for hours;
- a chat post that answered `200` with `ok:false` was believed by several
  workflows for weeks, because nothing checked the body;
- an expression written into a raw JSON body was sent as literal characters,
  so a channel id arrived as the text `={{ $json.channel }}`;
- a variable used above its own declaration threw only on the runs that had
  work to do, so the workflow looked healthy for an hour;
- `staticData` accumulated a snapshot of real people and went into every
  export;
- a node caps out well below the ten minutes a device receipt can take.

None of that can be typechecked, unit-tested or secret-scanned. In the sidecar
all of it can, so the workflows here are wiring and nothing else.
`npm run validate:workflows` rejects a Code node outright.

## Import order

Import `jml-on-error.json` first. The other four name it as their error
workflow, and n8n stores that reference as an id, so the target has to exist
before the reference means anything.

1. `jml-on-error.json`
2. `jml-doctor.json`
3. `jml-pipeline.json`
4. `jml-leaver-manual.json`
5. `jml-device-disposition.json`

Then, for each of the four: **Settings, Error Workflow, pick `jml-on-error`**.
The shipped files carry the string `jml-on-error` as a placeholder because a
workflow id belongs to one instance and means nothing on another. Until you
pick it, a failure in that workflow alerts nobody, which is the state the
original estate was in for its whole life.

Everything imports inactive on purpose. Read a workflow, run it once by hand,
then activate it.

## Environment

Two variables are read by the workflows themselves:

| Variable | Value | Why it is not in the file |
| --- | --- | --- |
| `JML_API_URL` | `http://jml:8787` on the compose network | A URL in a shipped export points every adopter at whoever owns that host |
| `JML_DRY_RUN` | `true` until you have watched a run | Arming is a decision, and it should be visible in one place |

`JML_DRY_RUN` is read as `$env.JML_DRY_RUN !== 'false'`, so anything except the
exact string `false` means dry run. An unset or misspelt variable therefore
changes nothing on a real tenant. The sidecar defaults the same way: only an
explicit `dryRun: false` in the body arms a call, so both ends fail safe.

One more variable is shared with the sidecar rather than being n8n's own:
`SLACK_JML_CHANNEL_ID`, the channel these workflows post to. It is an
environment reference rather than a value because a channel id pasted into a
shipped workflow posts one organisation's leaver names into another
organisation's channel.

The validator fails on any `$env` reference outside those three. The shipped
`docker-compose.yml` sets `JML_API_URL` on the n8n service; add `JML_DRY_RUN`
and `SLACK_JML_CHANNEL_ID` there too, from the same `.env` the sidecar reads.

## Credentials

Three, and only the first belongs to the toolkit:

| Credential | Type | Holds |
| --- | --- | --- |
| `JML Toolkit API` | Header Auth | `Authorization` = `Bearer <JML_API_TOKEN>` |
| `JML Slack Alerts` | Slack API | the bot token n8n posts with |
| `JML Form Access` | Basic Auth | a username and password for the two forms |

No vendor credential is here. The identity provider key, the Google service
account and the HRIS token are all inside the sidecar container, which is why
n8n holds one toolkit secret instead of five. `docker compose config` shows the
n8n service carrying no vendor variable, and `grep -ri credential n8n/workflows`
shows the exports carrying no credential material, so the claim is checkable
rather than something to take on trust.

Match the credential names exactly. The exports reference credentials by name
with no id, because an id is meaningless on another instance, and n8n binds
them on import by name.

`JML Form Access` is not optional. A form trigger is reachable by anyone who
can reach n8n, and these two forms suspend accounts and remove device records.
The inbound ticket webhook is authenticated the same way, with its own header
credential, `JML Inbound Webhook`, so the ticketing tool never holds the token
that drives the sidecar.

The bundle ships no form path. n8n assigns one when the workflow is activated,
and you read the URL off the trigger node. The one fixed path is the inbound
ticket webhook's, `jml-ticket-inbound`, because the ticketing tool has to be
given it in advance; the header credential is what guards it. A fixed path in a public
repository is a URL everybody already knows, and a form URL behaves like a
shared secret whatever else guards it.

## Timeouts

| Route | Timeout | Reason |
| --- | --- | --- |
| `POST /v1/runs`, `POST /v1/leavers/run`, `GET /v1/runs/{id}` | 30s | The answer is immediate; the work is not done inside the request |
| `GET /v1/doctor` | 120s | It makes a live call per credential and per authorised scope |
| Everything in the device workflow | 600s | A command receipt takes minutes, and the agent-quiet confirmation adds ten more |

Every run route is asynchronous: the sidecar answers `202` with a `runId` and
the workflow polls `GET /v1/runs/{runId}`, which answers `202` while the run is
in flight and `200` with the report when it is terminal. Nothing the engine
does is bounded by an n8n task, which is the only arrangement that survives the
device path. It also removes the first-run problem, where a backlog of leavers
takes longer than any HTTP timeout allows.

Each poll loop is bounded by `$runIndex`, so a run that never reaches a
terminal state ends the execution rather than looping for ever. Giving up still
reaches the assertion at the end, so it is reported as a failure and not as
silence.

## Two kinds of skip, and why neither is a failure

`409` appears twice and means the same thing both times: nothing happened.

- on `POST`, a run of that kind is already in flight in the sidecar;
- on the poll, the run started, took the pipeline lease, found another process
  holding it, and did nothing.

Both route to a No Operation node, not to an error. A schedule that overlaps
itself is normal operation, and an alert nobody can act on gets ignored along
with the ones that matter. On the manual form the same skip means the operator
should submit the form again; nothing was done to the person.

## Node by node

### jml-pipeline

1. **Every day at 07:00**: one schedule for the whole lifecycle. The sidecar
   runs sync, then detect, then the leaver engine, inside one lease. The
   original had five separate schedules whose ordering existed only in a
   comment, and the sync sometimes ran after the engine that depended on it.
2. **Run options**: computes `dryRun` from the environment. One place to look.
3. **Start the run**: `POST /v1/runs`. Fields are sent as key/value pairs. A
   raw JSON body does not begin with `=`, so n8n never evaluates the
   expressions inside it and ships their characters instead.
4. **Run accepted?** and **Already running?**: `202` proceeds, `409` skips,
   anything else stops. The status code is read explicitly because the request
   is configured never to error, so nothing here has to guess from an empty
   body.
5. **Wait for the engine** and **Poll the run**: the poll loop.
6. **Lease held elsewhere?**: the second skip described above.
7. **Summarise the run**: flattens the report into the few fields the message
   needs, so the nodes after it read short expressions. A run that failed before
   finishing has no report, and that is said in words rather than printed as
   `undefined`.
8. **Post the run summary**: the counts, including `blocked` and `failedLegs`.
   The Slack node is set to continue on error so that delivery is judged in
   exactly one place, the node after it.
9. **Slack accepted the post?**: stops the execution unless `ok` is literally
   `true`.
10. **Run reported ok?**: reads `ok` from the summary node by name, not from
    `$json`. After the Slack node `$json` is the chat response, whose own `ok`
    field means something else entirely.

The order of the last three matters. The chat post comes first so that a failed
run is still announced; the assertions come after it so that a throw cannot
take the announcement down with it. Both are the same recorded lesson: a throw
ends the execution, so anything that must happen goes before the assertion.

### jml-doctor

Runs fifteen minutes ahead of the pipeline, so a credential that has stopped
working is known before the run that needs it rather than after. `200` means
every probe passed and `503` means one did not; both are answers, and only a
third status means the sidecar itself is unreachable.

Nothing is posted while every probe passes. When one fails, the failing rows are
posted with their remediation and documentation anchor, and then the execution
is failed deliberately, in that order, so a rejected post cannot hide the thing
it was reporting.

It does repeat daily while a probe stays broken. That is the honest trade for
now: the sidecar's doctor route does not yet say whether its table has changed
since the last check, and computing that in the workflow would put a second copy
of the same state somewhere it cannot be tested. When the route reports a
change, the gate here becomes one condition.

### jml-leaver-manual and jml-device-disposition

Forms, both authenticated, both defaulting to a dry run.

A dry run on the disposition form is the preflight: it prints the bindings, the
refusals, the exact association it would create, and what the day 7 device gate
would say afterwards, and writes nothing.

The disposition form asks for an explicit acknowledgement before a handover can
lose an escrowed disk-encryption key, and for the system id the uninstall script
was proven on, because a script whose manifest says it has never run on hardware
is refused without one. See
[canary a device script](../docs/runbooks/canary-a-device-script.md).

The form offers `return_to_pool`, `handover` and `retain_unmanaged`. Reassigning
to a named person is `jml device dispose` on the command line for now: the
engine takes a new owner, and the API route does not yet pass one through. An
option that silently did something other than what it says is worse than an
option that is not there.

`retain_unmanaged` writes nothing at all and deliberately leaves the day 7 gate
closed. Deleting a device record while the agents are still installed removes
the machine from your view, not from the network.

### jml-on-error

Error trigger, one chat post naming the workflow, the node and the execution,
and an assertion on the post. An alert path that cannot report its own failure
is not an alert path.

This workflow deliberately does not name an error workflow of its own. It would
name itself, and a failure inside it would then spend its time alerting on being
unable to alert. The validator enforces both halves: the other four must name
it, and it must not name anything.

## Prove the schedule actually runs

Do this once, when you first activate `jml-pipeline`, and again after any n8n
upgrade. It takes four minutes and it is the only thing that distinguishes a
working schedule from one that has never fired.

1. Set `JML_DRY_RUN=true` and restart n8n so it is picked up.
2. Open `jml-pipeline`, change the trigger to a cron expression of `*/2 * * * *`
   and save.
3. Activate the workflow. Watch the Executions list. Within two minutes an
   execution should appear, and it should be green.
4. Open it. Confirm the poll node returned a report and that the chat post
   landed in the channel. A green execution with no message in the channel means
   the chat credential or the channel id is wrong.
5. Set the trigger back to `0 7 * * *` and save. **Check the Executions list
   again ten minutes later and confirm nothing new has appeared**, which proves
   the restore took.

Why this is worth the four minutes: a scheduled job in the estate this came from
ran a broken build for months and nobody noticed, because nothing
distinguished "ran and found nothing to do" from "never ran". Hosted schedulers
also throttle frequent schedules silently, so a two-minute cron that never fires
is itself useful information about the instance you are on.

The equivalent check on the sidecar is `jml doctor`, and the dead-man ping is
sent only after a notification is proven delivered, so a green dead-man proves
the alert path as well as the run.

## Editing a workflow

Edit in the n8n editor, then scrub the export before committing it:

```
node n8n/scrub-export.mjs export.json --out n8n/workflows/jml-doctor.json
npm run validate:workflows
```

The scrub tool strips the instance metadata an export carries: credential ids
(and renames credentials to the bundle's names), node ids, webhook ids, form
paths, instance settings such as the timezone and caller policy, the channel
names a chat node caches, `pinData`, and `staticData`, which is a snapshot of
whatever the workflow last handled. It refuses to write anything if the
identifier gate or the validator still object, because a scrub that half worked
leaves a file that looks scrubbed.

Never install a workflow by writing to n8n's database. This n8n runs a published
version of a workflow, not the row you edited, so a database edit changes
nothing while appearing to succeed. Use the editor or the public API.

`npm run validate:workflows` runs in CI and rejects: instance metadata, a
credential id, a hardcoded URL, an unknown `$env` reference, a node type off the
allowlist, a Code node, a raw JSON body, a missing or self-referential error
workflow, an unasserted chat post, work queued after a delivery assertion, a
chat branch that runs before a sibling, a device workflow with a timeout under
ten minutes, an open form, a run route that blocks instead of polling, and a
file that would import already active.
