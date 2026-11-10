import type { AgentContext, Schedule } from "agents";
import type {
  ChatResponseResult,
  TurnConfig,
  TurnContext,
  UiChatMessage,
} from "../actors/actorPorts";
import { createCfActorSession } from "../actors/cfAgentsAdapter";
import { PortThink, createThinkActorTurn, type SkillSource, type ThinkScheduledTasks } from "../actors/thinkAdapter";
import type { ActorSessionPort, ActorTurnHooks, ActorTurnPort, ActorEmailEvent, ActorWebhookEvent } from "../actors/actorPorts";
import type { ToolSet } from "ai";
import { getWorkersAIModel } from "./model";
import { resolveScreenerAgentName } from "./screenerAgentName";
import { actorGateway } from "../services/cloudflareActorGateway";
import { copilotRegistrationForSourceTab } from "../services/copilotChannels";
import { recordJobOutcome } from "../services/jobOutcomes";
import type { JobOutcomeInput } from "../data/jobOutcomePorts";
import {
  buildOrchestratorSystemPrompt,
  resolveShadowMaxSteps,
  type StockCopilotPromptCapability,
} from "./chatPrompt";
import { resolveCopilotTradingSelection } from "./copilotTradingMode";
import { LLMJudge } from "./judge";
import { VectorMemory } from "../memory/vector-memory";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, type NLQSchedulingPort, type NLQSocialBriefPort, type NLQStockScreenPort } from "./nlq";
import { resolveErrorAspect, AgentErrorCode } from "../aspects/errorCodes";
import { logAspectEvent } from "../aspects/loggingAspect";
import { DatabaseORM } from "../orm";

import { PaymentGatewayService, normalizeGateway, isWebhookGateway, isSupportedGateway, SUPPORTED_GATEWAYS, type SupportedGateway } from "../services/payments";
import { computePortfolioRisk, aggregatePortfolioRisk, resolvePositionsSnapshot, evaluatePostTradeTotals, type CandidateGreekContribution } from "../services/portfolioRisk";
import { ETradeThinkHarness } from "../services/thinkHarness";
import {
  type OrderIntent,
  type PolicyVerdict,
  type PolicyVerdictAttestation,
} from "../services/riskPolicyEngine";
import { assessPortfolioConcentration } from "../services/portfolioConcentration";
import { sizeCandidateAgainstPortfolio, type SizingCandidate } from "../services/positionSizing";
import { generateHedgeProposals } from "../services/hedgeProposals";
import { ensureFrameworkQueueIndexes } from "../services/frameworkQueueIndexes";
import { createResourceUsagePort } from "../telemetry/createResourceUsagePorts";

import { sharedCorrelationService } from "../services/correlationService";
import type { ScreenerAgent } from "./screener-agent";
import type { ResearchAgent } from "./research-agent";
import { evaluateResearchOutcome, type ResearchExecutionPath } from "../services/researchTaskLedger";
import { getEtapiConfig, setRuntimeEtapiConfigOverrides } from "../config/etapiConfig";
import { isDemoCalibratedChainsEnabled } from "../config/demoMode";
import {
  HTTP_DELIVERY_MODE_SWITCH,
  JOB_LIST_ENVELOPE_SWITCH,
  applyJobListEnvelope,
  jobsConfigErrorEvent,
  levelsForHttpDelivery,
  levelsForJobListEnvelope,
  resolveHttpDeliveryMode,
  resolveJobListEnvelope,
  shouldQueueApiRequest,
  type HttpDeliveryScopedModes,
  type JobListScopedModes,
} from "../config/asyncJobModes";
import type { PaymentsFlowScopedModes } from "../config/paymentsFlowModes";
import { BROKER_CATALOG, brokerCopilotCapability, diffScanRuns, isCopilotBroker } from "../trading";
import { createOptionsDiscoveryPorts } from "../data/createOptionsDiscoveryPorts";

import { createOrmPorts } from "../data/createOrmPorts";
import { SqlLegacyChatStore } from "../data/doSqliteLegacyChatAdapter";
import { createDidAttestation, resolveAgentDidDocument } from "./did";
import { createMAS } from "./mas";
import { dispatchOrchestratorA2A, orchestratorA2AOutcome, type OrchestratorA2AOutcome } from "./orchestrator/a2aDispatch";
import { buildChatErrorFallback, type ChatErrorFallbackContext } from "./chatErrorFallback";
import { getScreenerExecutionContext, migrateLegacyScreenSchedules, removeUnownedBaselineSchedules, ensureStrategyScanSchedule, resolveScheduledLogin, type ScheduleMaintenanceContext } from "./orchestrator/scheduleMaintenance";
import { handleSettingsWebhook } from "./orchestrator/settingsWebhook";
import { createStockCopilotActivityPort } from "../data/createStockCopilotStorePorts";
import { declareStrategyScanObserveTasks, type ScheduledTasksObserveContext } from "./orchestrator/scheduledTasksObserve";
import { declareStockCopilotTasks, type ScheduledTasksCopilotContext } from "./orchestrator/scheduledTasksCopilot";
import { buildOrchestratorSkillSources } from "./orchestrator/skillPacks";
import { autoRenewETradeTokens, autonomousGoalScreen, autonomousMarketScreen, autonomousStrategyDiscovery, collectIvHistory, expireStaleOrderDraft, sendScheduledReminder, type ScheduledCallbackOutcome, type ScheduledCallbacksContext } from "./orchestrator/scheduledCallbacks";
import { recordScheduleCallbackRun } from "./orchestrator/scheduleCallbackRunRecords";
import { nlqSchedulingPort, nlqSocialBriefPort, nlqStockScreenPort, type NlqPortsContext } from "./orchestrator/nlqPorts";
import { formatTraceparent, newTraceContext } from "../observability/observabilityPorts";
import { observeDoRouteDispatch } from "../observability/scheduledJobOutcomes";
import { recordTraceHopBestEffort } from "../data/createMeshTracePorts";
import { createSocialBriefStoreFromNamespace } from "./social/briefStore";
import { fetchSlackPost } from "./social/delivery";
import { postSlackText } from "./resourceGoals";
import { renderChannelText } from "../outcomes/outcomeAspects";
import type { DoNamespaceLike } from "../data/durableKv";
import { createKvMembershipStore } from "../security/iaaaMembershipStore";
import { isLoginShaped } from "../security/serviceIdentity";
import { sessionStore } from "../security/session";
import { submitAsyncJob, recoverQueuedAsyncJobs, recoverStaleRunningAsyncJobs, getAsyncJob, listAsyncJobs, executeAsyncJob, sweepStaleAsyncJobs, scheduleScreenerFollowups, retryAsyncJob, type AsyncJobsContext } from "./orchestrator/asyncJobs";
import { watchdogMissedSchedules, type ScheduleWatchdogContext, type ScheduleWatchdogSweepResult } from "./orchestrator/scheduleWatchdog";
import { RECORDED_SCHEDULE_CALLBACKS } from "./orchestrator/scheduleCallbacks";
import { ensureOrchestratorTables } from "./orchestrator/tableSchema";
import { REPORT_CONFIRMATION_TTL_MS } from "./orchestrator/reportConfirmationTtl";
import { routeRequest, type RouteRequestDeps } from "./orchestrator/routeRequest";
import { submitChatTurn, awaitChatTurnSubmission, type DurableTurnContext, type SubmittedTurnHandle } from "./orchestrator/durableTurnSubmission";
import type { ScreenerRunOutcome } from "../services/screenerFollowups";
import { marketDateKey, readAutopilotStateRaw, getAutopilotState, writeAutopilotState, incrementAutopilotOrdersToday, fetchBrokerBalanceSnapshot, openNotionalForSymbol, evaluateAndRecordAutopilotVerdict, type AutopilotContext } from "./orchestrator/autopilot";
import { readSettingRaw, writeSetting, getReportDispatchHitl, setReportDispatchHitl, createReportConfirmation, getReportConfirmation, decideReportConfirmation, storeResearchReportCanonicalAsync, confirmationDeliveryMeta, deliverStoredReportEmail, deliverStoredReportWebhook, persistScreenerReportCanonical, persistParentScreenReportCanonical, persistPipelineGenerateReportCanonical, refreshCanonicalPdfFields, sendReportEmail, sendReportWebhook, type ReportDispatchContext } from "./orchestrator/reportDispatch";
import { extractMessageText, createTurnTools, deriveTurn, assembleGrounding, type ChatTurnHelpersContext } from "./orchestrator/chatTurnHelpers";
import { createOpenaimpMcpFetch, ensureOpenaimpMcpConnection, chatNlqTurnGate, resolveStockCopilotMcpActivation, STOCK_COPILOT_SOURCE_TAB, type ChatNlqTurnGateResult, type EnsureOpenaimpMcpResult } from "./orchestrator/meshMcpClient";
import { logChatActivity, enqueueHttpRequest, type HttpEntryContext } from "./orchestrator/httpEntry";
import { runResearchAndPublish, deliverResearchReport, sendResearchSummaryEmail, type ResearchPublishContext } from "./orchestrator/researchPublish";
import { ETradeEmailTradingService } from "../trading";
import { ETradeBrowserService } from "../services/browserAgent";
import { runGovernanceSeed } from "./orchestrator/governanceSeed";
import { runShardJobReconcile, type ReconcileShardJobsReport } from "./orchestrator/shardJobReconcile";
import { runCanonicalReportSeed, type SeedCanonicalReportsResult } from "./orchestrator/canonicalReportSeed";
import {
  deliverWorkflowGoalScreenOutcome as deliverGoalScreenOutcome,
  persistWorkflowGoalScreenReport,
  type WorkflowGoalScreenEnvelope,
} from "./orchestrator/goalScreenDispatch";
import type { ScreeningChannel } from "../services/screeningDelivery";
import type { GovernedHaltState } from "../data/governedHalt";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import { createFollowupDeliveryPort } from "../services/screenerFollowupDelivery";
import { createSqlDeliverySuppressionStore } from "../data/deliveryClaimsStore";
import { createDeliverySuppressor } from "../workflows/screenDeliverySuppression";
import { ScheduledTasksService, type AutonomousOptionsAnalysisOptions, type AutonomousStrategyDiscoveryOptions } from "../services/scheduledTasks";
// Issue #278: durable scheduled-run reports for the NextGenTP agent.
// Issue #308: the single generate→store seam + canonical report bodies.
import {
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
  storeReportAtGeneration,
  type CanonicalStoreResult,
  type ScheduledReportInput,
} from "../services/scheduledReports";
// Issue #359-01: reports + HITL routes live in src/agents/routes/reports.ts;
// routeRequest delegates to handleReportsRoutes at the original position.
import { handleReportsRoutes } from "./routes/reports";








import { buildDataProviderPorts } from "../data/buildDataProviderPorts";
import { createEnsuredAuditPolicyAdapter } from "../data/createAuditPolicyPorts";
import type { AuditPolicyPort } from "../data/auditPolicyPorts";
import type { D1ProviderConfigAdapter } from "../data/d1ProviderConfigAdapter";
import type { D1ProviderCaptureAdapter } from "../data/d1ProviderCaptureAdapter";











// Issue #359-08: premium routes live in src/agents/routes/premium.ts;
// routeRequest delegates to handlePremiumRoutes at the original position.
import { handlePremiumRoutes } from "./routes/premium";










import { handleScheduledJobOutcomeRoute } from "./routes/scheduledJobOutcome";
import { TRADING_PAID_SERVICES } from "../services/agenticPayments";
import type {
  Env,
  AgentName,
  AuditEvent,
  MessageRecord,
  TransactionRecord,
  CategoryRecord,
  ExternalAdRecord,
  RevenueSummary,
  ETradeOptionChain,
  ETradeOptionExpireDate,
  AsyncJobPayload,
  AsyncJobRecord,
  AsyncJobSubmission,
  TransactionSnapData,
  RouteDecision,
} from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/orchestrator",
});

/**
 * Issue #686: message normalization for the model call now lives
 * in the actor turn runner (toModelMessages, text-only mapping);
 * the AIChatAgent-era normalizeMessagesForSDK helper was removed
 * with the cutover. Issue #1738: Think's session assembly is gone;
 * the runner performs the same normalization over the actor's own
 * transcript store.
 */

export { CREATABLE_SCHEDULE_CALLBACKS, type CreatableScheduleCallback } from "./orchestrator/scheduleCallbacks";

type ETradeEnvironment = "TEST" | "PROD";
type ScreenerExecutionContext = { userLogin: string; environment?: ETradeEnvironment };
const SCREENER_EXECUTION_CONTEXT_KEY = "screener:execution-context";
const LEGACY_SCHEDULE_MIGRATION_KEY = "screener:legacy-baseline-migration:v3";
/** Issue #618: interval between automatic stale-task sweeps (6 hours). */
const STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60;
/** Issue #3784: interval between automatic stale-async-job sweeps
 *  (15 minutes) — short enough that a run crossing the 30-min
 *  stuck threshold is flagged on the next tick, long enough that
 *  the sweep stays a cheap bounded scan (100 rows/tick). */
const STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS = 15 * 60;
/** Issue #3788: the missed-schedule watchdog rides the same 15-minute
 *  sweep tick as #3784 — one implementation of the tick consumed by
 *  both sweeps, not a second scheduler. */
const SCHEDULE_WATCHDOG_INTERVAL_SECONDS = STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS;
/**
 * Issue #275: the hourly full-catalog Strategy/Symbol Scanner run.
 * Minute :35 staggers it off the equity screens (commonly armed at
 * :05) and the :15/:22 system jobs, so the E*TRADE budget is not hit
 * by every job in the same minute.
 */
export const STRATEGY_SCAN_CRON = "35 * * * *";
/** Issue #624: research task heartbeat interval while a run is in flight (2 minutes). */
const RESEARCH_TASK_HEARTBEAT_MS = 120_000;

export class OrchestratorAgent extends PortThink {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    // Issue #686 (R8): the sanitized step clamp is the production
    // bound — a non-numeric MAS_MAX_STEPS falls back to the default
    // instead of propagating NaN into the turn's stop condition.
    this.maxSteps = resolveShadowMaxSteps(env);
    // Issue #1952: the port hooks for Think's direct-turn path
    // (native transports that bypass the turn facet below). The
    // adapter path builds its own hooks object per turn, so a
    // test instance built without a constructor still drives
    // HTTP turns; only direct turns need this assignment.
    this.portHooks = this.actorTurnHooks();
  }

  private scheduledScreenerSlots = new Set<string>();
  private scheduledOptionsSlots = new Set<string>();
  private scheduledDiscoverySlots = new Set<string>();

  /**
   * #2303 (#1976 step 1): the data-provider platform ports, built lazily
   * from env (AGENT_DB), schema-ensured once per instance. Null adapters
   * (binding absent) leave callers on the legacy DO-store path. Memoized
   * as a promise so concurrent first uses share one build.
   */
  private dataProviderPortsPromise?: Promise<{
    config: D1ProviderConfigAdapter | null;
    captures: D1ProviderCaptureAdapter | null;
  }>;

  private dataProviderPorts(): Promise<{
    config: D1ProviderConfigAdapter | null;
    captures: D1ProviderCaptureAdapter | null;
  }> {
    if (!this.dataProviderPortsPromise) {
      this.dataProviderPortsPromise = buildDataProviderPorts(this.env);
    }
    return this.dataProviderPortsPromise;
  }

  /**
   * #3156 (Q7): the audit-policy port for the money-path gate,
   * built lazily from env (AGENT_DB), schema-ensured once per
   * instance. Null when unbound — the gate helper then fails
   * closed on its own. Memoized as a promise so concurrent first
   * uses share one build (same shape as dataProviderPorts).
   */
  private auditPolicyPortPromise?: Promise<AuditPolicyPort | null>;

  private auditPolicyPort(): Promise<AuditPolicyPort | null> {
    if (!this.auditPolicyPortPromise) {
      this.auditPolicyPortPromise = createEnsuredAuditPolicyAdapter(this.env);
    }
    return this.auditPolicyPortPromise;
  }

  /**
   * #1724: optional HTTP_DELIVERY_MODE / JOB_LIST_ENVELOPE
   * session/user carriers for the DO entry decision in onRequest
   * (delivery run = the `x-delivery-mode` header, envelope run = the
   * `?envelope=` query param, global env = this.env). Populated by
   * the execution-context owner; unset carriers fall through to env.
   * In production today only run + env are settable — the same
   * boundary as #1721/#1722/#1723. See src/config/asyncJobModes.ts.
   */
  scopedHttpDeliveryModes?: HttpDeliveryScopedModes;
  scopedJobListModes?: JobListScopedModes;

  /**
   * #1735: optional PAYMENTS_FLOW_MODE session/user carriers for the
   * payments routes (run is per-call on the route context, global
   * env = this.env). Populated by the execution-context owner;
   * unset carriers fall through to env. In production today only
   * env is settable — the same boundary as #1721/#1722/#1723/#1724.
   * See src/config/paymentsFlowModes.ts.
   */
  scopedPaymentsFlowModes?: PaymentsFlowScopedModes;

  /** Step bound for chat turns (sanitized clamp; see resolveShadowMaxSteps). */
  maxSteps: number;

  /**
   * #2496 (Mesh Improvement, programme #2494): Think waits for the
   * SDK MCP client connections to settle before each turn's
   * inference loop merges the discovered catalog (this.mcp holds
   * the openaimp server registration — see
   * ./orchestrator/meshMcpClient.ts). `includeMcpTools`
   * deliberately keeps its SDK default (true): Think's auto-merge
   * of the discovered set under `tool_openaimp_<name>` keys IS the
   * provided consumption path this slice is built on.
   */
  waitForMcpConnections = { timeout: 10_000 };

  // ---------------------------------------------------------------------
  // Issue #1952 (think-fleet): the actor session + Think turn facet.
  // The turn runs through the foundation adapter (PortThink's
  // one-shot override + hook-order protocol, lifecycle boot inside
  // the adapter) over this DO's port session. The domain hooks keep
  // their port signatures but live under port* names: PortThink
  // owns the Think-signature beforeTurn/onChatResponse/onChatError
  // methods, and a same-named class method would shadow that
  // protocol and fire the domain logic twice per turn. Lazily
  // built session (Object.create test instances run without a
  // constructor) and memoized per instance.
  // ---------------------------------------------------------------------
  private actorSession?: ActorSessionPort;

  private getActorSession(): ActorSessionPort {
    return (this.actorSession ??= createCfActorSession({
      get: (key) => this.ctx.storage.get(key) as Promise<unknown>,
      put: (key, value) => this.ctx.storage.put(key, value),
      delete: async (key) => {
        await this.ctx.storage.delete(key);
      },
    }));
  }

  /**
   * Issue #1738: reset epoch for in-flight turns. abortAllRequests
   * bumps it; the facet wrapper below gates onChatResponse on it
   * and removes a stale turn's appended message, so a memory reset
   * cannot land a stale turn's side effects after the clear.
   */
  private turnEpoch = 0;

  /**
   * Issue #1952: the port hooks object. The epoch gate mirrors the
   * retired runner's isAborted: onChatResponse is suppressed for a
   * turn aborted mid-flight (its pendingTurn was already consumed
   * by the reset, so firing would steal a newer turn's stash);
   * onChatError stays ungated (the retired runner reported model
   * failures even when aborted). Ungated when no epoch is passed
   * (the direct-turn portHooks assignment in the constructor).
   */
  private actorTurnHooks(epoch?: number): ActorTurnHooks {
    return {
      getModel: () => this.getModel(),
      getSystemPrompt: () => this.getSystemPrompt(),
      getTools: () => this.getTools(),
      beforeTurn: (ctx) => this.portBeforeTurn(ctx),
      onChatResponse: (result) =>
        epoch === undefined || this.turnEpoch === epoch
          ? this.portOnChatResponse(result)
          : Promise.resolve(),
      onChatError: (error) => this.portOnChatError(error),
      // Issue #3471: the settings-change webhook (the port verifies
      // and dispatches it, #3474) — the Stock Copilot push leg.
      onWebhook: (event) => this.portOnSettingsWebhook(event),
      // Issue #3490: the email channel's first consumer is the
      // orchestrator's hook stub (no behavior) — the port accepts
      // and logs the mail, and real per-copilot email behavior is
      // each copilot's own follow-on.
      onEmail: (event) => this.portOnEmail(event),
      maxSteps: this.maxSteps,
    };
  }

  /**
   * Issue #3471: a verified settings-change delivery (broker/mode
   * selection writes notify this instance through the built-in
   * webhook channel). The handler re-resolves the selection,
   * records a real change in the copilot activity feed, and
   * setStates the held selection — the base Agent broadcast,
   * unwrapped, is what pushes it to connected clients (#3472).
   * Extracted to ./orchestrator/settingsWebhook.ts (#992 pattern);
   * this method only binds the class's own members.
   */
  private async portOnSettingsWebhook(event: ActorWebhookEvent): Promise<void> {
    await handleSettingsWebhook(
      {
        env: this.env,
        activity: createStockCopilotActivityPort(this.ctx.storage.sql),
        readSettingRaw: (key) => this.readSettingRaw(key),
        getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
        getState: () => this.state,
        setState: (next) => {
          const self = this as { setState?: (s: unknown) => void };
          self.setState?.(next);
        },
        audit: (type, agent, payload) => this.audit(type, agent, payload),
      },
      event,
    );
  }

  /**
   * Issue #3490: the email channel's first consumer — a stub with
   * NO behavior, by design. The port has already accepted, parsed,
   * and logged the mail; this hook exists so the orchestrator's
   * instances are addressable on the channel
   * (`orchestrator-agent+<login>@<domain>`) and so the no-hook
   * no-op is a deliberate opt-in point, not an accident. Real
   * per-copilot email behavior is each copilot's own follow-on
   * and lands on this hook, not beside it.
   */
  private async portOnEmail(_event: ActorEmailEvent): Promise<void> {
    return;
  }

  private createActorTurnRunner(): ActorTurnPort {
    const epoch = this.turnEpoch;
    const session = this.getActorSession();
    const inner = createThinkActorTurn(this, this.actorTurnHooks(epoch), session);
    return {
      runTurn: async (input) => {
        const result = await inner.runTurn(input);
        if (this.turnEpoch !== epoch) {
          // Aborted mid-flight: the facet already appended the
          // assistant message, so remove it, and report the same
          // aborted shape the retired runner returned (no message,
          // no onChatResponse — already gated above).
          if (result.message) await session.deleteMessages([result.message.id]);
          return { status: "error", error: "aborted", requestId: result.requestId, continuation: false };
        }
        return result;
      },
    };
  }

  /**
   * Issue #1952: port* names — Think owns the getMessages /
   * addMessages / runTurn names with its own session-backed
   * signatures, so the class's port-transcript accessors cannot
   * keep those names (their signatures are incompatible). The
   * route context bags keep the getMessages/addMessages property
   * names; only the class methods are renamed.
   */
  /** Actor session transcript (replaces Think's session store). */
  private getPortMessages(): Promise<UiChatMessage[]> {
    return this.getActorSession().getMessages();
  }

  /** Upsert-by-id transcript append (Think saveMessages semantics). */
  private addPortMessages(messages: UiChatMessage[]): Promise<void> {
    return this.getActorSession().appendMessages(messages);
  }

  /**
   * Think chat turn, driven through the port's turn facet.
   * Issue #2566: the chat-turn driver no longer drives the facet —
   * it submits through Think's durable submission queue (the facet
   * cannot persist a turn across an instance restart). The facet
   * is retained deliberately: it is the actor port's turn surface
   * (the conformance suite in tests/actor-ports-conformance runs
   * against it), and it remains the only path that carries a
   * configOverride turn, which the submission queue has no
   * equivalent for.
   */
  private runFacetTurn(input: Parameters<ActorTurnPort["runTurn"]>[0]): Promise<ChatResponseResult> {
    return this.createActorTurnRunner().runTurn(input);
  }

  /**
   * Issue #1738: Agent-native abort for the memory-reset route.
   * Bumps the turn epoch; in-flight turns check it before landing
   * side effects (see createActorTurnRunner). The route calls
   * resetTurnState + clearConversationMessages separately, so each
   * method keeps its own scope.
   */
  // Protected, not private: Think declares abortAllRequests /
  // resetTurnState protected, and the class's versions must keep
  // at least that visibility (see the clearMessages note).
  protected abortAllRequests(_reason?: unknown): void {
    this.turnEpoch++;
    // Issue #2566: cancel the driver's in-flight submission too, so
    // a memory reset signals the SDK queue (best-effort: a reset
    // must never fail because the queue could not be reached, and
    // the epoch gate in the wait half still lands the aborted shape
    // if the cancellation arrives too late to matter).
    const active = this.activeSubmittedTurn;
    if (active) {
      this.activeSubmittedTurn = undefined;
      try {
        void this.cancelSubmission(active.submissionId).catch(() => {});
      } catch {
        // Engine without the submission surface (test stubs): the
        // epoch bump above is the whole contract there.
      }
    }
  }

  /** Reset the in-flight turn stash. */
  protected resetTurnState(): void {
    this.pendingTurn = undefined;
  }

  /**
   * Clear the actor transcript (transcript only — mas_messages
   * audit rows are untouched). Dual store (#1952): the port
   * transcript is cleared authoritatively, and Think's tree session
   * is cleared best-effort behind it — a port-only clear would
   * leave pre-reset history in the next turn's model context.
   * The tree clear is best-effort (a failure warns, it never fails
   * the reset the port clear already performed); the lifecycle
   * boot covers RPC-only instances whose session is not started.
   * Public because Think's clearMessages is public; the override
   * keeps that contract and extends it to both stores.
   */
  async clearMessages(): Promise<void> {
    await this.getActorSession().clear();
    try {
      await (
        this as unknown as { lifecycle?: { start?: () => Promise<unknown> } }
      ).lifecycle?.start?.();
      await super.clearMessages();
    } catch (err) {
      structuredLog.warn("orchestrator.think_session_clear_failed", {
        message: "[OrchestratorAgent] Think session clear failed; port transcript is cleared:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Issue #1738: Agent-native replacement for Think's
   * waitUntilStable. Polls the in-flight turn stash — the only
   * in-flight work this class tracks — until it clears or the
   * timeout elapses. Best-effort: the single caller already
   * catches and continues on timeout.
   * Issue #1952: renamed — Think owns waitUntilStable with
   * turn-queue-drain semantics; this polls the class's own stash.
   * The scheduled-callbacks context bag keeps the waitUntilStable
   * property name.
   */
  private async waitForPendingTurn(options?: { timeout?: number }): Promise<boolean> {
    const timeout = options?.timeout ?? 30_000;
    const deadline = Date.now() + timeout;
    while (this.pendingTurn !== undefined) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Issue #992: context builders for the modules extracted under
  // ./orchestrator/. Each builder assembles the explicit ports one
  // module's functions receive; DO storage, locks and identity stay
  // owned by this class — the builders only bind its own members.
  // ---------------------------------------------------------------------

  private scheduleMaintenanceContext(): ScheduleMaintenanceContext {
    return {
      agentCtx: this.ctx,
      listSchedules: () => this.listSchedules(),
      cancelSchedule: (id) => this.cancelSchedule(id),
      schedule: (when, callback, payload, options) => this.schedule(when, callback as keyof this, payload, options),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      screenerExecutionContextKey: SCREENER_EXECUTION_CONTEXT_KEY,
      legacyScheduleMigrationKey: LEGACY_SCHEDULE_MIGRATION_KEY,
      strategyScanCron: STRATEGY_SCAN_CRON,
    };
  }

  private scheduledTasksObserveContext(): ScheduledTasksObserveContext {
    return {
      agentCtx: this.ctx,
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    };
  }

  // Issue #3391: ports for the Stock Copilot cycle declaration
  // (./orchestrator/scheduledTasksCopilot.ts). The declaration itself
  // gates on the STOCK_COPILOT_PAPER_ENABLED flag + this instance's
  // screener execution context, so flag-off instances declare nothing.
  private scheduledTasksCopilotContext(): ScheduledTasksCopilotContext {
    return {
      env: this.env,
      agentCtx: this.ctx,
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      getOrm: () => this.getOrm(),
      readSettingRaw: (key) => this.readSettingRaw(key),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    };
  }

  private scheduledCallbacksContext(): ScheduledCallbacksContext {
    return {
      env: this.env,
      agentCtx: this.ctx,
      self: this,
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      removeUnownedBaselineSchedules: () => this.removeUnownedBaselineSchedules(),
      getOrm: () => this.getOrm(),
      sessionKey: () => this.sessionKey(),
      waitUntilStable: (options) => this.waitForPendingTurn(options),
      scheduledScreenerSlots: (this.scheduledScreenerSlots ??= new Set<string>()),
      scheduledDiscoverySlots: (this.scheduledDiscoverySlots ??= new Set<string>()),
      scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string, chainReport?: boolean) =>
        scheduleScreenerFollowups(this.asyncJobsContext(), outcome, userLogin, chainReport),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      serviceMembershipStore: createKvMembershipStore(sessionStore(this.env)),
    };
  }

  private nlqPortsContext(): NlqPortsContext {
    return {
      schedule: (when, callback, payload, options) =>
        this.schedule(when, callback as keyof this, payload, options),
      scheduleEvery: (intervalSeconds, callback, payload) =>
        this.scheduleEvery(intervalSeconds, callback as keyof this, payload),
      cancelSchedule: (id) => this.cancelSchedule(id),
      listSchedules: () => this.listSchedules(),
      getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      getSocialBriefStore: () =>
        createSocialBriefStoreFromNamespace(
          this.env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
        ),
      // Issue #2369: env + this instance's SQL for the chat
      // screen's workflow start and mas_reports read-back.
      env: this.env,
      ensureTables: () => this.ensureTables(),
      // Issue #2428 (Agent Mesh S17): the chat screen's workflow
      // command is stamped with the in-flight turn's traceparent
      // (the same lazy mint the turn tools read), so the run
      // joins the turn's trace.
      traceparent: () => this.turnTraceparent(),
    };
  }

  /**
   * Issue #2428 (Agent Mesh S17): the in-flight turn's mesh
   * traceparent. Minted lazily on first read (one trace per
   * turn, shared by the turn tools, the door calls, the queued
   * jobs, and the NLQ screen port) and the turn hop is recorded
   * once, best-effort, at mint time. No in-flight turn → no
   * trace (undefined): consumers outside a turn record nothing
   * rather than fabricating an ingress.
   */
  private turnTraceparent(): string | undefined {
    const turn = this.pendingTurn;
    if (!turn) return undefined;
    if (!turn.traceparent) {
      const trace = newTraceContext();
      turn.traceparent = formatTraceparent(trace);
      if (!turn.traceHopRecorded) {
        turn.traceHopRecorded = true;
        void recordTraceHopBestEffort(this.env, {
          traceId: trace.traceId,
          spanId: trace.spanId,
          kind: "turn",
          operation: "chat.turn",
          timestampMs: Date.now(),
          caller: turn.userLogin,
          agent: "OrchestratorAgent",
        });
      }
    }
    return turn.traceparent;
  }

  private asyncJobsContext(): AsyncJobsContext {
    return {
      env: this.env,
      agentCtx: this.ctx,
      // Issue #3922: the instance's settings reader, forwarded
      // into mcp.tool executions (the ND gate's stored layer).
      readSettingRaw: (key) => this.readSettingRaw(key),
      ensureTables: () => this.ensureTables(),
      sessionKey: () => this.sessionKey(),
      schedule: (when, callback, payload, options) => this.schedule(when, callback as keyof this, payload, options),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getOrm: () => this.getOrm(),
      routeRequest: (request) => this.routeRequest(request),
      nlqSchedulingPort: () => this.nlqSchedulingPort(),
      nlqStockScreenPort: () => this.nlqStockScreenPort(),
      followupReportPort: () => ({
        getStockPdf: async (userLogin: string, key: string) => {
          const pdf = await this.getScreenerAgent(userLogin).getPdfByKey(key);
          return pdf ? { fileName: pdf.fileName } : null;
        },
        getOptionsPdf: async (userLogin: string, key: string) => {
          const pdf = await this.getScreenerAgent(userLogin).getOptionsPdfByKey(key);
          return pdf ? { fileName: pdf.fileName } : null;
        },
      }),
      followupDeliveryPort: () => createFollowupDeliveryPort({
        env: this.env,
        getOrm: () => this.getOrm(),
        getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin),
      }),
      deliverySuppressor: createDeliverySuppressor(createSqlDeliverySuppressionStore(() => this.ensureTables())), // Issue #2913 (G6): durable suppression — one claims table shared by every context built here (lazy store).
      serviceMembershipStore: createKvMembershipStore(sessionStore(this.env)),
      notifyStuckRun: async (info) => {
        // Issue #2567: stuck-running alert via postSlackText (the #1819
        // resource cap-alert seam; webhook first, bot token second).
        // Text renders from the outcome catalog (#2975); the legacy
        // text is the fallback. Detection + the exactly-once claim
        // live in asyncJobs.maybeAlertStuckRunning.
        const text = renderChannelText("stuck_run_alert", "slack", {
          jobId: info.jobId, label: info.label, ageMin: Math.round(info.ageMs / 60000),
          thresholdMin: Math.round(info.thresholdMs / 60000), capability: info.capability,
          ownerLogin: info.ownerLogin, startedAt: info.startedAt,
          // Issue #3811: the stall evidence rides the alert text —
          // the executor's last activity, falling back to the claim
          // instant for rows that predate heartbeats.
          lastActivityAt: info.lastActivityAt ?? info.startedAt,
          lastActivityMin: Math.round((info.heartbeatAgeMs ?? info.ageMs) / 60000),
        }, "legacy_stuck_run_alert");
        const result = await postSlackText({ post: fetchSlackPost, env: this.env, text });
        this.audit(result.ok ? "async_job.stuck_alert" : "async_job.stuck_alert_failed", "orchestrator", {
          jobId: info.jobId,
          capability: info.capability,
          ownerLogin: info.ownerLogin,
          ageMs: info.ageMs,
          ...(result.ok ? { method: result.method } : { error: result.error }),
        });
      },
    };
  }

  private scheduleWatchdogContext(): ScheduleWatchdogContext {
    return {
      env: this.env,
      sql: this.ctx.storage.sql,
      storage: this.ctx.storage,
      listSchedules: () => this.listSchedules(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      notifyMissedSchedule: async (info) => {
        // Issue #3788: missed-schedule alert via postSlackText (the
        // #2567 stuck-run seam: catalog text, webhook first, bot
        // token second). Detection + the exactly-once claim live in
        // scheduleWatchdog.watchdogMissedSchedules; this hook is
        // delivery only, and audits its own outcome.
        const text = renderChannelText("missed_schedule_alert", "slack", {
          scheduleId: info.scheduleId, kind: "schedule", callback: info.callback,
          expectedTick: info.expectedTick, lastRun: info.lastRun ?? "never",
          detail: `missed-fire: expected ${info.expectedTick} (last run: ${info.lastRun ?? "never"})`,
        }, "legacy_missed_schedule_alert");
        const result = await postSlackText({ post: fetchSlackPost, env: this.env, text });
        this.audit(result.ok ? "schedule.missed_fire_alert" : "schedule.missed_fire_alert_failed", "orchestrator", {
          scheduleId: info.scheduleId,
          callback: info.callback,
          ...(result.ok ? { method: result.method } : { error: result.error }),
        });
      },
    };
  }

  private autopilotContext(): AutopilotContext {
    return {
      env: this.env,
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      autopilotStateKey: OrchestratorAgent.AUTOPILOT_STATE_KEY,
    };
  }

  private reportDispatchContext(): ReportDispatchContext {
    return {
      env: this.env,
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      reportDispatchHitlKey: OrchestratorAgent.REPORT_DISPATCH_HITL_KEY,
      reportConfirmationTtlMs: REPORT_CONFIRMATION_TTL_MS,
      sendReportEmail: (recipient, title, fileName, attachmentBase64, userLogin) =>
        this.sendReportEmail(recipient, title, fileName, attachmentBase64, userLogin),
      sendReportWebhook: (title, query, sheets, userLogin) =>
        this.sendReportWebhook(title, query, sheets, userLogin),
    };
  }

  private chatTurnHelpersContext(): ChatTurnHelpersContext {
    return {
      env: this.env,
      // Issue #3922: the instance's settings reader, forwarded
      // into the turn's tool context (the ND gate's stored layer).
      readSettingRaw: (key) => this.readSettingRaw(key),
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      // Issue #1686: the DO blob handle, so chat-turn tool screens
      // (etrade_market_scan) capture fully instead of outcome-only.
      storage: this.ctx.storage,
      sessionKey: () => this.sessionKey(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      submitAsyncJob: (job) => this.submitAsyncJob(job),
      getAsyncJob: (jobId) => this.getAsyncJob(jobId),
      listAsyncJobs: (limit) => this.listAsyncJobs(limit),
      getMessages: () => this.getPortMessages(),
      // Issue #2341: the mesh doors' acting identity — the in-flight
      // turn's userLogin from the turn stash (filled by the HTTP
      // driver before runTurn, or by portBeforeTurn for WS turns).
      turnUserLogin: () => this.pendingTurn?.userLogin,
      // Issue #2428 (Agent Mesh S17): the mesh doors' and jobs'
      // trace carrier — the in-flight turn's traceparent, minted
      // lazily on the turn stash (see turnTraceparent()).
      turnTraceparent: () => this.turnTraceparent(),
      // Issue #1738: Think's active-turn metadata went away with
      // the base change. deriveTurn falls back to the last user
      // message's metadata, which carries sourceTab/userLogin for
      // turns the HTTP driver builds (pendingTurn).
      activeTurnMetadata: undefined,
    };
  }

  private httpEntryContext(): HttpEntryContext {
    return {
      sessionKey: () => this.sessionKey(),
      recordMessage: (role, content, agent) => this.recordMessage(role, content, agent),
      addMessages: (messages) => this.addPortMessages(messages),
      submitAsyncJob: (job) => this.submitAsyncJob(job),
    };
  }

  private researchPublishContext(): ResearchPublishContext {
    return {
      env: this.env,
      agentCtx: this.ctx,
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      getResearchAgent: (userLogin?: string) => this.getResearchAgent(userLogin),
      runAgentTool: (cls, options) => this.runAgentTool(cls as any, options),
      getReportDispatchHitl: () => this.getReportDispatchHitl(),
      createReportConfirmation: (kind, payloadJson, reportId, createdBy) =>
        this.createReportConfirmation(kind, payloadJson, reportId, createdBy),
      RESEARCH_TASK_HEARTBEAT_MS,
    };
  }

  /**
   * ScreenerAgent stub (issue #261) — one agent owns all screening.
   * E*TRADE-only market data; honest failure when unavailable.
   */
  private getScreenerAgent(userLogin?: string): ScreenerAgent {
    // Issue #1185: per-owner instances; naming/owner resolution lives
    // in ./screenerAgentName (fail closed without an identity).
    // Addressing rides the ActorGateway (#1779); the stub type is unchanged.
    return actorGateway.stub<ScreenerAgent>(
      this.env.SCREENER_AGENT,
      resolveScreenerAgentName(this.env, userLogin),
    );
  }

  // Issue #992: extracted to ./orchestrator/scheduleMaintenance.ts (getScreenerExecutionContext);
  private async getScreenerExecutionContext(): Promise<ScreenerExecutionContext | undefined> {
    return getScreenerExecutionContext(this.scheduleMaintenanceContext());
  }

  // Issue #992: extracted to ./orchestrator/scheduleMaintenance.ts (migrateLegacyScreenSchedules);
  private async migrateLegacyScreenSchedules(context: ScreenerExecutionContext): Promise<void> {
    return migrateLegacyScreenSchedules(this.scheduleMaintenanceContext(), context);
  }

  // Issue #992: extracted to ./orchestrator/scheduleMaintenance.ts (removeUnownedBaselineSchedules);
  private async removeUnownedBaselineSchedules(): Promise<void> {
    return removeUnownedBaselineSchedules(this.scheduleMaintenanceContext());
  }

  /**
   * ResearchAgent stub (issue #319) — one agent owns options research.
   * Per-tenant instance id: research:<userLogin>.
   */
  private getResearchAgent(userLogin?: string): ResearchAgent | null {
    const ns = this.env.RESEARCH_AGENT;
    if (!ns) return null;
    // Issue #2327 (Agent Mesh S3): no identity, no instance. A
    // missing, blank, or retired-literal login resolves NO stub —
    // callers fail closed on the null — instead of silently landing
    // on the shared research:default instance, which attributed
    // work to a login that is no user.
    const trimmed = typeof userLogin === "string" ? userLogin.trim() : "";
    if (!trimmed || trimmed === "default") return null;
    const login = userLogin as string;
    // Addressing rides the ActorGateway (#1779); the null guards above are unchanged.
    return actorGateway.stub<ResearchAgent>(ns, `research:${login}`);
  }

  // Issue #992: extracted to ./orchestrator/researchPublish.ts (runResearchAndPublish);
  async runResearchAndPublish(
    trigger: "manual" | "scheduled",
    userLogin?: string
  ): Promise<{
    success: boolean;
    error?: string;
    reportId?: string | null;
    created?: boolean;
    emailed?: boolean;
    report?: unknown;
    taskId?: string | null;
    executionPath?: ResearchExecutionPath;
  }> {
    return runResearchAndPublish(this.researchPublishContext(), trigger, userLogin);
  }

  // Issue #992: extracted to ./orchestrator/researchPublish.ts (deliverResearchReport);
  private async deliverResearchReport(
    agent: { getResearchPdfByKey(k: string): Promise<{ bytes: Uint8Array; fileName: string } | null>; refreshIdeaQuotes(r: unknown, u?: string): Promise<Array<{ symbol: string; status: string; detail: string }>>; getResearchConfig(): Promise<{ autoEmail?: boolean; emailTo?: string }> },
    report: {
      runId: string;
      trigger: string;
      createdAt: string;
      summary: string;
      ideas: Array<{ rank: number; symbol: string; outlook: string; structure: string; score: number; thesis: string }>;
      watchlist: Array<{ symbol: string }>;
      rejected: Array<unknown>;
      userLogin?: string;
    },
    opts: { reportId: string | null; pdfKey: string | null; trigger: string; userLogin: string }
  ): Promise<{ emailed: boolean; slack: boolean; webhook: boolean; held: boolean }> {
    return deliverResearchReport(this.researchPublishContext(), agent, report, opts);
  }

  // Issue #992: extracted to ./orchestrator/researchPublish.ts (sendResearchSummaryEmail);
  private async sendResearchSummaryEmail(
    recipient: string,
    summary: string,
    ideaCount: number,
    reportId: string | null,
    userLogin: string
  ): Promise<boolean> {
    return sendResearchSummaryEmail(this.researchPublishContext(), recipient, summary, ideaCount, reportId, userLogin);
  }

  /** Issue #1559 — thin wrapper for the operator route's one-time halt seed (execution in ./orchestrator/governanceSeed.ts). */
  async seedGovernanceHalt(setBy: string, tenantId: string): Promise<{ seeded: boolean; state: GovernedHaltState }> {
    return runGovernanceSeed({ doSql: this.ctx.storage.sql, env: this.env }, setBy, tenantId);
  }

  /** Issue #1676 — thin wrapper; execution in ./orchestrator/shardJobReconcile.ts. */
  async reconcileShardJobProjection(tenantId: string): Promise<ReconcileShardJobsReport> {
    return runShardJobReconcile({ env: this.env, listRailsJobs: () => this.listAsyncJobs(100), tenantId, nowMs: Date.now() });
  }

  /** Issue #1688 — thin wrapper for the operator route's one-time canonical report seed (execution in ./orchestrator/canonicalReportSeed.ts). Reads this instance's mas_reports (the canonical copy); never writes the DO table; a second run is a no-op. */
  async seedCanonicalReports(setBy: string, tenantId: string): Promise<SeedCanonicalReportsResult> {
    this.ensureTables();
    const orm = new DatabaseORM(this.ctx.storage.sql);
    return runCanonicalReportSeed({
      env: this.env,
      listCanonicalReports: () => orm.reports.findMany({ orderBy: "created_at ASC" }),
      tenantId,
      setBy,
      nowMs: Date.now(),
    });
  }
  /**
   * Issue #2223 (slice 1): A2A door, cfpay signature — the edge
   * dispatcher (src/a2a) resolves the orchestrator-family names to
   * this class on the SHARED_ORCHESTRATOR_INSTANCE instance and
   * calls this with the parsed body + origin (a Request cannot
   * cross the DO RPC boundary). Thin delegation to the dispatch
   * module (./orchestrator/a2aDispatch), which serves the MAS tools;
   * the NLQ executor is injected here because its ports are
   * class-bound. Returns the collected { text, data } outcome.
   *
   * Issue #2421 (Agent Mesh S15): RESTORED. #2178 (eff48958)
   * removed this method as collateral of the mas_events
   * audit-chain rework, leaving the five surfaces resolving at the
   * edge to a class with no handleA2A (every POST 500'd) and the
   * dispatch module with no production caller. The wiring below is
   * the #2223 original; tests/mesh_every_door_s15_2421.test.ts
   * pins its presence so a future refactor cannot unwire it
   * silently again.
   */
  async handleA2A(body: unknown, origin: string): Promise<OrchestratorA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    this.ensureTables();
    const sessionId = this.sessionKey();
    const data = await dispatchOrchestratorA2A(this.env, body, {
      sessionId,
      sql: this.ctx.storage.sql,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      nlqExecute: async (query: string) => {
        const plan = await planNLQ(this.env, query);
        return executeNLQQueryAsync(this.getOrm(), sessionId, plan, this.env, undefined, undefined, {
          schedulingPort: this.nlqSchedulingPort(),
          stockScreenPort: this.nlqStockScreenPort(),
          socialBriefPort: this.nlqSocialBriefPort() ?? undefined,
        });
      },
    });
    return orchestratorA2AOutcome(data);
  }

  // Issue #2496 (Mesh Improvement S1): the in-flight openaimp MCP
  // discovery ensure, shared by concurrent onStart/turn callers.
  private meshMcpEnsureInFlight?: Promise<EnsureOpenaimpMcpResult>;

  /**
   * #2496: (re)establish the SDK MCP client connection to this
   * instance's own openaimp MCP server, via the loopback identity
   * carrier (./orchestrator/meshMcpClient.ts). The transport is
   * memory-only (the SDK cannot persist a fetch function), so
   * every wake re-registers it after the restore settles; a live
   * connection is reused. Never throws — the ensure step audits
   * its own failure (mesh_mcp.discovery_failed) and the turn
   * degrades to its native tools until a later ensure succeeds.
   */
  private ensureMeshMcpDiscovery(): Promise<EnsureOpenaimpMcpResult> {
    const mcp = this.mcp as typeof this.mcp | undefined;
    if (!mcp) {
      // Object.create test instances run without the Agent
      // constructor, so no manager exists to discover through.
      return Promise.resolve({ ready: false, toolCount: 0, reused: false, error: "no MCP client manager on this instance" });
    }
    this.meshMcpEnsureInFlight ??= ensureOpenaimpMcpConnection({
      mcp,
      fetch: createOpenaimpMcpFetch({
        dispatch: (request) => this.routeRequest(request),
        resolveActingLogin: () => this.pendingTurn?.userLogin,
        resolveTraceparent: () => this.turnTraceparent(),
      }),
      audit: (type, payload) => this.audit(type, "orchestrator", payload),
    }).finally(() => {
      this.meshMcpEnsureInFlight = undefined;
    });
    return this.meshMcpEnsureInFlight;
  }

  /** Cloudflare Agents lifecycle: initialize SQLite and recover durable work. */
  async onStart(props?: Record<string, unknown>): Promise<void> {
    this.ensureTables();

    try {
      await this.recoverQueuedAsyncJobs();
    } catch (error) {
      structuredLog.error("orchestrator.on_start_queued_async_jobs_reschedule_failed", {
        message: "[OrchestratorAgent][onStart] Could not reschedule queued async jobs:",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Issue #3907: fail fast the orphaned `running` rows whose
    // executor died with the DO — same seam as the queued
    // recovery above, its own try/catch so a bad row never fails
    // startup.
    try {
      await this.recoverStaleRunningAsyncJobs();
    } catch (error) {
      structuredLog.error("orchestrator.on_start_stale_running_async_jobs_recovery_failed", {
        message: "[OrchestratorAgent][onStart] Could not recover stale running async jobs:",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      // Issue #2496 (Mesh Improvement S1): establish the SDK MCP
      // client connection to this instance's own openaimp MCP
      // server so chat turns discover the catalog. Best-effort: a
      // discovery failure never blocks startup (audited as
      // mesh_mcp.discovery_failed; retried at the next turn).
      await this.ensureMeshMcpDiscovery();
    } catch (meshErr) {
      structuredLog.warn("orchestrator.on_start_mesh_mcp_discovery_failed", {
        message: "[OrchestratorAgent][onStart] Mesh MCP discovery setup failed:",
        error: meshErr instanceof Error ? meshErr.message : String(meshErr),
      });
    }

    try {
      // A newly initialized Agent has only an opaque DO id, not its account
      // owner. Never use that id as an E*TRADE login. Authenticated requests
      // perform the one-time migration away from app-created baseline jobs.
      const context = await this.getScreenerExecutionContext();
      if (context?.userLogin) {
        await this.migrateLegacyScreenSchedules(context);
        // Issue #275: the hourly full-catalog strategy scan rides the
        // same authenticated maintenance path (armed once per user).
        await this.ensureStrategyScanSchedule(context);
      } else await this.removeUnownedBaselineSchedules();
    } catch (schedErr) {
      structuredLog.warn("orchestrator.on_start_legacy_schedule_reconciliation_failed", {
        message: "[OrchestratorAgent][onStart] Legacy maintenance schedule reconciliation failed:",
        error: schedErr instanceof Error ? schedErr.message : String(schedErr),
      });
    }

    try {
      // Issue #618: on the same maintenance path, close any task
      // records already stale for this user and arm the recurring
      // sweep. Best-effort: a sweep problem never blocks startup.
      const context = await this.getScreenerExecutionContext();
      if (context?.userLogin) {
        await this.sweepStaleLedgerTasks({ userLogin: context.userLogin });
        await this.ensureStaleSweepSchedule(context.userLogin);
      }
    } catch (sweepErr) {
      structuredLog.warn("orchestrator.on_start_stale_task_sweep_failed", {
        message: "[OrchestratorAgent][onStart] Stale-task sweep setup failed:",
        error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      });
    }

    try {
      // Issue #3784: run the stale-async-job sweep once and arm the
      // recurring 15-minute interval, on the same maintenance path
      // as the #618 ledger sweep. Session-scoped (this instance's
      // mas_async_jobs rows), so no screener context is needed.
      // Best-effort: a sweep problem never blocks startup.
      await this.sweepStaleAsyncJobs();
      await this.ensureStaleAsyncJobSweepSchedule();
    } catch (sweepErr) {
      structuredLog.warn("orchestrator.on_start_stale_async_job_sweep_failed", {
        message: "[OrchestratorAgent][onStart] Stale async-job sweep setup failed:",
        error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
      });
    }

    try {
      // Issue #3788: run the missed-schedule watchdog once and arm
      // the recurring 15-minute interval, on the same maintenance
      // path as the #3784 sweep (one tick, two consumers).
      // Best-effort: a watchdog problem never blocks startup.
      await this.watchdogMissedSchedules();
      await this.ensureScheduleWatchdogSchedule();
    } catch (watchdogErr) {
      structuredLog.warn("orchestrator.on_start_schedule_watchdog_failed", {
        message: "[OrchestratorAgent][onStart] Schedule watchdog setup failed:",
        error: watchdogErr instanceof Error ? watchdogErr.message : String(watchdogErr),
      });
    }

    try {
      // Issue #686: residual legacy-session lift (see
      // liftLegacyChatMessages). Best-effort: never blocks startup.
      await this.liftLegacyChatMessages();
    } catch (liftErr) {
      structuredLog.warn("orchestrator.on_start_legacy_session_lift_failed", {
        message: "[OrchestratorAgent][onStart] Legacy session lift failed:",
        error: liftErr instanceof Error ? liftErr.message : String(liftErr),
      });
    }

    try {
      // Issue #2280: the framework alarm queue (cf_agents_jobs) has no index
      // on time, so every alarm scans it. Create the seek indexes last: the
      // schedule reconciliation above has forced the framework table to
      // exist by touching the queue, and the framework creates it lazily.
      // Best-effort: a failure never blocks startup; the next start retries.
      ensureFrameworkQueueIndexes(this.ctx.storage.sql);
    } catch (idxErr) {
      structuredLog.warn("orchestrator.on_start_framework_queue_index_failed", {
        message: "[OrchestratorAgent][onStart] Framework queue index setup failed:",
        error: idxErr instanceof Error ? idxErr.message : String(idxErr),
      });
    }

    // Issue #3899 (RC1): a cold start that lands AFTER the execution
    // context exists (a redeploy, an eviction) must re-evaluate the
    // declaration against it — the onStart reconcile is the
    // best-effort arm for that path. Best-effort: a failure never
    // blocks startup.
    await this.reconcileCopilotScheduledTasks();
  }

  /**
   * Issue #686 (R6): one-time transform-migration for any residual
   * pre-SDK `cf_ai_chat_agent_messages` rows. The AIChatAgent base
   * lifted this table into the agents-SDK session store at every
   * wake and dropped it on a clean lift, so production instances
   * are already migrated; Think does not perform the lift, so this
   * covers an instance whose earlier lift was left incomplete.
   * Semantics mirror the incumbent migration: existence check,
   * idempotent import by message id (addMessages upserts by id),
   * drop the table only on a fully clean lift — otherwise leave it
   * in place and log, so the rows remain recoverable.
   */
  private async liftLegacyChatMessages(): Promise<void> {
    // Issue #1776 (#1717 Adapter S2): the lift's SQL lives in
    // SqlLegacyChatStore (src/data/doSqliteLegacyChatAdapter.ts)
    // behind the existing SqlStorage injection; this method keeps
    // only the validation / import / drop-on-clean-lift logic.
    const store = new SqlLegacyChatStore(this.ctx.storage.sql);
    if (!store.tableExists()) return;
    const rows = store.listLegacyRows();
    const valid: any[] = [];
    let skipped = 0;
    for (const row of rows) {
      try {
        const message = JSON.parse(row.message);
        if (
          !message ||
          typeof message.id !== "string" ||
          typeof message.role !== "string" ||
          !Array.isArray(message.parts)
        ) {
          skipped++;
          continue;
        }
        valid.push(message);
      } catch {
        skipped++;
      }
    }
    if (valid.length > 0) await this.addPortMessages(valid as any);
    if (skipped === 0) {
      store.dropTable();
      return;
    }
    structuredLog.error("orchestrator.legacy_lift_partial_import", {
      message: `[OrchestratorAgent] Legacy lift imported ${valid.length} of ${rows.length} rows (${skipped} skipped); leaving cf_ai_chat_agent_messages in place so they remain recoverable.`,
      imported: valid.length,
      total: rows.length,
      skipped,
    });
  }

  /**
   * Issue #618 (R4 follow-up): Cloudflare Agents Scheduled Callback
   * that closes stale research and screener task records (#615) for
   * this instance's user. Each ledger is swept in isolation so one
   * failure cannot block the other; swept tasks end escalated, never
   * auto-rerun.
   */
  async sweepStaleLedgerTasks(payload?: { userLogin?: string }): Promise<{ userLogin: string | null; researchSwept: number; screenerSwept: number; researchPruned: number; screenerPruned: number }> {
    const context = await this.getScreenerExecutionContext();
    const userLogin = context?.userLogin || payload?.userLogin;
    if (!userLogin) {
      structuredLog.warn("orchestrator.stale_task_sweep_skipped_no_owner", {
        message: "[OrchestratorAgent] Skipping stale-task sweep without an authenticated account owner.",
      });
      return { userLogin: null, researchSwept: 0, screenerSwept: 0, researchPruned: 0, screenerPruned: 0 };
    }
    let researchSwept = 0;
    try {
      const research = this.getResearchAgent(userLogin);
      if (research) researchSwept = (await research.sweepStaleResearchTasks()).length;
    } catch (error) {
      structuredLog.warn("orchestrator.stale_research_sweep_failed", {
        message: `[OrchestratorAgent] Stale research sweep failed for ${userLogin}:`,
        userLogin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let screenerSwept = 0;
    try {
      screenerSwept = (await this.getScreenerAgent(userLogin).sweepStaleScreenerTasks()).length;
    } catch (error) {
      structuredLog.warn("orchestrator.stale_screener_sweep_failed", {
        message: `[OrchestratorAgent] Stale screener sweep failed for ${userLogin}:`,
        userLogin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Issue #635: retention pruning rides the same maintenance path,
    // in its own isolated legs — a prune failure never affects sweeps.
    let researchPruned = 0;
    try {
      const research = this.getResearchAgent(userLogin);
      if (research) researchPruned = (await research.pruneExpiredResearchTasks()).length;
    } catch (error) {
      structuredLog.warn("orchestrator.research_retention_prune_failed", {
        message: `[OrchestratorAgent] Research retention prune failed for ${userLogin}:`,
        userLogin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let screenerPruned = 0;
    try {
      screenerPruned = (await this.getScreenerAgent(userLogin).pruneExpiredScreenerTasks()).length;
    } catch (error) {
      structuredLog.warn("orchestrator.screener_retention_prune_failed", {
        message: `[OrchestratorAgent] Screener retention prune failed for ${userLogin}:`,
        userLogin,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (researchSwept > 0 || screenerSwept > 0 || researchPruned > 0 || screenerPruned > 0) {
      structuredLog.info("orchestrator.task_maintenance_summary", {
        message: `[OrchestratorAgent] Task maintenance for ${userLogin}: research swept=${researchSwept} pruned=${researchPruned}; screener swept=${screenerSwept} pruned=${screenerPruned}.`,
        userLogin,
        researchSwept,
        researchPruned,
        screenerSwept,
        screenerPruned,
      });
    }
    return { userLogin, researchSwept, screenerSwept, researchPruned, screenerPruned };
  }

  /** Issue #618: arm the recurring stale-sweep interval once per user. */
  private async ensureStaleSweepSchedule(userLogin: string): Promise<void> {
    const existing = await this.listSchedules().catch(() => [] as Schedule<unknown>[]);
    const already = existing.some((s) => {
      const item = s as any;
      return item.callback === "sweepStaleLedgerTasks" && item.payload?.userLogin === userLogin;
    });
    if (already) return;
    await this.scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS, "sweepStaleLedgerTasks", { userLogin });
  }

  // Issue #992: extracted to ./orchestrator/scheduleMaintenance.ts (ensureStrategyScanSchedule);
  async ensureStrategyScanSchedule(context: ScreenerExecutionContext): Promise<void> {
    return ensureStrategyScanSchedule(this.scheduleMaintenanceContext(), context);
  }

  /**
   * Issue #3899 (RC1): re-reconcile the Think scheduled-task
   * declaration after app-owned data it reads changed. The SDK's
   * own hook for this exact case — `internal_reconcileScheduledTasks`
   * ("call this after changing app-owned data that
   * `getScheduledTasks()` reads"). Best-effort by design: a
   * reconcile failure is logged, never thrown — a request must
   * never fail, and startup must never block, because the scheduler
   * could not be re-armed.
   */
  private async reconcileCopilotScheduledTasks(): Promise<void> {
    try {
      await this.internal_reconcileScheduledTasks();
    } catch (reconcileError) {
      structuredLog.warn("orchestrator.copilot_schedule_reconcile_failed", {
        message: "[OrchestratorAgent] Could not reconcile the Stock Copilot scheduled task:",
        error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      });
    }
  }

  // Issue #2693 (#2494 Think adoption, screener slice 1): extracted
  // to ./orchestrator/scheduledTasksObserve.ts
  // (declareStrategyScanObserveTasks). OBSERVE ONLY: Think
  // reconciles this declaration on startup; the task's handler
  // records occurrences and never dispatches — the STRATEGY_SCAN_CRON
  // SDK row above keeps firing the real options scan.
  override async getScheduledTasks(): Promise<ThinkScheduledTasks> {
    const observeTasks = await declareStrategyScanObserveTasks(
      this.scheduledTasksObserveContext(),
    );
    // Issue #3391: the Stock Copilot cycle task joins the declaration
    // (empty unless the flag is on and this instance holds a login
    // context — see ./orchestrator/scheduledTasksCopilot.ts).
    const copilotTasks = await declareStockCopilotTasks(
      this.scheduledTasksCopilotContext(),
    );
    return { ...observeTasks, ...copilotTasks };
  }

  // Issue #2705 (Agents SDK Skills enablement, slice 1):
  // extracted to ./orchestrator/skillPacks.ts
  // (buildOrchestratorSkillSources). The class serves ONE
  // in-repo code-manifest source — the chat-screening door
  // playbook pack; Think re-lists sources before every turn
  // and, with a non-empty catalog, adds activate_skill /
  // read_skill_resource to the turn's tool set. No other fleet
  // class overrides this hook in this slice.
  override getSkills(): SkillSource[] {
    return buildOrchestratorSkillSources();
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (autoRenewETradeTokens);
  // Issue #3788: the method records its own run (recordScheduleCallbackRun,
  // mirroring the four creatable callbacks) — before this slice, SDK
  // firings of this internal-only callback left no per-run record
  // (the #2964 carried gap), so the schedule watchdog could not
  // observe it. The delegate reports no outcome, so a completed
  // invocation records success; a throw records failure and rethrows.
  async autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "autoRenewETradeTokens",
      payload,
      schedule,
      async () => {
        await autoRenewETradeTokens(this.scheduledCallbacksContext(), payload);
        return { outcome: "success", descriptor: "token renewal complete" };
      },
    );
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (autonomousMarketScreen);
  // Issue #2964: the SDK fires this as method.call(this, payload, schedule),
  // so the schedule object arrives as the second argument and the wrapper
  // records the run against schedule.id (manual triggers resolve via the
  // payload's stamped scheduleId instead). The method stays Promise<void>.
  async autonomousMarketScreen(payload?: {
    sector?: string;
    universe?: string;
    maxItems?: number;
    broadcast?: boolean;
    trigger?: "manual" | "scheduled";
    userLogin?: string;
    environment?: ETradeEnvironment;
    emailTo?: string;
    slackChannel?: string;
    webhookUrl?: string;
    pushToSlack?: boolean;
    filters?: import("../types").StockScreenerFilter;
    provider?: import("../trading").StockScreenProvider;
    stageChain?: import("../types").StageChainConfig;
    /** Issue #2373 (slice C): schedule kind + submission
     *  authorization, forwarded to the scheduled callback. */
    scheduleKind?: "one_off" | "recurring";
    authorizedAtSubmission?: boolean;
  }, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "autonomousMarketScreen",
      payload,
      schedule,
      () => autonomousMarketScreen(this.scheduledCallbacksContext(), payload),
    );
  }

  // Consolidation C1 (issue #1201): extracted to ./orchestrator/scheduledCallbacks.ts (autonomousGoalScreen);
  // Issue #2964: recording wrapper, same pattern as autonomousMarketScreen.
  async autonomousGoalScreen(payload?: {
    goalKind?: string;
    direction?: string;
    scenarioId?: string;
    symbols?: string[];
    assetClasses?: ("stocks" | "options")[];
    trigger?: "manual" | "scheduled";
    userLogin?: string;
    environment?: ETradeEnvironment;
    emailTo?: string;
    slackChannel?: string;
    pushToSlack?: boolean;
    /** Issue #2373 (slice C): schedule kind + submission
     *  authorization, forwarded to the scheduled callback. */
    scheduleKind?: "one_off" | "recurring";
    authorizedAtSubmission?: boolean;
  }, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "autonomousGoalScreen",
      payload,
      schedule,
      () => autonomousGoalScreen(this.scheduledCallbacksContext(), payload),
    );
  }

  /**
   * Cloudflare Agents Scheduled Callback: Autonomous Options Intelligence
   * Runs cross-symbol options discovery and dispatches omnichannel push alerts
   */
  async autonomousOptionsAnalysis(payload?: AutonomousOptionsAnalysisOptions, schedule?: { id?: unknown }): Promise<void> {
    try {
      await this.waitForPendingTurn({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    // Issue #2964: outcome stash, same pattern as the extracted callbacks.
    let outcome: ScheduledCallbackOutcome = { outcome: "skipped", detail: "callback did not run" };
    const runAnalysis = async (): Promise<ScheduledCallbackOutcome> => {
      const savedContext = await this.getScreenerExecutionContext();
      const userLogin = resolveScheduledLogin(payload?.userLogin, savedContext?.userLogin) || "";
      const environment = payload?.environment || savedContext?.environment;
      if (payload?.trigger !== "manual" && !userLogin) {
        await this.removeUnownedBaselineSchedules();
        structuredLog.warn("orchestrator.unowned_scheduled_options_screen_skipped", {
          message: "[OrchestratorAgent] Skipping unowned scheduled options screen.",
        });
        return (outcome = { outcome: "skipped", detail: "unowned scheduled options screen" });
      }
      if (payload?.trigger !== "manual") {
        const slot = new Date().toISOString().slice(0, 16);
        const thesis = payload?.thesis || "bullish";
        const slotKey = `${thesis}:${slot}`;
        this.scheduledOptionsSlots ??= new Set<string>();
        if (this.scheduledOptionsSlots.has(slotKey)) {
          return (outcome = { outcome: "skipped", detail: "duplicate minute slot (in-memory)" });
        }
        if (this.scheduledOptionsSlots.size > 32) this.scheduledOptionsSlots.clear();
        this.scheduledOptionsSlots.add(slotKey);
        const key = `options:scheduled:last-slot:${thesis}`;
        const last = await this.ctx.storage.get<{ slot: string }>(key);
        if (last?.slot === slot) {
          structuredLog.warn("orchestrator.duplicate_scheduled_options_scan_suppressed", {
            message: `[OrchestratorAgent] Suppressing duplicate scheduled options scan (${thesis}) in ${slot}Z`,
            thesis,
            slot,
          });
          return (outcome = { outcome: "skipped", detail: "duplicate minute slot (persistent)" });
        }
        await this.ctx.storage.put(key, { slot });
      }
      const service = new ScheduledTasksService(this.env, this.getOrm(), userLogin, createOptionsDiscoveryPorts({ sql: this.ctx.storage.sql, storage: this.ctx.storage }).scanRuns, undefined, undefined, undefined, (outcome, schedulerUserLogin, chainReport) => scheduleScreenerFollowups(this.asyncJobsContext(), outcome, schedulerUserLogin, chainReport), {sql:this.ctx.storage.sql,blobStorage:this.ctx.storage,env:this.env}, (spec) => (this as any).submitAsyncJob(spec), undefined, this.env.SCREENER_EVENTS ?? null);
      const res = await service.autonomousOptionsAnalysis({ ...payload, userLogin, environment, sharded: payload?.sharded });
      if ((res as any).skipped) {
        return (outcome = { outcome: "skipped", detail: "service skipped" });
      }
      if (res.data?.sharded) {
        return (outcome = { outcome: "success", descriptor: "sharded to async-job rails; per-shard rows carry the outcome" });
      }
      // Issue #223 + #910 + #2091: history row + canonical row, via
      // the shared recorder (extracted so orchestrator.ts stays
      // within the #992 size budget). Failures warn inside it and
      // never turn a completed analysis into a failed one.
      const { recordOptionsOrchestratorRun } = await import("../services/optionsServeRecord");
      await recordOptionsOrchestratorRun(
        { orm: this.getOrm() as never, storage: this.ctx.storage },
        {
          timestamp: res.timestamp,
          success: res.success,
          trigger: payload?.trigger === "manual" ? "manual" : "scheduled",
          thesis: payload?.thesis || "bullish",
          symbols: res.data?.symbols || payload?.symbols || [],
          withTrades: res.data?.withTrades ?? 0,
          summary: res.data?.summary || "",
          opportunities: res.data?.opportunities || [],
          error: res.error,
          pdfKey: res.data?.pdfKey ?? null,
          xlsxKey: res.data?.xlsxKey ?? null,
          csvKey: res.data?.csvKey ?? null,
          reportUrl: res.data?.reportUrl ?? null,
          canonicalReportId: res.data?.canonicalReportId ?? null,
          scanRunId: (res.data as unknown as { scanRunId?: string } | undefined)?.scanRunId ?? null,
          userLogin: userLogin || undefined,
        },
      );
      if (res.success && res.data) {
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "options_alert",
                title: "Autonomous Options Intelligence Alert",
                summary: res.data.summary,
                symbols: res.data.symbols,
                withTrades: res.data.withTrades,
                opportunities: res.data.opportunities,
                notifications: res.data.notifications,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      } else if (!res.success) {
        // Failure surfacing (issue #112): mirror the success broadcast
        // for failures — the service audits the failure and records a
        // session message, and live clients get this broadcast.
        // Deliberately no throw: platform callback retry is not used
        // for scheduled jobs — see the failure contract on
        // ScheduledTasksService.
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "options_alert",
                title: "Autonomous Options Intelligence Failed",
                success: false,
                symbols: payload?.symbols,
                error: res.error,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      }
      // Issue #2964: the run's outcome for the recording wrapper.
      return (outcome = res.success
        ? { outcome: "success", descriptor: res.data?.summary || "options analysis complete" }
        : { outcome: "failure", error: res.error ?? "options analysis failed" });
    };

    // Issue #2964: record the run, then return void as before. A
    // throwing run records a failure and the throw still propagates
    // (SDK retry policy preserved).
    await recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "autonomousOptionsAnalysis",
      payload,
      schedule,
      async () => {
        if (typeof (this as any).keepAliveWhile === "function") {
          await (this as any).keepAliveWhile(runAnalysis);
        } else {
          await runAnalysis();
        }
        return outcome;
      },
    );
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (autonomousStrategyDiscovery);
  // Issue #2964: recording wrapper, same pattern as autonomousMarketScreen.
  async autonomousStrategyDiscovery(payload?: AutonomousStrategyDiscoveryOptions, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "autonomousStrategyDiscovery",
      payload,
      schedule,
      () => autonomousStrategyDiscovery(this.scheduledCallbacksContext(), payload),
    );
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (collectIvHistory);
  // Issue #3788: records its own run — see the token-renewal wrapper above
  // (the #2964 carried gap for internal-only callbacks).
  async collectIvHistory(payload?: { symbols?: string[]; environment?: string; userLogin?: string }, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "collectIvHistory",
      payload,
      schedule,
      async () => {
        await collectIvHistory(this.scheduledCallbacksContext(), payload);
        return { outcome: "success", descriptor: "IV collection complete" };
      },
    );
  }

  // Issue #686: the AIChatAgent-era submitMessages wrapper — an
  // emulation of the documented autonomous-admission API over
  // saveMessages — is removed. Think provides submitMessages
  // natively as the durable submissions queue (its own signature
  // and acceptance result). Issue #2566: the chat-turn driver
  // (runAgenticChatTurn) now submits through that native queue —
  // see ./orchestrator/durableTurnSubmission.ts — and channel
  // admissions reach the same driver through the route context, so
  // this is now the one submission path for programmatic turns.

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (expireStaleOrderDraft);
  // Issue #3788: records its own run — see the token-renewal wrapper above
  // (the #2964 carried gap for internal-only callbacks).
  async expireStaleOrderDraft(payload: { orderId: string; userLogin?: string }, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "expireStaleOrderDraft",
      payload,
      schedule,
      async () => {
        await expireStaleOrderDraft(this.scheduledCallbacksContext(), payload);
        return { outcome: "success", descriptor: "stale order draft expired" };
      },
    );
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (sendScheduledReminder);
  async sendScheduledReminder(payload: { reminderId: string; message: string; userLogin?: string }): Promise<void> {
    return sendScheduledReminder(this.scheduledCallbacksContext(), payload);
  }

  // Issue #992: extracted to ./orchestrator/nlqPorts.ts (nlqSchedulingPort);
  private nlqSchedulingPort(): NLQSchedulingPort {
    return nlqSchedulingPort(this.nlqPortsContext());
  }

  // Issue #992: extracted to ./orchestrator/nlqPorts.ts (nlqStockScreenPort);
  private nlqStockScreenPort(): NLQStockScreenPort {
    return nlqStockScreenPort(this.nlqPortsContext());
  }

  // #1077 Phase 5b slice 2: extracted to ./orchestrator/nlqPorts.ts
  // (nlqSocialBriefPort); null when SESSION_STORE is unavailable, so
  // NLQ brief writes fail honestly instead of writing to nowhere.
  private nlqSocialBriefPort(): NLQSocialBriefPort | null {
    return nlqSocialBriefPort(this.nlqPortsContext());
  }

  private ensureTables() {
    return ensureOrchestratorTables(this.ctx.storage.sql);
  }

  /**
   * Issue #3530 slice B: the feed-outcome door. The ScheduledAgent
   * host's settled feed runs land in THIS instance's job-outcome
   * sink — the store the Autopilot Control Center's job feed reads
   * (GET /autopilot/jobs) — recorded through the one
   * recordJobOutcome mechanism (#3527/#1976), keys + outcome codes
   * only. Never throws: a sink failure is logged, and the feed run
   * stands on its own records (run record + dataset artifact).
   */
  async recordFeedJobOutcome(input: JobOutcomeInput): Promise<void> {
    try {
      recordJobOutcome(this.ensureTables(), input);
    } catch (err) {
      structuredLog.warn("orchestrator.feed_job_outcome_record_failed", {
        message:
          "Feed job outcome record failed; the feed run stands on its own records.",
        runId: input.id,
        kind: input.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }


  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (submitAsyncJob);
  private async submitAsyncJob(
    job: AsyncJobSubmission,
  ): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
    return submitAsyncJob(this.asyncJobsContext(), job);
  }

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (recoverQueuedAsyncJobs);
  private async recoverQueuedAsyncJobs(): Promise<void> {
    return recoverQueuedAsyncJobs(this.asyncJobsContext());
  }

  // Issue #3907: extracted to ./orchestrator/asyncJobs.ts (recoverStaleRunningAsyncJobs);
  private async recoverStaleRunningAsyncJobs(): Promise<{ examined: number; failed: number }> {
    return recoverStaleRunningAsyncJobs(this.asyncJobsContext());
  }

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (getAsyncJob);
  private getAsyncJob(jobId: string): AsyncJobRecord | undefined {
    return getAsyncJob(this.asyncJobsContext(), jobId);
  }

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (listAsyncJobs);
  private listAsyncJobs(limit = 50): AsyncJobRecord[] {
    return listAsyncJobs(this.asyncJobsContext(), limit);
  }

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (executeAsyncJob);
  // Issue #3788: records its own run — see the token-renewal wrapper above
  // (the #2964 carried gap for internal-only callbacks). Every
  // invocation of this method is a firing (SDK schedule or manual
  // trigger route), so recording here cannot double-record: the
  // trigger route treats recorded callbacks as self-recording.
  async executeAsyncJob(payload: AsyncJobPayload, schedule?: { id?: unknown }): Promise<void> {
    return recordScheduleCallbackRun(
      this.ctx.storage.sql,
      "executeAsyncJob",
      payload,
      schedule,
      async () => {
        await executeAsyncJob(this.asyncJobsContext(), { jobId: payload.jobId });
        return { outcome: "success", descriptor: "async job executed" };
      },
    );
  }

  // Issue #3784: extracted to ./orchestrator/asyncJobs.ts
  // (sweepStaleAsyncJobs) — the scheduled callback that applies the
  // read path's reap + stuck alert to stale `running` rows without
  // a read. Armed from onStart beside the #618 ledger sweep.
  async sweepStaleAsyncJobs(): Promise<{ examined: number; alerted: number; reaped: number }> {
    return sweepStaleAsyncJobs(this.asyncJobsContext());
  }

  // Issue #3788: extracted to ./orchestrator/scheduleWatchdog.ts
  // (watchdogMissedSchedules) — the scheduled callback that flags
  // durable schedules whose last callback run is older than their
  // expected tick + grace. Armed from onStart on the same 15-minute
  // tick as the #3784 sweep: one tick implementation, two consumers.
  async watchdogMissedSchedules(): Promise<ScheduleWatchdogSweepResult> {
    return watchdogMissedSchedules(this.scheduleWatchdogContext(), {
      recordedCallbacks: RECORDED_SCHEDULE_CALLBACKS,
    });
  }

  /** Issue #3788: arm the recurring missed-schedule watchdog once per
   *  instance (the #618/#3784 ensure-schedule pattern: list
   *  schedules, skip when a watchdogMissedSchedules schedule exists). */
  private async ensureScheduleWatchdogSchedule(): Promise<void> {
    const existing = await this.listSchedules().catch(() => [] as Schedule<unknown>[]);
    const already = existing.some((s) => {
      const item = s as any;
      return item.callback === "watchdogMissedSchedules";
    });
    if (already) return;
    await this.scheduleEvery(SCHEDULE_WATCHDOG_INTERVAL_SECONDS, "watchdogMissedSchedules", {});
  }

  /** Issue #3784: arm the recurring stale-async-job sweep once per
   *  instance (the #618 ensureStaleSweepSchedule pattern: list
   *  schedules, skip when a sweepStaleAsyncJobs schedule exists). */
  private async ensureStaleAsyncJobSweepSchedule(): Promise<void> {
    const existing = await this.listSchedules().catch(() => [] as Schedule<unknown>[]);
    const already = existing.some((s) => {
      const item = s as any;
      return item.callback === "sweepStaleAsyncJobs";
    });
    if (already) return;
    await this.scheduleEvery(STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS, "sweepStaleAsyncJobs", {});
  }

  // Consolidation C3 (#1277): extracted to ./orchestrator/asyncJobs.ts (retryAsyncJob);
  private async retryAsyncJob(jobId: string): Promise<{ jobId: string; status: "queued"; statusUrl: string }> {
    return retryAsyncJob(this.asyncJobsContext(), jobId);
  }

  private sessionKey(): string {
    return this.ctx.id.toString();
  }

  private getOrm(): DatabaseORM {
    this.ensureTables();
    // Issue #2280 (slice 5): app-SQL measurement. A null port (no
    // OBSERVABILITY/AGENT_DB bindings) means no sink, and execQuery
    // behaves exactly as before.
    const orm = new DatabaseORM(this.ctx.storage.sql, {
      resourceSink: createResourceUsagePort(this.env) ?? undefined,
    });
    orm.initializeSchema(this.sessionKey());
    return orm;
  }

  /**
   * Inserts one audit row into mas_events and returns the stored record.
   * Single owner of audit-row inserts (issue #270): this.audit() and the
   * POST /audit/event route both funnel through here.
   * Issue #2178 (Q7 S1): via the chained events Repository, not raw SQL.
   */
  private recordAudit(
    type: string,
    agent: string,
    payload: Record<string, unknown>
  ): { id: string; type: string; agent: string; payload: Record<string, unknown>; created_at: string } {
    const orm = this.getOrm();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    orm.events.create({
      id,
      sessionId: this.sessionKey(),
      type,
      agent: agent as AuditEvent["agent"],
      payload,
      createdAt: now,
    });
    return { id, type, agent, payload, created_at: now };
  }

  private audit(type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) {
    try {
      this.recordAudit(type, agent, payload);
    } catch {
      // Don't fail execution if audit insertion fails
    }
  }

  // ---------------------------------------------------------------------------
  // Autopilot policy envelope (autopilot Phase 1)
  //
  // The Durable Object owns run state, limits, and the kill switch so that one
  // envelope governs every client and channel, and so the kill switch survives
  // a page reload. Policy decisions are recorded with a server-side signature.
  // ---------------------------------------------------------------------------

  private static readonly AUTOPILOT_STATE_KEY = "autopilot_state_v1";

  // Issue #992: extracted to ./orchestrator/autopilot.ts (marketDateKey);
  private marketDateKey(now: Date = new Date()): string {
    return marketDateKey(now);
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (readAutopilotStateRaw);
  private readAutopilotStateRaw(): Record<string, any> {
    return readAutopilotStateRaw(this.autopilotContext());
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (getAutopilotState);
  private getAutopilotState() {
    return getAutopilotState(this.autopilotContext());
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (writeAutopilotState);
  private writeAutopilotState(patch: Record<string, unknown>) {
    return writeAutopilotState(this.autopilotContext(), patch);
  }

  /** Issue #277: setting key for optional HITL confirmation on report dispatch. */
  private static readonly REPORT_DISPATCH_HITL_KEY = "report_dispatch_hitl";
  /** Pending report confirmations expire unconfirmed after this long. */

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (readSettingRaw);
  private readSettingRaw(key: string): string | null {
    return readSettingRaw(this.reportDispatchContext(), key);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (writeSetting);
  private writeSetting(key: string, value: string): void {
    return writeSetting(this.reportDispatchContext(), key, value);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (getReportDispatchHitl);
  private getReportDispatchHitl(): boolean {
    return getReportDispatchHitl(this.reportDispatchContext());
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (setReportDispatchHitl);
  private setReportDispatchHitl(enabled: boolean): void {
    return setReportDispatchHitl(this.reportDispatchContext(), enabled);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (createReportConfirmation);
  private createReportConfirmation(
    kind: "email" | "webhook" | "screener",
    payloadJson: string,
    reportId?: string | null,
    createdBy?: string | null
  ): string {
    return createReportConfirmation(this.reportDispatchContext(), kind, payloadJson, reportId, createdBy);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (getReportConfirmation);
  private getReportConfirmation(id: string): any | null {
    return getReportConfirmation(this.reportDispatchContext(), id);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (decideReportConfirmation);
  private decideReportConfirmation(id: string, status: "approved" | "rejected" | "expired", decidedBy: string | null): void {
    return decideReportConfirmation(this.reportDispatchContext(), id, status, decidedBy);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (storeResearchReportCanonicalAsync);
  private async storeResearchReportCanonicalAsync(
    bodyJson: string,
    meta: { title: string; summary: string; userLogin?: string }
  ): Promise<{ reportId: string; generationId: string } | null> {
    return storeResearchReportCanonicalAsync(this.reportDispatchContext(), bodyJson, meta);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (confirmationDeliveryMeta);
  private confirmationDeliveryMeta(row: any): { recipient?: string } {
    return confirmationDeliveryMeta(row);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (deliverStoredReportEmail);
  private async deliverStoredReportEmail(
    reportId: string,
    recipient: string,
    userLogin: string
  ): Promise<"sent" | "missing" | "failed"> {
    return deliverStoredReportEmail(this.reportDispatchContext(), reportId, recipient, userLogin);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (deliverStoredReportWebhook);
  private async deliverStoredReportWebhook(
    reportId: string,
    userLogin: string
  ): Promise<{ outcome: "sent" | "missing" | "failed"; result?: { success: boolean; status?: number; error?: string; notConfigured?: boolean } }> {
    return deliverStoredReportWebhook(this.reportDispatchContext(), reportId, userLogin);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (persistScreenerReportCanonical);
  private persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    provider?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    pdfKey?: string;
    xlsxKey?: string;
    xlsxStatus?: unknown;
    csvKey?: string;
    csvStatus?: unknown;
    runSource?: unknown;
    error?: string;
    trigger?: unknown;
    userLogin?: string;
    /** Issue #2863: replay criteria/refs (additive). */
    criteria?: unknown;
    patternRef?: unknown;
    presetRef?: unknown;
    /** Issue #2773: Pareto evaluation (additive). */
    pareto?: unknown;
  }): Promise<void> {
    return persistScreenerReportCanonical(this.reportDispatchContext(), result);
  }

  /**
   * Issue #1737: workflow doors. Thin PUBLIC wrappers over the
   * same two functions the synchronous routes use, so the
   * async path stores and delivers through identical code —
   * no new delivery path, no duplicated logic. Called by
   * ScreenerScreenWorkflow via the shared orchestrator stub.
   */
  async recordWorkflowScreenReport(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    provider?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    pdfKey?: string;
    xlsxKey?: string;
    xlsxStatus?: unknown;
    csvKey?: string;
    csvStatus?: unknown;
    runSource?: unknown;
    error?: string;
    trigger?: unknown;
    userLogin?: string;
  }): Promise<void> {
    return this.persistScreenerReportCanonical(result);
  }

  /** #2869: door over the one recorder's PDF refresh (update-only, monotonic, owner re-checked). */
  async refreshCanonicalPdfFields(input: Parameters<typeof refreshCanonicalPdfFields>[1]) { return refreshCanonicalPdfFields(this.reportDispatchContext(), input); }

  /** #2910 (G3): door — owner rides on the input; id or null, never delivers. */
  async recordWorkflowParentScreenReport(input: Parameters<typeof persistParentScreenReportCanonical>[1]): Promise<{ reportId: string } | null> { return persistParentScreenReportCanonical(this.reportDispatchContext(), input); }

  /** #3940 (#3550 precondition (a)): door — the J generate
   *  stage's tenant-aware canonical leg stores its canonical
   *  copy through this door, so the row lands in this (the
   *  report-owning tenant's) Orchestrator DO's mas_reports in
   *  both pipeline residencies. Thin wrapper over the one
   *  seam, like the screener doors above. */
  async recordPipelineGenerateReport(
    input: ScheduledReportInput,
  ): Promise<CanonicalStoreResult | null> {
    return persistPipelineGenerateReportCanonical(this.reportDispatchContext(), input);
  }

  async deliverWorkflowScreenOutcome(
    outcome: ScreenerRunOutcome,
    userLogin: string,
    deliveryId?: string,
  ): Promise<void> {
    // A caller-supplied deterministic deliveryId lets a
    // retried deliver step converge in the outcome sink
    // instead of forking a second tracked record.
    await scheduleScreenerFollowups(
      this.asyncJobsContext(),
      deliveryId ? { ...outcome, deliveryId } : outcome,
      userLogin,
    );
  }

  /**
   * Issue #1996 (#1972 slice 1): workflow doors for goal
   * screens. Thin PUBLIC wrappers over the goal dispatch
   * module — the same canonical seams the synchronous goal
   * path uses, so a workflow run and a direct run are
   * indistinguishable downstream. Called by
   * ScreenerScreenWorkflow via the shared orchestrator stub.
   */
  async recordWorkflowGoalScreenReport(
    envelope: WorkflowGoalScreenEnvelope,
    userLogin: string,
  ): Promise<string> {
    return persistWorkflowGoalScreenReport(
      { env: this.env, getOrm: () => this.getOrm() },
      envelope,
      userLogin,
    );
  }

  async deliverWorkflowGoalScreenOutcome(
    envelope: WorkflowGoalScreenEnvelope,
    userLogin: string,
    channels: ScreeningChannel[],
    emailTo?: string,
  ): Promise<void> {
    return deliverGoalScreenOutcome(
      { env: this.env, getOrm: () => this.getOrm() },
      envelope,
      userLogin,
      channels,
      emailTo,
    );
  }

  /**
   * Issue #2530: the non-deterministic mode's interpretation
   * audit door. Called by ScreenerScreenWorkflow (via the
   * shared orchestrator stub) from the parent's journaled
   * audit step: the prompt (the run's screenIntent), the raw
   * artifact the interpreter produced, and the deterministic
   * validator's verdict land in mas_events. Deliberately
   * built on recordAudit, NOT the swallowing audit() helper:
   * the workflow's contract is no-audit-no-execution, so a
   * failed insert must throw back into the audit step (which
   * retries, then fails the run before any shard executes).
   * The insert still funnels through the #270 single owner.
   */
  async recordWorkflowScreenInterpretationAudit(record: {
    jobId: string;
    userLogin: string;
    intent: string;
    artifact: unknown;
    validation: { ok: boolean; reasons?: string[] };
    effectiveFilters?: Record<string, unknown>;
  }): Promise<void> {
    this.recordAudit("screener.interpretation", "orchestrator", {
      jobId: record.jobId,
      userLogin: record.userLogin,
      mode: "non-deterministic",
      intent: record.intent,
      artifact: record.artifact ?? null,
      validation: record.validation,
      ...(record.effectiveFilters ? { effectiveFilters: record.effectiveFilters } : {}),
    });
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (sendReportEmail);
  private async sendReportEmail(
    recipient: string,
    title: string,
    fileName: string,
    attachmentBase64: string,
    userLogin: string
  ): Promise<boolean> {
    return sendReportEmail(this.reportDispatchContext(), recipient, title, fileName, attachmentBase64, userLogin);
  }

  // Issue #992: extracted to ./orchestrator/reportDispatch.ts (sendReportWebhook);
  private async sendReportWebhook(
    title: string,
    query: string,
    sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>,
    userLogin: string
  ): Promise<{ success: boolean; status?: number; error?: string; notConfigured?: boolean }> {
    return sendReportWebhook(this.reportDispatchContext(), title, query, sheets, userLogin);
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (incrementAutopilotOrdersToday);
  private incrementAutopilotOrdersToday(): void {
    return incrementAutopilotOrdersToday(this.autopilotContext());
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (fetchBrokerBalanceSnapshot);
  private async fetchBrokerBalanceSnapshot(userLogin: string, requestedEnv: unknown): Promise<unknown | null> {
    return fetchBrokerBalanceSnapshot(this.autopilotContext(), userLogin, requestedEnv);
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (openNotionalForSymbol);
  private openNotionalForSymbol(symbol: string): number | null {
    return openNotionalForSymbol(this.autopilotContext(), symbol);
  }

  // Issue #992: extracted to ./orchestrator/autopilot.ts (evaluateAndRecordAutopilotVerdict);
  private async evaluateAndRecordAutopilotVerdict(params: {
    userLogin: string;
    requestedEnv: unknown;
    sessionId: string;
    intent: OrderIntent;
    draftId?: string | null;
    dryRun?: boolean;
  }): Promise<{ verdict: PolicyVerdict; attestation: PolicyVerdictAttestation }> {
    return evaluateAndRecordAutopilotVerdict(this.autopilotContext(), params);
  }

  private recordMessage(role: "user" | "assistant" | "system", content: string, agent: AgentName | "orchestrator") {
    try {
      const sql = this.ensureTables();
      // Issue #2359 (#1976 step 4d): the write serves through
      // the step-3a message port (the table's port home)
      // instead of the raw INSERT it replaces — same row,
      // same insert-or-throw conflict policy, same swallow.
      createOrmPorts(sql).messages.create({
        id: crypto.randomUUID(),
        sessionId: this.sessionKey(),
        role,
        content: content.slice(0, 30000),
        agent,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Don't fail execution if record insertion fails
    }
  }

  // Issue #992: extracted to ./orchestrator/chatTurnHelpers.ts (extractMessageText);
  private extractMessageText(message: unknown): string {
    return extractMessageText(message);
  }

  /**
   * Issue #686 (Think migration step 4 — CUTOVER): the turn stash.
   * portBeforeTurn creates it for every turn — for facet turns from
   * the port hooks' context, for direct and submitted turns by
   * deriving it from the session (deriveTurn). portOnChatResponse
   * consumes it. One in-flight chat turn per DO instance is the
   * live semantic — the AIChatAgent base serialized turns the same
   * way. Issue #1738: the stash is in-memory only; there is no
   * durable turn sealing on eviction (see ADR 0005). Issue #2566:
   * the SUBMISSION is now durable even though the stash is not —
   * a persisted submission that outlives the instance re-executes
   * on a fresh one and re-derives the stash then (ADR 0024).
   */
  private pendingTurn?: {
    userText: string;
    userLogin: string;
    sourceTab?: string;
    isAutoOptionsResearchRequest: boolean;
    recentTurns: Array<{ role?: string; content: string }>;
    /** HTTP re-send of the history tail: the user mas_messages
     * record already exists, so beforeTurn must not write it again. */
    suppressUserRecord?: boolean;
    route?: RouteDecision;
    requestId: string;
    /**
     * Issue #2428 (Agent Mesh S17): the turn's mesh traceparent,
     * minted lazily by turnTraceparent() on first read so every
     * consumer of the turn (tools, doors, the NLQ screen port)
     * shares ONE trace. Absent until first read — a turn nobody
     * traces mints nothing.
     */
    traceparent?: string;
    /** Issue #2428: the turn hop for this trace has been recorded. */
    traceHopRecorded?: boolean;
  };

  /**
   * Issue #2566: route outcomes of driver-submitted turns, keyed by
   * the turn request id the driver stamps into the user message's
   * metadata (portBeforeTurn adopts the id and records the route
   * here when the submitted turn executes; the wait half of the
   * driver reads it back once the submission settles). Bounded by
   * the capture site (FIFO at 64 — submissions are user-paced and
   * each entry is one small route record).
   */
  private submittedTurnRoutes = new Map<string, RouteDecision>();

  /** Issue #2566: the driver's in-flight submission, so a memory
   *  reset (abortAllRequests) can cancel it in the SDK queue the
   *  same way the epoch gates the facet drive. */
  private activeSubmittedTurn?: { submissionId: string; epoch: number };

  /** Actor configuration: the constructed model arm (step-2 decision). */
  getModel() {
    return getWorkersAIModel(this.env);
  }

  /**
   * Actor configuration: the fallback system prompt for turns that
   * reach inference without beforeTurn instructions — the shared
   * builder with a neutral route, mirroring the live prompt's shape.
   */
  getSystemPrompt(): string {
    return buildOrchestratorSystemPrompt({
      route: { agent: "orchestrator", confidence: 1, reason: "Direct chat turn" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    });
  }

  /** Actor configuration: the live per-turn tool factory (#312 single owner). */
  getTools(): ToolSet {
    return this.createTurnTools(crypto.randomUUID());
  }

  // Issue #992: extracted to ./orchestrator/chatTurnHelpers.ts (createTurnTools);
  private createTurnTools(requestId: string): ToolSet {
    return createTurnTools(this.chatTurnHelpersContext(), requestId);
  }

  /**
   * Actor configuration: the session-memory context block (top-8
   * mas_memory facts). Under the actor turn runner (#1738) nothing
   * merged it; under PortThink (#1952) Think resolves it into
   * every turn again — the same facts assembleGrounding already
   * inlines into the prompt, so the block is live but redundant,
   * not new content. The method stays as the block's resolver
   * (pinned by the actor-cutover suite).
   */
  configureContext() {
    return [
      {
        label: "session-memory",
        description: "Persistent session facts recorded by earlier turns (mas_memory).",
        resolve: async () => {
          const sql = this.ensureTables();
          // Issue #2359 (#1976 step 4d): the read serves through
          // the step-3a memory port's listRecent (the identical
          // newest-first, limit-8 projection) instead of raw SQL.
          const rows = createOrmPorts(sql).memory.listRecent(8);
          if (rows.length === 0) return null;
          return rows.map((m) => `- ${m.key}: "${m.value}"`).join("\n");
        },
      },
    ];
  }

  // Issue #992: extracted to ./orchestrator/chatTurnHelpers.ts (deriveTurn);
  private async deriveTurn(ctx: TurnContext): Promise<{
    userText: string;
    userLogin: string;
    sourceTab?: string;
    isAutoOptionsResearchRequest: boolean;
    recentTurns: Array<{ role?: string; content: string }>;
  }> {
    return deriveTurn(this.chatTurnHelpersContext(), ctx);
  }

  // Issue #992: extracted to ./orchestrator/chatTurnHelpers.ts (assembleGrounding);
  private async assembleGrounding(userText: string): Promise<{ memoryContext: string; vectorContext: string }> {
    return assembleGrounding(this.chatTurnHelpersContext(), userText);
  }

  /**
   * Issue #686: actor turn lifecycle — runs before every chat turn,
   * whatever entry point drove it. Carries the duties the
   * AIChatAgent-era onChatMessage + runAgenticChatTurn split between
   * them: Judge routing (+ route.decided audit), the session-hygiene
   * purge of empty assistant messages, the user mas_messages record
   * (single writer for both entry points; suppressed only for an
   * HTTP re-send whose record already exists), the auto-research
   * NLQ pre-dispatch, grounding, and the per-turn TurnConfig (shared
   * prompt builder; tools suppressed on auto-research turns via
   * activeTools: [] — TurnConfig.tools is additive-only).
   * Issue #1952: port* name — PortThink owns the Think-signature
   * beforeTurn; this domain method is what the port hooks call.
   */
  async portBeforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    this.ensureTables();
    // Issue #2566: a driver-submitted turn arrives with no stash —
    // the stash is derived from the session, and the correlation
    // the driver stamped into the user message's metadata (its
    // turnRequestId, and the re-send record suppression) is adopted
    // so the driver can collect this turn's route outcome after
    // the submission settles.
    const derivedHere = !this.pendingTurn;
    const turn: NonNullable<typeof this.pendingTurn> = this.pendingTurn ?? {
      ...(await this.deriveTurn(ctx)),
      requestId: crypto.randomUUID(),
    };
    this.pendingTurn = turn;
    // Issue #2496: repair a failed/dropped openaimp MCP discovery
    // (a no-op when the connection is live). Think assembles the
    // turn's merged tool set before this hook runs, so a repair
    // here lands in the NEXT turn's discovered set — the wake-time
    // ensure in onStart is the primary establishment, and this
    // retry keeps a long-lived instance from staying degraded
    // after one failed wake.
    await this.ensureMeshMcpDiscovery();
    let submittedTurn = false;
    if (derivedHere) {
      try {
        const session = await this.getPortMessages();
        const lastUser = [...session].reverse().find((m: any) => m?.role === "user");
        const meta = ((lastUser as any)?.metadata ?? {}) as {
          turnRequestId?: unknown;
          suppressUserRecord?: unknown;
          recentTurns?: unknown;
          autoOptionsResearch?: unknown;
        };
        if (typeof meta.turnRequestId === "string" && meta.turnRequestId) {
          turn.requestId = meta.turnRequestId;
          submittedTurn = true;
          if (meta.suppressUserRecord === true) turn.suppressUserRecord = true;
          // Caller-carried turn inputs the facet drive received
          // directly (issue #2566): the Judge's recent-turns
          // context and the caller's auto-research determination,
          // adopted over the session derivation when present.
          if (Array.isArray(meta.recentTurns)) {
            turn.recentTurns = meta.recentTurns as Array<{ role?: string; content: string }>;
          }
          if (meta.autoOptionsResearch === true) turn.isAutoOptionsResearchRequest = true;
        }
      } catch {
        // Best-effort correlation only; the turn proceeds unadopted.
      }
    }
    const { userText, userLogin, isAutoOptionsResearchRequest, sourceTab } = turn;

    // Session hygiene: delete empty assistant messages left behind
    // by interrupted turns (the messages the live turn used to
    // filter out of its model input); activity entries are kept.
    try {
      const uiMessages = await this.getPortMessages();
      const staleIds = uiMessages
        .filter((m: any) => {
          if (!m || m.role !== "assistant" || m.metadata?.activity) return false;
          const parts = Array.isArray(m.parts) ? m.parts : [];
          const hasText = parts.some((p: any) => p && p.type === "text" && typeof p.text === "string" && p.text.trim());
          const hasTool = parts.some((p: any) => p && p.type !== "text");
          return !hasText && !hasTool;
        })
        .map((m: any) => m.id as string);
      if (staleIds.length > 0) await this.getActorSession().deleteMessages(staleIds);
    } catch {
      // Best-effort hygiene; never break the turn.
    }

    const judge = new LLMJudge(this.env);
    const route = isAutoOptionsResearchRequest
      ? {
        agent: "trading" as const,
        confidence: 1,
        reason: "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
        needsConfirmation: false,
      }
      : await judge.route(userText, turn.recentTurns);
    turn.route = route;
    this.audit("route.decided", "judge", {
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });
    if (submittedTurn) {
      // Issue #2566: record the route for the waiting driver (the
      // submission settles independently of this hook). FIFO-bound
      // at 64: a driver that never collects (instance replaced
      // mid-wait) must not grow the map without limit.
      this.submittedTurnRoutes.set(turn.requestId, route);
      while (this.submittedTurnRoutes.size > 64) {
        const oldest = this.submittedTurnRoutes.keys().next().value;
        if (oldest === undefined) break;
        this.submittedTurnRoutes.delete(oldest);
      }
    }

    if (userText && !turn.suppressUserRecord) {
      this.recordMessage("user", userText, "orchestrator");
    }

    let optionsResearchContext = "";
    if (isAutoOptionsResearchRequest) {
      try {
        const job = await this.submitAsyncJob({
          capability: "nlq.execute",
          payload: { query: userText, userLogin },
        });
        optionsResearchContext = [
          "AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:",
          JSON.stringify({
            query: userText,
            ...job,
          }),
        ].join("\n");
        this.audit("options_research.chat_query_executed", "nlq", {
          query: userText,
          sourceTab: sourceTab,
          jobId: job.jobId,
          status: job.status,
        });
      } catch (error) {
        optionsResearchContext = [
          "AUTO_OPTIONS_RESEARCH_EXECUTION_ERROR:",
          error instanceof Error ? error.message : "The Auto Options Research workflow failed.",
        ].join("\n");
        this.audit("options_research.chat_query_failed", "nlq", {
          query: userText,
          sourceTab: sourceTab,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { memoryContext, vectorContext } = await this.assembleGrounding(userText);
    // #2488/#2496: the CHAT_NLQ_MODE gate at the Think layer. The
    // discovered catalog arrives through Think's auto-merge and
    // TurnConfig.tools is additive-only, so while the switch
    // resolves off the gate restricts the turn via activeTools
    // (every merged tool except tool_openaimp_execute_nlq). The
    // auto-research suppression below still wins outright.
    const nlqGate: Partial<ChatNlqTurnGateResult> = isAutoOptionsResearchRequest
      ? {}
      : chatNlqTurnGate({
          toolNames: Object.keys(ctx.tools ?? {}),
          context: {
            env: this.env,
            // Issue #3741: the turn's identity + this instance's
            // settings reader, so the chat/NLQ choice resolves
            // per agent class and copilot registration through
            // the one resolver (stored layer included). With
            // nothing stored — production today — the resolution
            // is the pre-#3741 env chain exactly.
            className: "OrchestratorAgent",
            registrationId: copilotRegistrationForSourceTab(sourceTab),
            readSettingRaw: (key) => this.readSettingRaw(key),
          },
          audit: (type, payload) => this.audit(type, "orchestrator", payload),
        });
    // Issue #3721 (Capability S4): the Stock Copilot's mcp-client
    // activation. The discovered set is in the turn by #2496's
    // merge (nothing to include or exclude here); the activation —
    // the stock registration's declaration, read through the #3489
    // class manifest against this deployment's env — is what
    // steers a stock turn to the copilot's own discovered
    // commands. A stock turn whose activation is withdrawn (the
    // manifest's externalized override) is audited, never
    // silently unsteered.
    const stockMcpActivation = resolveStockCopilotMcpActivation({
      sourceTab,
      env: this.env as unknown as Record<string, unknown>,
    });
    if (sourceTab === STOCK_COPILOT_SOURCE_TAB && !stockMcpActivation.active) {
      this.audit("stock_copilot.mcp_client_inactive", "orchestrator", {
        state: stockMcpActivation.state,
      });
    }
    const chatExecSetting = this.readSettingRaw("stock_copilot:chat_execution_mode");
    const apState = this.getAutopilotState();
    const copilotExecutionMode: "autonomous" | "hitl" =
      chatExecSetting === "autonomous" || (chatExecSetting !== "hitl" && apState.running && !apState.killSwitch)
        ? "autonomous"
        : "hitl";
    // Issue #3839: the copilot's steering follows the ACTIVE broker/mode
    // from the tenant selection, not a hardcoded broker. An unresolved or
    // unsupported selection leaves the capability absent; the default
    // Alpaca steering and the cycle's own refusal handle it.
    let stockCopilotCapability: StockCopilotPromptCapability | undefined;
    if (stockMcpActivation.active) {
      const copilotSelection = await resolveCopilotTradingSelection({
        env: this.env,
        readSettingRaw: (key) => this.readSettingRaw(key),
      });
      if (copilotSelection.resolved && isCopilotBroker(copilotSelection.selection.brokerId)) {
        const capability = brokerCopilotCapability(copilotSelection.selection.brokerId);
        stockCopilotCapability = {
          brokerId: copilotSelection.selection.brokerId,
          brokerLabel: BROKER_CATALOG[copilotSelection.selection.brokerId].label,
          mode: copilotSelection.selection.mode,
          environment: copilotSelection.selection.environment,
          tools: capability.tools,
          bracketOrders: capability.bracketOrders,
          percentBrackets: capability.percentBrackets,
        };
      }
    }
    return {
      instructions: buildOrchestratorSystemPrompt({
        route,
        memoryContext,
        vectorContext,
        optionsResearchContext,
        isAutoOptionsResearchRequest,
        stockCopilotMcpActive: stockMcpActivation.active,
        stockCopilotCapability,
        // #3727: the steering follows the SAME value the gate
        // resolved for this turn (nlqGate.mode) — no second read
        // of CHAT_NLQ_MODE. The auto-research branch never runs
        // the gate; its steering stays the flagged-off default.
        chatNlqEnabled: nlqGate.mode === "on",
        copilotExecutionMode,
      }),
      maxSteps: this.maxSteps,
      ...(isAutoOptionsResearchRequest
        ? { activeTools: [] as string[] }
        : nlqGate.activeTools
          ? { activeTools: nlqGate.activeTools }
          : {}),
    };
  }

  /**
   * Issue #686: actor turn lifecycle — fires after a chat turn completes
   * (any entry point) once the assistant message is persisted.
   * Applies the live streamText onFinish side-effects: the assistant
   * mas_messages record (route.agent attribution), judge.evaluate →
   * response.evaluated audit, and best-effort VectorMemory remember.
   * Consumes the turn stash.
   * Issue #1952: port* name — PortThink owns the Think-signature
   * onChatResponse (record-only during facet turns); this domain
   * method is what the port hooks call after the append.
   */
  async portOnChatResponse(result: ChatResponseResult): Promise<void> {
    const turn = this.pendingTurn;
    this.pendingTurn = undefined;
    if (!turn || result.status === "error" || !result.message) return;
    const text = this.extractMessageText(result.message);
    if (!text || !turn.route) return;
    const route = turn.route;
    this.recordMessage("assistant", text, route.agent);
    const judge = new LLMJudge(this.env);
    const quality = await judge.evaluate({ question: turn.userText, answer: text, agent: route.agent });
    this.audit("response.evaluated", "judge", {
      score: quality.score,
      grounded: quality.grounded,
      safe: quality.safe,
      issues: quality.issues,
    });
    const vectorizeBinding = (this.env as any).VECTOR_MEMORY;
    try {
      if (this.env.AI && vectorizeBinding) {
        const vm = new VectorMemory(this.env.AI, vectorizeBinding, undefined);
        await vm.remember({
          jobId: turn.requestId,
          operation: `chat:${route.agent}`,
          summary: `Q: ${turn.userText.slice(0, 300)}\nA: ${text.slice(0, 500)}`,
          success: quality.safe !== false && quality.grounded !== false,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      structuredLog.warn("orchestrator.vector_remember_failed", {
        message: "[VectorMemory] remember failed:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Issue #686: actor turn lifecycle — a chat turn that fails terminally
   * surfaces the aspect format the AIChatAgent-era UI stream's
   * onError produced ([code] title: message + remediation steps),
   * after logging the same aspect event that handler recorded.
   * Issue #1952: port* name and synchronous by design — Think calls
   * its error hook without awaiting it, so only a sync hook controls
   * the error text; PortThink owns the Think-signature name.
   */
  portOnChatError(error: unknown): string {
    const aspect = resolveErrorAspect(error);
    logAspectEvent({
      aspect: "ChatStream",
      operationName: "uiStreamError",
      code: aspect.code,
      level: "error",
      error: aspect.message,
      audit: (e, _c, p) => this.audit(e, "orchestrator", p),
    });
    return `[${aspect.code}] ${aspect.title}: ${aspect.message}\n\nRemediation:\n${aspect.resolutionSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  }

  /**
   * Issue #312: the single-owner agentic chat turn. Judge routing, sub-agent
   * tools, memory/vector grounding, and the model call live here and only here.
   * POST /api/chat awaits the final text via this driver. Never duplicate
   * this pipeline. Issue #1952: the HTTP driver is the supported chat
   * entry (no in-repo client uses Think's native WebSocket transport).
   * Issue #686: the driver runs the turn through the Think turn facet
   * and returns the adapter shape the routes expect, {result,
   * route}. The user message enters the session through the factory
   * input (delta-by-id), so an HTTP re-send of the history tail does
   * not duplicate it.
   * Issue #2566: the driver now SUBMITS the turn through Think's
   * durable submission queue instead of driving the facet in wait
   * mode (see ./orchestrator/durableTurnSubmission.ts and ADR
   * 0024); the {result, route} shape is unchanged. The executed
   * turn derives its inputs from the session (deriveTurn — the
   * direct-turn derivation), and the inputs the facet drive
   * received directly from the caller — identity, source tab, the
   * Judge's recent-turns context, the auto-research flag — ride
   * the submitted message's metadata and are adopted by
   * portBeforeTurn, so no caller input is lost in the move.
   */
  private async runAgenticChatTurn(opts: {
    userText: string;
    recentTurns: Array<{ role?: string; content: string }>;
    userLogin: string;
    isAutoOptionsResearchRequest: boolean;
    /** WS chat only: the originating UI tab, for options-research audit context. */
    sourceTab?: string;
    /** Issue #2566: explicit idempotency key for the submission —
     *  a re-submission with the same key collects the original
     *  submission's outcome instead of executing a second turn. */
    submissionKey?: string;
  }) {
    const handle = await this.submitChatTurn(opts);
    return this.awaitChatTurnSubmission(handle);
  }

  // Issue #2566: extracted to ./orchestrator/durableTurnSubmission.ts
  // (submitChatTurn) — the submit half of the driver above: the user
  // message lands in the canonical port transcript and the turn in
  // Think's durable submission queue, so a submitted turn survives
  // an instance restart and completes afterwards (ADR 0024).
  private async submitChatTurn(opts: {
    userText: string;
    recentTurns?: Array<{ role?: string; content: string }>;
    userLogin: string;
    isAutoOptionsResearchRequest?: boolean;
    sourceTab?: string;
    submissionKey?: string;
  }): Promise<SubmittedTurnHandle> {
    return submitChatTurn(this.durableTurnContext(), opts);
  }

  // Issue #2566: extracted to ./orchestrator/durableTurnSubmission.ts
  // (awaitChatTurnSubmission) — the wait half: block on the durable
  // submission until it settles, then shape the {result, route} the
  // routes have always returned from this driver.
  private async awaitChatTurnSubmission(handle: SubmittedTurnHandle) {
    return awaitChatTurnSubmission(this.durableTurnContext(), handle);
  }

  /** Issue #2566: the this-bound context for the durable-turn
   *  submission helpers (src/agents/orchestrator/
   *  durableTurnSubmission.ts). Session/identity ownership stays
   *  with the class; the builder only binds its own members — note
   *  getMessages binds Think's own session (where a submitted turn
   *  persists its reply), while the port transcript stays canonical
   *  for reads through getPortMessages. */
  private durableTurnContext(): DurableTurnContext {
    return {
      getPortMessages: () => this.getPortMessages(),
      addPortMessages: (messages) => this.addPortMessages(messages),
      extractMessageText: (message) => this.extractMessageText(message),
      submitMessages: (messages, options) =>
        this.submitMessages(messages as any, options as any),
      waitForSubmission: (submissionId) => this.waitForSubmission(submissionId),
      inspectSubmission: (submissionId) => this.inspectSubmission(submissionId),
      getThinkMessages: async () => (await this.getMessages()) as unknown[],
      turnEpoch: () => this.turnEpoch,
      submittedTurnRoutes: this.submittedTurnRoutes,
      markSubmittedTurnActive: (active) => {
        this.activeSubmittedTurn = active;
      },
      markSubmittedTurnSettled: (submissionId) => {
        if (this.activeSubmittedTurn?.submissionId === submissionId) {
          this.activeSubmittedTurn = undefined;
        }
      },
    };
  }

  /** Issue #669: the this-bound context for the shared fallback
   * (src/agents/chatErrorFallback.ts), so the Think shadow builds the
   * identical degraded answer from the same implementation.
   * Issue #686: the shadow is gone; the context now serves the
   * production class alone. */
  private chatErrorFallbackContext(): ChatErrorFallbackContext {
    return {
      env: this.env,
      orm: this.getOrm(),
      sessionId: this.sessionKey(),
      audit: (type, payload) => this.audit(type, "orchestrator", payload),
      scanRunStore: createOptionsDiscoveryPorts({ sql: this.ctx.storage.sql, storage: this.ctx.storage }).scanRuns,
      profileStore: createOptionsDiscoveryPorts({ sql: this.ctx.storage.sql, storage: this.ctx.storage }).strategyProfiles,
      schedulingPort: this.nlqSchedulingPort(),
      stockScreenPort: this.nlqStockScreenPort(),
    };
  }

  /**
   * Issue #312: shared degraded-answer builder for chat turns. Runs the
   * deterministic NLQ fallback and returns the same diagnostic text the
   * WebSocket chat streams; POST /api/chat returns it as JSON instead.
   * Issue #669: the implementation lives in ./chatErrorFallback,
   * shared with the Think shadow; this method only binds the context.
   */
  private async buildChatErrorFallback(
    streamErr: unknown,
    userText: string,
    userLogin: string
  ): Promise<string> {
    return buildChatErrorFallback(this.chatErrorFallbackContext(), streamErr, userText, userLogin);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    this.ensureTables();

    // Scheduled callbacks have no request headers. Remember the authenticated
    // owner/environment on every authenticated app request, not only the
    // schedules panel, so all existing cron records gain the right context.
    const userLogin = request.headers.get("x-user-login") || "";
    const rawEnvironment = (request.headers.get("x-environment") || "").toUpperCase();
    const storage = this.ctx?.storage;
    if (isLoginShaped(userLogin) && storage && typeof storage.put === "function") {
      const previous = await this.getScreenerExecutionContext();
      const context: ScreenerExecutionContext = {
        userLogin,
        environment: rawEnvironment === "TEST" || rawEnvironment === "PROD"
          ? rawEnvironment
          : previous?.environment,
      };
      await storage.put(SCREENER_EXECUTION_CONTEXT_KEY, context);
      try {
        await this.migrateLegacyScreenSchedules(context);
      } catch (scheduleError) {
        // Authentication-context persistence must not make unrelated API
        // routes fail if Durable Object schedule registration is unavailable.
        structuredLog.warn("orchestrator.authenticated_baseline_schedule_reconcile_failed", {
          message: "[OrchestratorAgent] Could not reconcile authenticated baseline schedules:",
          error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError),
        });
      }
      // Issue #3899 (RC1): the Think task declaration reads this
      // stored context, and its first evaluation (cold start) always
      // predates it — re-reconcile exactly when the stored context
      // changed, so the first authenticated request arms the
      // `stock-copilot-paper-cycle` task instead of waiting for a
      // cold start that may never come. Best-effort (see
      // reconcileCopilotScheduledTasks): the reconcile never fails
      // the request.
      const contextChanged =
        previous?.userLogin !== context.userLogin ||
        previous?.environment !== context.environment;
      if (contextChanged) {
        await this.reconcileCopilotScheduledTasks();
      }
    }

    if (/(?:^|\/api)\/jobs$/.test(path) && request.method === "GET") {
      const jobs = this.listAsyncJobs(Number(url.searchParams.get("limit")) || 50).map((job) => {
        const { result: _result, ...summary } = job;
        return summary;
      });
      // #1724: JOB_LIST_ENVELOPE over the list envelope only (run =
      // `?envelope=`, session/user = scoped carriers, env = Worker
      // var, builtin = REST legacy "nocount"). List rows stay
      // result-stripped in both modes; the single-job full record is
      // untouched. An invalid winning value fails closed to nocount,
      // logged + audited as jobs.config_error.
      const resolvedEnvelope = resolveJobListEnvelope(
        levelsForJobListEnvelope(
          this.scopedJobListModes,
          url.searchParams.get("envelope"),
          (this.env as unknown as Record<string, unknown> | undefined)?.[JOB_LIST_ENVELOPE_SWITCH]
        ),
        "nocount"
      );
      if (resolvedEnvelope.invalid) {
        structuredLog.error("orchestrator.jobs_list_envelope_invalid", {
          message: `[jobs] invalid ${JOB_LIST_ENVELOPE_SWITCH} value ${JSON.stringify(resolvedEnvelope.raw)} — failing closed to "nocount"`,
          setting: JOB_LIST_ENVELOPE_SWITCH,
          rawValue: resolvedEnvelope.raw,
        });
        this.audit(jobsConfigErrorEvent(), "orchestrator", {
          setting: JOB_LIST_ENVELOPE_SWITCH,
          value: resolvedEnvelope.raw ?? "",
          resolved: "nocount",
        });
      }
      return Response.json(applyJobListEnvelope(jobs, resolvedEnvelope.mode));
    }

    const jobMatch = path.match(/(?:^|\/api)\/jobs\/([0-9a-f-]{36})$/i);
    if (jobMatch && request.method === "GET") {
      const job = this.getAsyncJob(jobMatch[1]);
      return job
        ? Response.json(job)
        : Response.json({ error: "Async job not found." }, { status: 404 });
    }

    // Consolidation C3 (#1277): per-stage retry — resubmit a failed
    // job (e.g. a chain's failed deliver stage) from its recorded
    // payload; upstream stages are never re-executed.
    const jobRetryMatch = path.match(/(?:^|\/api)\/jobs\/([0-9a-f-]{36})\/retry$/i);
    if (jobRetryMatch && request.method === "POST") {
      try {
        const retried = await this.retryAsyncJob(jobRetryMatch[1]);
        return Response.json({ success: true, ...retried });
      } catch (err: any) {
        const message = err?.message || "Retry failed.";
        const status = /not found/i.test(message) ? 404 : /already retried|Only a failed/i.test(message) ? 409 : 500;
        return Response.json({ success: false, error: message }, { status });
      }
    }

    if (/(?:^|\/api)\/chat-activity$/.test(path) && request.method === "POST") {
      return this.logChatActivity(request);
    }

    if (path.endsWith("/scheduled-job-outcome") && request.method === "POST") // #2037: dispatch-failure records land here (background-gated in handler).
      return handleScheduledJobOutcomeRoute(request, { audit: (type, agent, payload) => this.audit(type, agent as "orchestrator", payload), getOrm: () => this.getOrm(), env: this.env as unknown as Record<string, unknown> });

    // Issue #2457: cross-tenant admin queue actions run synchronously
    // through routeRequest, before the queue decision below. The
    // generic /api/ forwarder marks these queue-eligible and "admin"
    // is not an immediate prefix, so without this branch a
    // preview-confirm-verify admin call would queue as an async job
    // and return 202 instead of its result. Same early-branch pattern
    // as chat-activity above; no shared queue semantics change.
    if (/(?:^|\/api)\/admin\/tenants(?:\/|$)/.test(path)) {
      return this.routeRequest(request);
    }

    // Issue #2489: same trap for the KV wipe route — "maintenance"
    // is not an immediate prefix, so without this branch a
    // preview-confirm KV wipe would queue as an async job and return
    // 202 instead of its per-row result. Same pattern as above.
    if (/(?:^|\/api)\/maintenance\/kv-wipe(?:\/|$)/.test(path)) {
      return this.routeRequest(request);
    }

    // Issue #2501: same trap for the service-user provision route:
    // "admin" is not an immediate prefix, so a provision POST would
    // queue as an async job and return 202. Same pattern as above.
    if (/(?:^|\/api)\/admin\/service-user\/provision(?:\/|$)/.test(path) && request.method === "POST") {
      return this.routeRequest(request);
    }

    // Issue #2681: same trap for the service-token admin routes and
    // the orchestrator-migration routes: "admin" is not an immediate
    // prefix, so without this branch a token mint/rotate/revoke or a
    // migration POST would queue as an async job and return 202
    // instead of its per-request result (a 202 mint would strand the
    // shown-once secret in a job payload). Method-agnostic, like the
    // tenants branch above: reads on these paths are sync either way.
    if (/(?:^|\/api)\/admin\/service-user\/tokens(?:\/|$)/.test(path)) {
      return this.routeRequest(request);
    }
    if (/(?:^|\/api)\/admin\/orchestrator-migration(?:\/|$)/.test(path)) {
      return this.routeRequest(request);
    }

    // The Worker strips the /api prefix when forwarding and marks queue-eligible requests.
    const isMcpEndpoint = /\/mcp(?:\/|$)/i.test(path);
    const isScheduleEndpoint = /(?:^|\/)(?:api\/)?schedules(?:\/|$)/i.test(path);
    const isImmediateEndpoint = /(?:^|\/)(?:api\/)?(?:clear|reset|memory|audit|chat|chat-activity|screener|etrade\/options\/strategy|etrade|broker|trading|options|workflow-runs|external-ads|categories|referrals|revenue|ads|platform|environment)(?:\/|$)/i.test(path);
    const isJobsEndpoint = /(?:^|\/api)\/jobs(?:\/|$)/.test(path);
    const isApiRequest = path.startsWith("/api/") || request.headers.get("x-async-eligible") === "1";
    // #1724: HTTP_DELIVERY_MODE over the queue decision (run =
    // `x-delivery-mode` header, session/user = scoped carriers, env =
    // Worker var, builtin = the per-prefix legacy: immediate → sync,
    // otherwise queued). An explicitly set level overrides the prefix
    // rule in both directions. An invalid winning value fails closed
    // to legacy, logged + audited as jobs.config_error. The jobs /
    // MCP / schedules exclusions stand in every mode (see
    // shouldQueueApiRequest); the /jobs branches above already
    // returned, so isJobsEndpoint here is belt-and-braces.
    const deliveryLegacy = isImmediateEndpoint ? "sync" : "queued";
    const resolvedDelivery = resolveHttpDeliveryMode(
      levelsForHttpDelivery(
        this.scopedHttpDeliveryModes,
        request.headers.get("x-delivery-mode"),
        (this.env as unknown as Record<string, unknown> | undefined)?.[HTTP_DELIVERY_MODE_SWITCH]
      ),
      deliveryLegacy
    );
    if (resolvedDelivery.invalid) {
      structuredLog.error("orchestrator.http_delivery_mode_invalid", {
        message: `[jobs] invalid ${HTTP_DELIVERY_MODE_SWITCH} value ${JSON.stringify(resolvedDelivery.raw)} — failing closed to "${deliveryLegacy}"`,
        setting: HTTP_DELIVERY_MODE_SWITCH,
        rawValue: resolvedDelivery.raw,
      });
      this.audit(jobsConfigErrorEvent(), "orchestrator", {
        setting: HTTP_DELIVERY_MODE_SWITCH,
        value: resolvedDelivery.raw ?? "",
        resolved: deliveryLegacy,
      });
    }
    if (shouldQueueApiRequest({
      isApiRequest,
      isJobsEndpoint,
      isMcpEndpoint,
      isScheduleEndpoint,
      deliveryMode: resolvedDelivery.mode,
      method: request.method,
    })) {
      return this.enqueueHttpRequest(request, url);
    }

    // #2037: the three job paths get the DO dispatch wrap; the rest keep today's path.
    return observeDoRouteDispatch(path, request.method, request.headers, this.env, () => this.routeRequest(request));
  }

  // Issue #992: extracted to ./orchestrator/httpEntry.ts (logChatActivity);
  private async logChatActivity(request: Request): Promise<Response> {
    return logChatActivity(this.httpEntryContext(), request);
  }

  // Issue #992: extracted to ./orchestrator/httpEntry.ts (enqueueHttpRequest);
  private async enqueueHttpRequest(request: Request, url: URL): Promise<Response> {
    return enqueueHttpRequest(this.httpEntryContext(), request, url);
  }

  private routeRequest(request: Request): Promise<Response> {
    return routeRequest(this as unknown as RouteRequestDeps, request);
  }
}
