/**
 * Every Google scope this connector uses, what needs it, and what breaks
 * without it.
 *
 * This table is the single source for three things that otherwise drift apart:
 * the connector's own token minting, the per-scope probe behind `jml doctor`,
 * and the Google rows of docs/credentials.md. Domain-wide delegation is granted
 * scope string by scope string in the Google Admin console, and a scope that is
 * mistyped there is indistinguishable from one that was never granted, so the
 * exact strings live in code and the documentation is generated from them.
 *
 * The subject matters as much as the scope. A delegated token is minted for a
 * particular person, and the same scope authorised for the wrong subject fails
 * in a way that reads like a missing grant.
 */

/** The exact scope strings. Never build one by concatenation. */
export const GOOGLE_SCOPES = {
  directoryUser: 'https://www.googleapis.com/auth/admin.directory.user',
  directoryUserReadonly: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
  licensing: 'https://www.googleapis.com/auth/apps.licensing',
  dataTransfer: 'https://www.googleapis.com/auth/admin.datatransfer',
  gmailSettingsBasic: 'https://www.googleapis.com/auth/gmail.settings.basic',
  gmailSend: 'https://www.googleapis.com/auth/gmail.send',
  spreadsheetsReadonly: 'https://www.googleapis.com/auth/spreadsheets.readonly',
  driveReadonly: 'https://www.googleapis.com/auth/drive.readonly',
} as const

export type ScopeKey = keyof typeof GOOGLE_SCOPES
export type GoogleScope = (typeof GOOGLE_SCOPES)[ScopeKey]

/**
 * Who the token is minted for.
 *
 * `self` is the service account acting as itself, with no impersonation
 * subject at all. That mode reaches resources shared directly with the service
 * account's own address, which is how a spreadsheet or a calendar is read
 * without asking an administrator for a broad delegation.
 */
export type SubjectKind =
  /** The configured Google administrator. */
  | 'admin'
  /** The person leaving. Only their own token can change their own mailbox. */
  | 'leaver'
  /** The mailbox notifications are sent as. */
  | 'sender'
  /** No subject: the service account itself. */
  | 'self'

export interface ScopeUse {
  key: ScopeKey
  scope: GoogleScope
  subject: SubjectKind
  /** Connector methods that mint a token for this scope. */
  methods: readonly string[]
  /** Required for the Phase 1 leaver path, as opposed to an optional adapter. */
  required: boolean
  /** One line, for the probe table and the credentials documentation. */
  breaksWithout: string
}

/**
 * The scope table.
 *
 * Read the `subject` column before granting anything: five of these are
 * delegated to a person, and two are refused under delegation in practice and
 * only work with the service account acting as itself against a resource that
 * has been shared with it.
 */
export const SCOPE_USES: readonly ScopeUse[] = [
  {
    key: 'directoryUser',
    scope: GOOGLE_SCOPES.directoryUser,
    subject: 'admin',
    methods: ['getUser', 'suspendUser', 'deleteUser', 'listUsers'],
    required: true,
    breaksWithout:
      'No Google account can be read, suspended or deleted, and a leaver keeps a working mailbox.',
  },
  {
    key: 'directoryUserReadonly',
    scope: GOOGLE_SCOPES.directoryUserReadonly,
    subject: 'admin',
    methods: ['resolveRecipient', 'transferDrive'],
    required: true,
    breaksWithout:
      'The person the leaver files are handed to cannot be resolved, so the transfer has no recipient and the row parks.',
  },
  {
    key: 'licensing',
    scope: GOOGLE_SCOPES.licensing,
    subject: 'admin',
    methods: ['listLicences', 'revokeLicence'],
    required: true,
    breaksWithout: 'Paid seats are never released, so a leaver is billed for indefinitely.',
  },
  {
    key: 'dataTransfer',
    scope: GOOGLE_SCOPES.dataTransfer,
    subject: 'admin',
    methods: ['transferDrive', 'getTransferStatus'],
    required: true,
    breaksWithout:
      'The leaver files are never handed over, and deleting the account destroys them.',
  },
  {
    key: 'gmailSettingsBasic',
    scope: GOOGLE_SCOPES.gmailSettingsBasic,
    subject: 'leaver',
    methods: ['setVacationResponder'],
    required: true,
    breaksWithout:
      'No auto-reply is set, so mail sent to the leaver is accepted and then lost when the account goes.',
  },
  {
    key: 'gmailSend',
    scope: GOOGLE_SCOPES.gmailSend,
    subject: 'sender',
    methods: ['sendMail'],
    required: true,
    breaksWithout: 'No notification leaves the toolkit, so nobody is told what happened.',
  },
  {
    key: 'spreadsheetsReadonly',
    scope: GOOGLE_SCOPES.spreadsheetsReadonly,
    subject: 'self',
    methods: ['readSharedSpreadsheet'],
    required: false,
    breaksWithout:
      'Nothing in the leaver path. Only an optional read of a spreadsheet shared with the service account.',
  },
  {
    key: 'driveReadonly',
    scope: GOOGLE_SCOPES.driveReadonly,
    subject: 'self',
    methods: ['readSharedFile'],
    required: false,
    breaksWithout:
      'Nothing in the leaver path. Only an optional read of a file shared with the service account.',
  },
]

/** The scopes `jml doctor` probes before an adopter arms anything. */
export const REQUIRED_SCOPE_USES: readonly ScopeUse[] = SCOPE_USES.filter((u) => u.required)

/** Which scope a method needs. Used to name the missing grant in an error. */
export function scopeUsesForMethod(method: string): readonly ScopeUse[] {
  return SCOPE_USES.filter((u) => u.methods.includes(method))
}

export function scopeUseForKey(wanted: ScopeKey): ScopeUse {
  const found = SCOPE_USES.find((u) => u.key === wanted)
  // Unreachable while ScopeKey and SCOPE_USES are derived from one table, but a
  // silent undefined here would mint a token with no scope, which Google
  // answers with a generic invalid_grant that names nothing.
  if (!found) throw new Error('no scope is registered under ' + wanted)
  return found
}
