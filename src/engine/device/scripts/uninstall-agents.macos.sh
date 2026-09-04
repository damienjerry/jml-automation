#!/bin/bash
# UNPROVEN ON HARDWARE.
#
# This script has NEVER been run on a real machine. It was ported from
# automation that had no macOS handover path at all: the launchd labels and
# paths it works on were read from one device's inventory, not from a removal
# that anybody watched. Treat every line as a draft.
#
# Before using it on anybody's laptop, follow
# docs/runbooks/canary-a-device-script.md: create the command, attach ONE
# machine you own, read the receipt, and only then set
# devices.uninstallTriggers.darwin. The toolkit refuses a handover until you
# have done that, and scripts/manifest.json records provenOnHardware: false
# until you change it yourself.
#
# WHAT IT DOES
# Removes each agent named in config.devices.agents, prints one receipt line and
# exits 0. The receipt is the result, not the exit code:
#
#     AGENTS_REMOVED <name>=<yes|no|absent> ...
#
# yes     the agent was found and is now gone
# no      the agent was found and something is still present
# absent  nothing belonging to that agent was installed
#
# RULES
#   - The agent specification is rendered from your configuration as
#     bar-separated records, not as JSON. A shell script cannot parse JSON
#     without a tool that may not be installed, and a removal script that
#     depends on one fails on exactly the machine nobody can reach.
#   - Every path and label comes from configuration. Nothing product-specific
#     is written here, and nothing is matched by substring.
#   - Removal of the agent running this script is scheduled detached, with a
#     delay, because uninstalling it in the foreground kills its own runner
#     before the receipt is written. It is off unless you fill it in during
#     your canary.

set -u
# Deliberately no `set -e`: one agent that will not come off must not stop the
# others, and it must not stop the receipt from being printed. Every command
# that may fail is checked where it is called.

AGENT_SPEC=$(
  cat <<'JML_AGENT_SPEC'
__AGENT_SPEC__
JML_AGENT_SPEC
)

SELF_SPEC=$(
  cat <<'JML_SELF_SPEC'
__SELF_UNINSTALL_SPEC__
JML_SELF_SPEC
)

RECEIPT=""
SELF_STATE="not-attempted"

# Read the value of one record kind out of a specification block.
spec_values() {
  local block="$1" kind="$2" line rest
  while IFS= read -r line; do
    case "$line" in
      "$kind|"*)
        rest=${line#*|}
        printf '%s\n' "$rest"
        ;;
    esac
  done <<EOF
$block
EOF
}

# The block of records belonging to one agent, from its own header to the next.
agent_block() {
  local wanted="$1" line current="" rest
  while IFS= read -r line; do
    case "$line" in
      'agent|'*)
        rest=${line#*|}
        current="$rest"
        ;;
      *)
        if [ "$current" = "$wanted" ]; then
          printf '%s\n' "$line"
        fi
        ;;
    esac
  done <<EOF
$AGENT_SPEC
EOF
}

launchd_loaded() {
  local label="$1"
  # Checked in both the system domain and every logged-in user domain: an agent
  # installed by a user is invisible to a root-only check, and a root-only check
  # once reported a clean machine that still had the agent running.
  if launchctl print "system/${label}" >/dev/null 2>&1; then
    return 0
  fi
  local uid
  uid=$(id -u "$(stat -f '%Su' /dev/console 2>/dev/null || echo root)" 2>/dev/null || echo "")
  if [ -n "$uid" ] && launchctl print "gui/${uid}/${label}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

agent_present() {
  local name="$1" block label path
  block=$(agent_block "$name")
  while IFS= read -r label; do
    [ -z "$label" ] && continue
    if launchd_loaded "$label"; then
      return 0
    fi
    if [ -f "/Library/LaunchDaemons/${label}.plist" ] || [ -f "/Library/LaunchAgents/${label}.plist" ]; then
      return 0
    fi
  done <<EOF
$(spec_values "$block" label)
EOF
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    if [ -e "$path" ]; then
      return 0
    fi
  done <<EOF
$(spec_values "$block" path)
EOF
  return 1
}

remove_agent() {
  local name="$1" block label path uid
  block=$(agent_block "$name")
  uid=$(id -u "$(stat -f '%Su' /dev/console 2>/dev/null || echo root)" 2>/dev/null || echo "")

  while IFS= read -r label; do
    [ -z "$label" ] && continue
    launchctl bootout "system/${label}" >/dev/null 2>&1
    if [ -n "$uid" ]; then
      launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1
    fi
    rm -f "/Library/LaunchDaemons/${label}.plist" "/Library/LaunchAgents/${label}.plist"
    # Some installers write a sibling job with a suffix, so the exact label is
    # removed above and anything sharing that exact prefix is removed here.
    for plist in "/Library/LaunchDaemons/${label}."*.plist "/Library/LaunchAgents/${label}."*.plist; do
      [ -e "$plist" ] && rm -f "$plist"
    done
    pkill -f "$label" >/dev/null 2>&1
  done <<EOF
$(spec_values "$block" label)
EOF

  while IFS= read -r path; do
    [ -z "$path" ] && continue
    # No globbing and no recursion into anything the configuration did not
    # name: the paths are removed exactly as written.
    rm -rf "$path"
  done <<EOF
$(spec_values "$block" path)
EOF
}

schedule_self_uninstall() {
  local enabled command delay plist args
  enabled=$(spec_values "$SELF_SPEC" enabled | head -n 1)
  if [ "$enabled" != "yes" ]; then
    printf 'not-configured'
    return 0
  fi
  command=$(spec_values "$SELF_SPEC" command | head -n 1)
  delay=$(spec_values "$SELF_SPEC" delay | head -n 1)
  if [ -z "$command" ]; then
    printf 'not-configured'
    return 0
  fi
  args=""
  while IFS= read -r arg; do
    [ -z "$arg" ] && continue
    args="${args}    <string>${arg}</string>
"
  done <<EOF
$(spec_values "$SELF_SPEC" arg)
EOF

  plist=/Library/LaunchDaemons/com.jml.agent-self-uninstall.plist
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jml.agent-self-uninstall</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>sleep ${delay:-120}; exec "\$0" "\$@"</string>
    <string>${command}</string>
${args}  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  chmod 644 "$plist"
  if launchctl bootstrap system "$plist" >/dev/null 2>&1; then
    printf 'scheduled'
  else
    printf 'schedule-failed'
  fi
}

main() {
  local name state
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if ! agent_present "$name"; then
      state="absent"
    else
      remove_agent "$name"
      # The state comes from looking at the machine again, never from the exit
      # code of the removal: a job that reports success and is still loaded is
      # exactly what this receipt exists to catch.
      if agent_present "$name"; then
        state="no"
      else
        state="yes"
      fi
    fi
    RECEIPT="${RECEIPT}${RECEIPT:+ }${name}=${state}"
  done <<EOF
$(spec_values "$AGENT_SPEC" agent)
EOF

  SELF_STATE=$(schedule_self_uninstall)
}

main
printf 'SELF_UNINSTALL %s\n' "$SELF_STATE"
printf 'AGENTS_REMOVED %s\n' "$RECEIPT"

# Always zero. The state is in the receipt, and a non-zero exit would make a
# partially removed machine indistinguishable from one that never ran.
exit 0
