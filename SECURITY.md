# Security

This toolkit suspends and deletes staff accounts. Read this page before you
point it at a real tenant, and check the claims rather than believing them:
every statement below names the file or the command that proves it.

## What it can do if it misbehaves

Stated plainly, so nobody has to infer it from the feature list.

With a writing JumpCloud key, a Google service account holding domain-wide
delegation, `mode: armed` and the matching entries in `armedActions`, this
software can:

| Action | What it does to your estate | Reversible |
| --- | --- | --- |
| `suspend` | Suspends a JumpCloud account. The person cannot sign in anywhere that account fronts. | Yes, by hand |
| `autoreply` | Sets a vacation responder on a leaver's mailbox. | Yes |
| `licence` | Deletes every paid licence assignment the account holds. | Re-assign, if seats remain |
| `transfer` | Starts a Google data transfer, moving a leaver's Drive files to another person. | No. The files move |
| `google_suspend` | Suspends the Google account. | Yes, by hand |
| `delete` | **Deletes the JumpCloud account and the Google account.** | No, past the provider's own retention window |
| `device_unbind` | Detaches a person from a machine, or attaches its next owner. | Yes |
| `device_handover` | Runs an uninstall script on a machine, then **deletes the JumpCloud device record**, which destroys the escrowed disk-encryption recovery key with it. | No |

Two further consequences are worth naming because they are not obvious from
the action name:

- Deleting a Google account destroys every file it still owns that has not
  been transferred. That is why the deletion gate refuses to open until the
  provider itself reports the transfer complete.
- Deleting a JumpCloud device record removes the only command channel to that
  machine. The machine carries on running, and there is nothing left to reach
  it with. See [docs/incidents.md](docs/incidents.md#retaining-an-unmanaged-machine-is-not-a-resolution).

The engine never unsuspends and never restores. A wrong suspension is
undone by a person, deliberately: by the time a row reaches the hand-over
day, somebody else may already hold the files.

## What it refuses to do

The refusals matter more than the features, so they are listed first-class.

| It refuses to | Because |
| --- | --- |
| Act at all, on a fresh install | `mode` defaults to `dry-run` and `armedActions` defaults to `[]` |
| Accept `mode: armed` with an empty `armedActions` | One switch that arms everything is how a rehearsal becomes a mass suspension |
| Delete an account while a machine is bound to the person | Deleting it strands the machine, unmanaged, with its recovery key gone |
| Open the device gate when the device read fails | An unreadable gate blocks. Only a successful read of zero devices opens it |
| Run a device hand-over on a fresh install | `devices.uninstallTriggers` is `null` for every platform |
| Run an unproven uninstall script without a named canary machine | Neither shipped script has run on real hardware |
| Fire a command that is attached to a device group, or to a machine somebody else attached | A trigger fires on every association the command holds |
| Delete a device record on anything less than an on-device receipt plus a period of silence | A trigger acceptance is not an execution, and a collected command is not a finished one |
| Start a run when the store's tombstone count has fallen | Rows removed outside the toolkit make historic leavers look like new departures |
| Start a run when the day-0 candidate count exceeds `leaver.maxDay0PerRun` | A sudden crowd of leavers is a data fault far more often than a redundancy round |
| Hand over a snapshot from the HR system below `hris.minPlausibleHeadcount` | A truncated read looks exactly like a company where everybody left |
| Start the sidecar when the audit log cannot be written | A step whose intent cannot be recorded does not happen |
| Start with `AZURE_CLIENT_SECRET` or `SLACK_SCIM_TOKEN` set | Those legs ship as interfaces only. A credential present for a step that cannot run reads as coverage that does not exist |
| Delete a person row, ever | The store interface has no `delete` and no `prune` |

## Trust statement

Each row is a claim about the code, with the command that checks it. Run them
against your own checkout.

| Claim | Check |
| --- | --- |
| No telemetry, no analytics, no phone-home, no update check | `grep -rin "telemetry\|analytics\|sentry\|posthog\|mixpanel" src bin` returns only the `devices.purgeTelemetryHistory` config key and comments about device telemetry |
| Every outbound call goes through one client | `grep -rn "fetch(\|node:https" src \| grep -v src/core/http.ts` returns nothing. ESLint enforces it: see [eslint.config.mjs](eslint.config.mjs) |
| The only hosts contacted are vendor APIs | `grep -rno "https://[a-z0-9.-]*" src \| grep -v googleapis.com/auth` lists the HR API, JumpCloud, four Google hosts, Slack, and two literals that are never fetched (a JSON Schema `$schema` and `$id` in [src/config/generate.ts](src/config/generate.ts)) |
| Two runtime dependencies, no transitive ones | `npm ls --omit=dev --all` prints `yaml` and `zod` and nothing else |
| Credentials are never written anywhere by the toolkit | `jml.config.yaml` is mounted read-only in [docker-compose.yml](docker-compose.yml); nothing in `src/` writes to a credential path. `jml config show` prints references and lengths only |
| A secret is unprintable by construction | [src/config/secrets.ts](src/config/secrets.ts): the value lives in a closure, `toString`, `toJSON` and the Node inspect hook all return `[redacted]` |
| Interpolating a secret is a lint error | [eslint.config.mjs](eslint.config.mjs), rule `no-restricted-syntax`. `npm run lint` |
| Everything emitted passes through a redaction registry | [src/config/redact.ts](src/config/redact.ts). Registered in plain, percent-encoded and base64 forms, since a credential in a URL or a basic-auth header arrives encoded |
| Audit rows carry no credential value | [test/regression/secret-in-error-redacted.test.ts](test/regression/secret-in-error-redacted.test.ts) |
| Sidecar responses carry no credential value | [test/regression/api-response-carries-a-credential.test.ts](test/regression/api-response-carries-a-credential.test.ts) |
| A provider echoing a key back in an error body does not leak it | [test/regression/secret-echoed-in-error-body.test.ts](test/regression/secret-echoed-in-error-body.test.ts) |
| Audit rows store addresses as a salted hash when `audit.minimisePii` is on | [test/regression/audit-log-keeps-addresses-in-clear.test.ts](test/regression/audit-log-keeps-addresses-in-clear.test.ts) |
| A dry run writes nothing at all, including the toolkit's own bookkeeping | [test/regression/dry-run-writes-the-tombstone-baseline.test.ts](test/regression/dry-run-writes-the-tombstone-baseline.test.ts) |
| The demo makes no network call and writes no file | `node bin/jml.mjs demo`. It needs no credentials and no configuration |

The whole set:

```
npm ci
npm run gate      # identifiers, generated-file check, workflow validation, typecheck, lint, 1457 tests
node bin/jml.mjs demo
```

`npm run gate` on this checkout: 0 identifier errors and 0 warnings, 4
generated artefacts current, 5 workflow files valid, typecheck and lint clean,
1457 tests across 149 files passing. `npm run docs:links` separately: 32
Markdown files and 99 source files, 0 broken links.

## Credentials and blast radius

No credential value belongs in `jml.config.yaml`. Every secret field holds a
reference: `env:NAME`, `file:/path`, or `op://<vault>/<item>/<field>`. See
[docs/config-reference.md](docs/config-reference.md#secret-references).

Reference a secret-manager item by its stable id, not by its title. A title
reference resolves until somebody renames the item, and then it fails at the
next scheduled run with nobody watching.

| Credential | Least privilege this toolkit needs | Blast radius if it leaks |
| --- | --- | --- |
| HR service user (`HIBOB_SERVICE_USER_ID`, `HIBOB_SERVICE_TOKEN`) | Read only, on the people fields named in `hris.hibob.fields`. No write. No time-off | Read access to the staff directory: names, addresses, departments, managers, start and leaving dates |
| JumpCloud admin key (`JUMPCLOUD_API_KEY`) | The read set in [src/connectors/jumpcloud/scopes.ts](src/connectors/jumpcloud/scopes.ts) is enough for a report-only deployment. Writes are needed only for the actions you arm | Full control of the directory the key's owner administers: accounts, devices and commands. A JumpCloud key inherits its owner's admin role, so a read-only admin is a genuinely different key, not a flag |
| Google service account key (`GOOGLE_SERVICE_ACCOUNT_JSON`) | The eight scopes in [src/connectors/google/scopes.ts](src/connectors/google/scopes.ts), six of them required. Delegation is granted scope string by scope string | Impersonation of any user in the domain, for the scopes delegated. This is the widest credential in the set: treat it as tenant-wide |
| Slack bot token (`SLACK_BOT_TOKEN`, optional) | `chat:write` only, for the Phase 1 default | Posting as the bot in channels it has been invited to |
| Sidecar bearer token (`JML_API_TOKEN`) | Generated by `jml init`, 32 bytes minimum | Anything the sidecar can do, which includes starting an armed deletion run. Treat it as equal to the vendor credentials |
| Audit sink header, dead-man ping URL | Optional | The ping URL is itself the credential, which is why it is held as a secret reference |

Google tokens are minted **one scope per JWT**, on every path. A bundled
multi-scope token fails wholesale when a single scope is undelegated, and the
provider answers `unauthorized_client` naming nothing, so a partial grant
reads as no delegation at all. `jml doctor` reports 200 or 401 per scope.
Pinned by [test/regression/bundled-scope-token.test.ts](test/regression/bundled-scope-token.test.ts).

## The sidecar

`jml serve` runs an HTTP service so an automation tool can drive the toolkit
without holding any vendor credential. The split is the point: n8n holds the
bearer token and nothing else, so an exported workflow cannot carry your
Google key, because n8n never had it. `docker compose config` prints the
resolved environment of both services and the n8n service names no vendor
variable.

Surface, from [src/server/routes.ts](src/server/routes.ts):

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /v1/health` | none | Answers one field, `ok`. A health endpoint reporting versions or credential state is a reconnaissance surface on a service whose job is destructive |
| `GET /v1/doctor` | bearer | The credential report: references and lengths, never values |
| `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/{id}` | bearer | Start a pipeline run, list runs, poll one |
| `POST /v1/leavers/run` | bearer | One named person |
| `GET /v1/leavers/{hrisId}` | bearer | One row |
| `POST /v1/leavers/hold`, `/release`, `/ack`, `/tombstone` | bearer | Human controls. `hold` and `tombstone` require a reason |
| `POST /v1/devices/preflight`, `/v1/devices/disposition` | bearer | Read a machine, or act on one |

Properties worth checking in the code:

- **The port is not published.** [docker-compose.yml](docker-compose.yml) gives
  the `jml` service no `ports:` key. It is reachable as `http://jml:8787` on
  the private compose network and nowhere else. Publishing it would put an
  endpoint that can delete accounts on your host interface behind one bearer
  token.
- **The token is compared in constant time**, over SHA-256 digests of both
  sides, in `makeAuthoriser` in [src/server/http.ts](src/server/http.ts).
  Hashing first is deliberate: a raw `timingSafeEqual` throws on a length
  mismatch, which leaks the length.
- **A token under 32 characters refuses to start the server.**
- **401 says nothing.** A wrong token and a missing token get the same answer.
- **The body is capped** at 64 KB and the connection is dropped past it. This
  process holds every credential, so an unbounded body is a way to exhaust it.
- **Dry run is the default on every route.** Only an explicit `dryRun: false`
  arms a call, so a malformed body plans instead of acting.
- **Every response passes through the redaction registry** on the way out.
- **Runs are asynchronous.** Starting work answers 202 with a run id and the
  caller polls. A second concurrent run answers 409 and is a skip, not a
  failure.
- **The container runs as a non-root user** ([Dockerfile](Dockerfile), `USER
  node`) from a digest-pinned base image.

The sidecar has no user model, no roles and no request signing. Anything
holding the token can do anything the toolkit can do. Keep it on a private
network, and put your own proxy and authentication in front of the n8n editor
before exposing that beyond the host.

## The arming locks

Two locks, and they are independent. Both have to be open before a provider is
written to.

1. **The call.** Every CLI command plans unless `--armed` is passed; every
   route plans unless the body says `dryRun: false`.
2. **The configuration.** `mode: armed`, plus the action named in
   `armedActions`. `isArmed` in
   [src/engine/leaver/legs.ts](src/engine/leaver/legs.ts) is
   `cfg.mode === 'armed' && cfg.armedActions.includes(action)`. An action that
   is not named records `not_armed` and moves on, so you can arm suspension
   and leave deletion to a person indefinitely.

Two flags are literal `true` in the schema and cannot be overridden at all:
`leaver.deviceGate.failClosed` and `devices.forbidGroupBoundCommands`. Each is
there because the opposite behaviour caused a recorded incident.

## What is not proven

Stated here rather than in a footnote, because a sceptical reader is right to
ask.

- **Only reads have run against a real tenant.** One shadow run before this release:
  `jml doctor`, the HR read, the identity directory read, the Google scope
  probes and the Notion adapter in read-only mode. No write has. Every write
  path is exercised against a scripted HTTP double
  ([test/fixtures/http/fake-http.ts](test/fixtures/http/fake-http.ts)), written
  by hand from the vendors' documented behaviour, and the shadow run showed what
  that is worth: the first real HR call answered 415 to a header shape every
  fake accepted. The vendor behaviours the code guards against were established
  in the private automation this was ported from, not by this code.
- **Neither device uninstall script has ever run on real hardware.**
  [src/engine/device/scripts/manifest.json](src/engine/device/scripts/manifest.json)
  records `provenOnHardware: false` for both. Service names, uninstall
  strings, launchd labels and paths were inferred. A hand-over on an unproven
  platform is refused unless you name the machine you canaried it on, and the
  refusal names the runbook.
- **The n8n bundle has never been imported into a running n8n.** The five
  workflow files are hand-authored and validated by a gate that checks their
  structure. No execution has been observed.
- **No Linux uninstall script ships.** A hand-over on a Linux machine is
  refused rather than being sent the Windows script.

## Reporting a vulnerability

Report privately. Use GitHub's private vulnerability reporting on this
repository: **Security** then **Report a vulnerability**. Do not open a public
issue, and do not include a real credential, a real address or a real device
name in the report.

Useful in a report: the version or commit, the configuration shape from
`jml config show` (which prints no values), the failing command, and what you
expected instead. If a credential has been exposed, rotate it first and report
second.

Expect an acknowledgement within a week. There is no bounty programme.
