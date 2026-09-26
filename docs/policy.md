# Decide your leaver policy before you arm anything

The day-0, day-6 and day-7 sequence is one organisation's process. It is a good
default, and it is still a default. These are the questions it answers on your
behalf unless you answer them first. Each row says what the toolkit does today,
the setting that changes it where one exists, and where there is no setting.

Write your answers down. An AI assistant adapting this for you should be given
them, not left to infer them.

## The questions

| Question | What happens today | Setting |
| --- | --- | --- |
| Do we delete accounts at all? | Yes, on day 7, once every gate opens | `leaver.deletion: never` keeps both accounts after suspension and hand-over. Day 7 is not scheduled, and the report counts the retained leavers. Close a row with `jml leaver tombstone` when you have dealt with the accounts yourself |
| Should a person approve each deletion? | No | `leaver.requireOperatorAck: true`. Nothing is deleted until somebody runs `jml leaver ack` for that person |
| Keep the mailbox for archiving? | The Google account is deleted with the identity account | `leaver.deleteGoogleUser: false` stops the Google account at suspension. There is no archive-user step |
| How long between leaving and deletion? | Hand-over day 6, deletion day 7, counted from the day-0 run | `leaver.transferDay`, `leaver.deleteDay` |
| Who gets the files? | The manager address on the person's row, as the HR system reported it | `google.driveTransfer.fallbackRecipient` when no manager is recorded. Null, the default, parks the row for a person to decide |
| What if the manager has also left? | **Not checked.** The recorded address is used as it is. A deleted manager account makes the transfer fail and the row park after repeated failures. A manager who is suspended but not deleted can receive the files | none. Check the manager before arming `transfer` if your HR data lags |
| An immediate exit, at a set time? | No time of day. Day 0 is the first run after the HR system stops listing the person as employed | For now: update the HR system, then `jml sync --armed` and `jml leaver run --hris-id <id> --armed` by hand |
| A departure cancelled before day 0? | The HR system lists them as employed again, so nothing happens | none needed |
| A departure cancelled after day 0? | The row is frozen automatically and a person decides. Nothing is unsuspended | `jml leaver release` after you have restored access by hand. See [runbooks/incident-recovery.md](runbooks/incident-recovery.md) |
| A rehire? | A finished leaver's record is terminal and cannot be reopened. The sync warns that a tombstoned person is employed again | give them a new HR record |
| Contractors, drivers, anybody IT does not provision for? | Everybody the HR system lists is in scope | `hris.hibob.fields.scopeField` and `scopeInValues` name the HR field that says whether IT provisions for a person. HiBob adapter only; for a file export, leave those people out of the file |
| Accounts that must never be touched (break-glass admins, service accounts)? | **No protected list.** An account is only acted on if its address or id is on a leaver's row, and never while a person who still works here holds it | none. Keep such accounts out of the HR system, and check `jml leaver dry-run` output |
| What if the HR data is stale? | A live HR read is fresh by definition. A file export is not: **its age is not checked** | none for files. Re-export before each run, or schedule the export |
| What if the HR data is wrong? | A read below `hris.minPlausibleHeadcount` people is refused. More day-0 leavers in one run than `leaver.maxDay0PerRun` stops the whole run | both settings |
| A legal or retention hold? | Not known to this toolkit | see below |

## A toolkit hold is not a legal hold

`jml leaver hold` freezes one row against this toolkit. It tells nothing to
Google, JumpCloud or anything else, and it does not preserve data.

Deleting a Google user can remove retention protection and make their data
unrecoverable. A completed Drive transfer moves files the person owned. It is
not proof that their mail, chats, or files shared with them have been kept.
If you have a retention duty, or a person is under a legal hold, set
`leaver.deletion: never`, or hold that person, and preserve their data in the
provider's own retention tool first. Google's guidance on what deletion removes
is in the Workspace Admin Help, under deleting a user.

## Deletion is a separate decision

Nothing about installing this toolkit commits you to automatic deletion. A
sound first year is:

1. arm `suspend`, `autoreply` and `licence`, and watch;
2. arm `transfer` and `google_suspend`;
3. then decide between `leaver.deletion: never`, `leaver.requireOperatorAck: true`,
   or arming `delete`.

Without one of those three, a leaver who reaches the deletion day with `delete`
unarmed turns every armed run red until you choose. That is deliberate while
you are still arming in stages. It is not a way to run for good.
