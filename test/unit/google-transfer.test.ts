import { describe, expect, it } from 'vitest'

import {
  findExistingTransfer,
  getTransferStatus,
  resolveDriveApplicationId,
  transferDrive,
} from '../../src/connectors/google/transfer.ts'
import { directoryUser, googleCtx, type Rule } from '../fixtures/google/harness.ts'

const APPLICATIONS: Rule = {
  method: 'GET',
  match: '/datatransfer/v1/applications',
  respond: {
    status: 200,
    body: {
      applications: [
        { id: '100000000000001', name: 'Calendar' },
        { id: '100000000000002', name: 'Drive and Docs' },
      ],
    },
  },
}

function directoryRules(recipientPresent = true): Rule[] {
  return [
    {
      method: 'GET',
      match: '/users/jane.doe',
      respond: { status: 200, body: directoryUser({ id: 'leaver-id' }) },
    },
    {
      method: 'GET',
      match: '/users/john.doe',
      respond: recipientPresent
        ? { status: 200, body: directoryUser({ id: 'recipient-id' }) }
        : { status: 404, body: {} },
    },
  ]
}

const NO_EXISTING_TRANSFERS: Rule = {
  method: 'GET',
  match: '/transfers?',
  respond: { status: 200, body: { dataTransfers: [] } },
}

describe('resolving the Drive application', () => {
  it('reads the id out of the provider list rather than assuming one', async () => {
    const { ctx } = googleCtx([APPLICATIONS])

    expect(await resolveDriveApplicationId(ctx)).toBe('100000000000002')
  })

  it('pages the application list', async () => {
    const { ctx } = googleCtx([
      {
        method: 'GET',
        match: '/applications',
        respond: [
          { status: 200, body: { applications: [{ id: '1', name: 'Calendar' }], nextPageToken: 'p2' } },
          { status: 200, body: { applications: [{ id: '2', name: 'Drive and Docs' }] } },
        ],
      },
    ])

    expect(await resolveDriveApplicationId(ctx)).toBe('2')
  })

  it('answers null when this tenancy has no such application', async () => {
    const { ctx } = googleCtx([
      { method: 'GET', match: '/applications', respond: { status: 200, body: { applications: [] } } },
    ])

    expect(await resolveDriveApplicationId(ctx)).toBeNull()
  })
})

describe('starting a hand-over', () => {
  it('resolves both ids and sends the resolved application id', async () => {
    const { ctx, http } = googleCtx([
      ...directoryRules(),
      NO_EXISTING_TRANSFERS,
      APPLICATIONS,
      {
        method: 'POST',
        match: '/transfers',
        respond: { status: 200, body: { id: 'transfer-1', overallTransferStatusCode: 'inProgress' } },
      },
      {
        method: 'GET',
        match: '/transfers/transfer-1',
        respond: { status: 200, body: { id: 'transfer-1', overallTransferStatusCode: 'inProgress' } },
      },
    ])

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    expect(outcome.ok).toBe(true)
    expect(outcome.transferId).toBe('transfer-1')
    // Started is not finished: only a polled completion may be recorded as done.
    expect(outcome.verified).toBe(false)

    const insert = http.apiRequests().find((r) => r.method === 'POST')!
    expect(insert.json).toEqual({
      oldOwnerUserId: 'leaver-id',
      newOwnerUserId: 'recipient-id',
      applicationDataTransfers: [
        {
          applicationId: '100000000000002',
          applicationTransferParams: [{ key: 'PRIVACY_LEVEL', value: ['PRIVATE', 'SHARED'] }],
        },
      ],
    })
  })

  it('reports the leaver having no account as already absent', async () => {
    const { ctx, http } = googleCtx([
      { method: 'GET', match: '/users/jane.doe', respond: { status: 404, body: {} } },
    ])

    expect(await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')).toMatchObject({
      ok: false,
      alreadyAbsent: true,
    })
    expect(http.apiRequests().some((r) => r.method === 'POST')).toBe(false)
  })

  it('fails loudly when the recipient cannot be resolved, and starts nothing', async () => {
    const { ctx, http } = googleCtx(directoryRules(false))

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('recipient')
    expect(http.apiRequests().some((r) => r.method === 'POST')).toBe(false)
  })

  it('fails when the application is missing rather than sending a guessed id', async () => {
    const { ctx, http } = googleCtx([
      ...directoryRules(),
      NO_EXISTING_TRANSFERS,
      { method: 'GET', match: '/applications', respond: { status: 200, body: { applications: [] } } },
    ])

    expect(await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')).toMatchObject({
      ok: false,
      verified: false,
    })
    expect(http.apiRequests().some((r) => r.method === 'POST')).toBe(false)
  })

  it('treats an insert with no transfer id as a failure', async () => {
    const { ctx } = googleCtx([
      ...directoryRules(),
      NO_EXISTING_TRANSFERS,
      APPLICATIONS,
      { method: 'POST', match: '/transfers', respond: { status: 200, body: {} } },
    ])

    expect(await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')).toMatchObject({
      ok: false,
      retryable: true,
    })
  })

  it('marks a rate-limited insert retryable', async () => {
    const { ctx } = googleCtx([
      ...directoryRules(),
      NO_EXISTING_TRANSFERS,
      APPLICATIONS,
      { method: 'POST', match: '/transfers', respond: { status: 429, body: {} } },
    ])

    expect(await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')).toMatchObject({
      ok: false,
      retryable: true,
    })
  })
})

describe('polling a hand-over', () => {
  it('reports a completed transfer as done', async () => {
    const { ctx } = googleCtx([
      {
        method: 'GET',
        match: '/transfers/transfer-1',
        respond: { status: 200, body: { overallTransferStatusCode: 'completed' } },
      },
    ])

    expect(await getTransferStatus(ctx, 'transfer-1')).toEqual({ state: 'completed', done: true })
  })

  it('reports a failed transfer as done, so it stops being polled', async () => {
    const { ctx } = googleCtx([
      {
        method: 'GET',
        match: '/transfers/',
        respond: { status: 200, body: { overallTransferStatusCode: 'failed' } },
      },
    ])

    expect(await getTransferStatus(ctx, 'transfer-1')).toEqual({ state: 'failed', done: true })
  })

  it('never reports an unreadable transfer as done', async () => {
    const { ctx } = googleCtx([
      { method: 'GET', match: '/transfers/', respond: { status: 500, body: {} } },
    ])

    expect(await getTransferStatus(ctx, 'transfer-1')).toEqual({ state: 'unknown', done: false })
  })

  it('throws rather than reporting no existing transfers when the list fails', async () => {
    const { ctx } = googleCtx([
      { method: 'GET', match: '/transfers?', respond: { status: 500, body: {} } },
    ])

    await expect(findExistingTransfer(ctx, 'leaver-id')).rejects.toThrow('500')
  })
})
