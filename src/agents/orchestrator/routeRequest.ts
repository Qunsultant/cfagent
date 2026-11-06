/**
 * Issue #2942 (orchestrator split, under #2764) — the orchestrator's HTTP
 * route dispatch, moved verbatim from OrchestratorAgent.routeRequest
 * (moves only, no behaviour change). The class keeps a thin wrapper so
 * every caller (onRequest, contexts, the queue decision) is untouched.
 *
 * The dispatch order below is load-bearing: handlers are tried in this
 * exact sequence and the first non-null response wins, ending in the
 * Not-found fallthrough. Do not reorder blocks without updating the
 * per-route extraction characterization tests.
 *
 * The agent surface the dispatch needs is declared as RouteRequestDeps:
 * the class passes itself (cast — the members are the class's private
 * methods, which only the class may name; at runtime they are the same
 * functions the inline body called). Nothing here reaches the class
 * itself, so there is no import cycle back to orchestrator.ts.
 */
import type { AgentContext } from "agents";
import type { Env, AgentName, AsyncJobRecord } from "../../types";
import { parseTraceparent } from "../../observability/observabilityPorts";
import type { UiChatMessage } from "../../actors/actorPorts";
import type { ResearchAgent } from "../research-agent";
import type { D1ProviderConfigAdapter } from "../../data/d1ProviderConfigAdapter";
import type { D1ProviderCaptureAdapter } from "../../data/d1ProviderCaptureAdapter";
import type { AsyncJobsContext } from "./asyncJobs";
import type { PaymentsFlowScopedModes } from "../../config/paymentsFlowModes";
import type { ScreenerRunOutcome } from "../../services/screenerFollowups";
import type { ResearchExecutionPath } from "../../services/researchTaskLedger";
import type { ReportsRouteContext } from "../routes/reports";
import type { McpChatNlqRouteContext } from "../routes/mcpChatNlq";
import type { AutopilotRouteContext } from "../routes/autopilot";
import type { SchedulesRouteContext } from "../routes/schedules";
import type { EtradeBrokerRouteContext } from "../routes/etradeBroker";
import { handleReportsRoutes, makeSubmitFollowupDelivery } from "../routes/reports";
import { handleScreenerPresetRoutes } from "../routes/screenerPresets";
import { handleMcpChatNlqRoutes } from "../routes/mcpChatNlq";
import { handleSchemaRoutes } from "../routes/schema";
import { handleAdsRevenueReferralsRoutes, handleReferralsAdsRoutes } from "../routes/adsRevenueReferrals";
import { handleAuditRoutes } from "../routes/audit";
import { handleMeterRoutes } from "../routes/meter";
import { handleDlqRoutes } from "../routes/dlq";
import { handleDataProviderRoutes } from "../routes/dataProviders";
import { handleEnrichmentRoutes } from "../routes/enrichment";
import { handleWorkflowRunsRoutes } from "../routes/workflowRuns";
import { handleKnowledgeCorpusRoutes } from "../routes/knowledgeCorpus";
import { handleSearchHubRoutes } from "../routes/searchHub";
import { handleAutopilotRoutes } from "../routes/autopilot";
import { handleMemoryResetRoutes } from "../routes/memoryReset";
import { handlePaymentsRoutes } from "../routes/payments";
import { handlePaymentAssuranceLiveRoutes } from "../routes/paymentAssuranceLive";
import { handleAgenticPaymentsRoutes } from "../routes/agenticPayments";
import { handlePlatformUsersRoutes } from "../routes/platformUsers";
import { handlePlatformAccountRoutes } from "../routes/platformAccounts";
import { handlePremiumRoutes, makePremiumRouteContext } from "../routes/premium";
import { handleTradingIntegrationsRoutes } from "../routes/tradingIntegrations";
import { handleEtradeBrokerRoutes, handleEtradeBrokerActivityRoutes } from "../routes/etradeBroker";
import { handleBrokerOrderRoutes } from "../routes/brokerOrders";
import { handleBrokerOptionsRoutes } from "../routes/brokerOptions";
import { handleBrokerReadsRoutes } from "../routes/brokerReads";
import { handleBrokerConnectRoutes } from "../routes/brokerConnect";
import { handleBrokerRiskRoutes } from "../routes/brokerRisk";
import { handleBrokerScreenRoutes } from "../routes/brokerScreen";
import { handleEtradeOptionsRoutes } from "../routes/etradeOptions";
import { handleOptionsProviderGateRoutes } from "../routes/optionsProviderGate";
import { resolveBrokerEnvironmentFromSettings } from "../routes/brokerEnvironment";
import { handleWatchlistsRoutes } from "../routes/watchlists";
import { handleBrokerGateRoutes } from "../routes/brokerGate";
import { handleAlpacaMarketDataRoutes, handleAlpacaTradingRoutes } from "../routes/alpaca";
import { handleMarketDataQuoteResearchRoutes, handleMarketDataCompareScreenRoutes } from "../routes/marketDataResearch";
import { handleScreenerResearchRoutes } from "../routes/screenerResearch";
import { handleSchedulesRoutes, makeRunScheduleCallback } from "../routes/schedules";
import { handleStockCopilotRoutes } from "../routes/stockCopilot";
import { handleMaintenanceRoutes } from "../routes/maintenance";
import { handleServiceUserRoutes } from "../routes/serviceUser";
import { handleDelegationRoutes } from "../routes/delegations";
import { handleOrchestratorMigrationRoutes } from "../routes/orchestratorMigration";
import { ACCOUNT_SCOPED_SCHEDULE_CALLBACKS, CREATABLE_SCHEDULE_CALLBACKS } from "./scheduleCallbacks";
import { REPORT_CONFIRMATION_TTL_MS } from "./reportConfirmationTtl";
import { handleAdminTenantQueueRoutes } from "../routes/adminTenantQueues";
import { handlePlatformTenantRoutes } from "../routes/platformTenants";
import { handlePlatformChannelRoutes } from "../routes/platformChannels";
import { handleKvWipeRoutes } from "../routes/kvWipe";
import { handleDataLifecycleRoutes } from "../routes/dataLifecycle";
import { scheduleScreenerFollowups } from "./asyncJobs";

/** The orchestrator surface the route dispatch needs (see header note). */
export interface RouteRequestDeps {
  env: Env;
  ctx: AgentContext;
  sessionKey(): string;
  ensureTables: ReportsRouteContext["ensureTables"];
  getOrm: McpChatNlqRouteContext["getOrm"];
  getStorageSql: McpChatNlqRouteContext["getStorageSql"];
  getStorage: McpChatNlqRouteContext["getStorage"];
  audit(type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>): void;
  recordAudit: import("../routes/audit").AuditRouteContext["recordAudit"];
  getScreenerAgent: ReportsRouteContext["getScreenerAgent"];
  getScreenerExecutionContext: ReportsRouteContext["getScreenerExecutionContext"];
  getReportDispatchHitl: ReportsRouteContext["getReportDispatchHitl"];
  setReportDispatchHitl: ReportsRouteContext["setReportDispatchHitl"];
  getReportConfirmation: ReportsRouteContext["getReportConfirmation"];
  decideReportConfirmation: ReportsRouteContext["decideReportConfirmation"];
  createReportConfirmation: ReportsRouteContext["createReportConfirmation"];
  confirmationDeliveryMeta: ReportsRouteContext["confirmationDeliveryMeta"];
  deliverStoredReportEmail: ReportsRouteContext["deliverStoredReportEmail"];
  deliverStoredReportWebhook: ReportsRouteContext["deliverStoredReportWebhook"];
  sendReportEmail: ReportsRouteContext["sendReportEmail"];
  sendReportWebhook: ReportsRouteContext["sendReportWebhook"];
  storeResearchReportCanonicalAsync: ReportsRouteContext["storeResearchReportCanonicalAsync"];
  submitAsyncJob: NonNullable<SchedulesRouteContext["submitAsyncJob"]>;
  getAsyncJob: McpChatNlqRouteContext["getAsyncJob"];
  listAsyncJobs(limit?: number): AsyncJobRecord[];
  extractMessageText: McpChatNlqRouteContext["extractMessageText"];
  getPortMessages(): Promise<UiChatMessage[]>;
  recordMessage: McpChatNlqRouteContext["recordMessage"];
  runAgenticChatTurn: McpChatNlqRouteContext["runAgenticChatTurn"];
  buildChatErrorFallback: McpChatNlqRouteContext["buildChatErrorFallback"];
  scopedHttpDeliveryModes: McpChatNlqRouteContext["scopedHttpDeliveryModes"];
  scopedJobListModes: McpChatNlqRouteContext["scopedJobListModes"];
  scopedPaymentsFlowModes: PaymentsFlowScopedModes;
  /** #3156 (Q7): audit-policy port for the money-path gate (null when unbound). */
  auditPolicyPort(): Promise<import("../../data/auditPolicyPorts").AuditPolicyPort | null>;
  nlqSchedulingPort: NonNullable<McpChatNlqRouteContext["nlqSchedulingPort"]>;
  nlqSocialBriefPort: NonNullable<McpChatNlqRouteContext["nlqSocialBriefPort"]>;
  getResearchAgent(userLogin?: string): ResearchAgent | null;
  runResearchAndPublish(
    trigger: "manual" | "scheduled",
    userLogin?: string,
  ): Promise<{
    success: boolean;
    error?: string;
    reportId?: string | null;
    created?: boolean;
    emailed?: boolean;
    report?: unknown;
    taskId?: string | null;
    executionPath?: ResearchExecutionPath;
  }>;
  readSettingRaw(key: string): string | null;
  writeSetting(key: string, value: string): void;
  getAutopilotState: AutopilotRouteContext["getAutopilotState"];
  writeAutopilotState: AutopilotRouteContext["writeAutopilotState"];
  incrementAutopilotOrdersToday: EtradeBrokerRouteContext["incrementAutopilotOrdersToday"];
  evaluateAndRecordAutopilotVerdict: AutopilotRouteContext["evaluateAndRecordAutopilotVerdict"];
  autonomousMarketScreen: SchedulesRouteContext["autonomousMarketScreen"];
  autoRenewETradeTokens: SchedulesRouteContext["autoRenewETradeTokens"];
  persistScreenerReportCanonical: EtradeBrokerRouteContext["persistScreenerReportCanonical"];
  asyncJobsContext(): AsyncJobsContext;
  dataProviderPorts(): Promise<{
    config: D1ProviderConfigAdapter | null;
    captures: D1ProviderCaptureAdapter | null;
  }>;
  listSchedules: SchedulesRouteContext["listSchedules"];
  cancelSchedule: SchedulesRouteContext["cancelSchedule"];
  getScheduleById: SchedulesRouteContext["getScheduleById"];
  schedule: SchedulesRouteContext["schedule"];
  scheduleEvery: SchedulesRouteContext["scheduleEvery"];
  resetTurnState(): void;
  abortAllRequests(reason?: unknown): void;
  clearMessages(): Promise<void>;
}

/**
 * The orchestrator's HTTP route dispatch (moved verbatim from
 * OrchestratorAgent.routeRequest). First non-null handler wins.
 */
export async function routeRequest(deps: RouteRequestDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const sql = deps.ensureTables();
  const sessionId = deps.sessionKey();

  // Issue #359-01: reports + HITL routes are handled by
  // src/agents/routes/reports.ts. Invoked at this exact position in the
  // sequential path.endsWith matching sequence; a non-null return matched.
  const reportsResponse = await handleReportsRoutes(request, url, path, sessionId, {
    env: deps.env,
    ensureTables: () => deps.ensureTables(),
    getScreenerAgent: (userLogin?: string) => deps.getScreenerAgent(userLogin),
    getScreenerExecutionContext: () => deps.getScreenerExecutionContext(),
    getReportDispatchHitl: () => deps.getReportDispatchHitl(),
    setReportDispatchHitl: (enabled) => deps.setReportDispatchHitl(enabled),
    getReportConfirmation: (id) => deps.getReportConfirmation(id),
    decideReportConfirmation: (id, status, decidedBy) =>
      deps.decideReportConfirmation(id, status, decidedBy),
    createReportConfirmation: (kind, payloadJson, reportId, createdBy) =>
      deps.createReportConfirmation(kind, payloadJson, reportId, createdBy),
    submitFollowupDelivery: makeSubmitFollowupDelivery((job) => deps.submitAsyncJob(job)),
    confirmationDeliveryMeta: (row) => deps.confirmationDeliveryMeta(row),
    deliverStoredReportEmail: (reportId, recipient, userLogin) =>
      deps.deliverStoredReportEmail(reportId, recipient, userLogin),
    deliverStoredReportWebhook: (reportId, userLogin) =>
      deps.deliverStoredReportWebhook(reportId, userLogin),
    sendReportEmail: (recipient, title, fileName, attachmentBase64, userLogin) =>
      deps.sendReportEmail(recipient, title, fileName, attachmentBase64, userLogin),
    sendReportWebhook: (title, query, sheets, userLogin) =>
      deps.sendReportWebhook(title, query, sheets, userLogin),
    storeResearchReportCanonicalAsync: (bodyJson, meta) =>
      deps.storeResearchReportCanonicalAsync(bodyJson, meta),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    reportConfirmationTtlMs: () => REPORT_CONFIRMATION_TTL_MS,
  });
  if (reportsResponse) return reportsResponse;

  // Issue #1495 (#940-A): screener preset routes (screenerPresets.ts), invoked at this exact position in the sequential matching sequence.
  const presetsResponse = await handleScreenerPresetRoutes(request, url, path, sessionId, { ensureTables: () => deps.ensureTables() });
  if (presetsResponse) return presetsResponse;

  // Issue #359-02: MCP + chat + NLQ routes are handled by
  // src/agents/routes/mcpChatNlq.ts. Invoked at this exact position in the
  // sequential path.endsWith matching sequence; a non-null return matched.
  const mcpChatNlqResponse = await handleMcpChatNlqRoutes(request, url, path, sessionId, {
    getOrm: () => deps.getOrm(),
    getStorageSql: () => deps.ctx.storage.sql,
    // Issue #1661: DO blob handle for full capture on NLQ legs.
    getStorage: () => deps.ctx.storage,
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    submitAsyncJob: (job) => deps.submitAsyncJob(job),
    getAsyncJob: (jobId) => deps.getAsyncJob(jobId),
    listAsyncJobs: () => deps.listAsyncJobs().map(({ result: _result, ...job }) => job),
    extractMessageText: (message) => deps.extractMessageText(message),
    getMessages: () => deps.getPortMessages(),
    recordMessage: (role, content, agent) => deps.recordMessage(role, content, agent),
    runAgenticChatTurn: (opts) => deps.runAgenticChatTurn(opts),
    buildChatErrorFallback: (err, userText, userLogin) => deps.buildChatErrorFallback(err, userText, userLogin),
    scopedHttpDeliveryModes: deps.scopedHttpDeliveryModes,
    scopedJobListModes: deps.scopedJobListModes,
    nlqSchedulingPort: () => deps.nlqSchedulingPort(),
    nlqSocialBriefPort: () => deps.nlqSocialBriefPort(),
  });
  if (mcpChatNlqResponse) return mcpChatNlqResponse;

  // Issue #359-17: schema introspection routes (GET /schema/tables,
  // POST /schema/query) are handled by src/agents/routes/schema.ts.
  // Invoked at this exact position in the sequential path.endsWith
  // matching sequence (between the MCP/chat/NLQ handler and the
  // ads/revenue/referrals handler); a non-null return matched.
  const schemaResponse = await handleSchemaRoutes(request, url, path, sessionId, {
    getOrm: () => deps.getOrm(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (schemaResponse) return schemaResponse;

  // Issue #359-03: ads / revenue / referrals (inventory group: categories,
  // revenue, external ads) are handled by
  // src/agents/routes/adsRevenueReferrals.ts. Invoked at this exact
  // position in the sequential path.endsWith matching sequence (between
  // /schema/query and /audit); a non-null return matched.
  const adsRevenueReferralsResponse = await handleAdsRevenueReferralsRoutes(request, url, path, sessionId, {
    getOrm: () => deps.getOrm(),
    ensureTables: () => deps.ensureTables(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    env: deps.env, // #1721: global-env fallback for the ads/revenue switches.
  });
  if (adsRevenueReferralsResponse) return adsRevenueReferralsResponse;

  // Issue #359-04: audit routes (GET/POST /audit, POST /audit/event) are
  // handled by src/agents/routes/audit.ts. Invoked at this exact position
  // in the sequential path.endsWith matching sequence (between the
  // ads/revenue/referrals handler and the autopilot block); a non-null
  // return matched.
  const auditResponse = await handleAuditRoutes(request, url, path, sessionId, {
    ensureTables: () => deps.ensureTables(),
    getOrm: () => deps.getOrm(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    recordAudit: (type, agent, payload) => deps.recordAudit(type, agent, payload),
    env: deps.env, // #1733: global-env fallback for AUDIT_WRITE_MODE.
  });
  if (auditResponse) return auditResponse;

  const meter = await handleMeterRoutes(request, url, path, sessionId, { sql: deps.ctx.storage.sql, env: deps.env });
  if (meter) return meter;

  const dlq = await handleDlqRoutes(request, url, path, sessionId, { env: deps.env });
  if (dlq) return dlq;

  // Issue #1170 (E3): data-provider lifecycle routes are handled
  // by src/agents/routes/dataProviders.ts. Invoked here (after the
  // audit handler); a non-null return matched. The verified login
  // (set by src/server.ts from the session, #1156) gates mutations
  // and is the audit actor.
  const dataProviderPorts = await deps.dataProviderPorts();
  const dataProvidersResponse = await handleDataProviderRoutes(request, url, path, sessionId, {
    env: deps.env,
    sql: deps.ctx.storage.sql,
    configPort: dataProviderPorts.config,
    capturePort: dataProviderPorts.captures,
    userLogin: request.headers.get("x-user-login") || "",
    recordAudit: (type, agent, payload) => deps.recordAudit(type, agent, payload),
  });
  if (dataProvidersResponse) return dataProvidersResponse;

  // Issue #1888: enrichment routes (routes/enrichment.ts), after data-providers; non-null return matched.
  const enrichmentResponse = await handleEnrichmentRoutes(request, url, path, sessionId, {
    env: deps.env,
    sql: deps.ctx.storage.sql,
    userLogin: request.headers.get("x-user-login") || "",
    recordAudit: (type, agent, payload) => deps.recordAudit(type, agent, payload),
  });
  if (enrichmentResponse) return enrichmentResponse;

  // Workflow Runs ledger (routes/workflowRuns.ts), after enrichment.
  const workflowRunsResponse = await handleWorkflowRunsRoutes(request, url, path, sessionId, {
    ensureTables: () => deps.ensureTables(),
    userLogin: request.headers.get("x-user-login") || "", env: deps.env,
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
    env: deps.env,
    storage: deps.ctx.storage,
    userLogin: request.headers.get("x-user-login") || "",
    sql: deps.ctx.storage.sql,
  });
  if (knowledgeCorpusResponse) return knowledgeCorpusResponse;

  // Issue #2120 (slice 1): Search hub routes (POST /search/agent,
  // POST /search/knowledge). Mounted adjacent to the knowledgeCorpus
  // mount; the new paths collide with no existing suffix.
  // Issue #1169 (S4-2): POST /search/mas rides the same mount; it
  // additionally receives the report store (the MAS tool's sql) and
  // the orchestrator audit (its type accepts the MAS "search"
  // agent value), mirroring the autopilot mount's audit pattern.
  // Issue #3323: POST /search/ai-agent rides the same mount; it
  // dispatches over deps.env's AI_SEARCH_AGENT Durable Object
  // binding and threads this mount's session login as callerLogin.
  const searchHubResponse = await handleSearchHubRoutes(request, url, path, sessionId, {
    env: deps.env,
    userLogin: request.headers.get("x-user-login") || "",
    sql: deps.ctx.storage.sql,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (searchHubResponse) return searchHubResponse;

  // Issue #359-05: autopilot control center routes (GET /autopilot,
  // POST /autopilot/state, POST /autopilot/kill-switch,
  // POST|PUT /autopilot/limits, POST /autopilot/evaluate) are handled
  // by src/agents/routes/autopilot.ts. Invoked at this exact position
  // in the sequential matching sequence (between the audit handler and
  // the Persistent Memory endpoint); a non-null return matched.
  const autopilotResponse = await handleAutopilotRoutes(request, url, path, sessionId, {
    ensureTables: () => deps.ensureTables(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    getAutopilotState: () => deps.getAutopilotState(),
    writeAutopilotState: (patch) => deps.writeAutopilotState(patch),
    evaluateAndRecordAutopilotVerdict: (params) => deps.evaluateAndRecordAutopilotVerdict(params),
  });
  if (autopilotResponse) return autopilotResponse;

  // Issue #359-06: memory + reset routes (GET/POST/DELETE /memory,
  // POST|DELETE|GET /clear|/reset) are handled by
  // src/agents/routes/memoryReset.ts. Invoked at this exact position
  // in the sequential path.endsWith matching sequence (between the
  // autopilot handler and the referrals+ads handler); a non-null
  // return matched.
  const memoryResetResponse = await handleMemoryResetRoutes(request, url, path, sessionId, {
    ensureTables: () => deps.ensureTables(),
    getOrm: () => deps.getOrm(),
    // #1723: env for the MEMORY_READ_MODE env level on GET /memory.
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    abortAllRequests: (_reason) => deps.abortAllRequests(),
    resetTurnState: () => deps.resetTurnState(),
    clearConversationMessages: async () => {
      await deps.clearMessages();
    },
  });
  if (memoryResetResponse) return memoryResetResponse;

  // Issue #359-03: referrals + sponsored ads (community group) are
  // handled by src/agents/routes/adsRevenueReferrals.ts. Invoked at this
  // exact position in the sequential path.endsWith matching sequence
  // (between /memory and the payments block); a non-null return matched.
  const referralsAdsResponse = await handleReferralsAdsRoutes(request, url, path, sessionId, {
    getOrm: () => deps.getOrm(),
    ensureTables: () => deps.ensureTables(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    env: deps.env, // #1721: global-env fallback for the ads/revenue switches.
  });
  if (referralsAdsResponse) return referralsAdsResponse;

  // Issue #359-07: payments routes (Multi-Gateway Payments & DID
  // Management API) are handled by src/agents/routes/payments.ts.
  // Invoked at this exact position in the sequential path.endsWith
  // matching sequence (between the referrals+ads handler and the
  // Cloudflare Agentic Payments block); a non-null return matched.
  const paymentsResponse = await handlePaymentsRoutes(request, url, path, sessionId, {
    env: deps.env,
    ensureTables: () => deps.ensureTables(),
    getOrm: () => deps.getOrm(),
    getAuditPolicyPort: () => deps.auditPolicyPort(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    // #1735: session/user carriers for PAYMENTS_FLOW_MODE (run is
    // per-call on the route context and is not set here — there is
    // no execution-owner run source on this path today, and a
    // request-supplied run value must never flip the flow).
    scopedPaymentsFlowModes: deps.scopedPaymentsFlowModes,
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
    env: deps.env,
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
    env: deps.env,
    getOrm: () => deps.getOrm(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (agenticPaymentsResponse) return agenticPaymentsResponse;

  // Issue #2220 (program #2218 slice 2): user administration
  // routes live in src/agents/routes/platformUsers.ts. Invoked
  // immediately after the agentic-payments handler, before
  // premium; a non-null return matched.
  const platformUsersResponse = await handlePlatformUsersRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (platformUsersResponse) return platformUsersResponse;
  // Issue #2221: tenant admin routes, after agentic-payments.
  const platformTenantResponse = await handlePlatformTenantRoutes(request, url, path, sessionId, {
    env: deps.env,
  });
  if (platformTenantResponse) return platformTenantResponse;

  // Issue #2222 (program #2218, slice 4): platform account
  // administration routes (routes/platformAccounts.ts), after
  // the agentic-payments handler; a non-null return matched.
  // The verified login (set by src/server.ts from the session)
  // is the identity and the audit actor.
  const platformAccountResponse = await handlePlatformAccountRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (platformAccountResponse) return platformAccountResponse;

  // Issue #3169 (program #2218): platform channel
  // administration routes (routes/platformChannels.ts), after
  // the account-admin handler and before premium; a non-null
  // return matched. Tenant-level delivery-channel enablement
  // flags, operator-gated like the tenant slice.
  const platformChannelResponse = await handlePlatformChannelRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (platformChannelResponse) return platformChannelResponse;

  // Issue #359-08: premium paid-trading routes (Paid Trading Service:
  // Institutional Options Screener, Equity Research, Anomaly Signals)
  // are handled by src/agents/routes/premium.ts. Invoked at this exact
  // position in the sequential matching sequence (between the Cloudflare
  // Agentic Payments block and the Environment & E*TRADE Trading APIs
  // block); a non-null return matched.
  const premiumResponse = await handlePremiumRoutes(request, url, path, sessionId, makePremiumRouteContext(deps));
  if (premiumResponse) return premiumResponse;

  // Issue #3233 (program #3216): broker-neutral options reads. The selected
  // broker serves /broker/options/*; a capability it does not implement is a
  // coded 501 naming that broker. The legacy /etrade/options/* block below is
  // untouched (its route inventory is byte-pinned by #995).
  const brokerOptionsResponse = await handleBrokerOptionsRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
  });
  if (brokerOptionsResponse) return brokerOptionsResponse;

  // Issue #2853 (gap G2): the account/position reads the neutral broker
  // panels render. Gated by the broker_panel_contract flag; a broker that
  // cannot serve the read answers a coded 501 naming that broker.
  const brokerReadsResponse = await handleBrokerReadsRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
  });
  if (brokerReadsResponse) return brokerReadsResponse;

  // Issue #3324: portfolio risk for the selected broker. The model is the
  // platform's; the book, Greeks, and spot price come from the broker that
  // holds them. Declared per broker in the catalogue.
  const brokerRiskResponse = await handleBrokerRiskRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
  });
  if (brokerRiskResponse) return brokerRiskResponse;

  // Issue #3272 S2: stock screening for the selected broker. The platform
  // does the math; only the quotes come from the broker, so a broker with
  // no screener API can still screen its own universe.
  const brokerScreenResponse = await handleBrokerScreenRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
  });
  if (brokerScreenResponse) return brokerScreenResponse;

  // Issue #3351: Alpaca sign-in. A credential surface, not a panel read: it is
  // the one place a pair is verified and stored, so it sits with the broker
  // routes rather than inside a broker-specific handler.
  const brokerConnectResponse = await handleBrokerConnectRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
  });
  if (brokerConnectResponse) return brokerConnectResponse;

  // Provider/broker slice 1: the broker gate delegation
  // (src/agents/routes/brokerGate.ts). Invoked at this exact
  // position in the sequential matching sequence (after the
  // premium delegation, before the E*TRADE broker delegation);
  // a non-null return matched. It returns the coded
  // FAILURE_BROKER_UNAVAILABLE response for /etrade/ broker and
  // watchlist paths when the tenant broker is not etrade, and
  // null otherwise (including /etrade/options/* data paths).
  const brokerGateResponse = await handleBrokerGateRoutes(request, url, path, sessionId, {
    env: deps.env,
  });
  if (brokerGateResponse) return brokerGateResponse;

  // Issue #359-09: E*TRADE broker routes (Environment & E*TRADE Trading
  // APIs block) are handled by src/agents/routes/etradeBroker.ts
  // (handleEtradeBrokerRoutes). Invoked at this exact position in the
  // sequential matching sequence (after the premium delegation);
  // a non-null return matched.
  const etradeBrokerResponse = await handleEtradeBrokerRoutes(request, url, path, sessionId, {
    env: deps.env,
    traceId: parseTraceparent(request.headers.get("traceparent"))?.traceId ?? null,
    asyncJobId: request.headers.get("x-async-job-id") || undefined,
    scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string) =>
      scheduleScreenerFollowups(deps.asyncJobsContext(), outcome, userLogin),
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
    writeSetting: (key, value) => deps.writeSetting(key, value),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    getScreenerAgent: (userLogin) => deps.getScreenerAgent(userLogin),
    persistScreenerReportCanonical: (result) => deps.persistScreenerReportCanonical(result),
    evaluateAndRecordAutopilotVerdict: (params) => deps.evaluateAndRecordAutopilotVerdict(params),
    getAutopilotState: () => deps.getAutopilotState(),
    incrementAutopilotOrdersToday: () => deps.incrementAutopilotOrdersToday(),
    schedule: ((when, callback, payload) => deps.schedule(when, callback as string, payload)) as EtradeBrokerRouteContext["schedule"],
    cancelSchedule: (id) => deps.cancelSchedule(id),
  });
  if (etradeBrokerResponse) return etradeBrokerResponse;

  // Issue #3089: broker-routed order endpoints (preview/execute/
  // orders resolve the platform from the registry and bind the
  // draft to its broker). Invoked right after the E*TRADE block;
  // the legacy /etrade/* order routes above are untouched.
  const brokerOrderResponse = await handleBrokerOrderRoutes(request, url, path, sessionId, {
    env: deps.env,
    traceId: parseTraceparent(request.headers.get("traceparent"))?.traceId ?? null,
    asyncJobId: request.headers.get("x-async-job-id") || undefined,
    scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string) =>
      scheduleScreenerFollowups(deps.asyncJobsContext(), outcome, userLogin),
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
    writeSetting: (key, value) => deps.writeSetting(key, value),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    getScreenerAgent: (userLogin) => deps.getScreenerAgent(userLogin),
    persistScreenerReportCanonical: (result) => deps.persistScreenerReportCanonical(result),
    evaluateAndRecordAutopilotVerdict: (params) => deps.evaluateAndRecordAutopilotVerdict(params),
    getAutopilotState: () => deps.getAutopilotState(),
    incrementAutopilotOrdersToday: () => deps.incrementAutopilotOrdersToday(),
    schedule: ((when, callback, payload) => deps.schedule(when, callback as string, payload)) as EtradeBrokerRouteContext["schedule"],
    cancelSchedule: (id) => deps.cancelSchedule(id),
  });
  if (brokerOrderResponse) return brokerOrderResponse;

  // The requestedEnv binding stays inline in the dispatcher: it is
  // computed once here and passed through the context to the E*TRADE
  // options and watchlists delegations below. The broker handlers
  // recompute their own copy inside the module.
  // Issue #2482: the binding is the persisted per-login environment
  // selection, never the request header — options and watchlist data
  // must agree with every other broker surface.
  const requestedEnv: "TEST" | "PROD" | undefined =
    resolveBrokerEnvironmentFromSettings((key) => deps.readSettingRaw(key), deps.env);

  // Issue #359-10: omnichannel trading channel routes (email / slack /
  // browser / voice trading integrations) are handled by
  // src/agents/routes/tradingIntegrations.ts
  // (handleTradingIntegrationsRoutes). Invoked at this exact position in
  // the sequential path.endsWith matching sequence (after the E*TRADE
  // broker routes block, before the broker activity delegation); a
  // non-null return matched.
  const tradingIntegrationsResponse = await handleTradingIntegrationsRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    agentCtx: deps.ctx,
    nlqSchedulingPort: () => deps.nlqSchedulingPort(),
    // Issue #1262 Phase 4: channel NLQ deps need DO storage SQL
    // for the scan/profile stores and discovery runners.
    getStorageSql: () => deps.ctx.storage.sql,
  });
  if (tradingIntegrationsResponse) return tradingIntegrationsResponse;

  // Issue #359-09: E*TRADE broker account-activity routes (transactions,
  // alerts, product lookup) are handled by
  // src/agents/routes/etradeBroker.ts (handleEtradeBrokerActivityRoutes).
  // Invoked at this exact position in the sequential matching sequence
  // (after the trading channels block, before the options block);
  // a non-null return matched.
  const etradeBrokerActivityResponse = await handleEtradeBrokerActivityRoutes(request, url, path, sessionId, {
    env: deps.env,
    traceId: parseTraceparent(request.headers.get("traceparent"))?.traceId ?? null,
    getOrm: () => deps.getOrm(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
    writeSetting: (key, value) => deps.writeSetting(key, value),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    getScreenerAgent: (userLogin) => deps.getScreenerAgent(userLogin),
    persistScreenerReportCanonical: (result) => deps.persistScreenerReportCanonical(result),
    evaluateAndRecordAutopilotVerdict: (params) => deps.evaluateAndRecordAutopilotVerdict(params),
    getAutopilotState: () => deps.getAutopilotState(),
    incrementAutopilotOrdersToday: () => deps.incrementAutopilotOrdersToday(),
    schedule: ((when, callback, payload) => deps.schedule(when, callback as string, payload)) as EtradeBrokerRouteContext["schedule"],
    cancelSchedule: (id) => deps.cancelSchedule(id),
  });
  if (etradeBrokerActivityResponse) return etradeBrokerActivityResponse;

  // Provider/broker slice 2 (issue #2598): the options feed gate
  // delegation (src/agents/routes/optionsProviderGate.ts). Invoked at
  // this exact position in the sequential matching sequence
  // (immediately before the E*TRADE options delegation); a non-null
  // return matched. It returns the coded
  // FAILURE_DATA_PROVIDER_UNAVAILABLE response for live-chain options
  // paths when the tenant's selected data provider does not declare
  // optionsChains, and null otherwise — including every stored-run
  // read, the catalog, and config, which read no live chain.
  const optionsProviderGateResponse = await handleOptionsProviderGateRoutes(request, url, path, sessionId, {
    env: deps.env,
  });
  if (optionsProviderGateResponse) return optionsProviderGateResponse;

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
    env: deps.env,
    asyncJobId: request.headers.get("x-async-job-id") || undefined,
    scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string) =>
      scheduleScreenerFollowups(deps.asyncJobsContext(), outcome, userLogin),
    getOrm: () => deps.getOrm(),
    agentCtx: deps.ctx,
    ensureTables: () => deps.ensureTables(),
    requestedEnv,
    getScreenerAgent: (userLogin) => deps.getScreenerAgent(userLogin),
  });
  if (etradeOptionsResponse) return etradeOptionsResponse;

  // Issue #359-12: E*TRADE watchlists routes (list / details / create /
  // save-screen / delete) are handled by src/agents/routes/watchlists.ts
  // (handleWatchlistsRoutes). Invoked at this exact position in the
  // sequential path.endsWith matching sequence (after the E*TRADE options
  // delegation, before the Alpaca block); a non-null return matched. The
  // requestedEnv binding stays inline and is passed through the context.
  const watchlistsResponse = await handleWatchlistsRoutes(request, url, path, sessionId, {
    env: deps.env,
    getOrm: () => deps.getOrm(),
    requestedEnv,
  });
  if (watchlistsResponse) return watchlistsResponse;

  const alpacaTradingResponse = await handleAlpacaTradingRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (alpacaTradingResponse) return alpacaTradingResponse;

  // ==========================================
  // Market Data Research & Quoting APIs (yfinance & Alpaca)
  // ==========================================

  const marketDataResearchResponse = await handleMarketDataQuoteResearchRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    getScreenerAgent: (userLogin?: string) => deps.getScreenerAgent(userLogin),
    persistScreenerReportCanonical: (result) => deps.persistScreenerReportCanonical(result),
  });
  if (marketDataResearchResponse) return marketDataResearchResponse;

  const alpacaMarketDataResponse = await handleAlpacaMarketDataRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (alpacaMarketDataResponse) return alpacaMarketDataResponse;

  const marketDataScreeningResponse = await handleMarketDataCompareScreenRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    getScreenerAgent: (userLogin?: string) => deps.getScreenerAgent(userLogin),
    persistScreenerReportCanonical: (result) => deps.persistScreenerReportCanonical(result),
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
    getScreenerAgent: (userLogin?: string) => deps.getScreenerAgent(userLogin),
    getScreenerExecutionContext: () => deps.getScreenerExecutionContext(),
    getResearchAgent: (userLogin?: string) => deps.getResearchAgent(userLogin),
    runResearchAndPublish: (trigger, userLogin) => deps.runResearchAndPublish(trigger, userLogin),
    getOrm: () => deps.getOrm(),
    traceId: parseTraceparent(request.headers.get("traceparent"))?.traceId ?? null,
    // Issue #1661: DO blob handle for full capture on the backtest leg.
    getStorage: () => deps.ctx.storage,
    readSettingRaw: (key) => deps.readSettingRaw(key),
    writeSetting: (key, value) => deps.writeSetting(key, value),
    env: deps.env,
  });
  if (screenerResearchResponse) return screenerResearchResponse;
  // Issue #2280: maintenance routes run before the schedules routes.
  const maintenanceResponse = await handleMaintenanceRoutes(request, url, path, sessionId, {
    agentCtx: deps.ctx,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (maintenanceResponse) return maintenanceResponse;
  // Issue #2331 slice 1: service-user provisioning routes run after
  // maintenance, before schedules; the route logic itself lives in
  // routes/serviceUser.ts, the class gains no logic.
  const serviceUserResponse = await handleServiceUserRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (serviceUserResponse) return serviceUserResponse;

  // Issue #3153: delegation management routes run after
  // service-user, before admin tenant queues; the route logic
  // itself lives in routes/delegations.ts, the class gains no
  // logic.
  const delegationResponse = await handleDelegationRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (delegationResponse) return delegationResponse;

  // Issue #2457: cross-tenant queue routes run after service-user,
  // before schedules; the route logic itself lives in
  // routes/adminTenantQueues.ts, the class gains no logic.
  const adminTenantQueueResponse = await handleAdminTenantQueueRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (adminTenantQueueResponse) return adminTenantQueueResponse;

  // Issue #2489: KV wipe routes run after admin tenant queues,
  // before schedules; the route logic itself lives in
  // routes/kvWipe.ts, the class gains no logic.
  const kvWipeResponse = await handleKvWipeRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (kvWipeResponse) return kvWipeResponse;

  // Issue #3250: admin data lifecycle routes (clean state,
  // platform bootstrap, tenant bootstrap) run after kvWipe in
  // the admin neighbourhood; every default is resolved inside
  // routes/dataLifecycle.ts from env, the class gains no logic.
  const dataLifecycleResponse = await handleDataLifecycleRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (dataLifecycleResponse) return dataLifecycleResponse;

  // Issue #2681: orchestrator-migration routes run after kvWipe,
  // before schedules; the route logic itself lives in
  // routes/orchestratorMigration.ts, the class gains no logic.
  const migrationResponse = await handleOrchestratorMigrationRoutes(request, url, path, sessionId, {
    env: deps.env,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    storage: deps.ctx.storage as never,
    listSchedules: () => deps.listSchedules() as unknown as Promise<import("../routes/orchestratorMigration").MigrationSchedule[]>,
    schedule: (when, callback, payload, options) => deps.schedule(when, callback as string, payload, options),
    scheduleEvery: (intervalSeconds, callback, payload) => deps.scheduleEvery(intervalSeconds, callback as string, payload),
  });
  if (migrationResponse) return migrationResponse;

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
    env: deps.env,
    agentCtx: deps.ctx,
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
    listSchedules: (criteria) => deps.listSchedules(criteria),
    cancelSchedule: (id) => deps.cancelSchedule(id),
    getScheduleById: (id) => deps.getScheduleById(id),
    schedule: (when, callback, payload, options) => deps.schedule(when, callback as string, payload, options),
    scheduleEvery: (intervalSeconds, callback, payload) => deps.scheduleEvery(intervalSeconds, callback as string, payload),
    getScreenerExecutionContext: () => deps.getScreenerExecutionContext(),
    getOrm: () => deps.getOrm(),
    scheduleScreenerFollowups: (outcome: ScreenerRunOutcome, userLogin: string, chainReport?: boolean) =>
      scheduleScreenerFollowups(deps.asyncJobsContext(), outcome, userLogin, chainReport),
    submitShardJob: (spec) => (deps as any).submitAsyncJob(spec),
    submitAsyncJob: (spec) => (deps as any).submitAsyncJob(spec),
    autonomousMarketScreen: (payload) => deps.autonomousMarketScreen(payload),
    autoRenewETradeTokens: (payload) => deps.autoRenewETradeTokens(payload),
    creatableScheduleCallbacks: CREATABLE_SCHEDULE_CALLBACKS,
    accountScopedScheduleCallbacks: ACCOUNT_SCOPED_SCHEDULE_CALLBACKS,
    runScheduleCallback: makeRunScheduleCallback(deps),
  });
  if (schedulesResponse) return schedulesResponse;

  // Issue #3422: Stock Copilot status + pause/resume control
  // routes (routes/stockCopilot.ts) run after schedules, before
  // the Not-found fallthrough; a non-null return matched. The
  // context is the instance's own storage handle + acting
  // identity, so the panel reads and controls only the signed-in
  // user's own copilot loop.
  const stockCopilotResponse = await handleStockCopilotRoutes(request, url, path, sessionId, {
    env: deps.env,
    sql: deps.ctx.storage.sql,
    getScreenerExecutionContext: () => deps.getScreenerExecutionContext(),
    readSettingRaw: (key) => deps.readSettingRaw(key),
    // #3398: the session-choice write lands in the same settings
    // store the cycle and the status read resolve from.
    writeSetting: (key, value) => deps.writeSetting(key, value),
    audit: (type, agent, payload) => deps.audit(type, agent, payload),
  });
  if (stockCopilotResponse) return stockCopilotResponse;

  return new Response("Not found", { status: 404 });
}
