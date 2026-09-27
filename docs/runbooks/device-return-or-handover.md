# Runbook: return, reassign or hand over a leaver's machine

A machine still bound to a leaver blocks their day-7 deletion. Deleting the
account while the binding stands removes the only channel to that machine and
takes its escrowed disk-encryption recovery key with it, so the laptop carries
on running, unmanaged, with nothing left to reach it. That happened, and the
machine went on reporting telemetry for weeks.

This runbook is how the block is cleared. Read
[clear-a-blocked-deletion.md](clear-a-blocked-deletion.md) first if you are not
sure that is what you are looking at.

**Nothing here has been run against a real fleet.** The two uninstall scripts
have never executed on real hardware and the shipped manifest records
`provenOnHardware: false`. The handover disposition refuses to run until you
have proved the script yourself. See
[canary-a-device-script.md](canary-a-device-script.md).

## Choose the disposition

Four exist. Three clear the deletion gate. Only one deletes anything.

| Disposition | Writes | Clears the gate | Machine ends up |
| --- | --- | --- | --- |
| `return_to_pool` (default) | removes the leaver's binding, optionally binds the spares account | yes | enrolled, managed, key still escrowed |
| `reassign` | binds the new owner, reads it back, then removes the leaver's | yes | enrolled, managed, owned by somebody else |
| `handover` | uninstalls the agents, proves it, then deletes the device record | yes | outside your management, key destroyed |
| `retain_unmanaged` | nothing at all | **no, deliberately** | in the leaver's hands, still enrolled |

`return_to_pool` is the default because it costs nothing and risks nothing. The
machine stays enrolled and managed, the recovery key stays escrowed, no script
runs, nothing is deleted, and the day-7 block clears. If you are unsure which to
pick, this is the answer.

**The order in a reassignment is not cosmetic.** The new owner is bound and read
back first, and only then is the leaver's binding removed, so the machine is
never briefly owned by nobody. Reversed, a failure in the middle leaves an
unowned machine that no report attributes to anyone.

`retain_unmanaged` clears nothing on purpose. It is the honest answer for a
machine that has left your control without your agents coming off: it deletes
nothing, keeps the case open, and leaves a person to decide. Switching it to
"clears the gate" would turn "I do not know what happened to this laptop" into
"deleted, done".

## Always preflight

Everything in the preflight is a read. Nothing attaches, fires or deletes.

```
jml device preflight --system-id sys-a1b2c3 --disposition return_to_pool
```

```
device            sys-a1b2c3  (sys-a1b2c3)
platform          unknown   no uninstall trigger is configured for it
direct owners     none
would unbind      nothing
would bind        nothing
last contact      unknown
encryption key    unknown
command           none needed
agents expected   none
script proven     no script involved
dry run           yes: config.mode is dry-run

REFUSED:  provider_unreadable  the device could not be read: reading a device answered 401
```

That run is what a broken credential looks like: a refusal, not a guess. An
unreadable answer is not an absence of danger, and an earlier version of this code
treated a failed device read as "no devices" and deleted the account.

Add `--owner-hris-id p-1004` to assert whose machine this is. The run is then
refused with `owner_mismatch` if the machine is not bound to that person, which
is the check that stops a mistyped system id acting on somebody else's laptop.

Read three lines before going further:

- **direct owners.** Group-derived access is not custody; only a direct binding
  counts, and only a direct binding blocks a deletion.
- **encryption key.** `held by the provider, and DESTROYED if the record is
  deleted` is the warning that matters for a handover.
- **last contact.** A machine nobody has heard from will not run a command
  today. The preflight warns past `devices.staleContactWarnMin`.

`jml device preflight` exits 0 when nothing refuses the run and 1 when something
does, so it works in a script.

## return_to_pool

```
jml device preflight --system-id sys-a1b2c3 --disposition return_to_pool --owner-hris-id p-1004
jml device dispose --system-id sys-a1b2c3 --disposition return_to_pool --owner-hris-id p-1004 \
  --armed --actor jane.doe@example.com
```

`dispose` is a dry run unless `--armed`, **and** `mode` must be `armed` **and**
`armedActions` must list `device_unbind`. Three independent brakes, and the
loosest wins. A dry run prints the exact association it would create rather
than a summary, because a plan that does not name what it would touch is not a
plan.

Correct output ends with a line reading `deletion gate after this run:` and
either `clears` or `still blocked`, with the reason in brackets: `unbound`,
`rebound_to_pool`, `bound_to_new_owner`, `record_deleted`, `still_bound`,
`unreadable`, `retained_unmanaged` or `not_executed`. The verdict comes from
re-reading the provider after the write, so you do not have to wait for the next
scheduled run to find out whether it worked. `unreadable` is reported as still
blocked, never as probably fine.

`identity.jumpcloud.poolUserEmail` names the spares account. Left null, the
machine is unbound and not rebound, which still clears the gate.

Undo: bind the person back in your provider console. Nothing was uninstalled and
nothing was deleted, so there is nothing else to reverse.

## reassign

**Not reachable from the CLI or the sidecar in this release.** The engine
supports it and the tests cover it, but neither `jml device dispose` nor
`POST /v1/devices/disposition` accepts the new owner, so a reassignment
requested through either is refused with `no_rebind_target`. Until that flag
exists, either rebind in your provider console and then use `return_to_pool`, or
call the library directly.

## handover

This is the only disposition that deletes a device record, and the only one that
runs a script on somebody's machine. It is refused until you have done the
canary procedure, and each refusal names the runbook:

| Refusal | Means |
| --- | --- |
| `no_uninstall_trigger` | `devices.uninstallTriggers.<os>` is null, which is the shipped default for every platform |
| `unproven_script_needs_canary` | the script is marked unproven and no `--canaried-system-id` was given |
| `canary_is_the_target` | the machine named as the canary is the machine this run would act on, so nothing has been proven |
| `no_agents_configured` | `devices.agents` is empty, so no receipt could prove anything was removed |
| `group_bound` | the command is attached to a device group, so a trigger would fire on the whole fleet |
| `collateral_associations` | the command already has devices attached, which would be uninstalled as collateral |
| `not_a_trigger` | the command cannot be fired by trigger, and the trigger endpoint reports success anyway |
| `fde_acknowledgement_required` | the provider holds the recovery key, or did not say whether it holds one |

```
jml device preflight --system-id sys-a1b2c3 --disposition handover
jml device dispose --system-id sys-a1b2c3 --disposition handover \
  --armed --acknowledge-fde-key-loss --canaried-system-id sys-d4e5f6 \
  --actor jane.doe@example.com
```

`--canaried-system-id` must name a **different** machine from `--system-id`.
Naming the target as its own canary cannot be true, and the check exists less
for a person typing it than for an automation template that maps both fields
from the same expression: that satisfies a presence test silently and fires an
unproven uninstaller.

### The disk-encryption acknowledgement

`--acknowledge-fde-key-loss` is required whenever the provider holds the
recovery key **and also when it does not say whether it holds one**. Deleting
the record destroys an escrowed key, and an unknown is not a no.

Before you pass it, decide what happens to that key. Export it, or accept that
the machine's disk is unrecoverable if it ever needs the recovery path.

### What has to be true before the record is deleted

Three things, in order, and all of them:

1. the receipt read from the **detail** endpoint carries both an exit code and a
   response time. A result row on its own means the machine collected the
   command, which is not the same as running it;
2. every agent in `devices.agents` is reported `yes` or `absent` in the
   `AGENTS_REMOVED` line;
3. the machine's last-contact time has not moved for
   `devices.agentQuietMinutes`. The removal is confirmed by silence, not by an
   exit code.

Anything short of that leaves the machine enrolled and deletes nothing. Read the
step table in the report:

| Step | Failure to take seriously |
| --- | --- |
| `uninstall` | "collected the command and did not finish it" means the script is hanging, usually on an unbounded download or an interactive uninstaller |
| `receipt` | `not accounted for` means the script never named that agent; `still installed` means it named it and it is still there |
| `agent_quiet` | "contacted the provider again" means an agent is still running, whatever the receipt said |
| `delete_record` | only reached when the three above passed |

A warning about a leaked association means the uninstall command may still be
attached to that machine. Detach it before anything else fires that command: a
leaked attachment on a restart command once restarted somebody's laptop every
day for eleven days before anybody connected the two.

Undo: there is none worth the name. The record is gone, the agents are gone and
the escrowed key is gone. Re-enrolling the machine means physical access and the
person's cooperation.

## retain_unmanaged

```
jml device dispose --system-id sys-a1b2c3 --disposition retain_unmanaged \
  --note "sold to the leaver, agents left in place, machine not recovered" \
  --actor jane.doe@example.com
```

It writes nothing to the provider whatever you pass. `--armed` is ignored for
this disposition; the dry run is forced.

The row stays blocked and the case stays open. To close it, decide: recover the
machine and use `return_to_pool`, prove the script and use `handover`, or
close the person's row by hand with
`jml leaver tombstone --reason "..."` and record the machine in your asset
register as gone. The last one is the answerable version of switching the gate
off, and it is described in [incident-recovery.md](incident-recovery.md).
