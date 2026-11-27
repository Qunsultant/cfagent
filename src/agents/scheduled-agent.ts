import { PortThink } from "../actors/thinkAdapter";
import type {
  ThinkStepContext,
  ThinkTurnContext,
  ThinkTurnConfig,
} from "../actors/thinkAdapter";
import { createAgentScheduleManagementTool } from "./mcpAdapter";
import { AGENTIC_SPEND_AGENT_ID } from "../payments/ledger";
import { actorGateway } from "../services/cloudflareActorGateway";
import {
  dispatchScheduledA2A,
  scheduledA2AOutcome,
  type ScheduledA2AOutcome,
} from "./scheduledA2aDispatch";
import type { Env } from "../types";
import type { DoStubLike } from "../data/durableKv";
import type { CompiledChain, CompiledChainStep } from "../orchestrate";
import type { ChainRunResult } from "../mcps/openaimp/goalChainCommands";
import {
  approveSynthesizedInList,
  markSynthesizedFired,
  SYNTHESIZED_SCHEDULES_KEY,
  synthesizeSchedule as synthesizeChainSchedule,
  type SynthesizedSchedule,
} from "../agentic/jobSynthesis";
import {
  isGovernedHalted,
  killSynthesizedInList,
} from "../agentic/chainGovernance";
import {
  auditBlockedChainFiring,
  auditSuccessfulChainFiring,
  CHAIN_EXECUTE_OPERATION,
  decideChainFiring,
  materializeSynthesizedRecord,
} from "../agentic/chainFiring";
import {
  executeOpportunityHunt,
  OPPORTUNITY_HUNT_OPERATION,
  type OpportunityHuntResult,
} from "../services/opportunityHunt";
import {
  readPersistedTechnicalsBars,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
} from "../services/feedJobs";

import {
  type ScheduledGoal,
  type ScheduleTick,
} from "../schedule";
import {
  getBuiltinScheduledGoals,
  isBuiltinScheduledGoalId,
} from "../config/builtinScheduledGoals";
import {
  buildJobRunRecord,
  normalizeJobRunRecord,
  type JobRunRecord,
} from "../services/jobRunRecords";
import { newRunId } from "../services/executionTreeIds";
import {
  GOAL_RUN_JOB_RUN_RECORD_CAP_ENV_VAR,
  GOAL_RUN_TICK_HISTORY_CAP_ENV_VAR,
  resolveGoalRunJobRunRecordCap,
  resolveGoalRunTickHistoryCap,
} from "../config/goalRunRetention";
import { resolveMissedScheduleGraceMs } from "../config/missedScheduleAlert";
import { HEARTBEAT_ALARM_CALLBACK } from "../config/heartbeatWatchdog";
import {
  findMissedGoalFiring,
  missedFiringDetail,
  SCHEDULE_WATCHDOG_FIRST_SEEN_KEY,
  SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
} from "../services/scheduleWatchdog";
import {
  nameLedgerWriteFailure,
  type ScheduleCallbackRecordFailure,
} from "./orchestrator/scheduleCallbackRunRecords";
import { renderChannelText } from "../outcomes/outcomeAspects";
// Issue #3121 S3 — the tick-evaluated kind evaluates through the S1
// shared primitives: `isDue` / `isValidCron` / `zonedDateParts` are
// the S1 module's verbatim re-exports of src/schedule.ts (one
// implementation, never reimplemented); the ledger linkage, the goal
// lifecycle audit events, and the provenance helpers are the same
// module's. src/schedule.ts stays the source of truth.
import {
  buildGoalScheduleAuditEvent,
  buildLedgerLinkage,
  isDue,
  isSubDailyCron,
  isValidCron,
  postGoalScheduleAuditEvent,
  provenanceFromPayload,
  systemProvenance,
  zonedDateParts,
  type GoalScheduleAuditEvent,
} from "../services/consolidatedScheduling";
import { SHARED_ORCHESTRATOR_INSTANCE, getServiceUserLogin } from "../security/serviceIdentity";
import { isPlatformServiceProvisioned } from "../security/serviceDispatch";
import { sessionStore } from "../security/session";
import { createKvMembershipStore } from "../security/iaaaMembershipStore";
import { armHeartbeatAlarm, isHeartbeatAlarmTick } from "../services/heartbeatClock";
import { dispatchTickRiders } from "../services/tickRiders";
import {
  runAutopilotMonthlyEvaluation,
  type AutopilotMonthlyEvaluationResult,
} from "../services/autopilotMonthlyEvaluation";
import { createD1UnifiedSchedulePorts } from "../data/createUnifiedSchedulePorts";
import type {
  ScheduleStore,
  UnifiedScheduleRecord,
} from "../data/unifiedSchedulePorts";
import { goalToRecord, isUnchangedGoalRecord, recordToGoal } from "../services/unifiedScheduleManagement";
import {
  fetchLedgerRuns,
  mergeLedgerRuns,
  postLedgerRun,
} from "../services/unifiedLedger";
import {
  createAgentSchedulePdpDeps,
  decidePendingScheduleApproval,
  evaluateAgentSchedulePdp,
  executeAgentScheduleAction,
  resolvePendingScheduleApproval,
  type AgentGoalScheduleAdapter,
  type AgentScheduleLoopOrigin,
  type AgentScheduleActionResult,
  type AgentScheduleExecutorDeps,
  type PendingScheduleApproval,
} from "../services/agentScheduleCapability";
import {
  type AgentScheduleLoopSettings,
  type AgentScheduleLoopSettingsResolution,
} from "../services/agentScheduleLoopSettings";
import { resolveIaaaTenant } from "../security/iaaaGithubEndToEnd";
import {
  DEPLOYMENT_DEFAULT_TENANT_ID,
  DEPLOYMENT_DEFAULT_WORKSPACE_ID,
} from "../config/tenantDefaults";
import { resolveEnvironmentConfig } from "../config/environment";
import { createSocialStoresFromNamespace } from "./social/durableStores";
// Issue #3543 (Pipeline J1 host wiring, consumed by J2 #3535): the
// job pipeline's host wiring — declarations, control-plane
// construction, dispatch, and the workflow start path live in
// ./scheduledTasksPipeline.ts (the scheduledTasksCopilot.ts
// pattern transposed); the RPC surface below delegates to it.
import {
  buildScheduledAgentChainSurfaceView,
  createScheduledAgentPipelineControl,
  createScheduledAgentStageEventStore,
  declarePipelineTasks,
  dispatchFeedJobWorkflow,
  dispatchAnalyzeAfterEnrichCompletion,
  dispatchDeliverAfterGenerateCompletion,
  dispatchEnrichAfterFeedCompletion,
  dispatchGenerateAfterAnalyzeCompletion,
  ensureScheduledAgentPipelineJobs,
  listPipelineCompletions,
  pipelineAnalyzeJobIds,
  pipelineChainJobIds,
  pipelineChainStageNodePath,
  pipelineDeliverJobIds,
  pipelineEnrichJobIds,
  pipelineGenerateJobIds,
  pipelineJobIds,
  recordPipelineCompletion,
  refreshScheduledAgentChainDefinition,
  settleOrphanedPipelineRuns,
  startPipelineJobWorkflow,
  type PipelineChainSurfaceView,
  type PipelineCompletionNote,
  type ScheduledTasksPipelineContext,
} from "./scheduledTasksPipeline";
import {
  dispatchCompletionSchedules,
  type CompletionFiringResult,
} from "./scheduledTasksCompletion";
import type { CompletionEvent } from "../services/completionTrigger";
import type { ThinkScheduledTasks } from "../actors/thinkAdapter";
import type {
  JobInstanceRecord,
  JobDefinition,
  JobRunProvenance,
} from "../data/jobPipelinePorts";
import type { JobStagesRead, JobStatusView } from "../services/jobPipelineEngine";
import { resolveRunNowTrigger } from "../services/jobPipelineEngine";
import type { JobRunTrigger } from "../data/jobRunRecordPorts";
import { normalizeJobRunTrigger } from "../data/jobRunRecordPorts";
import { buildJobStatusReport, resolveSubJob } from "../services/jobStageStatus";
import { isJobStageId, jobStageNodePath } from "../workflows/stageRunnerPorts";
import type { JobStageEventRecord } from "../data/jobStageEventPorts";
import { resolveWorkflowRunsStageReadLimit } from "../config/workflowRunsStageRead";
import { assertExecutionModeSupported, resolveExecutionMode } from "../services/jobPipelineConfig";
import { addressableStages, jobDefinitionSpec } from "../config/jobDefinitionCatalog";
import { buildJobConfigFromSpec } from "../services/jobDefinitionSpecBuilder";
import { buildFeedRunInputDefinition } from "../services/runInputCarrier";
import { bindJobDefinitionParams, bindStageOverrides } from "../services/jobDefinitionParamBinders";
import { buildFeedJobRegistry } from "../services/feedJobs";
import { FEED_JOB_CODES } from "../services/feedJobCodes";
import {
  FeedJobTimeoutError,
  resolveFeedJobTimeouts,
  withFeedDeadline,
} from "../services/feedJobTimeouts";
import {
  buildFeedJobSurfaceView,
  FEED_PIPELINE_CATALOG,
  type FeedJobSurfaceView,
} from "../services/feedPipelineJobs";
import { createFeedDatasetAdapter } from "../data/createFeedDatasetPorts";
// Issue #3536 (Pipeline J3): the enrich jobs' surface on this
// host — the merged status view's composition pieces (the RPCs
// below delegate to the same ONE control plane; no second
// implementation of any pipeline operation exists here).
import { buildEnrichJobRegistry } from "../services/enrichJobs";
import {
  buildEnrichJobSurfaceView,
  ENRICH_PIPELINE_CATALOG,
  type EnrichJobSurfaceView,
} from "../services/enrichPipelineJobs";
import { createEnrichedDatasetAdapter } from "../data/createEnrichedDatasetPorts";
// Issue #3537 (Pipeline J4): the analyze jobs' surface on this
// host — the merged status view's composition pieces (the RPCs
// below delegate to the same ONE control plane).
import { buildAnalyzeJobRegistry } from "../services/analyzeJobs";
import {
  buildAnalyzeJobSurfaceView,
  ANALYZE_PIPELINE_CATALOG,
  type AnalyzeJobSurfaceView,
} from "../services/analyzePipelineJobs";
import { createAnalyzedDatasetPorts } from "../data/createAnalyzedDatasetPorts";
// Issue #3538 (Pipeline J5): the generate jobs' surface on this
// host — the merged status view's composition pieces (the RPCs
// below delegate to the same ONE control plane).
import { buildGenerateJobRegistry } from "../services/generateJobs";
import {
  buildGenerateJobSurfaceView,
  GENERATE_PIPELINE_CATALOG,
  type GenerateJobSurfaceView,
} from "../services/generatePipelineJobs";
import { createGeneratedDatasetPorts } from "../data/createGeneratedDatasetPorts";
// Issue #3539 (Pipeline J6): the deliver jobs' surface on this
// host — the merged status view's composition pieces (the RPCs
// below delegate to the same ONE control plane).
import { buildDeliverJobRegistry } from "../services/deliverJobs";
import {
  buildDeliverJobSurfaceView,
  DELIVER_PIPELINE_CATALOG,
  type DeliverJobSurfaceView,
} from "../services/deliverPipelineJobs";
import { createDeliveryDatasetPorts } from "../data/createDeliveryDatasetPorts";
import { createSocialBriefStoreFromNamespace } from "./social/briefStore";
import {
  createSocialPipelineStoresFromNamespace,
  runSocialDailyPipeline,
  SOCIAL_DAILY_PIPELINE_ID,
} from "./social/pipeline";
import { executeSocialGoal, priorDates } from "./social/goalExecutor";
import { buildSocialEnv } from "./social/config";
import {
  postSlackText,
  runResourceCapAlert,
  runResourceComparison,
  runResourceRollup,
} from "./resourceGoals";
import { createOtelMetrics } from "../observability/otelMetricsProvider";
import { createD1ResourceDb } from "../data/d1ResourceUsageAdapter";
import {
  deliverPendingApprovals,
  fetchSlackPost,
  type SlackPostFn,
} from "./social/delivery";
import {
  createMemoryDryRunSink,
  type DryRunSink,
  type SocialTransport,
} from "./social/publisher";
import { createFetchSocialTransport } from "./social/liveTransport";
import type { DoNamespaceLike } from "../data/durableKv";
import { readAgentDbHalt } from "../data/createGovernancePorts";
import type { HaltReader } from "../data/governancePorts";
import {
  createChainScheduleAdapter,
  projectAfterTransition,
} from "../data/createChainSchedulePorts";
import {
  reconcileChainSchedules,
  type ChainScheduleTransition,
  type ReconcileReport,
} from "../data/chainScheduleProjection";
import { ensureChainScheduleSchema } from "../data/d1ChainScheduleAdapter";
import { projectRunLegs } from "../data/createShardJobPorts";
import { recordAuditEventBestEffort } from "../data/createAuditReportPorts";
import {
  claimGoalFiring,
  goalFiringKey,
  releaseGoalFiring,
  type GoalFiringMarker,
} from "../services/goalFiringClaims";
import type {
  IndexListJobResult,
  IndexRefreshOperation,
} from "../services/indexListJob";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/scheduled-agent",
});

/**
 * Resolve a halt read for the firing path, failing closed: any
 * reader error reports halted. The adapter's own `isHalted`
 * already fails closed; this covers injected readers too, so no
 * failure mode on this path reads as clear.
 */
async function resolveReaderHalt(
  reader: HaltReader,
  tenantId: string,
): Promise<boolean> {
  try {
    return await reader.isHalted(tenantId);
  } catch (err) {
    structuredLog.error("scheduledAgent.halt_read_failed", {
      message: "[ScheduledAgent] Halt read failed; failing closed:",
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

// ScheduledAgent: autonomous trigger for goal-driven agent work.
//
// Wired to Cloudflare Cron Triggers (wrangler.jsonc triggers.crons).
// On each tick it:
//   1. Pulls enabled goals from DO storage
//   2. Checks each goal's cron schedule (isDue)
//   3. Budget-checks via PaymentsAgent before creating work
//   4. Creates an Orchestrator job for due goals within budget
//
// The agent never spends directly — all budget decisions go through
// PaymentsAgent, and all work goes through the orchestrator module.
//
// SCOPE (issue #959, survey item D10): ScheduledAgent is explicitly
// NOT a screening scheduler. Screening schedules (stock screens,
// options analysis, strategy discovery) live in the OrchestratorAgent
// schedule store as the autonomousMarketScreen /
// autonomousOptionsAnalysis / autonomousStrategyDiscovery callbacks,
// created through POST /api/schedules/create and validated by
// src/trading/screeningSchemas.ts. Do not add screening callbacks
// here — this agent's remit is goal evaluations with budget checks
// on the */30 cron, nothing else.
//
// Social posting (issue #1077 Phase 5b slice 1) IS in remit as a goal:
// the seeded "daily-social-post" goal (disabled) runs "social.publish"
// through the social goal executor, not through createJob. The goal's
// cron + timeZone decide when; the executor decides what. The old
// bespoke fire check and parallel social tick were retired with this
// change, so there is exactly one scheduler for social posts.

/** Rebuild the compiled chain a synthesized record was made from. */
function chainFromRecord(record: SynthesizedSchedule): CompiledChain {
  return {
    goal: record.goal,
    steps: record.steps,
    budgetCents: record.budgetCents,
    budgetCapCents: record.budgetCapCents,
    recurrence: record.kind,
    reusesStoredReport: record.reusesStoredReport,
  };
}

/** Shard job ids from an executor run's leg results, in leg order. */
function shardProvenanceOf(run: ChainRunResult): string[] {
  const out: string[] = [];
  for (const leg of run.legs) {
    const result = leg.result as { shardJobIds?: unknown } | undefined;
    if (result && Array.isArray(result.shardJobIds)) {
      for (const id of result.shardJobIds) {
        if (typeof id === "string" && !out.includes(id)) out.push(id);
      }
    }
  }
  return out;
}

/**
 * Test/production overrides for onCron. Production passes none: the
 * social brief is read from the durable brief store for the firing
 * date (slice 2); an override here is test-only and wins over the
 * store when one is passed.
 */
export interface ScheduledAgentCronOpts {
  socialBriefProvider?: () => string | null;
  socialTransport?: SocialTransport;
  socialDryRunSink?: DryRunSink;
  /** #1077 Phase 5b slice 3: injected Slack poster for approval-card delivery (tests). Production uses fetch. */
  socialSlackPost?: SlackPostFn;
  /** #1819 rollup slice: injected Slack poster for cap alerts (tests). Production uses fetch. */
  resourceSlackPost?: SlackPostFn;
  /** #3788 watchdog slice: injected Slack poster for missed-fire alerts (tests). Production uses fetch. */
  watchdogSlackPost?: SlackPostFn;
  /** Force evaluation of a specific goal regardless of cron/enabled state (manual trigger). */
  forceGoalId?: string;
  /**
   * #1517: global-halt state for governed chain firing. A sql
   * (Orchestrator `mas_settings`) is preferred when the caller has
   * one — `isGovernedHalted(sql)` — otherwise pass the halt state
   * the caller already knows. The bare tick carries neither, so it
   * enforces the per-record gates (approved/killed/due) and the
   * budget check; see src/agentic/chainFiring.ts for the disclosed
   * cross-DO halt limitation.
   */
  halted?: boolean;
  /** Sql for the global-halt read + blocked-firing audit (callers with D1 access only). */
  sql?: any;
  /**
   * #1548 (slice 0): injected halt reader (tests, or a caller
   * that already owns a governance adapter). An explicit halted
   * flag still wins; a sql still wins over the reader. When
   * neither is present, the production tick reads the mirrored
   * halt from this.env.AGENT_DB when bound — the DO's own env
   * carries bindings, so no env crosses the RPC boundary (#1391).
   */
  haltReader?: HaltReader;
  /**
   * Tenant for the halt read. Absent, the deployment default from
   * resolveIaaaTenant (env IAAA_TENANT_ID, else "primary"), logged
   * as an explicit fallback — never a silent hardcoded literal
   * (#3179). A caller with a real tenant context threads it here.
   */
  tenantId?: string;
  /**
   * #1523 (Lane 2): leg executor for governed chain firings
   * (e.g. `createChainLegExecutor` bound to a DO/SQL runtime by
   * the caller that owns it). Absent, the branch keeps lane 1
   * behavior exactly: descriptor only, no legs claimed. Present,
   * legs run AFTER the governed decision and the PaymentsAgent
   * budget check above, and BEFORE the descriptor is created —
   * so a failed run stamps nothing and leaves the goal due.
   */
  chainExecutor?: (step: CompiledChainStep) => Promise<unknown>;
  /**
   * #1980: injected index-list refresh executor (tests, or a
   * caller that already owns a store + fetchers). Absent, the
   * branch below runs the Wikipedia goal's production path
   * (D1 store via AGENT_DB + global fetch) and fails the
   * holdings goal visibly until its fetcher is bound — never
   * a silent no-op, never an invented holdings URL.
   */
  indexRefreshExecutor?: (
    operation: IndexRefreshOperation,
  ) => Promise<IndexListJobResult>;
  /**
   * #4411: injected monthly Autopilot evaluation executor (tests, or
   * a caller that already owns an evaluate path). Absent, the branch
   * below runs the production path: the configured service identity
   * posts the representative dry-run intent to the OrchestratorAgent
   * evaluate endpoint. A missing service identity or a missing
   * ORCHESTRATOR_AGENT binding fails visibly and leaves the goal due
   * — never a silent no-op, never a substituted identity.
   */
  autopilotEvaluateExecutor?: (
    goal: ScheduledGoal,
  ) => Promise<AutopilotMonthlyEvaluationResult>;
  /**
   * Issue #3121 Phase 2 (#3124) — single evaluation scan: a caller
   * that already loaded the goals (triggerGoal) passes its snapshot
   * so onCron evaluates without re-listing the store. The snapshot
   * is the loader's `{ goals, records }` pair: the goals to evaluate
   * and the full loaded record list the save step reuses for removal
   * sync and createdAt preservation. Absent, onCron loads as before.
   */
  preloadedGoals?: { goals: ScheduledGoal[]; records: UnifiedScheduleRecord[] };
}

/**
 * Issue #1956 (think-fleet): ScheduledAgent extends PortThink
 * (src/actors/thinkAdapter.ts) instead of raw Agent. PortThink is
 * Think behind the actor port, so the class keeps Agent's storage /
 * scheduler facets and gains Think's turn facet — but this class has
 * NO turn path and NO port hooks (portHooks stays unset, so
 * PortThink.beforeTurn returns undefined and the chat hooks are
 * no-ops). Its observable behavior is the cron/goal surface below,
 * unchanged: ticks arrive via the one recurring SDK alarm
 * (`scheduleEvery`, `onCron` in-process — issue #4234, ADR 0030),
 * armed from `onStart` and re-armed by the hourly Worker watchdog
 * when missing or stale; the Worker tick cron stays OFF per #4112,
 * and the RPC `onCron()` path still works for manual triggers and
 * tests. onCron never touches Think's session, so no lifecycle boot
 * is needed on that path — the adapter-owned start() precondition
 * applies to turns only.
 */
/**
 * Issue #2426 (G14) — the audit actor for ScheduledAgent's own
 * maintenance acts when no acting principal is threaded into the
 * call. The reconciliation below is executed BY this agent (an
 * operator triggers it through the admin-gated route, which
 * threads the operator's login as the actor — see
 * reconcileChainScheduleProjection); a caller that supplies no
 * actor is answered with the agent's own named identity, never the
 * synthetic "system" literal this replaces: "system" named nobody,
 * while this names the agent that performed the act, in the same
 * named-service-identity pattern as NLQ_WEBHOOK_SERVICE_LOGIN
 * (#2412).
 */
export const SCHEDULED_AGENT_AUDIT_ACTOR = "scheduled-agent";

/**
 * Issue #3122 — the DO storage key for pending agent-schedule
 * approvals (goal kind). Same KV-list pattern as goals / ticks /
 * jobRunRecords on this DO; the orchestrator DO keeps its own
 * pending approvals in its sql table (same port shape, separate
 * instance — each DO decides only its own approvals).
 */
export const PENDING_SCHEDULE_APPROVALS_KEY = "pendingScheduleApprovals";

type AgenticLoopStopReason =
  | "cost-cap"
  | "time-cap"
  | "turn-cap"
  | "kill-switch"
  | "usage-unavailable"
  | "settings-unavailable";

interface ActiveAgenticLoop {
  login: string;
  scheduleId: string;
  runId: string;
  prompt: string;
  requestId?: string;
  settings: AgentScheduleLoopSettings;
  controller: AbortController;
  startedAtMs: number;
  usedModelTokens: number;
  turns: number;
  stopReason?: AgenticLoopStopReason;
}

type AgenticLoopRunOutcome =
  | { status: "completed"; usedModelTokens: number; turns: number }
  | { status: "approval-required"; usedModelTokens: number; turns: number; pendingApprovalId: string }
  | { status: "skipped"; detail: string; usedModelTokens: number; turns: number }
  | { status: "failed"; detail: string; usedModelTokens: number; turns: number };

export class ScheduledAgent extends PortThink {
  /**
   * #2840: in-memory firing claims for this isolate (the
   * synchronous half of the goal in-flight guard; the durable
   * half is the goalFiring: marker in ctx.storage). Keyed by
   * goal id; see src/services/goalFiringClaims.ts.
   */
  private goalFiringClaims = new Map<string, GoalFiringMarker>();
  private activeAgenticLoop?: ActiveAgenticLoop;
  private agenticLoopTurnQueue: Promise<void> = Promise.resolve();

  /**
   * Issue #6503 — the unified schedule store for this DO is D1 ONLY
   * (owner direction 2026-11-25, FAIL CLOSED): built from the bound
   * AGENT_DB, and it THROWS when the binding is absent — no DO
   * fallback, no KV fallback. Deploy must bind AGENT_DB on this host.
   * The DO `unified_schedules` table and the `"goals"` KV key are
   * never read or written; D1 starts empty (NO-COPY).
   */
  private async unifiedScheduleStore(): Promise<ScheduleStore> {
    return createD1UnifiedSchedulePorts({ d1: this.env.AGENT_DB }).unifiedSchedules;
  }

  /**
   * Issue #3121 Phase 2 (#3123) — the ledger post function for the
   * shared orchestrator instance (the same stub channel as the
   * goal-lifecycle audit sink), or null when the host binds no
   * ORCHESTRATOR_AGENT. A null post keeps the legacy KV ledger.
   */
  private ledgerPost(): ((req: Request) => Promise<Response>) | null {
    try {
      const stub = actorGateway.stub<DoStubLike>(
        this.env.ORCHESTRATOR_AGENT,
        SHARED_ORCHESTRATOR_INSTANCE,
      );
      return (req: Request) => stub.fetch(req);
    } catch {
      return null;
    }
  }

  /**
   * Issue #3652 — execute the `search.opportunity_hunt` operation over the
   * live persisted technicals bars. The bar source is the same artifact the
   * screener reads; a missing or stale artifact is a named failure
   * (`opportunity_hunt_no_bars`), never an empty "success".
   */
  private async huntOpportunities(now: Date): Promise<OpportunityHuntResult> {
    const envStrings: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      this.env as unknown as Record<string, unknown>,
    )) {
      if (typeof value === "string") envStrings[key] = value;
    }
    const technicalsDef = buildFeedJobRegistry(envStrings).get(
      YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
    );
    return executeOpportunityHunt({
      now: () => now,
      loadCloses: async () => {
        const store = createFeedDatasetAdapter(this.env);
        // An unbound store is a configuration state, not an empty universe:
        // fail with its own name so the ledger row says which one it is.
        if (!store) {
          throw new Error(
            "opportunity_hunt_store_unbound: AGENT_DB is not bound on this host",
          );
        }
        const persisted = await readPersistedTechnicalsBars(store, {
          ...(technicalsDef
            ? { maxAgeSeconds: technicalsDef.staleAfterMinutes * 60 }
            : {}),
          nowMs: now.getTime(),
        });
        const closes = new Map<string, number[]>();
        if (!persisted || persisted.stale) return closes;
        for (const [symbol, bars] of persisted.barsBySymbol) {
          const series = bars
            .map((bar) => bar.close)
            .filter((close) => Number.isFinite(close));
          if (series.length > 0) closes.set(symbol, series);
        }
        return closes;
      },
    });
  }

  private async getGoals(): Promise<ScheduledGoal[]> {
    return (await this.loadGoalRecords()).goals;
  }

  /**
   * Issue #3121 Phase 2 (#3124) — single evaluation scan: the one
   * load behind `getGoals`, returning the goals AND the full loaded
   * record list. The records snapshot is what the save step reuses
   * for removal sync and createdAt preservation, so an evaluation
   * that loads then saves costs one store scan instead of two. The
   * snapshot is the FULL loaded list — including rows that do not
   * map to a goal and KV-imported rows — so the save behaves
   * exactly like the re-list it replaces in the sequential flow.
   * Every branch below is `getGoals` verbatim, plus the records
   * carried alongside: the KV import, the empty-store seed, and the
   * no-SQL fallback are unchanged.
   */
  private async loadGoalRecords(): Promise<{
    goals: ScheduledGoal[];
    records: UnifiedScheduleRecord[];
  }> {
    const store = await this.unifiedScheduleStore();
    // Issue #6503 — D1 ONLY: the DO `"goals"` KV key is never read and
    // the one-way KV → store import is deleted (NO-COPY: D1 starts
    // empty; user goals are recreatable through the goals UX).
    const stored = await store.listByKind("goal");
    // A `deleted`-state row is a tombstone, not a goal: it never
    // appears in the goals list and never counts toward the seed rule.
    const goals = stored
      .filter((record) => record.state !== "deleted")
      .map((record) => recordToGoal(record))
      .filter((goal): goal is ScheduledGoal => goal !== undefined);
    const records = [...stored];
    if (goals.length === 0) {
      // Seed rule: the built-in goals config, only when no live goal
      // exists — minus goals the owner removed. The removal record is
      // the D1 `deleted` row (written by saveGoals on removal) plus
      // the legacy `#4253` KV list (read-only: pre-cutover removals,
      // whose ids have no D1 row yet). Distinct created_at values (one
      // second apart) preserve the seed order under the store's
      // created_at ordering.
      const deletedIds = new Set(
        stored
          .filter((record) => record.state === "deleted")
          .map((record) => record.id),
      );
      const seedable = await this.seedableBuiltinGoals(deletedIds);
      const baseMs = Date.now();
      const seeded: UnifiedScheduleRecord[] = [];
      for (let i = 0; i < seedable.length; i++) {
        const goal = seedable[i];
        try {
          const record = goalToRecord(goal);
          record.createdAt = new Date(baseMs + i * 1000).toISOString();
          record.updatedAt = record.createdAt;
          await store.save(record);
          seeded.push(record);
        } catch {
          // Seed best-effort; the return below still serves the goals.
        }
      }
      return { goals: [...seedable], records: seeded };
    }
    // Issue #6293 — one-time reconciliation of the stale
    // opportunity-hunt cron (see reconcileStaleOpportunityHuntCron):
    // the corrected record is written back to the store with its
    // createdAt preserved, and the returned snapshot updated so a
    // later saveGoals never re-introduces the stale value.
    if (this.reconcileStaleOpportunityHuntCron(goals)) {
      const fixed = goals.find((goal) => goal.id === "opportunity-hunt");
      if (fixed) {
        const prev = records.find((record) => record.id === fixed.id);
        const record = goalToRecord(fixed);
        if (prev) {
          record.createdAt = prev.createdAt;
          records[records.indexOf(prev)] = record;
        } else {
          records.push(record);
        }
        record.updatedAt = new Date().toISOString();
        await store.save(record);
      }
    }
    return { goals, records };
  }

  /**
   * Issue #6293 — one-time reconciliation of the stale
   * opportunity-hunt cron (user decision 2026-11-23: run it daily).
   * The deployed stored goal still carries the cron it shipped with,
   * "0 *\/6 * * *" (every 6 hours; see src/config/builtinScheduledGoals.ts),
   * while the config says "0 7 * * *" (daily 07:00). The seed only
   * runs on an empty store and never backfills, so the stale value
   * persists indefinitely — and the no-timeZone isDue branch can
   * never fire a step-hour cron, so the goal effectively never runs
   * on schedule.
   *
   * Resets ONLY the known stale value to the config value (the
   * config is the source of truth for the target cron). Any other
   * stored cron — including an owner edit via the goals UI — is
   * left untouched, so this never clobbers an owner edit. Once
   * corrected the stored value equals the config value and this
   * never fires again: a one-time reconciliation, not a blanket
   * overwrite-on-load. Returns true when a goal was corrected; the
   * caller persists the correction through the store the goals were
   * read from.
   */
  private reconcileStaleOpportunityHuntCron(goals: ScheduledGoal[]): boolean {
    const stored = goals.find((goal) => goal.id === "opportunity-hunt");
    if (!stored || stored.cron !== "0 */6 * * *") return false;
    const config = getBuiltinScheduledGoals().find(
      (goal) => goal.id === "opportunity-hunt",
    );
    if (!config || stored.cron === config.cron) return false;
    // Issue #6293 — the id alone does not identify the shipped
    // opportunity-hunt goal: a stored goal that reuses the id with a
    // different operation keeps its cron (a fixture running
    // "search.query" must not be rewritten to daily 07:00).
    if (stored.operation !== config.operation) return false;
    stored.cron = config.cron;
    return true;
  }

  /**
   * Issue #3121 Phase 2 (#3124) — single evaluation scan: `existing`
   * is the already-loaded record list from `loadGoalRecords` (or
   * `onCron`'s preloaded snapshot). When a caller passes it, the
   * save reuses it for removal sync and createdAt preservation
   * instead of re-listing the store — one scan per evaluation. When
   * no snapshot is passed, the save re-lists as before (the fallback
   * for any caller without one). The snapshot must be the FULL loaded
   * list, including rows that do not map to a goal, so a malformed
   * row is still pruned exactly as the re-list pruned it.
   *
   * Issue #4205 — dirty-check saves: the re-save loop below writes
   * only goals whose persisted fields changed since load
   * (`isUnchangedGoalRecord`, ignoring the write stamp). Removal
   * sync and the no-snapshot fallback are unchanged.
   */
  private async saveGoals(
    goals: ScheduledGoal[],
    existing?: UnifiedScheduleRecord[],
  ): Promise<void> {
    const store = await this.unifiedScheduleStore();
    const nowIso = new Date().toISOString();
    const existingRecords = existing ?? (await store.listByKind("goal"));
    const existingById = new Map(existingRecords.map((record) => [record.id, record]));
    const wanted = new Set(goals.map((goal) => goal.id));
    for (const record of existingRecords) {
      if (wanted.has(record.id)) continue;
      // Issue #6503 — a `deleted` row is a tombstone: never hard-remove
      // it in the sync loop, or the re-seed would resurrect the goal.
      if (record.state === "deleted") continue;
      // Issue #6503 — removing a built-in goal writes a `deleted`
      // tombstone instead of a hard remove, so the seed rule (which
      // subtracts `deleted` ids) never resurrects it. A user goal has
      // no seed to resurrect it, so its row is removed as before.
      if (isBuiltinScheduledGoalId(record.id)) {
        try {
          await store.save({ ...record, state: "deleted", updatedAt: nowIso });
        } catch {
          // A failed tombstone leaves the live row in place; the goal
          // stays visible, so the failure is not silent.
        }
        continue;
      }
      try {
        await store.remove(record.id);
      } catch {
        // A failed remove leaves a stale row the next read still serves;
        // the goal is gone from the wanted set, so it is not re-added.
      }
    }
    for (const goal of goals) {
      const record = goalToRecord(goal);
      // Preserve the stored created_at: re-saving every goal must
      // not reshuffle the list order under created_at ordering.
      const prev = existingById.get(goal.id);
      if (prev) record.createdAt = prev.createdAt;
      // Issue #4205 — dirty-check saves: a goal whose persisted
      // fields are unchanged since load is not re-written. The
      // comparison ignores updatedAt (bumped below on a real
      // write); a goal with no loaded row is always written, and
      // removal sync above is unchanged — only the re-save loop
      // skips. The write stamp is set only when the save happens,
      // so an unchanged goal keeps its stored updatedAt.
      if (prev && isUnchangedGoalRecord(prev, record)) continue;
      record.updatedAt = nowIso;
      try {
        await store.save(record);
        // Issue #4205 — the snapshot is the store's picture, so a
        // write refreshes it: a second save in the same flow (the
        // triggerGoal restore) compares against what the first save
        // wrote, not the pre-flow load. Without this the restore
        // would compare the reset lastRun against the stale
        // pre-stamp snapshot, conclude "unchanged", and skip the
        // write the store actually needs. A failed write leaves
        // the snapshot (and the store) at the old row.
        existingById.set(goal.id, record);
        if (existing) {
          const idx = existing.findIndex((r) => r.id === goal.id);
          if (idx >= 0) existing[idx] = record;
        }
      } catch {
        // A failed store write leaves the goal in the KV key, where
        // the next read's one-way import picks it up.
      }
    }
  }

  /**
   * Issue #6503 step 13 — the goal-run retention caps, resolved
   * from this agent's env (the managed leg needs the cross-DO
   * mirror follow-up: this agent's storage cannot see the
   * orchestrator's mas_settings, so a managed
   * `goalRun.jobRunRecordCap` / `goalRun.tickHistoryCap` does not
   * reach the tick yet; env/default governs until then, exactly
   * as today — 500 records / 50 ticks).
   */
  private jobRunRecordCap(): number {
    return resolveGoalRunJobRunRecordCap({
      env: (this.env as unknown as Record<string, unknown> | undefined)?.[
        GOAL_RUN_JOB_RUN_RECORD_CAP_ENV_VAR
      ],
    });
  }

  private tickHistoryCap(): number {
    return resolveGoalRunTickHistoryCap({
      env: (this.env as unknown as Record<string, unknown> | undefined)?.[
        GOAL_RUN_TICK_HISTORY_CAP_ENV_VAR
      ],
    });
  }

  /** Recent cron ticks, newest first (capped). */
  private async getTicks(): Promise<ScheduleTick[]> {
    const stored = await this.ctx.storage.get<ScheduleTick[]>("tickHistory");
    return stored ?? [];
  }

  private async recordTick(tick: ScheduleTick): Promise<void> {
    const history = await this.getTicks();
    history.unshift(tick);
    await this.ctx.storage.put("tickHistory", history.slice(0, this.tickHistoryCap()));
  }

  /**
   * Issue #2964 — per-run result records. The legacy home is the
   * DO key-value `"jobRunRecords"` key (newest first, capped);
   * issue #3121 Phase 2 (#3123) moves new rows to the one physical
   * ledger (OrchestratorAgent DO SQLite, shared instance) and this
   * read merges both homes, so history is never dropped silently.
   * Recording never breaks a tick: a storage failure is swallowed,
   * so a run that happened but left no record is still visible via
   * the tick.
   */
  private async getKvJobRuns(): Promise<JobRunRecord[]> {
    const stored = await this.ctx.storage.get<JobRunRecord[]>("jobRunRecords");
    // Issue #3121 S1 — rows stored before the §4 columns read back
    // normalized (trigger "unknown", ids null); no silent backfill.
    return (stored ?? []).map((record) => normalizeJobRunRecord(record));
  }

  private async getJobRuns(): Promise<JobRunRecord[]> {
    const legacy = await this.getKvJobRuns().catch(() => [] as JobRunRecord[]);
    const post = this.ledgerPost();
    if (!post) return legacy;
    const shared = await fetchLedgerRuns(post, { limit: this.jobRunRecordCap() });
    if (!shared) return legacy;
    return mergeLedgerRuns(shared, legacy).slice(0, this.jobRunRecordCap());
  }

  /**
   * Issue #5085 (S6): returns whether the row landed. Recording
   * never breaks the tick — but a swallowed store failure is
   * unobservable, so a caller that supplied a hook hears about it
   * (best-effort; a throwing hook is swallowed too). Callers that
   * need the claim (the watchdog sweep) skip their alert when the
   * row did not land, so the finding recurs next tick and the claim
   * is retried rather than alerting without a claim.
   */
  private async recordJobRun(
    record: Omit<JobRunRecord, "system">,
    onRecordFailure?: (failure: ScheduleCallbackRecordFailure) => void,
  ): Promise<boolean> {
    try {
      // Issue #5102 (F5 of #5094): the scheduled agent's rows are
      // scheduling records — the tick loop carries no firing binding
      // in scope (goals carry creation provenance, not a binding),
      // and F3's rule forbids a fresh ambient read at fire time, so
      // these rows stamp explicit nulls and still record. The
      // brokered execution a goal dispatches records its own tuple
      // through its own write site (schedule callback payload,
      // broker preview/execute, policy verdict).
      const built = buildJobRunRecord({
        system: "scheduled-agent-goal",
        accountType: record.accountType ?? null,
        accountId: record.accountId ?? null,
        bindingScope: record.bindingScope ?? null,
        bindingSource: record.bindingSource ?? null,
        ...record,
      });
      const post = this.ledgerPost();
      if (post) {
        // The one physical ledger, best-effort: a 401 (no service
        // user configured) or a failed post falls through to the
        // legacy KV key below — the row is never lost, and the
        // merged read covers both homes.
        const serviceLogin = getServiceUserLogin(this.env);
        if (await postLedgerRun(post, built, serviceLogin)) return true;
      }
      const runs = await this.getKvJobRuns();
      runs.unshift(built);
      await this.ctx.storage.put("jobRunRecords", runs.slice(0, this.jobRunRecordCap()));
      return true;
    } catch (err) {
      if (onRecordFailure) {
        try {
          onRecordFailure({
            jobId: record.jobId,
            operation: record.operation,
            outcome: record.outcome,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // Reporting a failed record must never break the tick either.
        }
      }
      return false;
    }
  }

  /** Per-run history for one goal (newest first), or all goals. */
  async listJobRuns(jobId?: string, limit: number = 50): Promise<JobRunRecord[]> {
    const runs = await this.getJobRuns();
    const filtered = jobId ? runs.filter((r) => r.jobId === jobId) : runs;
    return filtered.slice(0, Math.max(1, Math.min(200, limit)));
  }

  /** One goal's newest run, or undefined when it never ran. */
  async getLatestJobRun(jobId: string): Promise<JobRunRecord | undefined> {
    const runs = await this.getJobRuns();
    return runs.find((r) => r.jobId === jobId);
  }

  /**
   * Issue #3788 — the goals watchdog, run at the end of every onCron
   * tick (after the due-goal loop, so runs recorded on this tick are
   * visible). For each enabled goal it asks the pure core whether the
   * goal missed its most recent expected tick; every finding emits
   * all three signals, claim-first in ledger order:
   *   1. a runs-ledger record (outcome "skipped", detail
   *      "missed-fire: ..." / "invalid-cron: ...") — the record IS
   *      the exactly-once claim for (goal, expected tick);
   *   2. a durable audit event (schedule.goal.missed_fire, code
   *      missed_fire / invalid_cron) through the lifecycle sink;
   *   3. a Slack alert through the existing postSlackText seam
   *      (webhook first, bot token second — the #1819 seam).
   * The watchdog NEVER stamps lastRun (the alert branch's rule: a
   * missed fire must not suppress the next evaluation) and never
   * fails the tick: per-goal try/catch, and a Slack failure is a
   * tick error, not a tick failure. A grace of 0 disables it
   * entirely (no findings, no heartbeat).
   *
   * The heartbeat: one ledger row per tick (job
   * schedule-watchdog-heartbeat, outcome success, examined/missed
   * counts). No heartbeat in 24h means the tick path itself is dead
   * — the Worker cron triggers are deployment-only and have no
   * per-trigger watchdog of their own. The heartbeat shares the
   * 500-record cap with goal runs (documented trade-off: ~48
   * heartbeat rows a day against ~7 days of retained history at
   * current goal volume; the 50-entry tickHistory stays the
   * short-term proof either way).
   */
  private async runScheduleWatchdog(
    now: Date,
    goals: ScheduledGoal[],
    opts?: ScheduledAgentCronOpts,
  ): Promise<{ examined: number; missed: number; errors: string[] }> {
    const result = { examined: 0, missed: 0, errors: [] as string[] };
    const graceMs = resolveMissedScheduleGraceMs(this.env as { MISSED_SCHEDULE_GRACE_MINUTES?: string });
    if (graceMs <= 0) return result;
    // Issue #5085 (S6): the audit half of the shared ledger-write
    // namer for this agent — the goal-schedule audit sink accepts
    // any string event type, so schedule.ledger_write_failed posts
    // through it (fire-and-forget; the sink swallows its own
    // failures, so naming a failed write can never fail the tick).
    const auditLedgerWriteFailure = (
      type: string,
      agent: "orchestrator",
      payload: Record<string, unknown>,
    ): void => {
      void this.postScheduleAuditEvent({ type, agent, payload });
    };
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const runs = await this.getJobRuns().catch(() => [] as JobRunRecord[]);
    const runsByGoal = new Map<string, JobRunRecord[]>();
    for (const run of runs) {
      const list = runsByGoal.get(run.jobId) ?? [];
      list.push(run);
      runsByGoal.set(run.jobId, list);
    }
    // First-seen attribution (same rule as the durable-schedule
    // sweep): a goal first observed after its expected tick is never
    // flagged for that tick. Stamped once per id, pruned to live goals.
    let firstSeen: Record<string, string> = {};
    try {
      const stored = await this.ctx.storage.get<Record<string, string>>(
        SCHEDULE_WATCHDOG_FIRST_SEEN_KEY,
      );
      if (stored && typeof stored === "object") {
        for (const [k, v] of Object.entries(stored)) {
          if (typeof v === "string" && v) firstSeen[k] = v;
        }
      }
      let changed = false;
      for (const goal of goals) {
        if (!(goal.id in firstSeen)) {
          firstSeen[goal.id] = nowIso;
          changed = true;
        }
      }
      for (const id of Object.keys(firstSeen)) {
        if (!goals.some((g) => g.id === id)) {
          delete firstSeen[id];
          changed = true;
        }
      }
      if (changed) await this.ctx.storage.put(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, firstSeen);
    } catch {
      // A first-seen failure fails closed to "unseen": no finding can
      // be attributed, but the sweep still runs and heartbeats.
      firstSeen = {};
    }
    for (const goal of goals) {
      if (!goal.enabled) continue;
      result.examined++;
      try {
        const firstSeenAtMs = firstSeen[goal.id] ? Date.parse(firstSeen[goal.id]) : undefined;
        const finding = findMissedGoalFiring({
          goal,
          runs: runsByGoal.get(goal.id) ?? [],
          firstSeenAtMs: Number.isFinite(firstSeenAtMs) ? firstSeenAtMs : undefined,
          nowMs,
          graceMs,
        });
        if (!finding) continue;
        const detail = missedFiringDetail(goal.id, finding, goal.cron);
        // Claim-first: the ledger record is the exactly-once claim.
        // Issue #5085 (S6): a failed claim write is named (audit +
        // coded OBS-1020) through the shared namer instead of
        // vanishing — and the goal is skipped this tick, so the
        // finding recurs next tick and the claim is retried rather
        // than alerting without a claim.
        const claimed = await this.recordJobRun(
          {
            jobId: goal.id,
            operation: goal.operation,
            started: nowIso,
            finished: nowIso,
            outcome: "skipped",
            triggeredBy: "scheduled",
            trigger: "scheduled",
            scheduleId: goal.id,
            asyncJobId: null,
            workflowId: null,
            detail,
          },
          nameLedgerWriteFailure(auditLedgerWriteFailure, "schedule.ledger_write_failed", {
            goalId: goal.id,
          }),
        );
        if (!claimed) continue;
        result.missed++;
        await this.auditGoalLifecycle("schedule.goal.missed_fire", goal.id, {
          operation: goal.operation,
          expectedTick: finding.expectedTickIso,
          lastRun: finding.lastRunIso ?? null,
          code: finding.code,
        });
        const text = renderChannelText(
          "missed_schedule_alert",
          "slack",
          {
            scheduleId: goal.id,
            kind: "goal",
            expectedTick: finding.expectedTickIso ?? "never (cron unparseable)",
            lastRun: finding.lastRunIso ?? "never",
            detail,
          },
          "legacy_missed_schedule_alert",
        );
        const delivered = await postSlackText({
          post: opts?.watchdogSlackPost ?? fetchSlackPost,
          env: this.env,
          text,
        });
        if (!delivered.ok) {
          result.errors.push(
            `${goal.id}: missed-fire Slack alert undelivered: ${delivered.error ?? "unknown delivery failure"}`,
          );
        }
      } catch (err) {
        // Per-goal try/catch: one bad goal never fails the tick or
        // the watchdog's remaining goals.
        result.errors.push(
          `${goal.id}: schedule watchdog failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Heartbeat: the tick ran, with examined counts. Best-effort.
    // Issue #5085 (S6): a failed heartbeat write is named (audit +
    // coded OBS-1020) through the shared namer instead of vanishing
    // silently.
    await this.recordJobRun(
      {
        jobId: SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
        operation: "schedule.watchdog_heartbeat",
        started: nowIso,
        finished: nowIso,
        outcome: "success",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: null,
        asyncJobId: null,
        workflowId: null,
        detail: `examined=${result.examined} missed=${result.missed}`,
      },
      nameLedgerWriteFailure(auditLedgerWriteFailure, "schedule.ledger_write_failed"),
    );
    return result;
  }

  /* ---------------------------------------------------------------- */
  /* Job pipeline host (#3543, consumed by #3535)                      */
  /*                                                                    */
  /* This agent manages/controls the pipeline (host decision on       */
  /* #3543). The methods below are the RPC door the invoking          */
  /* surfaces (Orchestrator doors, UX routes, the queue consumer)     */
  /* call; every one delegates to the ONE control plane built by      */
  /* ./scheduledTasksPipeline.ts over this agent's storage — no       */
  /* second implementation of any J1 operation exists here.           */
  /* ---------------------------------------------------------------- */

  private pipelineContext(): ScheduledTasksPipelineContext {
    return {
      env: this.env,
      // The AgentContext type itself is named in
      // ./scheduledTasksPipeline.ts — this class file never
      // imports the agents package directly (conformance #1738).
      agentCtx: this.ctx as unknown as ScheduledTasksPipelineContext["agentCtx"],
    };
  }

  /** String-valued env entries (the registries' knob source). */
  private feedEnvStrings(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  /** True when the job id is a feed-catalog job (#4171 residency routing). */
  private isFeedPipelineJob(jobId: string): boolean {
    return buildFeedJobRegistry(this.feedEnvStrings()).get(jobId) !== undefined;
  }

  /** Think scheduled-task declarations for the pipeline's jobs. */
  override async getScheduledTasks(): Promise<ThinkScheduledTasks> {
    return declarePipelineTasks(this.pipelineContext());
  }

  /**
   * Issue #4002: Cloudflare Agents lifecycle — settle the
   * pipeline runs orphaned by a host restart. A live run cannot
   * survive its host's death, so any instance still marked
   * `running` at start is settled as failed with a named orphan
   * error, and the job is dispatchable again (a re-armed feed
   * run from the Orchestrator's onStart recovery depends on
   * this: the dispatch forces this host to start, and onStart
   * precedes any dispatch). Best-effort by the same rule as the
   * Orchestrator's onStart recoveries: a settle failure is
   * logged and never fails startup.
   */
  override async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart(props);
    try {
      const { settled } = await settleOrphanedPipelineRuns(this.pipelineContext());
      if (settled.length > 0) {
        structuredLog.info("scheduledAgent.on_start_orphaned_pipeline_runs_settled", {
          message: `[ScheduledAgent][onStart] Settled ${settled.length} orphaned pipeline run(s) from a host restart:`,
          settled,
        });
      }
    } catch (error) {
      structuredLog.error("scheduledAgent.on_start_orphaned_pipeline_runs_settle_failed", {
        message: "[ScheduledAgent][onStart] Could not settle orphaned pipeline runs:",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Issue #4234 (ADR 0030) — arm the one recurring heartbeat alarm
    // (`scheduleEvery`, `onCron` in-process). Best-effort by the same
    // rule as the recoveries above: the ensure-pattern is idempotent
    // (a present alarm is a no-op), and a failed arm is logged and
    // never fails startup — the hourly Worker watchdog re-arms a
    // missing alarm, so a missed arm here is recovered within the
    // hour.
    try {
      const result = await armHeartbeatAlarm(this, this.env);
      structuredLog.info("scheduledAgent.on_start_heartbeat_alarm", {
        message: `[ScheduledAgent][onStart] Heartbeat alarm ${result.armed ? "armed" : "already armed"}.`,
      });
    } catch (error) {
      structuredLog.error("scheduledAgent.on_start_heartbeat_alarm_failed", {
        message: "[ScheduledAgent][onStart] Could not arm the heartbeat alarm (the hourly watchdog will re-arm it):",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  override async beforeTurn(
    ctx: ThinkTurnContext,
  ): Promise<ThinkTurnConfig | void> {
    const base = await super.beforeTurn(ctx);
    const active = this.activeAgenticLoop;
    if (
      !active ||
      ctx.body?.agentScheduleLoopRunId !== active.runId
    ) {
      return base;
    }
    if (!ctx.requestId) {
      active.stopReason = "settings-unavailable";
      active.controller.abort("agentic-loop request identity unavailable");
      throw new Error("Agentic-loop request identity is required for metered execution.");
    }
    active.requestId = ctx.requestId;

    const scheduleTool = createAgentScheduleManagementTool({
      env: this.env,
      actingLogin: () => active.login,
      loopOrigin: () => ({
        scheduleId: active.scheduleId,
        runId: active.runId,
      }),
      goalsOnly: true,
      execute: (request) =>
        executeAgentScheduleAction(this.agentScheduleExecutorDeps(), request),
    });
    return {
      ...(base ?? {}),
      messages: [{ role: "user", content: active.prompt }],
      tools: {
        ...((base?.tools ?? {}) as Record<string, unknown>),
        manage_agent_schedule: scheduleTool,
      },
      activeTools: ["manage_agent_schedule"],
      maxSteps: active.settings.maxTurns,
      maxOutputTokens: active.settings.maxModelTokens,
    };
  }

  override async onStepEnd(ctx: ThinkStepContext): Promise<void> {
    const active = this.activeAgenticLoop;
    if (
      !active ||
      !active.requestId ||
      this.activeTurn?.requestId !== active.requestId ||
      active.stopReason
    ) {
      return;
    }

    active.turns++;
    const usage = ctx.usage;
    const totalTokens = usage?.totalTokens;
    const inputTokens = usage?.inputTokens;
    const outputTokens = usage?.outputTokens;
    const reportedTokens =
      typeof totalTokens === "number" && Number.isFinite(totalTokens)
        ? totalTokens
        : typeof inputTokens === "number" &&
            Number.isFinite(inputTokens) &&
            typeof outputTokens === "number" &&
            Number.isFinite(outputTokens)
          ? inputTokens + outputTokens
          : undefined;
    if (
      reportedTokens === undefined ||
      !Number.isSafeInteger(reportedTokens) ||
      reportedTokens < 0 ||
      !Number.isSafeInteger(active.usedModelTokens + reportedTokens)
    ) {
      active.stopReason = "usage-unavailable";
      active.controller.abort("provider usage unavailable");
      return;
    }
    active.usedModelTokens += reportedTokens;

    const resolution = await this.getAgentScheduleLoopSettingsForLogin(
      active.login,
    );
    if (!resolution.settings) {
      active.stopReason = "settings-unavailable";
      active.controller.abort(resolution.issues.join("; ") || "loop settings unavailable");
      return;
    }
    active.settings = resolution.settings;
    if (!resolution.settings.enabled) {
      active.stopReason = "kill-switch";
      active.controller.abort("agentic-loop kill switch is disabled");
      return;
    }
    if (Date.now() - active.startedAtMs >= resolution.settings.maxDurationMs) {
      active.stopReason = "time-cap";
      active.controller.abort("configured loop duration reached");
      return;
    }
    if (active.turns >= resolution.settings.maxTurns) {
      active.stopReason = "turn-cap";
      active.controller.abort("configured loop turn limit reached");
      return;
    }
    if (active.usedModelTokens >= resolution.settings.maxModelTokens) {
      active.stopReason = "cost-cap";
      active.controller.abort("configured model-token cost cap reached");
    }
  }

  /** Run one pipeline job now and settle it; returns the outcome view. */
  async runPipelineJob(
    jobId: string,
    opts?: {
      userLogin?: string;
      trigger?: JobRunTrigger;
      /** Issue #6557 — the firing schedule payload's provenance. */
      provenance?: JobRunProvenance | null;
      /**
       * Issue #6682 — dispatch run inputs (universe/symbols/source/…),
       * bound by the one carrier into an ephemeral spec definition.
       * Absent ⇒ the job's own definition runs, as before.
       */
      runInputs?: Record<string, unknown>;
    },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    // Issue #3992 — a feed dispatch at this door is bounded:
    // ensure + dispatch + settle must complete within the feed
    // execution bound plus the capture bound for the terminal
    // writes. The engine's own race settles the run record
    // first in the ordinary hang; this bound covers the legs
    // outside it (definition ensure, door reads) so the caller
    // refuses by name instead of hanging until the async
    // executor's 90-minute backstop.
    const envStrings: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env as Record<string, unknown>)) {
      if (typeof value === "string") envStrings[key] = value;
    }
    const isFeedJob = buildFeedJobRegistry(envStrings).get(jobId) !== undefined;
    const runDispatch = async (): Promise<{ jobId: string; runId: string; state: string; error?: string }> => {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    // Issue #6682 — the one run-input carrier: bound inputs define an
    // ephemeral per-run job through the same bind → build → define
    // sequence as the define route; the run then dispatches that
    // definition. A binder refusal propagates by name before any run.
    const carried = buildFeedRunInputDefinition(jobId, opts?.runInputs, opts?.userLogin);
    const dispatchJobId = carried ? carried.ephemeralJobId : jobId;
    if (carried) {
      await control.defineJob(carried.config);
    }
    // Issue #4767 — a Run-now records the dispatch trigger: an
    // explicit trigger from a caller that knows it (a copilot
    // dispatch passes "copilot"); otherwise the job's root
    // schedule decides — "triggered" for a scheduled job, "manual"
    // for an unscheduled one. Never a hardcoded "manual".
    const definition = await control.getDefinition(jobId);
    const trigger =
      opts?.trigger !== undefined
        ? normalizeJobRunTrigger(opts.trigger)
        : resolveRunNowTrigger(definition);
    // Issue #6557 — a scheduled firing passes the payload's provenance;
    // every other caller passes none and the run records nulls.
    // Issue #4171 — a feed job dispatches to workflow residency:
    // this host is the control plane/dispatcher, and the workflow
    // instance executes the run. Non-feed jobs keep the host
    // dispatch below.
    if (isFeedJob) {
      const outcome = await dispatchFeedJobWorkflow(ctx, dispatchJobId, {
        trigger,
        ...(opts?.userLogin ? { userLogin: opts.userLogin } : {}),
        ...(opts?.provenance ? { provenance: opts.provenance } : {}),
        operation: "run",
      });
      return {
        jobId,
        runId: outcome.runId,
        state: outcome.state,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    }
    const dispatch = await control.runJob(dispatchJobId, {
      trigger,
      ...(opts?.provenance ? { provenance: opts.provenance } : {}),
    });
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    };
    if (!isFeedJob) return runDispatch();
    const timeouts = resolveFeedJobTimeouts(envStrings);
    const doorBoundMs = timeouts.executionMs + timeouts.captureMs;
    try {
      return await withFeedDeadline(
        runDispatch(),
        doorBoundMs,
        FEED_JOB_CODES.deadlineExceeded,
      );
    } catch (error) {
      if (error instanceof FeedJobTimeoutError) {
        throw new Error(
          `${FEED_JOB_CODES.deadlineExceeded}: feed job "${jobId}" dispatch did not settle within ${doorBoundMs}ms at the pipeline host door.`,
        );
      }
      throw error;
    }
  }

  /**
   * Issue #3121 #3310 — run one pipeline job stage now and settle
   * it; the scoped dispatch (scopePath = the stage's node path)
   * with the dispatching schedule id threaded, so the terminal run
   * record joins to the schedule and to the workflow instance.
   * Same door idiom as runPipelineJob: build control, ensure,
   * dispatch. The engine refuses a retired scope (fail-closed).
   */
  async runPipelineStage(
    jobId: string,
    opts?: { nodePath?: string; userLogin?: string; scheduleId?: string; trigger?: JobRunTrigger },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    // Issue #4171 — a scoped feed dispatch executes in workflow
    // residency, like every feed run.
    if (this.isFeedPipelineJob(jobId)) {
      const outcome = await dispatchFeedJobWorkflow(ctx, jobId, {
        trigger: normalizeJobRunTrigger(opts?.trigger ?? "scheduled"),
        scopePath: opts?.nodePath ?? "",
        ...(opts?.scheduleId ? { scheduleId: opts.scheduleId } : {}),
        ...(opts?.userLogin ? { userLogin: opts.userLogin } : {}),
        operation: "run",
      });
      return {
        jobId,
        runId: outcome.runId,
        state: outcome.state,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    }
    const dispatch = await control.runJob(jobId, {
      // Issue #4767 — the scoped run inherits the dispatch trigger
      // (Q5); the default caller is the schedule callback, so an
      // absent trigger means the schedule fired it. Widened to the
      // five modes: a Run-now of a stage passes "triggered".
      trigger: normalizeJobRunTrigger(opts?.trigger ?? "scheduled"),
      scopePath: opts?.nodePath ?? "",
      ...(opts?.scheduleId ? { scheduleId: opts.scheduleId } : {}),
    });
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /**
   * Reconfigure one pipeline job (#3530 scheduling-config): the
   * patch merges into the stored raw config through the engine's
   * configureJob — the schedule route's write path. Same door
   * idiom as every RPC here: build control, ensure, dispatch.
   */
  async configurePipelineJob(jobId: string, patch: unknown): Promise<JobDefinition> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.configureJob(jobId, patch);
  }

  /** Pause a running pipeline job (honored at the next step boundary). */
  async pausePipelineJob(jobId: string): Promise<JobInstanceRecord> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.pauseJob(jobId);
  }

  /** Resume a paused pipeline job from its persisted checkpoint. */
  async resumePipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    // Issue #4171 — a feed resume executes in workflow residency.
    if (this.isFeedPipelineJob(jobId)) {
      const outcome = await dispatchFeedJobWorkflow(ctx, jobId, {
        ...(opts?.userLogin ? { userLogin: opts.userLogin } : {}),
        operation: "resume",
      });
      return {
        jobId,
        runId: outcome.runId,
        state: outcome.state,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    }
    const dispatch = await control.resumeJob(jobId);
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Cancel a pipeline job (terminal). */
  async cancelPipelineJob(jobId: string): Promise<JobInstanceRecord> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.cancelJob(jobId);
  }

  /** Retry a pipeline job's last run as a new run. */
  async retryPipelineJob(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    // Issue #4171 — a feed retry executes in workflow residency.
    if (this.isFeedPipelineJob(jobId)) {
      const outcome = await dispatchFeedJobWorkflow(ctx, jobId, {
        ...(opts?.userLogin ? { userLogin: opts.userLogin } : {}),
        operation: "retry",
      });
      return {
        jobId,
        runId: outcome.runId,
        state: outcome.state,
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    }
    const dispatch = await control.retryJob(jobId);
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** The control plane's status view for one job. */
  async getPipelineJobStatus(jobId: string): Promise<JobStatusView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.getJob(jobId);
  }

  /**
   * Issue #4359 — the Workflow Runs stage read: one batch call for the
   * page's engine job ids. Same projection as getPipelineJobStatus
   * (control.getJobStages), never a second stage-read mechanism. An
   * unknown id is skipped, never invented into a stage list.
   */
  async getPipelineRunStages(jobIds: string[]): Promise<Record<string, JobStagesRead>> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    const limit = resolveWorkflowRunsStageReadLimit({
      WORKFLOW_RUNS_STAGE_READ_LIMIT: (this.env as unknown as Record<string, string | undefined>)
        .WORKFLOW_RUNS_STAGE_READ_LIMIT,
    });
    const out: Record<string, JobStagesRead> = {};
    for (const jobId of [...new Set(jobIds)].slice(0, limit)) {
      try {
        out[jobId] = await control.getJobStages(jobId);
      } catch {
        // Not an engine job (no definition on this host): no entry.
      }
    }
    return out;
  }

  /**
   * Issue #4360 — persist one stage publication durably. The queue
   * consumer calls this once per `job.stage.*` envelope; the store's
   * dedup makes a re-delivery a no-op rather than a second row.
   */
  async recordStageEvent(event: JobStageEventRecord): Promise<boolean> {
    const ctx = this.pipelineContext();
    return createScheduledAgentStageEventStore(ctx).record(event);
  }

  /**
   * Issue #4362 — drive one stage of one stock (engine) run from the
   * stock surface: run / rerun / stop / resume / cancel, addressed by the
   * same stage vocabulary the status read uses (stage id, kind, or node
   * path). The engine's own control-plane methods do the work; an unknown
   * job or stage refuses by name with the stages that exist, and a
   * terminal stage refuses with its current state — never a silent no-op.
   */
  async controlPipelineStage(
    jobId: string,
    stage: string,
    operation: "run" | "rerun" | "stop" | "resume" | "cancel",
    opts?: { userLogin?: string },
  ): Promise<{
    jobId: string;
    stageId: string;
    nodePath: string;
    operation: string;
    state: string;
    runId: string | null;
  }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    const view = await control.getJob(jobId);
    const report = buildJobStatusReport(jobId, view);
    const resolved = resolveSubJob(report, stage);
    if (!resolved.ok) throw new Error(resolved.reason);
    const nodePath = resolved.subJob.nodePath;
    const stageId = resolved.subJob.stageId;
    // Issue #4171 — feed stage execution (run / re-run / resume)
    // dispatches to workflow residency; stop/cancel stay control
    // plane writes on this host.
    if (
      this.isFeedPipelineJob(jobId) &&
      (operation === "run" || operation === "rerun" || operation === "resume")
    ) {
      const outcome = await dispatchFeedJobWorkflow(ctx, jobId, {
        ...(opts?.userLogin ? { userLogin: opts.userLogin } : {}),
        operation:
          operation === "run"
            ? "runStage"
            : operation === "rerun"
              ? "rerunStage"
              : "resumeStage",
        nodePath,
      });
      return {
        jobId,
        stageId,
        nodePath,
        operation,
        state: outcome.state,
        runId: outcome.runId ?? null,
      };
    }
    if (operation === "run" || operation === "rerun") {
      const dispatch =
        operation === "run"
          ? await control.runStage(jobId, nodePath)
          : await control.rerunStage(jobId, nodePath);
      return {
        jobId,
        stageId,
        nodePath,
        operation,
        state: dispatch.state,
        runId: dispatch.runId ?? null,
      };
    }
    if (operation === "resume") {
      const dispatch = await control.resumeStage(jobId, nodePath);
      return {
        jobId,
        stageId,
        nodePath,
        operation,
        state: dispatch.state,
        runId: dispatch.runId ?? null,
      };
    }
    const next =
      operation === "stop"
        ? await control.stopStage(jobId, nodePath)
        : await control.cancelStage(jobId, nodePath);
    return {
      jobId,
      stageId,
      nodePath,
      operation,
      state: next.state,
      runId: next.currentRunId ?? null,
    };
  }

  /**
   * Issue #4467 — replay a past run: a NEW run of the definition version
   * the original executed, with the original's trigger. The engine's own
   * `replayRun` does the work; this is the host seam behind the door, and
   * it shares `createScheduledAgentPipelineControl` with every other
   * control verb, so the operator identity and store residency are the
   * same as stage control.
   *
   * Issue #6400 — the SAME seam, narrowed to one stage by `opts.stage`
   * (the engine's `replayStage`): that stage's own work becomes its own new
   * run. The stage is addressed by its stage id (`job:2` — the id the runs
   * view and the stage tools show) or by the node path itself. Both are
   * self-describing, so neither is resolved against TODAY's definition
   * vocabulary: the replay executes the RECORDED version's tree, and a
   * name resolved against a newer tree could point at a different stage.
   */
  async replayPipelineRun(
    jobId: string,
    runId: string,
    opts?: { userLogin?: string; stage?: string },
  ): Promise<{
    jobId: string;
    replayedRunId: string;
    runId: string;
    state: string;
    stage?: string;
  }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    const nodePath =
      opts?.stage && isJobStageId(opts.stage)
        ? jobStageNodePath(opts.stage)
        : opts?.stage;
    // Issue #4171 — a feed replay executes in workflow residency.
    if (this.isFeedPipelineJob(jobId)) {
      const outcome = await dispatchFeedJobWorkflow(ctx, jobId, {
        ...(opts?.userLogin ? { userLogin: opts.userLogin } : {}),
        operation: nodePath ? "replayStage" : "replayRun",
        replayRunId: runId,
        ...(nodePath ? { nodePath } : {}),
      });
      return {
        jobId,
        replayedRunId: runId,
        runId: outcome.runId,
        state: outcome.state,
        ...(opts?.stage ? { stage: opts.stage } : {}),
      };
    }
    const dispatch = nodePath
      ? await control.replayStage(jobId, runId, nodePath)
      : await control.replayRun(jobId, runId);
    return {
      jobId,
      replayedRunId: runId,
      runId: dispatch.runId,
      state: dispatch.state,
      ...(opts?.stage ? { stage: opts.stage } : {}),
    };
  }

  /** Issue #4360 — a run's recorded stage events, in recorded order. */
  async listStageEvents(runId: string): Promise<JobStageEventRecord[]> {
    const ctx = this.pipelineContext();
    return createScheduledAgentStageEventStore(ctx).listByRun(runId);
  }

  /**
   * Issue #4363 — set a job's execution mode for its NEXT run. The mode is
   * fixed at start, so a live run refuses by name with the next-run-only
   * rule; a terminal/idle job takes the new mode and the next dispatch uses
   * it (the definition is versioned, so the change is a new version).
   */
  async setPipelineJobExecutionMode(
    jobId: string,
    mode: unknown,
  ): Promise<{ jobId: string; executionMode: Record<string, string>; appliedTo: "next-run" }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    const view = await control.getJob(jobId);
    const state = view.instance?.state ?? "idle";
    if (state === "running" || state === "queued" || state === "paused") {
      throw new Error(
        `Job "${jobId}" is ${state} — the execution mode is fixed at start and cannot change mid-run. Next-run-only: stop or cancel this run, set the mode, then start a new run.`,
      );
    }
    const resolved = resolveExecutionMode(mode);
    assertExecutionModeSupported(resolved);
    // Issue #4773 — the patch must land on the root node: the engine
    // resolves the job-level mode from root.executionMode only, so a
    // top-level executionMode was never read and the set silently did
    // nothing (the tool still reported appliedTo: "next-run").
    await control.configureJob(jobId, { root: { executionMode: resolved } });
    return {
      jobId,
      executionMode: resolved as unknown as Record<string, string>,
      appliedTo: "next-run",
    };
  }

  /**
   * Issue #4366 — define an engine job from the externalized definition
   * spec. The spec is validated on load (the catalogue's own resolver),
   * so an invalid definition refuses here, before any schedule can point
   * at it. The resolved definition is versioned by the engine as usual.
   */
  async definePipelineJobFromSpec(
    specId: string,
    jobId: string,
    opts?: {
      userLogin?: string;
      params?: Record<string, unknown>;
      /** Issue #4466 — per-stage values the flow collected, keyed by stage kind. */
      stageParams?: Record<string, Record<string, unknown>>;
      stageModes?: Record<string, Partial<import("../data/jobPipelinePorts").JobExecutionMode>>;
      /** Issue #4479 — per-stage cadence: minutes or a cron expression. */
      stageSchedules?: Record<string, { intervalMinutes?: number; cron?: string }>;
      /** Issue #4775 S1 — per-stage per-unit deadline, in milliseconds. */
      stageTimeouts?: Record<string, number>;
      /** Issue #4781 S2 — per-stage fan-out cap. */
      stageMaxParallel?: Record<string, number>;
      /** Issue #4781 S2 — per-stage retry bucket. */
      stageRetryBuckets?: Record<
        string,
        import("../workflows/stageRunnerPorts").StageRetryBucket
      >;
      /** Issue #4781 S2 — per-stage processing overrides (checkpoint interval). */
      stageProcessing?: Record<string, { checkpointEverySteps?: number }>;
    },
  ): Promise<{ jobId: string; name: string; version: number; stages: number }> {
    const spec = jobDefinitionSpec(specId);
    const id = typeof jobId === "string" ? jobId.trim() : "";
    if (!id) {
      throw new Error(
        `Defining the "${specId}" job requires a job id — none was supplied, and one is never invented.`,
      );
    }
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    const ownerLogin =
      typeof opts?.userLogin === "string" && opts.userLogin.trim()
        ? opts.userLogin.trim()
        : undefined;
    // The flow's parameter values are validated and bound to the family's
    // run parameters (universe → shards for the screener); a missing or
    // undeclared parameter refuses here, before the definition exists.
    const runParams = bindJobDefinitionParams(spec, opts?.params ?? {}, ownerLogin);
    // Issue #4466 — per-stage parameters and mode overrides, validated
    // against the spec before the definition exists.
    const perStage = bindStageOverrides(spec, {
      stageParams: opts?.stageParams,
      stageModes: opts?.stageModes,
      stageSchedules: opts?.stageSchedules,
      stageTimeouts: opts?.stageTimeouts,
      stageMaxParallel: opts?.stageMaxParallel,
      stageRetryBuckets: opts?.stageRetryBuckets,
      stageProcessing: opts?.stageProcessing,
    });
    const definition = await control.defineJob(
      buildJobConfigFromSpec(spec, id, runParams, perStage),
    );
    return {
      jobId: definition.jobId,
      name: definition.name,
      version: definition.version,
      stages: addressableStages(spec).length,
    };
  }

  /** Every pipeline job definition this host manages. */
  async listPipelineJobs(): Promise<JobDefinition[]> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.listJobs();
  }

  /** One feed job's merged surface status (dataset + pipeline). */
  async getFeedJobSurfaceStatus(jobId: string): Promise<FeedJobSurfaceView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const entry = FEED_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
    if (!entry) {
      throw new Error(
        `FEED_JOB_NOT_FOUND: no feed job with id "${jobId}" exists in the feed catalog.`,
      );
    }
    const envStrings: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(
      this.env as unknown as Record<string, unknown>,
    )) {
      if (typeof value === "string") envStrings[key] = value;
    }
    return buildFeedJobSurfaceView({
      entry,
      datasetStore: createFeedDatasetAdapter(this.env),
      registry: buildFeedJobRegistry(envStrings),
      pipeline: await control.getJob(jobId),
      nowMs: Date.now(),
    });
  }

  /** Every feed job's merged surface status, in catalog order. */
  async listFeedJobSurfaceStatuses(): Promise<FeedJobSurfaceView[]> {
    const views: FeedJobSurfaceView[] = [];
    for (const jobId of pipelineJobIds()) {
      views.push(await this.getFeedJobSurfaceStatus(jobId));
    }
    return views;
  }

  /** One enrich job's merged surface status (dataset + pipeline, #3536). */
  async getEnrichJobSurfaceStatus(jobId: string): Promise<EnrichJobSurfaceView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const entry = ENRICH_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
    if (!entry) {
      throw new Error(
        `ENRICH_JOB_NOT_FOUND: no enrich job with id "${jobId}" exists in the enrich catalog.`,
      );
    }
    const envStrings: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(
      this.env as unknown as Record<string, unknown>,
    )) {
      if (typeof value === "string") envStrings[key] = value;
    }
    return buildEnrichJobSurfaceView({
      entry,
      enrichedStore: createEnrichedDatasetAdapter(this.env),
      registry: buildEnrichJobRegistry(envStrings),
      pipeline: await control.getJob(jobId),
      nowMs: Date.now(),
    });
  }

  /** Every enrich job's merged surface status, in catalog order (#3536). */
  async listEnrichJobSurfaceStatuses(): Promise<EnrichJobSurfaceView[]> {
    const views: EnrichJobSurfaceView[] = [];
    for (const jobId of pipelineEnrichJobIds()) {
      views.push(await this.getEnrichJobSurfaceStatus(jobId));
    }
    return views;
  }

  /** One analyze job's merged surface status (dataset + pipeline, #3537). */
  async getAnalyzeJobSurfaceStatus(jobId: string): Promise<AnalyzeJobSurfaceView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const entry = ANALYZE_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
    if (!entry) {
      throw new Error(
        `ANALYZE_JOB_NOT_FOUND: no analyze job with id "${jobId}" exists in the analyze catalog.`,
      );
    }
    const envStrings: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(
      this.env as unknown as Record<string, unknown>,
    )) {
      if (typeof value === "string") envStrings[key] = value;
    }
    return buildAnalyzeJobSurfaceView({
      entry,
      analyzedStore: createAnalyzedDatasetPorts(this.env),
      registry: buildAnalyzeJobRegistry(envStrings),
      pipeline: await control.getJob(jobId),
      nowMs: Date.now(),
    });
  }

  /** Every analyze job's merged surface status, in catalog order (#3537). */
  async listAnalyzeJobSurfaceStatuses(): Promise<AnalyzeJobSurfaceView[]> {
    const views: AnalyzeJobSurfaceView[] = [];
    for (const jobId of pipelineAnalyzeJobIds()) {
      views.push(await this.getAnalyzeJobSurfaceStatus(jobId));
    }
    return views;
  }

  /** One generate job's merged surface status (dataset + pipeline, #3538). */
  async getGenerateJobSurfaceStatus(jobId: string): Promise<GenerateJobSurfaceView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const entry = GENERATE_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
    if (!entry) {
      throw new Error(
        `GENERATE_JOB_NOT_FOUND: no generate job with id "${jobId}" exists in the generate catalog.`,
      );
    }
    const envStrings: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(
      this.env as unknown as Record<string, unknown>,
    )) {
      if (typeof value === "string") envStrings[key] = value;
    }
    return buildGenerateJobSurfaceView({
      entry,
      generatedStore: createGeneratedDatasetPorts(this.env),
      registry: buildGenerateJobRegistry(envStrings),
      pipeline: await control.getJob(jobId),
      nowMs: Date.now(),
    });
  }

  /** Every generate job's merged surface status, in catalog order (#3538). */
  async listGenerateJobSurfaceStatuses(): Promise<GenerateJobSurfaceView[]> {
    const views: GenerateJobSurfaceView[] = [];
    for (const jobId of pipelineGenerateJobIds()) {
      views.push(await this.getGenerateJobSurfaceStatus(jobId));
    }
    return views;
  }

  /** One deliver job's merged surface status (dataset + pipeline, #3539). */
  async getDeliverJobSurfaceStatus(jobId: string): Promise<DeliverJobSurfaceView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const entry = DELIVER_PIPELINE_CATALOG.find((e) => e.jobId === jobId);
    if (!entry) {
      throw new Error(
        `DELIVER_JOB_NOT_FOUND: no deliver job with id "${jobId}" exists in the deliver catalog.`,
      );
    }
    const envStrings: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(
      this.env as unknown as Record<string, unknown>,
    )) {
      if (typeof value === "string") envStrings[key] = value;
    }
    return buildDeliverJobSurfaceView({
      entry,
      deliveryStore: createDeliveryDatasetPorts(this.env),
      registry: buildDeliverJobRegistry(envStrings),
      pipeline: await control.getJob(jobId),
      nowMs: Date.now(),
    });
  }

  /** Every deliver job's merged surface status, in catalog order (#3539). */
  async listDeliverJobSurfaceStatuses(): Promise<DeliverJobSurfaceView[]> {
    const views: DeliverJobSurfaceView[] = [];
    for (const jobId of pipelineDeliverJobIds()) {
      views.push(await this.getDeliverJobSurfaceStatus(jobId));
    }
    return views;
  }

  /** One pipeline chain's end-to-end surface status (#3540): per-stage states + the frontier, one query. */
  async getPipelineChainSurfaceStatus(
    jobId: string,
  ): Promise<PipelineChainSurfaceView> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return buildScheduledAgentChainSurfaceView(ctx, control, jobId);
  }

  /** Every pipeline chain's end-to-end surface status, in catalog order (#3540). */
  async listPipelineChainSurfaceStatuses(): Promise<PipelineChainSurfaceView[]> {
    const views: PipelineChainSurfaceView[] = [];
    for (const jobId of pipelineChainJobIds()) {
      views.push(await this.getPipelineChainSurfaceStatus(jobId));
    }
    return views;
  }

  /**
   * Run one pipeline chain end-to-end (#3540). The chain's
   * definition is refreshed from the stage jobs' stored
   * definitions first, so a stage reconfigured through the
   * control plane is what the chain runs.
   */
  async runPipelineChain(
    jobId: string,
    opts?: { userLogin?: string; trigger?: JobRunTrigger },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    await refreshScheduledAgentChainDefinition(ctx, control, jobId);
    // Issue #4767 — same Run-now rule as runPipelineJob, read
    // after the chain definition refresh so the schedule check
    // sees the refreshed definition.
    const definition = await control.getDefinition(jobId);
    const trigger =
      opts?.trigger !== undefined
        ? normalizeJobRunTrigger(opts.trigger)
        : resolveRunNowTrigger(definition);
    const dispatch = await control.runJob(jobId, { trigger });
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Resume a paused pipeline chain from its persisted checkpoint (#3540). */
  async resumePipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    await refreshScheduledAgentChainDefinition(ctx, control, jobId);
    const dispatch = await control.resumeJob(jobId);
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Retry a pipeline chain's last run as a new run (#3540). */
  async retryPipelineChain(
    jobId: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    await refreshScheduledAgentChainDefinition(ctx, control, jobId);
    const dispatch = await control.retryJob(jobId);
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Stop (pause) one stage of a pipeline chain's run — resumable, never a failure (#3540). */
  async stopPipelineChainStage(
    jobId: string,
    stage: string,
  ): Promise<JobInstanceRecord> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.stopStage(jobId, pipelineChainStageNodePath(ctx, jobId, stage));
  }

  /** Resume the stopped stage of a pipeline chain's run from its checkpoint (#3540). */
  async resumePipelineChainStage(
    jobId: string,
    stage: string,
    opts?: { userLogin?: string },
  ): Promise<{ jobId: string; runId: string; state: string; error?: string }> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx, opts?.userLogin);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    const dispatch = await control.resumeStage(
      jobId,
      pipelineChainStageNodePath(ctx, jobId, stage),
    );
    if (!dispatch.completion) {
      return { jobId, runId: dispatch.runId, state: dispatch.state };
    }
    const outcome = await dispatch.completion;
    return {
      jobId,
      runId: outcome.runId,
      state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Cancel one stage of a pipeline chain's run — terminal for that stage; its downstream never proceeds (#3540). */
  async cancelPipelineChainStage(
    jobId: string,
    stage: string,
  ): Promise<JobInstanceRecord> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);
    return control.cancelStage(jobId, pipelineChainStageNodePath(ctx, jobId, stage));
  }

  /**
   * The queue consumer's intake: record one routed completion —
   * then the stage hand-offs: a completed feed job dispatches
   * the enrich job consuming it (#3536), a completed enrich
   * job dispatches the analyze job consuming it (#3537), a
   * completed analyze job dispatches the generate job consuming
   * it (#3538), and a completed generate job dispatches the
   * deliver job consuming it (#3539) (best-effort; the
   * recording never depends on a dispatch). Deliver is the end
   * of the chain: its completions dispatch nothing.
   */
  async recordPipelineCompletion(note: PipelineCompletionNote): Promise<void> {
    const ctx = this.pipelineContext();
    await recordPipelineCompletion(ctx, note);
    await dispatchEnrichAfterFeedCompletion(ctx, note);
    await dispatchAnalyzeAfterEnrichCompletion(ctx, note);
    await dispatchGenerateAfterAnalyzeCompletion(ctx, note);
    await dispatchDeliverAfterGenerateCompletion(ctx, note);
  }

  /**
   * Issue #4425 — fire the owner-defined completion triggers this terminal
   * event matches.
   *
   * Distinct from the four fixed data-pipeline dispatches above: those are
   * the feed pipeline's own wiring (feed → enrich → analyze → generate →
   * deliver), not owner-definable. This door is the generic binding — any
   * target job whose raw config carries `completionTrigger` — and it reuses
   * the same control plane, so a fired target is an ordinary scheduled run.
   * The result names what fired and what could not, so the consumer's log
   * says why a chained schedule did not run.
   */
  async fireCompletionSchedules(event: CompletionEvent): Promise<CompletionFiringResult> {
    const ctx = this.pipelineContext();
    const control = createScheduledAgentPipelineControl(ctx);
    return dispatchCompletionSchedules(control, event, async (jobId, opts) => {
      // Issue #4171 — a feed target starts workflow residency;
      // every other target keeps the host dispatch.
      if (this.isFeedPipelineJob(jobId)) {
        // Preserve the host dispatch's refusal surface: a target
        // already running is skipped with its reason, not fired
        // into a workflow that can only error.
        const view = await control.getJob(jobId);
        const state = view.instance?.state;
        if (state === "running" || state === "queued") {
          throw new Error(
            `Job "${jobId}" is ${state} (run ${view.instance?.currentRunId ?? "unknown"})`,
          );
        }
        return startPipelineJobWorkflow(ctx, jobId, {
          trigger: opts.trigger,
          ...(opts.scopePath ? { scopePath: opts.scopePath } : {}),
          operation: "run",
        });
      }
      return control.runJob(jobId, opts);
    });
  }

  /** Recorded pipeline completions, newest first. */
  async listPipelineCompletions(
    jobId?: string,
  ): Promise<PipelineCompletionNote[]> {
    return listPipelineCompletions(this.pipelineContext(), jobId);
  }

  /** Dispatch a run as a JobPipelineWorkflow instance (ids-only payload). */
  async startPipelineJobWorkflow(
    jobId: string,
    opts?: { trigger?: JobRunTrigger; scopePath?: string },
  ): Promise<{ instanceId: string }> {
    return startPipelineJobWorkflow(this.pipelineContext(), jobId, opts ?? {});
  }

  /**
   * Cron entrypoint, invoked by the Workers runtime on each
   * triggers.crons tick. Evaluates due goals and dispatches work.
   *
   * Issue #1391: production calls onCron() with 0 arguments across the
   * Durable Object RPC boundary; the agent reads this.env directly.
   * Passing the Worker Env across the DO RPC boundary throws DataCloneError
   * because binding objects cannot be serialized.
   *
   * For backwards compatibility with unit tests, onCron accepts either
   * onCron(), onCron(opts), or onCron(env, opts).
   */
  async onCron(
    envOrOpts?: Env | ScheduledAgentCronOpts,
    maybeOpts?: ScheduledAgentCronOpts,
  ): Promise<ScheduleTick> {
    let env: Env = this.env;
    let opts: ScheduledAgentCronOpts | undefined = maybeOpts;

    if (envOrOpts) {
      if (
        typeof envOrOpts === "object" &&
        ("PAYMENTS_AGENT" in envOrOpts || "SESSION_STORE" in envOrOpts)
      ) {
        env = envOrOpts as Env;
      } else if (!opts) {
        opts = envOrOpts as ScheduledAgentCronOpts;
      }
    }
    const now = new Date();
    const tick: ScheduleTick = {
      timestamp: now.toISOString(),
      goalsEvaluated: 0,
      jobsCreated: 0,
      jobsSkipped: 0,
      errors: [],
    };

    // Issue #4234 (ADR 0030) — the heartbeat alarm tick: the SDK
    // invokes a scheduled callback as `handler(payload, schedule)`,
    // so a second argument that is an `onCron` Schedule row marks
    // this invocation as the alarm firing. Every other shape (RPC
    // `onCron()`, manual trigger, test call) is not the alarm and
    // behaves exactly as today.
    const isAlarmTick = isHeartbeatAlarmTick(envOrOpts, maybeOpts);

    // Issue #4234 — the #2331 slice 2 provisioning guard, alarm
    // ticks only: the tick skips with a logged reason if the
    // platform-tier service user is not provisioned. The skip is
    // recorded as a tick (so the watchdog still sees the alarm
    // fired), with the reason in its errors.
    let alarmUserLogin: string | null = null;
    if (isAlarmTick) {
      alarmUserLogin = getServiceUserLogin(env);
      const serviceProvisioned =
        alarmUserLogin !== null &&
        (await isPlatformServiceProvisioned(
          createKvMembershipStore(sessionStore(env)),
          alarmUserLogin,
          now.getTime(),
        ));
      if (!serviceProvisioned) {
        const reason = !alarmUserLogin
          ? "SERVICE_USER_LOGIN is not configured"
          : "service user is not provisioned for the platform tier";
        const detail = `${reason} — heartbeat tick skipped rather than running unattended work without a verified identity (#2331 slice 2)`;
        structuredLog.error(
          "scheduledAgent.heartbeat_tick_skipped_unprovisioned",
          {
            message: `[ScheduledAgent][onCron] ${detail}`,
          },
        );
        tick.errors.push(detail);
        await this.recordTick(tick);
        return tick;
      }
    }

    // Issue #3121 Phase 2 (#3124) — single evaluation scan: the
    // tick evaluates from one load; the save step below reuses the
    // same snapshot instead of re-listing the store.
    //
    // Issue #6503 — the goal load is fail-closed: when AGENT_DB is
    // not bound (or the D1 store is otherwise unreadable) the load
    // throws. A tick that cannot load its goals refuses to run, but
    // records the refusal as a tick error instead of crashing the
    // alarm — every goal stays due and the failure is visible in
    // the tick record.
    let goals: ScheduledGoal[];
    let records: UnifiedScheduleRecord[];
    try {
      ({ goals, records } =
        opts?.preloadedGoals ?? (await this.loadGoalRecords()));
    } catch (error) {
      const detail = `Scheduled goals could not be loaded: ${
        error instanceof Error ? error.message : String(error)
      }`;
      structuredLog.error("scheduledAgent.goals_load_failed", {
        message: `[ScheduledAgent][onCron] ${detail}`,
      });
      tick.errors.push(detail);
      await this.recordTick(tick);
      return tick;
    }
    // #1517: global-halt state for governed chain goals only; other
    // goals are unaffected. A supplied sql wins over a supplied flag
    // only when the flag is absent — an explicit halted:true is never
    // overridden by a sql read.
    // #1548 (slice 0): the bare tick finally sees the global halt:
    // an injected reader wins over the binding read, and the
    // binding read (this.env.AGENT_DB, the DO's own env) is the
    // production path. Unbound + no reader = legacy behavior
    // (false). The governed predicate below stays the decision-maker.
    // Issue #3179: the tick's tenant context is threaded in by the
    // caller when one exists (opts.tenantId); otherwise the tick
    // uses the deployment default — resolved explicitly, and
    // logged, never a silent hardcoded literal. The cron trigger
    // scans all goals and has no single owner, so the explicit env
    // default is the honest tick-wide tenant here; per-goal owner
    // derivation would need an owner on the goal record.
    const tickTenantId = opts?.tenantId ?? resolveIaaaTenant(this.env);
    if (!opts?.tenantId) {
      structuredLog.info("scheduledAgent.tick_tenant_env_fallback", {
        site: "onCron",
        tenantId: tickTenantId,
        reason: "no tenant context threaded into onCron",
      });
    }
    const governedHalted =
      opts?.halted ??
      (opts?.sql
        ? isGovernedHalted(opts.sql)
        : opts?.haltReader
          ? await resolveReaderHalt(opts.haltReader, tickTenantId)
          : this.env.AGENT_DB
            ? await readAgentDbHalt(this.env, tickTenantId)
            : false);

    for (const goal of goals) {
      const isForced = opts?.forceGoalId === goal.id;
      if (!goal.enabled && !isForced) continue;
      tick.goalsEvaluated++;

      // Issue #6503 (G3) — the due-check itself enforces the stored
      // state: `paused: !goal.enabled` makes isDue answer false for
      // a paused row even if the `continue` above were ever
      // bypassed. The goals are the D1 store's rows (recordToGoal
      // maps state "paused" to enabled=false), never a cached copy.
      if (!isForced && !isDue(goal.cron, goal.lastRun, now, goal.timeZone, { subDailyOptIn: goal.subDailyOptIn === true, paused: !goal.enabled })) continue;

      // Issue #2964: per-run record inputs for this firing. `started`
      // is captured before the branch; each terminal point records
      // its own outcome (success/failure/skipped) with the finished
      // time of that point. Disabled or not-due goals never reach
      // here, so they leave no record — no run happened.
      const runStarted = now.toISOString();
      const triggeredBy = isForced ? "manual" : "scheduled";
      const recordGoalRun = (
        outcome: JobRunRecord["outcome"],
        extra: {
          error?: string;
          detail?: string;
          descriptor?: string;
          artifactRefs?: string[];
          asyncJobId?: string | null;
          workflowId?: string | null;
        },
      ): Promise<void> => {
        // Issue #3121 S3 — the §4 consolidated-ledger linkage is
        // resolved through the S1 resolver (`buildLedgerLinkage`),
        // not hand-built at this write site: the schedule id IS the
        // goal id; the trigger derives from `triggeredBy` (forced →
        // manual, tick → scheduled); the async job id rides the
        // success branches that create an Orchestrator job (null
        // elsewhere — social/resource/index/pipeline firings create
        // no Orchestrator job); no goal firing runs through a
        // workflow, so workflowId is null. The values are identical
        // to the S1 hand-built ones; the resolver is now the one
        // place that derives them, so the write site cannot drift
        // from it.
        const linkage = buildLedgerLinkage({
          payload: {
            scheduleId: goal.id,
            ...(extra.asyncJobId
              ? { asyncJobId: extra.asyncJobId }
              : {}),
            ...(extra.workflowId
              ? { workflowId: extra.workflowId }
              : {}),
          },
          triggeredBy,
        });
        return this.recordJobRun({
          jobId: goal.id,
          operation: goal.operation,
          started: runStarted,
          finished: new Date().toISOString(),
          outcome,
          triggeredBy,
          trigger: linkage.trigger,
          scheduleId: linkage.scheduleId,
          asyncJobId: linkage.asyncJobId,
          workflowId: linkage.workflowId,
          ...(extra.error !== undefined ? { error: extra.error } : {}),
          ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
          ...(extra.descriptor !== undefined
            ? { descriptor: extra.descriptor }
            : {}),
          ...(extra.artifactRefs !== undefined
            ? { artifactRefs: extra.artifactRefs }
            : {}),
        }).then((landed) => {
          // Issue #6293 — a run whose record did not land is silent
          // no-row: `recordJobRun` swallows a storage failure and the
          // firing branches ignored the boolean, so the tick said
          // jobsCreated 1 with no error and no row anywhere. A failed
          // write is a tick error now, so the trigger route and the
          // ledger panel report it instead of a phantom success.
          if (!landed) {
            tick.errors.push(
              `${goal.id}: run record did not land (ledger + legacy store both failed)`,
            );
          }
          return undefined;
        });
      };

      if (goal.executionMode === "agentic-loop") {
        try {
          if (await this.hasPendingAgenticLoopApproval(goal.id)) {
            tick.jobsSkipped++;
            await recordGoalRun("skipped", {
              detail: "agentic-loop continuation is waiting for owner approval",
            });
            continue;
          }
        } catch (error) {
          const detail = `could not read pending agentic-loop approvals: ${
            error instanceof Error ? error.message : String(error)
          }`;
          tick.errors.push(`${goal.id}: ${detail}`);
          tick.jobsSkipped++;
          await recordGoalRun("failure", { error: detail });
          continue;
        }
      }

      // #2840: in-flight firing guard (the screen-lock pattern,
      // extended to goals). A second submission — manual trigger
      // from another browser session, or a cron tick landing
      // while a manual firing runs — is answered "already in
      // flight" with the first run's id, never a duplicate
      // firing. The claim is released in the finally below on
      // every firing exit (including every `continue` inside
      // the branch); only a crashed isolate leaves a marker,
      // which goes stale after GOAL_FIRING_STALE_MS.
      let firingClaim: { claimed: true; runId: string } | null = null;
      try {
        const claim = await claimGoalFiring(this.goalFiringClaims, {
          goalId: goal.id,
          triggeredBy,
          nowMs: Date.now(),
          readMarker: () => this.ctx.storage.get(goalFiringKey(goal.id)),
          writeMarker: (marker) => this.ctx.storage.put(goalFiringKey(goal.id), marker),
        });
        if (!claim.claimed) {
          tick.errors.push(`${goal.id}: already in flight (run ${claim.runId}, status running)`);
          tick.jobsSkipped++;
          await recordGoalRun("skipped", { detail: `already in flight: run ${claim.runId} (status running)` });
          continue;
        }
        firingClaim = claim;
      } catch (err) {
        // A claim that cannot be proven (storage failure) fails
        // this goal's firing visibly — firing without a claim
        // would be exactly the duplicate this guard exists for.
        tick.errors.push(
          `${goal.id}: firing claim failed: ${err instanceof Error ? err.message : String(err)}`
        );
        tick.jobsSkipped++;
        await recordGoalRun("failure", {
          error: `firing claim failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      try {
        // #1779: the shared PaymentsAgentStub (budgetCheck) via the
        // ActorGateway — replaces this site's inline stub type.
        const payments = actorGateway.paymentsStub(env.PAYMENTS_AGENT);
        const budgetOk = await payments.budgetCheck({
          operation: goal.operation,
          amountCents: goal.budgetCents,
          // Issue #2327: name the budget bucket explicitly. The spend
          // these goals gate is executed and recorded under the
          // orchestrator identity (src/payments/ledger.ts attribution
          // contract), so the check names that bucket deliberately —
          // it no longer inherits it from a callee-side default.
          agentId: AGENTIC_SPEND_AGENT_ID,
        });

        if (!budgetOk.allowed) {
          tick.errors.push(`${goal.id}: budget check rejected: ${budgetOk.reason ?? "disallowed"}`);
          tick.jobsSkipped++;
          await recordGoalRun("skipped", { detail: `budget check rejected: ${budgetOk.reason ?? "disallowed"}` });
          continue;
        }

        if (goal.executionMode === "agentic-loop") {
          const outcome = await this.runBoundedAgenticLoop(goal);
          const finishedAt = new Date().toISOString();
          const usageDetail = `used ${outcome.usedModelTokens} provider-reported model tokens across ${outcome.turns} step(s)`;
          if (outcome.status === "completed") {
            goal.lastRun = finishedAt;
            tick.jobsCreated++;
            await recordGoalRun("success", {
              descriptor: "bounded agentic loop completed",
              detail: usageDetail,
            });
          } else if (outcome.status === "approval-required") {
            goal.lastRun = finishedAt;
            tick.jobsSkipped++;
            await recordGoalRun("skipped", {
              detail: `model-token cap reached; continuation awaits owner approval (${outcome.pendingApprovalId}); ${usageDetail}`,
            });
          } else if (outcome.status === "skipped") {
            goal.lastRun = finishedAt;
            tick.jobsSkipped++;
            await recordGoalRun("skipped", {
              detail: `${outcome.detail}; ${usageDetail}`,
            });
          } else {
            tick.errors.push(`${goal.id}: ${outcome.detail}`);
            tick.jobsSkipped++;
            await recordGoalRun("failure", {
              error: `${outcome.detail}; ${usageDetail}`,
            });
          }
          continue;
        }

        const rawEnv = env as unknown as Record<string, string | undefined>;
        if (goal.operation.startsWith("pipeline:")) {
          // #1224: a goal whose operation names a pipeline runs
          // ordered stages back-to-back in ONE firing through the
          // pipeline executor, not the single-operation path. The
          // budget check above already ran exactly once for this
          // goal; the pipeline adds no second check, and the one
          // tick entry for this onCron call records the outcome
          // below. Manual triggerGoal runs the same branch (it
          // calls onCron), so cron and manual firings behave
          // identically. Unknown pipeline ids fail closed: the
          // goal stays due, no orchestrator job is created.
          const stores = createSocialPipelineStoresFromNamespace(
            (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
          );
          if (!stores) {
            tick.errors.push(`${goal.id}: SESSION_STORE binding unavailable, goal left due`);
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: "SESSION_STORE binding unavailable, goal left due" });
            continue;
          }
          if (goal.operation !== SOCIAL_DAILY_PIPELINE_ID) {
            tick.errors.push(`${goal.id}: unknown pipeline: ${goal.operation}`);
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: `unknown pipeline: ${goal.operation}` });
            continue;
          }
          const pipelineResult = await runSocialDailyPipeline({
            // Phase 3 (#6550): the forwarded social env is rendered from
            // environment.config.json via buildSocialEnv; a still-set
            // env var wins. SOCIAL_APPROVAL_CHANNELS stays env-only.
            env: buildSocialEnv(rawEnv),
            tokens: {
              X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
              THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
              FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
              INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
              LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
              LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
            },
            store: stores.store,
            approvals: stores.approvals,
            briefStore: stores.briefStore,
            ledger: stores.ledger,
            nowMs: now.getTime(),
            timeZone: goal.timeZone,
            transport: opts?.socialTransport ?? createFetchSocialTransport(),
            dryRunSink: opts?.socialDryRunSink ?? createMemoryDryRunSink(),
            slackPost: opts?.socialSlackPost,
            slackEnv: rawEnv,
          });
          for (const e of pipelineResult.errors) {
            tick.errors.push(`${goal.id}: ${e}`);
          }
          if (pipelineResult.status === "completed") {
            goal.lastRun = now.toISOString();
            tick.jobsCreated++;
            await recordGoalRun("success", { descriptor: "pipeline completed" });
          } else if (pipelineResult.status === "failed") {
            // Failed: lastRun untouched, the goal stays due and
            // retries on the next tick; a failed run resumes at the
            // first incomplete stage via the pipeline ledger.
            tick.jobsSkipped++;
            await recordGoalRun("failure", { error: pipelineResult.errors.join("; ") || "pipeline failed" });
          } else {
            // Skipped (e.g. noBrief): lastRun untouched, the goal
            // stays due and retries on the next tick; a skipped run
            // starts fresh.
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: `pipeline ${pipelineResult.status}` });
          }
          continue;
        }

        if (goal.operation === "social.publish") {
          // #1077 Phase 5b slice 1: executed directly, never through
          // createJob (there is no orchestrator job for posting).
          const stores = createSocialStoresFromNamespace(
            (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
          );
          if (!stores) {
            tick.errors.push(`${goal.id}: SESSION_STORE binding unavailable, goal left due`);
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: "SESSION_STORE binding unavailable, goal left due" });
            continue;
          }
          // #1077 Phase 5b slice 2: production reads the firing
          // date's brief from the durable brief store (same
          // SESSION_STORE namespace as the draft/approval stores).
          // A test override still wins when one is passed. A read
          // failure throws into the loop's catch below: the error is
          // recorded and the goal stays due for retry — never a
          // silent publish of nothing, and never stale content.
          // The firing date uses the goal's timeZone (default
          // America/New_York), exactly as buildDailyDrafts derives
          // the draft date, so the brief and the drafts cannot
          // disagree about which day they belong to.
          const briefStore = createSocialBriefStoreFromNamespace(
            (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
          );
          const firingDate = zonedDateParts(now.getTime(), goal.timeZone ?? "America/New_York").date;
          const storedBrief = briefStore ? await briefStore.getBrief(firingDate) : null;
          const result = await executeSocialGoal({
            // Phase 3 (#6550): the forwarded social env is rendered from
            // environment.config.json via buildSocialEnv; a still-set
            // env var wins. SOCIAL_APPROVAL_CHANNELS stays env-only.
            env: buildSocialEnv(rawEnv),
            tokens: {
              X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
              THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
              FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
              INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
              LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
              LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
            },
            store: stores.ledger,
            approvals: stores.approvals,
            briefProvider: opts?.socialBriefProvider ?? (() => storedBrief),
            nowMs: now.getTime(),
            timeZone: goal.timeZone,
            transport: opts?.socialTransport ?? createFetchSocialTransport(),
            dryRunSink: opts?.socialDryRunSink ?? createMemoryDryRunSink(),
          });
          if (!result.fired) {
            // lastRun untouched: the goal stays due and retries on the
            // next tick (noBrief, posting off, or no drafts produced).
            // #1077 Phase 5b slice 3: delivery still runs below for a
            // not-fired tick (except posting disabled) — delivery is
            // independent of the day's brief, and a noBrief tick can
            // still carry undelivered backlog.
            if (isForced || (result.reason && result.reason !== "noBrief")) {
              tick.errors.push(`${goal.id}: skipped (${result.reason ?? "not fired"})`);
            }
            tick.jobsSkipped++;
          } else {
            for (const r of result.publish.results) {
              if (r.outcome === "error") {
                tick.errors.push(`${goal.id}: ${r.channel}: ${r.reason}`);
              }
            }
            for (const entry of result.catchUp) {
              for (const r of entry.results) {
                if (r.outcome === "error") {
                  tick.errors.push(`${goal.id}: catch-up ${entry.date} ${r.channel}: ${r.reason}`);
                }
              }
            }
            goal.lastRun = now.toISOString();
            tick.jobsCreated++;
          }
          // #1077 Phase 5b slice 3: approval-card delivery pass.
          // Runs after the goal execution on every social tick except
          // posting-disabled (the kill switch gates delivery too),
          // over the firing date plus the catch-up lookback, so a
          // card recorded late in the day is still delivered that
          // night. Idempotent per (date, channel, draftId): a second
          // pass skips already-delivered records. Delivery failures
          // are tick errors — non-fatal, never unfiring the goal —
          // and the undelivered record retries on the next pass.
          // When NO Slack destination is configured at all (neither
          // webhook nor bot token), the pass is skipped silently:
          // Slack delivery is opt-in by configuration, and the
          // session-gated route remains the approval path. A
          // configured destination that fails DOES record errors.
          const slackConfigured = rawEnv.SLACK_WEBHOOK_URL || rawEnv.SLACK_BOT_TOKEN;
          if (slackConfigured && (result.fired || result.reason !== "postingDisabled")) {
            const deliveries = await deliverPendingApprovals({
              store: stores.ledger,
              approvals: stores.approvals,
              dates: [firingDate, ...priorDates(firingDate)],
              post: opts?.socialSlackPost ?? fetchSlackPost,
              env: rawEnv,
            });
            for (const d of deliveries) {
              if (d.error) {
                tick.errors.push(`${goal.id}: slack delivery ${d.channel} ${d.date}: ${d.error}`);
              }
            }
          }
          if (!result.fired) {
            await recordGoalRun("skipped", { detail: `skipped (${result.reason ?? "not fired"})` });
          } else {
            const publishErrors = [
              ...result.publish.results.filter((r) => r.outcome === "error"),
              ...result.catchUp.flatMap((entry) => entry.results.filter((r) => r.outcome === "error")),
            ];
            await recordGoalRun("success", {
              descriptor:
                publishErrors.length > 0
                  ? `social post fired; ${publishErrors.length} channel errors (see tick errors)`
                  : "social post fired",
            });
          }
          continue;
        }

        if (
          goal.operation === "resource.rollup_daily" ||
          goal.operation === "resource.cap_alert" ||
          goal.operation === "resource.dashboard_comparison"
        ) {
          // #1819 rollup slice: resource goals execute directly through
          // the resource goal handlers (the social.publish precedent),
          // never through createJob — createJob mints a pending
          // descriptor and executes nothing. The catalog entry exists
          // so addGoal accepts these operations.
          //
          // AGENT_DB unbound means there is no projection to query:
          // fail visible, goal stays due, never stamp a success.
          const rawDb = (env as unknown as { AGENT_DB?: D1Database }).AGENT_DB;
          const db = rawDb ? createD1ResourceDb(rawDb) : undefined;
          if (!db) {
            tick.errors.push(`${goal.id}: AGENT_DB binding unavailable, goal left due`);
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: "AGENT_DB binding unavailable, goal left due" });
            continue;
          }
          if (goal.operation === "resource.rollup_daily") {
            // Issue #5082 (S2): the rollup is absorbed as the
            // first metric — the rollup goal hands its rows to
            // the metrics recorder (the same rows it wrote to
            // D1), and the batch is flushed so the metrics
            // export promptly. The metrics handle is built per
            // tick (the rollup runs once a day) and shut down
            // after the flush; a metrics failure never fails
            // the rollup goal (the recorder is best-effort).
            const otelMetrics = createOtelMetrics(env);
            try {
              await runResourceRollup({
                db,
                nowMs: now.getTime(),
                metrics: otelMetrics.recorder,
              });
              await otelMetrics.flush();
            } finally {
              await otelMetrics.shutdown().catch(() => {
                // Best-effort teardown.
              });
            }
            goal.lastRun = now.toISOString();
            tick.jobsCreated++;
            await recordGoalRun("success", { descriptor: "rollup complete" });
            continue;
          }
          if (goal.operation === "resource.cap_alert") {
            // The alert branch NEVER stamps lastRun, deliberately:
            // isDue's 23h guard would otherwise suppress hourly
            // evaluation for 23h after any stamp. Sub-daily goals
            // work through the #4235 opt-in's per-tick guard, not
            // through lastRun stamping. Delivery dedup lives in
            // alert state per (budget, day), not in goal state — so
            // both the :00 and :30 ticks match the hourly cron
            // (minute-tolerance rule) and the second evaluation is
            // a deduped no-op.
            const result = await runResourceCapAlert({
              db,
              nowMs: now.getTime(),
              post: opts?.resourceSlackPost ?? fetchSlackPost,
              env: rawEnv,
            });
            for (const u of result.undelivered) {
              tick.errors.push(`${goal.id}: alert delivery failed (${u.budget}): ${u.error}`);
            }
            for (const n of result.noDestination) {
              tick.errors.push(
                `${goal.id}: alert undeliverable — no Slack destination configured (${n.budget}); recorded in alert state`
              );
            }
            if (result.undelivered.length > 0) {
              // Delivery attempted and failed: state unmarked, so the
              // next matching tick retries. lastRun untouched by
              // design (see above).
              tick.jobsSkipped++;
              await recordGoalRun("skipped", {
                detail: `alert delivery failed (${result.undelivered.map((u) => u.budget).join(", ")})`,
              });
            } else {
              tick.jobsCreated++;
              // The record, not lastRun, is this branch's success
              // signal — lastRun stays unstamped by design (see
              // above), which used to leave hourly alert runs
              // unobservable run by run.
              await recordGoalRun("success", { descriptor: "alert evaluated" });
            }
            continue;
          }
          // resource.dashboard_comparison: latest completed rollup day,
          // so a forced evaluation reproduces the scheduled run
          // exactly (same rows, same report JSON).
          const result = await runResourceComparison({ db });
          if ("skipped" in result) {
            // Expected transient state before the first rollup lands;
            // no tick error (the rollup goal's own errors surface a
            // real breakage), goal stays due and retries tomorrow.
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: "no completed rollup yet" });
            continue;
          }
          goal.lastRun = now.toISOString();
          tick.jobsCreated++;
          await recordGoalRun("success", { descriptor: "comparison complete" });
          continue;
        }

        if (
          goal.operation === "index.refresh_wikipedia" ||
          goal.operation === "index.refresh_holdings" ||
          goal.operation === "index.refresh_listings"
        ) {
          // #1980 index-list refresh goals execute directly
          // through the refresh job (the social.publish /
          // resource.* precedent), never through createJob —
          // createJob mints a pending descriptor and executes
          // nothing. The catalog entry exists so addGoal accepts
          // these operations.
          //
          // An injected executor wins (tests; a caller that
          // already owns a store + fetchers). Otherwise the
          // Wikipedia goal runs its production path: D1 store
          // via AGENT_DB (the resource-goal binding read) +
          // global fetch over the #1852 adapter's own Wikipedia
          // URLs — the fetcher is fetch(url).text(), the URLs
          // are the adapter's, nothing invented. The listings
          // goal (#5956) runs the same production path with the
          // listings-derived adapter bound to the live listings
          // feed — its fetcher IS bound in code, so the goal is
          // executable (its built-in entry is a follow-up
          // activation). The holdings
          // goal has no production fetcher binding in code (no
          // ETF holdings-file URL is established anywhere in
          // the repo): it fails visibly and stays due instead
          // of fetching from an invented URL, and it ships
          // DISABLED in the built-in goals config until the binding
          // lands (see src/config/builtinScheduledGoals.ts). An all-failed job
          // throws into the loop's catch below: tick error,
          // goal stays due — the feed job's rule. A partial
          // job stamps lastRun with its failures named as tick
          // errors: the run happened, the fed indices are
          // stored, and the next cadence re-fetches the failed
          // ones (no retry storm inside one tick).
          let refreshResult: IndexListJobResult;
          if (opts?.indexRefreshExecutor) {
            refreshResult = await opts.indexRefreshExecutor(
              goal.operation as IndexRefreshOperation,
            );
          } else if (goal.operation === "index.refresh_holdings") {
            tick.errors.push(
              `${goal.id}: holdings fetcher not bound — no ETF holdings-file fetcher is bound in this deployment, goal left due`,
            );
            tick.jobsSkipped++;
            await recordGoalRun("skipped", {
              detail: "holdings fetcher not bound — no ETF holdings-file fetcher is bound in this deployment, goal left due",
            });
            continue;
          } else {
            const db = (env as unknown as { AGENT_DB?: unknown }).AGENT_DB;
            if (!db) {
              tick.errors.push(`${goal.id}: AGENT_DB binding unavailable, goal left due`);
              tick.jobsSkipped++;
              await recordGoalRun("skipped", { detail: "AGENT_DB binding unavailable, goal left due" });
              continue;
            }
            const { createD1IndexListDb, D1IndexListStore } = await import(
              "../data/d1IndexListAdapter"
            );
            const {
              createIndexMembershipService,
              createListingsDerivedIndexMembershipAdapter,
              createWikipediaIndexMembershipAdapter,
            } = await import("../trading");
            const {
              createIndexListRefreshExecutor,
              fetchWikipediaIndexHtml,
            } = await import("../services/indexListJob");
            const { fetchAllUsStockListings } = await import(
              "../services/nasdaqListings"
            );
            const service = createIndexMembershipService({
              wikipedia: createWikipediaIndexMembershipAdapter(fetchWikipediaIndexHtml),
              holdings: {
                getMembers: async () => {
                  throw new Error(
                    "holdings fetcher not bound — the Wikipedia refresh path never calls it",
                  );
                },
              },
              // #5956 — the listings-derived adapter (tech / etf /
              // lev_etf): bound for real, never a stub — the
              // listings goal refreshes through it.
              listings: createListingsDerivedIndexMembershipAdapter(
                fetchAllUsStockListings,
              ),
            });
            refreshResult = await createIndexListRefreshExecutor({
              store: new D1IndexListStore(createD1IndexListDb(db as D1Database)),
              service,
            })(goal.operation as IndexRefreshOperation);
          }
          for (const f of refreshResult.failures) {
            tick.errors.push(`${goal.id}: ${f.index}: ${f.error}`);
          }
          goal.lastRun = now.toISOString();
          tick.jobsCreated++;
          await recordGoalRun("success", {
            descriptor:
              refreshResult.failures.length > 0
                ? `stored ${refreshResult.artifacts.length} index lists; failed: ${refreshResult.failures.map((f) => f.index).join(", ")}`
                : `stored ${refreshResult.artifacts.length} index lists`,
          });
          continue;
        }

        if (goal.operation === "autopilot.evaluate") {
          // #4411 monthly Autopilot evaluation: executes directly
          // through the existing POST /api/autopilot/evaluate path
          // (the social.publish / resource.* / index.* precedent),
          // never through createJob — createJob mints a pending
          // descriptor and executes nothing. The catalog entry
          // exists so addGoal accepts the operation.
          //
          // An injected executor wins (tests; a caller that already
          // owns an evaluate path). Otherwise the production path
          // resolves the configured service identity and posts the
          // representative dry-run intent through the OrchestratorAgent
          // stub (the postGoalScheduleAuditEvent precedent: stub
          // fetch over https://agent.internal). A missing service
          // identity or a missing ORCHESTRATOR_AGENT binding fails
          // visibly and leaves the goal due (the feed job's rule);
          // an executor throw propagates to the loop's catch below:
          // tick error, goal stays due.
          let evaluation: AutopilotMonthlyEvaluationResult;
          if (opts?.autopilotEvaluateExecutor) {
            evaluation = await opts.autopilotEvaluateExecutor(goal);
          } else {
            const serviceLogin = getServiceUserLogin(env);
            let evaluateFetch: ((req: Request) => Promise<Response>) | null = null;
            try {
              const orchestrator = actorGateway.stub<DoStubLike>(
                env.ORCHESTRATOR_AGENT,
                SHARED_ORCHESTRATOR_INSTANCE,
              );
              evaluateFetch = (req: Request) => orchestrator.fetch(req);
            } catch {
              evaluateFetch = null;
            }
            evaluation = await runAutopilotMonthlyEvaluation({
              serviceLogin,
              evaluateFetch,
            });
          }
          if (!evaluation.ok) {
            tick.errors.push(`${goal.id}: ${evaluation.error}`);
            tick.jobsSkipped++;
            await recordGoalRun("skipped", {
              detail: evaluation.error ?? "monthly Autopilot evaluation failed",
            });
            continue;
          }
          goal.lastRun = now.toISOString();
          tick.jobsCreated++;
          await recordGoalRun("success", {
            descriptor: evaluation.descriptor ?? "monthly policy check complete",
          });
          continue;
        }

        if (goal.operation === CHAIN_EXECUTE_OPERATION) {
          // #1517 (Lane 1) + #1523 (Lane 2): a materialized chain
          // goal fires ONLY through the governed decision. The
          // budget check above already ran for this goal; this
          // branch adds the record lookup + governed gate, then —
          // when the caller supplied a leg executor — runs the
          // chain's legs for real BEFORE any job descriptor is
          // created. A failed run stamps nothing and leaves the
          // goal due; a successful run creates the descriptor
          // exactly like every other goal, stamps goal + record
          // so the due window fires once, and (with sql) writes
          // the #755 success audit lane 1 left open. No executor
          // supplied = lane 1 behavior exactly: descriptor only,
          // no legs claimed. Ordering note: legs run before the
          // descriptor, so a descriptor-creation failure after a
          // successful run leaves the legs run but unstamped —
          // the tick error names it, and the next tick retries.
          const records = await this.getSynthesized();
          const record = records.find((r) => r.id === goal.id);
          if (!record) {
            tick.errors.push(
              `${goal.id}: no synthesized record for chain goal — refusing to fire, goal left due`,
            );
            tick.jobsSkipped++;
            await recordGoalRun("skipped", {
              detail: "no synthesized record for chain goal — refusing to fire, goal left due",
            });
            continue;
          }
          const decision = decideChainFiring(record, now, {
            halted: governedHalted,
          });
          if (!decision.fire) {
            tick.errors.push(
              `${goal.id}: chain firing blocked (${decision.reason})`,
            );
            if (opts?.sql) {
              try {
                auditBlockedChainFiring(opts.sql, record, decision.reason, now);
              } catch (err) {
                tick.errors.push(
                  `${goal.id}: blocked-firing audit failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            tick.jobsSkipped++;
            await recordGoalRun("skipped", { detail: `chain firing blocked (${decision.reason})` });
            continue;
          }
          let runResult: ChainRunResult | null = null;
          if (opts?.chainExecutor) {
            runResult = await this.executeChainForRecord(
              chainFromRecord(record),
              opts.chainExecutor,
              {
                chainId: record.id,
                tenantId: tickTenantId,
                writer: "scheduled-agent:onCron",
              },
            );
            if (!runResult.ok) {
              const failed = runResult.legs.filter(
                (l) => l.status === "failed" || l.status === "blocked",
              );
              tick.errors.push(
                `${goal.id}: chain execution failed (${failed
                  .map((l) => `${l.capabilityId}: ${l.detail}`)
                  .join("; ")})`,
              );
              tick.jobsSkipped++;
              await recordGoalRun("failure", {
                error: `chain execution failed (${failed
                  .map((l) => `${l.capabilityId}: ${l.detail}`)
                  .join("; ")})`,
              });
              continue;
            }
          }
          const { createJob } = await import("../orchestrate");
          const job = await createJob(env, {
            goalId: goal.id,
            goalName: goal.name,
            operation: goal.operation,
            budgetCents: goal.budgetCents,
          });
          await this.saveSynthesized(
            records.map((r) =>
              r.id === record.id
                ? markSynthesizedFired(r, now.toISOString())
                : r,
            ),
          );
          goal.lastRun = now.toISOString();
          tick.jobsCreated++;
          await recordGoalRun("success", { descriptor: `job:${job.jobId}`, asyncJobId: job.jobId });
          // Success audit only when every leg completed or was
          // submitted to the rails: a run with unimplemented legs
          // (e.g. deliver awaiting the serve hook) has no complete
          // outcome to attest yet, so no row is written for it.
          if (runResult && opts?.sql && runResult.legs.every(
            (l) => l.status === "completed" || l.status === "submitted",
          )) {
            try {
              auditSuccessfulChainFiring(
                opts.sql,
                record,
                shardProvenanceOf(runResult),
                now,
              );
            } catch (err) {
              tick.errors.push(
                `${goal.id}: success audit failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          continue;
        }

        // Issue #3652: the opportunity hunt is not a descriptor-only job —
        // it runs and records what it found. Registering the operation
        // without this branch would have turned the old failure into a
        // green row that did nothing.
        if (goal.operation === OPPORTUNITY_HUNT_OPERATION) {
          const hunt = await this.huntOpportunities(now);
          goal.lastRun = now.toISOString();
          tick.jobsCreated++;
          await recordGoalRun("success", { descriptor: hunt.summary });
          continue;
        }

        const { createJob } = await import("../orchestrate");
        const job = await createJob(env, {
          goalId: goal.id,
          goalName: goal.name,
          operation: goal.operation,
          budgetCents: goal.budgetCents,
        });

        goal.lastRun = now.toISOString();
        tick.jobsCreated++;
        await recordGoalRun("success", { descriptor: `job:${job.jobId}`, asyncJobId: job.jobId });
      } catch (err) {
        tick.errors.push(
          `${goal.id}: ${err instanceof Error ? err.message : String(err)}`
        );
        tick.jobsSkipped++;
        await recordGoalRun("failure", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // #2840: release only the claim this firing holds; the
        // release overwrites the marker with status "completed"
        // via put (best-effort — a failed write leaves a
        // "running" marker the stale window reaps), so it needs
        // no delete method on the storage.
        if (firingClaim) {
          await releaseGoalFiring(this.goalFiringClaims, {
            goalId: goal.id,
            runId: firingClaim.runId,
            writeMarker: (marker) => this.ctx.storage.put(goalFiringKey(goal.id), marker),
          });
        }
      }
    }

    // Issue #3788: the goals watchdog runs at the end of every tick —
    // a missed firing is an explicit, alerted signal, not a panel
    // reading "never". Best-effort: a watchdog failure is a tick
    // error, never a tick failure.
    try {
      const watchdog = await this.runScheduleWatchdog(now, goals, opts);
      for (const error of watchdog.errors) tick.errors.push(error);
    } catch (err) {
      tick.errors.push(
        `schedule watchdog failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.saveGoals(goals, records);
    await this.recordTick(tick);
    // Issue #4234 (ADR 0030) — alarm ticks only: the tick's riders
    // and daily due-checks ride the alarm firing. Best-effort: the
    // riders' observer and the due-check runner already swallow
    // their own failures, and anything else here is logged, never
    // thrown — the goal tick above already recorded.
    if (isAlarmTick && alarmUserLogin !== null) {
      try {
        await this.runAlarmTickWork(alarmUserLogin);
      } catch (error) {
        structuredLog.error("scheduledAgent.heartbeat_tick_work_failed", {
          message:
            "[ScheduledAgent][onCron] Heartbeat tick work failed (the goal tick stands):",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return tick;
  }

  /**
   * Issue #4234 (ADR 0030) — the alarm tick's extra work: the six
   * piggyback rider dispatches. Runs after the goal tick records, so a
   * failure here never un-records the tick. Issue #6503 — the daily
   * due-checks (token renewal + retention) are RETIRED: those duties
   * are real stored schedules now, fired through their entry points
   * when the stored schedule fires, never from this tick.
   */
  private async runAlarmTickWork(userLogin: string): Promise<void> {
    const env = this.env;
    const orchestrator = actorGateway.stub<DoStubLike>(
      env.ORCHESTRATOR_AGENT,
      SHARED_ORCHESTRATOR_INSTANCE,
    );
    await dispatchTickRiders({
      userLogin,
      orchestratorFetch: (request) => orchestrator.fetch(request),
      createSink: () => createObservabilitySink(env),
      dispatchAndAwait: async (promise) => {
        await promise;
      },
      slackPoster: async (text: string) => {
        await postSlackText({ post: fetchSlackPost, env, text });
      },
    });
  }

  /**
   * Issue #4253 — the durable removal record for built-in goals.
   * Removing a built-in goal is an owner decision that must survive
   * a re-seed and a redeploy. Issue #6503 — the live record is the
   * D1 `deleted` tombstone row (written by saveGoals on removal);
   * this `\"removedBuiltinGoals\"` KV key is LEGACY-READ-ONLY: it
   * guards pre-cutover removals, whose ids have no D1 row yet, and
   * nothing writes it anymore (removeGoal no longer appends; addGoal
   * still clears an entry on explicit re-add, so the owner can always
   * bring a goal back on purpose). The seed rule
   * (`seedableBuiltinGoals`) and the Seed-all button (via GET
   * /api/schedule/builtin-goals) subtract this list plus the D1
   * `deleted` ids.
   */
  private async getRemovedBuiltinGoalIds(): Promise<string[]> {
    const stored = await this.ctx.storage
      .get<string[]>("removedBuiltinGoals")
      .catch(() => undefined);
    if (!Array.isArray(stored)) return [];
    return stored.filter((id): id is string => typeof id === "string");
  }

  private async setRemovedBuiltinGoalIds(ids: string[]): Promise<void> {
    await this.ctx.storage.put("removedBuiltinGoals", [...ids]);
  }

  /** The config's built-in goals minus the owner-removed ones: what a seed may plant. */
  private async seedableBuiltinGoals(deletedIds?: Set<string>): Promise<ScheduledGoal[]> {
    const removed = new Set([
      ...(await this.getRemovedBuiltinGoalIds()),
      ...(deletedIds ?? []),
    ]);
    return getBuiltinScheduledGoals().filter((goal) => !removed.has(goal.id));
  }

  /** Owner-removed built-in goal ids, in removal order. */
  async listRemovedBuiltinGoalIds(): Promise<string[]> {
    const kv = await this.getRemovedBuiltinGoalIds();
    // Issue #6503 — the D1 `deleted` rows are the live removal record;
    // the KV list is legacy (pre-cutover removals) and read-only.
    const store = await this.unifiedScheduleStore();
    const deleted = await store.listByState("deleted");
    const ids = [...kv];
    for (const record of deleted) {
      if (record.kind === "goal" && !ids.includes(record.id)) ids.push(record.id);
    }
    return ids;
  }

  /** List all scheduled goals. */
  async listGoals(): Promise<ScheduledGoal[]> {
    return this.getGoals();
  }

  /** Recent cron tick history, newest first. */
  async getTickHistory(limit: number = 20): Promise<ScheduleTick[]> {
    const history = await this.getTicks();
    return history.slice(0, Math.max(1, Math.min(50, limit)));
  }

  /**
   * Issue #4234 (ADR 0030) — the heartbeat re-arm primitive: the
   * #618/#3788 ensure-pattern for the recurring `onCron` alarm.
   * Skip when an `onCron` schedule already exists; `scheduleEvery`
   * when absent; on force, cancel the existing `onCron` schedules
   * only (other callbacks are left alone) and re-create. The SDK's
   * `scheduleEvery` is itself idempotent, so calling this from
   * `onStart` is safe. Refuses a non-positive interval instead of
   * arming a broken alarm.
   */
  async ensureHeartbeatAlarm(
    intervalSeconds: number,
    opts?: { force?: boolean },
  ): Promise<{ armed: boolean; alreadyArmed: boolean }> {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error(
        "heartbeat interval must be a positive number of seconds",
      );
    }
    const existing = await this.listSchedules();
    const heartbeat = existing.filter(
      (schedule) => schedule.callback === HEARTBEAT_ALARM_CALLBACK,
    );
    if (heartbeat.length > 0 && !opts?.force) {
      return { armed: false, alreadyArmed: true };
    }
    if (opts?.force) {
      for (const schedule of heartbeat) {
        await this.cancelSchedule(schedule.id);
      }
    }
    await this.scheduleEvery(
      intervalSeconds,
      HEARTBEAT_ALARM_CALLBACK,
      {},
    );
    return { armed: true, alreadyArmed: false };
  }

  /**
   * Issue #3121 S3 (S3-P07) — the ONE audit poster call site: every
   * schedule audit event posts through this helper to the one
   * `mas_events` funnel (the orchestrator's `POST /api/audit/event`
   * via the ORCHESTRATOR_AGENT stub on the shared instance) — the
   * goal-lifecycle sink (auditGoalLifecycle below) and the
   * capability executor's audit dep (agentScheduleExecutorDeps)
   * alike, so no second audit system can creep in as a second
   * poster. Best-effort (the auditGoalLifecycle swallow rule): a
   * missing binding or a failed post never fails the action it
   * records. Callers choose await (lifecycle sink, so the event
   * lands before the mutation returns) vs void (executor dep,
   * fire-and-forget).
   */
  private async postScheduleAuditEvent(event: {
    type: string;
    agent: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      const auditAgent = actorGateway.stub<DoStubLike>(
        this.env.ORCHESTRATOR_AGENT,
        SHARED_ORCHESTRATOR_INSTANCE,
      );
      await postGoalScheduleAuditEvent((req) => auditAgent.fetch(req), event);
    } catch {
      // Best-effort audit: a missing binding or a failed post
      // must never fail the action it records.
    }
  }

  /**
   * Issue #3121 S3 (#3312) — the DO-side goal-lifecycle audit sink.
   *
   * S1 wired the four `schedule.goal.*` events at the
   * `/api/schedule/goals` route funnel in `src/server/routes/
   * trading.ts`; the A2A dispatch path (`handleA2A` → these methods
   * directly) bypassed it, so agent-driven goal mutations left no
   * lifecycle audit event. The sink moves INTO the mutation methods
   * (`addGoal` / `removeGoal` / `setGoalEnabled` / `triggerGoal`
   * below) — the one funnel every entry path flows through, so a
   * future entry path is audited by construction and no call site
   * can forget it. The route funnel is retired (S3): the route
   * threads the session actor into the methods instead of posting
   * its own event, so each mutation still emits exactly one event
   * with the same shape S1 pins.
   *
   * The sink is the same `mas_events` funnel S1 used — the
   * orchestrator's `POST /api/audit/event` via the ORCHESTRATOR_AGENT
   * stub (the DO-side precedent is the wallet scanner's
   * `persistAudit`, same channel, same instance). The stub is
   * built lazily inside the call, so a caller whose env binds no
   * ORCHESTRATOR_AGENT never touches the binding; the poster never
   * throws and the whole call is swallowed — the `this.audit`
   * swallow rule — so an audit failure can never fail the mutation
   * it records.
   */
  private async auditGoalLifecycle(
    event: GoalScheduleAuditEvent,
    goalId: string,
    extra?: {
      operation?: string;
      enabled?: boolean;
      /** Issue #3788: the missed-fire finding's expected tick (ISO). */
      expectedTick?: string;
      /** Issue #3788: the goal's last run (ISO), or null when never. */
      lastRun?: string | null;
      /** Issue #3788: the finding code (missed_fire / invalid_cron). */
      code?: string;
    },
    actor?: string | null,
  ): Promise<void> {
    if (!goalId) return;
    await this.postScheduleAuditEvent(
      buildGoalScheduleAuditEvent({
        event,
        goalId,
        actor: actor ?? undefined,
        ...extra,
      }),
    );
  }

  /**
   * Add a new scheduled goal. The operation must exist in the
   * orchestrate.ts catalog; the cron expression uses five fields with
   * lists, ranges, and steps in every field ("0 9 * * 1-5"). An
   * optional IANA timeZone reads the cron wall-clock in that zone;
   * without one the historical UTC behavior applies.
   */
  async addGoal(goal: {
    id: string;
    name: string;
    cron: string;
    operation: string;
    budgetCents: number;
    enabled?: boolean;
    executionMode?: "deterministic" | "agentic-loop";
    timeZone?: string;
    provenance?: unknown;
    /**
     * Issue #4235 — explicit owner opt-in to a sub-daily cadence
     * for this goal. Without it a sub-daily cron is refused (the
     * default is at most once per day); with it the opt-in is
     * recorded on the goal and the tick's per-tick guard applies.
     */
    subDailyOptIn?: boolean;
    /**
     * Issue #3121 S3 (#3312) — the acting principal for the
     * lifecycle audit event, threaded by the entry path (the
     * session login on the route path, the edge-authenticated
     * caller on the A2A path). Validated, never trusted raw: a
     * non-string actor is dropped, never recorded.
     */
    actor?: unknown;
  }): Promise<ScheduledGoal> {
    const id = goal.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!id) throw new Error("Goal id is required.");
    if (!goal.name.trim()) throw new Error("Goal name is required.");
    if (!isValidCron(goal.cron.trim())) {
      throw new Error("Cron must be a valid 5-field cron expression (e.g. '0 6 * * *').");
    }
    let timeZone: string | undefined;
    if (goal.timeZone !== undefined && goal.timeZone !== "") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: goal.timeZone });
        timeZone = goal.timeZone;
      } catch {
        throw new Error(`Invalid timeZone: ${goal.timeZone}`);
      }
    }
    if (!Number.isFinite(goal.budgetCents) || goal.budgetCents <= 0) {
      throw new Error("budgetCents must be a positive number.");
    }
    // Issue #3121 Phase 2 (#3124) — single evaluation scan: the
    // save below reuses this load's snapshot.
    const { goals, records } = await this.loadGoalRecords();
    if (goals.some((g) => g.id === id)) throw new Error(`Goal already exists: ${id}`);
    const { OPERATION_CATALOG } = await import("../orchestrate");
    const known = OPERATION_CATALOG.some((e) => e.operations.includes(goal.operation));
    if (!known) throw new Error(`Unknown operation: ${goal.operation}`);
    // Issue #4235 — granularity first: the default is at most once
    // per day. A sub-daily cron needs the explicit per-schedule
    // opt-in, recorded on the goal below. Checked after the
    // operation check so an unknown operation still reports as such.
    const subDailyOptIn = goal.subDailyOptIn === true;
    if (isSubDailyCron(goal.cron.trim()) && !subDailyOptIn) {
      throw new Error(
        `Sub-daily cron '${goal.cron.trim()}' runs more than once per day: pass subDailyOptIn: true to opt-in explicitly.`,
      );
    }
    // Issue #3121 S1 — creation provenance travels with the goal.
    // Validated, never trusted raw: a malformed stamp is dropped,
    // and a goal created without one simply has none ("not
    // recorded", never backfilled).
    const provenance = provenanceFromPayload(goal);
    if (goal.executionMode === "agentic-loop") {
      const ownerLogin = provenance?.createdBy;
      if (typeof ownerLogin !== "string" || !ownerLogin.trim()) {
        throw new Error("Agentic-loop schedules require a recorded owner login.");
      }
      const resolution =
        await this.getAgentScheduleLoopSettingsForLogin(ownerLogin);
      if (!resolution.settings?.enabled) {
        throw new Error(
          resolution.settings
            ? "Agentic-loop scheduling is disabled by the owner-managed kill switch."
            : resolution.issues.join("; ") ||
                "Agentic-loop scheduling requires valid owner-managed bounds.",
        );
      }
    }
    const actor =
      typeof goal.actor === "string" && goal.actor.trim()
        ? goal.actor
        : undefined;
    const created: ScheduledGoal = {
      id,
      name: goal.name.trim(),
      cron: goal.cron.trim(),
      operation: goal.operation,
      budgetCents: Math.floor(goal.budgetCents),
      enabled: goal.enabled !== false,
      executionMode: goal.executionMode ?? "deterministic",
      ...(timeZone ? { timeZone } : {}),
      ...(provenance ? { provenance } : {}),
      // Issue #4235 — the opt-in is recorded only when it was
      // needed (a sub-daily cron): a daily goal never carries it.
      ...(subDailyOptIn && isSubDailyCron(goal.cron.trim()) ? { subDailyOptIn: true } : {}),
    };
    goals.push(created);
    await this.saveGoals(goals, records);
    // Issue #4253 — an explicit re-add of a removed built-in goal
    // wins over the removal record: the goal comes back and stays
    // back, so the record entry is cleared now that it is saved.
    if (isBuiltinScheduledGoalId(created.id)) {
      const removed = await this.getRemovedBuiltinGoalIds();
      if (removed.includes(created.id)) {
        await this.setRemovedBuiltinGoalIds(
          removed.filter((id) => id !== created.id),
        );
      }
    }
    // Issue #3121 S3 (#3312) — the lifecycle event is emitted by
    // the mutation, not the route: every entry path (route, A2A,
    // mesh door) flows through here. Best-effort; a failed audit
    // never fails the add (the goal is already saved).
    await this.auditGoalLifecycle(
      "schedule.goal.added",
      created.id,
      { operation: created.operation },
      actor,
    );
    return created;
  }

  /** Remove a scheduled goal by ID. */
  async removeGoal(id: string, actor?: string | null): Promise<boolean> {
    // Issue #3121 Phase 2 (#3124) — single evaluation scan: the
    // snapshot is taken before the splice, so the save still finds
    // the removed row and deletes it — one scan, same removal.
    const { goals, records } = await this.loadGoalRecords();
    const idx = goals.findIndex((g: ScheduledGoal) => g.id === id);
    if (idx < 0) return false;
    goals.splice(idx, 1);
    await this.saveGoals(goals, records);
    // Issue #6503 — removing a built-in goal is a durable owner
    // decision, recorded as a D1 `deleted` tombstone by saveGoals
    // above — the seed rule subtracts `deleted` ids, so the goal never
    // resurrects. The `#4253` KV list is legacy-read-only (pre-cutover
    // removals); nothing writes it anymore. Removing a user goal
    // records nothing.
    // Issue #3121 S3 (#3312) — only an actual removal is a
    // lifecycle event; a miss is a state answer, not an event.
    await this.auditGoalLifecycle("schedule.goal.removed", id, undefined, actor);
    return true;
  }

  /** Enable or disable a goal by ID. */
  async setGoalEnabled(
    id: string,
    enabled: boolean,
    actor?: string | null,
  ): Promise<boolean> {
    // Issue #3121 Phase 2 (#3124) — single evaluation scan: the
    // save below reuses this load's snapshot.
    const { goals, records } = await this.loadGoalRecords();
    const goal = goals.find((g: ScheduledGoal) => g.id === id);
    if (!goal) return false;
    goal.enabled = enabled;
    await this.saveGoals(goals, records);
    // Issue #3121 S3 (#3312) — only an actual state change is a
    // lifecycle event; a miss is a state answer, not an event.
    await this.auditGoalLifecycle(
      "schedule.goal.enabled",
      id,
      { enabled },
      actor,
    );
    return true;
  }

  /**
   * Issue #2223 (final slice): A2A door, cfpay signature — the edge
   * dispatcher (src/a2a) resolves the "scheduled" name to this
   * class on the LIVE "default" instance (never the bare name: a
   * virgin instance would seed the built-in goals config and serve
   * plausible-looking wrong state) and calls this with the parsed
   * body + origin (a Request cannot cross the DO RPC boundary).
   * Thin delegation to the dispatch module (./scheduledA2aDispatch);
   * the bound methods are injected here because they are
   * class-bound. Returns the collected { text, data } outcome.
   */
  async handleA2A(
    body: unknown,
    origin: string,
    attribution?: { caller?: string } | null,
  ): Promise<ScheduledA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    // Issue #3121 S3 (#3312) — the A2A actor for the lifecycle audit
    // events the mutation methods emit: the edge-authenticated
    // caller identity (`a2a-credential:<surface>`, two-part
    // attribution, #2426 S16), threaded into the bound methods.
    // Reads carry no actor. A missing/blank caller records no actor
    // — never an invented one.
    const actor =
      typeof attribution?.caller === "string" && attribution.caller.trim()
        ? attribution.caller
        : undefined;
    const data = await dispatchScheduledA2A(this.env, body, {
      executor: {
        listGoals: () => this.listGoals(),
        getTickHistory: (limit) => this.getTickHistory(limit),
        addGoal: (goal) => this.addGoal({ ...goal, actor }),
        removeGoal: (id) => this.removeGoal(id, actor),
        setGoalEnabled: (id, enabled) => this.setGoalEnabled(id, enabled, actor),
        triggerGoal: (id) => this.triggerGoal(id, undefined, actor),
      },
    });
    return scheduledA2AOutcome(data);
  }

  /**
   * Issue #1446 ([AGENTIC] Phase 3): synthesized-schedule storage.
   *
   * Synthesized records live under the `synthesizedSchedules` DO key,
   * NEVER under the `goals` key — `onCron`/`triggerGoal` read only
   * `goals`, so a pending (or approved-but-unmaterialized) record
   * structurally cannot fire through the existing paths. Approval
   * still creates no goals-list entry; the ONLY path from an
   * approved record to a goals-list entry is the explicit
   * `materializeSynthesizedSchedule` below (#1517, Lane 1).
   */
  private async getSynthesized(): Promise<SynthesizedSchedule[]> {
    const stored =
      await this.ctx.storage.get<SynthesizedSchedule[]>(
        SYNTHESIZED_SCHEDULES_KEY,
      );
    return stored ?? [];
  }

  private async saveSynthesized(
    records: SynthesizedSchedule[],
  ): Promise<void> {
    await this.ctx.storage.put(SYNTHESIZED_SCHEDULES_KEY, records);
  }

  /** List all synthesized schedule/job records (pending + approved). */
  async listSynthesizedSchedules(): Promise<SynthesizedSchedule[]> {
    return this.getSynthesized();
  }

  /**
   * Synthesize a schedule/job record from a compiled chain. Always
   * pending (see src/agentic/jobSynthesis.ts — the confirmation
   * gate); duplicate ids are rejected.
   */
  async synthesizeSchedule(
    chain: CompiledChain,
    opts: { cron?: string | null; id?: string; timeZone?: string },
  ): Promise<SynthesizedSchedule> {
    const records = await this.getSynthesized();
    const record = synthesizeChainSchedule(chain, opts);
    if (records.some((r) => r.id === record.id)) {
      throw new Error(`Synthesized schedule already exists: ${record.id}`);
    }
    records.push(record);
    await this.saveSynthesized(records);
    // Issue #1651 (slice 1, R5): DO first, then project. A
    // projection failure never fails this transition — it is
    // logged inside projectAfterTransition and reconciled later.
    await this.projectSynthesized(record, "synthesize");
    return record;
  }

  /**
   * Issue #1651 (slice 1): best-effort projection of an
   * already-persisted synthesized record. Issue #3179: the
   * projection stamps the deployment default — resolved
   * explicitly via resolveIaaaTenant and logged, never a silent
   * hardcoded literal — until a tenant context is threaded
   * through ScheduledAgent. The record carries no owner, so
   * per-record owner derivation needs a record schema change
   * (not made here); workspaceId mirrors tenantId, the codebase
   * convention for projection rows.
   */
  private async projectSynthesized(
    record: SynthesizedSchedule,
    transition: ChainScheduleTransition,
  ): Promise<void> {
    const tenantId = resolveIaaaTenant(this.env);
    structuredLog.info("scheduledAgent.tick_tenant_env_fallback", {
      site: "projectSynthesized",
      tenantId,
      recordId: record.id,
      transition,
      reason: "no tenant context threaded through projection",
    });
    await projectAfterTransition(this.env, {
      tenantId,
      workspaceId: tenantId,
      record,
      transition,
      nowMs: Date.now(),
    });
  }

  /**
   * Issue #1651 (slice 1): operator/maintenance reconciliation
   * of the chain/schedule projection against current DO state.
   * This is the invocation point for `reconcileChainSchedules`:
   * it is called deliberately by an operator (via the
   * admin-gated POST /api/chains/reconcile route), never on
   * boot, deploy, or tick. Returns the report so the operator
   * sees exactly what changed. The route threads the operator's
   * login as `actor` for the audit row (issue #2426); a caller
   * that supplies none is recorded under SCHEDULED_AGENT_AUDIT_ACTOR.
   */
  async reconcileChainScheduleProjection(
    tenantId: string = DEPLOYMENT_DEFAULT_TENANT_ID,
    actor?: string,
  ): Promise<ReconcileReport> {
    const adapter = createChainScheduleAdapter(this.env);
    if (!adapter) {
      return { checked: 0, reconciled: 0, alreadyCurrent: 0, errors: [] };
    }
    // Issue #2426: the audit row names its real actor — the
    // operator the route threaded in, or this agent's own named
    // identity when no actor was supplied (never "system").
    const auditActor =
      typeof actor === "string" && actor.trim().length > 0
        ? actor.trim()
        : SCHEDULED_AGENT_AUDIT_ACTOR;
    await ensureChainScheduleSchema(adapter.db);
    const records = await this.getSynthesized();
    const report = await reconcileChainSchedules({
      store: adapter,
      tenantId,
      workspaceId: DEPLOYMENT_DEFAULT_WORKSPACE_ID,
      nowMs: Date.now(),
      records,
    });
    // Issue #1688 (slice 3, R5): a reconcile pass writes one
    // tenant-wide audit event carrying its report counts.
    // Best-effort and never blocking: the helper never throws.
    await recordAuditEventBestEffort(this.env, {
      tenantId,
      workspaceId: "primary",
      chainId: null,
      eventKind: "reconcile",
      subjectType: "chain",
      subjectId: tenantId,
      actor: auditActor,
      detailJson: JSON.stringify(report),
      occurredAtMs: Date.now(),
      provenanceWriter: "scheduled-agent:reconcileChainScheduleProjection",
      provenanceSourceDo: "ScheduledAgent",
      provenanceSourceVersion: "1",
    }, Date.now());
    return report;
  }

  /**
   * Approve one synthesized record (pending → approved). The ONLY
   * transition to live; unknown ids throw; re-approving is a no-op.
   */
  async approveSynthesizedSchedule(
    id: string,
  ): Promise<SynthesizedSchedule> {
    const records = await this.getSynthesized();
    const updated = approveSynthesizedInList(records, id);
    await this.saveSynthesized(updated);
    const record = updated.find((r) => r.id === id)!;
    // Issue #1651 (slice 1, R5): DO first, then project.
    await this.projectSynthesized(record, "approve");
    return record;
  }

  /**
   * Kill one synthesized record (pending/approved → killed). Phase 6
   * (#1468): killed is terminal and the record never fires
   * (`shouldFireSynthesized` fires ONLY approved records); killing
   * removes nothing, so killed schedules stay enumerable via
   * `listSynthesizedSchedules` and auditable. Unknown ids throw;
   * re-killing is a no-op.
   */
  async killSynthesizedSchedule(
    id: string,
  ): Promise<SynthesizedSchedule> {
    const records = await this.getSynthesized();
    const updated = killSynthesizedInList(records, id);
    await this.saveSynthesized(updated);
    const record = updated.find((r) => r.id === id)!;
    // Issue #1651 (slice 1, R5): DO first, then project.
    await this.projectSynthesized(record, "kill");
    return record;
  }

  /**
   * Issue #1517 (Lane 1): materialize ONE approved recurring record
   * as a goals-list entry. The ONLY transition from synthesized
   * record to schedulable goal: approval alone creates nothing (see
   * above), and this method refuses pending, killed, and one-shot
   * records via `materializeSynthesizedRecord`. Idempotent: a
   * goal already materialized for this id is returned unchanged,
   * never duplicated; a goal id already used by a non-chain goal
   * throws. Materializing creates no job, no async-job row, and no
   * shard job — the goal fires later, through the governed `onCron`
   * branch, when its cron is due.
   */
  async materializeSynthesizedSchedule(
    id: string,
  ): Promise<ScheduledGoal> {
    const records = await this.getSynthesized();
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new Error(`Unknown synthesized schedule: ${id}.`);
    }
    // Issue #3121 Phase 2 (#3124) — single evaluation scan: the
    // save below reuses this load's snapshot.
    const { goals, records: goalRecords } = await this.loadGoalRecords();
    const existing = goals.find((g) => g.id === id);
    if (existing) {
      if (existing.operation !== CHAIN_EXECUTE_OPERATION) {
        throw new Error(`Goal id already exists for a non-chain goal: ${id}`);
      }
      return existing;
    }
    const goal = materializeSynthesizedRecord(record);
    // Issue #3121 S3 — a materialized goal is a goal-schedule
    // creation, so it carries creation provenance like every other
    // creation path: framework machinery acting on an approved
    // record, origin system, reason naming the cause. No actor is
    // threaded here (no route calls this method today); the
    // creation record names the cause, never an invented creator.
    // Idempotent re-materialization returns the stored goal
    // unchanged below — creation-only stamping, never rewritten.
    goal.provenance = systemProvenance("synthesized-materialization");
    goals.push(goal);
    await this.saveGoals(goals, goalRecords);
    return goal;
  }

  /**
   * Run a record's chain through a caller-supplied leg executor.
   * The caller (onCron branch / fireSynthesizedSchedule) already
   * ran the governed decision and the PaymentsAgent budget check,
   * so `runChain`'s per-leg budgetCheck passes through here — it
   * must not re-gate work that is already approved and checked.
   */
  private async executeChainForRecord(
    chain: CompiledChain,
    chainExecutor: (step: CompiledChainStep) => Promise<unknown>,
    project?: { chainId: string; tenantId: string; writer: string },
  ): Promise<ChainRunResult> {
    const { runChain } = await import("../mcps/openaimp/goalChainCommands");
    return runChain(chain, {
      executeLeg: chainExecutor,
      budgetCheck: async () => true,
      // Issue #1676: project each ran leg into AgentDB as it
      // completes. The projector never throws (unbound store
      // is a no-op, store failures are reported), so this
      // callback can never fail the run. The chain id is the
      // synthesized record id, matching slice 1's chain rows.
      ...(project
        ? {
            onLegOutcome: (leg: import("../mcps/openaimp/goalChainCommands").ChainLegResult) =>
              projectRunLegs(this.env, {
                tenantId: project.tenantId,
                workspaceId: "primary",
                chainId: project.chainId,
                legs: [leg],
                nowMs: Date.now(),
                writer: project.writer,
              }),
          }
        : {}),
    });
  }

  /**
   * Issue #1517 (Lane 1) + #1523 (Lane 2): fire ONE one-shot
   * synthesized record directly. Recurring records are refused
   * here — they must materialize first and fire via `onCron`, so
   * there is exactly one firing path per kind. The governed
   * decision runs before the PaymentsAgent budget check and
   * before any job descriptor is created; a blocked or
   * budget-rejected firing consumes nothing and leaves `firedAt`
   * unset, so it can be retried. With a supplied leg executor,
   * legs run after the budget check and before the descriptor —
   * an executor failure likewise consumes nothing. A successful
   * firing consumes the record (`firedAt` set) and returns the
   * job descriptor id plus the run result.
   */
  async fireSynthesizedSchedule(
    id: string,
    opts?: {
      halted?: boolean;
      sql?: any;
      haltReader?: HaltReader;
      tenantId?: string;
      chainExecutor?: (step: CompiledChainStep) => Promise<unknown>;
    },
  ): Promise<{
    fired: boolean;
    reason: string;
    jobId?: string;
    record: SynthesizedSchedule;
    execution?: ChainRunResult;
  }> {
    const records = await this.getSynthesized();
    const record = records.find((r) => r.id === id);
    if (!record) {
      throw new Error(`Unknown synthesized schedule: ${id}.`);
    }
    if (record.kind !== "one-shot") {
      throw new Error(
        `Cannot fire synthesized schedule ${id} directly: recurring records must materialize first and fire via onCron (materializeSynthesizedSchedule).`,
      );
    }
    const now = new Date();
    // Issue #3121 #3393 — every direct one-shot firing records a
    // consolidated-ledger run row (system `scheduled-agent-goal`),
    // like the onCron terminal points (`recordGoalRun`): the trigger
    // is manual — a one-shot record has no cron and is fired directly
    // by a caller, never by the tick; the schedule id IS the record
    // id; the async job id rides the success branch that creates an
    // Orchestrator job (null on every refusal — no job was created);
    // no one-shot firing runs through a workflow, so workflowId is
    // null. The linkage resolves through the S1 resolver
    // (`buildLedgerLinkage`), never hand-built at this write site.
    // Recording never breaks the firing: `recordJobRun` swallows
    // storage failures, and a refused firing still records its
    // reason (a skip without a reason cannot be constructed).
    const runStarted = now.toISOString();
    const recordOneShotRun = (
      outcome: JobRunRecord["outcome"],
      extra: {
        error?: string;
        detail?: string;
        descriptor?: string;
        asyncJobId?: string | null;
      },
    ): Promise<void> => {
      const linkage = buildLedgerLinkage({
        payload: {
          scheduleId: record.id,
          ...(extra.asyncJobId ? { asyncJobId: extra.asyncJobId } : {}),
        },
        triggeredBy: "manual",
      });
      return this.recordJobRun({
        jobId: record.id,
        operation: CHAIN_EXECUTE_OPERATION,
        started: runStarted,
        finished: new Date().toISOString(),
        outcome,
        triggeredBy: "manual",
        trigger: linkage.trigger,
        scheduleId: linkage.scheduleId,
        asyncJobId: linkage.asyncJobId,
        workflowId: linkage.workflowId,
        ...(extra.error !== undefined ? { error: extra.error } : {}),
        ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
        ...(extra.descriptor !== undefined
          ? { descriptor: extra.descriptor }
          : {}),
      }).then(() => undefined);
    };
    // #1548 (slice 0): same halt resolution as onCron, so the
    // direct one-shot path sees the mirrored halt too. Issue
    // #3179: same explicit env-default fallback as onCron when
    // no tenant context is threaded in — never a silent literal.
    const fireTenantId = opts?.tenantId ?? resolveIaaaTenant(this.env);
    if (!opts?.tenantId) {
      structuredLog.info("scheduledAgent.tick_tenant_env_fallback", {
        site: "fireSynthesizedSchedule",
        tenantId: fireTenantId,
        reason: "no tenant context threaded into fireSynthesizedSchedule",
      });
    }
    const halted =
      opts?.halted ??
      (opts?.sql
        ? isGovernedHalted(opts.sql)
        : opts?.haltReader
          ? await resolveReaderHalt(opts.haltReader, fireTenantId)
          : this.env.AGENT_DB
            ? await readAgentDbHalt(this.env, fireTenantId)
            : false);
    const decision = decideChainFiring(record, now, { halted });
    if (!decision.fire) {
      if (opts?.sql) {
        try {
          auditBlockedChainFiring(opts.sql, record, decision.reason, now);
        } catch {
          /* Blocked already; an audit failure must not unblock it. */
        }
      }
      await recordOneShotRun("skipped", { detail: decision.reason });
      return { fired: false, reason: decision.reason, record };
    }
    // #1779: the shared PaymentsAgentStub (budgetCheck) via the
    // ActorGateway — the second site of the duplicated inline type.
    const payments = actorGateway.paymentsStub(this.env.PAYMENTS_AGENT);
    const budgetOk = await payments.budgetCheck({
      operation: CHAIN_EXECUTE_OPERATION,
      amountCents: record.budgetCents,
      // Issue #2327: same explicit bucket as the onCron goal check —
      // see the attribution note there.
      agentId: AGENTIC_SPEND_AGENT_ID,
    });
    if (!budgetOk.allowed) {
      // Issue #3121 #3393 — a budget refusal is a terminal point:
      // it records a skipped row with the reason, like the onCron
      // budget terminal point, and consumes nothing.
      const budgetReason = `budget check rejected: ${budgetOk.reason ?? "disallowed"}`;
      await recordOneShotRun("skipped", { detail: budgetReason });
      return {
        fired: false,
        reason: budgetReason,
        record,
      };
    }
    let execution: ChainRunResult | undefined;
    if (opts?.chainExecutor) {
      execution = await this.executeChainForRecord(
        chainFromRecord(record),
        opts.chainExecutor,
        {
          chainId: record.id,
          tenantId: fireTenantId,
          writer: "scheduled-agent:fireSynthesizedSchedule",
        },
      );
      if (!execution.ok) {
        const failed = execution.legs.filter(
          (l) => l.status === "failed" || l.status === "blocked",
        );
        // Issue #3121 #3393 — a failed-legs firing is a terminal
        // point: it records a failure row with the error, like the
        // onCron failure terminal points, and consumes nothing.
        const failureReason = `chain execution failed: ${failed
          .map((l) => `${l.capabilityId}: ${l.detail}`)
          .join("; ")}`;
        await recordOneShotRun("failure", { error: failureReason });
        return {
          fired: false,
          reason: failureReason,
          record,
          execution,
        };
      }
    }
    const { createJob } = await import("../orchestrate");
    const job = await createJob(this.env, {
      goalId: record.id,
      goalName: record.goal,
      operation: CHAIN_EXECUTE_OPERATION,
      budgetCents: record.budgetCents,
    });
    const updated = markSynthesizedFired(record, now.toISOString());
    await this.saveSynthesized(
      records.map((r) => (r.id === id ? updated : r)),
    );
    // Issue #3121 #3393 — the firing consumed the record, so the
    // success row records with the created job's id (the join key
    // to the job), the same `job:<id>` descriptor the onCron
    // job-creating branches stamp.
    await recordOneShotRun("success", {
      descriptor: `job:${job.jobId}`,
      asyncJobId: job.jobId,
    });
    if (
      execution &&
      opts?.sql &&
      execution.legs.every(
        (l) => l.status === "completed" || l.status === "submitted",
      )
    ) {
      try {
        auditSuccessfulChainFiring(
          opts.sql,
          record,
          shardProvenanceOf(execution),
          now,
        );
      } catch {
        /* Firing stands; an audit failure must not unconsume it. */
      }
    }
    return {
      fired: true,
      reason: decision.reason,
      jobId: job.jobId,
      record: updated,
      execution,
    };
  }

  /**
   * Manually trigger evaluation of a single goal.
   *
   * Issue #1391:
   * 1. env is optional over the DO RPC boundary; if omitted, reads this.env.
   * 2. Evaluates the goal even if it is currently disabled (e.g. daily-social-post
   *    shipped disabled by default). It temporarily enables the goal in storage
   *    for this firing, and restores its original enabled state afterwards so
   *    that the daily recurring schedule remains disabled.
   */
  async triggerGoal(
    id: string,
    env?: Env,
    actor?: string | null,
  ): Promise<ScheduleTick> {
    // Issue #3121 Phase 2 (#3124) — single evaluation scan: this
    // load's snapshot threads through onCron and the restore path
    // below, so a manual trigger costs one store scan instead of
    // five. No await sits between this load and the onCron call, so
    // the snapshot cannot go stale in between.
    const { goals, records } = await this.loadGoalRecords();
    const goal = goals.find((g: ScheduledGoal) => g.id === id);
    if (!goal) {
      return {
        timestamp: new Date().toISOString(),
        goalsEvaluated: 0,
        jobsCreated: 0,
        jobsSkipped: 1,
        errors: [`Goal not found: ${id}`],
      };
    }
    const origLastRun = goal.lastRun;
    const targetEnv =
      env && typeof env === "object" && ("PAYMENTS_AGENT" in env || "SESSION_STORE" in env)
        ? env
        : this.env;

    const tick = await this.onCron(targetEnv, {
      forceGoalId: id,
      preloadedGoals: { goals, records },
    });
    // Issue #3121 S3 (#3312) — a trigger of a missing goal is no
    // lifecycle event (no goal changed state); a found goal's manual
    // firing is. The condition is the route's S1 condition, moved
    // into the method with the sink.
    if (tick.goalsEvaluated > 0) {
      await this.auditGoalLifecycle(
        "schedule.goal.triggered",
        id,
        undefined,
        actor,
      );
    }
    const currentGoal = goals.find((g: ScheduledGoal) => g.id === id);
    const waitingOnLoopApproval =
      currentGoal?.executionMode === "agentic-loop" &&
      (await this.hasPendingAgenticLoopApproval(id));
    if (
      tick.jobsCreated === 0 &&
      tick.errors.length === 0 &&
      !waitingOnLoopApproval
    ) {
      // The restore reuses the same in-memory goals onCron evaluated
      // and saved — no re-read: the snapshot's createdAt values are
      // the stored ones, so the reset save preserves them exactly
      // as the re-read did.
      if (currentGoal) {
        currentGoal.lastRun = origLastRun;
        await this.saveGoals(goals, records);
      }
    }
    return tick;
  }

  /**
   * Issue #3122 — the agent schedule capability bound to this DO's
   * stores. Goals adapter over getGoals/saveGoals/triggerGoal (the
   * mutation funnel, so goal lifecycle events still emit exactly
   * once); ledger rows go to the DO-native jobRunRecords list
   * (recordJobRun — the per-run view the Jobs UI reads); audit
   * events post best-effort to the orchestrator audit channel (the
   * auditGoalLifecycle swallow rule: a failed post never fails the
   * action); pending approvals live under
   * PENDING_SCHEDULE_APPROVALS_KEY. PDP is the same compiled policy
   * + membership PIP as evaluateRoutePep, via authorize() with the
   * alias-resolved principal (the session precondition of
   * evaluateRoutePep cannot be met inside the DO).
   */
  private async getAgentScheduleLoopSettingsForLogin(
    login: string,
  ): Promise<AgentScheduleLoopSettingsResolution> {
    try {
      const orchestrator = actorGateway.stub<{
        getAgentScheduleLoopSettings(): Promise<AgentScheduleLoopSettingsResolution>;
      }>(this.env.ORCHESTRATOR_AGENT, login);
      return await orchestrator.getAgentScheduleLoopSettings();
    } catch (error) {
      return {
        settings: null,
        issues: [
          `Unable to read owner-managed agentic-loop settings: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }

  private async hasPendingAgenticLoopApproval(scheduleId: string): Promise<boolean> {
    const approvals =
      (await this.ctx.storage.get<PendingScheduleApproval[]>(
        PENDING_SCHEDULE_APPROVALS_KEY,
      )) ?? [];
    return approvals.some((approval) => {
      const definition = approval.definition as Record<string, unknown> | null;
      return (
        approval.kind === "agentic-loop" &&
        approval.status === "pending" &&
        definition?.scheduleId === scheduleId
      );
    });
  }

  private async withAgenticLoopTurn<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.agenticLoopTurnQueue;
    let release!: () => void;
    this.agenticLoopTurnQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async requestAgenticLoopContinuationApproval(
    goal: ScheduledGoal,
    active: ActiveAgenticLoop,
  ): Promise<string> {
    const approvals =
      (await this.ctx.storage.get<PendingScheduleApproval[]>(
        PENDING_SCHEDULE_APPROVALS_KEY,
      )) ?? [];
    const existing = approvals.find((approval) => {
      const definition = approval.definition as Record<string, unknown> | null;
      return (
        approval.kind === "agentic-loop" &&
        approval.status === "pending" &&
        definition?.scheduleId === goal.id
      );
    });
    if (existing) return existing.id;

    const id = `pending-loop-${crypto.randomUUID()}`;
    const entry: PendingScheduleApproval = {
      id,
      kind: "agentic-loop",
      requestedBy: active.login,
      agentId: goal.provenance?.agentId ?? AGENTIC_SPEND_AGENT_ID,
      requestedAt: new Date().toISOString(),
      definition: {
        purpose: "continue-agentic-loop",
        scheduleId: goal.id,
        runId: active.runId,
        operation: goal.operation,
        usedModelTokens: active.usedModelTokens,
        maxModelTokens: active.settings.maxModelTokens,
        turns: active.turns,
      },
      approvalReasons: [
        `Provider-reported usage reached ${active.usedModelTokens} model tokens of the configured ${active.settings.maxModelTokens}-token cap. Approving starts one new bounded run; no monetary price is inferred.`,
      ],
      status: "pending",
    };
    await this.ctx.storage.put(PENDING_SCHEDULE_APPROVALS_KEY, [
      ...approvals,
      entry,
    ]);
    return id;
  }

  private async runBoundedAgenticLoop(
    goal: ScheduledGoal,
  ): Promise<AgenticLoopRunOutcome> {
    const login = goal.provenance?.createdBy;
    if (typeof login !== "string" || !login.trim()) {
      return {
        status: "failed",
        detail: "agentic-loop schedule has no recorded owner login",
        usedModelTokens: 0,
        turns: 0,
      };
    }

    return this.withAgenticLoopTurn(async () => {
      const resolution =
        await this.getAgentScheduleLoopSettingsForLogin(login);
      if (!resolution.settings) {
        return {
          status: "failed",
          detail:
            resolution.issues.join("; ") ||
            "owner-managed agentic-loop bounds are unavailable",
          usedModelTokens: 0,
          turns: 0,
        };
      }
      if (!resolution.settings.enabled) {
        return {
          status: "skipped",
          detail: "owner-managed agentic-loop kill switch is disabled",
          usedModelTokens: 0,
          turns: 0,
        };
      }

      const prompt = [
        `Scheduled goal: ${goal.name}`,
        `Registered operation: ${goal.operation}`,
        `Schedule id: ${goal.id}`,
        "Work only within the available schedule-management capability. Do not create or re-arm schedules unless the owner approves the pending action.",
      ].join("\n");
      const active: ActiveAgenticLoop = {
        login,
        scheduleId: goal.id,
        runId: newRunId(),
        prompt,
        settings: resolution.settings,
        controller: new AbortController(),
        startedAtMs: Date.now(),
        usedModelTokens: 0,
        turns: 0,
      };
      this.activeAgenticLoop = active;
      const timeout = setTimeout(() => {
        if (!active.stopReason) {
          active.stopReason = "time-cap";
          active.controller.abort("configured loop duration reached");
        }
      }, active.settings.maxDurationMs);

      try {
        await this.lifecycle.start();
        const result = await this.runTurn({
          input: prompt,
          body: { agentScheduleLoopRunId: active.runId },
          signal: active.controller.signal,
        });

        if (active.stopReason === "cost-cap") {
          const pendingApprovalId =
            await this.requestAgenticLoopContinuationApproval(goal, active);
          return {
            status: "approval-required",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
            pendingApprovalId,
          };
        }
        if (active.stopReason === "kill-switch") {
          return {
            status: "skipped",
            detail: "owner-managed agentic-loop kill switch was disabled during execution",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
          };
        }
        if (
          active.stopReason === "settings-unavailable" ||
          active.stopReason === "usage-unavailable"
        ) {
          return {
            status: "failed",
            detail:
              active.stopReason === "usage-unavailable"
                ? "provider-reported model usage was unavailable; loop stopped without continuation"
                : "owner-managed agentic-loop settings became unavailable; loop stopped",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
          };
        }
        if (result.status === "error" && !active.stopReason) {
          return {
            status: "failed",
            detail: "Think returned an error while executing the scheduled goal",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
          };
        }
        if (result.status === "skipped" && !active.stopReason) {
          return {
            status: "failed",
            detail: "Think skipped a scheduled goal despite receiving a non-empty prompt",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
          };
        }
        return {
          status: "completed",
          usedModelTokens: active.usedModelTokens,
          turns: active.turns,
        };
      } catch (error) {
        if (active.stopReason === "cost-cap") {
          const pendingApprovalId =
            await this.requestAgenticLoopContinuationApproval(goal, active);
          return {
            status: "approval-required",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
            pendingApprovalId,
          };
        }
        if (
          active.stopReason === "time-cap" ||
          active.stopReason === "turn-cap"
        ) {
          return {
            status: "completed",
            usedModelTokens: active.usedModelTokens,
            turns: active.turns,
          };
        }
        return {
          status: "failed",
          detail: `Think execution failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          usedModelTokens: active.usedModelTokens,
          turns: active.turns,
        };
      } finally {
        clearTimeout(timeout);
        if (this.activeAgenticLoop === active) this.activeAgenticLoop = undefined;
      }
    });
  }

  private agentScheduleExecutorDeps(): AgentScheduleExecutorDeps {
    const goalsAdapter: AgentGoalScheduleAdapter = {
      list: async () => (await this.getGoals()) as unknown as Array<Record<string, unknown>>,
      add: async (goal) => {
        const created = await this.addGoal(
          goal as unknown as Parameters<ScheduledAgent["addGoal"]>[0],
        );
        return created as unknown as Record<string, unknown>;
      },
      remove: (id) => this.removeGoal(id),
      setEnabled: (id, enabled) => this.setGoalEnabled(id, enabled),
      trigger: (id) => this.triggerGoal(id),
    };
    return {
      pdp: (input) => evaluateAgentSchedulePdp(createAgentSchedulePdpDeps(this.env), input),
      config: resolveEnvironmentConfig(this.env).agentSchedule,
      resolveAgentScheduleLoopSettings: async (login) =>
        (await this.getAgentScheduleLoopSettingsForLogin(login)).settings,
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      recordLedger: (record) => {
        void this.recordJobRun(record);
      },
      audit: (type, payload) => {
        // S3-P07: the one poster call site — this dep posts through
        // postScheduleAuditEvent (fire-and-forget), never directly.
        void this.postScheduleAuditEvent({
          type,
          agent: "scheduled-agent",
          payload,
        });
      },
      pendingApprovals: {
        load: async () =>
          (await this.ctx.storage.get<PendingScheduleApproval[]>(PENDING_SCHEDULE_APPROVALS_KEY)) ?? [],
        save: async (list) => {
          await this.ctx.storage.put(PENDING_SCHEDULE_APPROVALS_KEY, list);
        },
      },
      stores: { goals: goalsAdapter },
    };
  }

  /** List pending goal approvals (the queue the approval UI reads, #4142). */
  async listPendingGoalApprovals(): Promise<PendingScheduleApproval[]> {
    const all =
      (await this.ctx.storage.get<PendingScheduleApproval[]>(PENDING_SCHEDULE_APPROVALS_KEY)) ?? [];
    return all.filter((entry) => entry.status === "pending");
  }

  /**
   * Decide a pending goal approval. Approve arms the recorded goal
   * definition through the capability under the original requester's
   * principal (the approver is PDP-checked for action:approve on the
   * route before this is called); reject arms nothing. The state
   * machine is enforced here (pending → decided, once). A failed
   * arming throws and leaves the approval pending, so the approver
   * can retry once the cause is fixed.
   */
  async approvePendingGoalApproval(
    id: string,
    decidedBy: string,
  ): Promise<{
    approval: PendingScheduleApproval;
    scheduleId?: string;
    continuation?: ScheduleTick;
  }> {
    const all =
      (await this.ctx.storage.get<PendingScheduleApproval[]>(PENDING_SCHEDULE_APPROVALS_KEY)) ?? [];
    const entry = resolvePendingScheduleApproval(all, id);
    if (!entry) throw new Error(`Pending approval '${id}' was not found.`);
    if (entry.status !== "pending") {
      throw new Error(`Pending approval '${id}' is already decided (${entry.status}).`);
    }
    const def = entry.definition as Record<string, unknown>;
    if (entry.kind === "agentic-loop") {
      if (def.purpose !== "continue-agentic-loop") {
        throw new Error(`Pending approval '${id}' has an unsupported agentic-loop purpose.`);
      }
      const scheduleId =
        typeof def.scheduleId === "string" ? def.scheduleId : "";
      if (!scheduleId) {
        throw new Error(`Pending approval '${id}' has no schedule id.`);
      }
      const goal = (await this.getGoals()).find((item) => item.id === scheduleId);
      if (!goal || !goal.enabled) {
        throw new Error(
          `Agentic-loop schedule '${scheduleId}' is missing or paused; approval was not consumed.`,
        );
      }
      if (goal.provenance?.createdBy !== entry.requestedBy) {
        throw new Error(
          `Agentic-loop schedule '${scheduleId}' no longer belongs to the approval requester.`,
        );
      }
      const settings =
        await this.getAgentScheduleLoopSettingsForLogin(entry.requestedBy);
      if (!settings.settings?.enabled) {
        throw new Error(
          settings.settings
            ? "Agentic-loop scheduling is disabled by the owner-managed kill switch."
            : settings.issues.join("; ") ||
                "Owner-managed agentic-loop bounds are unavailable.",
        );
      }
      const decided = decidePendingScheduleApproval(
        all,
        id,
        "approved",
        decidedBy,
        new Date().toISOString(),
      );
      await this.ctx.storage.put(PENDING_SCHEDULE_APPROVALS_KEY, decided);
      const continuation = await this.triggerGoal(scheduleId, undefined, decidedBy);
      return {
        approval: decided.find((item) => item.id === id)!,
        scheduleId,
        continuation,
      };
    }
    if (entry.kind !== "goal") {
      throw new Error(`Pending approval '${id}' is not a goal approval.`);
    }
    const loopOriginRaw = def.loopOrigin as Record<string, unknown> | undefined;
    const loopOrigin: AgentScheduleLoopOrigin | undefined =
      loopOriginRaw &&
      typeof loopOriginRaw.scheduleId === "string" &&
      typeof loopOriginRaw.runId === "string"
        ? {
            scheduleId: loopOriginRaw.scheduleId,
            runId: loopOriginRaw.runId,
          }
        : undefined;
    if (def.loopOrigin !== undefined && !loopOrigin) {
      throw new Error(`Pending approval '${id}' has an invalid loop origin.`);
    }
    const deps = this.agentScheduleExecutorDeps();
    const principal = { login: entry.requestedBy, agentId: entry.agentId };
    const tenantId = resolveIaaaTenant(this.env);
    let armed: AgentScheduleActionResult;
    if (def.action === "resume") {
      const kind = def.kind;
      if (kind !== "goal" || !loopOrigin || typeof def.scheduleId !== "string") {
        throw new Error(`Pending approval '${id}' has an invalid resume definition.`);
      }
      armed = await executeAgentScheduleAction(deps, {
        action: "resume",
        kind: "goal",
        principal,
        tenantId,
        scheduleId: def.scheduleId,
        approvedPendingId: id,
        loopOrigin,
      });
    } else if (def.scheduleId !== undefined) {
      armed = await executeAgentScheduleAction(deps, {
        action: "update",
        kind: "goal",
        principal,
        tenantId,
        scheduleId: String(def.scheduleId),
        goal: def.goal as Record<string, unknown>,
        approvedPendingId: id,
        ...(loopOrigin ? { loopOrigin } : {}),
      });
    } else {
      armed = await executeAgentScheduleAction(deps, {
        action: "create",
        kind: "goal",
        principal,
        tenantId,
        operation: String((def.goal as Record<string, unknown>).operation ?? ""),
        goal: def.goal as Record<string, unknown>,
        approvedPendingId: id,
        ...(loopOrigin ? { loopOrigin } : {}),
      });
    }
    if (!armed.ok) {
      throw new Error(`Approval could not be armed: ${armed.reason}`);
    }
    const nowIso = new Date().toISOString();
    const decided = decidePendingScheduleApproval(all, id, "approved", decidedBy, nowIso);
    await this.ctx.storage.put(PENDING_SCHEDULE_APPROVALS_KEY, decided);
    return {
      approval: decided.find((item) => item.id === id)!,
      ...(armed.scheduleId !== undefined ? { scheduleId: armed.scheduleId } : {}),
    };
  }

  /** Reject a pending goal approval; arms nothing. */
  async rejectPendingGoalApproval(id: string, decidedBy: string): Promise<PendingScheduleApproval> {
    const all =
      (await this.ctx.storage.get<PendingScheduleApproval[]>(PENDING_SCHEDULE_APPROVALS_KEY)) ?? [];
    const entry = resolvePendingScheduleApproval(all, id);
    if (!entry) throw new Error(`Pending approval '${id}' was not found.`);
    if (entry.status !== "pending") {
      throw new Error(`Pending approval '${id}' is already decided (${entry.status}).`);
    }
    const decided = decidePendingScheduleApproval(
      all,
      id,
      "rejected",
      decidedBy,
      new Date().toISOString(),
    );
    await this.ctx.storage.put(PENDING_SCHEDULE_APPROVALS_KEY, decided);
    return decided.find((item) => item.id === id)!;
  }
}
