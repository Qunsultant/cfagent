/**
 * Issue #359-16: task schedule management routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move -
 * no behavior change.
 *
 * Owns the contiguous schedules block (invoked at the EXACT original
 * position in routeRequest's sequential matching sequence, after the
 * screener + research delegation and before routeRequest's Not-found
 * fallthrough):
 *   GET         /schedules                        (list; ?type=cron|interval|delayed|scheduled)
 *   POST        /schedules/cancel                 (cancel by id)
 *   DELETE      /schedules/:id                    (cancel by id)
 *   GET         /schedules/:id                    (get by id)
 *   POST        /schedules/create                 (create; #111 callback allow-list)
 *   POST        /schedules                        (create alias)
 *   POST        /schedules/trigger-screen
 *   POST        /schedules/trigger-renew
 *   POST        /schedules/trigger-options-analysis
 *   POST        /schedules/trigger-retention      (issue #255)
 *   POST        /schedules/record-cron-dispatch    (issue #3121 S5 — Worker cron dispatch ledger row)
 *   POST        /schedules/runs/record             (issue #3121 Phase 2 #3123 — ledger record route)
 *   POST        /schedules/trigger-iv-collection  (issue #15)
 *   POST        /schedules/trigger-discovery      (issue #126)
 *   POST        /schedules/:id/pause               (issue #273)
 *   POST        /schedules/:id/resume              (issue #273)
 *   POST        /schedules/:id/trigger             (issue #273)
 *   POST        /schedules/pause                   (issue #5878 — bulk pause by scope)
 *   POST        /schedules/resume                  (issue #5878 — bulk resume by scope)
 *   POST        /schedules/trigger                 (issue #5878 — bulk run-now by scope)
 *   PUT         /schedules/:id                     (issue #273)
 *   GET         /schedules/approvals               (issue #3122 — list pending agent-schedule approvals)
 *   POST        /schedules/approvals/:id/approve   (issue #3122 — PDP-checked approve + arm)
 *   POST        /schedules/approvals/:id/reject    (issue #3122 — PDP-checked reject)
 *
 * The handler ends with an explicit `return null` - never undefined.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * SchedulesRouteContext parameter; there are no new globals and no
 * back-references into the class. The Agents SDK scheduler methods stay
 * owned by the Agent base class and arrive as narrow wrappers (the
 * `as keyof this` assertion pattern from the #109 NLQ scheduling port).
 * The #111 callback allow-list constants stay module-owned by
 * orchestrator.ts (CREATABLE_SCHEDULE_CALLBACKS is a public export) and
 * arrive via the context.
 */

import type { AgentContext, Schedule, ScheduleCriteria } from "agents";
import { defaultAccountTypeForCallback } from "../../config/accountBindings";
import { resolveEnvironmentConfig } from "../../config/environment";
import { getStoredTokens, isTokenExpiredEt, etradeIdentityFromLogin } from "../../security/etradeOAuth";
import {
  BROKER_DISPLAY_NAMES,
  isBrokerId,
  resolveTenantProviders,
} from "../../services/tenantProviders";
import {
  accountBindingAuditFields,
  resolveValidatedExecutionAccountContext,
  type ExecutionAccountContext,
} from "../../services/accountBindings";
import { TradingPlatformRegistry, tradingTypeFor } from "../../trading";
import { AGENTIC_LOOP_UNAVAILABLE_REASON } from "../../schedule";
import type { BrokerAccount } from "../../types";
// Issue #5104 (DEFAULT part of B1): the brokerCatalog helpers are
// re-exported by the trading barrel (src/trading/index.ts), which is
// the sole public import surface of src/trading/ (#290 boundary).
// Importing the leaf module directly (../../trading/brokerCatalog)
// violates that boundary; the barrel is the only allowed path.
// The barrel's load cycle with providerConnections is a load-time
// concern only — defaultBrokerId()/defaultTradingMode() are called
// at request time, after all modules have initialized.
import { defaultBrokerId, defaultTradingMode } from "../../trading";
import { isLoginShaped, getServiceUserLogin } from "../../security/serviceIdentity";
import type { JobRunTrigger } from "../../data/jobRunRecordPorts";
import { findDuplicateSchedule } from "../../services/scheduleDedupe";

/**
 * Issue #5516 — the creation-time broker when the tenant store cannot be read.
 * This is NOT a run default: a run resolves `config/vocabulary.json` → broker
 * through the one externalized block. It is the pre-#3655 bootstrap
 * path kept deliberately (the gate below states the contract): an unreadable
 * selection has always meant "run the E*TRADE token check", and that check
 * names the broker it checks. Pinned by tests/run_defaults_5516.test.ts (D5)
 * so a later cleanup cannot silently reroute schedule creation to a broker the
 * deployment has no credentials for.
 */
const LEGACY_UNREADABLE_BROKER = "etrade";
import {
  buildScheduleProvenance,
  isSubDailyCron,
  isSubDailyInterval,
  isValidCron,
  stampScheduleProvenance,
} from "../../services/consolidatedScheduling";
import { runStorageRetention } from "../../security/storageRetention";
import { createAuditPolicyAdapter } from "../../data/createAuditPolicyPorts";
import { auditEventPort } from "../../data/createAuditEventPorts";
import { pruneAuditChainForTenant } from "../../data/auditPolicyPorts";
import { createProfileAdapter } from "../../data/createProfilePorts";
import { createOrmPorts } from "../../data/createOrmPorts";
import { loadIdpProfileConfig } from "../../security/idpProfileConfig";
import { verifyStoredAuditChainAndAlertD1, type TamperAlertResult } from "../../services/auditTamperAlert";
import {
  verifyStoredAuditChainAndAlertCheckpointedD1,
  type CheckpointedTamperAlertResult,
} from "../../services/auditChainVerification";
import { settingReadFromSql, settingWriteFromSql } from "../../services/screeningFlags";
import { createBlobStore } from "../../services/blobStoreR2Adapter";
import { pruneJobOutcomes } from "../../services/jobOutcomes";
import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import {
  applyScheduleChannelToggle,
  resolveScheduleChannelFlagsView,
} from "../../features/scheduleChannelFlags";
import { DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS } from "../../config/scheduleFrequencyFloor";
import {
  SCHEDULE_BELOW_FREQUENCY_FLOOR,
  isBelowFrequencyFloorError,
  refuseBelowFloorTiming,
  type ScheduleFloorTiming,
} from "../../services/scheduleFrequencyFloor";
import {
  applyScheduleControlsPatch,
  resolveEffectiveScheduleFloor,
  resolveEffectiveScheduleStartPaused,
  resolveScheduleControlsView,
} from "../../services/scheduleControls";
import { checkPlatformPermission } from "../../security/iaaaPdpSeam";
import { isTenantAdminForTenant } from "../../data/referralCodePorts";
import { lookupInternalUserIdByLogin } from "../../security/iaaaMigration";
import { createKvMembershipStore } from "../../security/iaaaMembershipStore";
import { sessionStore } from "../../security/session";

import { nameLedgerWriteFailure, recordScheduleCallbackRun } from "../orchestrator/scheduleCallbackRunRecords";
import {
  buildSnapshotManifest,
  ORPHAN_SWEEP_PREFIX,
  planOrphanSweep,
  resolveOrphanSweepDelete,
  resolveSnapshotEnabled,
  SNAPSHOT_ROW_LIMIT,
  snapshotObjectKey,
} from "../../data/retention1766";
import {
  buildSchedulePayload,
  validateStrategyRequest,
} from "../../trading";
import {
  buildOptionsDiscoveryPorts,
  createOptionsDiscoveryPorts,
} from "../../data/createOptionsDiscoveryPorts";
import { ScheduledTasksService } from "../../services/scheduledTasks";
import { pickFeedLoadParams } from "../../services/feedSnapshotStore";
import {
  activateCreatedSchedule,
  collapseScheduleListItems,
  deleteUnifiedSchedule,
  getUnifiedScheduleDetail,
  isBulkScheduleScope,
  listUnifiedScheduleItems,
  pauseSchedulesInScope,
  pauseUnifiedSchedule,
  pausedScreenScheduleToRecord,
  resumeSchedulesInScope,
  resumeUnifiedSchedule,
  screenScheduleToRecord,
  TICKER_PUSH_RECORD_ID,
  TOKEN_RENEWAL_RECORD_ID,
  RETENTION_RECORD_ID,
  NIGHTLY_RESEARCH_RECORD_ID,
  STALE_LEDGER_SWEEP_RECORD_ID,
  STALE_ASYNC_JOB_SWEEP_RECORD_ID,
  SCHEDULE_WATCHDOG_RECORD_ID,
  SYSTEM_SCHEDULE_RECORD_IDS,
  tickerPushRecordToListItem,
  tokenRenewalRecordToListItem,
  retentionRecordToListItem,
  nightlyResearchRecordToListItem,
  staleLedgerSweepRecordToListItem,
  staleAsyncJobSweepRecordToListItem,
  scheduleWatchdogRecordToListItem,
  triggerUnifiedSchedule,
  triggerSchedulesInScope,
  unifiedRecordToListItem,
  updateUnifiedSchedule,
  type BulkScheduleRowExecutor,
  type BulkScheduleScope,
  type BulkScheduleSummary,
  type BulkScheduleVerb,
  type ResolvedScheduleTiming,
  type ScheduleAlarms,
  type ScheduleAlarmLike,
} from "../../services/unifiedScheduleManagement";
import { SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID } from "../../services/scheduleWatchdog";
import {
  TICKER_INSTANCE_NAME,
  resolveTickerPushStaleAfterIntervals,
} from "../ticker-agent";
import { actorGateway } from "../../services/cloudflareActorGateway";
import type { TickerPushRecordStub } from "../../services/actorGatewayPorts";
import { createD1UnifiedSchedulePorts } from "../../data/createUnifiedSchedulePorts";
import type { ScheduleStore, UnifiedScheduleRecord } from "../../data/unifiedSchedulePorts";
import {
  createJobRunRecordAdapter,
  recordLedgerRunD1,
  resolveLedgerAttribution,
  type D1JobRunRecordStore,
} from "../../data/createJobRunRecordPorts";
import { buildJobRunRecord, scheduleIdToLedgerJobId, type JobRunRecordInput } from "../../services/jobRunRecords";
import { RENEWAL_DISPATCH_CRON, RETENTION_DISPATCH_CRON } from "../../services/heartbeatDueChecks";
import { resolveActorAttribution } from "../../security/backgroundAttribution";
import type { DatabaseORM } from "../../orm";
import type { AgentName, AgentScheduleItem, Env } from "../../types";
import {
  agentScheduleProvenance,
  createAgentScheduleExecutorDepsForDo,
  createAgentSchedulePdpDeps,
  createPausedAgentSdkScheduleRecord,
  decidePendingScheduleApproval,
  evaluateAgentSchedulePdp,
  executeAgentScheduleAction,
  removeAgentSdkScheduleRecord,
  resolvePendingScheduleApproval,
  unifiedRecordToAgentSdkScheduleItem,
  type AgentScheduleActionResult,
  type AgentSdkScheduleAdapter,
  type AgentSdkTiming,
  type AgentWorkflowStageScheduleAdapter,
} from "../../services/agentScheduleCapability";
import {
  createWorkflowStageScheduleAdapter,
  validateWorkflowStageScheduleInput,
  type WorkflowStageRegistry,
} from "../../services/workflowStageSchedule";
import { getScheduledAgentDoor } from "../orchestrator/meshDoors";
import { resolveIaaaTenant } from "../../security/iaaaGithubEndToEnd";
import {
  IAAA_AUDIT_POLICY_VERSION,
  recordAuditEvent,
  shouldBlockAction,
  type AuditStore,
} from "../../security/iaaaAudit";
import { createWiredAuditStore } from "../../security/iaaaAuditStore";
import { scheduleWebhookFollowupBodySchema } from "../../api/ingressSchemas";
import {
  buildScheduleWebhookFollowupSubmission,
  buildScheduleWebhookMintRecord,
  SCHEDULE_WEBHOOK_AUDIT_EVENTS,
} from "../../services/scheduleWebhookFollowup";
import {
  deriveScheduleWebhookIdempotencyKey,
  OrmReplayStore,
  resolveScheduleWebhookIdempotencyTtlMs,
  sharedMemoryReplayStore,
  type ReplayStore,
} from "../../security/webhookReplay";
import { createPendingScheduleApprovalPort } from "../../data/doSqlitePendingScheduleApprovalsAdapter";

import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { handleCronDispatchRecordRoute } from "./cronDispatchRecord";
import { RECORDED_SCHEDULE_CALLBACKS } from "../orchestrator/scheduleCallbacks";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/routes/schedules",
});

/** Structural mirror of OrchestratorAgent's private ETradeEnvironment
 * (src/agents/orchestrator.ts). */
type ETradeEnvironment = "TEST" | "PROD";

/** Structural mirror of OrchestratorAgent's private ScreenerExecutionContext
 * (src/agents/orchestrator.ts). */
type ScreenerExecutionContext = { userLogin: string; environment?: ETradeEnvironment };

/** The subset of OrchestratorAgent surface the schedules handlers need. */
export interface SchedulesRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** Durable Object agent context (owner: OrchestratorAgent - was `this.ctx`),
   * used for the SqlStorage-backed stores. */
  agentCtx: AgentContext;
  /** Audit funnel (owner: OrchestratorAgent.audit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /**
   * Issue #6503 step 9 (G2) — test seam: use this IAAA audit store
   * instead of createWiredAuditStore(env) for the audit-before-write
   * record. Absent, the route records through the wired store (the
   * SessionStore DO audit-append); a store that cannot append
   * blocks the control op with the coded 503, never a silent
   * unaudited write.
   */
  auditStore?: AuditStore | null;
  /** SDK schedule listing (owner: Agent base class - was `this.listSchedules`). */
  listSchedules(criteria?: ScheduleCriteria): Promise<Schedule<unknown>[]>;
  /** SDK schedule cancellation (owner: Agent base class - was `this.cancelSchedule`). */
  cancelSchedule(id: string): Promise<boolean>;
  /** SDK schedule lookup (owner: Agent base class - was `this.getScheduleById`). */
  getScheduleById(id: string): Promise<Schedule<unknown> | undefined>;
  /** SDK scheduler (owner: Agent base class - was `this.schedule`). */
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<Schedule<unknown>>;
  /**
   * Issue #4351 — re-declare the code-declared scheduled tasks (the SDK's
   * `internal_reconcileScheduledTasks`), so a resumed declared task is armed
   * again immediately instead of on the next host start. Optional: a host with
   * no declaration reconciles nothing.
   */
  reconcileScheduledTasks?: () => Promise<void>;
  /** SDK interval scheduler (owner: Agent base class - was `this.scheduleEvery`). */
  scheduleEvery(
    intervalSeconds: number,
    callback: string,
    payload?: unknown
  ): Promise<Schedule<unknown>>;
  /** Execution-context accessor (owner: OrchestratorAgent.getScreenerExecutionContext - was `this.getScreenerExecutionContext`). */
  getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined>;
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Issue #1123 S5b: follow-up bridge for screener runs triggered
   *  through the schedule routes (optional — hosts without it keep
   *  the service's event-bus behavior). */
  scheduleScreenerFollowups?: (
    outcome: import("../../services/screenerFollowups").ScreenerRunOutcome,
    userLogin: string,
    chainReport?: boolean,
  ) => Promise<void>;
  /** Consolidation #1236 (feed seam): submit an async job (owner:
   *  OrchestratorAgent.submitAsyncJob). Used by the feed-snapshot
   *  route; hosts without it cannot submit feed jobs. */
  submitAsyncJob?: (spec: import("../../types").AsyncJobSubmission) => Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
  /** Scheduled market screen (owner: OrchestratorAgent.autonomousMarketScreen - was `this.autonomousMarketScreen`). */
  autonomousMarketScreen(payload?: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    broadcast?: boolean;
    trigger?: JobRunTrigger;
    userLogin?: string;
    environment?: ETradeEnvironment;
    emailTo?: string;
    slackChannel?: string;
    webhookUrl?: string;
    pushToSlack?: boolean;
    filters?: import("../../types").StockScreenerFilter;
    provider?: import("../../trading").StockScreenProvider;
    stageChain?: import("../../types").StageChainConfig;
  }): Promise<void>;
  /** E*TRADE token renewal (owner: OrchestratorAgent.autoRenewETradeTokens - was `this.autoRenewETradeTokens`). */
  autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }): Promise<void>;
  /** #111 user-creatable callback allow-list (owner: orchestrator.ts module const CREATABLE_SCHEDULE_CALLBACKS). */
  creatableScheduleCallbacks: readonly string[];
  /** Account-scoped callback set (owner: orchestrator.ts module const ACCOUNT_SCOPED_SCHEDULE_CALLBACKS). */
  accountScopedScheduleCallbacks: ReadonlySet<string>;
  /** Manual dispatch of a schedule's own callback (owner: OrchestratorAgent — a dynamic this[callback] invocation), used by POST /schedules/:id/trigger (#273). */
  runScheduleCallback(callback: string, payload: unknown): Promise<void>;
  /**
   * Issue #4260 — injectable flag port for the schedules/flags routes
   * (tests and local in-memory runtimes). Absent, the routes resolve
   * createFeatureFlagPort(ctx.env) per request.
   */
  featureFlagPort?: import("../../features/featureFlagPorts").FeatureFlagPort;
  /**
   * Issue #4260 — injectable membership store for the platform-admin
   * probe behind the schedules/flags toggle (tests). Absent, the
   * probe builds it from the session store, as AdminTenantQueues does.
   */
  flagMembershipStore?: import("../../security/authorization").MembershipStore;
  /**
   * Issue #4260 — injectable alias KV for the login→internal-id
   * lookup behind the schedules/flags toggle (tests). Absent, the
   * probe uses the session store.
   */
  flagAliasKv?: import("../../security/kvResilience").KvLike;
}

/**
 * Issue #1170 (E3): the runScheduleCallback closure that used to be
 * built inline in OrchestratorAgent.routeRequest's schedules
 * context now lives here with the routes it serves (the #992
 * extraction pattern — this is what keeps orchestrator.ts inside
 * its size budget as new dispatch blocks land). Behaviour is
 * identical to the inline closure: resolve the named method on the
 * host, refuse non-callables with the same error, invoke with the
 * host as `this`.
 */
export function makeRunScheduleCallback(
  host: unknown
): SchedulesRouteContext["runScheduleCallback"] {
  return async (callback: string, payload: unknown) => {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const executionMode = (payload as Record<string, unknown>).executionMode;
      if (executionMode === "agentic-loop") {
        throw new Error(AGENTIC_LOOP_UNAVAILABLE_REASON);
      }
      if (executionMode !== undefined && executionMode !== "deterministic") {
        throw new Error(`Unsupported schedule executionMode: ${String(executionMode)}.`);
      }
    }
    const fn = (host as Record<string, unknown>)[callback];
    if (typeof fn !== "function") {
      throw new Error(`Schedule callback '${callback}' is not callable on the orchestrator.`);
    }
    await (fn as (p: unknown) => Promise<void>).call(host, payload);
  };
}

/**
 * Issue #3121 #3310 — the one alarms-port construction for the
 * unified management service: the SDK scheduler surface
 * (list/get/cancel/arm) over the class's Agent methods. The routes
 * and the A2A capability instance share it, so the two never drift
 * into different arming behavior.
 *
 * Issue #6482 — the port is also a floor enforcement point: arm()
 * refuses a below-floor interval or cron (coded
 * SCHEDULE_BELOW_FREQUENCY_FLOOR) before touching the SDK, so
 * every arm through the unified management service and the stage
 * adapter goes through the one hard-reject helper. The floor
 * resolves per arm through the caller's resolver (managed setting
 * > env carrier > default (monthly 2,592,000s)); with no resolver the fail-closed
 * default applies. One-shot timings pass through.
 */
// Issue #6482 — the resolved timing in floor-helper shape (cron /
// interval carry a frequency; one-shot timings pass through), shared
// by arm() and checkFloor() so the two can never disagree about what
// a timing means.
function timingForFloor(timing: ResolvedScheduleTiming): ScheduleFloorTiming {
  return timing.type === "cron"
    ? { type: "cron", cron: timing.cron }
    : timing.type === "interval"
      ? { type: "interval", intervalSeconds: timing.intervalSeconds }
      : { type: "scheduled", time: timing.time };
}

export function makeScheduleAlarmsPort(
  scheduling: Pick<
    SchedulesRouteContext,
    "listSchedules" | "getScheduleById" | "cancelSchedule" | "schedule" | "scheduleEvery"
  >,
  opts?: { resolveFloor?: () => number },
): ScheduleAlarms {
  return {
    list: () =>
      scheduling
        .listSchedules()
        .then((s) => s as unknown as ScheduleAlarmLike[]),
    get: (id) =>
      scheduling
        .getScheduleById(id)
        .then((s) => (s ? (s as unknown as ScheduleAlarmLike) : undefined)),
    cancel: (id) => scheduling.cancelSchedule(id),
    // Issue #6482 — the floor check without arming: update
    // pre-validates the new timing through it before cancelling,
    // so a refused update leaves the schedule exactly as it was.
    checkFloor: (timing) => {
      const floorSeconds = opts?.resolveFloor?.() ?? DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS;
      const refusal = refuseBelowFloorTiming(timingForFloor(timing), floorSeconds);
      return refusal.ok ? { ok: true } : { ok: false, message: refusal.message };
    },
    arm: async (timing, callback, payload, options) => {
      const floorSeconds = opts?.resolveFloor?.() ?? DEFAULT_SCHEDULE_MIN_INTERVAL_SECONDS;
      const refusal = refuseBelowFloorTiming(timingForFloor(timing), floorSeconds);
      if (!refusal.ok) throw refusal.error;
      // Issue #6482 — a recorded idempotent opt-out rides the SDK
      // arm (default idempotent: true); interval arms take no options.
      const idempotent = options?.idempotent ?? true;
      if (timing.type === "cron")
        return scheduling
          .schedule(timing.cron, callback, payload, { idempotent })
          .then((s) => s as unknown as ScheduleAlarmLike);
      if (timing.type === "interval")
        return scheduling
          .scheduleEvery(timing.intervalSeconds, callback, payload)
          .then((s) => s as unknown as ScheduleAlarmLike);
      return scheduling
        .schedule(new Date(timing.time * 1000), callback, payload, { idempotent })
        .then((s) => s as unknown as ScheduleAlarmLike);
    },
  };
}

/**
 * Task schedule management routes. Invoked from routeRequest at the exact
 * position the original block occupied (after the
 * handleScreenerResearchRoutes delegation, before the Not-found
 * fallthrough); returns a Response when one of the owned paths matches, or
 * null to continue sequential matching.
 */
/**
 * Issue #4004 follow-up — which identity a schedule-creation request acts
 * as. The header is the Worker-established identity for this request and
 * wins whenever it is usable; the per-instance screener context is the
 * fallback for callers that carry no identity, never an override of one.
 * A context login such as an agent identity ("openaimp") therefore cannot
 * shadow the signed-in owner and send the credential lookup to the wrong
 * connection (the stale connection has no stored credential for the owner).
 */
type ScheduleEnv = "TEST" | "PROD";

export function resolveTrustedScheduleIdentity(input: {
  headerLogin: string | null | undefined;
  headerEnvironment: string;
  context?: { userLogin?: string; environment?: ScheduleEnv } | null;
  configuredEnvironment: ScheduleEnv;
}): { userLogin: string; environment: ScheduleEnv } {
  const headerLogin = isLoginShaped(input.headerLogin) ? input.headerLogin : "";
  const headerEnv =
    input.headerEnvironment === "TEST" || input.headerEnvironment === "PROD"
      ? (input.headerEnvironment as ScheduleEnv)
      : undefined;
  return {
    userLogin: headerLogin || input.context?.userLogin || "",
    environment: headerEnv || input.context?.environment || input.configuredEnvironment,
  };
}

/**
 * Issue #3121 #4237 — the ticker-push row for the Schedules home
 * list. The record lives in the TickerAgent's own store (ADR 0029
 * D-0), so the list reads it through the typed RPC and appends its
 * list item (interval + last push + derived health). Best-effort:
 * an unbound namespace, a failed RPC, a null record, or a record of
 * another kind omits the row and logs a warning — the list never
 * fails because the live feed cannot be reached. The health
 * threshold resolves from env here, never on the client.
 */
export async function readTickerPushListItem(
  env: Env,
): Promise<ReturnType<typeof tickerPushRecordToListItem> | null> {
  try {
    const stub = actorGateway.stub<TickerPushRecordStub>(
      env.TICKER_AGENT,
      TICKER_INSTANCE_NAME,
    );
    const record = await stub.getTickerPushRecord();
    if (!record || record.kind !== "ticker-push") return null;
    return tickerPushRecordToListItem(
      record,
      Date.now(),
      resolveTickerPushStaleAfterIntervals(env),
    );
  } catch (err) {
    structuredLog.warn("schedules.ticker_push_read_failed", {
      message: "[Schedules] ticker-push list read failed; the row is omitted:",
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Issue #6503 — the token-renewal row for the Schedules home
 * list, from its STORED record: the last renewal is joined from
 * the ledger's own renewal-dispatch rows (jobId =
 * RENEWAL_DISPATCH_CRON), so the row shows the duty's last firing
 * — or none, when it has never fired. No stored record means no
 * row: nothing is synthesized. Best-effort on the ledger read: a
 * failed ledger read renders the stored row without a last run and
 * logs a warning — the list never fails, and the row never vanishes,
 * because the ledger cannot be read. The `store` is the D1
 * job-run-records store (#6101); null reads as "no last run".
 */
export async function readTokenRenewalListItem(
  store: D1JobRunRecordStore | null | undefined,
  record?: UnifiedScheduleRecord | null,
): Promise<ReturnType<typeof tokenRenewalRecordToListItem> | null> {
  if (!record) return null;
  try {
    const lastRun = store ? await store.latestByJob(RENEWAL_DISPATCH_CRON) : undefined;
    return tokenRenewalRecordToListItem(
      record,
      lastRun ? { started: lastRun.started, finished: lastRun.finished, outcome: lastRun.outcome } : undefined,
    );
  } catch (err) {
    structuredLog.warn("schedules.token_renewal_read_failed", {
      message: "[Schedules] token-renewal last-run read failed; the stored row renders without it:",
      error: err instanceof Error ? err.message : String(err),
    });
    return tokenRenewalRecordToListItem(record);
  }
}

/**
 * Issue #6503 — the retention row for the Schedules home list,
 * from its STORED record: the last pass is joined from the
 * ledger's own retention-dispatch rows (jobId =
 * RETENTION_DISPATCH_CRON), so the row shows the duty's last pass
 * — or none, when it has never fired. The pass-outcome summary
 * rides the row's lastRunDetail (the dispatch row's `detail`,
 * rendered verbatim). No stored record means no row. Best-effort
 * on the ledger read, like the token-renewal row: the stored row
 * renders without a last run when the ledger cannot be read.
 */
export async function readRetentionListItem(
  store: D1JobRunRecordStore | null | undefined,
  record?: UnifiedScheduleRecord | null,
): Promise<ReturnType<typeof retentionRecordToListItem> | null> {
  if (!record) return null;
  try {
    const lastRun = store ? await store.latestByJob(RETENTION_DISPATCH_CRON) : undefined;
    return retentionRecordToListItem(
      record,
      lastRun ? { started: lastRun.started, finished: lastRun.finished, outcome: lastRun.outcome, detail: lastRun.detail } : undefined,
    );
  } catch (err) {
    structuredLog.warn("schedules.retention_read_failed", {
      message: "[Schedules] retention last-run read failed; the stored row renders without it:",
      error: err instanceof Error ? err.message : String(err),
    });
    return retentionRecordToListItem(record);
  }
}

/**
 * Issue #6503 — the nightly research row for the Schedules home
 * list, from its STORED record: the last run is joined from the
 * ledger's own nightly-research rows (jobId =
 * NIGHTLY_RESEARCH_RECORD_ID, the row the scheduled-tick handler
 * writes when the run fires), so the row shows the duty's last run
 * — or none, when it has never fired. No stored record means no
 * row. Best-effort on the ledger read, like its siblings.
 */
export async function readNightlyResearchListItem(
  store: D1JobRunRecordStore | null | undefined,
  record?: UnifiedScheduleRecord | null,
): Promise<ReturnType<typeof nightlyResearchRecordToListItem> | null> {
  if (!record) return null;
  try {
    const lastRun = store ? await store.latestByJob(NIGHTLY_RESEARCH_RECORD_ID) : undefined;
    return nightlyResearchRecordToListItem(
      record,
      lastRun ? { started: lastRun.started, finished: lastRun.finished, outcome: lastRun.outcome } : undefined,
    );
  } catch (err) {
    structuredLog.warn("schedules.nightly_research_read_failed", {
      message: "[Schedules] nightly research last-run read failed; the stored row renders without it:",
      error: err instanceof Error ? err.message : String(err),
    });
    return nightlyResearchRecordToListItem(record);
  }
}

/**
 * Issue #6503 — the stale-ledger-task sweep row for the Schedules
 * home list, from its STORED record: the last run is joined from
 * the ledger's own sweep rows (jobId =
 * STALE_LEDGER_SWEEP_RECORD_ID, the row the #3394 wrapper writes
 * when the sweep fires), so the row shows the duty's last run with
 * its swept/pruned counts — or none, when it has never fired. No
 * stored record means no row. Best-effort on the ledger read, like
 * its siblings.
 */
export async function readStaleLedgerSweepListItem(
  store: D1JobRunRecordStore | null | undefined,
  record?: UnifiedScheduleRecord | null,
): Promise<ReturnType<typeof staleLedgerSweepRecordToListItem> | null> {
  if (!record) return null;
  try {
    const lastRun = store ? await store.latestByJob(STALE_LEDGER_SWEEP_RECORD_ID) : undefined;
    return staleLedgerSweepRecordToListItem(
      record,
      lastRun ? { started: lastRun.started, finished: lastRun.finished, outcome: lastRun.outcome, detail: lastRun.detail } : undefined,
    );
  } catch (err) {
    structuredLog.warn("schedules.stale_ledger_sweep_read_failed", {
      message: "[Schedules] stale ledger sweep last-run read failed; the stored row renders without it:",
      error: err instanceof Error ? err.message : String(err),
    });
    return staleLedgerSweepRecordToListItem(record);
  }
}

/**
 * Issue #6503 — the stale-async-job sweep row for the Schedules
 * home list, from its STORED record: the last run is joined from
 * the ledger's own sweep rows (jobId =
 * STALE_ASYNC_JOB_SWEEP_RECORD_ID), counts in the row's detail.
 * No stored record means no row. Best-effort like its siblings.
 */
export async function readStaleAsyncJobSweepListItem(
  store: D1JobRunRecordStore | null | undefined,
  record?: UnifiedScheduleRecord | null,
): Promise<ReturnType<typeof staleAsyncJobSweepRecordToListItem> | null> {
  if (!record) return null;
  try {
    const lastRun = store ? await store.latestByJob(STALE_ASYNC_JOB_SWEEP_RECORD_ID) : undefined;
    return staleAsyncJobSweepRecordToListItem(
      record,
      lastRun ? { started: lastRun.started, finished: lastRun.finished, outcome: lastRun.outcome, detail: lastRun.detail } : undefined,
    );
  } catch (err) {
    structuredLog.warn("schedules.stale_async_job_sweep_read_failed", {
      message: "[Schedules] stale async-job sweep last-run read failed; the stored row renders without it:",
      error: err instanceof Error ? err.message : String(err),
    });
    return staleAsyncJobSweepRecordToListItem(record);
  }
}

/**
 * Issue #6503 — the schedule-watchdog row for the Schedules home
 * list, from its STORED record: the last run is joined from the
 * ledger's heartbeat rows (jobId = SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
 * the row the watchdog itself writes every sweep), so the row shows
 * the duty's last sweep with its examined/missed/skipped counts —
 * or none, when it has never fired. No stored record means no row.
 * Best-effort like its siblings.
 */
export async function readScheduleWatchdogListItem(
  store: D1JobRunRecordStore | null | undefined,
  record?: UnifiedScheduleRecord | null,
): Promise<ReturnType<typeof scheduleWatchdogRecordToListItem> | null> {
  if (!record) return null;
  try {
    const lastRun = store ? await store.latestByJob(SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID) : undefined;
    return scheduleWatchdogRecordToListItem(
      record,
      lastRun ? { started: lastRun.started, finished: lastRun.finished, outcome: lastRun.outcome, detail: lastRun.detail } : undefined,
    );
  } catch (err) {
    structuredLog.warn("schedules.schedule_watchdog_read_failed", {
      message: "[Schedules] schedule watchdog last-run read failed; the stored row renders without it:",
      error: err instanceof Error ? err.message : String(err),
    });
    return scheduleWatchdogRecordToListItem(record);
  }
}

/**
 * Issue #4260: where the surfaced flags are managed, for the home's
 * read-only guidance. An injected port (tests / local in-memory
 * runtimes) is the in-memory source; a FLAGS binding means the
 * Cloudflare Flagship dashboard; otherwise environment variables.
 */
function resolveFlagManagedBy(ctx: SchedulesRouteContext): "flagship" | "environment" | "in-memory" {
  if (ctx.featureFlagPort) return "in-memory";
  const envRecord = ctx.env as unknown as Record<string, unknown>;
  return envRecord.FLAGS ? "flagship" : "environment";
}

/**
 * Issue #4260 — the platform-admin probe behind the
 * schedules/flags toggle. The same PDP platform-scope decision
 * AdminTenantQueues uses (live platform-admin binding at platform
 * scope, unrevoked, unexpired; permission role:assign). Fail-closed
 * throughout: any unresolvable identity, unwired session, denied
 * decision or store failure resolves to "not an admin" — the GET
 * read stays open (canToggle false) and the POST refuses 403, never
 * 500s on an authorization lookup.
 */
type ScheduleFlagsCaller =
  | { kind: "admin"; login: string; internalUserId: string }
  | { kind: "unauthenticated" }
  | { kind: "forbidden"; reason: string };

async function resolveScheduleFlagsCaller(
  request: Request,
  ctx: SchedulesRouteContext,
): Promise<ScheduleFlagsCaller> {
  const login = request.headers.get("x-user-login") || "";
  if (!isLoginShaped(login)) {
    return { kind: "unauthenticated" };
  }
  try {
    const kv = ctx.flagAliasKv ?? sessionStore(ctx.env);
    const internalUserId = await lookupInternalUserIdByLogin(kv, login);
    if (!internalUserId) {
      return {
        kind: "forbidden",
        reason: "Forbidden: flag administration requires a wired session.",
      };
    }
    const store =
      ctx.flagMembershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
    const decision = await checkPlatformPermission(store, {
      internalUserId,
      permission: "role:assign",
      nowMs: Date.now(),
    });
    if (decision.decision !== "allow") {
      return {
        kind: "forbidden",
        reason: "Forbidden: flag administration requires platform-admin membership.",
      };
    }
    return { kind: "admin", login, internalUserId };
  } catch {
    return {
      kind: "forbidden",
      reason: "Forbidden: flag administration could not be verified.",
    };
  }
}

/**
 * Issue #6503 step 8 (G1) — the single seam for schedule-control
 * authorization (the level rule, Mars 2026-11-25). Every control
 * route in this file authorizes through it; no route invents a
 * second gate.
 *
 * Identity comes from the verified session only, via
 * resolveTrustedScheduleIdentity (the Worker-established
 * x-user-login header wins; the per-instance screener execution
 * context is the fallback) — never from a client-supplied
 * tenantId/userId. Roles come from the membership store, on the
 * platform primitives: the flags-probe shape (login → internal id
 * via the alias KV, then checkPlatformPermission with
 * role:assign, the platform-privilege grant) plus the
 * isTenantAdminForTenant composition for the tenant-admin leg.
 * No new permission is invented and no ExecutionContext PDP
 * resolution runs here: resolveExecutionContext requires a
 * `permission: Permission` and no schedule permission exists yet
 * (the mapping gap is CISO's, recorded for them). When the mapping
 * lands, the swap is this one function.
 *
 * Levels, from the stored record alone (records carry no tenant
 * field — #3122 F4 — so none is invented): platform-level is the
 * six system rows, any `kind: "internal"` row, a `worker-duty`
 * row, and the ticker-push live feed (system-owned, no owner);
 * every other known kind (screen, goal, workflow-stage, followup)
 * is user-level, owned by `ownerLogin`. An unknown kind has no
 * level and refuses fail-closed. A user-level row with no
 * ownerLogin is still user-level — it simply has no owning user,
 * so only a platform-admin or a tenant-admin of the instance
 * tenant may control it. The instance tenant
 * (resolveIaaaTenant) is the user's tenant in this single-tenant
 * deployment: a tenant-admin's leg is checked against it.
 *
 * Fail-closed throughout: no identity → unauthenticated (the
 * route answers 401); a membership-store failure grants no admin
 * role (the caller keeps plain-user standing — ownership compares
 * logins, never memberships — and the route answers 403, never a
 * bare 500, on a level the caller does not hold).
 */
export type ScheduleControlLevel = "platform" | "user";

export type ScheduleControlCaller =
  | { kind: "platform-admin"; login: string; internalUserId: string }
  | { kind: "tenant-admin"; login: string; internalUserId: string; tenantId: string }
  | { kind: "user"; login: string; internalUserId: string | null }
  | { kind: "unauthenticated" };

/** A resolved caller that passed the gate: identity is present, so `login` exists. */
export type AuthenticatedScheduleControlCaller = Exclude<
  ScheduleControlCaller,
  { kind: "unauthenticated" }
>;

export async function resolveScheduleControlCaller(
  request: Request,
  // Issue #6503 step 8b — the seam takes only the fields it reads
  // (identity + membership inputs), so other routes (maintenance
  // clear-table) can authorize through it without building a full
  // SchedulesRouteContext. A SchedulesRouteContext satisfies this
  // Pick structurally; nothing about the resolution changes.
  ctx: Pick<
    SchedulesRouteContext,
    "env" | "getScreenerExecutionContext" | "flagAliasKv" | "flagMembershipStore"
  >,
): Promise<ScheduleControlCaller> {
  let context: ScreenerExecutionContext | undefined;
  try {
    context = (await ctx.getScreenerExecutionContext()) ?? undefined;
  } catch {
    context = undefined;
  }
  const trusted = resolveTrustedScheduleIdentity({
    headerLogin: request.headers.get("x-user-login") || "",
    headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
    context,
    configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
  });
  if (!trusted.userLogin) {
    return { kind: "unauthenticated" };
  }
  const login = trusted.userLogin;
  try {
    const kv = ctx.flagAliasKv ?? sessionStore(ctx.env);
    const internalUserId = await lookupInternalUserIdByLogin(kv, login);
    if (!internalUserId) {
      return { kind: "user", login, internalUserId: null };
    }
    const store =
      ctx.flagMembershipStore ?? createKvMembershipStore(sessionStore(ctx.env));
    const decision = await checkPlatformPermission(store, {
      internalUserId,
      permission: "role:assign",
      nowMs: Date.now(),
    });
    if (decision.decision === "allow") {
      return { kind: "platform-admin", login, internalUserId };
    }
    const memberships = await store.getMembershipsByUser(internalUserId);
    const tenantId = resolveIaaaTenant(ctx.env);
    if (isTenantAdminForTenant(memberships, tenantId, Date.now())) {
      return { kind: "tenant-admin", login, internalUserId, tenantId };
    }
    return { kind: "user", login, internalUserId };
  } catch {
    return { kind: "user", login, internalUserId: null };
  }
}

/** The control level of a stored schedule record, or null when its kind names no level. */
export function resolveScheduleControlLevel(
  record: UnifiedScheduleRecord,
): ScheduleControlLevel | null {
  if (
    SYSTEM_SCHEDULE_RECORD_IDS.has(record.id) ||
    record.kind === "internal" ||
    record.kind === "worker-duty" ||
    record.kind === "ticker-push" ||
    record.id === TICKER_PUSH_RECORD_ID
  ) {
    return "platform";
  }
  if (
    record.kind === "screen" ||
    record.kind === "goal" ||
    record.kind === "workflow-stage" ||
    record.kind === "followup"
  ) {
    return "user";
  }
  return null;
}

export type ScheduleControlAuthorization =
  | { allowed: true }
  | { allowed: false; status: 403; reason: string };

/**
 * The level rule for one stored record: platform-level →
 * platform-admin only; user-level → platform-admin, tenant-admin
 * of the user's tenant, or the owning user. A record whose level
 * cannot be determined refuses fail-closed (403 naming the
 * unknown kind), never allows.
 */
export function authorizeScheduleControl(
  caller: ScheduleControlCaller,
  record: UnifiedScheduleRecord,
): ScheduleControlAuthorization {
  const level = resolveScheduleControlLevel(record);
  if (level === null) {
    return {
      allowed: false,
      status: 403,
      reason: `Forbidden: schedule '${record.id}' has an unknown kind '${record.kind}', so its control level cannot be determined.`,
    };
  }
  if (level === "platform") {
    if (caller.kind === "platform-admin") return { allowed: true };
    return {
      allowed: false,
      status: 403,
      reason: "Forbidden: platform-level schedules are controllable by platform-admin only.",
    };
  }
  if (caller.kind === "platform-admin" || caller.kind === "tenant-admin") {
    return { allowed: true };
  }
  if (caller.kind === "user" && record.ownerLogin && caller.login === record.ownerLogin) {
    return { allowed: true };
  }
  if (caller.kind === "user" && !record.ownerLogin) {
    return {
      allowed: false,
      status: 403,
      reason: "Forbidden: this user-level schedule names no owning user, so only a platform-admin or a tenant-admin of the instance tenant may control it.",
    };
  }
  return {
    allowed: false,
    status: 403,
    reason: "Forbidden: user-level schedules are controllable by a platform-admin, a tenant-admin of the user's tenant, or the owning user.",
  };
}

/**
 * Authorize a control op addressed by id, with the stored record
 * when one exists. The six system ids are platform-level by id
 * even when no row is stored yet, so a non-admin is refused
 * before the route's own not-found; a non-system id with no
 * stored row returns null and the route answers with its own
 * not-found/refusal — nothing is mutated either way.
 */
export function authorizeScheduleControlForId(
  caller: ScheduleControlCaller,
  id: string,
  record: UnifiedScheduleRecord | undefined,
): ScheduleControlAuthorization | null {
  if (id === TICKER_PUSH_RECORD_ID) {
    if (caller.kind === "platform-admin") return { allowed: true };
    return {
      allowed: false,
      status: 403,
      reason: "Forbidden: the ticker-push live feed is platform-level and controllable by platform-admin only.",
    };
  }
  if (!record) {
    if (SYSTEM_SCHEDULE_RECORD_IDS.has(id)) {
      if (caller.kind === "platform-admin") return { allowed: true };
      return {
        allowed: false,
        status: 403,
        reason: "Forbidden: platform-level schedules are controllable by platform-admin only.",
      };
    }
    return null;
  }
  return authorizeScheduleControl(caller, record);
}

/** The audit deps the step-9 (G2) helpers read: the env for the wired store, the test seam, and the funnel. */
export interface ScheduleControlAuditDeps {
  env: Env;
  auditStore?: AuditStore | null;
  audit: (type: string, agent: "orchestrator", payload: Record<string, unknown>) => void;
}

/** The caller level as the audit attribution names it. */
export function scheduleControlCallerLevel(caller: ScheduleControlCaller): string {
  return caller.kind;
}

/**
 * Issue #6503 step 9 (G2) — audit-before-write for schedule control
 * ops, the #5867 shape: ONE IAAA chain record BEFORE the store
 * write, over the wired store (`createWiredAuditStore`) or the
 * `auditStore` test seam. The record names the action (the existing
 * `schedule.*` vocabulary, reused — no parallel names), the schedule
 * id(s) as resourceId, and the resolved caller login as actor;
 * outcome is "pending" (the write has not run yet) and the funnel
 * annotation after the write carries the outcome, exactly as #5867
 * keeps the funnel after the write. Schedule control ops are
 * consequential, so a failed audit write BLOCKS: returns the coded
 * 503 refusal (FAILURE_COMMERCIAL_AUDIT_REQUIRED, already in the
 * outcome catalog at 503) and the caller must not write. Returns
 * null when the record landed and the write may proceed.
 *
 * Residual (#5867, documented not solved): if the store write fails
 * after this record lands, an audit record exists for a change that
 * never landed — the chain has no rollback for this. A validation
 * refusal (400) or a gate refusal (401/403) never reaches this
 * helper, so those consume no chain record.
 */
export async function auditScheduleControlBeforeWrite(
  deps: Pick<ScheduleControlAuditDeps, "env" | "auditStore">,
  caller: ScheduleControlCaller,
  action: string,
  resourceId?: string,
): Promise<Response | null> {
  if (caller.kind === "unauthenticated") {
    // No identity to attribute: every gate answers 401 before a
    // control op reaches this helper, so a caller arriving here
    // without one is a route bug — refused, never audited under
    // "anonymous" (refusals are audited separately, below).
    return Response.json(
      { error: "Unauthorized: a signed-in session is required to control schedules." },
      { status: 401 },
    );
  }
  let recorded: Awaited<ReturnType<typeof recordAuditEvent>>;
  try {
    const store = deps.auditStore ?? createWiredAuditStore(deps.env);
    recorded = await recordAuditEvent(store, {
      timestamp: Date.now(),
      type: "schedule-admin",
      actorPrincipalId: caller.login,
      actorType: "human",
      initiatingPrincipalId: caller.login,
      tenantId: resolveIaaaTenant(deps.env),
      correlationId: crypto.randomUUID(),
      action,
      // The IAAA resourceId caps at 512 chars; a bulk id list is
      // truncated here and carried in full on the funnel event.
      ...(resourceId ? { resourceId: resourceId.slice(0, 512) } : {}),
      decision: "allow",
      policyVersion: IAAA_AUDIT_POLICY_VERSION,
      outcome: "pending",
    });
  } catch {
    recorded = {
      ok: false,
      code: "AUDIT_WRITE_FAILED",
      error: "audit event could not be recorded; the action must not be reported as audited",
    };
  }
  if (shouldBlockAction("consequential", !recorded.ok)) {
    return Response.json(
      {
        error: "Schedule control refused: the audit record could not be written, so the change was not applied.",
        code: "FAILURE_COMMERCIAL_AUDIT_REQUIRED",
        action,
        ...(resourceId ? { scheduleId: resourceId } : {}),
      },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Issue #6503 step 9 (G2) — refusal auditing for the step-8/8b
 * gates: every 401/403 writes a refusal audit event naming the
 * attempted action, the schedule id (or scope/table), the reason,
 * and the caller login (or "anonymous"). Best-effort ONLY, both
 * emissions: the chain record (decision "deny", outcome "failed",
 * the reason as errorCode) and the `schedule.control-refused`
 * funnel annotation. Either failing must not change the 401/403
 * response and must never let the refused op proceed — the gate
 * has already refused it before this runs.
 */
export async function auditScheduleControlRefusal(
  deps: ScheduleControlAuditDeps,
  action: string,
  resourceId: string | undefined,
  reason: string,
  caller: ScheduleControlCaller,
  extraFunnel?: Record<string, unknown>,
): Promise<void> {
  const login = caller.kind === "unauthenticated" ? "anonymous" : caller.login;
  try {
    const store = deps.auditStore ?? createWiredAuditStore(deps.env);
    await recordAuditEvent(store, {
      timestamp: Date.now(),
      type: "schedule-admin",
      actorPrincipalId: login,
      actorType: "human",
      initiatingPrincipalId: login,
      tenantId: resolveIaaaTenant(deps.env),
      correlationId: crypto.randomUUID(),
      action,
      ...(resourceId ? { resourceId: resourceId.slice(0, 512) } : {}),
      decision: "deny",
      policyVersion: IAAA_AUDIT_POLICY_VERSION,
      outcome: "failed",
      errorCode: reason.slice(0, 512),
    });
  } catch {
    // Best-effort: a refusal audit failing never changes the refusal.
  }
  try {
    deps.audit("schedule.control-refused", "orchestrator", {
      action,
      ...(resourceId ? { scheduleId: resourceId } : {}),
      ...(extraFunnel ?? {}),
      reason,
      callerLogin: login,
      callerLevel: caller.kind === "unauthenticated" ? "anonymous" : caller.kind,
    });
  } catch {
    // Best-effort funnel annotation; see above.
  }
}

export async function handleSchedulesRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: SchedulesRouteContext
): Promise<Response | null> {
    // Issue #3121 Phase 2 (#3123): the one schedule store — the
    // unified D1 `unified_schedules` table (#6503, D1 only) — and
    // the one management path behind every route in this file.
    // Subpath ids come from the /schedules/<id>/<action> shape via
    // regex (not a counted route condition). The store is built
    // once per request (one adapter, one lazy schema-ensure); the
    // factory throws fail-closed when AGENT_DB is unbound, so the
    // control plane refuses rather than silently reading a DO
    // table that is no longer a live store.
    let cachedStore: ScheduleStore | undefined;
    const unifiedStore = () =>
      (cachedStore ??= createD1UnifiedSchedulePorts({
        d1: ctx.env.AGENT_DB,
      }).unifiedSchedules);
    const alarms: ScheduleAlarms = makeScheduleAlarmsPort(ctx, {
      // Issue #6482 — the port resolves the effective floor per arm
      // (managed setting > env carrier > default), so a floor set in
      // the schedules home governs unified-management arms without a
      // redeploy.
      resolveFloor: () => resolveEffectiveScheduleFloor(ctx.agentCtx.storage.sql, ctx.env).seconds,
    });
    // Issue #4352 — the ticker push is schedulable like any other job. Its
    // record lives in the TickerAgent's own DO (ADR 0029 D-0), so pause /
    // resume / cadence go through that host's typed RPC, not the local store.
    const tickerPushStub = () =>
      actorGateway.stub<TickerPushRecordStub>(ctx.env.TICKER_AGENT, TICKER_INSTANCE_NAME);
    const subpathId = (p: string): string => {
      const m = p.match(/\/schedules\/([^/]+)\//);
      if (!m) return "";
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    };

    // Issue #6503 step 8 (G1) — the one gate every control route
    // below answers through: no identity → 401; a level the caller
    // does not hold → 403 naming the level. A missing stored row
    // abstains (null) unless the id itself is a system id, so the
    // route keeps its own not-found/refusal and nothing is mutated.
    // The store read is best-effort here: a store failure leaves
    // the record unknown and the route answers with its own error,
    // exactly as before the gate.
    //
    // Issue #6503 step 9 (G2) — the gate also carries the audit
    // attribution: on allow it returns the resolved caller and the
    // stored record it loaded (the before-state for the audit), so
    // the branch never re-resolves the caller; on refuse it audits
    // the refusal (best-effort, never changing the 401/403) and
    // returns the refusal Response. `action` is the schedule.*
    // audit name for the op (e.g. "schedule.paused").
    const authorizeControlOrRespond = async (
      scheduleId: string,
      action: string,
    ): Promise<{ caller: AuthenticatedScheduleControlCaller; record: UnifiedScheduleRecord | undefined } | Response> => {
      const caller = await resolveScheduleControlCaller(request, ctx);
      if (caller.kind === "unauthenticated") {
        const reason = "Unauthorized: a signed-in session is required to control schedules.";
        await auditScheduleControlRefusal(ctx, action, scheduleId, reason, caller);
        return Response.json({ error: reason }, { status: 401 });
      }
      let record: UnifiedScheduleRecord | undefined;
      try {
        record = await unifiedStore().get(scheduleId);
      } catch {
        record = undefined;
      }
      const decision = authorizeScheduleControlForId(caller, scheduleId, record);
      if (decision && !decision.allowed) {
        await auditScheduleControlRefusal(ctx, action, scheduleId, decision.reason, caller);
        return Response.json({ error: decision.reason }, { status: decision.status });
      }
      return { caller, record };
    };

    // Issue #5878 — the one schedule list, shared by the GET list
    // route and the bulk pause/resume/trigger routes: the unified
    // items (the store only — a stored row renders, no stored row
    // means the id does not appear) plus the ticker-push row, under
    // the same ?type= filter. A bulk scope filters THESE rows (by
    // kind), so the bulk verb and the home the user sees can never
    // disagree about which rows a scope names.
    const readScheduleListItems = async (typeParam?: string | null) => {
      const items = await listUnifiedScheduleItems(
        { store: unifiedStore(), alarms },
        typeParam ?? undefined,
      );
      // Issue #3121 #4237 — the ticker-push row is not in this
      // store (it lives in the TickerAgent); append it when the
      // feed answers, under the same ?type= filter as the rest.
      const tickerItem = await readTickerPushListItem(ctx.env);
      if (tickerItem && (!typeParam || tickerItem.type === typeParam)) {
        items.push(tickerItem);
      }
      // Issue #6503 — the last-run joins for the six stored system
      // rows (#4239–#4242): a stored row renders from the store
      // above; each join decorates that row in place with its last
      // run from the ledger. No stored row means no join and no
      // row — nothing is synthesized. The join readers return the
      // stored row without a last run when the ledger cannot be
      // read, so a ledger failure never drops a stored row.
      const systemReaders = [
        [TOKEN_RENEWAL_RECORD_ID, readTokenRenewalListItem],
        [RETENTION_RECORD_ID, readRetentionListItem],
        [NIGHTLY_RESEARCH_RECORD_ID, readNightlyResearchListItem],
        [STALE_LEDGER_SWEEP_RECORD_ID, readStaleLedgerSweepListItem],
        [STALE_ASYNC_JOB_SWEEP_RECORD_ID, readStaleAsyncJobSweepListItem],
        [SCHEDULE_WATCHDOG_RECORD_ID, readScheduleWatchdogListItem],
      ] as const;
      for (const [id, reader] of systemReaders) {
        const at = items.findIndex((item) => item.id === id);
        if (at === -1) continue;
        const record = await unifiedStore().get(id);
        const joined = await reader(createJobRunRecordAdapter(ctx.env), record);
        if (joined) items[at] = joined;
      }
      // Issue #5890 — one row per job: a stored system record and
      // its live alarm are the same job, so the rows collapse
      // through the same reader as the service list above — the home
      // and the bulk scopes built on this list can never disagree.
      return collapseScheduleListItems(items);
    };

    // Issue #5878 — the manual-run runner, shared by the single-row
    // trigger route and the bulk trigger route. Callbacks whose method
    // wrapper records its own runs (the creatable four, plus the
    // internal callbacks #3788/#3310/#4186 wrapped) record outcome-aware
    // runs themselves, so the route must not double-record them;
    // other callbacks have no wrapper, so the route records the
    // invocation itself (invocation-level success, since the
    // callback reports no outcome). Paused schedules refused
    // inside the service with 409 record nothing — no run happened.
    // The schedule id is the caller's explicit id when one is given
    // (the single-row route), else the id the payload carries
    // (triggerUnifiedSchedule stamps `scheduleId` on manual
    // triggers), so the ledger linkage is the same either way.
    const runScheduleCallbackNow = async (
      callback: string,
      payload: unknown,
      explicitScheduleId?: string,
    ) => {
      const scheduleId =
        explicitScheduleId ??
        (payload && typeof payload === "object" &&
        typeof (payload as Record<string, unknown>).scheduleId === "string"
          ? ((payload as Record<string, unknown>).scheduleId as string)
          : undefined);
      if ((RECORDED_SCHEDULE_CALLBACKS as readonly string[]).includes(callback)) {
        await ctx.runScheduleCallback(callback, payload);
      } else {
        await recordScheduleCallbackRun(
          ctx.agentCtx.storage.sql,
          callback,
          payload,
          { id: scheduleId },
          () => ctx.runScheduleCallback(callback, payload),
          {
            // Issue #5085 (S6): a failed ledger write is named
            // (audit + coded OBS-1020) through the shared
            // namer instead of vanishing silently.
            onRecordFailure: nameLedgerWriteFailure(
              (type, agent, payload) => ctx.audit(type, agent, payload),
              "schedule.ledger_write_failed",
            ),
            // Issue #6482 — the Worker env for the kill-switch +
            // firing-rate resolution at the one choke point.
            env: ctx.env,
          },
        );
      }
    };

    // Issue #5878 — the bulk executor for the one row the management
    // service does not own: the live-feed row. Its pause / resume /
    // trigger go through the TickerAgent's typed RPC, exactly as the
    // single-row route does them. Any other row returns undefined
    // and falls through to the standard per-row verb.
    //
    // Issue #6503 step 14b — unreachable from the bulk routes:
    // handleBulkScheduleVerb drops the feed row before the bulk
    // service runs, so the bulk verb never dispatches the feed;
    // the single-row routes are the feed's control plane. The
    // branch stays as the executor seam's row-level handler, never
    // as a bulk path — do not re-admit the row to the bulk rows.
    const executeBulkRow: BulkScheduleRowExecutor = async (row, verb) => {
      if (row.id !== TICKER_PUSH_RECORD_ID) return undefined;
      const stub = tickerPushStub();
      if (verb === "pause") {
        const feed = await stub.getTickerPushRecord();
        if (feed?.state === "paused") return { ok: true, already: true };
        await stub.pauseTickerPush();
        return { ok: true };
      }
      if (verb === "resume") {
        const feed = await stub.getTickerPushRecord();
        if (feed?.state !== "paused") return { ok: true, already: true };
        await stub.resumeTickerPush();
        return { ok: true };
      }
      const feed = await stub.getTickerPushRecord();
      if (feed?.state === "paused") {
        return { ok: false, error: "The live feed is paused — resume it before triggering." };
      }
      await stub.triggerTickerPush();
      return { ok: true };
    };

    // Issue #5878 — one bulk verb over a scope, shared by the three
    // bulk routes below. Body: `{ scope: "all" | kind }`. The scope
    // is validated (400 otherwise); the rows are the one schedule
    // list; the verb runs through the bulk service; each acted row
    // gets its single-row audit event, and the call gets one bulk
    // audit event naming the scope and the counts.
    const handleBulkScheduleVerb = async (verb: BulkScheduleVerb) => {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        if (!isBulkScheduleScope(body?.scope)) {
          return Response.json(
            { error: "scope must be 'all' or one of the schedule kinds (stocks, options, strategy, goal, payment, trading, system, queued, other)" },
            { status: 400 },
          );
        }
        const scope = body.scope as BulkScheduleScope;
        // Issue #6503 step 8 (G1) — level-rule gate for bulk verbs:
        // the 'all' and 'system' scopes touch platform-level rows,
        // so they are platform-admin only; any other scope names
        // user-level rows only, so a platform-admin or a
        // tenant-admin of the instance tenant may run it. A plain
        // user never bulk-controls rows they may not own.
        const bulkAction =
          verb === "pause" ? "schedule.bulk-paused" : verb === "resume" ? "schedule.bulk-resumed" : "schedule.bulk-triggered";
        const bulkCaller = await resolveScheduleControlCaller(request, ctx);
        if (bulkCaller.kind === "unauthenticated") {
          const reason = "Unauthorized: a signed-in session is required to control schedules.";
          await auditScheduleControlRefusal(ctx, bulkAction, undefined, reason, bulkCaller, { scope });
          return Response.json({ error: reason }, { status: 401 });
        }
        const bulkTouchesPlatform = scope === "all" || scope === "system";
        if (bulkTouchesPlatform && bulkCaller.kind !== "platform-admin") {
          const reason = `Forbidden: bulk ${verb} over the '${scope}' scope touches platform-level schedules, which are controllable by platform-admin only.`;
          await auditScheduleControlRefusal(ctx, bulkAction, undefined, reason, bulkCaller, { scope });
          return Response.json({ error: reason }, { status: 403 });
        }
        if (
          !bulkTouchesPlatform &&
          bulkCaller.kind !== "platform-admin" &&
          bulkCaller.kind !== "tenant-admin"
        ) {
          const reason = `Forbidden: bulk ${verb} over user-level schedules requires a platform-admin or a tenant-admin of the instance tenant.`;
          await auditScheduleControlRefusal(ctx, bulkAction, undefined, reason, bulkCaller, { scope });
          return Response.json({ error: reason }, { status: 403 });
        }
        // Issue #6503 step 14b — the ticker-push feed is not a
        // schedule, so it is in NO bulk scope: the home the user
        // sees renders it as a feed card outside the table, and
        // the bulk verb must name the same rows the home shows.
        // The filter is by the feed's stable id (it classifies as
        // kind "system", so a kind filter alone would still match
        // it) and it runs here, at the bulk verb's entry —
        // readScheduleListItems itself is shared with the GET list
        // route, which still appends the row for the feed card.
        // The audit ids below and the summary counts therefore
        // name schedules only.
        const rows = (await readScheduleListItems()).filter(
          (row) => row.id !== TICKER_PUSH_RECORD_ID,
        );
        const callbackById = new Map(rows.map((r) => [r.id, r.callback]));
        const deps = { store: unifiedStore(), alarms, reconcileDeclared: ctx.reconcileScheduledTasks };
        const nowIso = new Date().toISOString();
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record for the bulk op (naming the scope and the ids in
        // it) before the bulk service writes anything; a failed
        // audit refuses with the coded 503 and runs nothing.
        const bulkAuditRefusal = await auditScheduleControlBeforeWrite(
          ctx,
          bulkCaller,
          bulkAction,
          rows.map((r) => r.id).join(","),
        );
        if (bulkAuditRefusal) return bulkAuditRefusal;
        let summary: BulkScheduleSummary;
        if (verb === "pause") {
          summary = await pauseSchedulesInScope(deps, scope, rows, nowIso, executeBulkRow);
        } else if (verb === "resume") {
          summary = await resumeSchedulesInScope(deps, scope, rows, nowIso, executeBulkRow);
        } else {
          summary = await triggerSchedulesInScope(deps, scope, rows, runScheduleCallbackNow, executeBulkRow);
        }
        const auditEvent =
          verb === "pause" ? "schedule.paused" : verb === "resume" ? "schedule.resumed" : "schedule.triggered";
        for (const result of summary.results) {
          if (result.outcome !== "paused" && result.outcome !== "resumed" && result.outcome !== "triggered") {
            continue;
          }
          ctx.audit(auditEvent, "orchestrator", {
            scheduleId: result.id,
            callback: callbackById.get(result.id),
            // Issue #6503 step 9 (G2) — caller attribution on every
            // event. These per-row annotations stay after the write:
            // they name acted rows, knowable only from the outcome.
            changedBy: bulkCaller.login,
            callerLevel: bulkCaller.kind,
          });
        }
        ctx.audit(bulkAction, "orchestrator", {
          scope,
          scheduleIds: rows.map((r) => r.id),
          total: summary.total,
          applied: summary.applied,
          already: summary.already,
          refused: summary.refused,
          changedBy: bulkCaller.login,
          callerLevel: bulkCaller.kind,
        });
        return Response.json({
          success: true,
          verb: summary.verb,
          scope: summary.scope,
          total: summary.total,
          applied: summary.applied,
          already: summary.already,
          refused: summary.refused,
          results: summary.results,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run bulk schedule action" }, { status: 500 });
      }
    };

    // Issue #3311 — webhook-triggered scheduling: a workflow step
    // calls POST /schedules/webhook/followup (via the HMAC edge in
    // src/server/routes/scheduleWebhook.ts) and the scheduler mints a
    // scheduled follow-up job/sub-job on the async-job chain. The
    // branch sits FIRST: no other branch may swallow this path.
    //
    // Order: edge-marker gate (a call that did not pass the edge is
    // refused — the DO never mints on an unauthenticated forward) →
    // trusted identity (the header the edge stamped from the verified
    // body, never a caller header) → zod re-validation (the edge
    // already validated; the DO never trusts the forwarder blindly) →
    // PDP via #3122's evaluateAgentSchedulePdp (task:create; proceeds
    // when PDP is disabled, exactly as #3122 does) → capability
    // allow-list + submission build (the service module throws a
    // business error) → the one submitAsyncJob minter → the mint
    // ledger row (best-effort: a failed write is audited, never
    // breaks the mint) → both audits (call + mint).
    //
    // The follow-up fires under the chain's own guards (not-before,
    // claim, retry-once, recovery bounds) — no new firing path, no
    // T4 semantics change. Approval gate: none here — the caller is
    // a workflow executing the owner's already-authorized pipeline,
    // not an agent proposing a new consequential action (recorded in
    // #3311 for owner amendment at review).
    if (path.endsWith("/schedules/webhook/followup") && request.method === "POST") {
      try {
        if (request.headers.get("x-schedule-webhook") !== "1") {
          return Response.json(
            { error: "Schedule webhook calls must arrive through the authenticated webhook edge." },
            { status: 401 },
          );
        }
        const context = await ctx.getScreenerExecutionContext();
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: request.headers.get("x-user-login") || "",
          headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        if (!trusted.userLogin) {
          return Response.json({ error: "An authenticated user identity is required for a schedule webhook follow-up." }, { status: 401 });
        }
        const userLogin = trusted.userLogin;
        const rawBody = (await request.json().catch(() => null)) as unknown;
        const shaped = scheduleWebhookFollowupBodySchema.safeParse(rawBody);
        if (!shaped.success) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.denied, "orchestrator", {
            userLogin,
            workflowId: (rawBody as Record<string, unknown> | null)?.workflowId ?? null,
            reason: "webhook body failed validation",
          });
          return Response.json({ error: "Webhook body is invalid." }, { status: 400 });
        }
        const validBody = shaped.data;
        ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.received, "orchestrator", {
          userLogin,
          workflowId: validBody.workflowId,
          scheduleId: validBody.scheduleId ?? null,
          capability: validBody.capability,
          runAt: validBody.runAt,
        });
        const pdp = await evaluateAgentSchedulePdp(createAgentSchedulePdpDeps(ctx.env), {
          principal: { login: userLogin, agentId: "schedule-webhook" },
          tenantId: resolveIaaaTenant(ctx.env),
          action: "create",
          nowMs: Date.now(),
        });
        if (pdp.enforced && !pdp.allowed) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.denied, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            scheduleId: validBody.scheduleId ?? null,
            capability: validBody.capability,
            reason: pdp.reason ?? "PDP denied",
          });
          return Response.json({ error: "This webhook caller is not authorized to mint a schedule follow-up." }, { status: 403 });
        }
        // #4223 — durable idempotency claim BEFORE the mint, so a
        // re-delivered webhook is a 409 instead of a second mint.
        // The key is derived from the whole parsed body (same
        // delivery, same key — key order in the serialization does
        // not matter); the claim lives in orm.webhookReplay (DO
        // SQLite) and survives isolate restarts and redeploys, past
        // the edge nonce's 24h. The claim is placed after PDP (a
        // denied caller must not consume a key) and before the mint
        // (a failed mint leaves the key claimed, so the retry is a
        // 409, not a second mint). If the ORM is unavailable, the
        // isolate-scoped memory store is the fallback guard — minting
        // unguarded is never the fallback.
        const idempotencyKey = await deriveScheduleWebhookIdempotencyKey(validBody);
        const idempotencyTtlMs = resolveScheduleWebhookIdempotencyTtlMs(
          ctx.env.SCHEDULE_WEBHOOK_IDEMPOTENCY_TTL_MS,
        );
        let replayStore: ReplayStore;
        try {
          replayStore = new OrmReplayStore(ctx.getOrm());
        } catch {
          replayStore = sharedMemoryReplayStore();
        }
        let isDuplicate: boolean;
        try {
          isDuplicate = await replayStore.claim(idempotencyKey, "schedule-webhook", idempotencyTtlMs);
        } catch (err) {
          // The durable claim failed (store unreachable): fall back
          // to the isolate-scoped guard and say so in the log.
          structuredLog.warn("schedules.webhook_idempotency_claim_failed", {
            message: "[Schedules] schedule webhook durable idempotency claim failed; using memory fallback:",
            error: err instanceof Error ? err.message : String(err),
          });
          replayStore = sharedMemoryReplayStore();
          isDuplicate = await replayStore.claim(idempotencyKey, "schedule-webhook", idempotencyTtlMs);
        }
        if (isDuplicate) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.duplicate, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            scheduleId: validBody.scheduleId ?? null,
            capability: validBody.capability,
          });
          return Response.json({ error: "Duplicate schedule webhook delivery." }, { status: 409 });
        }
        let submission: import("../../types").AsyncJobSubmission;
        try {
          submission = buildScheduleWebhookFollowupSubmission(validBody);
        } catch (err) {
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.denied, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            scheduleId: validBody.scheduleId ?? null,
            capability: validBody.capability,
            reason: err instanceof Error ? err.message : String(err),
          });
          return Response.json({ error: err instanceof Error ? err.message : "Follow-up could not be built." }, { status: 400 });
        }
        if (!ctx.submitAsyncJob) {
          return Response.json({ error: "Follow-up submission is not wired on this host." }, { status: 500 });
        }
        const submitted = await ctx.submitAsyncJob(submission);
        // #4223 — retention hygiene, best-effort: spent idempotency
        // keys are pruned on mint so the table does not grow forever.
        // A prune failure never breaks the mint.
        try {
          await replayStore.pruneExpired();
        } catch {
          // Best-effort only.
        }
        const nowIso = new Date().toISOString();
        try {
          // Issue #6101 — the mint row lands in D1; an unbound
          // ledger is the named error, audited below like any
          // other write failure. Recording never breaks the mint.
          const ledgerStore = createJobRunRecordAdapter(ctx.env);
          if (!ledgerStore) {
            throw new Error(
              "[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).",
            );
          }
          await recordLedgerRunD1(
            ledgerStore,
            {
              system: "orchestrator-schedule",
              ...buildScheduleWebhookMintRecord({ jobId: submitted.jobId, body: validBody, nowIso }),
            },
            resolveLedgerAttribution(ctx.env, { userId: userLogin }),
          );
        } catch (err) {
          // Recording never breaks the mint — but a swallowed store
          // failure is unobservable, so it is audited instead.
          ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.mintLedgerFailed, "orchestrator", {
            userLogin,
            workflowId: validBody.workflowId,
            jobId: submitted.jobId,
            error: err instanceof Error ? err.message : String(err),
          });
          structuredLog.warn("schedules.webhook_mint_ledger_failed", {
            message: "[Schedules] schedule webhook mint ledger write failed:",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        ctx.audit(SCHEDULE_WEBHOOK_AUDIT_EVENTS.minted, "orchestrator", {
          userLogin,
          workflowId: validBody.workflowId,
          scheduleId: validBody.scheduleId ?? null,
          capability: validBody.capability,
          runAt: validBody.runAt,
          jobId: submitted.jobId,
        });
        return Response.json({
          ...submitted,
          capability: validBody.capability,
          runAt: validBody.runAt,
          workflowId: validBody.workflowId,
          scheduleId: validBody.scheduleId ?? null,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to mint schedule webhook follow-up" }, { status: 500 });
      }
    }
    // Issue #3121 #3310 — the stages adapter over the one
    // management service: the registry read goes through the
    // ScheduledAgent door (a job with no definition reads null —
    // the adapter names the refusal); the trigger firing dispatches
    // through the class's runScheduleCallback, whose runWorkflowStage
    // method records its own run, so no second recording here.
    const workflowStageAdapter = (): AgentWorkflowStageScheduleAdapter => {
      const registry: WorkflowStageRegistry = {
        getDefinition: async (jobId) => {
          try {
            const door = getScheduledAgentDoor(ctx.env);
            const view = await door.getPipelineJobStatus(jobId);
            return view.definition ?? null;
          } catch {
            return null;
          }
        },
      };
      return createWorkflowStageScheduleAdapter({
        store: unifiedStore(),
        alarms,
        registry,
        runCallback: (callback, payload) => ctx.runScheduleCallback(callback, payload),
        nowIso: () => new Date().toISOString(),
        // Issue #6503 — the start-paused control, resolved here so a
        // stage created through this adapter (direct or approved)
        // starts active when the control is off.
        startPaused: resolveEffectiveScheduleStartPaused(ctx.agentCtx.storage.sql, ctx.env).paused,
      });
    };

    // List all schedules (supports ?type=cron|interval|delayed|scheduled)
    if ((path.endsWith("/schedules") || path.endsWith("/api/schedules") || path === "/schedules" || path === "/api/schedules") && request.method === "GET") {
      try {
        // Issue #108: the typed listSchedules() is called directly. The
        // old fallback chain (listSchedules → scheduler.list → deprecated
        // getSchedules → 200 with an empty list) is deleted: it masked a
        // broken scheduling binding as "you have no schedules" (audit
        // finding F14). A failure now surfaces as the 500 below.
        const typeParam = url.searchParams.get("type");
        // Issue #5878 — the one schedule list (unified items +
        // ticker-push row); see readScheduleListItems.
        const items = await readScheduleListItems(typeParam ?? undefined);
        return Response.json({
          count: items.length,
          schedules: items,
          creatableCallbacks: [...ctx.creatableScheduleCallbacks],
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list schedules", schedules: [] }, { status: 500 });
      }
    }

    // Cancel a schedule by ID (POST /api/schedules/cancel or DELETE /api/schedules/:id)
    if (
      ((path.endsWith("/schedules/cancel") || path.includes("/schedules/cancel/")) && request.method === "POST") ||
      (path.includes("/schedules/") && request.method === "DELETE")
    ) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const scheduleId =
          body.scheduleId ||
          body.id ||
          url.searchParams.get("id") ||
          path.split("/schedules/cancel/")[1] ||
          path.split("/schedules/")[1] ||
          "";

        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        // Issue #6503 step 8 (G1) — level-rule gate, before any mutation.
        const cancelGate = await authorizeControlOrRespond(scheduleId, "schedule.cancelled");
        if (cancelGate instanceof Response) return cancelGate;
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record before the delete lands; a failed audit refuses
        // with the coded 503 and deletes nothing.
        const cancelAuditRefusal = await auditScheduleControlBeforeWrite(ctx, cancelGate.caller, "schedule.cancelled", scheduleId);
        if (cancelAuditRefusal) return cancelAuditRefusal;
        const cancelAttribution = {
          changedBy: cancelGate.caller.login,
          callerLevel: cancelGate.caller.kind,
          ...(cancelGate.record?.state ? { fromState: cancelGate.record.state } : {}),
        };
        if (scheduleId === TICKER_PUSH_RECORD_ID) {
          // Issue #4389 — Delete is every row's destructive control, and on a
          // live feed it means the only destructive thing there is: stop it.
          // The feed has no definition to remove (the agent rewrites its record
          // on the next push), so the cancellation IS the deletion; the row's
          // confirmation says so, and Resume brings it back.
          await tickerPushStub().pauseTickerPush();
          ctx.audit("schedule.cancelled", "orchestrator", {
            scheduleId,
            success: true,
            callback: "pushTicks",
            ...cancelAttribution,
          });
          return Response.json({ scheduleId, cancelled: true });
        }
        const deleted = await deleteUnifiedSchedule({ store: unifiedStore(), alarms }, scheduleId);
        if (!deleted.ok) {
          // Issue #5891 — the refusal is audited truthfully
          // (success:false + the named error) and answered with
          // the refusal's status, never the silent 200 +
          // cancelled:false.
          ctx.audit("schedule.cancelled", "orchestrator", {
            scheduleId,
            success: false,
            error: deleted.error,
            ...cancelAttribution,
          });
          return Response.json({ error: deleted.error }, { status: deleted.status });
        }
        ctx.audit("schedule.cancelled", "orchestrator", { scheduleId, success: true, ...cancelAttribution });
        return Response.json({ scheduleId, cancelled: deleted.cancelled });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel schedule" }, { status: 500 });
      }
    }

    // Issue #3122 — pending-approval decisions for agent schedules.
    // GET /api/schedules/approvals lists pending approvals (the queue
    // the approval UI reads, #4142); POST
    // /api/schedules/approvals/:id/approve arms the recorded
    // definition through the capability (the approver is PDP-checked
    // for action:approve; the arming runs under the ORIGINAL
    // requester's principal with the approval as its gate-skip
    // token); /reject records the rejection and arms nothing. A
    // failed arming leaves the approval pending, so the approver can
    // retry once the cause is fixed.
    if (request.method === "GET" && (path.endsWith("/schedules/approvals") || path.endsWith("/api/schedules/approvals"))) {
      try {
        const port = createPendingScheduleApprovalPort(ctx.agentCtx.storage.sql);
        const approvals = (await port.load()).filter((entry) => entry.status === "pending");
        return Response.json({ count: approvals.length, approvals });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list pending approvals" }, { status: 500 });
      }
    }

    // Issue #4260 — the schedules-home flags surface. GET reads the
    // three surfaced flags live through the existing FeatureFlagPort
    // (any caller may read; canToggle is true only for a platform
    // admin). POST toggles one channel flag for a platform admin
    // through the same port: the one-on invariant is enforced, the
    // schedules surface flag is read-only, and a runtime whose flag
    // source is operator-owned (Flagship dashboard / env vars)
    // refuses with FLAG_WRITE_UNSUPPORTED instead of a second store.
    // Both blocks sit before the get-by-id branch, which would
    // otherwise swallow /schedules/flags as an id.
    if (request.method === "GET" && (path.endsWith("/schedules/flags") || path.endsWith("/api/schedules/flags"))) {
      try {
        const port = ctx.featureFlagPort ?? createFeatureFlagPort(ctx.env);
        const view = await resolveScheduleChannelFlagsView(port);
        const caller = await resolveScheduleFlagsCaller(request, ctx);
        return Response.json({
          ...view,
          canToggle: caller.kind === "admin",
          managedBy: resolveFlagManagedBy(ctx),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to read scheduling-channel flags" }, { status: 500 });
      }
    }
    if (request.method === "POST" && (path.endsWith("/schedules/flags") || path.endsWith("/api/schedules/flags"))) {
      const caller = await resolveScheduleFlagsCaller(request, ctx);
      if (caller.kind === "unauthenticated") {
        return Response.json({ error: "Unauthorized: a signed-in session is required." }, { status: 401 });
      }
      if (caller.kind !== "admin") {
        return Response.json({ error: caller.reason }, { status: 403 });
      }
      const body = (await request.json().catch(() => null)) as unknown;
      const flag = (body as { flag?: unknown } | null)?.flag;
      const enabled = (body as { enabled?: unknown } | null)?.enabled;
      if (typeof flag !== "string" || typeof enabled !== "boolean") {
        return Response.json(
          { error: "A flag name and an enabled boolean are required.", code: "INVALID_REQUEST" },
          { status: 400 },
        );
      }
      const port = ctx.featureFlagPort ?? createFeatureFlagPort(ctx.env);
      const managedBy = resolveFlagManagedBy(ctx);
      const result = await applyScheduleChannelToggle(port, flag, enabled);
      if (!result.ok) {
        const status = result.code === "UNKNOWN_FLAG" ? 400 : 409;
        const error =
          result.code === "FLAG_WRITE_UNSUPPORTED"
            ? `${result.message} Manage it in the ${managedBy === "flagship" ? "Cloudflare Flagship dashboard" : "environment (FEATURE_FLAGS / FEATURE_SCHEDULE_CHAT / FEATURE_SCHEDULE_NLQ) and redeploy"}.`
            : result.message;
        return Response.json({ error, code: result.code }, { status });
      }
      ctx.audit("schedule.channel-flag-changed", "orchestrator", {
        flag,
        enabled,
        changedBy: caller.login,
        channels: result.state,
      });
      const view = await resolveScheduleChannelFlagsView(port);
      return Response.json({ ...view, canToggle: true, managedBy });
    }

    // Issue #6482 — the schedules-home controls surface. GET reads the
    // managed schedule controls live (effective floor + kill-switch +
    // firing rate + armed-schedule inventory); any caller may read,
    // canToggle is true only for a platform admin. POST applies one
    // controls change for a platform admin through the managed store
    // (mas_settings): the floor and the kill-switch are managed
    // settings, never env-only or dashboard-only. Both blocks sit
    // before the get-by-id branch, which would otherwise swallow
    // /schedules/controls as an id.
    if (request.method === "GET" && (path.endsWith("/schedules/controls") || path.endsWith("/api/schedules/controls"))) {
      try {
        const items = await listUnifiedScheduleItems({ store: unifiedStore(), alarms });
        const view = await resolveScheduleControlsView(ctx.agentCtx.storage.sql, ctx.env, items);
        const caller = await resolveScheduleFlagsCaller(request, ctx);
        return Response.json({ ...view, canToggle: caller.kind === "admin" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to read schedule controls" }, { status: 500 });
      }
    }
    if (request.method === "POST" && (path.endsWith("/schedules/controls") || path.endsWith("/api/schedules/controls"))) {
      const caller = await resolveScheduleFlagsCaller(request, ctx);
      if (caller.kind === "unauthenticated") {
        return Response.json({ error: "Unauthorized: a signed-in session is required." }, { status: 401 });
      }
      if (caller.kind !== "admin") {
        return Response.json({ error: caller.reason }, { status: 403 });
      }
      const body = (await request.json().catch(() => null)) as unknown;
      const patch = (body ?? {}) as {
        minIntervalSeconds?: unknown;
        firingEnabled?: unknown;
        startPaused?: unknown;
        firingRateAlertThreshold?: unknown;
        firingRateAlertWindowMinutes?: unknown;
        heartbeatIntervalSeconds?: unknown;
        heartbeatWatchdogStaleAfterMinutes?: unknown;
        missedScheduleGraceMinutes?: unknown;
        dueGuardMs?: unknown;
        staleRunningReapMs?: unknown;
        staleSweepBatchLimit?: unknown;
        researchScheduleUtcHour?: unknown;
        jobRunRecordCap?: unknown;
        tickHistoryCap?: unknown;
      };
      const hasFloor = patch.minIntervalSeconds !== undefined;
      const hasFiring = patch.firingEnabled !== undefined;
      const hasStartPaused = patch.startPaused !== undefined;
      const hasRateThreshold = patch.firingRateAlertThreshold !== undefined;
      const hasRateWindow = patch.firingRateAlertWindowMinutes !== undefined;
      // Issue #6503 step 13 — the externalized remainder is settable
      // through this same surface (no second settings mechanism).
      const hasHeartbeatInterval = patch.heartbeatIntervalSeconds !== undefined;
      const hasHeartbeatStaleAfter = patch.heartbeatWatchdogStaleAfterMinutes !== undefined;
      const hasGrace = patch.missedScheduleGraceMinutes !== undefined;
      const hasDueGuard = patch.dueGuardMs !== undefined;
      const hasReapMs = patch.staleRunningReapMs !== undefined;
      const hasReapBatch = patch.staleSweepBatchLimit !== undefined;
      const hasResearchHour = patch.researchScheduleUtcHour !== undefined;
      const hasJobRunCap = patch.jobRunRecordCap !== undefined;
      const hasTickCap = patch.tickHistoryCap !== undefined;
      if (!hasFloor && !hasFiring && !hasStartPaused && !hasRateThreshold && !hasRateWindow && !hasHeartbeatInterval && !hasHeartbeatStaleAfter && !hasGrace && !hasDueGuard && !hasReapMs && !hasReapBatch && !hasResearchHour && !hasJobRunCap && !hasTickCap) {
        return Response.json(
          {
            error:
              "A minIntervalSeconds, firingEnabled, startPaused, firingRateAlertThreshold, firingRateAlertWindowMinutes, heartbeatIntervalSeconds, heartbeatWatchdogStaleAfterMinutes, missedScheduleGraceMinutes, dueGuardMs, staleRunningReapMs, staleSweepBatchLimit, researchScheduleUtcHour, jobRunRecordCap or tickHistoryCap value is required.",
            code: "INVALID_CONTROLS",
          },
          { status: 400 },
        );
      }
      const applied = applyScheduleControlsPatch(
        ctx.agentCtx.storage.sql,
        {
          ...(hasFloor ? { minIntervalSeconds: patch.minIntervalSeconds as never } : {}),
          ...(hasFiring ? { firingEnabled: patch.firingEnabled as never } : {}),
          ...(hasStartPaused ? { startPaused: patch.startPaused as never } : {}),
          ...(hasRateThreshold ? { firingRateAlertThreshold: patch.firingRateAlertThreshold as never } : {}),
          ...(hasRateWindow ? { firingRateAlertWindowMinutes: patch.firingRateAlertWindowMinutes as never } : {}),
          ...(hasHeartbeatInterval ? { heartbeatIntervalSeconds: patch.heartbeatIntervalSeconds as never } : {}),
          ...(hasHeartbeatStaleAfter ? { heartbeatWatchdogStaleAfterMinutes: patch.heartbeatWatchdogStaleAfterMinutes as never } : {}),
          ...(hasGrace ? { missedScheduleGraceMinutes: patch.missedScheduleGraceMinutes as never } : {}),
          ...(hasDueGuard ? { dueGuardMs: patch.dueGuardMs as never } : {}),
          ...(hasReapMs ? { staleRunningReapMs: patch.staleRunningReapMs as never } : {}),
          ...(hasReapBatch ? { staleSweepBatchLimit: patch.staleSweepBatchLimit as never } : {}),
          ...(hasResearchHour ? { researchScheduleUtcHour: patch.researchScheduleUtcHour as never } : {}),
          ...(hasJobRunCap ? { jobRunRecordCap: patch.jobRunRecordCap as never } : {}),
          ...(hasTickCap ? { tickHistoryCap: patch.tickHistoryCap as never } : {}),
        },
        new Date().toISOString(),
      );
      if (!applied.ok) {
        return Response.json({ error: applied.message, code: applied.code }, { status: 400 });
      }
      ctx.audit("schedule.controls-changed", "orchestrator", {
        ...(applied.changed.minIntervalSeconds !== undefined
          ? { minIntervalSeconds: applied.changed.minIntervalSeconds }
          : {}),
        ...(applied.changed.firingEnabled !== undefined
          ? { firingEnabled: applied.changed.firingEnabled }
          : {}),
        ...(applied.changed.startPaused !== undefined
          ? { startPaused: applied.changed.startPaused }
          : {}),
        ...(applied.changed.firingRateAlertThreshold !== undefined
          ? { firingRateAlertThreshold: applied.changed.firingRateAlertThreshold }
          : {}),
        ...(applied.changed.firingRateAlertWindowMinutes !== undefined
          ? { firingRateAlertWindowMinutes: applied.changed.firingRateAlertWindowMinutes }
          : {}),
        ...(applied.changed.heartbeatIntervalSeconds !== undefined
          ? { heartbeatIntervalSeconds: applied.changed.heartbeatIntervalSeconds }
          : {}),
        ...(applied.changed.heartbeatWatchdogStaleAfterMinutes !== undefined
          ? { heartbeatWatchdogStaleAfterMinutes: applied.changed.heartbeatWatchdogStaleAfterMinutes }
          : {}),
        ...(applied.changed.missedScheduleGraceMinutes !== undefined
          ? { missedScheduleGraceMinutes: applied.changed.missedScheduleGraceMinutes }
          : {}),
        ...(applied.changed.dueGuardMs !== undefined
          ? { dueGuardMs: applied.changed.dueGuardMs }
          : {}),
        ...(applied.changed.staleRunningReapMs !== undefined
          ? { staleRunningReapMs: applied.changed.staleRunningReapMs }
          : {}),
        ...(applied.changed.staleSweepBatchLimit !== undefined
          ? { staleSweepBatchLimit: applied.changed.staleSweepBatchLimit }
          : {}),
        ...(applied.changed.researchScheduleUtcHour !== undefined
          ? { researchScheduleUtcHour: applied.changed.researchScheduleUtcHour }
          : {}),
        ...(applied.changed.jobRunRecordCap !== undefined
          ? { jobRunRecordCap: applied.changed.jobRunRecordCap }
          : {}),
        ...(applied.changed.tickHistoryCap !== undefined
          ? { tickHistoryCap: applied.changed.tickHistoryCap }
          : {}),
        changedBy: caller.login,
      });
      const items = await listUnifiedScheduleItems({ store: unifiedStore(), alarms });
      const view = await resolveScheduleControlsView(ctx.agentCtx.storage.sql, ctx.env, items);
      return Response.json({ ...view, canToggle: true });
    }
    const approvalsMatch = path.match(/\/schedules\/approvals\/([^/]+)\/(approve|reject)$/);
    if (request.method === "POST" && approvalsMatch) {
      const approvalId = (() => {
        try {
          return decodeURIComponent(approvalsMatch[1]);
        } catch {
          return approvalsMatch[1];
        }
      })();
      const decision = approvalsMatch[2] as "approve" | "reject";
      try {
        const context = await ctx.getScreenerExecutionContext();
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: request.headers.get("x-user-login") || "",
          headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        if (!trusted.userLogin) {
          return Response.json({ error: "An authenticated user identity is required to decide a schedule approval." }, { status: 401 });
        }
        // PDP: the approver needs action:approve in the tenant scope.
        const pdp = await evaluateAgentSchedulePdp(createAgentSchedulePdpDeps(ctx.env), {
          principal: { login: trusted.userLogin, agentId: "schedule-approvals-api" },
          tenantId: resolveIaaaTenant(ctx.env),
          action: "approve",
          nowMs: Date.now(),
        });
        if (!pdp.enforced || !pdp.allowed) {
          const reason = pdp.enforced
            ? pdp.reason ?? "action:approve not granted"
            : "PDP enforcement is disabled";
          ctx.audit("agent.schedule.approval-denied", "orchestrator", {
            pendingApprovalId: approvalId,
            decidedBy: trusted.userLogin,
            pdpEnforced: pdp.enforced,
            reason,
          });
          return Response.json({ error: `Approval denied by policy: ${reason}` }, { status: 403 });
        }
        const port = createPendingScheduleApprovalPort(ctx.agentCtx.storage.sql);
        const entry = resolvePendingScheduleApproval(await port.load(), approvalId);
        if (!entry) {
          return Response.json({ error: `Pending approval '${approvalId}' was not found.` }, { status: 404 });
        }
        if (entry.status !== "pending") {
          return Response.json({ error: `Pending approval '${approvalId}' is already decided (${entry.status}).` }, { status: 409 });
        }
        const nowIso = new Date().toISOString();
        if (decision === "reject") {
          await port.save(decidePendingScheduleApproval(await port.load(), approvalId, "rejected", trusted.userLogin, nowIso));
          ctx.audit("agent.schedule.approval-rejected", "orchestrator", { pendingApprovalId: approvalId, decidedBy: trusted.userLogin, kind: entry.kind });
          return Response.json({ approvalId, status: "rejected" });
        }
        // Approve: arm the recorded definition through the capability
        // under the original requester's principal. A goal definition
        // cannot arm from this DO (goals live in the ScheduledAgent
        // DO) — it is decided on the goal endpoint instead. A
        // stage-schedule arms through the stages adapter (the
        // unified store + the alarms port + the door registry read).
        if (entry.kind === "goal") {
          return Response.json({ error: `Pending approval '${approvalId}' is a goal approval; decide it at POST /api/schedule/goals/approvals/${approvalId}/approve.` }, { status: 409 });
        }
        const def = entry.definition as Record<string, unknown>;
        const principal = { login: entry.requestedBy, agentId: entry.agentId };
        const tenantId = resolveIaaaTenant(ctx.env);
        if (entry.kind === "workflow-stage") {
          const capabilityDeps = createAgentScheduleExecutorDepsForDo(
            ctx.env,
            ctx.agentCtx.storage.sql,
            (type, payload) => ctx.audit(type, "orchestrator", payload),
            { stages: workflowStageAdapter() },
          );
          let armedStage: AgentScheduleActionResult;
          if (def.jobId !== undefined) {
            armedStage = await executeAgentScheduleAction(capabilityDeps, {
              action: "create",
              kind: "workflow-stage",
              principal,
              tenantId,
              jobId: String(def.jobId),
              nodePath: String(def.nodePath),
              timing: def.timing as AgentSdkTiming,
              ...(typeof def.reason === "string" ? { reason: def.reason } : {}),
              approvedPendingId: approvalId,
            });
          } else {
            armedStage = await executeAgentScheduleAction(capabilityDeps, {
              action: "update",
              kind: "workflow-stage",
              principal,
              tenantId,
              scheduleId: String(def.scheduleId),
              ...(def.timing !== undefined ? { timing: def.timing as AgentSdkTiming } : {}),
              ...(typeof def.reason === "string" ? { reason: def.reason } : {}),
              approvedPendingId: approvalId,
            });
          }
          if (!armedStage.ok) {
            return Response.json({ error: `Approval could not be armed: ${armedStage.reason}` }, { status: 502 });
          }
          await port.save(decidePendingScheduleApproval(await port.load(), approvalId, "approved", trusted.userLogin, nowIso));
          ctx.audit("agent.schedule.approval-approved", "orchestrator", { pendingApprovalId: approvalId, decidedBy: trusted.userLogin, kind: entry.kind, scheduleId: armedStage.scheduleId });
          return Response.json({ approvalId, status: "approved", scheduleId: armedStage.scheduleId });
        }
        const toItem = (s: unknown): AgentScheduleItem => s as unknown as AgentScheduleItem;
        const sdkAdapter: AgentSdkScheduleAdapter = {
          // Issue #6482 — paused schedules have no live alarm, so
          // list/get union the live alarms with the store's records
          // (a live alarm wins when both name the same id).
          list: async () => {
            const live = (await ctx.listSchedules()).map(toItem);
            const stored = (await unifiedStore().list())
              .filter((record) => record.kind === "screen")
              .map((record) => unifiedRecordToAgentSdkScheduleItem(record));
            const seen = new Set(live.map((item) => item.id));
            return [...live, ...stored.filter((item) => !seen.has(item.id))];
          },
          get: async (id) => {
            const found = await ctx.getScheduleById(id);
            if (found !== undefined) return toItem(found);
            const record = await unifiedStore().get(id);
            return record && record.kind === "screen"
              ? unifiedRecordToAgentSdkScheduleItem(record)
              : undefined;
          },
          // Issue #6482 — paused by default: an approved create
          // records a paused schedule and never arms the SDK; an
          // explicit resume is the only activation. Issue #6503 —
          // when the start-paused control is off, the approved
          // schedule starts active instead (resume arms it through
          // the route's alarms port).
          create: async ({ timing, callback, payload }) =>
            createPausedAgentSdkScheduleRecord(
              unifiedStore(),
              { timing, callback, payload },
              new Date().toISOString(),
              {
                startPaused: resolveEffectiveScheduleStartPaused(ctx.agentCtx.storage.sql, ctx.env).paused,
                alarms,
              },
            ),
          cancel: async (id) => {
            const cancelled = await ctx.cancelSchedule(id);
            if (cancelled) {
              await removeAgentSdkScheduleRecord(unifiedStore(), id);
              return true;
            }
            // Issue #6482 — a paused schedule has no live alarm to
            // cancel: deleting it removes the record instead.
            const existing = await unifiedStore().get(id);
            if (existing) {
              await removeAgentSdkScheduleRecord(unifiedStore(), id);
              return true;
            }
            return false;
          },
        };
        const capabilityDeps = createAgentScheduleExecutorDepsForDo(
          ctx.env,
          ctx.agentCtx.storage.sql,
          (type, payload) => ctx.audit(type, "orchestrator", payload),
          { sdk: sdkAdapter },
        );
        let armed: AgentScheduleActionResult;
        if (def.callback !== undefined) {
          armed = await executeAgentScheduleAction(capabilityDeps, {
            action: "create",
            kind: "sdk",
            principal,
            tenantId,
            callback: String(def.callback),
            timing: def.timing as AgentSdkTiming,
            ...(def.payload !== undefined ? { payload: def.payload } : {}),
            approvedPendingId: approvalId,
          });
        } else {
          armed = await executeAgentScheduleAction(capabilityDeps, {
            action: "update",
            kind: "sdk",
            principal,
            tenantId,
            scheduleId: String(def.scheduleId),
            ...(def.timing !== undefined ? { timing: def.timing as AgentSdkTiming } : {}),
            ...(def.payload !== undefined ? { payload: def.payload } : {}),
            approvedPendingId: approvalId,
          });
        }
        if (!armed.ok) {
          return Response.json({ error: `Approval could not be armed: ${armed.reason}` }, { status: 502 });
        }
        await port.save(decidePendingScheduleApproval(await port.load(), approvalId, "approved", trusted.userLogin, nowIso));
        ctx.audit("agent.schedule.approval-approved", "orchestrator", { pendingApprovalId: approvalId, decidedBy: trusted.userLogin, kind: entry.kind, scheduleId: armed.scheduleId });
        return Response.json({ approvalId, status: "approved", scheduleId: armed.scheduleId });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to decide the schedule approval" }, { status: 500 });
      }
    }

    // Cancel ALL schedules on this instance (POST /api/schedules/cancel-all).
    // Issue #2280: the post-reset queue wipe mechanism — one endpoint for
    // the whole framework queue instead of one cancel per id. The list
    // covers every cf_agents_jobs row owned by this agent: user schedules
    // AND executeAsyncJob rows share the scheduler capability (verified
    // against agents SDK 0.24.0: JobQueue.list filters by capability, and
    // async jobs are scheduled through the same ctx.schedule API), so
    // cancelling each listed id empties the queue; the next alarm then
    // finds nothing due and the SDK deletes the alarm (rearmAlarm),
    // which stops the loop. Paused schedules are NOT queue rows (already
    // cancelled at SDK level) — their resume records in the paused store
    // are preserved, counted in the response, and never deleted here.
    // Fail-closed: without { confirm: true } this returns the preview
    // (what would be cancelled) and cancels nothing.
    if (path.endsWith("/schedules/cancel-all") && request.method === "POST") {
      try {
        // Issue #6503 step 8 (G1) — cancelling all touches every
        // schedule including the platform-level system rows, so the
        // whole route is platform-admin only (preview included).
        const caller = await resolveScheduleControlCaller(request, ctx);
        if (caller.kind === "unauthenticated") {
          const reason = "Unauthorized: a signed-in session is required to control schedules.";
          await auditScheduleControlRefusal(ctx, "schedules.cancelled.all", undefined, reason, caller);
          return Response.json({ error: reason }, { status: 401 });
        }
        if (caller.kind !== "platform-admin") {
          const reason = "Forbidden: cancelling all schedules touches platform-level schedules, which are controllable by platform-admin only.";
          await auditScheduleControlRefusal(ctx, "schedules.cancelled.all", undefined, reason, caller);
          return Response.json({ error: reason }, { status: 403 });
        }
        const body = (await request.json().catch(() => ({}))) as any;
        const schedules = await ctx.listSchedules();
        const preview = schedules.map((s) => ({ id: s.id, callback: s.callback }));
        let pausedPreserved = 0;
        try {
          pausedPreserved = (await unifiedStore().listByState("paused")).length;
        } catch {
          pausedPreserved = 0;
        }
        if (body.confirm !== true) {
          return Response.json({
            cancelled: 0,
            confirmRequired: true,
            wouldCancel: preview,
            wouldCancelCount: preview.length,
            pausedPreserved,
          });
        }
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record for the cancel-all (naming the ids to cancel)
        // before any cancellation runs; a failed audit refuses
        // with the coded 503 and cancels nothing.
        const cancelAllAuditRefusal = await auditScheduleControlBeforeWrite(
          ctx,
          caller,
          "schedules.cancelled.all",
          preview.map((s) => s.id).join(","),
        );
        if (cancelAllAuditRefusal) return cancelAllAuditRefusal;
        const cancelledIds: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const item of preview) {
          try {
            const ok = await ctx.cancelSchedule(item.id);
            if (ok) cancelledIds.push(item.id);
            else failed.push({ id: item.id, error: "not found" });
          } catch (err: any) {
            failed.push({ id: item.id, error: err.message || "cancel failed" });
          }
        }
        ctx.audit("schedules.cancelled.all", "orchestrator", {
          cancelledCount: cancelledIds.length,
          cancelledIds,
          failedCount: failed.length,
          pausedPreserved,
          // Issue #6503 step 9 (G2) — caller attribution on every event.
          changedBy: caller.login,
          callerLevel: caller.kind,
          // Issue #2457: cross-tenant delegation annotation only. These
          // headers are set solely by the admin tenant-queue route when
          // it fans out to this instance; they never change scope or
          // authorization here — the instance itself is the scope.
          ...(request.headers.get("x-admin-actor")
            ? { adminActor: request.headers.get("x-admin-actor") }
            : {}),
          ...(request.headers.get("x-admin-tenant")
            ? { adminTenant: request.headers.get("x-admin-tenant") }
            : {}),
        });
        return Response.json({
          cancelled: cancelledIds.length,
          cancelledIds,
          failed,
          pausedPreserved,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel all schedules" }, { status: 500 });
      }
    }

    // Issue #2964 — per-run job records + the creatable-callback
    // catalog for the unified Jobs UI. These MUST be matched BEFORE
    // the get-by-id block below: /schedules/abc/runs would otherwise
    // misparse "runs" as the id and 404, and /schedules/callbacks
    // would misparse "callbacks" as the id.
    if (path === "/schedules/runs" && request.method === "GET") {
      try {
        const params = new URL(request.url).searchParams;
        const scheduleId = params.get("scheduleId") || undefined;
        const limit = Number(params.get("limit") || 50);
        // Issue #6101 — the runs list reads the D1 ledger.
        const store = createJobRunRecordAdapter(ctx.env);
        if (!store) {
          throw new Error(
            "[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).",
          );
        }
        // Issue #6503 — a stored system id reads its ledger rows
        // under its dispatch job id (token-renewal → its cron).
        const runs = scheduleId
          ? await store.listByJob(scheduleIdToLedgerJobId(scheduleId), limit)
          : await store.listRecent(limit);
        return Response.json({ ok: true, runs });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list job runs" }, { status: 500 });
      }
    }
    const scheduleRunsMatch = path.match(/^\/schedules\/([^/]+)\/runs$/);
    if (scheduleRunsMatch && request.method === "GET") {
      try {
        const limit = Number(new URL(request.url).searchParams.get("limit") || 50);
        // Issue #6101 — the runs list reads the D1 ledger.
        const store = createJobRunRecordAdapter(ctx.env);
        if (!store) {
          throw new Error(
            "[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).",
          );
        }
        // Issue #4239 — see the /schedules/runs branch above.
        return Response.json({ ok: true, runs: await store.listByJob(scheduleIdToLedgerJobId(scheduleRunsMatch[1]), limit) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list job runs" }, { status: 500 });
      }
    }

    // Issue #3121 Phase 2 (#3123) — ledger record route. The
    // ScheduledAgent posts goal rows to the one physical ledger
    // (the D1 job_run_records, #6101) through this background-
    // gated route (same gate as record-cron-dispatch, §12 of the
    // S5 design). Placed here, next to the runs reads: no earlier
    // branch can swallow it — the earlier POST branches match only
    // `/schedules/cancel`, `/schedules/cancel-all`, the
    // `/:id/pause|resume|trigger` suffixes, `/schedules/create`,
    // `/schedules` exactly, or the other `trigger-*` suffixes —
    // and the generic `/schedules/` branches above are GET, DELETE,
    // or PUT, never POST. Body: a full JobRunRecord. A malformed
    // shape is 400 (the validator is the build); a store failure
    // is 500. The record itself goes through the one entry.
    if (path.endsWith("/schedules/runs/record") && request.method === "POST") {
      const attribution = resolveActorAttribution(
        request.headers,
        getServiceUserLogin(ctx.env),
      );
      if (attribution.actorKind !== "background") {
        return Response.json(
          { success: false, error: "Background service dispatch required." },
          { status: 401 },
        );
      }
      const body = (await request.json().catch(() => null)) as unknown;
      if (!body || typeof body !== "object") {
        return Response.json({ success: false, error: "Invalid ledger record." }, { status: 400 });
      }
      try {
        buildJobRunRecord(body as JobRunRecordInput);
      } catch (err) {
        return Response.json(
          { success: false, error: err instanceof Error ? err.message : "Invalid ledger record." },
          { status: 400 },
        );
      }
      try {
        // Issue #6101 — the record lands in D1 directly; there is
        // no projection to hook any more (the #6099 projector is
        // deleted). The attribution stamps the service-user login
        // as the run's user.
        const store = createJobRunRecordAdapter(ctx.env);
        if (!store) {
          throw new Error(
            "[run-ledger] D1 run-ledger binding unbound (AGENT_DB) (#6101).",
          );
        }
        const built = await recordLedgerRunD1(
          store,
          body as JobRunRecordInput,
          resolveLedgerAttribution(ctx.env, { userId: getServiceUserLogin(ctx.env) ?? undefined }),
        );
        return Response.json({ success: true, jobId: built.jobId, scheduleId: built.scheduleId ?? null });
      } catch (err) {
        return Response.json(
          { success: false, error: err instanceof Error ? err.message : "Failed to record ledger run." },
          { status: 500 },
        );
      }
    }
    if (path === "/schedules/callbacks" && request.method === "GET") {
      return Response.json({ ok: true, callbacks: ctx.creatableScheduleCallbacks });
    }

    // Get specific schedule by ID (GET /api/schedules/:id)
    if (path.includes("/schedules/") && request.method === "GET") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        // Issue #4389 — the live feed's Details come from its own DO, like every
        // other row's detail: one dialog, one path, no kind-specific gap.
        if (scheduleId === TICKER_PUSH_RECORD_ID) {
          const record = await tickerPushStub().getTickerPushRecord();
          if (!record) {
            return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
          }
          return Response.json(
            tickerPushRecordToListItem(
              record,
              Date.now(),
              resolveTickerPushStaleAfterIntervals(ctx.env),
            ),
          );
        }
        // Issue #6503 — a stored system row's detail is its list
        // item with the last run joined from the ledger (the same
        // join as the list); no stored row means 404 — nothing is
        // synthesized. The generic detail below would return the
        // raw alarm shape for an active row, without the join.
        if (SYSTEM_SCHEDULE_RECORD_IDS.has(scheduleId)) {
          const record = await unifiedStore().get(scheduleId);
          if (!record) {
            return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
          }
          const reader =
            scheduleId === TOKEN_RENEWAL_RECORD_ID
              ? readTokenRenewalListItem
              : scheduleId === RETENTION_RECORD_ID
                ? readRetentionListItem
                : scheduleId === NIGHTLY_RESEARCH_RECORD_ID
                  ? readNightlyResearchListItem
                  : scheduleId === STALE_LEDGER_SWEEP_RECORD_ID
                    ? readStaleLedgerSweepListItem
                    : scheduleId === STALE_ASYNC_JOB_SWEEP_RECORD_ID
                      ? readStaleAsyncJobSweepListItem
                      : readScheduleWatchdogListItem;
          const item = await reader(createJobRunRecordAdapter(ctx.env), record);
          return Response.json(item ?? unifiedRecordToListItem(record));
        }
        const detail = await getUnifiedScheduleDetail({ store: unifiedStore(), alarms }, scheduleId);
        if (!detail.ok) {
          return Response.json({ error: detail.error }, { status: detail.status });
        }
        return Response.json(detail.detail);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to get schedule" }, { status: 500 });
      }
    }

    // Bulk pause (POST /api/schedules/pause) — issue #5878. The bulk
    // branch sits BEFORE the single-row pause branch below: the
    // single-row match would otherwise read "pause" as the id.
    if (path.endsWith("/schedules/pause") && request.method === "POST") {
      return handleBulkScheduleVerb("pause");
    }

    // Bulk resume (POST /api/schedules/resume) — issue #5878. Same
    // ordering reason as the bulk pause branch above.
    if (path.endsWith("/schedules/resume") && request.method === "POST") {
      return handleBulkScheduleVerb("resume");
    }

    // Bulk run-now (POST /api/schedules/trigger) — issue #5878. Same
    // ordering reason as the bulk pause branch above.
    if (path.endsWith("/schedules/trigger") && request.method === "POST") {
      return handleBulkScheduleVerb("trigger");
    }

    // Pause a schedule (POST /api/schedules/:id/pause) — issue #273.
    // The SDK schedule is cancelled, but its definition and state
    // live in the unified store as a paused record, so the job stays
    // listed (status: paused) and can be resumed or edited in place.
    if (path.includes("/schedules/") && path.endsWith("/pause") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        // Issue #6503 step 8 (G1) — level-rule gate, before any mutation.
        const pauseGate = await authorizeControlOrRespond(scheduleId, "schedule.paused");
        if (pauseGate instanceof Response) return pauseGate;
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record before the pause lands; a failed audit refuses
        // with the coded 503 and pauses nothing.
        const pauseAuditRefusal = await auditScheduleControlBeforeWrite(ctx, pauseGate.caller, "schedule.paused", scheduleId);
        if (pauseAuditRefusal) return pauseAuditRefusal;
        const pauseAttribution = {
          changedBy: pauseGate.caller.login,
          callerLevel: pauseGate.caller.kind,
          ...(pauseGate.record?.state ? { fromState: pauseGate.record.state } : {}),
        };
        if (scheduleId === TICKER_PUSH_RECORD_ID) {
          await tickerPushStub().pauseTickerPush();
          ctx.audit("schedule.paused", "orchestrator", { scheduleId, callback: "pushTicks", ...pauseAttribution });
          const paused = await readTickerPushListItem(ctx.env);
          return Response.json({ success: true, schedule: paused });
        }
        const result = await pauseUnifiedSchedule({ store: unifiedStore(), alarms }, scheduleId, new Date().toISOString());
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        ctx.audit("schedule.paused", "orchestrator", { scheduleId, callback: result.record.callback, ...pauseAttribution });
        return Response.json({ success: true, schedule: unifiedRecordToListItem(result.record) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to pause schedule" }, { status: 500 });
      }
    }

    // Resume a paused schedule (POST /api/schedules/:id/resume) — #273.
    if (path.includes("/schedules/") && path.endsWith("/resume") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        // Issue #6503 step 8 (G1) — level-rule gate, before any mutation.
        const resumeGate = await authorizeControlOrRespond(scheduleId, "schedule.resumed");
        if (resumeGate instanceof Response) return resumeGate;
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record before the resume lands; a failed audit refuses
        // with the coded 503 and resumes nothing.
        const resumeAuditRefusal = await auditScheduleControlBeforeWrite(ctx, resumeGate.caller, "schedule.resumed", scheduleId);
        if (resumeAuditRefusal) return resumeAuditRefusal;
        const resumeAttribution = {
          changedBy: resumeGate.caller.login,
          callerLevel: resumeGate.caller.kind,
          ...(resumeGate.record?.state ? { fromState: resumeGate.record.state } : {}),
        };
        if (scheduleId === TICKER_PUSH_RECORD_ID) {
          await tickerPushStub().resumeTickerPush();
          ctx.audit("schedule.resumed", "orchestrator", { scheduleId, callback: "pushTicks", ...resumeAttribution });
          const resumedFeed = await readTickerPushListItem(ctx.env);
          return Response.json({ success: true, schedule: resumedFeed });
        }
        const result = await resumeUnifiedSchedule(
          { store: unifiedStore(), alarms, reconcileDeclared: ctx.reconcileScheduledTasks },
          scheduleId,
          new Date().toISOString(),
        );
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        ctx.audit("schedule.resumed", "orchestrator", { scheduleId, newScheduleId: result.alarm?.id, callback: result.record.callback, ...resumeAttribution });
        return Response.json({ success: true, previousId: result.previousId, schedule: result.alarm });
      } catch (err: any) {
        // Issue #6482 — a floor refusal from the re-arm is a client
        // error (400 with the code), not a 500: the requested cadence
        // is below the floor.
        if (isBelowFrequencyFloorError(err)) {
          return Response.json({ error: err.message, code: SCHEDULE_BELOW_FREQUENCY_FLOOR }, { status: 400 });
        }
        return Response.json({ error: err.message || "Failed to resume schedule" }, { status: 500 });
      }
    }

    // Trigger a schedule's callback now (POST /api/schedules/:id/trigger) — #273.
    if (path.includes("/schedules/") && path.endsWith("/trigger") && request.method === "POST") {
      try {
        const scheduleId = subpathId(path);
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        // Issue #6503 step 8 (G1) — level-rule gate, before any mutation.
        const triggerGate = await authorizeControlOrRespond(scheduleId, "schedule.triggered");
        if (triggerGate instanceof Response) return triggerGate;
        const triggerAttribution = {
          changedBy: triggerGate.caller.login,
          callerLevel: triggerGate.caller.kind,
        };
        // Issue #4389 — Trigger Now is every row's action: for the live feed it
        // pushes to the connected clients once, now, through its own DO.
        if (scheduleId === TICKER_PUSH_RECORD_ID) {
          const feed = await tickerPushStub().getTickerPushRecord();
          if (feed?.state === "paused") {
            return Response.json(
              { success: false, error: "The live feed is paused — resume it before triggering." },
              { status: 409 },
            );
          }
          // Issue #6503 step 9 (G2) — audit-before-write, after the
          // paused check above (a 409 consumes no chain record).
          const triggerAuditRefusal = await auditScheduleControlBeforeWrite(ctx, triggerGate.caller, "schedule.triggered", scheduleId);
          if (triggerAuditRefusal) return triggerAuditRefusal;
          await tickerPushStub().triggerTickerPush();
          ctx.audit("schedule.triggered", "orchestrator", { scheduleId, callback: "pushTicks", ...triggerAttribution });
          return Response.json({ success: true, scheduleId, callback: "pushTicks" });
        }
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record before the trigger runs; a failed audit refuses
        // with the coded 503 and triggers nothing.
        const triggerStoreAuditRefusal = await auditScheduleControlBeforeWrite(ctx, triggerGate.caller, "schedule.triggered", scheduleId);
        if (triggerStoreAuditRefusal) return triggerStoreAuditRefusal;
        const result = await triggerUnifiedSchedule(
          { store: unifiedStore(), alarms },
          scheduleId,
          (callback, payload) => runScheduleCallbackNow(callback, payload, scheduleId),
        );
        if (!result.ok) {
          return Response.json(
            { success: false, error: result.error },
            { status: result.status },
          );
        }
        ctx.audit("schedule.triggered", "orchestrator", { scheduleId: result.scheduleId, callback: result.callback, ...triggerAttribution });
        return Response.json({ success: true, scheduleId: result.scheduleId, callback: result.callback });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger schedule" }, { status: 500 });
      }
    }

    // Update a schedule (PUT /api/schedules/:id) — issue #273: change
    // the cron/interval and/or payload atomically (cancel + recreate
    // under the hood; paused jobs update in place in the unified store).
    if (path.includes("/schedules/") && request.method === "PUT") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        // Issue #6503 step 8 (G1) — level-rule gate, before any mutation.
        const updateGate = await authorizeControlOrRespond(scheduleId, "schedule.updated");
        if (updateGate instanceof Response) return updateGate;
        const body = (await request.json().catch(() => ({}))) as any;
        const updateAttribution = {
          changedBy: updateGate.caller.login,
          callerLevel: updateGate.caller.kind,
          ...(updateGate.record?.state ? { fromState: updateGate.record.state } : {}),
        };
        if (scheduleId === TICKER_PUSH_RECORD_ID) {
          // Issue #4352 — the live feed's one editable fact is its cadence,
          // and its cadence is an interval (a live feed has no cron phase).
          if (body?.scheduleType === "cron") {
            return Response.json(
              {
                error:
                  "The ticker push runs on an interval, not a cron expression — set an interval instead.",
              },
              { status: 400 },
            );
          }
          // Issue #6503 step 9 (G2) — audit-before-write, after the
          // cron check above (a 400 consumes no chain record).
          const updateTickerAuditRefusal = await auditScheduleControlBeforeWrite(ctx, updateGate.caller, "schedule.updated", scheduleId);
          if (updateTickerAuditRefusal) return updateTickerAuditRefusal;
          const seconds = Number(body?.intervalSeconds ?? 0);
          const applied = await tickerPushStub().setTickerPushInterval(seconds);
          ctx.audit("schedule.updated", "orchestrator", {
            scheduleId,
            callback: "pushTicks",
            intervalSeconds: applied.intervalSeconds,
            ...updateAttribution,
          });
          return Response.json({ success: true, schedule: await readTickerPushListItem(ctx.env) });
        }
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record before the update lands; a failed audit refuses
        // with the coded 503 and updates nothing.
        const updateAuditRefusal = await auditScheduleControlBeforeWrite(ctx, updateGate.caller, "schedule.updated", scheduleId);
        if (updateAuditRefusal) return updateAuditRefusal;
        const result = await updateUnifiedSchedule(
          { store: unifiedStore(), alarms },
          scheduleId,
          body,
          Date.now(),
        );
        if (!result.ok) {
          return Response.json({ success: false, error: result.error }, { status: result.status });
        }
        if (result.alarm) {
          ctx.audit("schedule.updated", "orchestrator", { scheduleId, newScheduleId: result.alarm.id, callback: result.record.callback, ...updateAttribution, toState: result.record.state });
          return Response.json({ success: true, previousId: result.previousId, schedule: result.alarm });
        }
        ctx.audit("schedule.updated", "orchestrator", { scheduleId, callback: result.record.callback, paused: true, ...updateAttribution, toState: result.record.state });
        return Response.json({ success: true, schedule: unifiedRecordToListItem(result.record) });
      } catch (err: any) {
        // Issue #6482 — a floor refusal from the re-arm is a client
        // error (400 with the code), not a 500.
        if (isBelowFrequencyFloorError(err)) {
          return Response.json({ success: false, error: err.message, code: SCHEDULE_BELOW_FREQUENCY_FLOOR }, { status: 400 });
        }
        return Response.json({ error: err.message || "Failed to update schedule" }, { status: 500 });
      }
    }

    // Create a stage-schedule (POST /api/schedules/workflow-stages) —
    // issue #3121 #3310: one pipeline job stage on its own schedule.
    // Scope is ENGINE job stages, validated against the ScheduledAgent's
    // registry: a legacy shard chain's stages are not engine nodes and are
    // not schedulable here — that gap is mooted by the chain's cutover onto
    // the workflow host (ADR 0031, #4426, #4471), which reuses this same
    // per-stage scheduling.
    // The REST create has no approval gate (the caller IS the human;
    // the gate is the agent path's, per #3122's design): session-gated,
    // registry-validated via the ScheduledAgent door, audited
    // `schedule.created`. Pause/resume/trigger/delete/detail/update/list
    // flow through the existing /:id/* routes via the management
    // service — no new routes for them.
    if (path.endsWith("/schedules/workflow-stages") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: request.headers.get("x-user-login") || "",
          headerEnvironment: (request.headers.get("x-environment") || "").toUpperCase(),
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        if (!trusted.userLogin) {
          const reason = "An authenticated user identity is required to create a stage-schedule.";
          await auditScheduleControlRefusal(ctx, "schedule.created", undefined, reason, { kind: "unauthenticated" });
          return Response.json({ error: reason }, { status: 401 });
        }
        const validated = validateWorkflowStageScheduleInput({
          jobId: body.jobId,
          nodePath: body.nodePath,
          scheduleType: body.scheduleType,
          cron: body.cron,
          intervalSeconds: body.intervalSeconds,
          reason: body.reason,
        });
        if (!validated.ok) {
          return Response.json({ error: validated.error }, { status: 400 });
        }
        const def = validated.value;
        // Issue #6503 step 9 (G2) — the create caller resolved
        // through the step-8 seam, so the audit names the resolved
        // login + level (a stage create is a user-level control op
        // owned by the caller).
        const stageCreateCaller = await resolveScheduleControlCaller(request, ctx);
        // Issue #6503 step 9 (G2) — audit-before-write: ONE chain
        // record before the stage-schedule is created; a failed
        // audit refuses with the coded 503 and creates nothing.
        const stageCreateAuditRefusal = await auditScheduleControlBeforeWrite(ctx, stageCreateCaller, "schedule.created", def.stageId);
        if (stageCreateAuditRefusal) return stageCreateAuditRefusal;
        const created = await workflowStageAdapter().create({
          jobId: def.jobId,
          nodePath: def.nodePath,
          timing:
            def.type === "cron"
              ? { type: "cron", cron: def.cron as string }
              : { type: "interval", intervalSeconds: def.intervalSeconds as number },
          reason: body.reason,
          ownerLogin: trusted.userLogin,
          provenance: agentScheduleProvenance("schedules-api", trusted.userLogin),
        });
        ctx.audit("schedule.created", "orchestrator", {
          scheduleId: created.id,
          jobId: def.jobId,
          nodePath: def.nodePath,
          stageId: def.stageId,
          origin: "api",
          // The caller cannot be unauthenticated here (the 401
          // above already returned), but the union still carries
          // the kind, so the login falls back to the trusted one.
          changedBy: stageCreateCaller.kind === "unauthenticated" ? trusted.userLogin : stageCreateCaller.login,
          callerLevel: stageCreateCaller.kind,
        });
        return Response.json({ success: true, schedule: unifiedRecordToListItem(created) });
      } catch (err: any) {
        // Issue #6482 — a floor refusal from the stage adapter's arm
        // is a client error (400 with the code), not a 500.
        if (isBelowFrequencyFloorError(err)) {
          return Response.json({ error: err.message, code: SCHEDULE_BELOW_FREQUENCY_FLOOR }, { status: 400 });
        }
        return Response.json({ error: err.message || "Failed to create stage-schedule" }, { status: 500 });
      }
    }

    // Create a schedule (delayed, scheduled, cron, or interval)
    if ((path.endsWith("/schedules/create") || (path.endsWith("/schedules") && request.method === "POST"))) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const { scheduleType, callback, payload, delayInSeconds, intervalSeconds, cron, date, idempotent } = body;

        if (!callback) {
          return Response.json({ error: "Callback method name is required" }, { status: 400 });
        }

        // Callback allow-list (#111): this public route may only arm the
        // user-creatable callbacks in ctx.creatableScheduleCallbacks.
        // Anything else — including internal-only callbacks such as
        // executeAsyncJob and expireStaleOrderDraft — is rejected, and no
        // schedule is created.
        if (!(ctx.creatableScheduleCallbacks as readonly string[]).includes(callback)) {
          return Response.json(
            {
              success: false,
              error: `Callback '${callback}' is not allowed: POST /api/schedules/create only accepts ${ctx.creatableScheduleCallbacks.join(", ")}`,
            },
            { status: 400 }
          );
        }

        // Issue #4235 — granularity first: the default is at most
        // once per day. A sub-daily timing needs the explicit
        // per-schedule opt-in (body.subDailyOptIn === true); anything
        // else is refused here, before any token check or arming, so
        // a rejected create arms nothing. A cron is range-validated
        // here too — an out-of-range cron is a 400, never a 503 from
        // the SDK. One-shot timings (delayed/scheduled) need no
        // opt-in.
        const subDailyOptIn = body.subDailyOptIn === true;
        const subDailyOptInError =
          "Sub-daily cadence runs more than once per day: pass subDailyOptIn: true to opt-in explicitly.";
        if (scheduleType === "cron" && cron) {
          if (!isValidCron(String(cron).trim())) {
            return Response.json(
              { success: false, error: `Invalid cron expression '${cron}': expected a valid 5-field cron expression (minute hour day-of-month month day-of-week, each field in range).` },
              { status: 400 }
            );
          }
          if (isSubDailyCron(String(cron).trim()) && !subDailyOptIn) {
            return Response.json({ success: false, error: subDailyOptInError }, { status: 400 });
          }
        }
        if (scheduleType === "interval" && intervalSeconds) {
          if (isSubDailyInterval(Number(intervalSeconds)) && !subDailyOptIn) {
            return Response.json({ success: false, error: subDailyOptInError }, { status: 400 });
          }
        }

        // Issue #6482 — the frequency floor is a hard refusal at arm
        // time, AFTER the sub-daily gate (a missing opt-in still
        // reports the opt-in error first) and BEFORE any identity,
        // credential, duplicate, or arming work, so a refused create
        // arms nothing. The sub-daily opt-in does NOT override the
        // floor: a 1-second interval with the opt-in is still refused.
        const floorSeconds = resolveEffectiveScheduleFloor(ctx.agentCtx.storage.sql, ctx.env).seconds;
        const floorTiming: ScheduleFloorTiming | undefined =
          scheduleType === "interval" && intervalSeconds
            ? { type: "interval", intervalSeconds: Number(intervalSeconds) }
            : scheduleType === "cron" && cron
              ? { type: "cron", cron: String(cron).trim() }
              : undefined;
        if (floorTiming) {
          const floorRefusal = refuseBelowFloorTiming(floorTiming, floorSeconds);
          if (!floorRefusal.ok) {
            return Response.json(
              { success: false, error: floorRefusal.message, code: SCHEDULE_BELOW_FREQUENCY_FLOOR },
              { status: 400 },
            );
          }
        }

        // Stamp screening schedules with the identity established by the
        // authenticated Worker forwarder. Never trust a caller-supplied
        // payload.userLogin to select another account's E*TRADE credentials.
        const context = await ctx.getScreenerExecutionContext();
        const headerUserLogin = request.headers.get("x-user-login") || "";
        const headerEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        // #4004 follow-up: the Worker-established header is THIS request's
        // verified identity; the stored screener context is per-instance
        // and can be stale (a previous login, or an agent identity such as
        // "openaimp"). Letting the context win made creation look for
        // credentials under the wrong connection and
        // refuse every schedule the signed-in owner tried to create.
        const trusted = resolveTrustedScheduleIdentity({
          headerLogin: headerUserLogin,
          headerEnvironment,
          context,
          configuredEnvironment: resolveEnvironmentConfig(ctx.env).name as ScheduleEnv,
        });
        const trustedUserLogin = trusted.userLogin;
        const trustedEnvironment = trusted.environment;
        if (ctx.accountScopedScheduleCallbacks.has(callback) && !trustedUserLogin) {
          const reason = "An authenticated broker account is required to create screening schedules.";
          await auditScheduleControlRefusal(ctx, "schedule.created", undefined, reason, { kind: "unauthenticated" });
          return Response.json({ success: false, error: reason }, { status: 401 });
        }
        // Issue #6503 step 8 (G1) — create is a control op on a
        // user-level schedule owned by the caller: any authenticated
        // user may schedule for themselves, but an anonymous create
        // names no owner and is refused (401), not just the
        // account-scoped callbacks above.
        if (!trustedUserLogin) {
          const reason = "An authenticated user identity is required to create a schedule.";
          await auditScheduleControlRefusal(ctx, "schedule.created", undefined, reason, { kind: "unauthenticated" });
          return Response.json({ success: false, error: reason }, { status: 401 });
        }
        // Issue #3655: the creation credential check follows the tenant
        // broker, not E*TRADE unconditionally. Broker etrade — or an
        // unreadable/unconfigured selection (LEGACY_UNREADABLE_BROKER,
        // #5516), preserving pre-#3655 behaviour — runs the existing
        // E*TRADE token check below,
        // unchanged. Any other broker verifies that broker's
        // credentials via resolveScreenSelection; a missing credential
        // is a 409 NAMING THE BROKER, never E*TRADE. Broker + data
        // provider + mode are resolved here and stamped onto the
        // payload at build time (identity, never a form value).
        let createBrokerId: string | undefined;
        let createDataProviderId: string | undefined;
        let createMode: "live" | "paper" | undefined;
        if (ctx.accountScopedScheduleCallbacks.has(callback)) {
          const tenantProviders = await resolveTenantProviders(ctx.env);
          createDataProviderId = tenantProviders.dataProviderId;
          // Issue #3655: providerConnections is imported LAZILY, never
          // statically — it sits on a load cycle with the trading
          // barrel (providerConnections → ../trading →
          // unifiedOptionsService → providerConnections); a static
          // import here would bind unifiedOptionsService to the real
          // reader instead of a test's vi.mock of it.
          const { readTenantBrokerSelection } = await import("../../services/providerConnections");
          const brokerRead = await readTenantBrokerSelection(ctx.env);
          // Issue #5516: the unreadable-store leg keeps the pre-#3655
          // E*TRADE bootstrap, named rather than inlined — see
          // LEGACY_UNREADABLE_BROKER. Issue #5104 (DEFAULT part of
          // B1): the UNCONFIGURED leg is different — no stored
          // selection resolves to the EXISTING vocabulary default,
          // not the legacy bootstrap. The mode is the configured
          // default mode, so the stamped (broker, mode) matches what
          // resolveScreenSelection resolves for the same unconfigured
          // tenant below.
          const brokerId =
            brokerRead.status === "ok"
              ? brokerRead.brokerId
              : brokerRead.status === "unconfigured"
                ? defaultBrokerId()
                : LEGACY_UNREADABLE_BROKER;
          createBrokerId = brokerId;
          const createEnvironment = trustedEnvironment === "TEST" ? "TEST" : "PROD";
          createMode =
            brokerRead.status === "unconfigured"
              ? defaultTradingMode()
              : tradingTypeFor(
                  isBrokerId(brokerId) ? brokerId : LEGACY_UNREADABLE_BROKER,
                  createEnvironment,
                );
          if (brokerId === "etrade") {
            // Issue #2442 S3: the trusted login (Worker-forwarder
            // established, never caller-supplied) resolves to its session
            // identity via the alias record, so a token stored under an
            // internal-id or alias-login key passes the preflight exactly
            // as it passes the panel check. Unresolvable yields an empty
            // identity, keeping today's login-only lookup.
            const identity = await etradeIdentityFromLogin(ctx.env, trustedUserLogin);
            const storedTokens = await getStoredTokens(ctx.env, trustedUserLogin, trustedEnvironment, identity);
            if (!storedTokens || isTokenExpiredEt(storedTokens.storedAt)) {
              return Response.json({
                success: false,
                error: "Connect an E*TRADE account for this environment before creating an account-scoped schedule.",
              }, { status: 409 });
            }
          } else {
            // Issue #3655: lazy import — same cycle as the broker read
            // above; never a static import of providerConnections here.
            const { resolveScreenSelection } = await import("../../services/providerConnections");
            const selection = await resolveScreenSelection({
              env: ctx.env,
              userLogin: trustedUserLogin,
            });
            if (!selection.resolved) {
              const display = BROKER_DISPLAY_NAMES[brokerId] ?? brokerId;
              return Response.json({
                success: false,
                error: `Connect a ${display} account for this environment before creating an account-scoped schedule (${selection.code}: ${selection.error}).`,
              }, { status: 409 });
            }
          }
        }
        const { userLogin: _untrustedUserLogin, environment: _untrustedEnvironment, brokerId: _untrustedBrokerId, dataProviderId: _untrustedDataProviderId, mode: _untrustedMode, accountId: _untrustedAccountId, accountType: _untrustedAccountType, ...safePayload } =
          payload && typeof payload === "object" ? payload : {};
        // Issue #2373 (slice C): schedule-creation guard for
        // STOCK schedules, under monetization ON only. Stock
        // ticks cannot ride the payment workflow (chain /
        // monolithic execution, G7-rejected migration — see the
        // tick decision in src/services/scheduledTasks.ts), so a
        // one-off stock schedule can never checkout: claiming
        // one_off without authorization is a 400 (authorization
        // never given), and claiming one_off WITH authorization
        // is also a 400 with the honest explanation (no checkout
        // exists for it — run manually via the paid screen seam
        // or use a covered recurring schedule). An absent
        // scheduleKind is stamped "recurring" below (fail-closed
        // default, covering legacy schedules); the tick itself
        // also defaults absent → recurring. Goal callbacks are
        // NOT guarded here: goal ticks already handle one_off
        // via the payment-workflow seam. The guard validates on
        // the raw payload BEFORE buildSchedulePayload, because
        // the builder's strict criteria schema does not know
        // these fields and would reject them as unknown; the
        // fields are stripped from the builder input and stamped
        // back onto the stored payload after the build.
        let stampedScheduleKind: "one_off" | "recurring" | undefined;
        if (callback === "autonomousMarketScreen") {
          const monetizationOn = await (
            await import("../../features/createFeatureFlagPort")
          ).createFeatureFlagPort(ctx.env).isEnabled("monetization");
          if (monetizationOn) {
            const claimedKind = (safePayload as Record<string, unknown>).scheduleKind;
            const claimedAuth = (safePayload as Record<string, unknown>).authorizedAtSubmission;
            if (
              claimedKind !== undefined &&
              claimedKind !== "one_off" &&
              claimedKind !== "recurring"
            ) {
              return Response.json(
                { success: false, error: `Invalid scheduleKind '${String(claimedKind)}': expected "one_off" or "recurring".` },
                { status: 400 },
              );
            }
            if (claimedKind === "one_off" && claimedAuth !== true) {
              return Response.json(
                { success: false, error: "A one-off stock schedule requires authorizedAtSubmission: a one-off run may not claim authorization never given." },
                { status: 400 },
              );
            }
            if (claimedKind === "one_off") {
              return Response.json(
                { success: false, error: "One-off checkout is unavailable for scheduled stock screens: the chain/monolithic run cannot ride the payment workflow. Run it manually via the paid screen seam or use a covered recurring schedule." },
                { status: 400 },
              );
            }
            stampedScheduleKind = (claimedKind as "recurring" | undefined) ?? "recurring";
            delete (safePayload as Record<string, unknown>).scheduleKind;
            delete (safePayload as Record<string, unknown>).authorizedAtSubmission;
          }
        }
        // Issue #959 (screening consolidation S1): criteria validation
        // and payload assembly live in ONE shared builder —
        // buildSchedulePayload in src/trading/screeningSchemas.ts —
        // used identically by this route, the trigger routes below, and
        // the NLQ scheduling executor, so the same criteria arm the same
        // payload through every door. The builder reproduces this
        // route's historical checks and error strings (universe,
        // symbols, the three discovery input models, maxItems) and
        // stamps identity from the trusted context only.
        let screeningPayload: unknown;
        if (ctx.accountScopedScheduleCallbacks.has(callback)) {
          // Issue #5100 (F3 of #5094): the schedule's account resolves
          // through the validated wrapper — an unbound creation is
          // refused with the coded failure, and a caller-supplied
          // accountId (captured above, before the identity strip) is
          // validated against the broker's enumerated accounts, never
          // accepted verbatim. The resolved tuple rides the identity
          // stamp below, so the schedule executes against exactly the
          // account stamped at creation.
          let resolvedScheduleBinding: ExecutionAccountContext | null = null;
          if (trustedUserLogin && createBrokerId && createMode) {
            const explicitAccountId = _untrustedAccountId;
            let availableAccounts: readonly BrokerAccount[] | undefined;
            if (explicitAccountId !== undefined && explicitAccountId !== null && `${explicitAccountId}`.trim() !== "") {
              // createBrokerId is server-resolved (tenant selection or
              // the legacy broker fallback), so this narrowing is
              // provably always true — a non-catalog id refuses
              // fail-closed rather than enumerating a guessed broker.
              if (!isBrokerId(createBrokerId)) {
                return Response.json(
                  { success: false, error: `Unknown broker "${createBrokerId}": the schedule was not created.` },
                  { status: 502 },
                );
              }
              try {
                availableAccounts = await TradingPlatformRegistry.getPlatform(
                  createBrokerId,
                  ctx.env,
                  ctx.getOrm(),
                  trustedUserLogin,
                  trustedEnvironment === "TEST" ? "TEST" : "PROD",
                ).getAccounts();
              } catch (enumErr) {
                return Response.json(
                  { success: false, error: `Could not enumerate ${createBrokerId} accounts to validate the requested account; the schedule was not created.` },
                  { status: 502 },
                );
              }
            }
            const bindingRes = await resolveValidatedExecutionAccountContext(ctx.env, trustedUserLogin, {
              broker: createBrokerId,
              mode: createMode,
              // Issue #5100 (F3 of #5094): the asset class defaults to
              // the callback's class (options analysis runs against
              // the options account); a body-supplied accountType is
              // an untrusted hint, validated by the wrapper. Issue
              // #6301: the default lives in the one home
              // (defaultAccountTypeForCallback), shared with the
              // fire-time guard and the blank-broker repair.
              accountType: _untrustedAccountType ?? defaultAccountTypeForCallback(callback),
              scope: "schedule",
              explicitAccountId,
              availableAccounts,
            });
            if (!bindingRes.ok) {
              return Response.json(
                { success: false, code: bindingRes.code, error: bindingRes.error },
                { status: bindingRes.status },
              );
            }
            resolvedScheduleBinding = bindingRes.context;
            ctx.audit?.("schedule.account_binding_resolved", "orchestrator", accountBindingAuditFields(resolvedScheduleBinding));
          }
          const built = buildSchedulePayload(callback, safePayload, {
            userLogin: trustedUserLogin || undefined,
            environment: trustedEnvironment || undefined,
            trigger: "scheduled",
            // Issue #3655: server-resolved broker + data provider +
            // mode ride the identity stamp (never a form value).
            ...(createBrokerId ? { brokerId: createBrokerId } : {}),
            ...(createDataProviderId ? { dataProviderId: createDataProviderId } : {}),
            ...(createMode ? { mode: createMode } : {}),
            // Issue #5100: the resolved binding tuple rides the same stamp.
            ...(resolvedScheduleBinding?.accountType
              ? { accountType: resolvedScheduleBinding.accountType }
              : {}),
            ...(resolvedScheduleBinding?.accountId
              ? { accountId: resolvedScheduleBinding.accountId }
              : {}),
          });
          if (!built.ok) {
            return Response.json({ success: false, error: built.error }, { status: 400 });
          }
          // Creation policy (route-level, unchanged): a stock schedule
          // must name its universe explicitly. The shared builder
          // deliberately does not require one — the trigger and NLQ
          // paths rely on the market-screen service's own default.
          if (callback === "autonomousMarketScreen" && safePayload.universe === undefined) {
            return Response.json({ success: false, error: "Stock schedules require one explicit universe." }, { status: 400 });
          }
          screeningPayload = built.value;
        } else {
          screeningPayload = payload;
        }
        // Issue #2373 (slice C): stamp the guard-validated
        // scheduleKind onto the stored payload (fail-closed
        // default "recurring" when the creator claimed none), so
        // the tick reads the same kind the guard approved. Flag
        // OFF (stampedScheduleKind undefined) leaves the payload
        // exactly as today.
        if (
          stampedScheduleKind !== undefined &&
          typeof screeningPayload === "object" &&
          screeningPayload !== null
        ) {
          (screeningPayload as Record<string, unknown>).scheduleKind = stampedScheduleKind;
        }
        // Issue #4235 — the recorded opt-in: a sub-daily schedule
        // created with the opt-in carries it on the stored payload,
        // so the unified record lifts it (screenScheduleToRecord)
        // and later updates read it back. Stamped only when the
        // cadence actually needs it — a daily schedule never
        // carries the flag.
        const needsOptIn =
          (scheduleType === "cron" && typeof cron === "string" && isSubDailyCron(cron.trim())) ||
          (scheduleType === "interval" && isSubDailyInterval(Number(intervalSeconds)));
        if (
          needsOptIn &&
          subDailyOptIn &&
          typeof screeningPayload === "object" &&
          screeningPayload !== null
        ) {
          (screeningPayload as Record<string, unknown>).subDailyOptIn = true;
        }

        // No fabricated success (#111): this route never invents a
        // schedule id or reports success for a schedule that does not
        // exist. Issue #6482 — paused by default: creation saves a
        // paused unified record and never arms the SDK, so nothing
        // can fire until an explicit resume re-arms it.
        // Issue #2071: creation is idempotent. A duplicate submit (double
        // click, retried request) returns the schedule that already exists
        // instead of creating a second identical one. A paused record
        // has no live alarm, so the duplicate check consults the
        // store as well as the live alarms — otherwise the second
        // submit would mint a second paused row for the same schedule.
        let duplicate: Schedule<unknown> | undefined;
        let duplicateRecord: ReturnType<typeof pausedScreenScheduleToRecord> | undefined;
        try {
          duplicate = findDuplicateSchedule(
            (await ctx.listSchedules()) as unknown as Record<string, any>[],
            callback,
            screeningPayload,
            { type: scheduleType, cron, intervalSeconds, delayInSeconds, date },
          ) as unknown as Schedule<unknown> | undefined;
          if (!duplicate) {
            const stored = (await unifiedStore().list())
              .filter((record) => record.kind === "screen")
              .map((record) => {
                const def = record.definition as Record<string, unknown>;
                return {
                  id: record.id,
                  callback: record.callback,
                  payload: def.payload,
                  type: def.type,
                  cron: def.cron,
                  intervalSeconds: def.intervalSeconds,
                  delayInSeconds: def.delayInSeconds,
                  time: def.time,
                };
              });
            const match = findDuplicateSchedule(
              stored,
              callback,
              screeningPayload,
              { type: scheduleType, cron, intervalSeconds, delayInSeconds, date },
            ) as unknown as { id: string } | undefined;
            if (match) duplicateRecord = await unifiedStore().get(match.id);
          }
        } catch {
          duplicate = undefined;
          duplicateRecord = undefined;
        }
        // Issue #3121 Phase 2 (#3123) — adoption: the armed alarm's
        // definition and state live in the unified store (record id =
        // the SDK alarm id; alarmId tracks the SDK-assigned id across
        // re-arms). Insert-if-absent: a record that already exists
        // (an idempotent re-arm, a duplicate) is never clobbered —
        // overwriting it would reset createdAt and the list order.
        // Best-effort: the alarm is armed either way — a failed
        // record write must not fail the creation, and the schedule
        // adopts a record when it is next touched.
        const adoptRecord = async (armed: Schedule<unknown>) => {
          try {
            const store = unifiedStore();
            if (!(await store.get(armed.id))) {
              await store.save(
                screenScheduleToRecord(
                  armed as unknown as ScheduleAlarmLike,
                  new Date().toISOString(),
                  trustedUserLogin || null,
                ),
              );
            }
          } catch {
            // Adoption failure is not a creation failure.
          }
        };
        if (duplicate) {
          await adoptRecord(duplicate);
          ctx.audit("schedule.duplicate_suppressed", "orchestrator", {
            scheduleId: (duplicate as any).id,
            callback,
            scheduleType,
          });
          return Response.json({ success: true, schedule: duplicate, duplicate: true });
        }
        if (duplicateRecord) {
          ctx.audit("schedule.duplicate_suppressed", "orchestrator", {
            scheduleId: duplicateRecord.id,
            callback,
            scheduleType,
          });
          return Response.json({
            success: true,
            schedule: duplicateRecord,
            duplicate: true,
            paused: duplicateRecord.state === "paused",
          });
        }

        // Issue #3121 S1 — creation provenance travels in the stored
        // payload (#2366 items 3–4): origin user, the trusted creator
        // identity (null when none was established — recorded
        // explicitly, never invented), creation time. Stamped AFTER
        // the duplicate check, so the fresh timestamp cannot defeat
        // dedup; a payload that already carries provenance keeps its
        // original creation record. The SDK-owned table schema is
        // untouched — the payload is the app's JSON blob on the row.
        screeningPayload = stampScheduleProvenance(
          screeningPayload,
          buildScheduleProvenance({
            origin: "user",
            createdBy: trustedUserLogin || null,
          }),
        );

        // Issue #6482 — paused by default: the schedule is created
        // as a paused unified record; the SDK is never armed here.
        // A missing timing is a 400 (the same honest shape as the
        // old invalid-parameters refusal), never a fabricated id.
        const nowIso = new Date().toISOString();
        let record: ReturnType<typeof pausedScreenScheduleToRecord> | undefined;
        if (scheduleType === "interval" && intervalSeconds) {
          record = pausedScreenScheduleToRecord(
            {
              callback,
              type: "interval",
              payload: screeningPayload,
              intervalSeconds: Number(intervalSeconds),
              ownerLogin: trustedUserLogin || null,
            },
            nowIso,
          );
        } else if (scheduleType === "cron" && cron) {
          record = pausedScreenScheduleToRecord(
            {
              callback,
              type: "cron",
              payload: screeningPayload,
              cron,
              // Issue #6482 — the idempotent opt-out rides the paused
              // record so resume arms with it (interval arms take no
              // options, so it is not recorded there).
              ...(typeof idempotent === "boolean" ? { idempotent } : {}),
              ownerLogin: trustedUserLogin || null,
            },
            nowIso,
          );
        } else if (scheduleType === "scheduled" && date) {
          record = pausedScreenScheduleToRecord(
            {
              callback,
              type: "scheduled",
              payload: screeningPayload,
              time: Math.floor(new Date(date).getTime() / 1000),
              ...(typeof idempotent === "boolean" ? { idempotent } : {}),
              ownerLogin: trustedUserLogin || null,
            },
            nowIso,
          );
        } else if (delayInSeconds !== undefined) {
          record = pausedScreenScheduleToRecord(
            {
              callback,
              type: "delayed",
              payload: screeningPayload,
              delayInSeconds: Number(delayInSeconds),
              ...(typeof idempotent === "boolean" ? { idempotent } : {}),
              ownerLogin: trustedUserLogin || null,
            },
            nowIso,
          );
        } else {
          return Response.json(
            { error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" },
            { status: 400 }
          );
        }

        // Issue #6503 step 9 (G2) — the create caller resolved
        // through the step-8 seam, so the audit names the resolved
        // login + level; then ONE chain record before the save —
        // a failed audit refuses with the coded 503 and creates
        // nothing. Placed after all validation above (a 400 or a
        // credential 409 consumes no chain record).
        const createCaller = await resolveScheduleControlCaller(request, ctx);
        const createAuditRefusal = await auditScheduleControlBeforeWrite(ctx, createCaller, "schedule.created", record.id);
        if (createAuditRefusal) return createAuditRefusal;
        await unifiedStore().save(record);
        // Issue #6503 — the start-paused control: when it is off, the
        // schedule starts active — resume (the one arming template)
        // arms it immediately. An arm refusal fails the create as a
        // whole (the activation removes the record), so the caller
        // never sees a paused schedule it did not ask for.
        let finalRecord = record;
        if (!resolveEffectiveScheduleStartPaused(ctx.agentCtx.storage.sql, ctx.env).paused) {
          const activated = await activateCreatedSchedule({ store: unifiedStore(), alarms }, record, nowIso);
          if (!activated.ok) {
            return Response.json({ success: false, error: activated.error }, { status: activated.status });
          }
          finalRecord = activated.record;
        }
        ctx.audit("schedule.created", "orchestrator", {
          scheduleId: finalRecord.id,
          callback,
          scheduleType,
          state: finalRecord.state,
          // The caller cannot be unauthenticated here (the 401s
          // above already returned), but the union still carries
          // the kind, so the login falls back to the trusted one.
          changedBy: createCaller.kind === "unauthenticated" ? trustedUserLogin : createCaller.login,
          callerLevel: createCaller.kind,
        });
        return Response.json({ success: true, schedule: finalRecord, paused: finalRecord.state === "paused" });
      } catch (err: any) {
        // A throwing store write created nothing, so it gets the
        // honest 503 {success:false, error} shape (#111), worded as what
        // it is — scheduling was unavailable and no schedule was created
        // — never a success response and never a fabricated id.
        return Response.json(
          { success: false, error: `Scheduling unavailable: ${err.message || "Failed to create schedule"}` },
          { status: 503 }
        );
      }
    }

    // Trigger autonomous market screen immediately on demand
    if (path.endsWith("/schedules/trigger-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || undefined;
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : undefined;
        // Issue #959: trigger bodies validate through the same shared
        // schedule builder as schedule creation — identity keys in the
        // body are stripped and re-stamped from the trusted context.
        const { userLogin: _bodyLogin, environment: _bodyEnv, ...triggerCriteria } = body ?? {};
        // Issue #5052: a Run-now dispatch stamps "triggered", never "manual".
        const built = buildSchedulePayload("autonomousMarketScreen", triggerCriteria, { userLogin, environment, trigger: "triggered" }, { applyCreationDefaults: false });
        if (!built.ok) {
          return Response.json({ success: false, error: built.error }, { status: 400 });
        }
        await ctx.autonomousMarketScreen(built.value);
        return Response.json({ success: true, message: "Autonomous market screen triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger market screen" }, { status: 500 });
      }
    }

    // Trigger E*TRADE token renewal immediately on demand
    if (path.endsWith("/schedules/trigger-renew") && request.method === "POST") {
      try {
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : context?.environment;
        await ctx.autoRenewETradeTokens({ userLogin, env: environment });
        return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger token renewal" }, { status: 500 });
      }
    }

    // Trigger autonomous options analysis immediately on demand
    if (path.endsWith("/schedules/trigger-options-analysis") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin || "";
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        const service = new ScheduledTasksService(ctx.env, ctx.getOrm(), userLogin, createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns, undefined, undefined, undefined, ctx.scheduleScreenerFollowups, { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env }, undefined, ctx.env.SCREENER_EVENTS ?? null);
        // Issue #959: validate through the shared schedule builder.
        const { userLogin: _bodyLogin, environment: _bodyEnv, ...triggerCriteria } = body ?? {};
        // Issue #5052: a Run-now dispatch stamps "triggered", never "manual".
        const built = buildSchedulePayload("autonomousOptionsAnalysis", triggerCriteria, { userLogin: userLogin || undefined, environment, trigger: "triggered" }, { applyCreationDefaults: false });
        if (!built.ok) {
          return Response.json({ success: false, error: built.error }, { status: 400 });
        }
        const result = await service.autonomousOptionsAnalysis(built.value as any);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger options analysis" }, { status: 500 });
      }
    }

    // Issue #3121 S5 — Worker cron dispatch ledger row. The named
    // entry points report their dispatch through this background-
    // gated route (see `handleCronDispatchRecordRoute`). Placed
    // adjacent to the trigger-retention branch: no earlier branch
    // can swallow it — the earlier POST branches match only
    // `/schedules/cancel`, `/schedules/cancel-all`, the
    // `/:id/pause|resume|trigger` suffixes, `/schedules/create`,
    // `/schedules` exactly, or the other `trigger-*` suffixes —
    // and the generic `/schedules/` branches above are GET, DELETE,
    // or PUT, never POST.
    if (path.endsWith("/schedules/record-cron-dispatch") && request.method === "POST") {
      return handleCronDispatchRecordRoute(request, {
        env: ctx.env,
        sql: ctx.agentCtx.storage.sql,
      });
    }

    // Nightly retention pass (issue #255, part of #143; extended to
    // mas_events + mas_memory by issue #786). The Worker's scheduled()
    // handler fires this at the 0 4 * * * cron.
    // Issue #1766 rides the same pass (same precedent as the #2294
    // job-outcomes leg): a best-effort orphan sweep over the
    // reports/ prefix and a best-effort R2 snapshot export of
    // this instance's tables. Both legs are best-effort — a
    // context without raw SQL or a bucket (tests, older
    // callers) or a leg failure must never fail the pass
    // itself — and both write their own mas_events audit rows
    // so the pass's work is observable, not just logged.
    // Fail-closed guards: the sweep deletes NOTHING unless
    // RETENTION_ORPHAN_SWEEP_DELETE is exactly "true", and a
    // referenced-keys read failure skips planning entirely
    // (an unknown referenced set must never read as "every
    // object is orphaned"). The sweep runs on the shared
    // Orchestrator instance only; per-user instances are
    // covered by PITR, not by this leg (recorded in the
    // #1766 doc, not papered over).
    if (path.endsWith("/schedules/trigger-retention") && request.method === "POST") {
      try {
        // #3156 (Q7): verify the mas_events tamper chain BEFORE any
        // pruning. A failed verification records a loud, blocking
        // alert and SKIPS the storage-retention prune this run —
        // pruning a broken chain would destroy the evidence the
        // review needs. If the alert write itself fails, the run
        // returns 503 rather than silently continuing (a
        // deliberate exception to this route's best-effort
        // philosophy for job-outcome pruning: tamper-evidence
        // handling is not best-effort). The orphan sweep, snapshot
        // export, and job-outcome prune do not touch mas_events
        // and still run. Retention windows themselves are
        // unchanged by this slice.
        // #2437: checkpointed verification — the nightly run reads only the
        // post-checkpoint window and persists the last-verified record
        // (position + outcome) in mas_settings, so its absence is itself
        // observable. A context without raw SQL (tests, older callers)
        // falls back to the #3156 full verify, which records no checkpoint.
        // #6102: both paths verify the live D1 chain now. The D1 port is
        // resolved first (a null port fails the run closed with 503 —
        // the frozen DO chain is never verified in production again);
        // a stored DO-chain checkpoint re-anchors from D1 genesis on
        // the first post-cutover run (see auditChainVerification).
        const auditEventsPort = await auditEventPort(
          ctx.env as unknown as { AGENT_DB?: unknown },
        );
        let auditChainVerification: TamperAlertResult | CheckpointedTamperAlertResult;
        try {
          if (!auditEventsPort) {
            throw new Error("audit chain verification: no audit event port (AGENT_DB unbound)");
          }
          const auditSql = ctx.agentCtx?.storage?.sql;
          auditChainVerification = auditSql
            ? await verifyStoredAuditChainAndAlertCheckpointedD1(
                auditEventsPort,
                settingReadFromSql(auditSql),
                settingWriteFromSql(auditSql),
              )
            : await verifyStoredAuditChainAndAlertD1(auditEventsPort);
        } catch (err) {
          structuredLog.error("schedules.retention_tamper_alert_write_failed", {
            message: "[retention] tamper alert write failed; retention aborted:",
            error: err instanceof Error ? err.message : String(err),
          });
          return Response.json(
            { error: "Audit chain verification alert could not be recorded; retention aborted." },
            { status: 503 },
          );
        }
        const auditChainPruneSkipped = !auditChainVerification.valid;
        if (auditChainPruneSkipped) {
          // #2437: the checkpointed result carries the persisted record;
          // the #3156 fallback does not. A type predicate (not an inline
          // `in` check) narrows the union for the compiler.
          const isCheckpointed = (
            r: TamperAlertResult | CheckpointedTamperAlertResult,
          ): r is CheckpointedTamperAlertResult => "checkpoint" in r;
          const brokenRowId = isCheckpointed(auditChainVerification)
            ? auditChainVerification.checkpoint.brokenRowId
            : null;
          structuredLog.error("schedules.retention_audit_chain_verification_failed", {
            message: `[retention] audit chain verification FAILED brokenIndex=${auditChainVerification.brokenIndex} brokenRowId=${brokenRowId ?? "n/a"} reason=${auditChainVerification.reason}; storage-retention prune skipped, evidence preserved.`,
            brokenIndex: auditChainVerification.brokenIndex,
            brokenRowId,
            reason: auditChainVerification.reason,
          });
        }
        // #6102: the retention pass's summary row and D1 events prune
        // run through the one resolved D1 audit-events port above. A null
        // port fails the pass closed at the summary write (the route's
        // catch returns 500) instead of silently writing to DO.
        const result = auditChainPruneSkipped
          ? { skipped: true, pruned: 0 }
          : await runStorageRetention(ctx.getOrm(), {
              retentionDays: ctx.env.MAS_MESSAGES_RETENTION_DAYS,
              eventsRetentionDays: ctx.env.MAS_EVENTS_RETENTION_DAYS,
              memoryRetentionDays: ctx.env.MAS_MEMORY_RETENTION_DAYS,
              writeAuditEvent: async (record) => {
                if (!auditEventsPort) {
                  throw new Error("runStorageRetention: no audit event port (AGENT_DB unbound)");
                }
                await auditEventsPort.create(record);
              },
              auditEvents: auditEventsPort,
            });
        // #5043 (G-4): run the D1 audit-chain prune in the same nightly
        // retention pass when DO chain verification succeeded. Fails closed
        // when audit_policy.retentionDays is unset (skipped: true, pruned: 0).
        const d1AuditChainPrune: {
          tenantId: string | null;
          pruned: number;
          capped: boolean;
          skipped: boolean;
          skippedReason: string | null;
          error: string | null;
        } = {
          tenantId: null,
          pruned: 0,
          capped: false,
          skipped: true,
          skippedReason: null,
          error: null,
        };
        if (auditChainPruneSkipped) {
          d1AuditChainPrune.skippedReason = "DO audit chain verification failed; evidence preserved";
        } else {
          try {
            const auditPolicyPort = createAuditPolicyAdapter(ctx.env);
            if (!auditPolicyPort) {
              d1AuditChainPrune.skippedReason = "AGENT_DB is not bound";
            } else {
              const tenantId = resolveIaaaTenant(ctx.env);
              const report = await pruneAuditChainForTenant(auditPolicyPort, tenantId);
              d1AuditChainPrune.tenantId = report.tenantId;
              d1AuditChainPrune.pruned = report.pruned;
              d1AuditChainPrune.capped = report.capped;
              d1AuditChainPrune.skipped = report.skipped;
              if (report.skipped) {
                d1AuditChainPrune.skippedReason = "no retentionDays configured in audit_policy";
              }
            }
          } catch (err) {
            d1AuditChainPrune.error = err instanceof Error ? err.message : String(err);
            structuredLog.warn("schedules.retention_d1_audit_chain_prune_failed", {
              message: "[retention] D1 audit chain prune failed:",
              error: d1AuditChainPrune.error,
            });
          }
        }
        // #2294: the outcome feed had no retention decision at all. Bound it
        // in the same nightly pass so history cannot grow into the read path.
        // Best-effort: a context without raw SQL (tests, older callers) or a
        // prune failure must never fail the retention pass itself.
        let jobOutcomes = { deletedByAge: 0, deletedByCap: 0, error: null as string | null };
        try {
          const sql = ctx.agentCtx.storage.sql;
          const pruned = pruneJobOutcomes(sql, {
            retentionDays: ctx.env.MAS_JOB_OUTCOMES_RETENTION_DAYS,
          });
          jobOutcomes = { ...pruned, error: null };
        } catch (err) {
          jobOutcomes.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_job_outcomes_prune_failed", {
            message: "[retention] job outcomes prune failed:",
            error: jobOutcomes.error,
          });
        }
        // #6102: the leg rows write to D1 now, through the resolved
        // port above. Best-effort as before: a missing port or a
        // failed write is swallowed — the response fields below are
        // the operator-visible record.
        const auditEvent = async (type: string, payload: Record<string, unknown>) => {
          try {
            if (!auditEventsPort) return;
            await auditEventsPort.create({
              id: `retention_${crypto.randomUUID().slice(0, 8)}`,
              sessionId: "system",
              type,
              agent: "orchestrator",
              payload,
              createdAt: new Date().toISOString(),
            });
          } catch {
            // Audit persistence is best-effort here; the response
            // fields below are the operator-visible record.
          }
        };
        // #5160 — IDP profile retention: purge profile rows whose
        // identity has no live membership and whose last IDP refresh
        // predates the configured retention window. Best-effort,
        // same as the job-outcomes leg: a missing store, an
        // unbound AGENT_DB, or a prune failure never fails the
        // retention pass itself. retentionDays 0 (the shipped
        // default) = retain while the identity exists — the cutoff
        // is the epoch, so nothing is expired. The config reads
        // from this instance's own mas_settings (the retention job
        // runs IN the orchestrator, so the SettingsPort is local
        // here — the worker-side sign-in path has no such port).
        const idpProfilePrune = {
          deleted: 0,
          skipped: null as string | null,
          error: null as string | null,
        };
        try {
          const profileStore = createProfileAdapter(ctx.env);
          if (!profileStore) {
            idpProfilePrune.skipped = "AGENT_DB is not bound";
          } else {
            const settings = createOrmPorts(ctx.agentCtx.storage.sql).settings;
            const config = loadIdpProfileConfig(settings);
            if (config.retentionDays <= 0) {
              idpProfilePrune.skipped = "retentionDays is 0 (retain while the identity exists)";
            } else {
              const membershipStore = createKvMembershipStore(sessionStore(ctx.env));
              const nowMs = Date.now();
              const pruned = await profileStore.purgeExpiredProfiles({
                cutoffMs: nowMs - config.retentionDays * 86_400_000,
                hasLiveMembership: async (internalUserId, tenantId) => {
                  const memberships = await membershipStore.getMembershipsByUser(internalUserId);
                  return memberships.some(
                    (m) =>
                      m.tenantId === tenantId &&
                      m.revokedAtMs === undefined &&
                      m.roleBindings.some(
                        (b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs,
                      ),
                  );
                },
              });
              idpProfilePrune.deleted = pruned.deleted;
              await auditEvent("RETENTION_IDP_PROFILE_PRUNE", {
                deleted: pruned.deleted,
                retentionDays: config.retentionDays,
                note: "Nightly IDP profile retention (#5160): expired profile rows for identities with no live membership.",
              });
            }
          }
        } catch (err) {
          idpProfilePrune.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_idp_profile_prune_failed", {
            message: "[retention] IDP profile prune failed:",
            error: idpProfilePrune.error,
          });
        }
        // #1766 leg 1 — orphan sweep (reports/*.json vs mas_reports.body_r2_key).
        const orphanSweep = {
          scanned: 0,
          orphans: 0,
          danglingRows: 0,
          deleted: 0,
          deleteFailed: 0,
          deleteEnabled: false,
          truncated: false,
          error: null as string | null,
          skipped: null as string | null,
        };
        try {
          // Issue #1777 (Adapter S3): the sweep lists/deletes through
          // the one BlobStore port; the skipped message is unchanged.
          const store = createBlobStore(ctx.env);
          if (!store) {
            orphanSweep.skipped = "REPORTS_BUCKET is not bound";
          } else {
            const sql = ctx.agentCtx.storage.sql as {
              exec: (q: string, ...params: unknown[]) => Iterable<unknown>;
            };
            const bucketKeys: string[] = [];
            let cursor: string | undefined;
            let pageTruncated = false;
            do {
              const page = await store.list({ prefix: ORPHAN_SWEEP_PREFIX, cursor, limit: 1000 });
              for (const key of page.keys) bucketKeys.push(key);
              pageTruncated = page.truncated;
              cursor = page.truncated ? page.cursor : undefined;
              if (bucketKeys.length >= 5000) {
                pageTruncated = true;
                break;
              }
            } while (pageTruncated && cursor);
            orphanSweep.truncated = pageTruncated;
            let referencedKeys: string[] | null = null;
            try {
              const rows = Array.from(
                sql.exec("SELECT body_r2_key FROM mas_reports WHERE body_r2_key IS NOT NULL"),
              ) as Array<{ body_r2_key?: unknown }>;
              referencedKeys = rows
                .map((r) => r.body_r2_key)
                .filter((k): k is string => typeof k === "string");
            } catch (err) {
              // Fail closed: without the referenced set, every object
              // would read as orphaned — so plan nothing at all.
              orphanSweep.error = `referenced-keys read failed: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (referencedKeys !== null) {
              const plan = planOrphanSweep({ bucketKeys, referencedKeys });
              orphanSweep.scanned = plan.scanned;
              orphanSweep.orphans = plan.orphans.length;
              orphanSweep.danglingRows = plan.danglingRows.length;
              orphanSweep.deleteEnabled = resolveOrphanSweepDelete(
                ctx.env?.RETENTION_ORPHAN_SWEEP_DELETE,
              );
              if (orphanSweep.deleteEnabled) {
                for (const key of plan.orphans) {
                  try {
                    await store.delete(key);
                    orphanSweep.deleted += 1;
                  } catch {
                    orphanSweep.deleteFailed += 1;
                  }
                }
              }
              await auditEvent("RETENTION_ORPHAN_SWEEP", {
                scanned: orphanSweep.scanned,
                orphans: orphanSweep.orphans,
                danglingRows: orphanSweep.danglingRows,
                deleted: orphanSweep.deleted,
                deleteFailed: orphanSweep.deleteFailed,
                deleteEnabled: orphanSweep.deleteEnabled,
                truncated: orphanSweep.truncated,
                note: "Nightly orphan sweep (#1766): reports/*.json objects with no mas_reports row; dangling rows are reported, never deleted.",
              });
            }
          }
        } catch (err) {
          orphanSweep.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_orphan_sweep_failed", {
            message: "[retention] orphan sweep failed:",
            error: orphanSweep.error,
          });
        }
        // #1766 leg 2 — R2 snapshot export of this instance's tables.
        const snapshot = {
          tables: 0,
          rows: 0,
          truncatedTables: [] as string[],
          key: null as string | null,
          error: null as string | null,
          skipped: null as string | null,
        };
        try {
          if (!resolveSnapshotEnabled(ctx.env?.RETENTION_SNAPSHOT_ENABLED)) {
            snapshot.skipped = "disabled by RETENTION_SNAPSHOT_ENABLED=false";
          } else {
            const store = createBlobStore(ctx.env);
            if (!store) {
              snapshot.skipped = "REPORTS_BUCKET is not bound";
            } else {
              const sql = ctx.agentCtx.storage.sql as {
                exec: (q: string, ...params: unknown[]) => Iterable<unknown>;
              };
              const tableRows = Array.from(
                sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"),
              ) as Array<{ name?: unknown }>;
              const tables: Array<{ table: string; rows: unknown[] }> = [];
              for (const t of tableRows) {
                if (typeof t.name !== "string" || !/^[A-Za-z0-9_]+$/.test(t.name)) continue;
                const rows = Array.from(sql.exec(`SELECT * FROM "${t.name}" LIMIT 5001`));
                tables.push({ table: t.name, rows });
              }
              const manifest = await buildSnapshotManifest({
                instance: "orchestrator",
                exportedAt: Date.now(),
                tables,
                rowLimit: SNAPSHOT_ROW_LIMIT,
              });
              const key = snapshotObjectKey("orchestrator", manifest.exportedAt);
              await store.put(key, JSON.stringify(manifest), {
                contentType: "application/json",
              });
              snapshot.tables = manifest.tables.length;
              snapshot.rows = manifest.tables.reduce((sum, t) => sum + t.rowCount, 0);
              snapshot.truncatedTables = manifest.tables
                .filter((t) => t.truncated)
                .map((t) => t.table);
              snapshot.key = key;
              await auditEvent("RETENTION_SNAPSHOT", {
                tables: snapshot.tables,
                rows: snapshot.rows,
                truncatedTables: snapshot.truncatedTables,
                key,
                manifestSha256: manifest.manifestSha256,
                note: "Nightly R2 snapshot export (#1766): portable per-table dump complementing Cloudflare PITR (30-day whole-DB restore); truncated tables are flagged, never silently partial.",
              });
            }
          }
        } catch (err) {
          snapshot.error = err instanceof Error ? err.message : String(err);
          structuredLog.warn("schedules.retention_snapshot_export_failed", {
            message: "[retention] snapshot export failed:",
            error: snapshot.error,
          });
        }
        return Response.json({
          success: true,
          ...result,
          auditChainVerification,
          auditChainPruneSkipped,
          d1AuditChainPrune,
          jobOutcomesPruned: jobOutcomes.deletedByAge + jobOutcomes.deletedByCap,
          jobOutcomesByAge: jobOutcomes.deletedByAge,
          jobOutcomesByCap: jobOutcomes.deletedByCap,
          jobOutcomesError: jobOutcomes.error,
          idpProfilePrune,
          orphanSweep,
          snapshot,
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run storage retention" }, { status: 500 });
      }
    }

    // Trigger the daily IV history collection immediately on demand
    // (issue #15) — same per-name outcomes the scheduled run produces;
    // idempotent per (symbol, day), so a manual rerun is safe.
    if (path.endsWith("/schedules/trigger-iv-collection") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD" ? rawEnvironment : context?.environment;
        // Issue #2337 cutover (R-2): the on-demand trigger
        // collects through the env-aware build's IV store —
        // D1 when AGENT_DB is bound — the same store the
        // scheduled collector and the read paths use.
        const service = new ScheduledTasksService(
          ctx.env,
          ctx.getOrm(),
          userLogin,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns,
          (await buildOptionsDiscoveryPorts(ctx.env, { sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage })).ivHistory,
          undefined,
          undefined,
          ctx.scheduleScreenerFollowups, undefined, undefined, ctx.env.SCREENER_EVENTS ?? null
        );
        const result = await service.collectDailyIvHistory({ ...body, userLogin, environment });
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger IV collection" }, { status: 500 });
      }
    }

    // Trigger scheduled strategy discovery immediately on demand
    // (issue #126) — re-runs the body's SAVED StrategyRequests verbatim
    // through the discovery pipeline and persists the run as a
    // "manual-trigger" discovery run. An account identity is required:
    // runs are per-user records and execute under the owner's E*TRADE
    // session (mirrors trigger-iv-collection's 401). Issue #533: a body
    // carrying inputModel "profile-derived" (+ profileId and symbols
    // or watchlistName) flows through the same call — the service
    // branches on the discriminator — and abstentions ride back in the
    // result data alongside failures. Issue #534: a body carrying
    // inputModel "no-view" (+ constraintSets) flows through the same
    // call the same way.
    if (path.endsWith("/schedules/trigger-discovery") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        // Issue #1661: platformDeps threads the DO storage handle so
        // trigger-discovery listings fetch live + capture (behavior change
        // from the missing-seam throw — disclosed, Q3).
        const service = new ScheduledTasksService(
          ctx.env,
          ctx.getOrm(),
          userLogin,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).scanRuns,
          undefined,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).discoveryRuns,
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).strategyProfiles,
          ctx.scheduleScreenerFollowups,
          { sql: ctx.agentCtx.storage.sql, blobStorage: ctx.agentCtx.storage, env: ctx.env },
          createOptionsDiscoveryPorts({ sql: ctx.agentCtx.storage.sql, storage: ctx.agentCtx.storage }).feedSnapshots, ctx.env.SCREENER_EVENTS ?? null,
          // Issue #4275: the firer's engine run record is durable
          // in the host DO (runStockScreenViaEngine seam: none).
          undefined, ctx.agentCtx.storage.sql
        );
        // Issue #959: validate through the shared schedule builder
        // (the service's own derivation validation still runs inside).
        const { userLogin: _bodyLogin, environment: _bodyEnv, ...triggerCriteria } = body ?? {};
        // Issue #5052: a Run-now dispatch stamps "triggered", never "manual".
        const built = buildSchedulePayload("autonomousStrategyDiscovery", triggerCriteria, { userLogin, environment, trigger: "triggered" }, { applyCreationDefaults: false });
        if (!built.ok) {
          return Response.json({ success: false, error: built.error }, { status: 400 });
        }
        const result = await service.autonomousStrategyDiscovery(built.value as any);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger strategy discovery" }, { status: 500 });
      }
    }

    // Submit the feed stage (consolidation #1236): produce + store
    // one snapshot artifact per symbol as a feed.snapshot async job
    // (stage "feed", retryable, status-visible). With chainTo, the
    // job mints a chain id and its completion plans the generate
    // stage (see the feed completion hook); without it, the job is
    // a standalone refresh. When chainTo is present the feed symbols
    // + filters are DERIVED from its requests, so generate-time
    // filter matching holds by construction; a body.symbols that
    // disagrees with chainTo.requests is rejected rather than
    // silently ignored.
    if (path.endsWith("/schedules/feed-snapshot") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const context = await ctx.getScreenerExecutionContext();
        const userLogin = request.headers.get("x-user-login") || context?.userLogin;
        if (!userLogin) return Response.json({ success: false, error: "An authenticated broker account is required." }, { status: 401 });
        const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
        const environment = rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : context?.environment;
        if (!ctx.submitAsyncJob) return Response.json({ success: false, error: "Feed submission is not wired on this host." }, { status: 500 });
        const tickerRe = /^[A-Z0-9./-]{1,16}$/i;
        const chainTo = body?.chainTo;
        let feedSymbols: Array<{ symbol: string; loadParams?: Record<string, unknown> }> | undefined;
        let chainRequests: Array<Record<string, unknown>> | undefined;
        if (chainTo !== undefined) {
          if (chainTo === null || typeof chainTo !== "object" || !Array.isArray(chainTo.requests) || chainTo.requests.length === 0) {
            return Response.json({ success: false, error: "chainTo.requests must be a non-empty array." }, { status: 400 });
          }
          for (const key of ["emailTo", "slackChannel", "webhookUrl"] as const) {
            if (chainTo[key] !== undefined && typeof chainTo[key] !== "string") {
              return Response.json({ success: false, error: `chainTo.${key} must be a string.` }, { status: 400 });
            }
          }
          chainRequests = [];
          feedSymbols = [];
          for (const req of chainTo.requests) {
            const invalid = validateStrategyRequest(req);
            if (invalid) {
              return Response.json({ success: false, error: `chainTo request is invalid: ${invalid}` }, { status: 400 });
            }
            const symbol = String((req as { symbol: string }).symbol).toUpperCase().trim();
            chainRequests.push(req);
            feedSymbols.push({ symbol, loadParams: pickFeedLoadParams(req) as Record<string, unknown> });
          }
          if (body?.symbols !== undefined) {
            const bodySymbols = Array.isArray(body.symbols) ? body.symbols.map((s: unknown) => String(s).toUpperCase().trim()) : null;
            const derived = feedSymbols.map((s) => s.symbol);
            if (!bodySymbols || bodySymbols.length !== derived.length || bodySymbols.some((s: string, i: number) => s !== derived[i])) {
              return Response.json({ success: false, error: "symbols must match chainTo.requests symbols." }, { status: 400 });
            }
          }
        } else {
          if (!Array.isArray(body?.symbols) || body.symbols.length === 0) {
            return Response.json({ success: false, error: "symbols must be a non-empty array, or chainTo.requests must name the feed." }, { status: 400 });
          }
          for (const s of body.symbols) {
            if (typeof s !== "string" || !tickerRe.test(s.trim())) {
              return Response.json({ success: false, error: `symbols must be valid ticker strings; got '${String(s)}'.` }, { status: 400 });
            }
          }
          feedSymbols = body.symbols.map((s: string) => ({ symbol: s.toUpperCase().trim() }));
        }
        const chainId = chainTo !== undefined ? crypto.randomUUID() : undefined;
        const submitted = await ctx.submitAsyncJob({
          capability: "feed.snapshot",
          payload: {
            userLogin,
            ...(environment ? { environment } : {}),
            symbols: feedSymbols,
            ...(chainTo
              ? {
                  chainTo: {
                    requests: chainRequests,
                    ...(typeof chainTo.emailTo === "string" ? { emailTo: chainTo.emailTo } : {}),
                    ...(typeof chainTo.slackChannel === "string" ? { slackChannel: chainTo.slackChannel } : {}),
                    ...(typeof chainTo.webhookUrl === "string" ? { webhookUrl: chainTo.webhookUrl } : {}),
                  },
                }
              : {}),
          },
          stage: "feed",
          ...(chainId ? { chainId } : {}),
        } as import("../../types").AsyncJobSubmission);
        return Response.json({ ...submitted, stage: "feed", ...(chainId ? { chainId } : {}) });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to submit feed snapshot" }, { status: 500 });
      }
    }
  return null;
}
