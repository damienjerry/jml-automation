/**
 * Google as the only account, for setups with no identity provider in front of
 * it (`identity.adapter: none`).
 *
 * Two pieces, kept apart on purpose:
 *
 *  - `GoogleActivation` sets a starter's temporary password on the Google
 *    account, where the reference setup sets it on the identity provider.
 *  - `NoIdentityProvider` stands in for the identity provider in the leaver
 *    engine. It never finds an account, so no identity step is scheduled and
 *    the device gate says plainly that no device inventory was checked.
 *
 * "Already in use" is the rule that matters most here, as it is on the
 * reference setup: a starter's temporary password must never replace a
 * password somebody is already using. Google records the last sign-in; an
 * account that has never signed in reports the Unix epoch. Anything else,
 * including a missing or unreadable value, counts as in use, so the failure
 * direction is a password left alone rather than a working one replaced.
 */

import type { ConnectionCheck } from '../../hris/types.ts'
import type { Outcome } from '../../core/types.ts'
import type { ActivationState, IdentityActivationConnector, IdentityConnector, ProviderUser } from '../types.ts'
import type { GoogleCtx } from './auth.ts'
import { getUser, readUserBody, writePassword } from './directory.ts'

/** Before this, a last sign-in is Google's "never" value rather than a real one. */
const NEVER_SIGNED_IN_BEFORE = Date.UTC(2000, 0, 1)

export function hasSignedIn(lastLoginTime: string | undefined): boolean {
  if (typeof lastLoginTime !== 'string' || lastLoginTime.trim() === '') return true
  const at = Date.parse(lastLoginTime)
  if (Number.isNaN(at)) return true
  return at >= NEVER_SIGNED_IN_BEFORE
}

export class GoogleActivation implements IdentityConnector, IdentityActivationConnector {
  readonly name = 'google'

  private readonly ctx: GoogleCtx

  constructor(ctx: GoogleCtx) {
    this.ctx = ctx
  }

  async findUser(opts: { storedId?: string | null; email: string; aliases?: string[] }): Promise<ProviderUser | null> {
    // A stored id on the row belongs to the identity provider of another
    // setup, so it is not used here. The address and aliases are.
    for (const address of [opts.email, ...(opts.aliases ?? [])]) {
      if (!address) continue
      const found = await getUser(this.ctx, address)
      if (found) return found
    }
    return null
  }

  async getActivationState(id: string): Promise<ActivationState | null> {
    const body = await readUserBody(this.ctx, id)
    if (!body) return null
    return {
      activated: hasSignedIn(body.lastLoginTime),
      mfaConfigured: body.isEnrolledIn2Sv === true,
      suspended: body.suspended === true,
      passwordExpired: body.changePasswordAtNextLogin === true,
    }
  }

  async setTemporaryPassword(id: string, password: string): Promise<Outcome> {
    // Checked again here, seconds after the engine checked, because the cost
    // of being wrong is somebody's working password.
    const body = await readUserBody(this.ctx, id)
    if (!body) return { ok: false, verified: false, error: 'no such account', retryable: false, detail: { reason: 'no_such_account' } }
    if (hasSignedIn(body.lastLoginTime) || body.isEnrolledIn2Sv === true) {
      return { ok: false, verified: false, error: 'the account is already in use; refusing to reset its password', retryable: false, detail: { reason: 'already_in_use' } }
    }
    return writePassword(this.ctx, id, password, 'google directory temporary password')
  }

  /** The password write already requires a change at next sign-in; this confirms it. */
  async expirePassword(id: string): Promise<Outcome> {
    const body = await readUserBody(this.ctx, id)
    if (!body) return { ok: false, verified: false, error: 'no such account', retryable: false, detail: { reason: 'no_such_account' } }
    return body.changePasswordAtNextLogin === true
      ? { ok: true, verified: true, detail: { passwordExpired: true } }
      : { ok: false, verified: false, error: 'the account does not show a pending password change', retryable: true, detail: { passwordExpired: false } }
  }

  // Never reached: with no identity provider these steps are not scheduled.
  async suspendUser(): Promise<Outcome> {
    return notScheduled()
  }
  async deleteUser(): Promise<Outcome> {
    return notScheduled()
  }

  async testConnection(): Promise<ConnectionCheck> {
    return { ok: true, detail: 'no separate identity provider: the Google account is the account (identity.adapter: none)' }
  }
}

export class NoIdentityProvider implements IdentityConnector {
  readonly name = 'none'

  async findUser(): Promise<ProviderUser | null> {
    return null
  }
  async suspendUser(): Promise<Outcome> {
    return notScheduled()
  }
  async deleteUser(): Promise<Outcome> {
    return notScheduled()
  }
  async testConnection(): Promise<ConnectionCheck> {
    return { ok: true, detail: 'none configured (identity.adapter: none); Google Workspace is the only account' }
  }
}

function notScheduled(): Outcome {
  return { ok: false, verified: false, error: 'there is no identity provider in this setup, so this step does not run', retryable: false }
}
