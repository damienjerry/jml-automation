/**
 * The configuration contract, and the single source of truth for it.
 *
 * `jml.config.example.yaml`, `.env.example`, `schema/jml.config.schema.json`
 * and `docs/config-reference.md` are all generated from this file by
 * `npm run generate`, and CI fails if any of them is stale. There is therefore
 * one place to add a key, and no way to add one that the documentation and the
 * editor schema do not know about.
 *
 * Field metadata travels with the field, inside `.describe()`, using the
 * grammar `ENV_VAR|prose`. An empty ENV_VAR means the key has no environment
 * override; a leading `!` on the name marks the field as a secret reference.
 * Keeping the metadata attached to the field rather than in a parallel table is
 * what makes drift impossible.
 *
 * Two structural decisions carry weight:
 *
 *  - `.strict()` on every object, so an unknown key is a start-up failure. A
 *    typo in a safety flag would otherwise be silently ignored, and the run
 *    would proceed with the guard off and nothing to show for it.
 *  - `mode: armed` is refused unless `armedActions` names what is armed, so
 *    arming is a per-action decision rather than one switch that turns
 *    everything on at once.
 */

import { z } from 'zod'
import { SECRET_REF_PATTERN } from './secrets.ts'

/** Builds the `ENV_VAR|prose` description string. See the file header. */
function meta(env: string, prose: string): string {
  return env + '|' + prose
}

const SECRET_MESSAGE =
  'a secret value must never appear in configuration: use env:NAME, file:/path or op://<vault>/<item>/<field>'

/** A field holding a reference to a credential, never the credential itself. */
function secretRef(env: string, prose: string) {
  return z.string().regex(SECRET_REF_PATTERN, SECRET_MESSAGE).describe(meta('!' + env, prose))
}

const email = (env: string, prose: string) => z.string().email().describe(meta(env, prose))

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const OrgSchema = z
  .object({
    name: z.string().min(1).describe(meta('ORG_NAME', 'Organisation name, used in notifications and the leaver auto-reply.')),
    primaryDomain: z
      .string()
      .min(1)
      .describe(meta('ORG_PRIMARY_DOMAIN', 'The domain a canonical address is expressed in.')),
    aliasDomains: z
      .array(z.string())
      .default([])
      .describe(
        meta(
          'ORG_ALIAS_DOMAINS',
          'Comma-separated domains that route to the same mailboxes. Two systems keyed on different domains for one person is how identity joins silently diverge.',
        ),
      ),
    timezone: z
      .string()
      .min(1)
      .describe(meta('ORG_TIMEZONE', 'IANA zone. ALL date-only arithmetic happens in it; never in UTC.')),
    itTeamSignature: z
      .string()
      .min(1)
      .describe(meta('IT_TEAM_SIGNATURE', 'Sign-off line on notifications sent to a person.')),
  })
  .strict()

const ARMED_ACTIONS = [
  'suspend',
  'autoreply',
  'licence',
  'transfer',
  'google_suspend',
  'delete',
  'device_unbind',
  'device_handover',
] as const

const MailSchema = z
  .object({
    senderMailbox: email(
      'MAIL_SENDER_MAILBOX',
      'The mailbox outbound mail is sent AS. Delegated authority is granted for this address specifically.',
    ),
    bcc: z.array(z.string().email()).default([]).describe(meta('MAIL_BCC', 'Addresses blind-copied on every notification.')),
    managerOnDay0: z
      .boolean()
      .default(true)
      .describe(meta('MAIL_MANAGER_ON_DAY0', "Tell the leaver's manager on day 0 that offboarding has started.")),
  })
  .strict()

const HiBobFieldsSchema = z
  .object({
    id: z.string().default('root.id').describe(meta('', 'Path to the stable HR id.')),
    email: z.string().default('root.email').describe(meta('', 'Path to the work email address.')),
    displayName: z.string().default('root.displayName').describe(meta('', 'Path to the display name.')),
    firstName: z.string().default('root.firstName').describe(meta('', 'Path to the first name.')),
    lastName: z.string().default('root.surname').describe(meta('', 'Path to the surname.')),
    department: z.string().default('work.department').describe(meta('', 'Path to the department.')),
    jobTitle: z.string().default('work.title').describe(meta('', 'Path to the job title.')),
    site: z.string().default('work.site').describe(meta('', 'Path to the work site.')),
    startDate: z.string().default('work.startDate').describe(meta('', 'Path to the start date.')),
    managerEmail: z.string().default('work.reportsTo.email').describe(meta('', "Path to the manager's email address.")),
    managerName: z.string().default('work.reportsTo.displayName').describe(meta('', "Path to the manager's name.")),
    terminationDate: z
      .array(z.string())
      .default(['internal.terminationDate', 'employment.terminationDate'])
      .describe(
        meta(
          '',
          'ORDERED fallbacks. HR systems hold the leaving date in different places depending on how the tenant is configured, and reading only the first one makes a leaver look like they have no date at all.',
        ),
      ),
  })
  .strict()

const HiBobSchema = z
  .object({
    baseUrl: z.string().url().default('https://api.hibob.com/v1').describe(meta('HIBOB_BASE_URL', 'HR API base URL.')),
    serviceUserId: secretRef('HIBOB_SERVICE_USER_ID', 'Service user id, as a secret reference.'),
    serviceToken: secretRef('HIBOB_SERVICE_TOKEN', 'Service user token, as a secret reference.'),
    pageSize: z.number().int().positive().default(200).describe(meta('HIBOB_PAGE_SIZE', 'Page size for the paged read.')),
    fields: HiBobFieldsSchema.default({}).describe(meta('', 'Where each field lives in the HR payload.')),
  })
  .strict()

const HrisSchema = z
  .object({
    adapter: z.enum(['hibob', 'fixture']).describe(meta('HRIS_ADAPTER', 'Which HR system to read.')),
    minPlausibleHeadcount: z
      .number()
      .int()
      .positive()
      .describe(
        meta(
          'HRIS_MIN_PLAUSIBLE_HEADCOUNT',
          'REQUIRED, no default. A snapshot smaller than this aborts the run. A truncated read looks exactly like a company where everybody left, and the cost of that mistake is suspending the whole staff, so an adopter states their own floor rather than inheriting a guess.',
        ),
      ),
    exitRenamePatterns: z
      .array(z.string())
      .default(['\\+(exit|leaver)@'])
      .describe(
        meta(
          'HRIS_EXIT_RENAME_PATTERNS',
          'Regular expressions matching the address an HR system renames a leaver to. A match means the address is an alias on the same person, never a new identity.',
        ),
      ),
    hibob: HiBobSchema.optional().describe(meta('', 'Required when adapter is hibob.')),
    fixture: z
      .object({ path: z.string().describe(meta('HRIS_FIXTURE_PATH', 'JSON file holding the snapshot.')) })
      .strict()
      .optional()
      .describe(meta('', 'Required when adapter is fixture.')),
  })
  .strict()

const SqliteStoreSchema = z
  .object({
    adapter: z.literal('sqlite').describe(meta('STORE_ADAPTER', 'Local SQLite: the default people store.')),
    path: z.string().default('./data/jml.sqlite').describe(meta('STORE_SQLITE_PATH', 'Database file.')),
  })
  .strict()

const NotionStoreSchema = z
  .object({
    adapter: z.literal('notion').describe(meta('', 'One Notion database as the people store.')),
    token: secretRef('NOTION_API_KEY', 'Internal integration token, as a secret reference.'),
    peopleDatabaseId: z.string().describe(meta('NOTION_PEOPLE_DB_ID', 'Database id holding one row per person.')),
    properties: z
      .record(z.string())
      .default({})
      .describe(meta('', 'Map from this toolkit’s field names to your property names.')),
    statusValues: z
      .record(z.string())
      .default({})
      .describe(meta('', 'Map from lifecycle status to your select options.')),
  })
  .strict()

const SheetsStoreSchema = z
  .object({
    adapter: z.literal('sheets').describe(meta('', 'A spreadsheet as the people store.')),
    spreadsheetId: z.string().describe(meta('PEOPLE_SHEET_ID', 'Spreadsheet id.')),
    tab: z.string().default('People').describe(meta('PEOPLE_SHEET_TAB', 'Worksheet name.')),
  })
  .strict()

const MemoryStoreSchema = z
  .object({
    adapter: z.literal('memory').describe(meta('', 'In-memory store for the demo and for dry-run rehearsal. Nothing persists.')),
  })
  .strict()

const IdentitySchema = z
  .object({
    jumpcloud: z
      .object({
        baseUrl: z
          .string()
          .url()
          .default('https://console.jumpcloud.com/api')
          .describe(
            meta('JUMPCLOUD_BASE_URL', 'Some tenants answer only on the console host and return 404 on the other one for every request, valid key or not.'),
          ),
        apiKey: secretRef('JUMPCLOUD_API_KEY', 'Organisation API key, as a secret reference.'),
        poolUserEmail: z
          .string()
          .email()
          .nullable()
          .default(null)
          .describe(meta('JUMPCLOUD_POOL_USER_EMAIL', 'Spares account a returned device is rebound to. Null disables the rebind.')),
      })
      .strict(),
  })
  .strict()

const GoogleSchema = z
  .object({
    serviceAccountJson: secretRef(
      'GOOGLE_SERVICE_ACCOUNT_JSON',
      'The whole service account key file, as a secret reference. `file:/path/to/key.json` is the usual form.',
    ),
    adminEmail: email('GOOGLE_ADMIN_EMAIL', 'The admin this service account impersonates for directory, licensing and transfer calls.'),
    customer: z
      .literal('my_customer')
      .default('my_customer')
      .describe(meta('GOOGLE_CUSTOMER', 'List by customer, never by one domain: a per-domain list silently misses every account on an alias domain.')),
    licenceProductIds: z
      .array(z.string())
      .default(['Google-Apps'])
      .describe(meta('GOOGLE_LICENCE_PRODUCT_IDS', 'Products searched when revoking a licence.')),
    driveTransfer: z
      .object({
        applications: z
          .array(z.enum(['drive', 'calendar']))
          .default(['drive'])
          .describe(meta('GOOGLE_TRANSFER_APPLICATIONS', 'What is handed over. The application id is resolved at run time, never hard-coded.')),
        privacyLevels: z
          .array(z.enum(['PRIVATE', 'SHARED']))
          .default(['PRIVATE', 'SHARED'])
          .describe(meta('GOOGLE_TRANSFER_PRIVACY_LEVELS', 'Which files move.')),
        fallbackRecipient: z
          .string()
          .email()
          .nullable()
          .default(null)
          .describe(meta('GOOGLE_TRANSFER_FALLBACK_RECIPIENT', 'Used when no manager resolves. Null parks the row for a person to decide.')),
        pollTimeoutMinutes: z
          .number()
          .int()
          .positive()
          .default(30)
          .describe(meta('GOOGLE_TRANSFER_POLL_TIMEOUT_MIN', 'How long one run waits before leaving the transfer to be re-polled by the next run.')),
      })
      .strict()
      .default({}),
  })
  .strict()

const LeaverSchema = z
  .object({
    terminationLookbackDays: z
      .number()
      .int()
      .positive()
      .default(60)
      .describe(
        meta(
          'TERMINATION_LOOKBACK_DAYS',
          'A leaving date older than this parks the row instead of acting on it. This is the backstop against a stale record being treated as a fresh departure.',
        ),
      ),
    maxDay0PerRun: z
      .number()
      .int()
      .positive()
      .default(5)
      .describe(
        meta(
          'LEAVER_MAX_DAY0_PER_RUN',
          'Circuit breaker. More day-0 candidates than this aborts the WHOLE run rather than processing the first few, because a sudden crowd of leavers is a data fault far more often than a redundancy round.',
        ),
      ),
    maxAttemptsPerLeg: z
      .number()
      .int()
      .positive()
      .default(6)
      .describe(meta('LEAVER_MAX_ATTEMPTS_PER_LEG', 'After this many failures a leg parks the row for a person.')),
    transferDay: z.number().int().min(1).default(6).describe(meta('OFFBOARD_TRANSFER_DAY', 'Days after suspension that files are handed over.')),
    deleteDay: z.number().int().min(2).default(7).describe(meta('OFFBOARD_DELETE_DAY', 'Days after suspension that accounts are deleted.')),
    revokeLicences: z
      .union([z.literal('all'), z.array(z.string())])
      .default('all')
      .describe(meta('LEAVER_REVOKE_LICENCES', '`all`, or a list of SKU ids to revoke.')),
    deleteGoogleUser: z
      .boolean()
      .default(true)
      .describe(meta('LEAVER_DELETE_GOOGLE_USER', 'False stops at suspension so the mailbox can be archived by hand.')),
    requireOperatorAck: z
      .boolean()
      .default(false)
      .describe(meta('LEAVER_REQUIRE_OPERATOR_ACK', 'Require a human acknowledgement before any deletion.')),
    requireTransferBeforeDelete: z
      .boolean()
      .default(true)
      .describe(meta('LEAVER_REQUIRE_TRANSFER_BEFORE_DELETE', 'Refuse deletion until the file handover is confirmed complete.')),
    autoReply: z
      .object({
        subject: z
          .string()
          .default('${displayName} has left ${orgName}')
          .describe(meta('LEAVER_AUTOREPLY_SUBJECT', 'Placeholders: displayName, orgName, managerName, managerEmail.')),
        bodyHtml: z
          .string()
          .default(
            '<p>${displayName} no longer works at ${orgName}.</p><p>Please contact ${managerName} at ${managerEmail}.</p>',
          )
          .describe(meta('LEAVER_AUTOREPLY_BODY', 'Same placeholders as the subject.')),
      })
      .strict()
      .default({}),
    deviceGate: z
      .object({
        directBindingsOnly: z
          .literal(true)
          .default(true)
          .describe(
            meta('', 'NOT overridable. Membership of a group that grants access to a machine is not custody of it, so only a direct binding blocks a deletion.'),
          ),
        failClosed: z
          .literal(true)
          .default(true)
          .describe(
            meta('', 'NOT overridable. A gate that cannot be read blocks. Reading an error as "no devices" is how an account gets deleted while the machine is still out there.'),
          ),
      })
      .strict()
      .default({}),
  })
  .strict()

const AgentSchema = z
  .object({
    name: z.string().describe(meta('', 'Agent name, echoed in the removal receipt.')),
    windows: z
      .object({
        services: z.array(z.string()).default([]).describe(meta('', 'Service names to stop and remove.')),
        uninstallDisplayNames: z.array(z.string()).default([]).describe(meta('', 'Exact uninstall display names. Anchored, never a substring match.')),
        paths: z.array(z.string()).default([]).describe(meta('', 'Leftover paths to remove.')),
      })
      .strict()
      .default({}),
    darwin: z
      .object({
        launchdLabels: z.array(z.string()).default([]).describe(meta('', 'launchd labels to bootout.')),
        paths: z.array(z.string()).default([]).describe(meta('', 'Leftover paths to remove.')),
      })
      .strict()
      .default({}),
  })
  .strict()

const DevicesSchema = z
  .object({
    dispositionDefault: z
      .enum(['return_to_pool', 'reassign', 'handover', 'retain_unmanaged'])
      .default('return_to_pool')
      .describe(meta('DEVICE_DISPOSITION_DEFAULT', 'What happens to a device when nobody says otherwise.')),
    uninstallTriggers: z
      .object({
        windows: z.string().nullable().default(null).describe(meta('DEVICE_UNINSTALL_TRIGGER_WINDOWS', 'Command trigger name. Null refuses handover on this platform.')),
        darwin: z.string().nullable().default(null).describe(meta('DEVICE_UNINSTALL_TRIGGER_MACOS', 'Command trigger name. Null refuses handover on this platform.')),
        linux: z.string().nullable().default(null).describe(meta('DEVICE_UNINSTALL_TRIGGER_LINUX', 'Command trigger name. Null refuses handover on this platform.')),
      })
      .strict()
      .default({}),
    agents: z
      .array(AgentSchema)
      .default([])
      .describe(meta('', 'The agents a handover removes, and the receipt keys the script must report back.')),
    agentQuietMinutes: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe(meta('DEVICE_AGENT_QUIET_MIN', 'Last contact must be frozen this long before a device record is deleted, so the removal is confirmed by silence rather than by an exit code.')),
    staleContactWarnMin: z
      .number()
      .int()
      .positive()
      .default(60)
      .describe(meta('DEVICE_STALE_CONTACT_WARN_MIN', 'Preflight warns when a device has not been heard from for this long.')),
    forbidGroupBoundCommands: z
      .literal(true)
      .default(true)
      .describe(
        meta('', 'NOT overridable. A trigger fires on every association the command holds, so a group-attached uninstaller strips the whole fleet.'),
      ),
    purgeTelemetryHistory: z
      .boolean()
      .default(false)
      .describe(meta('DEVICE_PURGE_TELEMETRY', 'Irreversible. Requires an explicit acknowledgement at the call site as well.')),
    receipt: z
      .object({
        holdMs: z
          .number()
          .int()
          .positive()
          .default(120_000)
          .describe(meta('DEVICE_HOLD_MS', 'How long to hold the association after firing. A short hold loses the work on any device that was not connected at that instant.')),
        pollMs: z.number().int().positive().default(15_000).describe(meta('DEVICE_POLL_MS', 'Result polling interval.')),
        timeoutMs: z.number().int().positive().default(600_000).describe(meta('DEVICE_RECEIPT_TIMEOUT_MS', 'Give up waiting for a receipt. Never read a timeout as success.')),
      })
      .strict()
      .default({}),
    fleet: z
      .object({
        url: z.string().url().nullable().default(null).describe(meta('FLEET_API_URL', 'Optional host-inventory API. Null disables the adapter.')),
        token: secretRef('FLEET_API_TOKEN', 'Optional host-inventory token.').nullable().default(null),
      })
      .strict()
      .default({}),
  })
  .strict()

const NotifySchema = z
  .object({
    adapters: z
      .array(z.enum(['slack', 'email', 'console']))
      .default(['console'])
      .describe(meta('NOTIFY_ADAPTERS', 'Where notifications go. Console is the default so the first run needs no credential.')),
    weeklyReraiseDay: z
      .enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'none'])
      .default('monday')
      .describe(
        meta(
          'NOTIFY_WEEKLY_RERAISE_DAY',
          'A standing problem is re-raised once on this weekday. Once, not on every run of that weekday: a weekday test is true for all of it.',
        ),
      ),
    slack: z
      .object({
        botToken: secretRef('SLACK_BOT_TOKEN', 'Bot token, as a secret reference.').nullable().default(null),
        itChannelId: z.string().nullable().default(null).describe(meta('SLACK_JML_CHANNEL_ID', 'Channel the IT summary is posted to.')),
      })
      .strict()
      .default({}),
    email: z
      .object({
        itMailbox: z.string().email().nullable().default(null).describe(meta('IT_SUPPORT_EMAIL', 'Mailbox the IT summary is sent to.')),
      })
      .strict()
      .default({}),
  })
  .strict()

const AuditSchema = z
  .object({
    minimisePii: z
      .boolean()
      .default(true)
      .describe(meta('AUDIT_MINIMISE_PII', 'Store addresses as a salted hash. An audit log is kept for years and does not need to be a staff directory.')),
    salt: secretRef('JML_AUDIT_SALT', 'Hash salt. Required when minimisePii is true.').nullable().default(null),
    jsonl: z
      .object({
        dir: z.string().default('./audit').describe(meta('AUDIT_DIR', 'Directory for the append-only log files.')),
      })
      .strict()
      .default({}),
    loki: z
      .object({
        enabled: z.boolean().default(false).describe(meta('AUDIT_LOKI_ENABLED', 'Also push audit rows to a log aggregator.')),
        url: z.string().url().nullable().default(null).describe(meta('LOKI_PUSH_URL', 'Push endpoint.')),
        authHeader: secretRef('LOKI_AUTH_HEADER', 'Authorization header value, as a secret reference.').nullable().default(null),
      })
      .strict()
      .default({}),
  })
  .strict()

/** Phase 1 ships these legs as interfaces only, and the literal false says so. */
const LegsSchema = z
  .object({
    azure: z.literal(false).default(false).describe(meta('', 'Reserved. The interface exists; nothing runs.')),
    slackScim: z.literal(false).default(false).describe(meta('', 'Reserved. The interface exists; nothing runs.')),
    saasChecklist: z.literal(false).default(false).describe(meta('', 'Reserved for a later phase.')),
  })
  .strict()

const ServerSchema = z
  .object({
    bind: z
      .string()
      .default('0.0.0.0:8787')
      .describe(meta('JML_SERVER_BIND', 'Where the sidecar listens. Not published to the host in the shipped compose file.')),
    token: secretRef('JML_API_TOKEN', 'Bearer token for the sidecar. At least 32 bytes; compared in constant time.'),
  })
  .strict()

// ---------------------------------------------------------------------------
// The whole document
// ---------------------------------------------------------------------------

/**
 * The object form, without the cross-field refinements.
 *
 * `generate.ts` walks this. A refinement wraps the schema in an effect and
 * hides the shape, so the two are exported separately rather than the
 * generator having to unwrap whatever refinements happen to be attached.
 */
export const ConfigObject = z
  .object({
    version: z.literal(1).describe(meta('', 'Config format version. Bumped only for a breaking change.')),
    org: OrgSchema,
    mode: z
      .enum(['dry-run', 'armed'])
      .default('dry-run')
      .describe(meta('JML_MODE', 'dry-run plans and reports without touching a provider. It is the default, and the demo runs in it.')),
    armedActions: z
      .array(z.enum(ARMED_ACTIONS))
      .default([])
      .describe(
        meta(
          'JML_ARMED_ACTIONS',
          'Which actions may really happen. An action absent from this list records not_armed rather than running, so arming happens one action at a time.',
        ),
      ),
    mail: MailSchema,
    hris: HrisSchema,
    store: z
      .discriminatedUnion('adapter', [SqliteStoreSchema, NotionStoreSchema, SheetsStoreSchema, MemoryStoreSchema])
      .describe(meta('', 'Where person records live.')),
    identity: IdentitySchema,
    google: GoogleSchema,
    leaver: LeaverSchema.default({}),
    devices: DevicesSchema.default({}),
    notify: NotifySchema.default({}),
    audit: AuditSchema.default({}),
    liveness: z
      .object({
        healthchecksPingUrl: secretRef(
          'HC_PING_JML',
          'Dead-man ping URL. The URL is itself the credential, so it is a secret reference. Pinged only after a notification is proven delivered.',
        )
          .nullable()
          .default(null),
      })
      .strict()
      .default({}),
    legs: LegsSchema.default({}),
    server: ServerSchema,
  })
  .strict()

export type JmlConfig = z.infer<typeof ConfigObject>

/** What `armedActions` may contain. */
export type ArmedAction = (typeof ARMED_ACTIONS)[number]
export const ALL_ARMED_ACTIONS: readonly ArmedAction[] = ARMED_ACTIONS

/** The schema to parse with. Adds the cross-field rules. */
export const ConfigSchema = ConfigObject.superRefine((cfg, ctx) => {
  if (cfg.mode === 'armed' && cfg.armedActions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['armedActions'],
      message:
        'mode: armed requires armedActions to name each action you are arming. One switch that arms everything is how a rehearsal becomes a mass suspension.',
    })
  }
  if (cfg.hris.adapter === 'hibob' && !cfg.hris.hibob) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hris', 'hibob'], message: 'hris.adapter is hibob, so hris.hibob is required' })
  }
  if (cfg.hris.adapter === 'fixture' && !cfg.hris.fixture) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hris', 'fixture'], message: 'hris.adapter is fixture, so hris.fixture.path is required' })
  }
  if (cfg.audit.minimisePii && !cfg.audit.salt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['audit', 'salt'],
      message: 'audit.minimisePii is true, so audit.salt must reference a salt. An unsalted hash of an address is reversible by guessing.',
    })
  }
  if (cfg.notify.adapters.includes('slack') && (!cfg.notify.slack.botToken || !cfg.notify.slack.itChannelId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notify', 'slack'], message: 'the slack notifier needs both notify.slack.botToken and notify.slack.itChannelId' })
  }
  if (cfg.notify.adapters.includes('email') && !cfg.notify.email.itMailbox) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notify', 'email'], message: 'the email notifier needs notify.email.itMailbox' })
  }
  if (cfg.leaver.deleteDay <= cfg.leaver.transferDay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['leaver', 'deleteDay'],
      message: 'leaver.deleteDay must be after leaver.transferDay, or files are deleted before they are handed over',
    })
  }
  if (cfg.audit.loki.enabled && !cfg.audit.loki.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['audit', 'loki', 'url'], message: 'audit.loki.enabled is true, so audit.loki.url is required' })
  }
})
