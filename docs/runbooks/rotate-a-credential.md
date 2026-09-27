# Runbook: rotate a credential

Use this when a key has expired, leaked, or belonged to somebody who has left.

Rotation is three steps: change the value where it lives, restart the process
that resolved it, prove it with `jml doctor`. The third step is the one people
skip and the only one that tells you anything.

Which credential each integration needs, the minimum scope, and where to create
it are in [../credentials.md](../credentials.md). This page is only about
replacing one that already exists.

## Why a restart is part of it

**Every secret reference resolves once, at start-up.** A credential that cannot
be resolved stops the process; it never becomes a step that quietly does nothing
while the run reports success. The resolved value is held in a closure and is
reachable only through a `use(fn)` call, so it cannot be stringified,
serialised, spread or inspected into a log by accident.

The consequence for rotation: a long-running `jml serve` holds the old value
until it is restarted. Changing the environment underneath it changes nothing.

This is worth knowing rather than guessing at, because the opposite arrangement
caused a real outage in an earlier design. A container
snapshotted its environment once at start and every scheduled job inside it read
that snapshot, so a rotated key was correct in the file and stale in the process
for days, and the errors it produced were swallowed as "nothing to
report".

## What the configuration holds, and what it does not

No credential value ever appears in `jml.config.yaml`. Every secret field holds
a reference in one of three grammars:

| Form | Meaning |
| --- | --- |
| `env:NAME` | the value of that environment variable |
| `file:/path` | the trimmed contents of that file |
| `op://<vault>/<item>/<field>` | read through the 1Password CLI |

`keychain:` is deliberately absent and fails the grammar rather than resolving
to nothing.

The fields that are secret references, and what breaks without each:

| Reference | Rotate where | Breaks |
| --- | --- | --- |
| `identity.jumpcloud.apiKey` | provider admin portal | everything: no account is read, suspended or deleted |
| `google.serviceAccountJson` | cloud IAM, then re-check the delegation | Google reads, suspension, deletion, licences, transfers, auto-reply, outbound mail |
| `hris.hibob.serviceUserId`, `hris.hibob.serviceToken` | HR system service users | the run aborts before the sync; nothing is touched |
| `server.token` | generate a new one | the sidecar answers 401 to n8n |
| `audit.salt` | generate a new one | see the warning below |
| `notify.slack.botToken` | the app's OAuth page | notifications are not delivered; work still happens |
| `audit.loki.authHeader` | your log service | the secondary audit sink only |
| `liveness.healthchecksPingUrl` | your dead-man service | the dead-man stops being pinged |
| `devices.fleet.token` | your host inventory | the optional inventory adapter only |

**Do not rotate `audit.salt` casually.** Addresses in the audit log are stored
as a salted hash of the address. Change the salt and rows written before the
change stop matching rows written after it, so one person appears as two
identities in a log that is append-only and cannot be corrected. Rotate it only
if the salt itself has leaked, and record the date you did it.

## Rotate one

### 1. Change the value

With `env:` references and the shipped compose file, that means `.env`:

```
$EDITOR .env
```

With `op://`, change it in the vault and leave the file alone.

**Reference a secret-manager item by its UUID, not its title.** A title
reference works until somebody renames the item, and then it fails at the next
scheduled run with nobody watching. That is not theoretical: a live cron job
resolved a credential by exact item title, the item was renamed to mark the old
key obsolete, and the job would have died silently the following morning.

### 2. Restart what resolved it

```
docker compose up -d jml
```

Only the `jml` service holds vendor credentials. The `n8n` service holds one
toolkit secret, the bearer token, and no vendor variable at all. You can check
that rather than take it:

```
docker compose config
```

If you are running the CLI rather than the sidecar, there is nothing to restart:
the next command resolves the new value.

### 3. Prove it

```
jml doctor
```

A passing credential row names the reference and the length, never the value:

```
pass  credential identity.jumpcloud.apiKey  resolved from env:JUMPCLOUD_API_KEY, 31 characters
pass  credential google.serviceAccountJson  resolved from env:GOOGLE_SERVICE_ACCOUNT_JSON, 75 characters
```

**A resolved credential is not a working one.** Those rows only say the
reference resolved. The rows below them make a live call each, and that is the
part that matters:

```
FAIL  identity provider                   the directory read answered 401 on https://console.jumpcloud.com/api
                                          Check the API key. A key belonging to a deleted admin answers 401 on every path.
                                          see credentials#jumpcloud
FAIL  google workspace                    the token exchange for the directory scope answered 0 (Error)
                                          Check google.adminEmail is a real administrator mailbox and that the service account key is current.
FAIL  google scope apps.licensing         refused with Error
                                          Paid seats are never released, so a leaver is billed for indefinitely.. This scope is required: delegate it before arming anything.
```

The last row is the reason `doctor` probes each scope separately rather than
once. **Google tokens are minted one scope per JWT**, so a bundled multi-scope
request fails wholesale when any single scope is undelegated, and a partial grant
then looks identical to no delegation at all. Each failing scope names what
stops working if it stays missing.

A single service account authorised for one directory operation and not another
is the failure this whole command exists for. In an earlier design, that
was discovered by a step silently doing nothing for months.

Ending state you want:

```
every check passed
```

`jml doctor` exits 0 when every check passed, 1 when one did not, and 78 when
the configuration itself would not load. The `jml-doctor` workflow runs it
fifteen minutes ahead of the pipeline for that reason: a credential that has
stopped working should be known before the run that needs it, not after.

## Rotating the sidecar's own token

`server.token` is the bearer token n8n sends. Rotating it takes two changes and
they must both land:

1. change `JML_API_TOKEN` in `.env`;
2. update the `JML Toolkit API` Header Auth credential in n8n to
   `Bearer <the new value>`.

```
docker compose up -d jml n8n
```

Then run the `jml-doctor` workflow by hand. A 401 from the sidecar looks
identical to a wrong token and to no token, on purpose: the response carries no
detail.

The token must be at least 32 bytes and is compared in constant time.
`jml init` generates one.

## If it will not resolve at all

The process refuses to start and names the reference:

```
invalid configuration:
  - hris.hibob.serviceToken: could not resolve secret reference env:HIBOB_SERVICE_TOKEN: environment
    variable HIBOB_SERVICE_TOKEN is not set. See docs/config-reference.md#secret-references
```

That is the designed behaviour. Look at the shape of the configuration without
resolving anything:

```
jml config show --no-secrets
```

It prints references and lengths and no value anywhere, and it is built by
redacting a structural copy rather than by choosing which fields to print, so a
credential that reached the config object by some route this code does not know
about is masked anyway.

## Undo

Put the old value back and restart the same service. Nothing else changed: no
row, no status, no account.

If the old value is already revoked at the provider, the toolkit is
non-functional until a working one is supplied, which is the safe direction. A
run with an unreadable provider parks rows and touches nothing; it does not
delete anything on the assumption that an account is absent.

One thing to check after any rotation, because it is the one thing a rotation
can break somewhere else: search your own scripts for the credential being
looked up **by item title** rather than by id. A title reference cannot survive
the rename you are about to do to mark the old key obsolete.
