# Runbook: canary a device script before you use it

**The two uninstall scripts in this repository have never been run on a real
machine.** They were ported from automation where the equivalent scripts were
written, deployed as device commands, and never executed on anything: the
service names, uninstall strings, launchd labels and paths in them were
inferred. `src/engine/device/scripts/manifest.json` records
`provenOnHardware: false`, both scripts carry the same statement in their
headers, and the toolkit refuses a handover until you have done the work below.

This runbook is how you turn a draft into something you can point at somebody's
laptop. Budget an hour and one machine you own.

## Why the toolkit refuses until you have done this

`devices.uninstallTriggers` defaults to `null` for every platform, so a fresh
install cannot run a handover at all. That is deliberate: nobody should inherit
a fleet-wide uninstaller they did not create and have not watched work. Two
separate refusals stand in the way, and each names this file:

| Refusal | What it means |
| --- | --- |
| `no_uninstall_trigger` | there is no command configured for this operating system |
| `unproven_script_needs_canary` | the script is marked unproven and `--armed` was used without `--canaried-system-id` |

A dry run is never refused for being unproven. Plan as much as you like.

## What a handover actually does, in order

1. attach your one machine to the uninstall command, and read the attachment
   back,
2. fire the command once, hold the attachment, then detach it in a `finally`
   and assert the attachment count is back to zero,
3. read the result from the **detail** endpoint and require both an exit code
   and a response time,
4. parse the `AGENTS_REMOVED` line and require every agent in
   `devices.agents` to be `yes` or `absent`,
5. watch the machine's last-contact time and require it unchanged for
   `devices.agentQuietMinutes`,
6. and only then delete the device record.

Anything short of steps 3, 4 and 5 leaves the machine enrolled and deletes
nothing. Deleting the record first removes the machine from your view and not
from the network: that happened, and the laptop went on reporting for weeks
with no command channel left to reach it.

## Step 1: write the agent list

`devices.agents` drives both scripts. Nothing product-specific is written in
them, so this list is the only place your fleet is described:

```yaml
devices:
  agents:
    - name: telemetry
      windows:
        services: ['ExampleTelemetry']
        uninstallDisplayNames: ['Example Telemetry Agent']
        paths: ['C:\Program Files\Example\Telemetry']
      darwin:
        launchdLabels: ['com.example.telemetry']
        paths: ['/Library/Application Support/Example/Telemetry']
```

Two rules the toolkit enforces when it renders a script:

- `name` may not contain a space, an equals sign or a bar. It becomes a
  `name=state` pair in the receipt, and a name with a space makes the receipt
  unparseable, which shows up as a handover that refuses to delete anything for
  a reason nobody can see.
- `uninstallDisplayNames` are compared **exactly**. Get them from the machine,
  not from the vendor's website: run
  `Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' | Select DisplayName, QuietUninstallString, UninstallString`
  and copy what it prints. The earlier version of this script matched a
  substring and hit an unrelated product whose display name happened to contain
  the same word.

## Step 2: create the command in your identity provider

Create one command per platform, paste in the rendered script, and give it a
trigger name. Three properties matter, and the toolkit checks all three before
it fires anything:

- **launch type must be trigger.** A command that cannot be fired by trigger
  reports success at the trigger endpoint and never reaches a device.
- **no device-group binding.** A trigger fires on every association the command
  holds, so a group-bound uninstaller strips your fleet in one call. This is
  refused, and `devices.forbidGroupBoundCommands` is a literal `true` in the
  schema that you cannot override.
- **no standing associations.** Any device already attached would be
  uninstalled as collateral. Also refused.

Do not edit the command definition through a partial API write afterwards. A
partial write answers 200 and resets every field it did not carry, which
silently changes the command's type and launch mode and disarms it. Edit it in
the console, or delete it and make a new one.

## Step 3: dry run against one machine you own

```
jml device preflight --system-id <systemId> --disposition handover
jml device dispose --system-id <systemId> --disposition handover --acknowledge-fde-key-loss
```

`dispose` is a dry run unless you pass `--armed`, so this changes nothing. It
prints the exact machine, the exact association it would create, the agents the
receipt must account for, every refusal and every warning. Read it. If it names
a machine you did not expect, stop.

The disk-encryption acknowledgement is required whenever the provider holds the
recovery key, **and also when it does not say whether it holds one**. Deleting
the record destroys an escrowed key, and an unknown is not a no.

## Step 4: execute on that one machine

```
jml device dispose --system-id <systemId> --disposition handover --armed \
  --canaried-system-id <canary-systemId> --acknowledge-fde-key-loss
```

Watch for these in the report, in this order:

- `uninstall`: `done` and verified. `failed` with "collected the command and
  did not finish it" means a result row exists with no exit code, which is
  collection, not execution: the script is hanging. Look for an unbounded
  download or an interactive uninstaller.
- `receipt`: the parsed states. `not accounted for` means the script never
  named that agent; `still installed` means it named it and it is still there.
- `agent_quiet`: `done` means last contact did not move for the configured
  window. `failed` with "contacted the provider again" means an agent is still
  running, whatever the receipt said.
- `delete_record`: only reached when all three above passed.
- `warnings`: an association-leak warning means the command may still be
  attached to that machine. Detach it before anything else fires that command.
  A leaked attachment on a restart command once restarted a laptop repeatedly
  for days.

## Step 5: check the machine yourself

Do not take the receipt's word for it. On the machine: the services or launchd
jobs are gone, the paths are gone, and nothing has reappeared after a reboot.
Then check that the provider's record is a 404 and that no telemetry has
arrived since the uninstall.

## Step 6: record what you proved

In **your fork**, set `provenOnHardware: true` for that platform in
`src/engine/device/scripts/manifest.json`, and record the machine, the date and
the agent versions in your change.

Do not send that change back to this repository. It is a statement about your
fleet and your script, not about this code, and the next adopter must do their
own canary.

## If you would rather not do any of this

You do not have to. `return_to_pool` clears the day-7 deletion block with no
device work at all: it removes the leaver's binding, optionally binds a spares
account, and leaves the machine enrolled, managed and with its recovery key
still escrowed. It is the default disposition for that reason. Handover exists
for the case where the machine genuinely leaves your management, and
`retain_unmanaged` exists for the case where it leaves your control without
your agents coming off, which deletes nothing and keeps the case open for a
person.
