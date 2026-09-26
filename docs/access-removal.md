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
| Existing Google sessions, mobile sync, app passwords, third-party app grants | **Nothing.** The toolkit does not sign the account out or revoke tokens | not covered | no | if you need them gone on day 0, use the Google Admin console: sign the user out and reset their sign-in cookies, and review app passwords and connected apps |
| Files the person owns in Drive | Transfers ownership to the manager | day 6 | yes, the transfer is polled until complete | shared drives, files shared *with* them and calendar delegation are not moved |
| Laptops bound to the account | Nothing on day 0. Deletion is refused while a machine is still bound | day 7 | yes, the gate reads the provider live | whether a suspended account can still unlock a bound machine depends on the agent and when it last checked in. Check it on your own devices |
| Group memberships, shared mailboxes, delegated access | Nothing | not covered | no | remove by hand, or through whatever manages your groups |
| Apps with their own logins (not through SSO) | Tells each owner from the app register, once, the day after the leaving date. Can raise a leaver ticket | day +1 | no | the owner removes the account |
| Personal API tokens, SSH keys, VPN profiles, shared passwords | Nothing | not covered | no | yours |
| Microsoft 365, Entra ID, Slack SCIM | Nothing. The interfaces exist and are not implemented; start-up refuses a credential for them | not covered | no | yours |

### The six-day Google window

The day-0 run does not suspend the Google account. That is the order this was
built around: the file transfer runs on day 6 and the account is suspended after
it. If Google sign-in goes through your identity provider, new Google web
sign-ins fail from day 0 because the identity provider refuses them. Sessions
that already exist, phones already syncing mail, and app passwords carry on
until day 6 or until Google's own licence removal stops the service.

If that window is not acceptable for your organisation, sign the account out by
hand on day 0 for now. A day-0 Google sign-out step is not implemented.

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
