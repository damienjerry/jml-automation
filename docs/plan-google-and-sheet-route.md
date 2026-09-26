# A possible extension: a complete route on Google Workspace and a people spreadsheet

**Not planned work, and not a commitment.** v1.0.0 does not include any of
this. It is written down so that anybody who wants the route can build it in
their own copy, in an order that works, with the design questions already
named. The sizes are estimates for whoever takes it on.

## The target

One small IT team, on Google Workspace, with no identity provider and no HR
system, keeps a list of people in a Google Sheet (or exports a CSV). The
toolkit reads that list every morning and, on its own:

- **creates** a starter's Google account, licenses it, puts it in the right
  organisational unit and groups, and sends the first sign-in details;
- **moves** a person between department groups when their department changes,
  removing the old groups as well as adding the new ones;
- **offboards** a leaver: closes the account, signs it out, hands the files
  over, and keeps or deletes the account as the policy says;
- tells IT, per person, what it did, how it confirmed it, and what is left to
  do by hand.

The existing HiBob and JumpCloud route keeps working unchanged. This adds a
second complete route; it does not replace the first.

**Out of scope, on purpose:** approvals, access exceptions with expiry, a web
interface, separate contractor policies, Microsoft 365. They belong on a
roadmap page, not in this work.

## Order, and why

1. **Google-only route.** Everything else needs Google to be the identity when
   there is no JumpCloud.
2. **Account creation.** A spreadsheet creates nothing upstream, so without this
   there is no joiner path at all.
3. **Spreadsheet or CSV as the HR source.** The input that makes 1 and 2 usable
   for somebody without an HR system.
4. **Department groups, and movers.** The first real access change.
5. **Small safety pieces** that the above make urgent: protected accounts, a
   pilot list, a stale-input check, and a per-person summary.
6. **Proof on a real tenant**, with disposable accounts.

## 0. A spike first, on a disposable account

Three Google behaviours decide the design of step 1, and none should be taken
on trust:

| Question | Why it matters |
| --- | --- |
| Can the Data Transfer API move Drive files out of a **suspended** account? | If yes, a Google-only day 0 can suspend the account outright. If no, day 0 has to close the door another way and suspend only after the day-6 hand-over, as the JumpCloud route does today |
| Does setting a random password plus `changePasswordAtNextLogin` and a sign-out stop every sign-in route for a non-SSO account? | This is the fallback door-close if suspension blocks the transfer |
| What does the Directory API return for a user who has never signed in (`lastLoginTime`, `agreedToTerms`)? | The joiner's "never touch an account somebody is already using" rule needs a Google equivalent of JumpCloud's `activated` |

Needs: one throwaway Google Workspace tenant or a test organisational unit that
holds no real people.

Size: half a day.

## 1. Google-only route: JumpCloud becomes optional

The connector interfaces already separate identity, devices and Google, so this
is mostly wiring rather than new engine logic.

- `identity.adapter: jumpcloud | none`. With `none`:
  - no JumpCloud credential is read, and `jml doctor` does not probe it;
  - the identity legs (`suspend_idp`, `delete_idp`) are not scheduled, rather
    than recorded as failed;
  - **what closes the door on day 0 moves to Google.** Either `suspend_google`
    moves to day 0, or a new `close_google` leg (random password, sign-out,
    revoke grants) does it, depending on the spike. Day 0 still refuses to write
    its marker until the door-close is verified;
  - joiner activation sets the temporary password on the Google account
    (password plus `changePasswordAtNextLogin`), and "already in use" reads
    Google's own sign-in record.
- `devices.adapter: none`, stated explicitly. Today the device gate fails
  closed, which is correct, but with no device inventory it would block every
  deletion for ever. `none` opens the gate and prints on every deletion that no
  device inventory was checked. It is never inferred from an empty read.
- The person row's stored id becomes provider-neutral (`googleUserId` already
  exists; `jumpcloudUserId` becomes optional), with a store migration.
- Config validation: `identity: none` with a JumpCloud-only action armed is an
  error.
- `jml setup`, `jml init`, the demo, doctor, and a second worked example config.

Size: the largest step. About 1,200 lines including tests. Two to three days.

## 2. Account creation

- `joiner.createAccounts: true` (Google-only route; the JumpCloud route keeps
  upstream creation).
- The address comes from a configured pattern, for example
  `{first}.{last}@domain`, normalised (accents, spaces, apostrophes).
- **It never overwrites.** If the address is taken by somebody else, the row
  parks and names the clash; it does not add a number and carry on.
- **It never creates twice.** The HR id is written to the Google user's
  `externalIds` at creation, and every run looks the person up by that id
  before creating. An interrupted run that created the account and crashed
  before recording it finds the account next time rather than making another.
- Created a few working days before the start date (the existing activation
  window), then the existing licence, org unit, password and welcome legs run.
- New armed action `create_account`, and scope `admin.directory.user` (already
  held).
- For the JumpCloud route: the joiner report says plainly when the upstream
  account has not appeared by the activation date, instead of doing nothing.

Size: about 700 lines including tests. Two days.

## 3. A spreadsheet or CSV as the HR source

Two adapters behind the existing HR interface (one snapshot read):

- `hris.adapter: sheet`: reads a Google Sheet shared with the service account,
  using the read-only Sheets scope the toolkit already declares. The sheet is
  only ever read, so a person maintains it and nothing has to be exported.
- `hris.adapter: csv`: reads a file, for anybody exporting from an HR system.

Both:

- a column map in config (id, first name, last name, work email if known,
  personal email, department, manager email, start date, leaving date);
- a shipped template sheet and example CSV;
- who is employed is derived from the dates, by the same rules as the HiBob
  adapter: started, and no leaving date that has passed;
- **validation refuses the whole read**, naming row numbers, on a missing
  column, a duplicate id, an unparseable date, or a leaving date before a start
  date. A partial read is never used, because an absent row is exactly what
  makes somebody a leaver;
- the existing plausibility floor and circuit breaker apply unchanged;
- **stale input is refused**: a CSV older than `hris.maxAgeHours`, or a sheet
  whose last edit is older than that, when configured.

Size: about 600 lines including tests. One to two days.

## 4. Department groups, and movers

- `access.groups`: groups everybody gets, and groups per department. **The
  toolkit only ever touches groups named in this map.** Membership of any other
  group is somebody else's, and is never removed.
- Joiner: added to their groups after the account exists.
- Mover: the sync already records department. A change produces a plan (these
  groups removed, these added), shown by `jml run` without `--armed` before anything happens,
  then applied. Removal is the point of the step, not an extra.
- Leaver: removed from the mapped groups on day 0, so a kept account (under
  `leaver.deletion: never`) does not keep receiving group mail.
- New armed actions `groups_add` and `groups_remove`, armed separately; scope
  `admin.directory.group.member`.
- Read back after every change, as every other leg does.

Size: about 900 lines including tests. Two to three days.

## 5. Small safety pieces

- `protectedAccounts`: addresses no leg may change, checked in every leg, for
  break-glass admins and service accounts.
- `pilot`: when set, only these people are acted on; everybody else is
  planned and reported. The limited-rollout control.
- A per-person summary, `jml show <person>` and in each notification: what is
  due, what was done and how it was confirmed, what is left to do by hand
  (from the owner register and access-removal list), and the deletion policy in
  force. "Run succeeded" is not enough when part of the work is outside the
  tool.

Size: about 500 lines including tests. One to two days.

## 6. Proof on a real tenant

On the disposable tenant from step 0, with invented people, recorded in a
validation table in [operating.md](operating.md):

- create a starter from the sheet, license, group, sign in with the temporary
  password;
- change their department, and confirm the old group is gone;
- offboard: door closed and every sign-in route tried, files handed over, kept
  or deleted per policy;
- a failed step retried; a run interrupted halfway and resumed; a restore from
  backup; a missed schedule detected.

Also, separately: `./install.sh` end to end on a Mac with Docker.

Size: one to two days, once the tenant exists.

## Totals

Roughly 4,000 lines including tests, and about two working weeks. Steps 1 and 2
touch shared code, so each lands as its own reviewed change with the full gate
green, and an outside review after steps 2, 4 and 6 is worth having.

## Questions whoever builds it has to answer

1. The disposable tenant for step 0 and step 6: a Google Workspace trial, or a
   test organisational unit somewhere.
2. The address pattern default for created accounts (`first.last` is the
   proposal).
3. Whether the Google-only route suspends on day 0 if the spike shows transfers
   work from a suspended account. Proposal: yes, because it is the simplest door
   that is readable back.
