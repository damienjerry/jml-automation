# Activate a starter

When somebody is joining and their accounts need to work on their first morning.

## What happens without you

If `joiner.gate` is `none`, nothing here is needed. Three working days before
the start date the pipeline activates the staged identity account, licenses the
Google account, waits for the mailbox, moves the account and sends the
messages. The run summary names who was activated and who was held.

## See the plan first

```bash
jml joiner dry-run --email jane.doe@example.com
```

Prints every leg with `pending`, the recipients the temporary password would go
to, and any address that would be withheld and why. Nothing is written.

## Open the gate

Only when `joiner.gate` is `manual` or `ticket`:

```bash
jml joiner approve --email jane.doe@example.com --actor you@example.com --note "form received"
```

The next run activates them. `jml joiner show --email ...` prints the gate and
every marker.

## Run one person now

```bash
jml joiner run --email jane.doe@example.com --armed
```

Each leg still needs its action in `armedActions`: `activate`, `joiner_licence`,
`ou_move`, `welcome`. An unarmed leg records `not_armed` and the run says so.

## When it refuses

`refused: the identity account is already in use` means somebody has set that
account's password or enrolled MFA. The toolkit never resets a working account.
Two possibilities: the person was activated by hand, or the HR record is matched
to the wrong account. Check the address on the account against the HR record
before doing anything. Once you are sure:

```bash
jml joiner approve --email jane.doe@example.com --reset-refusal --actor you@example.com
```

## When the welcome is withheld

`welcome email withheld from the work address: the mailbox is not ready` means
the licence went on but Workspace had not finished building the mailbox inside
`joiner.mailboxPoll`. The personal address got the welcome and IT got a note.
The account is activated; re-run `jml joiner run --email ...` later to send the
work-address copy, or forward it by hand.

## When the password is withheld

`temporary password withheld from the personal address` (or the manager) means
the address failed validation: a company address in the personal slot, or a
name where an address belongs. The IT mailbox always gets a copy. Fix the HR
record, or forward the copy.
