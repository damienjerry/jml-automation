# Running it: daily checks, stopping, backups, updates, removal

For the person who has it installed and now has to live with it. Every command
here is one that exists and has been run; where a step has only been exercised
on test data, it says so.

## Free to use is not free to run

The code is MIT licensed and costs nothing. Running it unattended has costs of
its own, and you should know them before you rely on it:

- **Something has to be awake at run time.** The pipeline runs on a schedule. A
  laptop that sleeps misses it. Run n8n and the sidecar on a machine that is
  always on: a small server, a virtual machine, or a home lab box with a UPS.
- **Vendor access.** You need API access to your HR system, an admin key for the
  identity provider, and a Google service account with domain-wide delegation.
  Some HR plans charge for API or service-user access. Check yours.
- **Docker.** Any Docker engine works. Docker Desktop is free for small
  businesses under Docker's own terms and needs a paid subscription above them.
- **n8n** is optional. Self-hosted n8n is free under its own licence for
  internal use. Without it, run `jml run` from cron.
- **Your time.** Provider APIs change. When one does, a connector breaks, and
  somebody has to notice, read the error and fix or update. That somebody is
  you. This is a versioned reference toolkit, shared for you to use and
  adapt. Ongoing maintenance, support and compatibility updates are not
  promised. If you deploy it, you own that deployment.
- **Someone to receive alerts.** Missed runs and failures are only useful if they
  reach a person who will act. Decide who that is before you arm anything.

## What has been tested against real services

| What | Against | When |
| --- | --- | --- |
| `jml doctor`, every credential and scope | HiBob, JumpCloud, Google Workspace | 2026-09-25, one tenant |
| HR read, history import, two dry-run cycles | the same tenant, read-only | 2026-09-25 |
| Notion people store, read-only | one live Notion database | 2026-09-25 |
| `jml n8n import` | n8n 1.123.77, a throwaway instance | 2026-09-26 |
| backup and restore of the SQLite store | test data only | 2026-09-26 |
| HR from a CSV file, including the shipped example | offline tests | 2026-09-26 |
| HR from a Google Sheet | a fake Sheets API only | 2026-09-26 |
| setup 1.0b (no identity provider) | fakes only, never a real tenant | 2026-09-26 |
| the installer and setup preview on Linux | Ubuntu, in CI, on every push | 2026-09-27 |
| the test suite on native Windows | Windows, in CI, on every push; does not block | 2026-09-27 |
| **any write to a real provider** | **never**: no suspension, licence change, transfer, deletion, activation or sent message | |
| device uninstall scripts | never on real hardware | |

Everything else is covered by the test suite, which runs against recorded
responses and fakes. Tests passing tells you the code does what the tests say.
It does not tell you your tenant behaves like the recordings.

## Every morning

1. Read the run report or the notification channel. A quiet day and a broken
   schedule look the same, so the next two checks matter more than the report.
2. **The schedule fired.** Set `liveness.healthchecksPingUrl` to a dead-man
   service, such as Healthchecks.io. The ping is sent only after a run's
   notification is confirmed delivered, so a missing ping means either the run
   did not happen or its alert did not arrive. Point the dead-man's own alert at
   a person.
3. **The credentials still work.** The shipped doctor workflow runs `jml doctor`
   fifteen minutes before the pipeline. A red doctor run means the next run will
   fail; fix the credential first. See [runbooks/rotate-a-credential.md](runbooks/rotate-a-credential.md).
4. **Nothing is parked for long.** `jml doctor` always prints the age of the
   oldest parked row. A parked row takes no action and raises nothing further,
   so a row parked for a week is a person nobody is handling.
5. **Red n8n executions.** `jml-on-error` alerts on any failed execution. Two
   `409` skips are normal (an overlapping run); see [n8n/README.md](../n8n/README.md).

`jml store verify` prints the counts: who is active, offboarding, held and
parked, and the exact set a run would act on today.

## Stop it

Fastest first. The full procedure, including what to do about a run already in
progress, is in [runbooks/incident-recovery.md](runbooks/incident-recovery.md#2-stop-the-next-run).

| Action | Stops |
| --- | --- |
| deactivate the `jml-pipeline` workflow in n8n | the schedule |
| `mode: dry-run` in `jml.config.yaml`, then restart the sidecar | every write, from any caller |
| empty `armedActions`, then restart the sidecar | each action, recorded as `not_armed` |
| `jml leaver hold --hris-id <id> --reason "..."` | one person, immediately, including the HR sync |

A run in progress cannot be stopped from outside. It holds a lease for up to
fifteen minutes. Wait for it, then read `jml audit tail`.

## Back up and restore

**Back up** the two databases and the audit directory:

```
jml store backup --to ./backups
```

That writes a consistent copy of both SQLite databases, named with the time:
`jml-people-<time>.sqlite` and `jml-state-<time>.sqlite`. The audit log is not
copied, because it is append-only and hash-chained: back up the `audit`
directory with your ordinary file backup. Keep backups off the machine.

**Restore**, with the schedule stopped first:

```
cp backups/jml-people-<time>.sqlite data/jml.sqlite
cp backups/jml-state-<time>.sqlite  data/jml-state.sqlite
jml store verify
jml audit verify
jml sync
```

Copy each file back to the exact live name in `store.path` and beside it.
`jml store verify` should show the counts you had. `jml sync` without `--armed`
should report nothing created and people unchanged or preserved; if it reports
people created, the store you restored is older or smaller than you thought.

This was exercised on test data: back up, delete both databases, restore,
verify, sync. Two things it showed:

- A copy left under its timestamped name is not read. The toolkit opens an empty
  store at the live path instead.
- An empty store with nothing expected used to print a clean result. `jml store
  verify` now warns when the store holds no rows. Pass `--expect-departed` with
  your tombstone count to make a lost store fail outright.

**Practise the restore** once, on a copy, before you need it.

If only the people database is lost and the state database survives, the next
run refuses on its own: the tombstone count fell, which is the signature of lost
rows. See [runbooks/incident-recovery.md](runbooks/incident-recovery.md#the-tombstone-count-invariant-aborted-a-run).

## Update

1. `jml store backup --to ./backups`, and copy the audit directory.
2. Read [CHANGELOG.md](../CHANGELOG.md) for the version you are moving to.
3. `git fetch --tags`, then `git checkout <tag or commit>`. Do not update to a
   moving branch on a system that deletes accounts.
4. `npm ci --ignore-scripts`, then `npm run build`.
5. `jml store migrate`. A SQLite store applies any migration the first time the
   new build opens it, whichever command that is, which is why the backup is
   step 1. A Notion store is never changed on open: `jml store migrate`
   rehearses, and `jml store migrate --armed` adds any missing property.
6. `jml doctor`, then one `jml run` without `--armed`, and read it.
7. With Docker: `docker compose up -d --build`.

**Roll back** by checking out the previous commit and repeating steps 4 and 7.
If a migration ran, restore the backup from step 1 as well.

## Rotate a credential

[runbooks/rotate-a-credential.md](runbooks/rotate-a-credential.md). In short:
change the value, restart whatever resolved it, run `jml doctor`.

## Remove it

1. Deactivate every `jml-` workflow in n8n, or `docker compose down`.
2. Revoke what it was given: the identity provider API key, the Google service
   account's domain-wide delegation (and the key), the HR service user, the
   Slack bot, the Notion integration, the n8n API key.
3. Decide what to keep. The people store and the audit log are your record of
   who was offboarded and when. Keep them for as long as your retention policy
   says, then delete `data/` and `audit/`.
4. Delete the clone.
