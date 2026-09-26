/**
 * The vocabulary the whole toolkit shares.
 *
 * One rule shapes everything here: a person is keyed on the identifier the HR
 * system owns (`hrisId`), never on their email address. Email is an attribute
 * that changes — people marry, people are renamed on the way out — and every
 * serious incident on record in the automation this was ported from came from
 * treating the address as the identity.
 */

/** Where a person is in their lifecycle. Only `transitions.ts` assigns these. */
export type LifecycleStatus =
  /** Start date is in the future. No access work happens yet. */
  | 'hired'
  /** Employed and present in the HR system's active set. */
  | 'active'
  /** Gone from the HR system's active set, offboarding not started. */
  | 'terminated'
  /** Offboarding has begun; `offboarding.suspendedAt` is set. */
  | 'offboarding'
  /** Terminal. A tombstone that stops the person ever being re-created. */
  | 'departed'

/**
 * Who is allowed to cause a transition. Enforced by the store on every write,
 * because "the sync must not touch a row the engine owns" was previously a
 * comment, and comments do not stop a bulk update.
 */
export type TransitionOwner = 'sync' | 'engine' | 'human'

/**
 * Why a row was parked. A parked row takes no automatic action and waits for a
 * person. Over-suppression is silent, so every parked row is reported in the
 * run summary and `jml doctor` reports the age of the oldest one.
 */
export type ReviewReason =
  /** Leaving date is older than the configured lookback, so it may be historic. */
  | 'termination_older_than_lookback'
  /** The provider record disagrees with what we hold about this person. */
  | 'identity_mismatch'
  /** Another employed person claims this account or address. */
  | 'identity_claimed_by_live_person'
  /** A provider lookup matched more than one account. */
  | 'ambiguous_provider_match'
  /** Nobody was resolved to hand the leaver's files to. */
  | 'no_transfer_recipient'
  /** A step failed more times than the configured limit. */
  | 'max_leg_attempts'
  /** The HR system says this person is employed again, after suspension. */
  | 'reinstated_after_day0'

/** The name of one unit of offboarding work. */
export type LegName =
  | 'suspend_idp'
  | 'revoke_licence'
  | 'set_autoreply'
  | 'signout_google'
  | 'close_google'
  | 'notify_manager'
  | 'transfer_drive'
  | 'suspend_google'
  | 'delete_idp'
  | 'delete_google'

/** How one leg ended. */
export type LegState =
  | 'pending'
  | 'done'
  /** The thing this leg would have created or removed was already in that state. */
  | 'already_absent'
  | 'failed'
  /** The leg is implemented but not switched on in config. */
  | 'not_armed'
  /** Nothing to do for this person (for example no Google account). */
  | 'not_applicable'

export interface LegRecord {
  state: LegState
  /**
   * True only when the effect was confirmed by reading the provider back.
   * A 2xx response is not an effect: this toolkit's ancestor recorded a
   * successful suspension from a 200 that had changed nothing.
   */
  verified: boolean
  attempts: number
  error?: string
  at?: string
}

/** Progress through offboarding. These are markers on the person, not statuses. */
export interface OffboardingRecord {
  /** Day-0 idempotency key. Written once, never cleared. */
  suspendedAt: string | null
  legs: Partial<Record<LegName, LegRecord>>
  transferredAt?: string | null
  transferId?: string | null
  transferRecipient?: string | null
  /** Set when a human chose the recipient or waived the transfer. */
  transferOverride?: string | null
  /** Non-null means deletion is refused. Re-evaluated live every run. */
  deleteBlockedReason?: string | null
  boundDevices?: BoundDevice[]
  /** Fingerprint of the blocking device set, so we alert on change, not on a timer. */
  blockedFingerprint?: string | null
  /** A human confirmed deletion may proceed, when config requires it. */
  operatorAck?: { by: string; at: string; note?: string } | null
  departedAt?: string | null
  /** Owners told, keyed by address, with the date. One message per owner, ever. */
  ownersNotified?: Record<string, string> | null
  /** The leaver ticket, raised once when the row becomes a day-0 candidate. */
  ticketRef?: { id: string; number: string; url: string | null } | null
}

/**
 * Progress through activation. Written by the joiner engine and by a human
 * opening the gate; never by the HR sync.
 */
export interface ActivationRecord {
  /**
   * Set only once the identity account has a temporary password and a forced
   * reset, both read back. The idempotency key: a row with it is never
   * activated again.
   */
  activatedAt?: string | null
  /**
   * `engine` when this toolkit did the work; `observed` when the account was
   * already in use at first sight and was left alone. The second is what every
   * existing employee reads as on a first install.
   */
  activatedBy?: 'engine' | 'observed' | null
  passwordResetForced?: boolean | null
  /** Where the temporary password went. Addresses, because a human checks this. */
  passwordSentTo?: string[] | null
  licenceAssignedAt?: string | null
  mailboxReadyAt?: string | null
  ouMovedAt?: string | null
  welcomeSentAt?: string | null
  /** Set when the gate is `manual` or `ticket` and somebody opened it. */
  gateOpenedAt?: string | null
  gateOpenedBy?: string | null
  /** A permanent refusal, cleared only by a human. */
  refusedReason?: string | null
  /** The manager was asked to raise the starter form. Once. */
  nudgedAt?: string | null
  /** The day-before reminder went. Once. */
  remindedAt?: string | null
  /** The ticket that opened the gate, when one did. */
  ticketRef?: { id: string; number: string; url: string | null } | null
  attempts?: number | null
  legs?: Partial<Record<ActivationLegName, LegRecord>> | null
}

export type ActivationLegName = 'activate' | 'joiner_licence' | 'ou_move' | 'welcome'

/** A device the identity provider says is bound to this person. */
export interface BoundDevice {
  id: string
  /** Human-readable name, so an alert names a machine rather than an id. */
  displayName: string | null
  osFamily: 'windows' | 'macos' | 'linux' | 'unknown'
  serial: string | null
  lastContact: string | null
  /** Whether the provider holds this machine's disk-encryption recovery key. */
  fdeKeyPresent: boolean | null
}

/** Accounts this person holds in other systems. */
export interface ExternalIds {
  jumpcloudUserId?: string | null
  googleUserId?: string | null
  [provider: string]: string | null | undefined
}

/** The canonical person record. */
export interface Person {
  /** The HR system's stable id. The only key. */
  hrisId: string
  status: LifecycleStatus
  primaryEmail: string
  /** Addresses this person has used before, kept so a rename is not a new person. */
  aliasEmails: string[]
  displayName: string
  firstName?: string | null
  lastName?: string | null
  department?: string | null
  jobTitle?: string | null
  site?: string | null
  managerEmail?: string | null
  /** Non-work address from the HR system. See HrisPerson. */
  personalEmail?: string | null
  startDate?: string | null
  terminationDate?: string | null
  /** Last day physically in, when the HR system holds one. See HrisPerson. */
  lastWorkingDay?: string | null
  /** Somebody IT provisions for. `null` reads as yes. See HrisPerson. */
  inScope?: boolean | null
  /** Frozen by a human. Excluded from every automatic selection. */
  hold: boolean
  holdReason?: string | null
  reviewReason?: ReviewReason | null
  externalIds: ExternalIds
  /**
   * Read from the Google Directory, never inferred from the identity provider.
   * The automation this replaces inferred it and suspended people who had no
   * Google account at all.
   */
  googleAccountPresent?: boolean | null
  offboarding?: OffboardingRecord | null
  /** Progress through joiner activation. Markers, not statuses, like offboarding. */
  activation?: ActivationRecord | null
  /** One slot. The history of what happened lives in the audit log. */
  note?: string | null
  source?: string | null
  updatedAt?: string | null
}

/** Who or what caused an action. Every audit row carries one. */
export interface Actor {
  kind: 'system' | 'human'
  /** `system:pipeline`, or a person's email when a human asked for it. */
  id: string
}

/** The result of one provider call. */
export interface Outcome {
  ok: boolean
  /** Confirmed by reading the provider back. Required before any status write. */
  verified: boolean
  /** The thing was already in the desired state. */
  alreadyAbsent?: boolean
  error?: string
  retryable?: boolean
  detail?: Record<string, unknown>
}

/** What one person's offboarding did during one run. */
export interface PersonRunResult {
  hrisId: string
  /** Never the email address of a real person in logs; this is the display name. */
  displayName: string
  phase: 'day0' | 'day6' | 'day7' | 'skipped' | 'parked' | 'blocked' | 'activated' | 'joiner_skipped' | 'joiner_refused'
  legs: Partial<Record<LegName | ActivationLegName, LegRecord>>
  statusBefore: LifecycleStatus
  statusAfter: LifecycleStatus
  blockedReason?: string | null
  reviewReason?: ReviewReason | null
  notes?: string[]
}

/** What a whole run did. Returned by the CLI and by the HTTP sidecar. */
export interface RunReport {
  runId: string
  kind: 'pipeline' | 'sync' | 'detect' | 'joiner' | 'leaver' | 'device'
  startedAt: string
  finishedAt: string
  dryRun: boolean
  /** False when any step failed, any gate threw, or a notification was not delivered. */
  ok: boolean
  /** Set when the run refused to do anything, for example the circuit breaker. */
  aborted?: { reason: string; detail?: Record<string, unknown> } | null
  counts: Record<string, number>
  people: PersonRunResult[]
  /** Problems that did not stop the run. */
  warnings: string[]
  errors: string[]
}
