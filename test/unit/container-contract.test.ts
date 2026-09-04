/**
 * The container contract.
 *
 * The security claim this toolkit makes to an adopter is precise: your
 * automation tool holds one bearer token and none of your vendor credentials,
 * so a workflow export cannot leak them. That claim lives in two files rather
 * than in prose, so it is asserted here rather than trusted.
 *
 * The other assertion is about the port. The sidecar can suspend and delete
 * accounts, and it is reachable by service name on a private network. Publishing
 * it to the host would put that endpoint behind one token and whatever else is
 * listening on the machine.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

interface Compose {
  services: Record<
    string,
    {
      image?: string
      build?: unknown
      ports?: string[]
      env_file?: string | string[]
      environment?: Record<string, string>
      volumes?: string[]
      networks?: string[]
    }
  >
  networks?: Record<string, unknown>
}

const compose = parseYaml(readFileSync('docker-compose.yml', 'utf8')) as Compose
const dockerfile = readFileSync('Dockerfile', 'utf8')

/** Anything that names a vendor credential rather than this toolkit's own. */
const VENDOR_CREDENTIAL_NAMES = [
  'JUMPCLOUD_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'HIBOB_SERVICE_TOKEN',
  'HIBOB_SERVICE_USER_ID',
  'SLACK_BOT_TOKEN',
  'FLEET_API_TOKEN',
  'LOKI_AUTH_HEADER',
  'JML_AUDIT_SALT',
  'HC_PING_JML',
]

describe('docker-compose.yml', () => {
  it('runs both services on one private network', () => {
    expect(compose.services.jml?.networks).toContain('jml')
    expect(compose.services.n8n?.networks).toContain('jml')
    expect(compose.networks).toHaveProperty('jml')
  })

  it('does not publish the sidecar port', () => {
    // The automation tool reaches it at http://jml:8787 on the compose
    // network. Nothing outside can reach it at all.
    expect(compose.services.jml?.ports).toBeUndefined()
    expect(compose.services.n8n?.environment?.JML_API_URL).toBe('http://jml:8787')
  })

  it('gives the automation tool the bearer token and no vendor credential', () => {
    const n8n = compose.services.n8n
    expect(n8n?.environment?.JML_API_TOKEN).toContain('JML_API_TOKEN')
    // No env_file either: the whole .env would hand it every credential.
    expect(n8n?.env_file).toBeUndefined()
    const declared = JSON.stringify(n8n?.environment ?? {})
    for (const name of VENDOR_CREDENTIAL_NAMES) expect(declared).not.toContain(name)
  })

  it('gives the sidecar the environment, and volumes for the three things that must survive a rebuild', () => {
    const jml = compose.services.jml
    expect(jml?.env_file).toBe('.env')
    const volumes = (jml?.volumes ?? []).join(' ')
    expect(volumes).toContain('/app/data')
    expect(volumes).toContain('/app/audit')
    expect(volumes).toContain('/app/config/jml.config.yaml')
  })

  it('mounts the configuration read-only, because nothing rewrites it', () => {
    const mount = (compose.services.jml?.volumes ?? []).find((entry) => entry.includes('jml.config.yaml'))
    expect(mount?.endsWith(':ro')).toBe(true)
  })

  it('pins the automation tool to an exact version', () => {
    // A tool that upgrades itself underneath a working schedule is how a
    // schedule silently stops firing.
    expect(compose.services.n8n?.image).toMatch(/:\d+\.\d+\.\d+$/)
  })
})

describe('Dockerfile', () => {
  it('pins the base image by digest rather than by a tag that moves', () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] as string)
    expect(froms.length).toBeGreaterThan(0)
    for (const from of froms) expect(from).toMatch(/^node@sha256:[0-9a-f]{64}$/)
  })

  it('runs as a non-root user', () => {
    // This process holds every vendor credential the toolkit uses.
    expect(dockerfile).toMatch(/^USER node$/m)
  })

  it('ships the build output and not the sources or the test runner', () => {
    expect(dockerfile).toContain('npm prune --omit=dev')
    expect(dockerfile).toContain('COPY --from=build /build/dist ./dist')
    expect(dockerfile).not.toMatch(/^COPY test/m)
  })

  it('bakes in no credential and no configuration', () => {
    for (const name of VENDOR_CREDENTIAL_NAMES) expect(dockerfile).not.toContain(name + '=')
    // The configuration arrives as a mount; only its location is set here.
    expect(dockerfile).toContain('ENV JML_CONFIG=/app/config/jml.config.yaml')
  })

  it('health-checks the one route that needs no credential', () => {
    expect(dockerfile).toContain('/v1/health')
  })
})
