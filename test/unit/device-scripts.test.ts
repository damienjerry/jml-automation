import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderUninstallScript } from '../../src/engine/device/handover.ts'
import { DeviceScriptError, loadScriptManifest, scriptsDirectory } from '../../src/engine/device/preflight.ts'
import { deviceConfig } from '../fixtures/device/harness.ts'

const AGENTS = deviceConfig().devices.agents

function shipped(file: string): string {
  return readFileSync(join(scriptsDirectory(), file), 'utf8')
}

describe('the shipped scripts', () => {
  it('say in their own headers that they have never run on hardware', () => {
    for (const entry of loadScriptManifest().scripts) {
      expect(shipped(entry.file)).toContain('UNPROVEN ON HARDWARE')
    }
  })

  it('point the reader at the canary runbook', () => {
    for (const entry of loadScriptManifest().scripts) {
      expect(shipped(entry.file)).toContain('docs/runbooks/canary-a-device-script.md')
    }
  })

  it('carry no product names of their own, so the config is the only source', () => {
    // Every service, display name, launchd label and path comes from config.
    // A product name baked into a shipped script is a name somebody else's
    // fleet does not have.
    for (const entry of loadScriptManifest().scripts) {
      const body = shipped(entry.file)
      expect(body).toContain(entry.receiptProtocol)
      for (const placeholder of ['Example Telemetry', 'com.example.telemetry']) {
        expect(body).not.toContain(placeholder)
      }
    }
  })

  it('always exit zero, because the state is in the receipt', () => {
    for (const entry of loadScriptManifest().scripts) {
      expect(shipped(entry.file)).toContain('exit 0')
    }
  })
})

describe('rendering the Windows script', () => {
  it('substitutes the configured agents and leaves no placeholder behind', () => {
    const rendered = renderUninstallScript({ os: 'windows', agents: AGENTS })
    expect(rendered.body).not.toContain('__AGENTS_JSON__')
    expect(rendered.body).toContain('"name": "telemetry"')
    expect(rendered.body).toContain('"Example Telemetry Agent"')
    expect(rendered.provenOnHardware).toBe(false)
  })

  it('leaves the self-uninstall off unless it is filled in during a canary', () => {
    const rendered = renderUninstallScript({ os: 'windows', agents: AGENTS })
    expect(rendered.body).toContain('"enabled": false')
  })

  it('schedules a filled-in self-uninstall detached, with a delay', () => {
    const rendered = renderUninstallScript({
      os: 'windows',
      agents: AGENTS,
      selfUninstall: { command: 'C:\\Windows\\System32\\example.exe', args: ['-remove'], delaySeconds: 120 },
    })
    expect(rendered.body).toContain('"delaySeconds": 120')
    // The delay is the point: uninstalling the agent in the foreground kills
    // the process running the script before the receipt is written.
    expect(rendered.body).toContain('New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds')
  })

  it('compares uninstall display names exactly rather than by substring', () => {
    const rendered = renderUninstallScript({ os: 'windows', agents: AGENTS })
    expect(rendered.body).toContain('$DisplayNames -contains $key.DisplayName')
    expect(rendered.body).not.toContain('-like')
  })

  it('uninstalls a product code with an explicit removal flag', () => {
    // A registry uninstall string beginning with the install flag would repair
    // the product instead of removing it, and report success either way.
    const rendered = renderUninstallScript({ os: 'windows', agents: AGENTS })
    expect(rendered.body).toContain("Arguments @('/x', $match.Value, '/qn', '/norestart')")
  })

  it('never builds a joined command line for a shell', () => {
    const rendered = renderUninstallScript({ os: 'windows', agents: AGENTS })
    expect(rendered.body).not.toContain('cmd /c')
    expect(rendered.body).not.toContain('cmd.exe /c')
  })
})

describe('rendering the macOS script', () => {
  it('substitutes the configured labels and paths', () => {
    const rendered = renderUninstallScript({ os: 'darwin', agents: AGENTS })
    expect(rendered.body).not.toContain('__AGENT_SPEC__')
    expect(rendered.body).toContain('agent|telemetry')
    expect(rendered.body).toContain('label|com.example.telemetry')
  })

  it('refuses a path that would break the record format', () => {
    // Rendering a bar into a bar-separated record would silently change which
    // paths get removed, so it is refused rather than escaped.
    expect(() =>
      renderUninstallScript({
        os: 'darwin',
        agents: [{ name: 'odd', windows: { services: [], uninstallDisplayNames: [], paths: [] }, darwin: { launchdLabels: [], paths: ['/tmp/a|b'] } }],
      }),
    ).toThrow(DeviceScriptError)
  })

  it('leaves the self-uninstall off unless it is filled in', () => {
    expect(renderUninstallScript({ os: 'darwin', agents: AGENTS }).body).toContain('enabled|no')
  })
})

describe('agent names', () => {
  it('are refused when they could not appear in a receipt', () => {
    for (const name of ['two words', 'has=equals', 'has|bar', '']) {
      expect(() =>
        renderUninstallScript({
          os: 'windows',
          agents: [{ name, windows: { services: [], uninstallDisplayNames: [], paths: [] }, darwin: { launchdLabels: [], paths: [] } }],
        }),
      ).toThrow(DeviceScriptError)
    }
  })
})

describe('Linux', () => {
  it('has no script, so a handover there is refused rather than sent the wrong one', () => {
    expect(loadScriptManifest().scripts.some((s) => s.os === 'linux')).toBe(false)
    expect(() => renderUninstallScript({ os: 'linux', agents: AGENTS })).toThrow(DeviceScriptError)
  })
})
