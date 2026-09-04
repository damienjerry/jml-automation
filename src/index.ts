/**
 * The public surface.
 *
 * Deliberately narrow. What is exported here is what an adopter can build
 * against: the vocabulary, the state machine, the store and provider ports,
 * the HR port, the engine entry points and the two things that make the whole
 * thing testable, which are the injectable clock and the fake providers.
 *
 * What is NOT exported matters as much. There is no way to reach inside a leg,
 * no way to write a status without going through `transition()`, and no export
 * that reveals a resolved credential: a SecretHandle is exported as a type so
 * an adapter can accept one, and the only thing you can do with it is `use`.
 */

// ---------------------------------------------------------------------------
// Vocabulary and the state machine
// ---------------------------------------------------------------------------
export type {
  Actor,
  BoundDevice,
  ExternalIds,
  LegName,
  LegRecord,
  LegState,
  LifecycleStatus,
  OffboardingRecord,
  Outcome,
  Person,
  PersonRunResult,
  ReviewReason,
  RunReport,
  TransitionOwner,
} from './core/types.ts'
export {
  decideTransition,
  isPreservedBySync,
  PRESERVED_BY_SYNC,
  TERMINAL_STATUSES,
  TRANSITIONS,
} from './core/transitions.ts'
export type { Transition, TransitionDecision, TransitionEvent, TransitionRefusal } from './core/transitions.ts'

// ---------------------------------------------------------------------------
// The pieces an adapter is written against
// ---------------------------------------------------------------------------
export type { Clock, IsoDate, IsoDateTime } from './core/clock.ts'
export { addDays, dateInZone, daysBetween, FakeClock, SystemClock, weekdayOf } from './core/clock.ts'
export type { DomainMap, DomainMapConfig } from './core/domain.ts'
export { createDomainMap } from './core/domain.ts'
export type { Logger, LogLevel } from './core/logger.ts'
export { createLogger, nullLogger } from './core/logger.ts'
export type { HttpClient, HttpRequest, HttpResponse } from './core/http.ts'
export { createHttpClient, HttpError } from './core/http.ts'
export type { ChangeGate, GateDecision } from './core/gate.ts'
export { createChangeGate } from './core/gate.ts'

export type { JmlConfig } from './config/schema.ts'
export { ALL_ARMED_ACTIONS, ConfigObject, ConfigSchema } from './config/schema.ts'
export type { ArmedAction } from './config/schema.ts'
export { ConfigError, describeConfig, loadConfig } from './config/load.ts'
export type { LoadedConfig } from './config/load.ts'
export type { SecretHandle, SecretProvider, SecretRegistry } from './config/secrets.ts'
export { redact, redactDeep, redactError } from './config/redact.ts'

export type { PeopleStore, PersonFilter, StateStore, TransitionRequest, TransitionResult } from './store/types.ts'
export { MemoryPeopleStore } from './store/memory/store.ts'
export { SqlitePeopleStore } from './store/sqlite/store.ts'
export { SqliteStateStore } from './store/state-sqlite.ts'
export { bootstrapTombstones, checkDepartedInvariant, DAY0_SELECTION, verifyStore } from './store/bootstrap.ts'
export type { BootstrapReport, VerifyReport } from './store/bootstrap.ts'

export type { ConnectionCheck, HrisAdapter, HrisPerson, HrisSnapshot } from './hris/types.ts'
export { HrisImplausible, HrisIncomplete } from './hris/types.ts'
export { FixtureHrisAdapter, readFixtureFile } from './hris/fixture.ts'
export { HiBobAdapter } from './hris/hibob/adapter.ts'

export type {
  CommandReceipt,
  CommandTargeting,
  DeviceConnector,
  GoogleWorkspaceConnector,
  IdentityConnector,
  ProviderUser,
} from './connectors/types.ts'
export { AmbiguousMatch, GateError } from './connectors/types.ts'
export { createFakeProviders, FakeProviders } from './connectors/fake.ts'
export type { FakeProvidersSeed } from './connectors/fake.ts'
export { createGoogleConnector } from './connectors/google/index.ts'
export { JumpCloudClient } from './connectors/jumpcloud/client.ts'
export { JumpCloudCommands } from './connectors/jumpcloud/commands.ts'
export { JumpCloudDevices } from './connectors/jumpcloud/devices.ts'
export { JumpCloudUsers } from './connectors/jumpcloud/users.ts'

export type { AuditEvent, AuditSink } from './audit/types.ts'
export { createJsonlAuditSink } from './audit/jsonl.ts'
export { createFanoutAuditSink } from './audit/fanout.ts'
export type { Notification, Notifier, NotificationResult } from './notify/types.ts'
export { createConsoleNotifier } from './notify/console.ts'
export { createEmailNotifier } from './notify/email.ts'
export { createFanoutNotifier } from './notify/fanout.ts'
export { createSlackNotifier } from './notify/slack.ts'

// ---------------------------------------------------------------------------
// Running the thing
// ---------------------------------------------------------------------------
export { runPipeline } from './engine/pipeline.ts'
export type { PipelineDeps, PipelineOptions, PipelineStepName } from './engine/pipeline.ts'
export { runSync } from './engine/sync.ts'
export type { SyncOptions, SyncReport } from './engine/sync.ts'
export { runDetect } from './engine/detect.ts'
export type { DetectOptions, DetectReport } from './engine/detect.ts'
export { runLeaverEngine } from './engine/leaver/engine.ts'
export type { LeaverRunOptions } from './engine/leaver/engine.ts'
export type { LeaverDeps } from './engine/leaver/legs.ts'
export { previewDeviceDisposition, runDeviceDisposition } from './engine/device/disposition.ts'
export type { DispositionReport } from './engine/device/disposition.ts'
export type { DeviceDeps, DeviceDisposition, DevicePreflight, DispositionRequest } from './engine/device/preflight.ts'

export { main } from './cli/index.ts'
export { runDemo } from './cli/demo.ts'
export type { DemoResult } from './cli/demo.ts'
export { runDoctor } from './cli/doctor.ts'
export type { DoctorReport, DoctorRow } from './cli/doctor.ts'
export { startServer } from './server/http.ts'
export { handle, JobBoard } from './server/routes.ts'
export type { ServerEngine, ServerRequest, ServerResponse } from './server/routes.ts'
