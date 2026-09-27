/**
 * Bindings: who holds a machine, who is going to hold it, and the two
 * dispositions that clear the gate without touching the machine.
 *
 * This is the primitive an earlier design never had. Its
 * blocked-deletion message told operators to unbind the person in the vendor
 * console, because no code could do it: the only clearing action anybody had
 * implemented was deleting the device record, which is the one action that
 * strands a machine. So the safe path did not exist and the dangerous one was
 * the default.
 *
 * Both dispositions here leave the machine enrolled, managed, and with its
 * disk-encryption recovery key still escrowed. Nothing is uninstalled and
 * nothing is deleted. That is what makes returning a device to the spares
 * account the default: it clears the day-7 block at no risk at all.
 *
 * The order in a reassignment is not cosmetic. The new owner is bound and read
 * back FIRST, and only then is the leaver's binding removed, so the machine is
 * never briefly owned by nobody. Reversed, a failure in the middle leaves an
 * unowned machine that no report attributes to anyone.
 */

import type { Outcome } from '../../core/types.ts'
import { describe, WRITING_DISPOSITIONS } from './preflight.ts'
import type { DeviceDeps, DevicePreflight, DispositionRequest, StepContext } from './preflight.ts'

/**
 * Decide which single binding would be removed.
 *
 * One binding, named, or none. Removing every direct owner because the request
 * did not say which one would take a machine away from whoever else holds it.
 */
export async function planOwnerBinding(deps: DeviceDeps, req: DispositionRequest, plan: DevicePreflight): Promise<void> {
  const owners = plan.directOwnerIds

  if (req.expectedOwnerHrisId) {
    if (!deps.people) {
      plan.refusals.push({
        code: 'owner_unknown',
        detail: 'an expected owner was given but this caller has no people store to resolve it against',
      })
      return
    }
    const person = await deps.people.get(req.expectedOwnerHrisId)
    if (!person) {
      plan.refusals.push({ code: 'owner_unknown', detail: 'no person is held under that HR id' })
      return
    }
    const providerId = person.externalIds.jumpcloudUserId ?? null
    if (!providerId) {
      plan.refusals.push({
        code: 'owner_unknown',
        detail: 'that person has no identity-provider account recorded, so their bindings cannot be checked',
      })
      return
    }
    if (!owners.includes(providerId)) {
      plan.refusals.push({
        code: 'owner_mismatch',
        detail:
          'this machine is not bound to the person being offboarded; it has ' +
          owners.length +
          ' direct binding(s) and none of them is theirs',
      })
      return
    }
    plan.unbindUserId = providerId
    return
  }

  if (req.leaverUserId) {
    if (!owners.includes(req.leaverUserId)) {
      plan.refusals.push({
        code: 'owner_mismatch',
        detail: 'the account named in the request is not directly bound to this machine',
      })
      return
    }
    plan.unbindUserId = req.leaverUserId
    return
  }

  if (!WRITING_DISPOSITIONS.includes(req.disposition) || req.disposition === 'handover') return

  const [only] = owners
  if (owners.length === 1 && only) {
    plan.unbindUserId = only
    plan.warnings.push('the binding to remove was inferred from the single direct owner of this machine')
    return
  }
  if (owners.length === 0) {
    plan.warnings.push('nothing is bound directly to this machine, so there is no binding to remove')
    return
  }
  plan.refusals.push({
    code: 'ambiguous_owner',
    detail:
      'this machine has ' +
      owners.length +
      ' direct bindings and the request did not say which one to remove; name the person or the account',
  })
}

/** Resolve the spares account or the new owner, read-only. */
export async function planRebindTarget(
  deps: DeviceDeps,
  req: DispositionRequest,
  plan: DevicePreflight,
): Promise<void> {
  if (req.disposition === 'reassign') {
    if (req.rebindToUserId) {
      plan.rebindUserId = req.rebindToUserId
      plan.rebindLabel = req.rebindToUserId
      return
    }
    if (!req.rebindToEmail) {
      plan.refusals.push({
        code: 'no_rebind_target',
        detail: 'a reassignment needs the person the machine is going to; none was given',
      })
      return
    }
    const found = await findAccount(deps, req.rebindToEmail, plan)
    if (!found) {
      plan.refusals.push({
        code: 'no_rebind_target',
        detail: 'the new owner could not be resolved to one provider account',
      })
      return
    }
    plan.rebindUserId = found.id
    plan.rebindLabel = req.rebindToEmail
    return
  }

  if (req.disposition !== 'return_to_pool') return

  const poolEmail = (deps.config.identity.jumpcloud?.poolUserEmail ?? null)
  if (!poolEmail) return
  const found = await findAccount(deps, poolEmail, plan)
  if (!found) {
    // Not a refusal. Removing the leaver's binding clears the gate on its own,
    // and refusing the safe half of the work because the optional half is
    // misconfigured leaves the machine bound to somebody who has left.
    plan.warnings.push('the spares account in config could not be resolved, so the machine will be left unbound')
    return
  }
  plan.rebindUserId = found.id
  plan.rebindLabel = poolEmail
}

async function findAccount(
  deps: DeviceDeps,
  email: string,
  plan: DevicePreflight,
): Promise<{ id: string } | null> {
  if (!deps.identity) {
    plan.warnings.push('no identity connector was supplied, so an address could not be resolved to an account')
    return null
  }
  try {
    return await deps.identity.findUser({ email })
  } catch (err) {
    plan.warnings.push('resolving an account by address failed: ' + describe(err))
    return null
  }
}

/**
 * Hand the machine back to the spares account.
 *
 * The rebind is optional and its failure does not undo the unbind: the gate is
 * cleared by the leaver no longer being bound, and a machine sitting unbound in
 * a spares cupboard is a tidiness problem, not a security one.
 */
export async function returnToPool(
  deps: DeviceDeps,
  _req: DispositionRequest,
  plan: DevicePreflight,
  ctx: StepContext,
): Promise<void> {
  await removeLeaverBinding(deps, plan, ctx)
  if (!plan.rebindUserId) return

  const label = 'bind the spares account ' + (plan.rebindLabel ?? 'in config') + ' to ' + plan.displayName
  await ctx.run('rebind', 'device.bindUser', label, () =>
    deps.devices.bindUser(asString(plan.rebindUserId), plan.systemId),
  )
}

/**
 * Give the machine to somebody else.
 *
 * Bind, read back, and only then unbind. If the bind cannot be verified the
 * leaver's binding is left alone and the gate stays blocked, which is the
 * honest outcome: we have not established that anybody else holds the machine.
 */
export async function reassign(
  deps: DeviceDeps,
  _req: DispositionRequest,
  plan: DevicePreflight,
  ctx: StepContext,
): Promise<void> {
  const newOwner = plan.rebindUserId
  if (!newOwner) {
    // The preflight refuses this case, so reaching it means the caller skipped
    // the plan. Recorded as a failure rather than thrown, so the report still
    // names the machine.
    ctx.record('rebind', 'no new owner was resolved for ' + plan.displayName, {
      state: 'failed',
      verified: false,
      attempts: 0,
      error: 'a reassignment needs a new owner and none was resolved',
    })
    return
  }

  const bindLabel = 'bind ' + (plan.rebindLabel ?? newOwner) + ' to ' + plan.displayName
  const bound = await ctx.run('rebind', 'device.bindUser', bindLabel, () =>
    deps.devices.bindUser(newOwner, plan.systemId),
  )
  if (!bound.ok || !bound.verified) {
    ctx.record('unbind', 'leave the previous binding on ' + plan.displayName + ' until the new owner is proven', {
      state: 'failed',
      verified: false,
      attempts: 0,
      error: 'the new owner could not be confirmed bound, so the previous binding was left in place',
    })
    return
  }

  await removeLeaverBinding(deps, plan, ctx)
}

/**
 * Remove exactly one binding, the one the plan named.
 *
 * A machine with nothing bound to it is already in the state this step is
 * trying to reach, so it records that rather than failing: an idempotent step
 * that fails on a repeat run makes an operator afraid to re-run it.
 */
async function removeLeaverBinding(
  deps: DeviceDeps,
  plan: DevicePreflight,
  ctx: StepContext,
): Promise<Outcome> {
  const userId = plan.unbindUserId
  if (!userId) {
    const leg = { state: 'already_absent' as const, verified: true, attempts: 0 }
    ctx.record('unbind', 'nothing is bound directly to ' + plan.displayName, leg)
    return { ok: true, verified: true, alreadyAbsent: true }
  }
  const label = 'remove the direct user binding from ' + plan.displayName
  return ctx.run('unbind', 'device.unbindUser', label, () => deps.devices.unbindUser(userId, plan.systemId))
}

/**
 * A non-null assertion with a reason.
 *
 * Called only where the plan has already established the value, and it returns
 * a failed outcome rather than throwing if that ever stops being true.
 */
function asString(value: string | null): string {
  if (value === null) throw new Error('a bind was attempted with no account resolved')
  return value
}
