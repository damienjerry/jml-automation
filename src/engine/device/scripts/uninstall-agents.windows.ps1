<#
  UNPROVEN ON HARDWARE.

  This script has NEVER been run on a real machine. It was ported from
  automation where the equivalent script was written, deployed as a device
  command, and never executed on anything: the service names, uninstall
  strings and product codes it relied on were inferred from documentation
  rather than read off a device. Treat every line below as a draft.

  Before you use it on anybody's laptop, follow
  docs/runbooks/canary-a-device-script.md: create the command, attach ONE
  machine you own, read the receipt, and only then set
  devices.uninstallTriggers.windows in your configuration. The toolkit refuses
  a handover until you have done that, and scripts/manifest.json records
  provenOnHardware: false until you change it yourself.

  WHAT IT DOES
  Removes each agent named in config.devices.agents, then prints one receipt
  line and exits 0. The receipt is the result, not the exit code: a device
  command that takes the machine down or restarts a service can lose its own
  output, so the state of every agent is written on one line that survives
  truncation.

      AGENTS_REMOVED <name>=<yes|no|absent> ...

  yes     the agent was found and is now gone
  no      the agent was found and something is still present
  absent  nothing belonging to that agent was installed

  RULES, each of which exists because the ancestor of this script broke it
    - Product names are compared EXACTLY against the names in your config. The
      earlier version matched a bare substring and hit an unrelated product
      whose display name happened to contain the same word.
    - A quiet uninstall string is used when the installer published one;
      otherwise the product code is uninstalled by the platform installer with
      an explicit /X. A registry uninstall string beginning /I is an INSTALL
      string masquerading as an uninstall string and is normalised here.
    - Nothing is ever appended to an unknown uninstall string and nothing is
      run through a joined command line. The earlier version appended a quiet
      flag to arbitrary strings and passed the result to a shell, which is the
      same unquoted-argument fault that made a restart command fail silently
      for weeks.
    - The agent that runs this script cannot uninstall itself in the
      foreground: it would kill its own runner half way through. That removal
      is scheduled as a detached task with a delay, and it is off unless you
      fill it in during your canary.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Rendered from config.devices.agents by the toolkit. Nothing product-specific
# is hard-coded in this file.
$AgentSpecJson = @'
__AGENTS_JSON__
'@

$SelfUninstallJson = @'
__SELF_UNINSTALL_JSON__
'@

$UninstallRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

$ProductCodePattern = '\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}'

function Get-UninstallEntry {
  param([string[]] $DisplayNames)
  if (-not $DisplayNames -or $DisplayNames.Count -eq 0) { return @() }
  $found = @()
  foreach ($root in $UninstallRoots) {
    $keys = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
    foreach ($key in $keys) {
      if ($null -eq $key.DisplayName) { continue }
      # Exact match, never a substring. This is the whole anchoring rule.
      if ($DisplayNames -contains $key.DisplayName) { $found += $key }
    }
  }
  return $found
}

function Split-CommandLine {
  <#
    Split a published uninstall string into a file and an argument array.

    Returns $null when the string cannot be split confidently, and the caller
    then leaves the product alone rather than guessing: a wrong split runs the
    wrong executable with somebody's arguments.
  #>
  param([string] $CommandLine)
  $text = $CommandLine.Trim()
  if ($text.Length -eq 0) { return $null }
  if ($text.StartsWith('"')) {
    $close = $text.IndexOf('"', 1)
    if ($close -lt 0) { return $null }
    $file = $text.Substring(1, $close - 1)
    $rest = $text.Substring($close + 1).Trim()
  }
  else {
    $space = $text.IndexOf(' ')
    if ($space -lt 0) { $file = $text; $rest = '' }
    else { $file = $text.Substring(0, $space); $rest = $text.Substring($space + 1).Trim() }
  }
  $arguments = @()
  if ($rest.Length -gt 0) {
    # Split on whitespace outside double quotes, so a quoted path stays one
    # argument. Each element is passed separately, never re-joined into a line.
    $arguments = [regex]::Matches($rest, '[^\s"]+|"([^"]*)"') | ForEach-Object {
      if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Value }
    }
  }
  return [pscustomobject]@{ File = $file; Arguments = @($arguments) }
}

function Invoke-Process {
  param([string] $File, [string[]] $Arguments)
  $argumentList = @($Arguments)
  if ($argumentList.Count -eq 0) {
    $process = Start-Process -FilePath $File -Wait -PassThru -NoNewWindow
  }
  else {
    $process = Start-Process -FilePath $File -ArgumentList $argumentList -Wait -PassThru -NoNewWindow
  }
  return $process.ExitCode
}

function Remove-AgentService {
  param([string] $Name)
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) { return }
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
  }
  # sc.exe rather than Remove-Service, which does not exist on the version of
  # PowerShell shipped with older supported builds.
  Invoke-Process -File 'sc.exe' -Arguments @('delete', $Name) | Out-Null
}

function Uninstall-AgentEntry {
  param($Entry)
  $quiet = $Entry.QuietUninstallString
  if (-not [string]::IsNullOrWhiteSpace($quiet)) {
    $split = Split-CommandLine -CommandLine $quiet
    if ($null -ne $split) {
      Invoke-Process -File $split.File -Arguments $split.Arguments | Out-Null
      return $true
    }
  }

  $raw = $Entry.UninstallString
  if (-not [string]::IsNullOrWhiteSpace($raw)) {
    $match = [regex]::Match($raw, $ProductCodePattern)
    if ($match.Success) {
      # /X, explicitly. A registry string carrying /I would REPAIR the product.
      Invoke-Process -File 'msiexec.exe' -Arguments @('/x', $match.Value, '/qn', '/norestart') | Out-Null
      return $true
    }
  }

  # No quiet string and no product code: an interactive uninstaller on an
  # unattended machine would hang for ever, so it is reported instead of run.
  return $false
}

function Test-AgentPresent {
  param($Agent)
  foreach ($name in @($Agent.services)) {
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) { return $true }
  }
  if ((Get-UninstallEntry -DisplayNames @($Agent.uninstallDisplayNames)).Count -gt 0) { return $true }
  foreach ($path in @($Agent.paths)) {
    # -Force so a hidden or system path is still seen. A plain Test-Path
    # answers false for some protected files that plainly exist.
    if (Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue) { return $true }
  }
  return $false
}

function Remove-AgentLeftover {
  param($Agent)
  foreach ($path in @($Agent.paths)) {
    if (Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Register-SelfUninstall {
  <#
    Schedule the removal of the agent that is running this script.

    Detached and delayed on purpose: uninstalling it in the foreground kills
    the process running these lines, so the receipt never gets written and the
    toolkit cannot tell a finished removal from a machine that went quiet.

    -Argument takes a single string because the scheduled-task API is defined
    that way; each element is quoted here rather than pasted together.
  #>
  param($Spec)
  if (-not $Spec.enabled) { return 'not-configured' }
  $quoted = @($Spec.args) | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
  $action = New-ScheduledTaskAction -Execute $Spec.command -Argument ($quoted -join ' ')
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds([int] $Spec.delaySeconds)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
  Register-ScheduledTask -TaskName 'jml-agent-self-uninstall' -Action $action -Trigger $trigger `
    -Principal $principal -Force | Out-Null
  return 'scheduled'
}

$states = [ordered]@{}
$selfState = 'not-attempted'

try {
  $agents = @($AgentSpecJson | ConvertFrom-Json)
  foreach ($agent in $agents) {
    $name = [string] $agent.name
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if (-not (Test-AgentPresent -Agent $agent)) {
      $states[$name] = 'absent'
      continue
    }

    $handled = $true
    foreach ($entry in Get-UninstallEntry -DisplayNames @($agent.uninstallDisplayNames)) {
      if (-not (Uninstall-AgentEntry -Entry $entry)) { $handled = $false }
    }
    foreach ($service in @($agent.services)) { Remove-AgentService -Name $service }
    Remove-AgentLeftover -Agent $agent

    # The state comes from a fresh look at the machine, never from the exit
    # code of the uninstaller: an installer that reports success and leaves its
    # service running is exactly what this receipt is for.
    if (Test-AgentPresent -Agent $agent) { $states[$name] = 'no' }
    else { $states[$name] = 'yes' }
    if (-not $handled) {
      Write-Output ('NOTE ' + $name + ' had an uninstall entry with no quiet string and no product code')
    }
  }

  $selfSpec = $SelfUninstallJson | ConvertFrom-Json
  $selfState = Register-SelfUninstall -Spec $selfSpec
}
catch {
  Write-Output ("ERROR " + $_.Exception.Message)
}
finally {
  $pairs = @()
  foreach ($key in $states.Keys) { $pairs += ($key + '=' + $states[$key]) }
  Write-Output ('SELF_UNINSTALL ' + $selfState)
  Write-Output ('AGENTS_REMOVED ' + ($pairs -join ' '))
}

# Always zero. The state is in the receipt, and a non-zero exit here would make
# a partially removed machine indistinguishable from one that never ran.
exit 0
