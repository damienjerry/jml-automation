# Owner notifications

Only when `ownerNotifications.enabled` is true.

## Setting it up

1. Export your platform register as CSV with a header row: a platform name
   column, an owner address column (several addresses may share a cell), and a
   column saying how offboarding is handled. Rows marked `Retired` are skipped.
2. Point `ownerNotifications.register.path` at it and set the column headers
   if yours differ.
3. Set `ownerNotifications.goLiveDate` to today. Nobody who left before it is
   ever notified. This is what stops the first run telling every owner about
   every leaver in your history.
4. Run `jml run` in dry-run and read the plan: it names every owner and the
   platforms each would hear about.

## What owners receive

One message per leaver, the day after the leaving date, listing only the
platforms that owner owns. It says IT does not administer those platforms and
will not follow up, so the owner knows the action is theirs.

## When a message was not delivered

The run reports it as a warning and records nothing for that owner, so the next
run tries again. `jml leaver show` prints `ownersNotified` with a date per
address that has been told.

## When the run refuses

`the register returned no owner addresses at all` means the file was read and
held no owners: an empty export, the wrong path, or the wrong column headers.
Nothing was sent. Fix the file and run again.
