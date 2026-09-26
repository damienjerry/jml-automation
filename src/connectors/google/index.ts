/**
 * The Google Workspace connector, assembled from its parts.
 *
 * Each part is a module of plain functions over a context, so a test can call
 * one method with one fake HTTP client and no wiring. This file holds the
 * wiring and nothing else: no request building, no status interpretation.
 *
 * There is no module-level state. Two connectors built against two tenancies
 * in the same process share nothing, which matters because the token cache is
 * the one place where crossing them would hand one tenancy's bearer to the
 * other.
 */

import type { HttpClient } from '../../core/http.ts'
import type { ConnectionCheck } from '../../hris/types.ts'
import type { GoogleProvisioningConnector, GoogleWorkspaceConnector, ProviderUser } from '../types.ts'
import {
  createGoogleAuth,
  subjectFor,
  type GoogleAuth,
  type GoogleConnectorConfig,
  type GoogleCtx,
} from './auth.ts'
import { closeUser, deleteUser, getUser, listUsers, resolveUserId, suspendUser, getMailboxState, moveToOrgUnit, signOutUser } from './directory.ts'
import { GoogleActivation } from './identity.ts'
import { sendMail, setVacationResponder } from './gmail.ts'
import { listLicences, revokeLicence, type LicenceAssignment, assignLicence } from './licensing.ts'
import { getTransferStatus, transferDrive } from './transfer.ts'
import { REQUIRED_SCOPE_USES, SCOPE_USES, type GoogleScope } from './scopes.ts'

export type { GoogleConnectorConfig, GoogleCtx, GoogleAuth } from './auth.ts'
export { GoogleAuthError, createGoogleAuth } from './auth.ts'
export { GOOGLE_SCOPES, SCOPE_USES, REQUIRED_SCOPE_USES } from './scopes.ts'
export type { GoogleScope, ScopeUse, SubjectKind } from './scopes.ts'
export type { LicenceAssignment } from './licensing.ts'
export type { TransferState } from './transfer.ts'
// Exposed so a caller resolving the hand-over application id does not have to
// reach past this module into the parts.
export { findExistingTransfer, resolveDriveApplicationId } from './transfer.ts'

const DOCS_ANCHOR = 'docs/credentials.md#google-workspace'

/** One scope's probe result, as `jml doctor` prints it. */
export interface ScopeReport {
  scope: GoogleScope
  ok: boolean
  /** Who the probe impersonated, or null for the service account itself. */
  subject: string | null
  /** Status from the token endpoint. 0 means the endpoint was unreachable. */
  status: number
  /** The OAuth error code only, never a body. */
  error?: string
  required: boolean
  /** Connector methods that stop working without this scope. */
  neededBy: readonly string[]
  breaksWithout: string
}

/** Extends the shared contract with the Google-specific reads. */
export interface GoogleConnector extends GoogleWorkspaceConnector, GoogleProvisioningConnector {
  /** Every account in the tenancy, listed by customer. */
  listUsers(): Promise<{ users: ProviderUser[]; complete: boolean }>
  /** The account's Google id, which the transfer API needs. */
  resolveUserId(email: string): Promise<string | null>
  /** All seats this account holds, with SKU names when the provider gives them. */
  listLicenceAssignments(email: string): Promise<LicenceAssignment[]>
  /** Starter activation on the Google account, for setups with no identity provider. */
  activation: GoogleActivation
  /** `armed` adds the optional scopes an armed action needs. */
  probeScopes(opts?: { mailbox?: string; armed?: readonly string[] }): Promise<ScopeReport[]>
}

export interface GoogleConnectorDeps {
  http: HttpClient
  /** Supplied by tests; the connector builds its own from the key otherwise. */
  auth?: GoogleAuth
  now?: () => number
}

export function createGoogleConnector(
  cfg: GoogleConnectorConfig,
  deps: GoogleConnectorDeps,
): GoogleConnector {
  const auth =
    deps.auth ??
    createGoogleAuth(cfg.serviceAccountJson, {
      http: deps.http,
      ...(deps.now ? { now: deps.now } : {}),
    })
  const ctx: GoogleCtx = { cfg, http: deps.http, auth }

  return {
    name: 'google',

    getUser: (email: string) => getUser(ctx, email),
    suspendUser: (email: string) => suspendUser(ctx, email),
    deleteUser: (email: string) => deleteUser(ctx, email),
    listUsers: () => listUsers(ctx),
    resolveUserId: (email: string) => resolveUserId(ctx, email),

    /**
     * The shared contract wants product and SKU pairs, which is what the
     * revoke needs. The richer list is available separately for a report.
     */
    async listLicences(email: string) {
      const held = await listLicences(ctx, email)
      return held.map((licence) => ({ productId: licence.productId, skuId: licence.skuId }))
    },
    listLicenceAssignments: (email: string) => listLicences(ctx, email),
    revokeLicence: (email: string, productId: string, skuId: string) =>
      revokeLicence(ctx, email, productId, skuId),

    getMailboxState: (email: string) => getMailboxState(ctx, email),
    moveToOrgUnit: (email: string, orgUnitPath: string) => moveToOrgUnit(ctx, email, orgUnitPath),
    assignLicence: (email: string, productId: string, skuId: string) => assignLicence(ctx, email, productId, skuId),

    transferDrive: (fromEmail: string, toEmail: string) => transferDrive(ctx, fromEmail, toEmail),
    getTransferStatus: (transferId: string) => getTransferStatus(ctx, transferId),

    setVacationResponder: (email: string, subject: string, body: string) =>
      setVacationResponder(ctx, email, subject, body),
    signOutUser: (email: string) => signOutUser(ctx, email),
    closeUser: (email: string) => closeUser(ctx, email),
    activation: new GoogleActivation(ctx),
    sendMail: (opts: { to: string[]; subject: string; body: string }) => sendMail(ctx, opts),

    testConnection: () => testConnection(ctx),
    probeScopes: (opts?: { mailbox?: string; armed?: readonly string[] }) => probeScopes(ctx, opts),
  }
}

/**
 * Prove the credential works, changing nothing.
 *
 * One customer-wide list of a single account is enough to show three separate
 * things: the key signs, the delegation covers the directory scope, and the
 * subject is a real administrator. A failure at any of those looks the same
 * from the outside, so the check reports which one it got to.
 */
async function testConnection(ctx: GoogleCtx): Promise<ConnectionCheck> {
  const directory = REQUIRED_SCOPE_USES.find((use) => use.key === 'directoryUser')
  if (!directory) {
    return { ok: false, detail: 'no directory scope is registered', docsAnchor: DOCS_ANCHOR }
  }

  const probe = await ctx.auth.probe(directory.scope, ctx.cfg.adminEmail)
  if (!probe.ok) {
    return {
      ok: false,
      detail: `the token exchange for the directory scope answered ${probe.status}${probe.error ? ` (${probe.error})` : ''}`,
      remediation:
        probe.error === 'unauthorized_client'
          ? 'Add the directory scope to the service account client id under domain-wide delegation, exactly as written in src/connectors/google/scopes.ts.'
          : 'Check google.adminEmail is a real administrator mailbox and that the service account key is current.',
      docsAnchor: DOCS_ANCHOR,
    }
  }

  try {
    const listed = await listUsers(ctx, { pageSize: 1, maxPages: 1 })
    return {
      ok: true,
      detail: `delegation works as the configured administrator; the tenancy answered a customer-wide list (${listed.users.length} account read of the first page)`,
      docsAnchor: DOCS_ANCHOR,
    }
  } catch (err) {
    return {
      ok: false,
      detail: `the delegated token worked and the directory read did not: ${message(err)}`,
      remediation:
        'Confirm the Admin SDK API is enabled on the Cloud project holding the service account.',
      docsAnchor: DOCS_ANCHOR,
    }
  }
}

/**
 * Ask Google about each scope on its own.
 *
 * This is a token exchange per scope and nothing else, so it reads nothing and
 * changes nothing, and it is safe against a live tenancy. It exists because a
 * missing scope otherwise surfaces days later as one leg quietly failing.
 *
 * The mailbox-scoped row is probed with a real mailbox rather than the
 * administrator when one is given: the administrator would prove the scope is
 * delegated while saying nothing about whether ordinary mailboxes can be
 * impersonated, which is the half that fails in practice.
 */
async function probeScopes(
  ctx: GoogleCtx,
  opts: { mailbox?: string; armed?: readonly string[] } = {},
): Promise<ScopeReport[]> {
  const reports: ScopeReport[] = []
  const armed = opts.armed ?? []
  const uses = SCOPE_USES.filter((use) => use.required || (use.armedBy ?? []).some((action) => armed.includes(action)))
  for (const use of uses) {
    const subject =
      use.subject === 'leaver'
        ? (opts.mailbox ?? ctx.cfg.adminEmail)
        : subjectFor(use.subject, ctx.cfg)
    const result = await ctx.auth.probe(use.scope, subject)
    reports.push({
      scope: use.scope,
      ok: result.ok,
      subject,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
      // Armed makes it required: the step will run, so a refusal is a failure.
      required: true,
      neededBy: use.methods,
      breaksWithout: use.breaksWithout,
    })
  }
  return reports
}

/** Narrow an unknown error to something printable. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error'
}
