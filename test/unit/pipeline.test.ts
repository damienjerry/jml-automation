import { describe, expect, it } from 'vitest'
import type { Person } from '../../src/core/types.ts'
import type { AuditSink } from '../../src/audit/types.ts'

/** The optional extras the pipeline looks for on a sink, without assuming them. */
type SinkWithExtras = AuditSink & { flush?: () => Promise<void>; warnings?: () => string[] }
import { createHttpClient } from '../../src/core/http.ts'
import { createSecretHandle, createSecretRegistry } from '../../src/config/secrets.ts'
import { PIPELINE_LEASE, runPipeline, summarise, type LivenessHttp, type PipelineDeps } from '../../src/engine/pipeline.ts'
import { DEPARTED_COUNTER } from '../../src/store/bootstrap.ts'
import {
  CapturingNotifier,
  IDP_USER_ID,
  LEAVER_EMAIL,
  LEAVER_ID,
  MANAGER_EMAIL,
  NOW,
  fixtureHris,
  harness,
  personFixture,
} from '../fixtures/leaver/harness.ts'
import { HrisImplausible, HrisIncomplete, type HrisAdapter } from '../../src/hris/types.ts'

const RUN = { dryRun: false, actor: { kind: 'system' as const, id: 'system:pipeline' } }
const PING_URL = 'https://example.com/ping/liveness'

/**
 * The leaver plus three people who still work here.
 *
 * Three employed, because the sync asserts the plausibility floor against the
 * EMPLOYED set as well as the whole snapshot, and the configured floor is
 * three. That is the check working, not a fixture quirk.
 */
const HR_SNAPSHOT = [
  personFixture(),
  personFixture({ hrisId: 'hris-0002', primaryEmail: MANAGER_EMAIL, terminationDate: null }),
  personFixture({ hrisId: 'hris-0003', primaryEmail: 'someone.else@example.com', terminationDate: null }),
  personFixture({ hrisId: 'hris-0004', primaryEmail: 'third.person@example.com', terminationDate: null }),
]
const EMPLOYED = ['hris-0002', 'hris-0003', 'hris-0004']

class PingRecorder implements LivenessHttp {
  readonly urls: string[] = []
  private readonly ok: boolean
  constructor(ok = true) {
    this.ok = ok
  }
  async request(req: { method: 'GET'; url: string }): Promise<{ ok: boolean; status: number }> {
    this.urls.push(req.url)
    return { ok: this.ok, status: this.ok ? 200 : 500 }
  }
}

function pipeline(
  opts: {
    people?: readonly Person[]
    notifier?: CapturingNotifier
    hris?: HrisAdapter
    ping?: PingRecorder
    liveness?: boolean
  } = {},
) {
  const h = harness({
    armed: true,
    ...(opts.people ? { people: opts.people } : {}),
    ...(opts.notifier ? { notifier: opts.notifier } : {}),
    config: opts.liveness ? { liveness: { healthchecksPingUrl: 'env:HC_PING_JML' } } : {},
    seed: {
      idp: [{ id: IDP_USER_ID, email: LEAVER_EMAIL }],
      google: [{ id: 'goog-leaver-1', email: LEAVER_EMAIL }],
    },
  })
  const deps: PipelineDeps = {
    ...h.deps,
    hris: opts.hris ?? fixtureHris(HR_SNAPSHOT, EMPLOYED),
    ...(opts.ping ? { http: opts.ping } : {}),
    secrets: createSecretRegistry(
      new Map([['liveness.healthchecksPingUrl', createSecretHandle('env:HC_PING_JML', PING_URL)]]),
    ),
  }
  return { h, deps }
}

describe('the shared HTTP client satisfies the liveness port', () => {
  it('compiles as one', () => {
    const http: LivenessHttp = createHttpClient()
    expect(typeof http.request).toBe('function')
  })
})

describe('one ordered run', () => {
  it('reads the HR system once and runs sync, detect and the leaver engine in order', async () => {
    let reads = 0
    const source = fixtureHris(HR_SNAPSHOT, EMPLOYED)
    const { h, deps } = pipeline({
      hris: {
        name: 'fixture',
        fetchAll: async () => {
          reads += 1
          return source.fetchAll()
        },
        testConnection: source.testConnection,
      },
    })

    const report = await runPipeline(deps, RUN)

    expect(reads).toBe(1)
    expect(report.kind).toBe('pipeline')
    expect(report.counts.hrisPeople).toBe(4)
    // Sync and detect counts are namespaced, so a reader can tell which step
    // a number came from.
    expect(Object.keys(report.counts).some((field) => field.startsWith('sync.'))).toBe(true)
    expect(Object.keys(report.counts).some((field) => field.startsWith('detect.'))).toBe(true)
    expect(h.audit.actions()).toContain('run.start')
  })

  it('records the run and its one-line summary', async () => {
    const { h, deps } = pipeline()
    const report = await runPipeline(deps, RUN)

    expect(await h.state.lastRun('pipeline')).toMatchObject({ runId: report.runId })
    expect(summarise(report)).toContain('armed')
  })

  it('skips rather than fails when another run holds the lease', async () => {
    // An overlapping schedule is normal operation. Turning it into a red run
    // teaches people to ignore red runs.
    const { h, deps } = pipeline()
    await h.state.acquireLease(PIPELINE_LEASE, 900)

    const report = await runPipeline(deps, RUN)

    expect(report.aborted?.reason).toBe('lease_held')
    expect(report.ok).toBe(true)
    expect(h.calls).toEqual([])
    expect((await h.store.get(LEAVER_ID))?.status).toBe('terminated')
  })

  it('releases the lease afterwards, so the next run is not locked out', async () => {
    const { h, deps } = pipeline()
    await runPipeline(deps, RUN)
    expect(await h.state.acquireLease(PIPELINE_LEASE, 900)).not.toBeNull()
  })

  it('aborts with zero writes when the HR snapshot is implausible', async () => {
    const { h, deps } = pipeline({
      hris: {
        name: 'fixture',
        fetchAll: async () => {
          throw new HrisImplausible('the snapshot holds 1 person against a floor of 3', { received: 1, floor: 3 })
        },
        testConnection: async () => ({ ok: true, detail: 'fixture' }),
      },
    })

    const report = await runPipeline(deps, RUN)

    expect(report.aborted?.reason).toBe('hris_implausible')
    expect(report.ok).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.notifier.kinds()).toEqual(['run.aborted'])
  })
})

describe('the liveness ping', () => {
  it('is sent only after the summary was delivered', async () => {
    const ping = new PingRecorder()
    const { deps } = pipeline({ ping, liveness: true })

    await runPipeline(deps, RUN)

    expect(ping.urls).toEqual([PING_URL])
  })

  it('is not sent when the summary could not be delivered', async () => {
    // A dead-man that is fed whatever happened proves the process ran. Feeding
    // it only after delivery proves the alerting path works too, which is the
    // half that has failed silently before.
    const ping = new PingRecorder()
    const { deps } = pipeline({ ping, liveness: true, notifier: new CapturingNotifier(false) })

    const report = await runPipeline(deps, RUN)

    expect(ping.urls).toEqual([])
    expect(report.ok).toBe(false)
  })

  it('is not sent in a dry run, and says so', async () => {
    const ping = new PingRecorder()
    const { deps } = pipeline({ ping, liveness: true })

    const report = await runPipeline(deps, { ...RUN, dryRun: true })

    expect(ping.urls).toEqual([])
    expect(report.warnings.join(' ')).toContain('liveness ping was not sent')
  })

  it('never puts the ping URL in the report, because the URL is the credential', async () => {
    const ping = new PingRecorder(false)
    const { deps } = pipeline({ ping, liveness: true })

    const report = await runPipeline(deps, RUN)

    expect(report.warnings.join(' ')).toContain('the liveness ping answered 500')
    expect(JSON.stringify(report)).not.toContain('example.com/ping')
  })

  it('says so rather than failing quietly when it is configured with nothing to send it', async () => {
    const { deps } = pipeline({ liveness: true })
    const report = await runPipeline({ ...deps, http: undefined }, RUN)
    expect(report.warnings.join(' ')).toContain('no HTTP client')
  })
})

describe('the tombstone baseline', () => {
  it('moves up as rows are closed, and never down', async () => {
    const { h, deps } = pipeline({ people: [personFixture({ primaryEmail: MANAGER_EMAIL })] })
    await h.state.setCounter(DEPARTED_COUNTER, 5)

    await runPipeline(deps, { ...RUN, steps: ['leaver'] })

    // Nothing was tombstoned, and the recorded number is left where it was
    // rather than being lowered to today's count.
    expect(await h.state.getCounter(DEPARTED_COUNTER)).toBe(5)
  })
})

describe('a dry run of the whole pipeline', () => {
  it('writes nothing and still reports what it would do', async () => {
    const { h, deps } = pipeline()
    const writesBefore = h.store.writes

    const report = await runPipeline(deps, { ...RUN, dryRun: true })

    expect(h.store.writes).toBe(writesBefore)
    expect(report.dryRun).toBe(true)
    expect(h.providers.idpAccount(IDP_USER_ID)?.suspended).toBeFalsy()
    expect(summarise(report)).toContain('dry-run')
  })
})

describe('a run whose audit log cannot be written', () => {
  it('stops with an abort reason rather than acting unrecorded', async () => {
    const { deps } = pipeline()
    const failing: PipelineDeps = {
      ...deps,
      audit: {
        name: 'unwritable',
        append: async () => {
          const err = new Error('the audit directory is not writable') as Error & { code: string }
          err.code = 'audit_unavailable'
          throw err
        },
      },
    }

    const report = await runPipeline(failing, { ...RUN, steps: ['leaver'] })

    expect(report.aborted?.reason).toBe('audit_unavailable')
    expect(report.ok).toBe(false)
  })
})

describe('the run summary', () => {
  it('carries the counts and the delivery result', async () => {
    const { h, deps } = pipeline()
    await runPipeline(deps, RUN)

    // The last one: the detect step announces under the same kind, and the
    // pipeline summary is sent after it.
    const summary = h.notifier.sent.filter((n) => n.kind === 'run.summary').at(-1)
    expect(summary?.body).toContain('Suspended today: 1')
    expect(summary?.body).toContain(NOW.slice(0, 10))
  })
})

describe('the steps a caller asks for', () => {
  it('can be narrowed to the leaver engine alone', async () => {
    const { h, deps } = pipeline()
    const report = await runPipeline(deps, { ...RUN, steps: ['leaver'] })

    expect(Object.keys(report.counts).some((field) => field.startsWith('sync.'))).toBe(false)
    expect(report.counts.day0).toBe(1)
    expect(h.audit.actions()).toContain('leaver.day0.suspend_idp')
  })

  it('can be the sync alone, which then writes no offboarding at all', async () => {
    const { h, deps } = pipeline()
    const report = await runPipeline(deps, { ...RUN, steps: ['sync'] })

    expect(Object.keys(report.counts).some((field) => field.startsWith('sync.'))).toBe(true)
    expect(report.counts.day0 ?? 0).toBe(0)
    expect(h.calls).toEqual([])
  })
})

describe('an HR read that came back short', () => {
  it('aborts as incomplete rather than as an implausible headcount', async () => {
    // The two need different responses: one is a truncated read, the other is
    // a company that appears to have emptied.
    const { deps } = pipeline({
      hris: {
        name: 'fixture',
        fetchAll: async () => {
          throw new HrisIncomplete('page 3 of the HR read did not return')
        },
        testConnection: async () => ({ ok: true, detail: 'fixture' }),
      },
    })
    const report = await runPipeline(deps, RUN)
    expect(report.aborted?.reason).toBe('hris_incomplete')
  })

  it('carries a snapshot warning into the run report rather than dropping it', async () => {
    const source = fixtureHris(HR_SNAPSHOT, EMPLOYED)
    const { deps } = pipeline({
      hris: {
        name: 'fixture',
        fetchAll: async () => ({ ...(await source.fetchAll()), warnings: ['one person has no address'] }),
        testConnection: source.testConnection,
      },
    })
    const report = await runPipeline(deps, RUN)
    expect(report.warnings.join(' ')).toContain('one person has no address')
  })
})

describe('the bookkeeping around a run', () => {
  it('reports a buffered audit sink that could not be flushed', async () => {
    const { deps } = pipeline()
    // Delegated explicitly rather than spread: a class instance loses its
    // methods to an object spread, and the sink is a class.
    const sink: SinkWithExtras = {
      name: deps.audit.name,
      append: (event) => deps.audit.append(event),
      flush: async () => {
        throw new Error('the log volume is full')
      },
    }
    const report = await runPipeline({ ...deps, audit: sink }, { ...RUN, steps: ['leaver'] })
    expect(report.ok).toBe(false)
    expect(report.errors.join(' ')).toContain('the log volume is full')
  })

  it('carries a secondary audit sink failure into the summary', async () => {
    const { deps } = pipeline()
    const sink: SinkWithExtras = {
      name: deps.audit.name,
      append: (event) => deps.audit.append(event),
      warnings: () => ['the log aggregator refused a row'],
    }
    const report = await runPipeline({ ...deps, audit: sink }, { ...RUN, steps: ['leaver'] })
    expect(report.warnings.join(' ')).toContain('the log aggregator refused a row')
  })

  it('warns rather than failing when the run history cannot be written', async () => {
    const { h, deps } = pipeline()
    const report = await runPipeline(
      {
        ...deps,
        state: {
          ...h.state,
          recordRun: async () => {
            throw new Error('the state database is locked')
          },
        },
      },
      { ...RUN, steps: ['leaver'] },
    )
    // The work is done by this point. Losing the history entry is worth
    // saying, not worth undoing anything for.
    expect(report.warnings.join(' ')).toContain('the state database is locked')
    expect(report.counts.day0).toBe(1)
  })

  it('warns when the tombstone baseline cannot be updated', async () => {
    // A person with no account anywhere is closed by the phantom path, so the
    // tombstone count really does grow during this run.
    const { h, deps } = pipeline({ people: [personFixture({ externalIds: {} })] })
    const noAccounts = {
      ...deps,
      idp: { ...deps.idp, findUser: async () => null },
      google: { ...deps.google, getUser: async () => null },
    }
    let writes = 0
    const report = await runPipeline(
      {
        ...noAccounts,
        state: {
          ...h.state,
          setCounter: async (name: string, value: number) => {
            // The first write is the prelude's baseline; the one that fails
            // here is the bump after the run, which must not undo the work.
            writes += 1
            if (writes > 1) throw new Error('the state database is read-only')
            await h.state.setCounter(name, value)
          },
        },
      },
      { ...RUN, steps: ['leaver'] },
    )
    expect(report.warnings.join(' ')).toContain('read-only')
    expect(report.counts.phantom).toBe(1)
  })
})

describe('a liveness ping that cannot be sent', () => {
  it('is reported rather than allowed to fail the run', async () => {
    const throwing: LivenessHttp = {
      request: async () => {
        throw new Error('the ping host is unreachable')
      },
    }
    const { deps } = pipeline({ liveness: true })
    const report = await runPipeline({ ...deps, http: throwing }, { ...RUN, steps: ['leaver'] })

    // The offboarding really happened. A dead-man that could not be fed is
    // worth saying and not worth undoing anything for.
    expect(report.warnings.join(' ')).toContain('the liveness ping could not be sent')
    expect(report.counts.day0).toBe(1)
  })

  it('is skipped without a warning when none is configured', async () => {
    const ping = new PingRecorder()
    const { deps } = pipeline({ ping })
    const report = await runPipeline(deps, { ...RUN, steps: ['leaver'] })

    expect(ping.urls).toEqual([])
    expect(report.warnings.join(' ')).not.toContain('liveness')
  })

  it('is skipped with a warning when the secret was never resolved', async () => {
    const ping = new PingRecorder()
    const { deps } = pipeline({ ping, liveness: true })
    const report = await runPipeline({ ...deps, secrets: undefined }, { ...RUN, steps: ['leaver'] })
    expect(report.warnings.join(' ')).toContain('no HTTP client or resolved secret')
  })
})

describe('an unexpected failure part-way through', () => {
  it('still returns a report, classified as a store problem', async () => {
    const { h, deps } = pipeline()
    const broken = {
      ...deps,
      state: {
        ...h.state,
        getFingerprint: async () => {
          throw new Error('the state database vanished')
        },
        setFingerprint: async () => {
          throw new Error('the state database vanished')
        },
        getCounter: async () => {
          throw new Error('the state database vanished')
        },
      },
    }
    const report = await runPipeline(broken, { ...RUN, steps: ['leaver'] })

    expect(report.aborted?.reason).toBe('store_unavailable')
    expect(report.ok).toBe(false)
    expect(report.errors.join(' ')).toContain('the state database vanished')
  })
})

describe('the circuit breaker inside a pipeline run', () => {
  it('ends the run there, with one notification and no second summary', async () => {
    const crowd = Array.from({ length: 6 }, (_, index) =>
      personFixture({ hrisId: `hris-1${index}`, primaryEmail: `person${index}@example.com` }),
    )
    const { h, deps } = pipeline({ people: crowd })

    const report = await runPipeline(deps, { ...RUN, steps: ['leaver'], runId: 'run-fixed' })

    expect(report.runId).toBe('run-fixed')
    expect(report.aborted?.reason).toBe('circuit_breaker')
    expect(h.notifier.kinds()).toEqual(['run.aborted'])
    // Still recorded in the history: a refusing run is a run, and its absence
    // would look like a schedule that never fired.
    expect(await h.state.lastRun('pipeline')).toMatchObject({ runId: 'run-fixed' })
  })

  it('passes a named person and a signed-for override through to the engine', async () => {
    const { h, deps } = pipeline()
    const report = await runPipeline(deps, {
      ...RUN,
      steps: ['leaver'],
      actor: { kind: 'human', id: 'jane.doe@example.com' },
      allowBulk: 10,
      only: { email: LEAVER_EMAIL },
    })

    expect(report.counts.day0).toBe(1)
    expect(h.audit.actions()).toContain('run.circuit_breaker_override')
  })
})

describe('something thrown that is not an Error', () => {
  it('still reaches the report as text rather than as "undefined"', async () => {
    // Not hypothetical: a rejected promise carrying a string is what several
    // provider libraries do, and a report reading "undefined" tells nobody
    // anything.
    const { h, deps } = pipeline()
    const rude = {
      ...deps,
      hris: {
        name: 'fixture',
        fetchAll: async () => {
          throw 'the HR host refused the connection'
        },
        testConnection: async () => ({ ok: true, detail: 'fixture' }),
      },
    }

    const report = await runPipeline(rude, RUN)

    expect(report.aborted?.reason).toBe('hris_unavailable')
    expect(report.errors.join(' ')).toContain('the HR host refused the connection')
    expect(h.calls).toEqual([])
  })

  it('is reported when the run history refuses it as well', async () => {
    const { h, deps } = pipeline()
    const report = await runPipeline(
      {
        ...deps,
        state: {
          ...h.state,
          recordRun: async () => {
            throw 'the state database is gone'
          },
        },
      },
      { ...RUN, steps: ['leaver'] },
    )
    expect(report.warnings.join(' ')).toContain('the state database is gone')
  })
})
