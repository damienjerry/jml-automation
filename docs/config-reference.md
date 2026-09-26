<!-- GENERATED FILE. Edit src/config/schema.ts and run `npm run generate`. -->

# Configuration reference

Every key `jml.config.yaml` accepts. An unknown key is a start-up failure,
so a typo in a safety flag cannot silently disable it.

## Environment references

Any string may contain `${NAME}`, which is replaced with that environment
variable at load time. An unset name is a start-up failure rather than an
empty string, because a blank domain or a blank mailbox matches nothing and
fails quietly instead of loudly.

## Secret references

A field marked **secret** below holds a reference, never a value:

| Form | Meaning |
| --- | --- |
| `env:NAME` | the value of that environment variable |
| `file:/path` | the trimmed contents of that file |
| `op://<vault>/<item>/<field>` | read through the 1Password CLI |

Reference a secret-manager item by its UUID, not its title. A title
reference works until somebody renames the item, and then it fails at the
next scheduled run with nobody watching.

Every reference resolves once, at start-up. A credential that cannot be
resolved stops the process; it never becomes a step that quietly does
nothing while the run reports success. Resolved values register with the
redactor, so they are masked in logs, error messages, the run report and
the audit log. `jml config show` prints references and lengths only.

## Reserved legs

This release ships the Azure and Slack SCIM legs as interfaces only. If
`AZURE_CLIENT_SECRET` or `SLACK_SCIM_TOKEN` is set, start-up refuses: a
credential present for a step that cannot run reads as coverage that does
not exist.

## Keys

| Key | Env | Type | Default | Secret | Notes |
| --- | --- | --- | --- | --- | --- |
| `version` | - | literal 1 | **required** | - | Config format version. Bumped only for a breaking change. |
| `org.name` | `ORG_NAME` | string | **required** | - | Organisation name, used in notifications and the leaver auto-reply. |
| `org.primaryDomain` | `ORG_PRIMARY_DOMAIN` | string | **required** | - | The domain a canonical address is expressed in. |
| `org.aliasDomains` | `ORG_ALIAS_DOMAINS` | string[] | `[]` | - | Comma-separated domains that route to the same mailboxes. Two systems keyed on different domains for one person is how identity joins silently diverge. |
| `org.timezone` | `ORG_TIMEZONE` | string | **required** | - | IANA zone. ALL date-only arithmetic happens in it; never in UTC. |
| `org.itTeamSignature` | `IT_TEAM_SIGNATURE` | string | **required** | - | Sign-off line on notifications sent to a person. |
| `mode` | `JML_MODE` | dry-run \| armed | `dry-run` | - | dry-run plans and reports without touching a provider. It is the default, and the demo runs in it. |
| `armedActions` | `JML_ARMED_ACTIONS` | suspend \| autoreply \| licence \| transfer \| google_suspend \| google_signout \| delete \| device_unbind \| device_handover \| activate \| joiner_licence \| ou_move \| welcome[] | `[]` | - | Which actions may really happen. An action absent from this list records not_armed rather than running, so arming happens one action at a time. |
| `mail.senderMailbox` | `MAIL_SENDER_MAILBOX` | string | **required** | - | The mailbox outbound mail is sent AS. Delegated authority is granted for this address specifically. |
| `mail.bcc` | `MAIL_BCC` | string[] | `[]` | - | Addresses blind-copied on every notification. |
| `mail.managerOnDay0` | `MAIL_MANAGER_ON_DAY0` | boolean | `true` | - | Tell the leaver's manager on day 0 that offboarding has started. |
| `hris.adapter` | `HRIS_ADAPTER` | hibob \| fixture \| csv \| sheet | **required** | - | Which HR source to read: HiBob, a JSON fixture, a CSV file, or a Google Sheet shared with the service account. |
| `hris.minPlausibleHeadcount` | `HRIS_MIN_PLAUSIBLE_HEADCOUNT` | integer | **required** | - | REQUIRED, no default. A snapshot smaller than this aborts the run. A truncated read looks exactly like a company where everybody left, and the cost of that mistake is suspending the whole staff, so an adopter states their own floor rather than inheriting a guess. |
| `hris.exitRenamePatterns` | `HRIS_EXIT_RENAME_PATTERNS` | string[] | `["\\+(exit\|leaver)@"]` | - | Regular expressions matching the address an HR system renames a leaver to. A match means the address is an alias on the same person, never a new identity. |
| `hris.hibob.baseUrl` | `HIBOB_BASE_URL` | string | `"https://api.hibob.com/v1"` | - | HR API base URL. |
| `hris.hibob.serviceUserId` | `HIBOB_SERVICE_USER_ID` | string | **required** | yes | Service user id, as a secret reference. |
| `hris.hibob.serviceToken` | `HIBOB_SERVICE_TOKEN` | string | **required** | yes | Service user token, as a secret reference. |
| `hris.hibob.pageSize` | `HIBOB_PAGE_SIZE` | integer | `200` | - | Page size for the paged read. |
| `hris.hibob.fields` | - | value | `{}` | - | Where each field lives in the HR payload. |
| `hris.fixture.path` | `HRIS_FIXTURE_PATH` | string | **required** | - | JSON file holding the snapshot. |
| `hris.table.path` | `HRIS_TABLE_PATH` | string \| null | `null` | - | The CSV file, for adapter csv. |
| `hris.table.spreadsheetId` | `HRIS_TABLE_SPREADSHEET_ID` | string \| null | `null` | - | The sheet id from its URL, for adapter sheet. Share the sheet with the service account address as a viewer. |
| `hris.table.range` | `HRIS_TABLE_RANGE` | string | `People` | - | The tab name, or an A1 range such as People!A1:Z. The first row is the headings. |
| `hris.table.dateFormat` | `HRIS_TABLE_DATE_FORMAT` | YYYY-MM-DD \| DD/MM/YYYY \| MM/DD/YYYY | `YYYY-MM-DD` | - | The one format every date in the table is in. A value in any other format refuses the whole read. |
| `hris.table.maxAgeHours` | `HRIS_TABLE_MAX_AGE_HOURS` | integer \| null | `null` | - | Refuse a table last changed longer ago than this. For a sheet it needs the read-only Drive scope as the service account. |
| `hris.table.inScopeValues` | - | string[] | `[yes, y, true, 1]` | - | Values of the inScope column that mean IT provisions for this person. |
| `hris.table.columns.hrisId` | - | string | `"Employee ID"` | - | A stable id that never changes, even when a name or address does. |
| `hris.table.columns.primaryEmail` | - | string | `"Work email"` | - | The work address, as the account was created. |
| `hris.table.columns.firstName` | - | string \| null | `"First name"` | - | First name. |
| `hris.table.columns.lastName` | - | string \| null | `"Last name"` | - | Last name. |
| `hris.table.columns.displayName` | - | string \| null | `null` | - | Full name, if the table has one column for it. |
| `hris.table.columns.department` | - | string \| null | `Department` | - | Department. |
| `hris.table.columns.jobTitle` | - | string \| null | `"Job title"` | - | Job title. |
| `hris.table.columns.managerEmail` | - | string \| null | `"Manager email"` | - | The manager's work address: files go to them on day 6. |
| `hris.table.columns.personalEmail` | - | string \| null | `"Personal email"` | - | Where a starter temporary password goes. |
| `hris.table.columns.startDate` | - | string \| null | `"Start date"` | - | First day. |
| `hris.table.columns.lastWorkingDay` | - | string \| null | `"Last working day"` | - | Last day in. Access stops the day after. A leaver keeps their row with this filled in. |
| `hris.table.columns.terminationDate` | - | string \| null | `null` | - | Contract end date, if different from the last working day. |
| `hris.table.columns.inScope` | - | string \| null | `null` | - | Whether IT provisions accounts for this person. Blank or unmapped means yes. |
| `store.adapter` (sqlite) | `STORE_ADAPTER` | literal "sqlite" | **required** | - | Local SQLite: the default people store. |
| `store.path` (sqlite) | `STORE_SQLITE_PATH` | string | `./data/jml.sqlite` | - | Database file. |
| `store.adapter` (notion) | - | literal "notion" | **required** | - | One Notion database as the people store. |
| `store.token` (notion) | `NOTION_API_KEY` | string | **required** | yes | Internal integration token, as a secret reference. |
| `store.peopleDatabaseId` (notion) | `NOTION_PEOPLE_DB_ID` | string | **required** | - | Database id holding one row per person. |
| `store.properties` (notion) | - | map | `{}` | - | Map from this toolkit’s field names to your property names. |
| `store.statusValues` (notion) | - | map | `{}` | - | Map from lifecycle status to your select options. |
| `store.readOnly` (notion) | `NOTION_READ_ONLY` | boolean | `false` | - | Never write to the database. Reads, counts, `jml store verify` and every dry run work; every write refuses; a missing property is read as empty rather than added. For a database another automation owns, such as a shadow run beside a live estate. |
| `store.adapter` (sheets) | - | literal "sheets" | **required** | - | A spreadsheet as the people store. |
| `store.spreadsheetId` (sheets) | `PEOPLE_SHEET_ID` | string | **required** | - | Spreadsheet id. |
| `store.tab` (sheets) | `PEOPLE_SHEET_TAB` | string | `People` | - | Worksheet name. |
| `store.adapter` (memory) | - | literal "memory" | **required** | - | In-memory store for the demo and for dry-run rehearsal. Nothing persists. |
| `identity.adapter` | `IDENTITY_ADAPTER` | jumpcloud \| none | `jumpcloud` | - | `jumpcloud` (setup 1.0a) puts a JumpCloud account in front of Google. `none` (setup 1.0b) makes the Google account the only account: day 0 closes it with a random password and a sign-out, starters get their temporary password on Google, and there is no device inventory, so every deletion says none was checked. |
| `identity.jumpcloud.baseUrl` | `JUMPCLOUD_BASE_URL` | string | `"https://console.jumpcloud.com/api"` | - | Some tenants answer only on the console host and return 404 on the other one for every request, valid key or not. |
| `identity.jumpcloud.apiKey` | `JUMPCLOUD_API_KEY` | string | **required** | yes | Organisation API key, as a secret reference. |
| `identity.jumpcloud.consoleUrl` | `JUMPCLOUD_CONSOLE_URL` | string | `"https://console.jumpcloud.com"` | - | Where a starter signs in for the first time. Printed in the password and welcome messages. |
| `identity.jumpcloud.poolUserEmail` | `JUMPCLOUD_POOL_USER_EMAIL` | string \| null | `null` | - | Spares account a returned device is rebound to. Null disables the rebind. |
| `google.serviceAccountJson` | `GOOGLE_SERVICE_ACCOUNT_JSON` | string | **required** | yes | The whole service account key file, as a secret reference. `file:/path/to/key.json` is the usual form. |
| `google.adminEmail` | `GOOGLE_ADMIN_EMAIL` | string | **required** | - | The admin this service account impersonates for directory, licensing and transfer calls. |
| `google.customer` | `GOOGLE_CUSTOMER` | literal "my_customer" | `my_customer` | - | List by customer, never by one domain: a per-domain list silently misses every account on an alias domain. |
| `google.licenceProductIds` | `GOOGLE_LICENCE_PRODUCT_IDS` | string[] | `[Google-Apps]` | - | Products searched when revoking a licence. |
| `google.driveTransfer.applications` | `GOOGLE_TRANSFER_APPLICATIONS` | drive \| calendar[] | `[drive]` | - | What is handed over. The application id is resolved at run time, never hard-coded. |
| `google.driveTransfer.privacyLevels` | `GOOGLE_TRANSFER_PRIVACY_LEVELS` | PRIVATE \| SHARED[] | `[PRIVATE, SHARED]` | - | Which files move. |
| `google.driveTransfer.fallbackRecipient` | `GOOGLE_TRANSFER_FALLBACK_RECIPIENT` | string \| null | `null` | - | Used when no manager resolves. Null parks the row for a person to decide. |
| `google.driveTransfer.pollTimeoutMinutes` | `GOOGLE_TRANSFER_POLL_TIMEOUT_MIN` | integer | `30` | - | How long one run waits before leaving the transfer to be re-polled by the next run. |
| `leaver.terminationLookbackDays` | `TERMINATION_LOOKBACK_DAYS` | integer | `60` | - | A leaving date older than this parks the row instead of acting on it. This is the backstop against a stale record being treated as a fresh departure. |
| `leaver.maxDay0PerRun` | `LEAVER_MAX_DAY0_PER_RUN` | integer | `5` | - | Circuit breaker. More day-0 candidates than this aborts the WHOLE run rather than processing the first few, because a sudden crowd of leavers is a data fault far more often than a redundancy round. |
| `leaver.maxAttemptsPerLeg` | `LEAVER_MAX_ATTEMPTS_PER_LEG` | integer | `6` | - | After this many failures a leg parks the row for a person. |
| `leaver.transferDay` | `OFFBOARD_TRANSFER_DAY` | integer | `6` | - | Days after suspension that files are handed over. |
| `leaver.deleteDay` | `OFFBOARD_DELETE_DAY` | integer | `7` | - | Days after suspension that accounts are deleted. |
| `leaver.deletion` | `LEAVER_DELETION` | automatic \| never | `automatic` | - | `never` suspends and hands over, then keeps both accounts. Day 7 is not scheduled at all: no run deletes a retained leaver, reads their devices, or reports a failure over them; the report counts them as retained. Close a row by hand with `jml leaver tombstone` once you have dealt with the accounts. `never` refuses `delete` in armedActions, because the two contradict each other. |
| `leaver.revokeLicences` | `LEAVER_REVOKE_LICENCES` | literal "all" \| string[] | `all` | - | `all`, or a list of SKU ids to revoke. |
| `leaver.deleteGoogleUser` | `LEAVER_DELETE_GOOGLE_USER` | boolean | `true` | - | False stops at suspension so the mailbox can be archived by hand. |
| `leaver.requireOperatorAck` | `LEAVER_REQUIRE_OPERATOR_ACK` | boolean | `false` | - | Require a human acknowledgement before any deletion. |
| `leaver.requireTransferBeforeDelete` | `LEAVER_REQUIRE_TRANSFER_BEFORE_DELETE` | boolean | `true` | - | Refuse deletion until the file handover is confirmed complete. |
| `leaver.autoReply.subject` | `LEAVER_AUTOREPLY_SUBJECT` | string | `"${displayName} has left ${orgName}"` | - | Placeholders: displayName, orgName, managerName, managerEmail. |
| `leaver.autoReply.bodyHtml` | `LEAVER_AUTOREPLY_BODY` | string | `"<p>${displayName} no longer works at ${orgName}.</p><p>Please contact ${managerName} at ${managerEmail}.</p>"` | - | Same placeholders as the subject. |
| `leaver.deviceGate.directBindingsOnly` | - | literal true | `true` | - | NOT overridable. Membership of a group that grants access to a machine is not custody of it, so only a direct binding blocks a deletion. |
| `leaver.deviceGate.failClosed` | - | literal true | `true` | - | NOT overridable. A gate that cannot be read blocks. Reading an error as "no devices" is how an account gets deleted while the machine is still out there. |
| `joiner.leadWorkingDays` | `JOINER_LEAD_WORKING_DAYS` | integer | `3` | - | Activate this many working days before the start date, so the temporary password reaches the manager in time. Weekends and the dates in holidays are skipped. |
| `joiner.graceDays` | `JOINER_GRACE_DAYS` | integer | `7` | - | Somebody who started more than this many days ago with no activation recorded is an existing employee, not a starter: not selected, not announced, and their manager is not nudged. On a fresh people store every employee looks like a starter otherwise. Name a person with --hris-id to activate them regardless. |
| `joiner.holidays` | - | string[] | `[]` | - | ISO dates that are not working days. Kept as data rather than a national calendar URL, because the toolkit must not depend on somebody else's endpoint being up on the morning a starter arrives. |
| `joiner.maxActivationsPerRun` | `JOINER_MAX_PER_RUN` | integer | `5` | - | More candidates than this are reported and held for the next run rather than all being activated at once. A crowd of joiners is a data fault far more often than a hiring round. |
| `joiner.gate` | `JOINER_GATE` | none \| manual \| ticket | `none` | - | What has to happen before an eligible person is activated. none: nothing. manual: somebody runs `jml joiner approve`. ticket: a ticket raised on the starter form opens it, through the configured ticketing adapter (Suptask ships), and `jml joiner approve` still works by hand. |
| `joiner.targetOrgUnitPath` | `JOINER_TARGET_OU` | string | `""` | - | Google organisational unit to move the account into on activation, for example the one whose sign-in is delegated to the identity provider. Blank skips the move. |
| `joiner.licence.productId` | - | string | `Google-Apps` | - | Google licensing product id. |
| `joiner.licence.skuId` | `JOINER_LICENCE_SKU` | string | `""` | - | The SKU to assign on activation. Blank skips licensing, and the welcome email is withheld if the mailbox is not ready anyway. |
| `joiner.mailboxPoll.tries` | - | integer | `6` | - | How many times to re-read the account waiting for the mailbox. |
| `joiner.mailboxPoll.intervalMs` | - | integer | `10000` | - | Milliseconds between reads. |
| `joiner.itSupportEmail` | `JOINER_IT_SUPPORT_EMAIL` | string \| null | `null` | - | Always receives a copy of the temporary password, so it is never lost when the other recipients are unusable. |
| `joiner.temporaryPasswordLength` | - | integer | `20` | - | Length of the generated temporary password. |
| `ticketing.adapter` | `TICKETING_ADAPTER` | none \| suptask | `none` | - | Which ticketing system. none disables every ticketing feature. |
| `ticketing.suptask.baseUrl` | `SUPTASK_BASE_URL` | string | `"https://public-api-prod.suptask.com/api/v2/public"` | - | Public API base URL. |
| `ticketing.suptask.apiToken` | `SUPTASK_API_TOKEN` | string \| null | `null` | yes | Workspace API token, as a secret reference. |
| `ticketing.suptask.queueId` | `SUPTASK_QUEUE_ID` | string | `""` | - | The inbox tickets are raised in. |
| `ticketing.suptask.requesterId` | `SUPTASK_REQUESTER_ID` | string | `""` | - | The chat user id automated tickets are raised as, usually the IT owner. |
| `ticketing.suptask.starterFormId` | `SUPTASK_STARTER_FORM_ID` | string | `""` | - | The new-starter form. Only a ticket raised on this form may open the activation gate. |
| `ticketing.suptask.leaverFormId` | `SUPTASK_LEAVER_FORM_ID` | string | `""` | - | The form leaver tickets are raised on. Blank raises them with no form. |
| `ticketing.starterForm.firstNameField` | - | string | `"First Name"` | - | Form field label holding the first name. |
| `ticketing.starterForm.lastNameField` | - | string | `"Last Name"` | - | Form field label holding the surname. |
| `ticketing.starterForm.emailField` | - | string | `"Work Email"` | - | Form field label holding the work address, if the form asks for one. Matched before the name. |
| `ticketing.starterForm.personalEmailField` | - | string | `"Personal Email"` | - | Form field label holding a personal address. Written to the person when present. |
| `ticketing.nudgeManager` | - | boolean | `true` | - | Ask the manager to raise the starter form when a joiner is detected and the gate is closed. Once per person. |
| `ticketing.dayBeforeReminder` | - | boolean | `true` | - | Remind the manager once, the day before the start date, if the gate is still closed. |
| `ticketing.leaverTicket` | - | boolean | `true` | - | Raise a ticket when a leaver becomes a day-0 candidate, so the platforms IT does not administer have somewhere to be worked through. |
| `ticketing.formInstruction` | - | string | `"In Slack, run /suptask and choose the new-starter form."` | - | One sentence telling a manager how to raise the starter form. Printed in the nudge and the reminder. |
| `ownerNotifications.enabled` | `OWNER_NOTIFICATIONS` | boolean | `false` | - | Tell each platform owner in the register when somebody leaves. |
| `ownerNotifications.goLiveDate` | `OWNER_NOTIFICATIONS_GO_LIVE` | string \| null | `null` | - | Required when enabled. Nobody whose leaving date is before this is ever notified, so switching the feature on cannot blast every owner about every leaver in the history. |
| `ownerNotifications.lookbackDays` | - | integer | `14` | - | A leaver older than this is not picked up, so a register that gains an owner later does not reopen old departures. |
| `ownerNotifications.register.adapter` | - | file | `file` | - | Where the register is read from. A file export is the reference; other sources are later adapters. |
| `ownerNotifications.register.path` | `SAAS_REGISTER_PATH` | string | `""` | - | CSV with a header row, or JSON. Required when enabled. |
| `ownerNotifications.register.nameColumn` | - | string | `Software` | - | Header of the platform-name column. |
| `ownerNotifications.register.ownerColumn` | - | string | `"Owner Email"` | - | Header of the owner-address column. Several addresses may share a cell. |
| `ownerNotifications.register.handlingColumn` | - | string | `Offboarding` | - | Header of the column saying how offboarding is handled. A value of Retired skips the row. |
| `devices.dispositionDefault` | `DEVICE_DISPOSITION_DEFAULT` | return_to_pool \| reassign \| handover \| retain_unmanaged | `return_to_pool` | - | What happens to a device when nobody says otherwise. |
| `devices.uninstallTriggers.windows` | `DEVICE_UNINSTALL_TRIGGER_WINDOWS` | string \| null | `null` | - | Command trigger name. Null refuses handover on this platform. |
| `devices.uninstallTriggers.darwin` | `DEVICE_UNINSTALL_TRIGGER_MACOS` | string \| null | `null` | - | Command trigger name. Null refuses handover on this platform. |
| `devices.uninstallTriggers.linux` | `DEVICE_UNINSTALL_TRIGGER_LINUX` | string \| null | `null` | - | Command trigger name. Null refuses handover on this platform. |
| `devices.agents` | - | object[] | `[]` | - | The agents a handover removes, and the receipt keys the script must report back. |
| `devices.agents[].name` | - | string | **required** | - | Agent name, echoed in the removal receipt. |
| `devices.agents[].windows.services` | - | string[] | `[]` | - | Service names to stop and remove. |
| `devices.agents[].windows.uninstallDisplayNames` | - | string[] | `[]` | - | Exact uninstall display names. Anchored, never a substring match. |
| `devices.agents[].windows.paths` | - | string[] | `[]` | - | Leftover paths to remove. |
| `devices.agents[].darwin.launchdLabels` | - | string[] | `[]` | - | launchd labels to bootout. |
| `devices.agents[].darwin.paths` | - | string[] | `[]` | - | Leftover paths to remove. |
| `devices.agentQuietMinutes` | `DEVICE_AGENT_QUIET_MIN` | integer | `10` | - | Last contact must be frozen this long before a device record is deleted, so the removal is confirmed by silence rather than by an exit code. |
| `devices.staleContactWarnMin` | `DEVICE_STALE_CONTACT_WARN_MIN` | integer | `60` | - | Preflight warns when a device has not been heard from for this long. |
| `devices.forbidGroupBoundCommands` | - | literal true | `true` | - | NOT overridable. A trigger fires on every association the command holds, so a group-attached uninstaller strips the whole fleet. |
| `devices.purgeTelemetryHistory` | `DEVICE_PURGE_TELEMETRY` | boolean | `false` | - | Irreversible. Requires an explicit acknowledgement at the call site as well. |
| `devices.receipt.holdMs` | `DEVICE_HOLD_MS` | integer | `120000` | - | How long to hold the association after firing. A short hold loses the work on any device that was not connected at that instant. |
| `devices.receipt.pollMs` | `DEVICE_POLL_MS` | integer | `15000` | - | Result polling interval. |
| `devices.receipt.timeoutMs` | `DEVICE_RECEIPT_TIMEOUT_MS` | integer | `600000` | - | Give up waiting for a receipt. Never read a timeout as success. |
| `devices.fleet.url` | `FLEET_API_URL` | string \| null | `null` | - | Optional host-inventory API. Null disables the adapter. |
| `devices.fleet.token` | `FLEET_API_TOKEN` | string \| null | `null` | yes | Optional host-inventory token. |
| `notify.adapters` | `NOTIFY_ADAPTERS` | slack \| email \| console[] | `[console]` | - | Where notifications go. Console is the default so the first run needs no credential. |
| `notify.weeklyReraiseDay` | `NOTIFY_WEEKLY_RERAISE_DAY` | monday \| tuesday \| wednesday \| thursday \| friday \| none | `monday` | - | A standing problem is re-raised once on this weekday. Once, not on every run of that weekday: a weekday test is true for all of it. |
| `notify.slack.botToken` | `SLACK_BOT_TOKEN` | string \| null | `null` | yes | Bot token, as a secret reference. |
| `notify.slack.itChannelId` | `SLACK_JML_CHANNEL_ID` | string \| null | `null` | - | Channel the IT summary is posted to. |
| `notify.email.itMailbox` | `IT_SUPPORT_EMAIL` | string \| null | `null` | - | Mailbox the IT summary is sent to. |
| `audit.minimisePii` | `AUDIT_MINIMISE_PII` | boolean | `true` | - | Store addresses as a salted hash. An audit log is kept for years and does not need to be a staff directory. |
| `audit.salt` | `JML_AUDIT_SALT` | string \| null | `null` | yes | Hash salt. Required when minimisePii is true. |
| `audit.jsonl.dir` | `AUDIT_DIR` | string | `./audit` | - | Directory for the append-only log files. |
| `audit.loki.enabled` | `AUDIT_LOKI_ENABLED` | boolean | `false` | - | Also push audit rows to a log aggregator. |
| `audit.loki.url` | `LOKI_PUSH_URL` | string \| null | `null` | - | Push endpoint. |
| `audit.loki.authHeader` | `LOKI_AUTH_HEADER` | string \| null | `null` | yes | Authorization header value, as a secret reference. |
| `liveness.healthchecksPingUrl` | `HC_PING_JML` | string \| null | `null` | yes | Dead-man ping URL. The URL is itself the credential, so it is a secret reference. Pinged only after a notification is proven delivered. |
| `legs.azure` | - | literal false | `false` | - | Reserved. The interface exists; nothing runs. |
| `legs.slackScim` | - | literal false | `false` | - | Reserved. The interface exists; nothing runs. |
| `legs.saasChecklist` | - | literal false | `false` | - | Reserved for a later phase. |
| `server.bind` | `JML_SERVER_BIND` | string | `"0.0.0.0:8787"` | - | Where the sidecar listens. Not published to the host in the shipped compose file. |
| `server.token` | `JML_API_TOKEN` | string | **required** | yes | Bearer token for the sidecar. At least 32 bytes; compared in constant time. |
