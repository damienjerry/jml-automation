# What "access removed" means, and what it does not

Suspending somebody's identity provider account stops new sign-ins through that
provider. It does not end every way a person can reach your systems. This page
lists each route, what the toolkit does about it, when, whether the result is
read back, and what stays your job.

Read it before you tell anybody that a leaver "has no access". The honest
sentence after a day-0 run is narrower: their identity provider sign-in is
suspended and confirmed, their mailbox answers with an auto-reply, and their
paid Google licence is removed.

## The routes, one at a time

This is the reference stack (JumpCloud and Google Workspace). The days are the
defaults, counted from the day-0 run.

| Route | What the toolkit does | When | Read back? | Still your job |
| --- | --- | --- | --- | --- |
| New sign-ins to the identity provider | Suspends the account | day 0 | yes | nothing |
| New sign-ins to apps federated through the identity provider (SSO) | Nothing directly. They fail because the identity provider refuses the sign-in | day 0 | no | an app's own session can outlive the suspension until it expires; end it in the app if it matters |
| The Google mailbox, receiving | Sets an auto-reply | day 0 | yes | mail still arrives until day 6 |
| The Google account, signing in | Removes the paid licence on day 0, suspends the account on day 6 | day 0, day 6 | yes | see below: the account is not suspended for six days |
| Gmail, Drive, Calendar and the other Workspace services | Removing the licence takes them away. This is effectively a soft disable: the account still exists, so its files can still be handed over | day 0 | the licence removal is read back | nothing |
| "Sign in with Google" into other apps, and access already granted to third-party apps | With `google_signout` armed: ends every Google session and revokes every third-party app grant. Not armed: nothing, and the still-active account works as an identity until day 6 | day 0 | the grants yes, by a fresh list that must come back empty; the sessions no, Google has no way to read them | arm it, or sign the user out by hand in the Google Admin console |
| Files the person owns in Drive | Transfers ownership to the manager | day 6 | yes, the transfer is polled until complete | shared drives, files shared *with* them and calendar delegation are not moved |
| Laptops bound to the account | Nothing on day 0. Deletion is refused while a machine is still bound | day 7 | yes, the gate reads the provider live | whether a suspended account can still unlock a bound machine depends on the agent and when it last checked in. Check it on your own devices |
| Group memberships, shared mailboxes, delegated access | Nothing | not covered | no | remove by hand, or through whatever manages your groups |
| Apps with their own logins (not through SSO) | Tells each owner from the app register, once, the day after the leaving date. Can raise a leaver ticket | day +1 | no | the owner removes the account |
| Personal API tokens, SSH keys, VPN profiles, shared passwords | Nothing | not covered | no | yours |
| Microsoft 365, Entra ID, Slack SCIM | Nothing. The interfaces exist and are not implemented; start-up refuses a credential for them | not covered | no | yours |

### The six days before the Google account is suspended

The day-0 run removes the licence and leaves the account active; the account is
suspended on day 6, after the files are handed over. Without a licence the
Workspace services stop, so the mailbox and Drive are out of reach from day 0.

What the account can still do in those six days is be an identity. Any other
app the person signed in to with "Sign in with Google" still accepts them, and
any access they granted a third-party app still works. If Google sign-in goes
through your identity provider, new sign-ins to Google itself already fail on
day 0; a session that was open before does not.

Arming `google_signout` closes this on day 0: it ends every session and revokes
every grant, then lists the grants again and counts the step done only when
none are left. It needs one more delegated scope,
`admin.directory.user.security`, which `jml doctor` checks once the action is
armed. Sessions cannot be read back from Google, so that half is reported as
requested rather than confirmed.

## Setup 1.0b: Google Workspace with no identity provider

The routes are the same, but what closes the door on day 0 is different:

| Route | What the toolkit does | When | Read back? | Still your job |
| --- | --- | --- | --- | --- |
| Signing in to Google with the password | Replaces it with a random one nobody holds, and requires a change at next sign-in | day 0 | the forced change reads back; the password itself cannot be read | nothing |
| Signing in to Google with a **passkey**, without a password | **Nothing.** If your Admin console lets users skip the password with a passkey, a person with a passkey can still sign in after the password is replaced, until the account is suspended on day 6 | not covered | no | turn off skipping passwords with passkeys in the Admin console, or remove the leaver's passkeys by hand on day 0. Not tested against a real tenant |
| Sessions already open | Ends every session | day 0 | no, Google cannot confirm it | nothing |
| Sign in with Google into other apps, third-party grants, app passwords | With `google_signout` armed: revokes every grant and app password | day 0 | yes, a fresh list must come back empty | arm it |
| The Google account itself | Suspended after the hand-over, then kept or deleted by the policy | day 6, day 7 | yes | nothing |
| Laptops | **Nothing.** There is no device inventory, and every deletion says so | not covered | no | recover the laptop, and remove the person from it, by hand |
| Sign-in through another identity provider (SSO) | **Nothing.** If Google sign-in goes through Okta, Entra ID or anything else, the Google password is not what lets the person in | not covered | no | close that account on day 0 yourself, or this setup is not closing the door |

**So in 1.0b, day 0 closes password sign-in and open sessions, and nothing
more.** Three routes stay open until the account is suspended on day 6, and each
needs checking once, in the Admin console, before you rely on this setup:

- **Passkeys.** Google Workspace can let a user sign in with a passkey and no
  password. Where that is allowed, replacing the password does not stop them.
- **Recovery.** A recovery phone or address that can reset the password lets
  the person set a new one.
- **Another identity provider.** If Google sign-in goes through SSO, the Google
  password is not what lets them in at all.

A second factor on its own does not let them back in: with the password
replaced, a known second factor is not enough. None of this has been tested
against a real tenant; it is what Google documents, and what to check.

## How to read the run report against this

Each step in the report ends in one of these states:

| In the report | Means |
| --- | --- |
| `done(verified)` | the change was made and a fresh read of the provider confirmed it |
| `done` without `verified` | the provider accepted the request and the read-back did not confirm it. Treat it as not done |
| `already_absent` | it was already in that state, for example already suspended |
| `not_armed` | the step exists and your configuration did not switch it on, so nothing was changed |
| `not_applicable` | nothing to do for this person, for example no Google account |
| `failed` | it did not happen; the row is retried and parked after `leaver.maxAttemptsPerLeg` failures |

Anything in the "not covered" rows above never appears in the report at all.
That is the point of this page: silence in the report about a route means the
toolkit does not look at it, not that the route is closed.

## For a different stack

If you replace JumpCloud or Google, rewrite this table for your platforms before
you go live. For Microsoft 365 the rows are different in kind, not only in name:
session and refresh-token revocation, mailbox retention or conversion to a shared
mailbox, OneDrive access for the manager, licence removal and deletion are
separate decisions there. See [adapting.md](adapting.md#microsoft-365-instead-of-google-workspace).
