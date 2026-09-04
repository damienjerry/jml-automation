import { describe, expect, it } from 'vitest'

import { listLicences, revokeLicence } from '../../src/connectors/google/licensing.ts'
import { GateError } from '../../src/connectors/types.ts'
import { googleCtx } from '../fixtures/google/harness.ts'

const ASSIGNMENT = {
  productId: 'Google-Apps',
  skuId: 'example-standard-sku',
  skuName: 'Example Standard',
  userId: 'jane.doe@example.com',
}

describe('reading what a person holds', () => {
  it('checks each named SKU directly when config names them', async () => {
    const { ctx, http } = googleCtx(
      [
        {
          method: 'GET',
          match: '/sku/example-standard-sku/user/',
          respond: { status: 200, body: ASSIGNMENT },
        },
        {
          method: 'GET',
          match: '/sku/example-archive-sku/user/',
          respond: { status: 404, body: {} },
        },
      ],
      { licenceSkuIds: ['example-standard-sku', 'example-archive-sku'] },
    )

    expect(await listLicences(ctx, 'jane.doe@example.com')).toEqual([
      { productId: 'Google-Apps', skuId: 'example-standard-sku', skuName: 'Example Standard' },
    ])
    // Two direct reads, no customer-wide listing.
    expect(http.apiRequests()).toHaveLength(2)
  })

  it('finds every SKU the account holds when none are named', async () => {
    const { ctx } = googleCtx(
      [
        {
          method: 'GET',
          match: '/product/Google-Apps/users?',
          respond: [
            {
              status: 200,
              body: {
                items: [
                  { ...ASSIGNMENT, userId: 'john.doe@example.com' },
                  ASSIGNMENT,
                ],
                nextPageToken: 'page-2',
              },
            },
            {
              status: 200,
              body: {
                items: [{ ...ASSIGNMENT, skuId: 'example-archive-sku', skuName: 'Example Archive' }],
              },
            },
          ],
        },
      ],
      { licensingCustomerId: 'example.com' },
    )

    const held = await listLicences(ctx, 'jane.doe@example.com')

    // Both seats, not just the first: an account can hold more than one, and
    // revoking a single hard-coded edition leaves the rest billing.
    expect(held.map((h) => h.skuId)).toEqual(['example-standard-sku', 'example-archive-sku'])
  })

  it('refuses to answer "no licences" when it cannot look', async () => {
    const { ctx } = googleCtx([])

    await expect(listLicences(ctx, 'jane.doe@example.com')).rejects.toBeInstanceOf(GateError)
  })

  it('refuses to answer when the listing failed', async () => {
    const { ctx } = googleCtx(
      [{ method: 'GET', match: '/users?', respond: { status: 500, body: {} } }],
      { licensingCustomerId: 'example.com' },
    )

    await expect(listLicences(ctx, 'jane.doe@example.com')).rejects.toBeInstanceOf(GateError)
  })

  it('refuses to answer when the listing ran out of pages', async () => {
    const { ctx } = googleCtx(
      [
        {
          method: 'GET',
          match: '/users?',
          respond: { status: 200, body: { items: [], nextPageToken: 'forever' } },
        },
      ],
      { licensingCustomerId: 'example.com' },
    )

    await expect(listLicences(ctx, 'jane.doe@example.com')).rejects.toThrow('page budget')
  })

  it('holds no licences when no products are configured', async () => {
    const { ctx, http } = googleCtx([], { licenceProductIds: [] })

    expect(await listLicences(ctx, 'jane.doe@example.com')).toEqual([])
    expect(http.requests).toHaveLength(0)
  })
})

describe('releasing a seat', () => {
  it('is verified once the assignment reads back gone', async () => {
    const { ctx, http } = googleCtx([
      { method: 'DELETE', match: '/sku/', respond: { status: 204, body: {} } },
      { method: 'GET', match: '/sku/', respond: { status: 404, body: {} } },
    ])

    const outcome = await revokeLicence(
      ctx,
      'jane.doe@example.com',
      'Google-Apps',
      'example-standard-sku',
    )

    expect(outcome).toMatchObject({ ok: true, verified: true })
    expect(outcome.alreadyAbsent).toBeUndefined()
    expect(http.apiRequests().map((r) => r.method)).toEqual(['DELETE', 'GET'])
  })

  it('refuses to claim success while the assignment is still there', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/sku/', respond: { status: 200, body: {} } },
      { method: 'GET', match: '/sku/', respond: { status: 200, body: ASSIGNMENT } },
    ])

    expect(
      await revokeLicence(ctx, 'jane.doe@example.com', 'Google-Apps', 'example-standard-sku'),
    ).toMatchObject({ ok: false, verified: false, retryable: true })
  })

  it('marks a Google-side fault retryable', async () => {
    const { ctx } = googleCtx([
      { method: 'DELETE', match: '/sku/', respond: { status: 503, body: {} } },
    ])

    expect(
      await revokeLicence(ctx, 'jane.doe@example.com', 'Google-Apps', 'example-standard-sku'),
    ).toMatchObject({ ok: false, verified: false, retryable: true })
  })
})
