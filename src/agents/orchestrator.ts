import type { AgentContext, Schedule } from "agents";
import type {
  ChatResponseResult,
  TurnConfig,
  TurnContext,
  UiChatMessage,
} from "../actors/actorPorts";
import { createCfActorSession } from "../actors/cfAgentsAdapter";
import { PortThink, createThinkActorTurn } from "../actors/thinkAdapter";
import type { ActorSessionPort, ActorTurnHooks, ActorTurnPort } from "../actors/actorPorts";
import type { ToolSet } from "ai";
import { getWorkersAIModel } from "./model";
import { resolveScreenerAgentName } from "./screenerAgentName";
import { buildOrchestratorSystemPrompt, resolveShadowMaxSteps } from "./chatPrompt";
import { LLMJudge } from "./judge";
import { VectorMemory } from "../memory/vector-memory";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, type NLQSchedulingPort, type NLQSocialBriefPort, type NLQStockScreenPort } from "./nlq";
import { resolveErrorAspect, AgentErrorCode } from "../aspects/errorCodes";
import { logAspectEvent } from "../aspects/loggingAspect";
import { DatabaseORM } from "../orm";
import { ensureSharedTable } from "../orm/schema";
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
import { ensureMasRetentionIndexes } from "../services/masRetentionIndexes";
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
import { diffScanRuns } from "../trading";
import { createOptionsDiscoveryPorts } from "../data/createOptionsDiscoveryPorts";
import { createOrchestratorTablePorts } from "../data/createOrchestratorTablePorts";
import { createOrmPorts } from "../data/createOrmPorts";
import { createDidAttestation, resolveAgentDidDocument } from "./did";
import { createMAS } from "./mas";
import { dispatchOrchestratorA2A, orchestratorA2AOutcome, type OrchestratorA2AOutcome } from "./orchestrator/a2aDispatch";
import { buildChatErrorFallback, type ChatErrorFallbackContext } from "./chatErrorFallback";
import { getScreenerExecutionContext, migrateLegacyScreenSchedules, removeUnownedBaselineSchedules, ensureStrategyScanSchedule, resolveScheduledLogin, type ScheduleMaintenanceContext } from "./orchestrator/scheduleMaintenance";
import { autoRenewETradeTokens, autonomousGoalScreen, autonomousMarketScreen, autonomousStrategyDiscovery, collectIvHistory, expireStaleOrderDraft, sendScheduledReminder, type ScheduledCallbacksContext } from "./orchestrator/scheduledCallbacks";
import { nlqSchedulingPort, nlqSocialBriefPort, nlqStockScreenPort, type NlqPortsContext } from "./orchestrator/nlqPorts";
import { formatTraceparent, newTraceContext } from "../observability/observabilityPorts";
import { recordTraceHopBestEffort } from "../data/createMeshTracePorts";
import { createSocialBriefStoreFromNamespace } from "./social/briefStore";
import type { DoNamespaceLike } from "../security/durableKv";
import { createKvMembershipStore } from "../security/iaaaMembershipStore";
import { isLoginShaped } from "../security/serviceIdentity";
import { sessionStore } from "../security/session";
import { submitAsyncJob, recoverQueuedAsyncJobs, getAsyncJob, listAsyncJobs, executeAsyncJob, ensureAsyncJobTables, scheduleScreenerFollowups, retryAsyncJob, type AsyncJobsContext } from "./orchestrator/asyncJobs";
import type { ScreenerRunOutcome } from "../services/screenerFollowups";
import { marketDateKey, readAutopilotStateRaw, getAutopilotState, writeAutopilotState, incrementAutopilotOrdersToday, fetchBrokerBalanceSnapshot, openNotionalForSymbol, evaluateAndRecordAutopilotVerdict, type AutopilotContext } from "./orchestrator/autopilot";
import { readSettingRaw, writeSetting, getReportDispatchHitl, setReportDispatchHitl, createReportConfirmation, getReportConfirmation, decideReportConfirmation, storeResearchReportCanonicalAsync, confirmationDeliveryMeta, deliverStoredReportEmail, deliverStoredReportWebhook, persistScreenerReportCanonical, sendReportEmail, sendReportWebhook, type ReportDispatchContext } from "./orchestrator/reportDispatch";
import { extractMessageText, createTurnTools, deriveTurn, assembleGrounding, type ChatTurnHelpersContext } from "./orchestrator/chatTurnHelpers";
import { createOpenaimpMcpFetch, ensureOpenaimpMcpConnection, chatNlqTurnGate, type EnsureOpenaimpMcpResult } from "./orchestrator/meshMcpClient";
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
import { deliverScreenerToSlackA2A } from "../services/screenerSlackDelivery";
import { createFollowupDeliveryPort } from "../services/screenerFollowupDelivery";
import { ScheduledTasksService, type AutonomousOptionsAnalysisOptions, type AutonomousStrategyDiscoveryOptions } from "../services/scheduledTasks";
// Issue #278: durable scheduled-run reports for the NextGenTP agent.
// Issue #308: the single generate→store seam + canonical report bodies.
import {
  canonicalResearchEmailBody,
  canonicalResearchWebhookBody,
  storeReportAtGeneration,
} from "../services/scheduledReports";
// Issue #359-01: reports + HITL routes live in src/agents/routes/reports.ts;
// routeRequest delegates to handleReportsRoutes at the original position.
import { handleReportsRoutes, makeSubmitFollowupDelivery } from "./routes/reports";
import { handleScreenerPresetRoutes } from "./routes/screenerPresets";
import { handleMcpChatNlqRoutes } from "./routes/mcpChatNlq";
import { handleSchemaRoutes } from "./routes/schema";
import { handleAdsRevenueReferralsRoutes, handleReferralsAdsRoutes } from "./routes/adsRevenueReferrals";
import { handleAuditRoutes } from "./routes/audit";
import { handleDataProviderRoutes } from "./routes/dataProviders";
import { buildDataProviderPorts } from "../data/buildDataProviderPorts";
import type { D1ProviderConfigAdapter } from "../data/d1ProviderConfigAdapter";
import type { D1ProviderCaptureAdapter } from "../data/d1ProviderCaptureAdapter";
import { handleEnrichmentRoutes } from "./routes/enrichment";
import { handleWorkflowRunsRoutes } from "./routes/workflowRuns";
import { handleKnowledgeCorpusRoutes } from "./routes/knowledgeCorpus";
import { handleSearchHubRoutes } from "./routes/searchHub";
import { handleAutopilotRoutes } from "./routes/autopilot";
import { handleMemoryResetRoutes } from "./routes/memoryReset";
import { handlePaymentsRoutes } from "./routes/payments";
import { handlePaymentAssuranceLiveRoutes } from "./routes/paymentAssuranceLive";
import { handleAgenticPaymentsRoutes } from "./routes/agenticPayments";
// Issue #359-08: premium routes live in src/agents/routes/premium.ts;
// routeRequest delegates to handlePremiumRoutes at the original position.
import { handlePremiumRoutes, makePremiumRouteContext } from "./routes/premium";
import { handleTradingIntegrationsRoutes } from "./routes/tradingIntegrations";
import {
  handleEtradeBrokerRoutes,
  handleEtradeBrokerActivityRoutes,
} from "./routes/etradeBroker";
import { handleEtradeOptionsRoutes } from "./routes/etradeOptions";
import { resolveBrokerEnvironmentFromSettings } from "./routes/brokerEnvironment";
import { handleWatchlistsRoutes } from "./routes/watchlists";
import { handleAlpacaMarketDataRoutes, handleAlpacaTradingRoutes } from "./routes/alpaca";
import { handleMarketDataQuoteResearchRoutes, handleMarketDataCompareScreenRoutes } from "./routes/marketDataResearch";
import { handleScreenerResearchRoutes } from "./routes/screenerResearch";
import { handleSchedulesRoutes, makeRunScheduleCallback } from "./routes/schedules";
import { handleMaintenanceRoutes } from "./routes/maintenance";
import { handleServiceUserRoutes } from "./routes/serviceUser";
import { handleAdminTenantQueueRoutes } from "./routes/adminTenantQueues";
import { handleKvWipeRoutes } from "./routes/kvWipe";
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

/**
 * Issue #686: message normalization for the model call now lives
 * in the actor turn runner (toModelMessages, text-only mapping);
 * the AIChatAgent-era normalizeMessagesForSDK helper was removed
 * with the cutover. Issue #1738: Think's session assembly is gone;
 * the runner performs the same normalization over the actor's own
 * transcript store.
 */

/**
 * Callbacks a caller may arm through POST /api/schedules/create (#111).
 *
 * This route is the public way to create schedules, so it accepts only
 * user-creatable jobs. Internal-only callbacks — `executeAsyncJob` (the
 * async-job plumbing) and `expireStaleOrderDraft` (order-draft expiry) —
 * are armed by the agent itself and are deliberately NOT in this list;
 * the route rejects them with HTTP 400. Only stock screening, options
 * screening, and saved-request strategy discovery (issue #126)
 * callbacks can be created through this route. NLQ scheduling (#109)
 * uses its separate agent scheduling port.
 */
export const CREATABLE_SCHEDULE_CALLBACKS = [
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  // Consolidation C1 (issue #1201, epic #1151 R1): goal-driven
  // screens are schedulable through the one schedule store.
  "autonomousGoalScreen",
] as const;

const ACCOUNT_SCOPED_SCHEDULE_CALLBACKS = new Set<string>([
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  "autonomousGoalScreen",
]);

export type CreatableScheduleCallback = (typeof CREATABLE_SCHEDULE_CALLBACKS)[number];

type ETradeEnvironment = "TEST" | "PROD";
type ScreenerExecutionContext = { userLogin: string; environment?: ETradeEnvironment };
const SCREENER_EXECUTION_CONTEXT_KEY = "screener:execution-context";
const LEGACY_SCHEDULE_MIGRATION_KEY = "screener:legacy-baseline-migration:v3";
/** Issue #618: interval between automatic stale-task sweeps (6 hours). */
const STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60;
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
      maxSteps: this.maxSteps,
    };
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

  /** Think chat turn, driven through the port's turn facet. */
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
      console.warn("[OrchestratorAgent] Think session clear failed; port transcript is cleared:", err);
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
      serviceMembershipStore: createKvMembershipStore(sessionStore(this.env)),
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
      reportConfirmationTtlMs: OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS,
      sendReportEmail: (recipient, title, fileName, attachmentBase64, userLogin) =>
        this.sendReportEmail(recipient, title, fileName, attachmentBase64, userLogin),
      sendReportWebhook: (title, query, sheets, userLogin) =>
        this.sendReportWebhook(title, query, sheets, userLogin),
    };
  }

  private chatTurnHelpersContext(): ChatTurnHelpersContext {
    return {
      env: this.env,
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
      createReportConfirmation: (kind, payloadJson, reportId) =>
        this.createReportConfirmation(kind, payloadJson, reportId),
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
    const id = this.env.SCREENER_AGENT.idFromName(resolveScreenerAgentName(this.env, userLogin));
    return this.env.SCREENER_AGENT.get(id) as unknown as ScreenerAgent;
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
    const id = ns.idFromName(`research:${login}`);
    return ns.get(id) as unknown as ResearchAgent;
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
      console.error("[OrchestratorAgent][onStart] Could not reschedule queued async jobs:", error);
    }

    try {
      // Issue #2496 (Mesh Improvement S1): establish the SDK MCP
      // client connection to this instance's own openaimp MCP
      // server so chat turns discover the catalog. Best-effort: a
      // discovery failure never blocks startup (audited as
      // mesh_mcp.discovery_failed; retried at the next turn).
      await this.ensureMeshMcpDiscovery();
    } catch (meshErr) {
      console.warn("[OrchestratorAgent][onStart] Mesh MCP discovery setup failed:", meshErr);
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
      console.warn("[OrchestratorAgent][onStart] Legacy maintenance schedule reconciliation failed:", schedErr);
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
      console.warn("[OrchestratorAgent][onStart] Stale-task sweep setup failed:", sweepErr);
    }

    try {
      // Issue #686: residual legacy-session lift (see
      // liftLegacyChatMessages). Best-effort: never blocks startup.
      await this.liftLegacyChatMessages();
    } catch (liftErr) {
      console.warn("[OrchestratorAgent][onStart] Legacy session lift failed:", liftErr);
    }

    try {
      // Issue #2280: the framework alarm queue (cf_agents_jobs) has no index
      // on time, so every alarm scans it. Create the seek indexes last: the
      // schedule reconciliation above has forced the framework table to
      // exist by touching the queue, and the framework creates it lazily.
      // Best-effort: a failure never blocks startup; the next start retries.
      ensureFrameworkQueueIndexes(this.ctx.storage.sql);
    } catch (idxErr) {
      console.warn("[OrchestratorAgent][onStart] Framework queue index setup failed:", idxErr);
    }
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
    const sql = this.ctx.storage.sql;
    const exists =
      Array.from(
        sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'"
        )
      ).length > 0;
    if (!exists) return;
    const rows = Array.from(
      sql.exec(
        "SELECT id, message, created_at FROM cf_ai_chat_agent_messages ORDER BY created_at ASC, rowid ASC"
      )
    ) as Array<{ id: string; message: string; created_at: unknown }>;
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
      sql.exec("DROP TABLE cf_ai_chat_agent_messages");
      return;
    }
    console.error(
      `[OrchestratorAgent] Legacy lift imported ${valid.length} of ${rows.length} rows (${skipped} skipped); leaving cf_ai_chat_agent_messages in place so they remain recoverable.`
    );
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
      console.warn("[OrchestratorAgent] Skipping stale-task sweep without an authenticated account owner.");
      return { userLogin: null, researchSwept: 0, screenerSwept: 0, researchPruned: 0, screenerPruned: 0 };
    }
    let researchSwept = 0;
    try {
      const research = this.getResearchAgent(userLogin);
      if (research) researchSwept = (await research.sweepStaleResearchTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Stale research sweep failed for ${userLogin}:`, error);
    }
    let screenerSwept = 0;
    try {
      screenerSwept = (await this.getScreenerAgent(userLogin).sweepStaleScreenerTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Stale screener sweep failed for ${userLogin}:`, error);
    }
    // Issue #635: retention pruning rides the same maintenance path,
    // in its own isolated legs — a prune failure never affects sweeps.
    let researchPruned = 0;
    try {
      const research = this.getResearchAgent(userLogin);
      if (research) researchPruned = (await research.pruneExpiredResearchTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Research retention prune failed for ${userLogin}:`, error);
    }
    let screenerPruned = 0;
    try {
      screenerPruned = (await this.getScreenerAgent(userLogin).pruneExpiredScreenerTasks()).length;
    } catch (error) {
      console.warn(`[OrchestratorAgent] Screener retention prune failed for ${userLogin}:`, error);
    }
    if (researchSwept > 0 || screenerSwept > 0 || researchPruned > 0 || screenerPruned > 0) {
      console.info(`[OrchestratorAgent] Task maintenance for ${userLogin}: research swept=${researchSwept} pruned=${researchPruned}; screener swept=${screenerSwept} pruned=${screenerPruned}.`);
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

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (autoRenewETradeTokens);
  async autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }): Promise<void> {
    return autoRenewETradeTokens(this.scheduledCallbacksContext(), payload);
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (autonomousMarketScreen);
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
  }): Promise<void> {
    return autonomousMarketScreen(this.scheduledCallbacksContext(), payload);
  }

  // Consolidation C1 (issue #1201): extracted to ./orchestrator/scheduledCallbacks.ts (autonomousGoalScreen);
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
  }): Promise<void> {
    return autonomousGoalScreen(this.scheduledCallbacksContext(), payload);
  }

  /**
   * Cloudflare Agents Scheduled Callback: Autonomous Options Intelligence
   * Runs cross-symbol options discovery and dispatches omnichannel push alerts
   */
  async autonomousOptionsAnalysis(payload?: AutonomousOptionsAnalysisOptions): Promise<void> {
    try {
      await this.waitForPendingTurn({ timeout: 30_000 });
    } catch {
      // Continue if timeout or unhandled
    }
    const runAnalysis = async () => {
      const savedContext = await this.getScreenerExecutionContext();
      const userLogin = resolveScheduledLogin(payload?.userLogin, savedContext?.userLogin) || "";
      const environment = payload?.environment || savedContext?.environment;
      if (payload?.trigger !== "manual" && !userLogin) {
        await this.removeUnownedBaselineSchedules();
        console.warn("[OrchestratorAgent] Skipping unowned scheduled options screen.");
        return;
      }
      if (payload?.trigger !== "manual") {
        const slot = new Date().toISOString().slice(0, 16);
        const thesis = payload?.thesis || "bullish";
        const slotKey = `${thesis}:${slot}`;
        this.scheduledOptionsSlots ??= new Set<string>();
        if (this.scheduledOptionsSlots.has(slotKey)) return;
        if (this.scheduledOptionsSlots.size > 32) this.scheduledOptionsSlots.clear();
        this.scheduledOptionsSlots.add(slotKey);
        const key = `options:scheduled:last-slot:${thesis}`;
        const last = await this.ctx.storage.get<{ slot: string }>(key);
        if (last?.slot === slot) {
          console.warn(`[OrchestratorAgent] Suppressing duplicate scheduled options scan (${thesis}) in ${slot}Z`);
          return;
        }
        await this.ctx.storage.put(key, { slot });
      }
      const service = new ScheduledTasksService(this.env, this.getOrm(), userLogin, createOptionsDiscoveryPorts({ sql: this.ctx.storage.sql, storage: this.ctx.storage }).scanRuns, undefined, undefined, undefined, (outcome, schedulerUserLogin, chainReport) => scheduleScreenerFollowups(this.asyncJobsContext(), outcome, schedulerUserLogin, chainReport), {sql:this.ctx.storage.sql,blobStorage:this.ctx.storage,env:this.env}, (spec) => (this as any).submitAsyncJob(spec));
      const res = await service.autonomousOptionsAnalysis({ ...payload, userLogin, environment, sharded: payload?.sharded });
      if ((res as any).skipped) return;
      if (res.data?.sharded) return;
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
    };

    if (typeof (this as any).keepAliveWhile === "function") {
      await (this as any).keepAliveWhile(runAnalysis);
    } else {
      await runAnalysis();
    }
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (autonomousStrategyDiscovery);
  async autonomousStrategyDiscovery(payload?: AutonomousStrategyDiscoveryOptions): Promise<void> {
    return autonomousStrategyDiscovery(this.scheduledCallbacksContext(), payload);
  }

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (collectIvHistory);
  async collectIvHistory(payload?: { symbols?: string[]; environment?: string; userLogin?: string }): Promise<void> {
    return collectIvHistory(this.scheduledCallbacksContext(), payload);
  }

  // Issue #686: the AIChatAgent-era submitMessages wrapper — an
  // emulation of the documented autonomous-admission API over
  // saveMessages — is removed. Think provides submitMessages
  // natively as the durable submissions queue (its own signature
  // and acceptance result), which is what external admissions
  // (webhooks, Slack, cron) now use.

  // Issue #992: extracted to ./orchestrator/scheduledCallbacks.ts (expireStaleOrderDraft);
  async expireStaleOrderDraft(payload: { orderId: string; userLogin?: string }): Promise<void> {
    return expireStaleOrderDraft(this.scheduledCallbacksContext(), payload);
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
    const storage = this.ctx.storage;
    const sql = storage.sql;
    // Shared mas_* tables come from the canonical DDL in src/orm/schema
    // (issue #782) — do not re-add their DDL here.
    ensureSharedTable(sql, "mas_messages");
    // Issue #2358 (#1976 step 4a): mas_async_jobs' DDL moved behind
    // the async-job queue port (one owner per table, ADR 0022 D-A).
    // This one call runs the family's whole schema ensure: the base
    // table, the session index, the already-running gate's seek
    // index (issue #2280 slice 2 — created right after the table,
    // so no lazy-creation ordering issue), and the probed job-graph
    // migration (issue #1123: parent/sub-job tracking columns,
    // additive).
    ensureAsyncJobTables(sql);
    ensureSharedTable(sql, "mas_events");
    // Issue #2280 (slice 3): the nightly retention batches' covering indexes.
    // Both tables exist by now (mas_messages above, mas_events just created),
    // so no lazy-creation ordering issue.
    ensureMasRetentionIndexes(sql);
    ensureSharedTable(sql, "mas_memory");
    // Issue #2359 (#1976 step 4d): the four orchestrator-owned
    // tables' DDL moved behind the orchestrator-table ports (one
    // owner per table, ADR 0022 D-A). These calls run the four
    // families' schema ensures in the legacy order: autopilot
    // state, report confirmations (with the probed #308
    // report_id migration), screener presets, policy verdicts
    // (with its created-at index).
    const tablePorts = createOrchestratorTablePorts(sql);
    // Autopilot policy state (autopilot Phase 1): server-owned run state,
    // limits, kill switch, and daily order budget. Previously all four lived in
    // browser localStorage, so a reload cleared the kill switch and a second
    // browser ran its own envelope.
    tablePorts.autopilot.ensureSchema();
    // Server-owned settings (issue #277): per-key runtime flags readable by
    // the agent and writable through the /trading/settings routes.
    // Issue #2390 (step 4g, gate G-7 ruled): the mas_settings DDL
    // is owned by the dedicated settings port's adapter — this
    // composition invokes its ensureSchema() and the class file
    // no longer carries the CREATE. (Issue #2359 deliberately
    // left the DDL here pending exactly this ruling.)
    createOrmPorts(sql).settings.ensureSchema();
    // Issue #277: pending HITL confirmations for research-report dispatch.
    // Payloads are stored verbatim at creation time; the actual email or
    // webhook send happens only when a human approves via
    // POST /trading/reports/confirm. Mirrors the /payments/confirm flow.
    // Issue #308: payload_json carries delivery metadata only (recipient /
    // fileName / title); the report bytes themselves live once in
    // mas_reports, referenced by report_id. Legacy rows (pre-#308) carry
    // the full payload in payload_json and are read via a fallback.
    tablePorts.confirmations.ensureSchema();
    // Issue #1495 (#940-A): user-scoped screener presets (DO/SQLite, not KV per #415); criteria validated by the run path's strict parsers before storage.
    tablePorts.presets.ensureSchema();
    // Append-only verdict ledger: every policy decision, its inputs, and a
    // signature produced server-side where the decision is made.
    tablePorts.verdicts.ensureSchema();
    ensureSharedTable(sql, "mas_referrals");
    ensureSharedTable(sql, "mas_ads");

    ensureSharedTable(sql, "mas_watchlists");

    // Seed default sponsor offers if ads table is empty.
    // Issue #2359 (#1976 step 4d): the count + inserts serve
    // through the step-3a ads repository port (the table's port
    // home) instead of raw statements here. The count==0 gate
    // makes the port's insert-or-throw equivalent to the legacy
    // INSERT OR IGNORE: the loop only runs on an empty table,
    // so no conflicting row can exist.
    try {
      const ads = createOrmPorts(sql).ads;
      if (ads.count() === 0) {
        const now = new Date().toISOString();
        const seedAds = [
          {
            id: "ad_workers_ai",
            title: "Cloudflare Workers AI",
            tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
            sponsor: "Cloudflare",
            badge: "FLAGSHIP PARTNER",
            url: "https://developers.cloudflare.com/workers-ai/",
            cta_text: "Deploy in 60s →",
            accent_color: "#f38020",
          },
          {
            id: "ad_ai_search",
            title: "Cloudflare AI Search",
            tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
            sponsor: "Cloudflare AI",
            badge: "FEATURED TOOL",
            url: "https://developers.cloudflare.com/ai-search/",
            cta_text: "Explore Docs →",
            accent_color: "#38bdf8",
          },
          {
            id: "ad_durable_objects",
            title: "Durable Objects SQLite",
            tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
            sponsor: "Cloudflare Platform",
            badge: "INFRASTRUCTURE",
            url: "https://developers.cloudflare.com/durable-objects/",
            cta_text: "Learn More →",
            accent_color: "#a855f7",
          },
          {
            id: "ad_openaimp",
            title: "OpenAIMP Agent Studio",
            tagline: "Scale autonomous multi-agent workflows with real-time LLM Judge routing and persistent memory.",
            sponsor: "OpenAIMP",
            badge: "SPONSOR",
            url: "https://agent.openaimp.com",
            cta_text: "Join Program →",
            accent_color: "#10b981",
          },
        ];

        for (const ad of seedAds) {
          ads.create({
            id: ad.id,
            title: ad.title,
            tagline: ad.tagline,
            sponsor: ad.sponsor,
            badge: ad.badge,
            url: ad.url,
            ctaText: ad.cta_text,
            accentColor: ad.accent_color,
            impressions: 0,
            clicks: 0,
            createdAt: now,
          });
        }
      }
    } catch {
      // Ignore if seeding fails
    }

    ensureSharedTable(sql, "mas_transactions");

    // Issue #175: this store previously seeded two fabricated "default"
    // transactions on first use — completed charges carrying invented
    // proof signatures and live-shaped gateway references, stamped with
    // the user's own DID as authorizer and rendered by the payments
    // ledger (including its volume/completed summary) as real payments.
    // They are removed, not relabelled: nothing depends on them (wallet
    // status counts only x402/mpp rows; the confirm flow requires a
    // "previewed" draft, which these never were). Real draft ids are
    // `pay_` + 8 random hex characters, so the two seed ids can only
    // ever have come from that seeding — purge exactly those rows from
    // stores seeded before this fix.
    try {
      // Issue #2359 (#1976 step 4d): the purge serves through
      // the step-3a transaction-ledger port (the table's port
      // home) instead of raw DELETEs here.
      const transactions = createOrmPorts(sql).transactions;
      transactions.delete("pay_init_stripe");
      transactions.delete("pay_init_paypal");
    } catch {
      // Ignore if the purge fails
    }

    return sql;
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

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (getAsyncJob);
  private getAsyncJob(jobId: string): AsyncJobRecord | undefined {
    return getAsyncJob(this.asyncJobsContext(), jobId);
  }

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (listAsyncJobs);
  private listAsyncJobs(limit = 50): AsyncJobRecord[] {
    return listAsyncJobs(this.asyncJobsContext(), limit);
  }

  // Issue #992: extracted to ./orchestrator/asyncJobs.ts (executeAsyncJob);
  async executeAsyncJob({ jobId }: AsyncJobPayload): Promise<void> {
    return executeAsyncJob(this.asyncJobsContext(), { jobId });
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
  private static readonly REPORT_CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

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
    reportId?: string | null
  ): string {
    return createReportConfirmation(this.reportDispatchContext(), kind, payloadJson, reportId);
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
   * runAgenticChatTurn (the HTTP driver) fills it before driving
   * runTurn; portBeforeTurn creates it when a turn arrives without
   * one. portOnChatResponse consumes it. One in-flight chat turn
   * per DO instance is the live semantic — the AIChatAgent base
   * serialized turns the same way. Issue #1738: the stash is
   * in-memory only; there is no durable turn sealing on eviction
   * (see ADR 0005).
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
    const nlqGate = isAutoOptionsResearchRequest
      ? {}
      : chatNlqTurnGate({
          toolNames: Object.keys(ctx.tools ?? {}),
          context: { env: this.env },
          audit: (type, payload) => this.audit(type, "orchestrator", payload),
        });
    return {
      instructions: buildOrchestratorSystemPrompt({
        route,
        memoryContext,
        vectorContext,
        optionsResearchContext,
        isAutoOptionsResearchRequest,
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
      console.warn("[VectorMemory] remember failed:", err instanceof Error ? err.message : String(err));
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
   */
  private async runAgenticChatTurn(opts: {
    userText: string;
    recentTurns: Array<{ role?: string; content: string }>;
    userLogin: string;
    isAutoOptionsResearchRequest: boolean;
    /** WS chat only: the originating UI tab, for options-research audit context. */
    sourceTab?: string;
  }) {
    const turn: NonNullable<typeof this.pendingTurn> = {
      ...opts,
      requestId: crypto.randomUUID(),
    };
    this.pendingTurn = turn;
    try {
      const existing = await this.getPortMessages();
      const tailUser = [...existing].reverse().find((m: any) => m?.role === "user");
      const isResend = !!tailUser && this.extractMessageText(tailUser) === opts.userText;
      if (isResend) turn.suppressUserRecord = true;
      const result = await this.runFacetTurn((current: any[]) =>
        isResend
          ? current
          : [
              ...current,
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: opts.userText }],
              } as any,
            ]
      );
      const text = result?.message ? this.extractMessageText(result.message) : "";
      const route = turn.route ?? {
        agent: "search",
        confidence: 0,
        reason: "Turn completed without a recorded route decision.",
        needsConfirmation: false,
      };
      return { result: { text }, route };
    } finally {
      if (this.pendingTurn === turn) this.pendingTurn = undefined;
    }
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
        console.warn("[OrchestratorAgent] Could not reconcile authenticated baseline schedules:", scheduleError);
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
        console.error(
          `[jobs] invalid ${JOB_LIST_ENVELOPE_SWITCH} value ${JSON.stringify(resolvedEnvelope.raw)} — failing closed to "nocount"`
        );
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

    // The Worker strips the /api prefix when forwarding and marks queue-eligible requests.
    const isMcpEndpoint = /\/mcp(?:\/|$)/i.test(path);
    const isScheduleEndpoint = /(?:^|\/)(?:api\/)?schedules(?:\/|$)/i.test(path);
    const isImmediateEndpoint = /(?:^|\/)(?:api\/)?(?:clear|reset|memory|audit|chat|chat-activity|screener|etrade\/options\/strategy|etrade|broker|trading|options|workflow-runs)(?:\/|$)/i.test(path);
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
      console.error(
        `[jobs] invalid ${HTTP_DELIVERY_MODE_SWITCH} value ${JSON.stringify(resolvedDelivery.raw)} — failing closed to "${deliveryLegacy}"`
      );
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

    return this.routeRequest(request);
  }

  // Issue #992: extracted to ./orchestrator/httpEntry.ts (logChatActivity);
  private async logChatActivity(request: Request): Promise<Response> {
    return logChatActivity(this.httpEntryContext(), request);
  }

  // Issue #992: extracted to ./orchestrator/httpEntry.ts (enqueueHttpRequest);
  private async enqueueHttpRequest(request: Request, url: URL): Promise<Response> {
    return enqueueHttpRequest(this.httpEntryContext(), request, url);
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const sql = this.ensureTables();
    const sessionId = this.sessionKey();

    // Issue #359-01: reports + HITL routes are handled by
    // src/agents/routes/reports.ts. Invoked at this exact position in the
    // sequential path.endsWith matching sequence; a non-null return matched.
    const reportsResponse = await handleReportsRoutes(request, url, path, sessionId, {
      env: this.env,
      ensureTables: () => this.ensureTables(),
      getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      getReportDispatchHitl: () => this.getReportDispatchHitl(),
      setReportDispatchHitl: (enabled) => this.setReportDispatchHitl(enabled),
      getReportConfirmation: (id) => this.getReportConfirmation(id),
      decideReportConfirmation: (id, status, decidedBy) =>
        this.decideReportConfirmation(id, status, decidedBy),
      createReportConfirmation: (kind, payloadJson, reportId) =>
        this.createReportConfirmation(kind, payloadJson, reportId),
      submitFollowupDelivery: makeSubmitFollowupDelivery((job) => this.submitAsyncJob(job)),
      confirmationDeliveryMeta: (row) => this.confirmationDeliveryMeta(row),
      deliverStoredReportEmail: (reportId, recipient, userLogin) =>
        this.deliverStoredReportEmail(reportId, recipient, userLogin),
      deliverStoredReportWebhook: (reportId, userLogin) =>
        this.deliverStoredReportWebhook(reportId, userLogin),
      sendReportEmail: (recipient, title, fileName, attachmentBase64, userLogin) =>
        this.sendReportEmail(recipient, title, fileName, attachmentBase64, userLogin),
      sendReportWebhook: (title, query, sheets, userLogin) =>
        this.sendReportWebhook(title, query, sheets, userLogin),
      storeResearchReportCanonicalAsync: (bodyJson, meta) =>
        this.storeResearchReportCanonicalAsync(bodyJson, meta),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      reportConfirmationTtlMs: () => OrchestratorAgent.REPORT_CONFIRMATION_TTL_MS,
    });
    if (reportsResponse) return reportsResponse;

    // Issue #1495 (#940-A): screener preset routes (screenerPresets.ts), invoked at this exact position in the sequential matching sequence.
    const presetsResponse = await handleScreenerPresetRoutes(request, url, path, sessionId, { ensureTables: () => this.ensureTables() });
    if (presetsResponse) return presetsResponse;

    // Issue #359-02: MCP + chat + NLQ routes are handled by
    // src/agents/routes/mcpChatNlq.ts. Invoked at this exact position in the
    // sequential path.endsWith matching sequence; a non-null return matched.
    const mcpChatNlqResponse = await handleMcpChatNlqRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      getStorageSql: () => this.ctx.storage.sql,
      // Issue #1661: DO blob handle for full capture on NLQ legs.
      getStorage: () => this.ctx.storage,
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      submitAsyncJob: (job) => this.submitAsyncJob(job),
      getAsyncJob: (jobId) => this.getAsyncJob(jobId),
      listAsyncJobs: () => this.listAsyncJobs().map(({ result: _result, ...job }) => job),
      extractMessageText: (message) => this.extractMessageText(message),
      getMessages: () => this.getPortMessages(),
      recordMessage: (role, content, agent) => this.recordMessage(role, content, agent),
      runAgenticChatTurn: (opts) => this.runAgenticChatTurn(opts),
      buildChatErrorFallback: (err, userText, userLogin) => this.buildChatErrorFallback(err, userText, userLogin),
      scopedHttpDeliveryModes: this.scopedHttpDeliveryModes,
      scopedJobListModes: this.scopedJobListModes,
      nlqSchedulingPort: () => this.nlqSchedulingPort(),
      nlqSocialBriefPort: () => this.nlqSocialBriefPort(),
    });
    if (mcpChatNlqResponse) return mcpChatNlqResponse;

    // Issue #359-17: schema introspection routes (GET /schema/tables,
    // POST /schema/query) are handled by src/agents/routes/schema.ts.
    // Invoked at this exact position in the sequential path.endsWith
    // matching sequence (between the MCP/chat/NLQ handler and the
    // ads/revenue/referrals handler); a non-null return matched.
    const schemaResponse = await handleSchemaRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (schemaResponse) return schemaResponse;

    // Issue #359-03: ads / revenue / referrals (inventory group: categories,
    // revenue, external ads) are handled by
    // src/agents/routes/adsRevenueReferrals.ts. Invoked at this exact
    // position in the sequential path.endsWith matching sequence (between
    // /schema/query and /audit); a non-null return matched.
    const adsRevenueReferralsResponse = await handleAdsRevenueReferralsRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      env: this.env, // #1721: global-env fallback for the ads/revenue switches.
    });
    if (adsRevenueReferralsResponse) return adsRevenueReferralsResponse;

    // Issue #359-04: audit routes (GET/POST /audit, POST /audit/event) are
    // handled by src/agents/routes/audit.ts. Invoked at this exact position
    // in the sequential path.endsWith matching sequence (between the
    // ads/revenue/referrals handler and the autopilot block); a non-null
    // return matched.
    const auditResponse = await handleAuditRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      recordAudit: (type, agent, payload) => this.recordAudit(type, agent, payload),
      env: this.env, // #1733: global-env fallback for AUDIT_WRITE_MODE.
    });
    if (auditResponse) return auditResponse;

    // Issue #1170 (E3): data-provider lifecycle routes are handled
    // by src/agents/routes/dataProviders.ts. Invoked here (after the
    // audit handler); a non-null return matched. The verified login
    // (set by src/server.ts from the session, #1156) gates mutations
    // and is the audit actor.
    const dataProviderPorts = await this.dataProviderPorts();
    const dataProvidersResponse = await handleDataProviderRoutes(request, url, path, sessionId, {
      env: this.env,
      sql: this.ctx.storage.sql,
      configPort: dataProviderPorts.config,
      capturePort: dataProviderPorts.captures,
      userLogin: request.headers.get("x-user-login") || "",
      recordAudit: (type, agent, payload) => this.recordAudit(type, agent, payload),
    });
    if (dataProvidersResponse) return dataProvidersResponse;

    // Issue #1888: enrichment routes (routes/enrichment.ts), after data-providers; non-null return matched.
    const enrichmentResponse = await handleEnrichmentRoutes(request, url, path, sessionId, {
      env: this.env,
      sql: this.ctx.storage.sql,
      userLogin: request.headers.get("x-user-login") || "",
      recordAudit: (type, agent, payload) => this.recordAudit(type, agent, payload),
    });
    if (enrichmentResponse) return enrichmentResponse;

    // Workflow Runs ledger (routes/workflowRuns.ts), after enrichment.
    const workflowRunsResponse = await handleWorkflowRunsRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      userLogin: request.headers.get("x-user-login") || "",
    });
    if (workflowRunsResponse) return workflowRunsResponse;

    // Issue #1169 (S1): knowledge-corpus admin upload routes (POST
    // /knowledge/corpus) are handled by
    // src/agents/routes/knowledgeCorpus.ts. Invoked at this exact
    // position in the sequential matching sequence (after the
    // data-provider handler, before autopilot); a non-null return
    // matched. The verified login (set by src/server.ts from the
    // session) gates ingestion; the corpus itself is not partitioned
    // by login (see knowledgeCorpus.ts header).
    // Issue #1169 (S4-4): the mount additionally passes the report
    // store (sql) so the weekly corpus-sync branch can read/write
    // its mas_settings marker and run the index backfill.
    const knowledgeCorpusResponse = await handleKnowledgeCorpusRoutes(request, url, path, sessionId, {
      env: this.env,
      storage: this.ctx.storage,
      userLogin: request.headers.get("x-user-login") || "",
      sql: this.ctx.storage.sql,
    });
    if (knowledgeCorpusResponse) return knowledgeCorpusResponse;

    // Issue #2120 (slice 1): Search hub routes (POST /search/agent,
    // POST /search/knowledge). Mounted adjacent to the knowledgeCorpus
    // mount; the new paths collide with no existing suffix.
    // Issue #1169 (S4-2): POST /search/mas rides the same mount; it
    // additionally receives the report store (the MAS tool's sql) and
    // the orchestrator audit (its type accepts the MAS "search"
    // agent value), mirroring the autopilot mount's audit pattern.
    const searchHubResponse = await handleSearchHubRoutes(request, url, path, sessionId, {
      env: this.env,
      userLogin: request.headers.get("x-user-login") || "",
      sql: this.ctx.storage.sql,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (searchHubResponse) return searchHubResponse;

    // Issue #359-05: autopilot control center routes (GET /autopilot,
    // POST /autopilot/state, POST /autopilot/kill-switch,
    // POST|PUT /autopilot/limits, POST /autopilot/evaluate) are handled
    // by src/agents/routes/autopilot.ts. Invoked at this exact position
    // in the sequential matching sequence (between the audit handler and
    // the Persistent Memory endpoint); a non-null return matched.
    const autopilotResponse = await handleAutopilotRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getAutopilotState: () => this.getAutopilotState(),
      writeAutopilotState: (patch) => this.writeAutopilotState(patch),
      evaluateAndRecordAutopilotVerdict: (params) => this.evaluateAndRecordAutopilotVerdict(params),
    });
    if (autopilotResponse) return autopilotResponse;

    // Issue #359-06: memory + reset routes (GET/POST/DELETE /memory,
    // POST|DELETE|GET /clear|/reset) are handled by
    // src/agents/routes/memoryReset.ts. Invoked at this exact position
    // in the sequential path.endsWith matching sequence (between the
    // autopilot handler and the referrals+ads handler); a non-null
    // return matched.
    const memoryResetResponse = await handleMemoryResetRoutes(request, url, path, sessionId, {
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      // #1723: env for the MEMORY_READ_MODE env level on GET /memory.
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      abortAllRequests: (_reason) => this.abortAllRequests(),
      resetTurnState: () => this.resetTurnState(),
      clearConversationMessages: async () => {
        await this.clearMessages();
      },
    });
    if (memoryResetResponse) return memoryResetResponse;

    // Issue #359-03: referrals + sponsored ads (community group) are
    // handled by src/agents/routes/adsRevenueReferrals.ts. Invoked at this
    // exact position in the sequential path.endsWith matching sequence
    // (between /memory and the payments block); a non-null return matched.
    const referralsAdsResponse = await handleReferralsAdsRoutes(request, url, path, sessionId, {
      getOrm: () => this.getOrm(),
      ensureTables: () => this.ensureTables(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      env: this.env, // #1721: global-env fallback for the ads/revenue switches.
    });
    if (referralsAdsResponse) return referralsAdsResponse;

    // Issue #359-07: payments routes (Multi-Gateway Payments & DID
    // Management API) are handled by src/agents/routes/payments.ts.
    // Invoked at this exact position in the sequential path.endsWith
    // matching sequence (between the referrals+ads handler and the
    // Cloudflare Agentic Payments block); a non-null return matched.
    const paymentsResponse = await handlePaymentsRoutes(request, url, path, sessionId, {
      env: this.env,
      ensureTables: () => this.ensureTables(),
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      // #1735: session/user carriers for PAYMENTS_FLOW_MODE (run is
      // per-call on the route context and is not set here — there is
      // no execution-owner run source on this path today, and a
      // request-supplied run value must never flip the flow).
      scopedPaymentsFlowModes: this.scopedPaymentsFlowModes,
    });
    if (paymentsResponse) return paymentsResponse;

    // Issue #2059: live PaymentWorkflow assurance routes (test the
    // live deployed workflow end-to-end with test inputs; no fake
    // seams). Invoked at this exact position in the sequential
    // path.endsWith matching sequence (between the payments
    // handler and the Cloudflare Agentic Payments block); a
    // non-null return matched. The handler itself enforces the
    // payment_assurance flag, caller identity, and the
    // PAYMENT_ASSURANCE_LIVE_LOGINS allowlist.
    const paymentAssuranceLiveResponse = await handlePaymentAssuranceLiveRoutes(request, url, path, sessionId, {
      env: this.env,
    });
    if (paymentAssuranceLiveResponse) return paymentAssuranceLiveResponse;

    // Issue #359-17: Cloudflare Agentic Payments routes (x402 & MPP:
    // GET /payments/agentic/wallet, GET|POST
    // /payments/agentic/auto-approve-limit) are handled by
    // src/agents/routes/agenticPayments.ts. Invoked at this exact
    // position in the sequential path.endsWith matching sequence
    // (between the payments handler and the premium handler);
    // a non-null return matched.
    const agenticPaymentsResponse = await handleAgenticPaymentsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (agenticPaymentsResponse) return agenticPaymentsResponse;

    // Issue #359-08: premium paid-trading routes (Paid Trading Service:
    // Institutional Options Screener, Equity Research, Anomaly Signals)
    // are handled by src/agents/routes/premium.ts. Invoked at this exact
    // position in the sequential matching sequence (between the Cloudflare
    // Agentic Payments block and the Environment & E*TRADE Trading APIs
    // block); a non-null return matched.
    const premiumResponse = await handlePremiumRoutes(request, url, path, sessionId, makePremiumRouteContext(this));
    if (premiumResponse) return premiumResponse;

    // Issue #359-09: E*TRADE broker routes (Environment & E*TRADE Trading
    // APIs block) are handled by src/agents/routes/etradeBroker.ts
    // (handleEtradeBrokerRoutes). Invoked at this exact position in the
    // sequential matching sequence (after the premium delegation);
    // a non-null return matched.
    const etradeBrokerResponse = await handleEtradeBrokerRoutes(request, url, path, sessionId, {
      env: this.env,
      asyncJobId: request.headers.get("x-async-job-id") || undefined,
      scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string) =>
        scheduleScreenerFollowups(this.asyncJobsContext(), outcome, userLogin),
      getOrm: () => this.getOrm(),
      readSettingRaw: (key) => this.readSettingRaw(key),
      writeSetting: (key, value) => this.writeSetting(key, value),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin),
      persistScreenerReportCanonical: (result) => this.persistScreenerReportCanonical(result),
      evaluateAndRecordAutopilotVerdict: (params) => this.evaluateAndRecordAutopilotVerdict(params),
      getAutopilotState: () => this.getAutopilotState(),
      incrementAutopilotOrdersToday: () => this.incrementAutopilotOrdersToday(),
      schedule: (when, callback, payload) => this.schedule(when, callback as keyof this, payload),
      cancelSchedule: (id) => this.cancelSchedule(id),
    });
    if (etradeBrokerResponse) return etradeBrokerResponse;

    // The requestedEnv binding stays inline in the dispatcher: it is
    // computed once here and passed through the context to the E*TRADE
    // options and watchlists delegations below. The broker handlers
    // recompute their own copy inside the module.
    // Issue #2482: the binding is the persisted per-login environment
    // selection, never the request header — options and watchlist data
    // must agree with every other broker surface.
    const requestedEnv: "TEST" | "PROD" | undefined =
      resolveBrokerEnvironmentFromSettings((key) => this.readSettingRaw(key), this.env);

    // Issue #359-10: omnichannel trading channel routes (email / slack /
    // browser / voice trading integrations) are handled by
    // src/agents/routes/tradingIntegrations.ts
    // (handleTradingIntegrationsRoutes). Invoked at this exact position in
    // the sequential path.endsWith matching sequence (after the E*TRADE
    // broker routes block, before the broker activity delegation); a
    // non-null return matched.
    const tradingIntegrationsResponse = await handleTradingIntegrationsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      agentCtx: this.ctx,
      nlqSchedulingPort: () => this.nlqSchedulingPort(),
      // Issue #1262 Phase 4: channel NLQ deps need DO storage SQL
      // for the scan/profile stores and discovery runners.
      getStorageSql: () => this.ctx.storage.sql,
    });
    if (tradingIntegrationsResponse) return tradingIntegrationsResponse;

    // Issue #359-09: E*TRADE broker account-activity routes (transactions,
    // alerts, product lookup) are handled by
    // src/agents/routes/etradeBroker.ts (handleEtradeBrokerActivityRoutes).
    // Invoked at this exact position in the sequential matching sequence
    // (after the trading channels block, before the options block);
    // a non-null return matched.
    const etradeBrokerActivityResponse = await handleEtradeBrokerActivityRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      readSettingRaw: (key) => this.readSettingRaw(key),
      writeSetting: (key, value) => this.writeSetting(key, value),
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin),
      persistScreenerReportCanonical: (result) => this.persistScreenerReportCanonical(result),
      evaluateAndRecordAutopilotVerdict: (params) => this.evaluateAndRecordAutopilotVerdict(params),
      getAutopilotState: () => this.getAutopilotState(),
      incrementAutopilotOrdersToday: () => this.incrementAutopilotOrdersToday(),
      schedule: (when, callback, payload) => this.schedule(when, callback as keyof this, payload),
      cancelSchedule: (id) => this.cancelSchedule(id),
    });
    if (etradeBrokerActivityResponse) return etradeBrokerActivityResponse;

    // Issue #359-11: E*TRADE options routes (chains / expire-dates / scans /
    // iv-history / profiles / strategy) and the trading/options routes
    // (llm-ideas / compare / recommend / catalog / strategies / screen /
    // unified / config) are handled by src/agents/routes/etradeOptions.ts
    // (handleEtradeOptionsRoutes). Invoked at this exact position in the
    // sequential path.endsWith matching sequence (after the E*TRADE broker
    // account-activity delegation, before the watchlists block); a non-null
    // return matched. The requestedEnv binding stays inline in the
    // dispatcher (shared with the watchlists delegation below) and is
    // passed through the context.
    const etradeOptionsResponse = await handleEtradeOptionsRoutes(request, url, path, sessionId, {
      env: this.env,
      asyncJobId: request.headers.get("x-async-job-id") || undefined,
      scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string) =>
        scheduleScreenerFollowups(this.asyncJobsContext(), outcome, userLogin),
      getOrm: () => this.getOrm(),
      agentCtx: this.ctx,
      ensureTables: () => this.ensureTables(),
      requestedEnv,
      getScreenerAgent: (userLogin) => this.getScreenerAgent(userLogin),
    });
    if (etradeOptionsResponse) return etradeOptionsResponse;

    // Issue #359-12: E*TRADE watchlists routes (list / details / create /
    // save-screen / delete) are handled by src/agents/routes/watchlists.ts
    // (handleWatchlistsRoutes). Invoked at this exact position in the
    // sequential path.endsWith matching sequence (after the E*TRADE options
    // delegation, before the Alpaca block); a non-null return matched. The
    // requestedEnv binding stays inline and is passed through the context.
    const watchlistsResponse = await handleWatchlistsRoutes(request, url, path, sessionId, {
      env: this.env,
      getOrm: () => this.getOrm(),
      requestedEnv,
    });
    if (watchlistsResponse) return watchlistsResponse;

    const alpacaTradingResponse = await handleAlpacaTradingRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (alpacaTradingResponse) return alpacaTradingResponse;

    // ==========================================
    // Market Data Research & Quoting APIs (yfinance & Alpaca)
    // ==========================================

    const marketDataResearchResponse = await handleMarketDataQuoteResearchRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      persistScreenerReportCanonical: (result) => this.persistScreenerReportCanonical(result),
    });
    if (marketDataResearchResponse) return marketDataResearchResponse;

    const alpacaMarketDataResponse = await handleAlpacaMarketDataRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (alpacaMarketDataResponse) return alpacaMarketDataResponse;

    const marketDataScreeningResponse = await handleMarketDataCompareScreenRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      persistScreenerReportCanonical: (result) => this.persistScreenerReportCanonical(result),
    });
    if (marketDataScreeningResponse) return marketDataScreeningResponse;

    // ==========================================
    // Cloudflare Agents Task Scheduling Management APIs
    // ==========================================

    // Issue #359-15: screener + autonomous research routes (/screener/*,
    // options PDF, /research/*) live in src/agents/routes/screenerResearch.ts
    // (handleScreenerResearchRoutes), invoked at this exact position in the
    // sequential path.endsWith sequence (after the market-data compare/screen
    // delegation, before the task schedules block); a non-null return
    // matched. Orchestrator-owned helpers arrive via the context object.
    const screenerResearchResponse = await handleScreenerResearchRoutes(request, url, path, sessionId, {
      getScreenerAgent: (userLogin?: string) => this.getScreenerAgent(userLogin),
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      getResearchAgent: (userLogin?: string) => this.getResearchAgent(userLogin),
      runResearchAndPublish: (trigger, userLogin) => this.runResearchAndPublish(trigger, userLogin),
      getOrm: () => this.getOrm(),
      // Issue #1661: DO blob handle for full capture on the backtest leg.
      getStorage: () => this.ctx.storage,
      readSettingRaw: (key) => this.readSettingRaw(key),
      writeSetting: (key, value) => this.writeSetting(key, value),
      env: this.env,
    });
    if (screenerResearchResponse) return screenerResearchResponse;
    // Issue #2280: maintenance routes run before the schedules routes.
    const maintenanceResponse = await handleMaintenanceRoutes(request, url, path, sessionId, {
      agentCtx: this.ctx,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (maintenanceResponse) return maintenanceResponse;
    // Issue #2331 slice 1: service-user provisioning routes run after
    // maintenance, before schedules; the route logic itself lives in
    // routes/serviceUser.ts, the class gains no logic.
    const serviceUserResponse = await handleServiceUserRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (serviceUserResponse) return serviceUserResponse;

    // Issue #2457: cross-tenant queue routes run after service-user,
    // before schedules; the route logic itself lives in
    // routes/adminTenantQueues.ts, the class gains no logic.
    const adminTenantQueueResponse = await handleAdminTenantQueueRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (adminTenantQueueResponse) return adminTenantQueueResponse;

    // Issue #2489: KV wipe routes run after admin tenant queues,
    // before schedules; the route logic itself lives in
    // routes/kvWipe.ts, the class gains no logic.
    const kvWipeResponse = await handleKvWipeRoutes(request, url, path, sessionId, {
      env: this.env,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });
    if (kvWipeResponse) return kvWipeResponse;

    // Issue #359-16: schedules task-scheduling routes (list/create/cancel/
    // trigger-*) are handled by src/agents/routes/schedules.ts
    // (handleSchedulesRoutes). Invoked at this exact position in the
    // sequential path.endsWith matching sequence (after the screener +
    // research delegation, before the Not-found fallthrough); a non-null
    // return matched. Orchestrator-owned helpers (the SDK scheduling
    // port, audit, getOrm, autonomousMarketScreen/autoRenewETradeTokens,
    // getScreenerExecutionContext, the #111 callback allow-list constants)
    // arrive via the context object.
    const schedulesResponse = await handleSchedulesRoutes(request, url, path, sessionId, {
      env: this.env,
      agentCtx: this.ctx,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
      listSchedules: (criteria) => this.listSchedules(criteria),
      cancelSchedule: (id) => this.cancelSchedule(id),
      getScheduleById: (id) => this.getScheduleById(id),
      schedule: (when, callback, payload, options) => this.schedule(when, callback as keyof this, payload, options),
      scheduleEvery: (intervalSeconds, callback, payload) => this.scheduleEvery(intervalSeconds, callback as keyof this, payload),
      getScreenerExecutionContext: () => this.getScreenerExecutionContext(),
      getOrm: () => this.getOrm(),
      scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string, chainReport?: boolean) =>
        scheduleScreenerFollowups(this.asyncJobsContext(), outcome, userLogin, chainReport),
      submitShardJob: (spec) => (this as any).submitAsyncJob(spec),
      submitAsyncJob: (spec) => (this as any).submitAsyncJob(spec),
      autonomousMarketScreen: (payload) => this.autonomousMarketScreen(payload),
      autoRenewETradeTokens: (payload) => this.autoRenewETradeTokens(payload),
      creatableScheduleCallbacks: CREATABLE_SCHEDULE_CALLBACKS,
      accountScopedScheduleCallbacks: ACCOUNT_SCOPED_SCHEDULE_CALLBACKS,
      runScheduleCallback: makeRunScheduleCallback(this),
    });
    if (schedulesResponse) return schedulesResponse;

    return new Response("Not found", { status: 404 });
  }
}
