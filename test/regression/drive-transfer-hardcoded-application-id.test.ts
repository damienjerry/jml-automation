/**
 * Three failures in one shape, all around the file hand-over.
 *
 * The application id was a numeric literal copied from one tenancy. It is
 * per-tenancy, and a wrong one is accepted without transferring anything.
 *
 * The recipient was resolved by matching a manager's display name in a
 * spreadsheet-like store. When that missed, the transfer was skipped, the
 * account was suspended anyway, and a week later it was deleted with the files
 * still inside it. A skipped hand-over must be loud.
 *
 * The insert is not idempotent. A run interrupted between inserting the
 * transfer and recording its id would start a second one on its next attempt.
 * The caller persists the id; the connector also looks for an existing
 * transfer, so both halves have to fail before a duplicate can happen.
 */

import { describe, expect, it } from 'vitest'

import { transferDrive } from '../../src/connectors/google/transfer.ts'
import { directoryUser, googleCtx, type Rule } from '../fixtures/google/harness.ts'

const PEOPLE: Rule[] = [
  {
    method: 'GET',
    match: '/users/jane.doe',
    respond: { status: 200, body: directoryUser({ id: 'leaver-id' }) },
  },
  {
    method: 'GET',
    match: '/users/john.doe',
    respond: { status: 200, body: directoryUser({ id: 'recipient-id' }) },
  },
]

const APPLICATIONS: Rule = {
  method: 'GET',
  match: '/applications',
  respond: {
    status: 200,
    body: {
      applications: [
        { id: '900000000000001', name: 'Calendar' },
        { id: '900000000000002', name: 'Drive and Docs' },
      ],
    },
  },
}

describe('the application id comes from the tenancy', () => {
  it('sends the id this tenancy reported', async () => {
    const { ctx, http } = googleCtx([
      ...PEOPLE,
      { method: 'GET', match: '/transfers?', respond: { status: 200, body: { dataTransfers: [] } } },
      APPLICATIONS,
      {
        method: 'POST',
        match: '/transfers',
        respond: { status: 200, body: { id: 'transfer-1', overallTransferStatusCode: 'inProgress' } },
      },
      {
        method: 'GET',
        match: '/transfers/',
        respond: { status: 200, body: { overallTransferStatusCode: 'inProgress' } },
      },
    ])

    await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    const insert = http.apiRequests().find((r) => r.method === 'POST')!
    const sent = insert.json as {
      applicationDataTransfers: { applicationId: string }[]
      oldOwnerUserId: string
      newOwnerUserId: string
    }
    expect(sent.applicationDataTransfers[0]!.applicationId).toBe('900000000000002')
    // Ids, never addresses: the API accepts an address-shaped value and
    // transfers nothing.
    expect(sent.oldOwnerUserId).toBe('leaver-id')
    expect(sent.newOwnerUserId).toBe('recipient-id')
  })

  it('refuses to transfer when this tenancy has no such application', async () => {
    const { ctx, http } = googleCtx([
      ...PEOPLE,
      { method: 'GET', match: '/transfers?', respond: { status: 200, body: { dataTransfers: [] } } },
      { method: 'GET', match: '/applications', respond: { status: 200, body: { applications: [] } } },
    ])

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    expect(outcome.ok).toBe(false)
    expect(http.apiRequests().some((r) => r.method === 'POST')).toBe(false)
  })
})

describe('no recipient means no quiet skip', () => {
  it('fails, names the recipient, and starts nothing', async () => {
    const { ctx, http } = googleCtx([
      {
        method: 'GET',
        match: '/users/jane.doe',
        respond: { status: 200, body: directoryUser({ id: 'leaver-id' }) },
      },
      { method: 'GET', match: '/users/john.doe', respond: { status: 404, body: {} } },
    ])

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    expect(outcome.ok).toBe(false)
    expect(outcome.verified).toBe(false)
    expect(outcome.detail).toMatchObject({ recipient: 'john.doe@example.com' })
    expect(http.apiRequests().some((r) => r.method === 'POST')).toBe(false)
  })
})

describe('an interrupted run resumes rather than duplicating', () => {
  it('reuses a transfer the provider already holds for this person', async () => {
    const { ctx, http } = googleCtx([
      ...PEOPLE,
      {
        method: 'GET',
        match: '/transfers?',
        respond: {
          status: 200,
          body: {
            dataTransfers: [
              { id: 'transfer-earlier', overallTransferStatusCode: 'inProgress' },
            ],
          },
        },
      },
    ])

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    expect(outcome).toMatchObject({ ok: true, verified: false, transferId: 'transfer-earlier' })
    expect(outcome.detail).toMatchObject({ reused: true })
    expect(http.apiRequests().some((r) => r.method === 'POST')).toBe(false)
  })

  it('starts a new transfer when the only earlier one failed', async () => {
    const { ctx, http } = googleCtx([
      ...PEOPLE,
      {
        method: 'GET',
        match: '/transfers?',
        respond: {
          status: 200,
          body: { dataTransfers: [{ id: 'transfer-earlier', overallTransferStatusCode: 'failed' }] },
        },
      },
      APPLICATIONS,
      {
        method: 'POST',
        match: '/transfers',
        respond: { status: 200, body: { id: 'transfer-2', overallTransferStatusCode: 'inProgress' } },
      },
      {
        method: 'GET',
        match: '/transfers/',
        respond: { status: 200, body: { overallTransferStatusCode: 'inProgress' } },
      },
    ])

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    expect(outcome.transferId).toBe('transfer-2')
    expect(http.apiRequests().filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('never reports a started transfer as a finished one', async () => {
    const { ctx } = googleCtx([
      ...PEOPLE,
      { method: 'GET', match: '/transfers?', respond: { status: 200, body: { dataTransfers: [] } } },
      APPLICATIONS,
      {
        method: 'POST',
        match: '/transfers',
        respond: { status: 200, body: { id: 'transfer-1' } },
      },
      {
        method: 'GET',
        match: '/transfers/',
        respond: { status: 200, body: { overallTransferStatusCode: 'inProgress' } },
      },
    ])

    const outcome = await transferDrive(ctx, 'jane.doe@example.com', 'john.doe@example.com')

    // Only a polled completion may be written down as a hand-over, because the
    // deletion gate is built on it.
    expect(outcome.ok).toBe(true)
    expect(outcome.verified).toBe(false)
  })
})
