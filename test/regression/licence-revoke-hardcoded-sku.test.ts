/**
 * Failure this prevents: the revoke named one SKU literally, so an account
 * holding a second edition kept a paid seat after its owner had left, and the
 * run reported the licence as revoked. Nothing in the report said which SKU had
 * been looked at, so the remaining seat was invisible.
 *
 * The SKUs come from the provider now: list what the account holds, then revoke
 * each one. A failed list must not read as "holds nothing", because that is
 * indistinguishable from a clean run and leaves the seat billing silently.
 */

import { describe, expect, it } from 'vitest'

import { listLicences, revokeLicence } from '../../src/connectors/google/licensing.ts'
import { GateError } from '../../src/connectors/types.ts'
import { googleCtx } from '../fixtures/google/harness.ts'

describe('every seat, not the one somebody typed into the code', () => {
  it('finds both editions an account holds', async () => {
    const { ctx } = googleCtx(
      [
        {
          method: 'GET',
          match: '/product/Google-Apps/users?',
          respond: {
            status: 200,
            body: {
              items: [
                { productId: 'Google-Apps', skuId: 'example-standard-sku', userId: 'jane.doe@example.com' },
                { productId: 'Google-Apps', skuId: 'example-archive-sku', userId: 'jane.doe@example.com' },
                { productId: 'Google-Apps', skuId: 'example-standard-sku', userId: 'john.doe@example.com' },
              ],
            },
          },
        },
      ],
      { licensingCustomerId: 'example.com' },
    )

    const held = await listLicences(ctx, 'jane.doe@example.com')

    expect(held.map((h) => h.skuId)).toEqual(['example-standard-sku', 'example-archive-sku'])
  })

  it('revokes each SKU it was given, product by product', async () => {
    const revoked: string[] = []
    const { ctx } = googleCtx([
      {
        method: 'DELETE',
        match: '/sku/',
        respond: (req) => {
          revoked.push(req.url)
          return { status: 204, body: {} }
        },
      },
      { method: 'GET', match: '/sku/', respond: { status: 404, body: {} } },
    ])

    for (const skuId of ['example-standard-sku', 'example-archive-sku']) {
      const outcome = await revokeLicence(ctx, 'jane.doe@example.com', 'Google-Apps', skuId)
      expect(outcome.verified).toBe(true)
    }

    expect(revoked).toHaveLength(2)
    expect(revoked[0]).toContain('example-standard-sku')
    expect(revoked[1]).toContain('example-archive-sku')
  })

  it('refuses to report an empty licence list when the read failed', async () => {
    const { ctx } = googleCtx(
      [{ method: 'GET', match: '/users?', respond: { status: 403, body: {} } }],
      { licensingCustomerId: 'example.com' },
    )

    await expect(listLicences(ctx, 'jane.doe@example.com')).rejects.toBeInstanceOf(GateError)
  })

  it('refuses to guess when neither SKUs nor a customer id are configured', async () => {
    const { ctx } = googleCtx([])

    await expect(listLicences(ctx, 'jane.doe@example.com')).rejects.toThrow('licenceSkuIds')
  })
})
