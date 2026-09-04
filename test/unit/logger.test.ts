import { describe, expect, it } from 'vitest'
import { createLogger, nullLogger } from '../../src/core/logger.ts'
import { FakeClock } from '../../src/core/clock.ts'
import { redactor, REDACTED } from '../../src/config/redact.ts'

function capture(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = []
  const logger = createLogger({
    write: (line) => lines.push(line),
    clock: new FakeClock('2026-09-04T09:00:00Z'),
    ...(level ? { level } : {}),
  })
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) }
}

describe('createLogger', () => {
  it('writes one JSON line carrying the level and the instant', () => {
    const { logger, parsed } = capture()
    logger.info('sync finished', { created: 2 })
    expect(parsed()[0]).toEqual({ at: '2026-09-04T09:00:00.000Z', level: 'info', message: 'sync finished', created: 2 })
  })

  it('withholds a line below the configured level', () => {
    const { logger, lines } = capture('warn')
    logger.info('not interesting')
    logger.warn('interesting')
    expect(lines).toHaveLength(1)
  })

  it('carries child fields on every line', () => {
    const { logger, parsed } = capture()
    logger.child({ runId: 'run-1' }).child({ hrisId: 'HR-1' }).info('leg done')
    expect(parsed()[0]).toMatchObject({ runId: 'run-1', hrisId: 'HR-1' })
  })

  it('serialises an Error instead of losing it to an empty object', () => {
    const { logger, parsed } = capture()
    logger.error('leg failed', { err: new TypeError('boom') })
    expect(parsed()[0]?.err).toMatchObject({ name: 'TypeError', message: 'boom' })
  })

  it('serialises a Set and a Map rather than dropping their contents', () => {
    const { logger, parsed } = capture()
    logger.info('counts', { seen: new Set(['a']), byStatus: new Map([['active', 1]]) })
    expect(parsed()[0]).toMatchObject({ seen: ['a'], byStatus: { active: 1 } })
  })

  it('redacts a registered credential wherever it appears in a line', () => {
    // The last line of defence. A credential rarely escapes through the code
    // that handles it; it escapes because somebody logged a whole request
    // object while debugging.
    redactor.register('credential-in-a-log-line')
    const { logger, lines } = capture()
    logger.warn('request failed for credential-in-a-log-line', { request: { headers: { authorization: 'Bearer credential-in-a-log-line' } } })
    expect(lines[0]).not.toContain('credential-in-a-log-line')
    expect(lines[0]).toContain(REDACTED)
  })

  it('prints a readable single line when asked to be pretty', () => {
    const lines: string[] = []
    const logger = createLogger({ write: (l) => lines.push(l), pretty: true })
    logger.info('sync finished', { created: 2 })
    expect(lines[0]).toBe('INFO  sync finished created=2')
  })
})

describe('nullLogger', () => {
  it('discards everything and keeps returning itself', () => {
    const logger = nullLogger()
    expect(() => logger.child({ a: 1 }).error('ignored')).not.toThrow()
    expect(logger.child({}).child({})).toBe(logger)
  })
})
