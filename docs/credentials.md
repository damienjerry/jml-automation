# Credentials

Every credential the Phase 1 code actually uses, the smallest permission set
that makes it work, where to create it, how `jml doctor` proves it, and how to
rotate it.

The scope lists here are read off two files in the source tree, not from
memory:

- [`src/connectors/google/scopes.ts`](../src/connectors/google/scopes.ts)
- [`src/connectors/jumpcloud/scopes.ts`](../src/connectors/jumpcloud/scopes.ts)

Each entry in those files carries the exact scope string, which method mints a
token for it, and one line saying what breaks without it. The "what breaks"
column below is quoted from them.

## What has not been proven

Read this before you grant anything on the strength of this page.

| Claim | Status |
| --- | --- |
| The toolkit has run end to end against a real tenancy | **No.** Nothing here has ever run against a live tenant. The connectors are driven by scripted fakes in 1351 tests, and the demo runs offline with no credentials. |
| The two device uninstall scripts have run on real hardware | **No.** `src/engine/device/scripts/manifest.json` records `provenOnHardware: false`, and a handover is refused on any platform whose script carries that flag until you name the machine you canaried it on. See [the canary runbook](runbooks/canary-a-device-script.md). |
| The n8n bundle has been imported into a running n8n | **No.** The exports validate and scrub; no instance has loaded them. |

So every "how `jml doctor` proves it" below describes a check the code
performs. It does not describe a check somebody's estate has passed. Treat the
console paths as the vendor's own documented locations, and confirm them
against your tenancy as you go.

## Two rules that apply to all of them

### No credential value goes in the configuration

Every secret field in `jml.config.yaml` holds a reference, never a value. Three
forms are accepted, and anything else fails the grammar at start-up:

| Form | Meaning |
| --- | --- |
| `env:JUMPCLOUD_API_KEY` | the value of that environment variable |
| `file:/run/secrets/jc-api-key` | the trimmed contents of that file |
| `op://<vault>/<item>/<field>` | read through the 1Password CLI |

Every reference resolves once, at start-up. A credential that cannot be
resolved stops the process. It never becomes a step that quietly does nothing
while the run reports success, which is what the automation this was extracted
from did for months. Resolved values are held in a closure and are only
readable inside `use(fn)`, so a handle cannot be stringified, spread or
inspected into a log by accident. Full grammar:
[config reference](config-reference.md#secret-references).

### Reference a secret-manager item by its stable id, not by its title

`op://<vault>/<uuid>/<field>` survives a rename. `op://<vault>/Some Item
Name/<field>` does not.

This is not tidiness. A title reference works until somebody renames the item,
and then it fails at the next unattended scheduled run rather than at the
moment of the rename. In the estate this was ported from, a credential was
renamed to mark it obsolete and a nightly job that looked its replacement up by
title died silently that night. Nothing connected the rename to the failure for
a day.

The same rule applies to any secret store with both a name and an id: use the
id.

## Prove Google delegation before you try anything else

<a id="probe-dwd-scopes"></a>

`tools/probe-dwd-scopes.mjs` mints one assertion per required scope, exchanges
each at the OAuth token endpoint, and prints a pass or fail row per scope.

```
node tools/probe-dwd-scopes.mjs \
  --admin admin@example.com \
  --sender it.notifications@example.com \
  --mailbox jane.doe@example.com
```

It runs on a fresh clone with nothing built and no dependencies installed. It
reads nothing in your tenancy and changes nothing: the token exchange is itself
the authorisation check, so it is safe against production. Exit status is 1 when
any required scope is refused, so it can gate a deploy.

Output when three scopes are delegated and three are not:

```
admin.directory.user           admin@example.com               200  granted
admin.directory.user.readonly  admin@example.com               200  granted
apps.licensing                 admin@example.com               200  granted
admin.datatransfer             admin@example.com               400  REFUSED (unauthorized_client)
gmail.settings.basic           jane.doe@example.com            400  REFUSED (unauthorized_client)
gmail.send                     it.notifications@example.com    400  REFUSED (unauthorized_client)

3 scope(s) refused. Add each one, exactly as written, under
Google Admin > Security > Access and data control > API controls > Domain-wide delegation,
against the service account client id. Then run this again.
  https://www.googleapis.com/auth/admin.datatransfer
  https://www.googleapis.com/auth/gmail.settings.basic
  https://www.googleapis.com/auth/gmail.send
```

### Why one assertion per scope, and why this is the most useful tool here

Google grants delegation scope string by scope string. A token requesting
several scopes at once fails **as a whole** the moment any single one of them is
not delegated, and the refusal is a bare `unauthorized_client` that names no
scope at all.

So a partial grant is indistinguishable from no delegation. That is how, in the
automation this was ported from, a service account that was authorised for user
administration and not for group administration read as a broken key, and the
search went looking for a bad key file, a clock skew and a wrong client id
before anybody thought to test one scope on its own. A five-minute check became
an afternoon.

The same rule shapes the connector itself. It mints one token per scope on
every path, always, and a regression test drives every method and asserts that
each request carried exactly one scope with no space in it:
[`test/regression/bundled-scope-token.test.ts`](../test/regression/bundled-scope-token.test.ts).

### Nothing secret is printed

The assertion and the returned token never leave the process. Only the OAuth
error **code** is shown, never the error description, because a description can
quote parts of the request and these tables get pasted into issues. A test
asserts the renderer is fed nothing but probe verdicts.

### Probe the mailbox scope with an ordinary mailbox

`--mailbox` matters. Probing `gmail.settings.basic` as the administrator proves
the scope is delegated while saying nothing about whether ordinary staff can be
impersonated, and that is the half that fails in practice. Pass a real,
non-administrator mailbox. Without `--mailbox` the tool falls back to `--admin`
and the row is weaker than it looks.

## The HR system

<a id="hibob"></a>

The reference adapter reads HiBob. `hris.adapter: fixture` is the credential-free
alternative and is what the demo uses.

| | |
| --- | --- |
| Credential type | Service user, sent as HTTP Basic `id:token` |
| Config keys | `hris.hibob.serviceUserId`, `hris.hibob.serviceToken` |
| Env | `HIBOB_SERVICE_USER_ID`, `HIBOB_SERVICE_TOKEN` |
| Where | HR system settings, integrations, service users. Attach a permission group carrying People read. |

### This toolkit never writes to the HR system

Read only. The whole of its HR interaction is `POST /v1/people/search`, called
twice per sync. There is no write path, no field update, no document upload and
no planned feature that would add one.

Say this out loud because an existing service user may already hold write
permission for something else. In the estate this came from, the same service
user wrote custom fields for an asset sync. That was a separate consumer. Do
not grant this toolkit write permission on its behalf, and if you are reusing an
over-privileged service user, know that the extra permission is not a
requirement of anything here.

### Minimum permission set

People read, on **active and inactive** employees, covering these fields:

| Field read | Path | Needed for | Without it |
| --- | --- | --- | --- |
| Person id | `root.id` | the join key for every row | nothing works: the id is the only stable identity |
| Work address | `root.email` | matching the provider account | no account can be found, so every leaver parks |
| Display name | `root.displayName` | notifications and audit rows | rows are named by id only |
| First, last name | `root.firstName`, `root.surname` | fallback naming | display name only |
| Department, title, site | `work.department`, `work.title`, `work.site` | reporting and routing | reports lose their grouping |
| Start date | `work.startDate` | deriving `hired` rather than `active` for a future joiner | a joiner is treated as already employed |
| Manager | `work.reportsTo.email`, `work.reportsTo.displayName` | the day-0 manager mail and the Drive transfer recipient | the transfer has no recipient and the row parks |
| Leaving date | `internal.terminationDate`, then `employment.terminationDate` | the entire leaver schedule | nobody is ever detected as leaving |

Time-off and leave endpoints are never called. In the estate this came from
those endpoints returned empty for every range at this permission level, and a
balance read returned 403, so no code here may assert anything about leave.

### Why inactive people are non-negotiable

The employed set is built from a **second** call with `showInactive: false`,
rather than from a lifecycle status string on each record. A lifecycle label
means different things in different tenants, and in different configurations of
the same tenant. Absence from the employed set is the thing the whole leaver
path keys on, so it is read directly.

That means a credential that can only see employed people produces a pipeline
which quietly offboards nobody, for ever, with no error.

### How `jml doctor` proves it

Two single-page probes, employed-only first and then including leavers. It
reports both counts and states the credential is used read only:

```
pass  HR system   read people: yes (48 employed, 61 including leavers, first page
                  only); this credential is used read only: the toolkit never writes
                  to the HR system
```

A 401 or 403 gets this remediation, verbatim from the adapter:

> The service user id or token is wrong, or the service user has no People read
> permission. This toolkit needs read only.

An employed read that works while the inactive read fails gets its own row,
because the two failures need different fixes:

> The service user must be allowed to read inactive people. Without them a
> leaver is missing from the snapshot altogether, so nobody is ever offboarded.

And if no inactive people come back at all, the check passes but says so:

> no inactive people came back, so either there are none or this credential
> cannot see them; check one known leaver before arming anything

### The permission failure that looks like mass redundancy

A truncated or filtered read looks exactly like a company where everybody left.
`hris.minPlausibleHeadcount` is required with no default for that reason: a
snapshot below your stated floor aborts the run and writes nothing. Set it well
below real headcount so only a broken read trips it.

Paging stops on a short page and nothing else. A read that cannot finish throws
rather than returning what it got, because a partial snapshot treats everybody
past the last page as having left. Regression tests:
[`hris-truncated-read-aborts`](../test/regression/hris-truncated-read-aborts.test.ts),
[`hris-implausible-headcount-aborts`](../test/regression/hris-implausible-headcount-aborts.test.ts),
[`hris-employed-set-not-status-string`](../test/regression/hris-employed-set-not-status-string.test.ts).

### Rotation

Create the new service user token alongside the old one, put the new value
where the reference points, restart the sidecar, re-run `jml doctor`, then
revoke the old one. Nothing caches the credential beyond process lifetime, so a
restart is the whole cutover.

## JumpCloud

| | |
| --- | --- |
| Credential type | Admin API key, sent as an `x-api-key` header |
| Config keys | `identity.jumpcloud.apiKey`, `identity.jumpcloud.baseUrl` |
| Env | `JUMPCLOUD_API_KEY`, `JUMPCLOUD_BASE_URL` |
| Where | Admin portal, your own profile menu, API key. For a reporter key, create a separate administrator with a read-only role and take that admin's key. |

### The key has no scopes of its own

There is no scope grammar. One key inherits whatever its owner's admin role
allows. So "minimum permission set" here means the set of calls this toolkit
makes, and the useful split is read against write.

**A read-only administrator role is enough for the whole detection path**, and
that includes the device gate. This matters: the check that refuses to delete
an account while somebody still holds a laptop needs no write permission at
all.

| Read call | Needed for | Without it |
| --- | --- | --- |
| `GET /systemusers` | find an account by address, and prove the key can read the directory | no account resolves, so every leaver parks |
| `GET /systemusers/{id}` | read a stored account id back, and verify a suspension actually applied | a suspension cannot be confirmed, so it is never recorded as done |
| `GET /v2/users/{id}/systems` | list the machines a person can reach: first half of the device gate | the gate cannot see devices, and it fails closed |
| `GET /v2/systems/{id}/associations?targets=user` | tell custody from group-derived access: second half of the gate | group membership would read as custody and block every deletion |
| `GET /systems/{id}` | name a device in an alert, read its last contact and whether its recovery key is escrowed | alerts name object ids, and the encryption-key warning cannot be raised |
| `GET /commands` | resolve a configured trigger name to a command | a handover cannot find its command |
| `GET /commands/{id}` | read a command definition, to refuse one whose launch type cannot be triggered | a command that cannot fire would be treated as fired |
| `GET /v2/commands/{id}/associations?targets=system` | refuse a command that already holds device associations somebody else owns | a trigger would fire on machines you did not select |
| `GET /v2/commands/{id}/associations?targets=system_group` | refuse a command bound to a device group | a trigger fires on every group member, so one handover strips a fleet |
| `GET /commandresults` | find this run's own result row | no receipt, so a handover never confirms |
| `GET /commandresults/{id}` | read the exit code and full output | the list endpoint truncates output and misreports exit codes |

Writes, each one named by the armed action that needs it. Grant a writing key
and you can still arm nothing:

| Write call | Arms | Without it |
| --- | --- | --- |
| `PUT /systemusers/{id}` | `suspend` | the account is left alone and the leg records `not_armed` |
| `DELETE /systemusers/{id}` | `delete` | the account stays suspended |
| `POST /v2/systems/{id}/associations` | `device_unbind` | a leaver stays bound to their machine, so the deletion gate stays blocked |
| `POST /v2/commands/{id}/associations` | `device_handover` | no machine can be attached to the uninstall command |
| `POST /command/trigger/{name}` | `device_handover` | the uninstall script never runs |
| `DELETE /systems/{id}` | `device_handover` | the device record survives after the agents are gone |

### Two calls this toolkit deliberately never makes

Both answered HTTP 200 in the estate this came from, and both were real
defects. They are recorded in the code so the next person to read the
capability list is not the person who reintroduces them.

| Call | Why not |
| --- | --- |
| `PUT /commands/{id}` | a write carrying only some fields answers 200 and resets the rest to defaults, silently changing a command's type and launch mode and leaving it unfireable |
| `POST /command/trigger/{name}` with a `systems` array in the body | the target list in the body is ignored, so it reads as targeting while the command fires on every association it holds |

### Some organisations answer only on the console host

The default base URL is `https://console.jumpcloud.com/api`. In at least one
organisation the other documented host returns 404 for **every** request, on any
network, with a perfectly valid key. That failure reads exactly like a dead
credential or a network fault.

If every call 404s, change the host before you rotate anything.

### How `jml doctor` proves it

One `GET /systemusers` with a limit of 1, and the row names the host that
answered, so a host problem is visible in the pass line:

```
pass  identity provider   read the directory on https://console.jumpcloud.com/api
```

A 401 or 403:

```
FAIL  identity provider   the directory read answered 401 on https://console.jumpcloud.com/api
                          Check the API key. A key belonging to a deleted admin answers 401 on every path.
                          see docs/credentials.md#jumpcloud
```

Anything else, including a 404, points at the host rather than the key:

> Some organisations answer only on the console host. A 404 on every path is
> the host being wrong, not the key.

**Not checked by doctor in this release.** The connector carries
`probeKeyRole()`, which tells a writing key from a read-only one by addressing
an empty-bodied write at an id that cannot exist: a read-only key is refused
before the record is looked for, and a writing key is told there is nothing
there. It changes nothing even against a live record. It is not wired into the
doctor table, so doctor will not tell you your key cannot suspend. Call it
yourself, or discover it on your first armed run.

### Rotation

Create the new key, put the value where the reference points, restart, re-run
`jml doctor` and confirm the host in the pass line, then delete the old key.
Before you rename or delete the old item in your secret store, grep for any
consumer that looks it up **by title** rather than by id. A title reference
breaks at the rename, not at the rotation.

## Google Workspace

A GCP service account with domain-wide delegation. One key, six required
scopes, four different impersonation subjects.

| | |
| --- | --- |
| Credential type | Service account JSON key file |
| Config keys | `google.serviceAccountJson`, `google.adminEmail` |
| Env | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_ADMIN_EMAIL` |
| Usual form | `file:/run/secrets/google-sa.json` |
| Where the key comes from | GCP console, IAM and admin, service accounts, keys |
| Where delegation is granted | Google Admin, Security, Access and data control, API controls, Domain-wide delegation. Add the service account **client id** with each scope string exactly as written. |
| Also needed | the Admin SDK API enabled on the Cloud project holding the service account |

The service account needs no IAM role on the Cloud project. Its authority comes
entirely from the delegation entry in Google Admin.

### The subject matters as much as the scope

A delegated token is minted for a particular person. The same scope authorised
for the wrong subject fails in a way that reads like a missing grant. Four
subject kinds appear in the code:

| Subject | Resolves to | Config |
| --- | --- | --- |
| `admin` | the configured Google administrator | `google.adminEmail` |
| `leaver` | the person leaving; only their own token can change their own mailbox | per person |
| `sender` | the mailbox notifications are sent as | `mail.senderMailbox` |
| `self` | no subject at all: the service account acting as itself | see [below](#the-service-account-acting-as-itself) |

### The six required scopes

| Scope | Subject | Used by | What breaks without it |
| --- | --- | --- | --- |
| `https://www.googleapis.com/auth/admin.directory.user` | admin | `getUser`, `suspendUser`, `deleteUser`, `listUsers` | No Google account can be read, suspended or deleted, and a leaver keeps a working mailbox. |
| `https://www.googleapis.com/auth/admin.directory.user.readonly` | admin | `resolveRecipient`, `transferDrive` | The person the leaver files are handed to cannot be resolved, so the transfer has no recipient and the row parks. |
| `https://www.googleapis.com/auth/apps.licensing` | admin | `listLicences`, `revokeLicence` | Paid seats are never released, so a leaver is billed for indefinitely. |
| `https://www.googleapis.com/auth/admin.datatransfer` | admin | `transferDrive`, `getTransferStatus` | The leaver files are never handed over, and deleting the account destroys them. |
| `https://www.googleapis.com/auth/gmail.settings.basic` | **leaver** | `setVacationResponder` | No auto-reply is set, so mail sent to the leaver is accepted and then lost when the account goes. |
| `https://www.googleapis.com/auth/gmail.send` | **sender mailbox** | `sendMail` | No notification leaves the toolkit, so nobody is told what happened. |

Both `admin.directory.user` and its `.readonly` sibling are listed on purpose.
The recipient lookup and the transfer both read the directory, and a deployment
that never arms a Google write can hold the read-only one alone for those legs.

`admin.datatransfer` takes **user ids, not addresses**. The connector resolves
both ids first, which is why the transfer leg needs the directory read as well
as the transfer scope.

Nothing hard-codes an application id or a licence SKU. The Drive application id
is resolved from the applications list at run time, and the revoke path lists
what the account actually holds rather than assuming one edition, because an
account can hold more than one SKU and a hard-coded edition leaves the others
billing. Regression tests:
[`drive-transfer-hardcoded-application-id`](../test/regression/drive-transfer-hardcoded-application-id.test.ts),
[`licence-revoke-hardcoded-sku`](../test/regression/licence-revoke-hardcoded-sku.test.ts).

`google.customer` is pinned to the Admin SDK literal `my_customer` and is not
overridable. Listing by a single domain silently omits every account on a
secondary domain, and any organisation that has ever migrated has one.

### The Gmail coupling, and why it is the least portable part of this toolkit

Outbound mail is sent **as** `mail.senderMailbox`, with that mailbox as the
delegation subject.

Under domain-wide delegation Gmail ignores mailbox delegation for the sending
identity. Sharing a mailbox with the administrator, or making the administrator
a delegate of it, does not let the administrator's delegated token send as that
mailbox.

The automation this was ported from minted a token for the administrator and
then posted to a shared mailbox's send path. It worked, and it worked only
because that administrator effectively **was** that mailbox. On any other
tenancy the same configuration fails.

So: if the address in `mail.senderMailbox` is not a mailbox the service account
may impersonate, the send fails. Two fixes, and no third:

1. Make `mail.senderMailbox` a real mailbox the service account may impersonate.
2. Set `mail.senderMailbox` to the administrator's own address and accept that
   notifications come from a person.

A regression test pins the subject, because this is the single line most likely
to be "simplified" back to the administrator:
[`gmail-send-as-admin-not-mailbox`](../test/regression/gmail-send-as-admin-not-mailbox.test.ts).

The leaver auto-reply has the mirror-image constraint. It is a setting inside
the leaver's own mailbox, so only a token minted with the **leaver** as subject
can write it. Your delegation must therefore cover `gmail.settings.basic` for
ordinary staff, not merely for an administrator. This is exactly why
`probe-dwd-scopes.mjs` takes `--mailbox`.

### How `jml doctor` proves it

One row for the credential as a whole, then one row per required scope.

The credential row exchanges a token for the directory scope and then lists a
single account customer-wide, which separates three failures that look
identical from outside: the key does not sign, the delegation does not cover
the scope, or the subject is not a real administrator.

```
pass  google workspace   delegation works as the configured administrator; the tenancy
                         answered a customer-wide list (1 account read of the first page)
```

Real output from a run with a key that cannot sign:

```
FAIL  google workspace                       the token exchange for the directory scope answered 0 (Error)
                                             Check google.adminEmail is a real administrator mailbox and that the service account key is current.
                                             see docs/credentials.md#google-workspace
FAIL  google scope admin.directory.user      refused with Error
                                             No Google account can be read, suspended or deleted, and a leaver keeps a working mailbox. This scope is required: delegate it before arming anything.
                                             see docs/credentials.md#google-workspace
FAIL  google scope admin.directory.user.readonly  refused with Error
                                             The person the leaver files are handed to cannot be resolved, so the transfer has no recipient and the row parks. This scope is required: delegate it before arming anything.
                                             see docs/credentials.md#google-workspace
```

An `unauthorized_client` on the credential row gets a different remediation
from any other error, because it is the one failure that is fixed in Google
Admin rather than in GCP:

> Add the directory scope to the service account client id under domain-wide
> delegation, exactly as written in `src/connectors/google/scopes.ts`.

A delegated token that works while the directory read fails points at the
project rather than the grant:

> Confirm the Admin SDK API is enabled on the Cloud project holding the service
> account.

**One thing to expect.** Doctor probes all six scopes as required and fails a
row for any that is not delegated, whatever you have armed. A report-only
deployment that never intends to send mail will therefore show a failing
`gmail.send` row. That is deliberate: a step that cannot run must not look like
a step with nothing to do. Read the per-scope remediation and decide, rather
than expecting a clean table from a partial grant.

Doctor probes `gmail.settings.basic` with `google.adminEmail` as the subject.
Only the standalone tool takes `--mailbox`, so run that separately to prove
ordinary staff can be impersonated.

### Rotation

Create a new key on the same service account, point the reference at the new
file, restart, re-run doctor, then delete the old key in GCP.

The delegation entry is keyed on the service account's **client id**, not on the
key, so a new key for the same service account inherits the grant and needs no
change in Google Admin. The reverse also holds: a different key for a service
account whose client id has no delegation fails identically to a corrupt key.

Deleting the service account, or creating a replacement one, does mean a new
client id and a fresh delegation entry with all six scope strings retyped. A
mistyped scope there is indistinguishable from one that was never granted,
which is the whole reason the exact strings live in code and this page is
written from them.

## The service account acting as itself

The auth layer supports minting a token with **no** subject. In that mode the
service account reaches only resources shared directly with its own address,
which is how a spreadsheet or a calendar is read without asking an
administrator for a domain-wide grant.

Two scopes are declared for this mode:

| Scope | Subject | Declared for |
| --- | --- | --- |
| `https://www.googleapis.com/auth/spreadsheets.readonly` | self | reading a spreadsheet shared with the service account |
| `https://www.googleapis.com/auth/drive.readonly` | self | reading a file shared with the service account |

Both are marked `required: false`, and neither is probed by `jml doctor`.

Why the mode is worth knowing about: sharing one document with one address is a
grant you can see, revoke and audit from the document itself. A domain-wide
delegation for `spreadsheets` or `drive.readonly` is a grant over everything in
the tenancy, approved by somebody who may not be you, recorded on a console page
nobody visits. For reading one sheet, the resource share is both smaller and
easier to withdraw. In the estate this came from, neither account had
`drive.readonly` delegated at all, and the sheet-writing work was done by a
service account with the sheet shared to it as Editor.

**Be clear about what Phase 1 does with this.** No code path calls
`readSharedSpreadsheet` or `readSharedFile`. The two store adapters that would
need them, Notion and Sheets, ship as interfaces only in this release:
`store.adapter` accepts them in the schema and the runtime refuses them.

```
store.adapter is "sheets", which this release ships as an interface only.
Use the sqlite store, or the memory store for a rehearsal.
```

So do not create a Notion integration token or share a spreadsheet with a
service account for this toolkit yet. `NOTION_API_KEY`, `NOTION_PEOPLE_DB_ID`,
`PEOPLE_SHEET_ID` and `PEOPLE_SHEET_TAB` exist in `.env.example` for a later
phase. If you do set up a store share ahead of time, note that a write-capable
Sheets store needs the full `spreadsheets` scope, not `.readonly`, and that
these scopes are refused under delegation in practice, so the resource-share
pattern is the working one.

## Slack

Optional. `notify.adapters` defaults to `console`, which needs no credential
and prints to stdout.

| | |
| --- | --- |
| Credential type | Bot token (`xoxb`) |
| Config keys | `notify.slack.botToken`, `notify.slack.itChannelId` |
| Env | `SLACK_BOT_TOKEN`, `SLACK_JML_CHANNEL_ID` |
| Where | api.slack.com, your app, OAuth and Permissions, Bot Token Scopes. Then install the app and invite the bot to the channel. |

### Minimum scope set

| Scope | Needed for | Without it |
| --- | --- | --- |
| `chat:write` | posting the IT summary and any per-person notice | nothing is posted; the notifier reports the post as undelivered and the run is not ok |

That is the whole Phase 1 default. Two more are worth naming so nobody grants
them by habit:

| Scope | Only if | Note |
| --- | --- | --- |
| `users:read.email` | you want a manager looked up by address for a direct message | widens what a leaked token can enumerate |
| `reactions:write` | you want a checklist reaction | cosmetic |

`channels:read` and `groups:read` are deliberately **not** requested. The estate
this came from granted them with no confirmed caller, and widening conversation
reads on a bot that also holds `users:read.email` increases what a leaked token
exposes for no benefit here.

### A bot token is not a user token, and neither is a SCIM token

Three different Slack credentials, on three different screens, which is where
adopters lose an hour:

| Credential | Prefix | Created at | This toolkit |
| --- | --- | --- | --- |
| Bot token | `xoxb` | your app, OAuth and Permissions | **this is the one.** Posts notifications. |
| User token | `xoxp` | same screen, User Token Scopes | not used. A user token can do things a bot cannot, such as `usergroups:write`. Do not substitute it. |
| SCIM API token | separate | workspace admin, manage apps, API token. Needs a Workspace Owner, and Business+ or Enterprise Grid. | not used in Phase 1. Deactivating a Slack account goes through `/scim/v1/Users` with `PATCH {active:false}`, and that leg ships as an interface only. |

Setting `SLACK_SCIM_TOKEN` makes start-up **refuse**. A credential present for a
step that cannot run reads as coverage that does not exist. Same for
`AZURE_CLIENT_SECRET`.

### Slack answers HTTP 200 with the failure in the body

A post counts as delivered only on a 2xx **and** `ok === true`. Anything else is
reported as undelivered, with the body's own error string, and the run is not
ok.

This is not defensive coding for its own sake. In the estate this came from,
three workflows posted nothing for weeks while every execution was recorded as
a success, because the transport status was checked and `ok` in the body was
not. Regression test:
[`slack-ok-false`](../test/regression/slack-ok-false.test.ts).

### Channel membership is per bot

A bot that is not in a private channel gets `channel_not_found`, which looks
exactly like a mistyped channel id. Another bot posting in that channel proves
nothing about yours.

### How `jml doctor` proves it

By default, `auth.test` only, and the row says plainly what it did not check:

```
pass  notifications   the bot token is valid; channel membership is NOT checked,
                      because proving it needs a write. Re-run with the write probe
                      enabled to check it
```

`jml doctor --probe-writes` adds a membership probe: schedule a message five
minutes ahead, then delete it. Nothing visible is posted.

```
pass  notifications   the bot token is valid and this bot can post to ${SLACK_JML_CHANNEL_ID}
```

On `channel_not_found` the remediation says which reading is right:

> invite THIS bot to the channel. Membership is per bot, so another bot posting
> there proves nothing, and a private channel the bot is not in reports the same
> error as a wrong id

A rejected token gets a different remediation, and it is the one that catches a
substituted credential:

> check the token is the bot token (it is issued under OAuth and Permissions,
> and is not the user token or the SCIM token) and that the app is still
> installed

### Rotation

Rotating a bot token means reinstalling the app, which issues a new `xoxb` and
invalidates the old one. The bot keeps its channel memberships. Put the new
value where the reference points, restart, and re-run `jml doctor
--probe-writes` so the channel row is actually exercised.

## The audit sink

The local append-only JSONL log is the record and needs no credential. It is
hash-chained, and `jml audit verify` names the first line that does not check
out.

An optional second sink pushes the same rows to a log aggregator.

| | |
| --- | --- |
| Credential type | Bearer token |
| Config keys | `audit.loki.enabled`, `audit.loki.url`, `audit.loki.authHeader` |
| Env | `AUDIT_LOKI_ENABLED`, `LOKI_PUSH_URL`, `LOKI_AUTH_HEADER` |

Despite the name, `LOKI_AUTH_HEADER` holds the **token only**. The sink
composes `Authorization: Bearer <value>` itself. Do not include the word
`Bearer` in the value.

Leaving it unset pushes unauthenticated. That is allowed, and it has to be an
explicit choice rather than a default, because an audit row names a person,
their address and their manager. The original pushed unauthenticated on the
grounds that the collector was only reachable on a private network. That is a
deployment assumption which ages badly and cannot be checked from inside the
process.

Two behaviours worth knowing:

- The local file is always primary. A remote sink that went first could hold a
  row for a step the local write then refused, which is worse than a missing
  row: it is a false record.
- This sink throws on failure. The fanout counts a secondary failure as a
  warning rather than aborting the run. The original swallowed every failure in
  an empty catch, so a broken audit push was invisible for as long as it lasted.

**Not probed by doctor.** The `audit chain` row covers the local directory and
the hash chain only:

```
pass  audit chain   ./audit: 0 rows, chain intact
```

A wrong token or unreachable collector surfaces as a run warning, not as a
doctor failure.

An unwritable audit directory is a different matter. `jml serve` refuses to
start:

> refusing to serve: a step whose intent cannot be recorded must not run, so
> the sidecar does not start without a writable audit log.

Regression test:
[`serve-starts-with-an-unwritable-audit-log`](../test/regression/serve-starts-with-an-unwritable-audit-log.test.ts).

### The audit salt

| | |
| --- | --- |
| Config key | `audit.salt` (`JML_AUDIT_SALT`) |
| Required when | `audit.minimisePii` is true, which is the default |

Addresses are stored as a salted hash, because an audit log is kept for years
and does not need to be a staff directory. `jml init` writes a random 32-byte
value.

Treat this as a credential, and understand what rotating it costs: rows written
under the old salt hash differently from rows written under the new one, so the
same person no longer joins across the change. Rotate only deliberately.

This flag was once true in every shipped configuration and did nothing, because
the sink was built without the salt and fell back to storing addresses in
clear, permanently, in an append-only file. Regression test:
[`audit-log-keeps-addresses-in-clear`](../test/regression/audit-log-keeps-addresses-in-clear.test.ts).

## The liveness ping URL

| | |
| --- | --- |
| Credential type | A per-check ping URL. The URL **is** the credential. |
| Config key | `liveness.healthchecksPingUrl` (`HC_PING_JML`) |
| Optional | yes; null disables the ping |

Held as a secret reference for that reason, used inside `use()`, and only the
resulting status is recorded. It never reaches a log line or an error message.

Two behaviours that make the dead-man mean something:

- Pinged last, and only after a notification is proven delivered. A dead-man
  pinged whatever happened proves the process ran. One pinged after delivery
  proves the alerting path works too, which is the part that has failed
  silently before.
- Never pinged on an abort, and never in dry run. A dead-man fed by a refusing
  run is worse than none.

Not probed by doctor. A failed ping is a run warning naming the status.

Rotation is whatever your checks service calls creating a new check. The old URL
stops being fed, so watch for the old check going red after you switch.

## The sidecar bearer token

| | |
| --- | --- |
| Credential type | Random bearer token, generated locally |
| Config keys | `server.token`, `server.bind` |
| Env | `JML_API_TOKEN`, `JML_SERVER_BIND` |
| Where | `jml init` writes 32 random bytes as 64 hex characters |

This is the only secret the automation tool holds. In n8n it is one Header Auth
credential named `JML Toolkit API`, carrying `Authorization` = `Bearer
<JML_API_TOKEN>`. No vendor credential goes anywhere near n8n: the identity
provider key, the Google service account and the HR token all live inside the
sidecar container, which is the point of the split.

Three properties of the check:

- Compared in constant time over fixed-length digests. A plain string
  comparison leaks the length of the matching prefix through timing, and a
  comparison over raw bytes throws on a length mismatch, which leaks the
  length. Both sides are hashed first so every comparison has the same shape.
- Under 32 characters and the server refuses to start: "a guessable token on
  this service is a way to delete accounts."
- The shipped compose file does not publish the port. The service is reachable
  by name on the private network and nowhere else, so the token is the second
  line of defence rather than the only one.

Doctor lists it as a resolved reference and a length, never a value, and does
not authenticate against a running server:

```
pass  credential server.token   resolved from env:JML_API_TOKEN, 64 characters
```

### Rotation

Generate 32 random bytes, put them where the reference points, restart the
sidecar, and update the one Header Auth credential in your automation tool.
Both ends change together, so expect a brief window where scheduled calls get
401. Nothing retries a 401, by design: retrying a credential refusal turns a
clear failure into a slow one that still does nothing.

## Least privilege per module

Nothing is armed by default. `mode` is `dry-run` and `armedActions` is empty, so
a first run plans and reports without touching a provider, and an action absent
from `armedActions` records `not_armed` rather than running.

That makes it worth granting narrowly and arming one action at a time. This
table says what each armed action costs in permission:

| Armed action | Additional permission | Grant it only when |
| --- | --- | --- |
| *(none: detection and reporting)* | HR People read; JumpCloud **read-only** role; Google `admin.directory.user.readonly` | always. This is the report-only deployment, and the device gate works at this level. |
| `suspend` | JumpCloud `PUT /systemusers/{id}` (administrator role) | you want the identity account closed on the leaving date |
| `autoreply` | Google `gmail.settings.basic`, delegated for **ordinary mailboxes** | you want mail to the leaver answered rather than accepted and lost |
| `licence` | Google `apps.licensing` | you want paid seats released. Set `leaver.revokeLicences` to a SKU list to narrow what is touched. |
| `transfer` | Google `admin.datatransfer` plus the directory read | you want files handed over. Required before deletion unless you turn `leaver.requireTransferBeforeDelete` off, which you should not. |
| `google_suspend` | Google `admin.directory.user` | you want the mailbox closed as well as the identity account |
| `delete` | Google `admin.directory.user` and JumpCloud `DELETE /systemusers/{id}` | you have watched suspensions and transfers work for a while. Set `leaver.deleteGoogleUser: false` to stop at suspension so a mailbox can be archived by hand. |
| `device_unbind` | JumpCloud `POST /v2/systems/{id}/associations` | you want a returned machine detached, or rebound to a spares account |
| `device_handover` | JumpCloud command associations, `POST /command/trigger/{name}`, `DELETE /systems/{id}` | **you have canaried the uninstall script on a machine you own.** The scripts have never run on real hardware. |
| notifications by mail | Google `gmail.send` for the sender mailbox | you want email rather than console output |
| notifications by chat | Slack bot token with `chat:write` | you want a channel post |

## What each credential can do if it leaks

Judge the blast radius yourself rather than taking a reassurance.

| Credential | What the holder can do | Mitigation in the code |
| --- | --- | --- |
| HR service user | Read your entire staff directory, current and former: names, work addresses, departments, sites, managers, start and leaving dates. | Read only, so nothing in your HR system can be changed with it. No leave data is reachable at this permission level. |
| JumpCloud key, read-only role | Enumerate every account and every machine, including last contact and whether a recovery key is escrowed. | Cannot change anything. |
| JumpCloud key, administrator role | **Suspend and delete any account, unbind any user from any machine, delete device records, and fire any existing command on any machine.** The worst credential in this list. | Nothing in the code limits it; the key inherits the role. Use a dedicated administrator, not a person's key, and keep the role no wider than the writes above. |
| Google service account key with the six scopes | Read, suspend and delete any Google account; revoke any licence; start a Drive transfer from anyone to anyone; set an auto-reply on any mailbox; send mail as the configured sender mailbox. | Delegation is per scope, so a narrower grant genuinely narrows the leak. Deleting the key in GCP revokes it immediately without touching the delegation entry. |
| Slack bot token | Post as the bot in every channel it has been invited to. Nothing else, at `chat:write` alone. | Membership is per bot, so the reach is the channels you invited it to. Reinstalling the app invalidates it. |
| Audit push token | Write rows into your log aggregator. Reach depends on the collector. | The local file is primary, so a stolen push token cannot alter the record. |
| Audit salt | Confirm whether a guessed address appears in the log, by hashing it and looking. | Hashing is a barrier to bulk reading, not to a targeted guess. Protect the log file as well as the salt. |
| Liveness ping URL | Feed your dead-man, so a failure stays silent. | Nothing else. This is why the URL is a secret and not a config value. |
| Sidecar bearer token | Everything the sidecar exposes, which includes suspending and deleting accounts and disposing of devices, subject to `armedActions`. | Requires network reach: the shipped compose file does not publish the port. Minimum 32 characters, enforced at start-up. |

## Rotating anything: the general shape

1. Create the new credential alongside the old one.
2. Put the new value where the reference already points, or point the reference
   at a new stable id.
3. Restart the sidecar. Every reference resolves once at start-up, so nothing
   caches a credential past a restart.
4. Re-run `jml doctor`, and `jml doctor --probe-writes` if Slack is in use.
5. Only then revoke the old credential.
6. Before renaming or deleting the old item in your secret store, grep every
   consumer for a lookup **by title**. That reference breaks at the rename, and
   it breaks at the next unattended run rather than in front of you.

## What `jml doctor` does not check

Named here so a clean table is not read as more than it is.

| Not checked | Consequence |
| --- | --- |
| Whether the JumpCloud key can write | An armed run is the first thing that finds out. `probeKeyRole()` exists on the connector and is not wired in. |
| Whether ordinary mailboxes can be impersonated | Doctor probes `gmail.settings.basic` as the administrator. Run `tools/probe-dwd-scopes.mjs --mailbox` for the real answer. |
| Whether the sender mailbox can actually send | The scope probe proves the grant, not the send. See [the Gmail coupling](#the-gmail-coupling-and-why-it-is-the-least-portable-part-of-this-toolkit). |
| Slack channel membership, by default | Passes on `auth.test` alone unless you pass `--probe-writes`. The row says so. |
| The audit push credential | Surfaces as a run warning. |
| The liveness ping URL | Surfaces as a run warning. |
| The sidecar token against a live listener | Only presence and length are reported. |

Two things doctor does check that are easy to overlook, and both were added
because their absence was silent.

It reports the age of the **oldest parked row**, whether or not anybody asked.
Parking a person is how this toolkit refuses to guess, and it is silent by
design: a parked row takes no action and raises nothing after the first notice.
Over-suppression therefore looks exactly like a quiet week.

```
pass  parked rows   nothing is parked
```

And it refuses to serve if the tombstone count has fallen since the last run.
Tombstones are what stop a historic leaver being offboarded again. A migration
once pruned those rows and every historic leaver read as a fresh departure.
Regression tests:
[`tombstones-pruned-refire`](../test/regression/tombstones-pruned-refire.test.ts),
[`tombstone-count-drop-aborts`](../test/regression/tombstone-count-drop-aborts.test.ts).
