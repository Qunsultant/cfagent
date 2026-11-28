// @vitest-environment node
/**
 * #6528 Phase 1 (Config: census + pins) — the universal-context census pin.
 *
 * This pin re-runs the context measurement over `src/` and holds the
 * result SHRINK-ONLY against the baseline recorded below, seeded from
 * main at `e5541ff` (2026-11-25, Phase 1):
 *  - a `*Context` definition that is NOT in the baseline fails;
 *  - the app-created context total above its baselined 211 fails;
 *  - decreases and vanished rows pass — that is the shrink the programme
 *    wants, and retiring a definition means lowering or removing its
 *    baseline entry in the same PR.
 *
 * Adding or raising a baseline entry is a deliberate, reviewed act: it
 * requires the new row's census disposition and reason, stated in the PR
 * that does it.
 *
 * Counting rule (from `docs/architecture/survey/context-survey-rca-plan.md`
 * §0, quoted):
 * > A definition is a named `type`/`interface` whose name contains
 * > `Context`, or a named config/port/file-backed object that functions as
 * > one (`Env`, `ResolvedEnvironment`, `EtapiConfig`, `OtelFileConfig`,
 * > `FeatureFlagPort`, `PriceCatalogue`, the 25 `*Modes` families). A usage
 * > is not a definition. A structural mirror counts as its own definition
 * > (it is a separate declaration that can drift). Inputs/results
 * > (`Resolve*Input`, `*Result` unions, `*DenyCode` unions) are counted
 * > only where listed in the services/security rows; elsewhere they are
 * > excluded. `environment.config.json` and wrangler vars+bindings count as
 * > one entry each in the 77.
 *
 * Seed numbers (re-derived on the PR base by exhaustive re-measurement,
 * NOT copied from the `3e516f1c` survey — the recount is
 * `~/workspace/6528-recount.md`; the seed reconciliation is
 * `docs/architecture/survey/6528-census-seed.md`):
 * - app-created: 211 = 131 itemized `*Context` rows (this baseline) − 1
 *   alias row (`BrokerOrderRouteContext`, a type alias, not a shape) − 2
 *   config-named rows (counted inside the 77 instead) + 1
 *   `PlatformIdentity` (a counted non-`*Context*` name) + 77 config
 *   objects + 3 client React contexts + 2 unitemized Tier A companion
 *   shapes (recorded allowance — see below).
 *
 * Phase 2 (#6540, 2026-11-25) raises the baseline 209 → 210 with ONE
 * row: `UniversalEnvContext` (`src/config/environment.ts`, CANONICAL) —
 * the one universal env context the programme adds (survey
 * `target-state-counts.md` §2, `per-domain-end-state.md` D1). Its
 * nested dimension types (`UniversalPlatformDimension`,
 * `UniversalTenantDimension`, `UniversalUserDimension`,
 * `UniversalSettingSources`) and its input (`ResolveUniversalInput`)
 * deliberately carry no `Context` name, so they are not separate
 * contexts (survey §1.1: nested sections are not contexts) and add
 * no further rows. At that phase, counting the excluded server
 * `OfferContext` would have made 211; the current #3122 pin baseline
 * adds `AgentScheduleToolContext`, so counting the excluded row would
 * now make 212.
 *
 * Issue #3122 raises the baseline 210 → 211 with one canonical
 * `AgentScheduleToolContext` row in `src/agents/mcpAdapter.ts`. This narrow
 * schedule-tool adapter port carries only the environment, owner-login
 * accessor, action executor, loop-origin accessor, and goals-only flag;
 * reusing the broad `McpToolContext` would inject unrelated command,
 * database, session, and permission dependencies into this capability.
 * - platform-provided: 3 types (Workers `ExecutionContext` at
 *   `scheduled`/`queue`/`email`, `DurableObjectState` at 3 constructors,
 *   Agents-SDK `AgentContext`) — 5 rows in the survey's §1.6 table, 7
 *   check sites in this pin.
 * - test-only: 0.
 *
 * JUDGMENT CALL — server `OfferContext` (DECISION: EXCLUDED, total stays 211):
 * a second, distinct `OfferContext` definition exists at
 * `src/services/upgradeOffers.ts:758` (`{ trigger, shownAtMs? }`, the
 * audit-only payload the client passes to the mint routes; the counted
 * client one is `src/client/commercialApi.ts:572`). It predates the
 * baseline — the survey missed it, it is not new. Under §0 as written it
 * is an *input* not listed in the services/security rows, so the survey's
 * applied practice excludes it and the total stays 211. If it were
 * counted, the total would be 212. The row is in EXCLUDED below with this
 * reason, so the decision is visible in the pin, not hidden. (Recount
 * §1.3; census seed §2.)
 *
 * Config-78 decomposition (DECISION: recorded, not recomputed):
 * the survey's own arithmetic does not pin down which misc objects are
 * inside the 77 — §0 enumerates 70 before misc (implying 7 misc) while
 * §1.5 excludes 2 JSON files from the 18 (implying 68 + 9 misc); the total
 * is 77 either way. This pin therefore does NOT recompute the 77 from
 * parts: it asserts the 71 enumerated components exist (25 named
 * components + 46 files: 25 `*Modes` files, 19 `config/*.json` files,
 * `environment.config.json`, `wrangler.jsonc`), asserts all 24 misc
 * objects named in §1.5 exist (a superset check), and records 78 as
 * census data. The §0 reading (70 + 7) is the one stated in the census
 * seed; the §1.5 reading (68 + 9) is recorded alongside it.
 * Issue #6709 adds the 19th JSON file (`config/brand.json`) after the
 * seed, so the enumerated count is 71 and the recorded total is 78.
 *
 * Unitemized Tier A allowance (SEED GAP, flagged not hidden):
 * the survey reports 17 Tier A definitions but itemizes 15 by name; the 2
 * companion shapes were never named, and no candidate rows exist in the
 * measured set that are Tier-A execution shapes outside the 15 named
 * (every measured `*Context` row is accounted for in the baseline or in
 * EXCLUDED with a reason). The pin therefore carries them as a recorded
 * allowance of 2 — the design's "itemize all 209 at seed time" could not
 * be satisfied from the survey as written. Itemizing the 2 companions is
 * follow-up census work, not a silent "unknown" row.
 *
 * Why a pure regex cannot reproduce 211: the anchored regex finds 176
 * `*Context` definitions in `src/`; 45 of those are EXCLUDED boundary
 * rows (inputs/results, deny-codes, domain-internal parameter objects,
 * shapes of counted items, UI prop types), leaving 131 counted rows;
 * the remaining 80 of the 211 are non-`*Context*` entries (77 config +
 * `PlatformIdentity` + 3 React consts, which are `const` declarations,
 * not types) plus the 2 unitemized Tier A shapes, minus the alias and
 * the 2 config-named rows (see the formula above). The pin's authority
 * is the census list checked against the enumeration, not the raw regex
 * count.
 *
 * Hermeticity: the pin reads FILES only — never env, never the network,
 * never git. Scope is `src/` (`.ts`/`.tsx`); `tests/` is scanned
 * separately and must define no `*Context` type.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Kind =
  | "execution-identity"
  | "di-ports"
  | "route"
  | "security"
  | "mcp"
  | "services-io"
  | "config-env"
  | "client-data";
type Disposition = "CANONICAL" | "MIRROR" | "ALIAS" | "CONFIG-ENTRY";

const KINDS: ReadonlySet<string> = new Set([
  "execution-identity",
  "di-ports",
  "route",
  "security",
  "mcp",
  "services-io",
  "config-env",
  "client-data",
]);
const DISPOSITIONS: ReadonlySet<string> = new Set([
  "CANONICAL",
  "MIRROR",
  "ALIAS",
  "CONFIG-ENTRY",
]);

/** Recorded census data (see the header — 78 and 2 are recorded, not recomputed). */
const RECORDED_CONFIG_TOTAL = 78;
const RECORDED_UNITEMIZED_TIER_A = 2;
const RECORDED_APP_CREATED_TOTAL = 211;

/** [file, name, kind, disposition] — shrink-only baseline (130 rows). */
const BASELINE: Array<[string, string, Kind, Disposition]> = [
  ["src/agentic/chainExecutor.ts", "ChainExecutionContext", "execution-identity", "CANONICAL"],
  ["src/agents/chatErrorFallback.ts", "ChatErrorFallbackContext", "di-ports", "CANONICAL"],
  ["src/agents/mcpAdapter.ts", "AgentScheduleToolContext", "mcp", "CANONICAL"],
  ["src/agents/orchestrator.ts", "ScreenerExecutionContext", "execution-identity", "MIRROR"],
  ["src/agents/orchestrator/asyncJobs.ts", "AsyncJobsContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/autopilot.ts", "AutopilotContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/canonicalReportSeed.ts", "CanonicalReportSeedContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/chatTurnHelpers.ts", "ChatTurnHelpersContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/durableTurnSubmission.ts", "DurableTurnContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/goalScreenDispatch.ts", "GoalScreenDispatchContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/governanceSeed.ts", "GovernanceSeedContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/httpEntry.ts", "HttpEntryContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/idpProfileConfig.ts", "IdpProfileConfigContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/meshOptionsStageControlDoor.ts", "OptionsStageControlDoorContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "MeshOptionsStrategyDoorContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/meshScreenDoor.ts", "MeshScreenDoorContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/meshStockCopilotDoor.ts", "StockCopilotDoorContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/nlqPorts.ts", "NlqPortsContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/reportDispatch.ts", "ReportDispatchContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/researchPublish.ts", "ResearchPublishContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/scheduleMaintenance.ts", "ScheduleMaintenanceContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/scheduleMaintenance.ts", "ScreenerExecutionContext", "execution-identity", "CANONICAL"],
  ["src/agents/orchestrator/scheduleWatchdog.ts", "ScheduleWatchdogContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/scheduledCallbacks.ts", "ScheduledCallbacksContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/scheduledTasksCopilot.ts", "ScheduledTasksCopilotContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/scheduledTasksObserve.ts", "ScheduledTasksObserveContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/settingsWebhook.ts", "SettingsWebhookContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/shardJobReconcile.ts", "ShardJobReconcileContext", "di-ports", "CANONICAL"],
  ["src/agents/orchestrator/usageEventsDoors.ts", "UsageEventsDoorsContext", "di-ports", "CANONICAL"],
  ["src/agents/pipeline.ts", "PipelineStageContext", "execution-identity", "CANONICAL"],
  ["src/agents/routes/adminTenantQueues.ts", "AdminTenantQueueContext", "route", "CANONICAL"],
  ["src/agents/routes/adsRevenueReferrals.ts", "AdsRevenueReferralsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/agenticPayments.ts", "AgenticPaymentsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/alpaca.ts", "AlpacaRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/audit.ts", "AuditRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/autopilot.ts", "AutopilotRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerConnect.ts", "BrokerConnectRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerEnvironment.ts", "BrokerEnvironmentSwitchContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerGate.ts", "BrokerGateRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerLimits.ts", "BrokerLimitRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerOptions.ts", "BrokerOptionsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerOrders.ts", "BrokerOrderRouteContext", "route", "ALIAS"],
  ["src/agents/routes/brokerReads.ts", "BrokerReadsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerRisk.ts", "BrokerRiskRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/brokerScreen.ts", "BrokerScreenRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/copilotChannels.ts", "CopilotChannelsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/copilotChannels.ts", "ScreenerExecutionContext", "execution-identity", "MIRROR"],
  ["src/agents/routes/cronDispatchRecord.ts", "CronDispatchRecordRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/dataLifecycle.ts", "DataLifecycleRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/dataProviders.ts", "DataProviderRoutesContext", "route", "CANONICAL"],
  ["src/agents/routes/delegations.ts", "DelegationRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/dlq.ts", "DlqRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/enrichment.ts", "EnrichmentRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/etradeBroker.ts", "EtradeBrokerRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/etradeOptions.ts", "EtradeOptionsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/idResolve.ts", "IdResolveRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/jobDefinitions.ts", "JobDefinitionsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/jobStatus.ts", "JobStatusRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/knowledgeCorpus.ts", "KnowledgeCorpusRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/kvWipe.ts", "KvWipeRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/maintenance.ts", "MaintenanceRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/marketDataResearch.ts", "MarketDataResearchRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/mcpChatNlq.ts", "McpChatNlqRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/memoryReset.ts", "MemoryResetRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/meter.ts", "MeterRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/opportunityHunt.ts", "OpportunityHuntRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/optionsProviderGate.ts", "OptionsProviderGateRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/orchestratorMigration.ts", "OrchestratorMigrationContext", "route", "CANONICAL"],
  ["src/agents/routes/paymentAssuranceLive.ts", "PaymentAssuranceLiveContext", "route", "CANONICAL"],
  ["src/agents/routes/payments.ts", "PaymentsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/platformAccounts.ts", "PlatformAccountRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/platformChannels.ts", "PlatformChannelRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/platformTenants.ts", "PlatformTenantRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/platformUsers.ts", "PlatformUsersRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/premium.ts", "PremiumRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/reports.ts", "ReportsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/scheduledJobOutcome.ts", "ScheduledJobOutcomeRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/schedules.ts", "SchedulesRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/schedules.ts", "ScreenerExecutionContext", "execution-identity", "MIRROR"],
  ["src/agents/routes/schema.ts", "SchemaRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/screenerPresets.ts", "ScreenerPresetsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/screenerResearch.ts", "ScreenerExecutionContext", "execution-identity", "MIRROR"],
  ["src/agents/routes/screenerResearch.ts", "ScreenerResearchRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/searchHub.ts", "SearchHubRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/serviceUser.ts", "ServiceUserRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/stockCopilot.ts", "ScreenerExecutionContext", "execution-identity", "MIRROR"],
  ["src/agents/routes/stockCopilot.ts", "StockCopilotRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/tradingIntegrations.ts", "TradingIntegrationsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/watchlists.ts", "WatchlistsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/workflowRuns.ts", "WorkflowRunsRouteContext", "route", "CANONICAL"],
  ["src/agents/routes/workspace.ts", "WorkspaceRouteContext", "route", "CANONICAL"],
  ["src/agents/scheduledTasksPipeline.ts", "ScheduledTasksPipelineContext", "di-ports", "CANONICAL"],
  ["src/agents/trading-agent.ts", "TradingServiceContext", "execution-identity", "CANONICAL"],
  ["src/client/ScannerPanel.tsx", "ScanRunContext", "client-data", "CANONICAL"],
  ["src/client/commercialApi.ts", "OfferContext", "client-data", "CANONICAL"],
  ["src/client/platformContextStore.ts", "PlatformContext", "client-data", "CANONICAL"],
  ["src/client/scheduledOptionsManager/ScheduleCard.tsx", "ScheduleRowContext", "client-data", "CANONICAL"],
  ["src/client/trading/tradeOrderContext.ts", "TradeOrderContext", "client-data", "CANONICAL"],
  ["src/config/environment.ts", "UniversalEnvContext", "config-env", "CANONICAL"],
  ["src/config/platformContext.ts", "PlatformContextCacheLimits", "config-env", "CONFIG-ENTRY"],
  ["src/features/featureFlagPorts.ts", "FeatureEvaluationContext", "config-env", "CONFIG-ENTRY"],
  ["src/mcps/openaimp/handler.ts", "OpenaimpMcpHandlerContext", "mcp", "CANONICAL"],
  ["src/patterns/interfaces.ts", "McpToolContext", "mcp", "CANONICAL"],
  ["src/security/apiRequestContext.ts", "ApiRequestContextDeps", "security", "CANONICAL"],
  ["src/security/apiRequestContext.ts", "ApiRequestContextOutcome", "security", "CANONICAL"],
  ["src/security/commercialExecutionContext.ts", "LedgerWriteContextLog", "security", "CANONICAL"],
  ["src/security/commercialExecutionContext.ts", "ObserveLedgerWriteContextInput", "security", "CANONICAL"],
  ["src/security/commercialExecutionContext.ts", "ResolveLedgerWriteContextHeaderInput", "security", "CANONICAL"],
  ["src/security/commercialExecutionContext.ts", "ResolveLedgerWriteContextInput", "security", "CANONICAL"],
  ["src/security/executionContext.ts", "ExecutionContext", "execution-identity", "CANONICAL"],
  ["src/security/executionContext.ts", "ExecutionContextAuthority", "security", "CANONICAL"],
  ["src/security/executionContext.ts", "ExecutionContextRequestEcho", "security", "CANONICAL"],
  ["src/security/executionContext.ts", "NarrowExecutionContextInput", "security", "CANONICAL"],
  ["src/security/executionContext.ts", "ResolveExecutionContextInput", "security", "CANONICAL"],
  ["src/security/mcpToolContext.ts", "McpToolContextDeps", "security", "CANONICAL"],
  ["src/security/mcpToolContext.ts", "McpToolContextInput", "security", "CANONICAL"],
  ["src/security/mcpToolContext.ts", "McpToolContextOutcome", "security", "CANONICAL"],
  ["src/security/obligations.ts", "ObligationEvaluationContext", "security", "CANONICAL"],
  ["src/security/platformContext.ts", "PlatformContextFacts", "security", "CANONICAL"],
  ["src/security/platformContext.ts", "PlatformContextPorts", "security", "CANONICAL"],
  ["src/security/platformContext.ts", "PlatformContextResult", "security", "CANONICAL"],
  ["src/security/platformContext.ts", "PlatformContextSources", "security", "CANONICAL"],
  ["src/security/platformContext.ts", "ResolvePlatformContextInput", "security", "CANONICAL"],
  ["src/services/accountBindings.ts", "ExecutionAccountContext", "execution-identity", "CANONICAL"],
  ["src/services/accountBindings.ts", "ValidatedExecutionAccountContext", "services-io", "CANONICAL"],
  ["src/services/jobPipelineEngine.ts", "RunContext", "execution-identity", "CANONICAL"],
  ["src/services/jobPipelineSteps.ts", "JobStepContext", "execution-identity", "CANONICAL"],
  ["src/services/optionsProviderContext.ts", "TenantProviderContext", "security", "CANONICAL"],
  ["src/services/runBrokerContext.ts", "ResolveRunBrokerContextInput", "services-io", "CANONICAL"],
  ["src/services/runBrokerContext.ts", "RunBrokerContext", "execution-identity", "CANONICAL"],
  ["src/types.ts", "ShardChainContext", "execution-identity", "CANONICAL"],
];

/** [file, name, kind, reason] — boundary rows: measured, excluded, dispositioned. */
const EXCLUDED: Array<[string, string, Kind, string]> = [
  ["src/actors/actorPorts.ts", "TurnContext", "security", "domain-internal parameter object (actor ports), not a counted context (recount §1.3)"],
  ["src/aspects/loggingAspect.ts", "AgentAspectContext", "security", "domain-internal parameter object (logging aspect), not a counted context (recount §1.3)"],
  ["src/aspects/loggingAspect.ts", "AspectContext", "security", "domain-internal parameter object (logging aspect), not a counted context (recount §1.3)"],
  ["src/aspects/transactionAspect.ts", "TransactionContext", "security", "domain-internal parameter object (transaction aspect), not a counted context (recount §1.3)"],
  ["src/client/components/ui/ContextStrip.tsx", "ContextStripChangeTone", "security", "UI component prop type, not a context (recount §1.3)"],
  ["src/client/components/ui/ContextStrip.tsx", "ContextStripProps", "security", "UI component prop type, not a context (recount §1.3)"],
  ["src/client/options/OptionsResearchPanel.tsx", "ChainContextValue", "security", "shape of counted ChainContext (OptionsResearchPanel.tsx:503), not a separate definition (recount §1.3)"],
  ["src/client/platformContextStore.ts", "PlatformContextResponse", "security", "underlying type of counted PlatformContext, not a separate definition (recount §1.3)"],
  ["src/config/jobDefinitionParamRegistry.ts", "ParamDerivationContext", "security", "domain-internal parameter object (job param registry), not a counted context (recount §1.3)"],
  ["src/data/providerCapturePorts.ts", "ResolvedRunContext", "security", "domain-internal parameter object (provider capture), not a counted context (recount §1.3)"],
  ["src/messaging/messagingPorts.ts", "JobContext", "security", "domain-internal parameter object (messaging ports), not a counted context (recount §1.3)"],
  ["src/observability/aspects.ts", "ObservabilityAspectContext", "security", "domain-internal parameter object (observability aspects), not a counted context (recount §1.3)"],
  ["src/observability/observabilityPorts.ts", "TraceContext", "security", "domain-internal parameter object (observability ports), not a counted context (recount §1.3)"],
  ["src/observability/structuredLogger.ts", "StructuredLogContext", "security", "domain-internal parameter object (structured logger), not a counted context (recount §1.3)"],
  ["src/retrieval/hybridRetrieval.ts", "ExpandGraphContextOptions", "security", "domain-internal parameter object (hybrid retrieval), not a counted context (recount §1.3)"],
  ["src/retrieval/hybridRetrieval.ts", "ExpandGraphContextResult", "security", "domain-internal result object (hybrid retrieval), not a counted context (recount §1.3)"],
  ["src/retrieval/retrievalPorts.ts", "GraphContextRow", "security", "domain-internal parameter object (retrieval ports), not a counted context (recount §1.3)"],
  ["src/security/apiRequestContext.ts", "ApiRequestContextDenyCode", "security", "§0 deny-code union, not listed in the services/security rows (recount §1.3)"],
  ["src/security/commercialExecutionContext.ts", "LedgerWriteContextHeaderResult", "security", "§0 result type, not listed in the services/security rows (recount §1.3)"],
  ["src/security/commercialExecutionContext.ts", "ObserveLedgerWriteContextOutcome", "security", "§0 outcome type, not listed in the services/security rows (recount §1.3)"],
  ["src/security/executionContext.ts", "ContextDenyCode", "security", "§0 deny-code union, not listed in the services/security rows (recount §1.3)"],
  ["src/security/executionContext.ts", "EvaluateExecutionContextResult", "security", "§0 result type, not listed in the services/security rows; the losing candidate for the unitemized security 21st (recount §1.1/§1.3)"],
  ["src/security/executionContext.ts", "ExecutionContextMode", "security", "§0 input/result-adjacent union, not listed in the services/security rows (recount §1.3)"],
  ["src/security/executionContext.ts", "NarrowExecutionContextResult", "security", "§0 result type, not listed in the services/security rows (recount §1.3)"],
  ["src/security/executionContext.ts", "ResolveExecutionContextResult", "security", "§0 result type, not listed in the services/security rows (recount §1.3)"],
  ["src/security/mcpToolContext.ts", "McpToolContextDenyCode", "security", "§0 deny-code union, not listed in the services/security rows (recount §1.3)"],
  ["src/security/platformContext.ts", "PlatformContextDenyCode", "security", "§0 deny-code union, not listed in the services/security rows (recount §1.3)"],
  ["src/security/platformContext.ts", "PlatformContextReResolutionEvent", "security", "§0 event type, not listed in the services/security rows (recount §1.3)"],
  ["src/services/cfpayLedger.ts", "RecordCfpayLedgerRowContextDeps", "security", "§0 deps object, not listed in the services/security rows (recount §1.3)"],
  ["src/services/optionsRunAlertFormat.ts", "OptionsRunAlertContext", "security", "domain-internal parameter object (options run alerts), not a counted context (recount §1.3)"],
  ["src/services/portfolioContextRanking.ts", "PortfolioContextFlag", "security", "domain-internal parameter object (portfolio ranking), not a counted context (recount §1.3)"],
  ["src/services/portfolioContextRanking.ts", "PortfolioContextFlagKind", "security", "domain-internal union (portfolio ranking), not a counted context (recount §1.3)"],
  ["src/services/portfolioContextRanking.ts", "PortfolioContextMarker", "security", "domain-internal parameter object (portfolio ranking), not a counted context (recount §1.3)"],
  ["src/services/portfolioContextRanking.ts", "PortfolioContextSnapshot", "security", "domain-internal parameter object (portfolio ranking), not a counted context (recount §1.3)"],
  ["src/services/providerConnections.ts", "ResolveScreenExecutionContextInput", "security", "§0 input type, not listed in the services/security rows (recount §1.3)"],
  ["src/services/recommendationKernel.ts", "KernelGateContext", "security", "domain-internal parameter object (recommendation kernel), not a counted context (recount §1.3)"],
  ["src/services/recommendationKernel.ts", "RankingContext", "security", "domain-internal parameter object (recommendation kernel), not a counted context (recount §1.3)"],
  ["src/services/researchGates.ts", "GateContext", "security", "domain-internal parameter object (research gates), not a counted context (recount §1.3)"],
  ["src/services/screenerFollowups.ts", "StageChainPlanContext", "security", "domain-internal parameter object (screener followups), not a counted context (recount §1.3)"],
  ["src/services/upgradeOffers.ts", "OfferContext", "client-data", "DECISION (see header): server-side mint-route payload input ({ trigger, shownAtMs? }); §0 counts inputs only where listed in the services/security rows, so this second OfferContext is excluded and the total stays 210. The counted OfferContext is the client one (src/client/commercialApi.ts:572). Counting this one would make the total 211."],
  ["src/trading/dataProviders/contract.ts", "DataRunContext", "security", "domain-internal parameter object (data-provider contract), not a counted context (recount §1.3)"],
  ["src/trading/options/llmIdeas.ts", "ContextLimitedRawOptionsIdeasInput", "security", "§0 input type, not listed in the services/security rows (recount §1.3)"],
  ["src/trading/options/strategies/types.ts", "StrategyContext", "security", "domain-internal parameter object (options strategies), not a counted context (recount §1.3)"],
  ["src/trading/options/unifiedOptionsService.ts", "OmnichannelContext", "security", "channel string union, not an object context (recount §1.3)"],
  ["src/trading/optionsScreener.ts", "ContractScreenContext", "security", "domain-internal parameter object (options screener), not a counted context (recount §1.3)"],
];

/** [file, name] — the 25 named config components (Env … PriceEntry). */
const CONFIG_NAMES: Array<[string, string]> = [
  ["src/types.ts", "Env"],
  ["src/config/environment.ts", "ResolvedEnvironment"],
  ["src/config/etapiConfig.ts", "EtapiConfig"],
  ["src/config/etapiConfig.ts", "EtapiScreenerConfig"],
  ["src/config/etapiConfig.ts", "EtapiStrategyScoreWeights"],
  ["src/config/etapiConfig.ts", "EtapiStrategyEngineConfig"],
  ["src/config/etapiConfig.ts", "EtapiFitGateConfig"],
  ["src/config/etapiConfig.ts", "EtapiOpportunityScannerConfig"],
  ["src/config/etapiConfig.ts", "EtapiDiscoveryConfig"],
  ["src/config/etapiConfig.ts", "DiscoveryDteWindow"],
  ["src/config/etapiConfig.ts", "EtapiExpirationGroup"],
  ["src/config/etapiConfig.ts", "EtapiLlmIdeasConfig"],
  ["src/config/etapiConfig.ts", "EtapiClientConfig"],
  ["src/config/etapiConfig.ts", "EtapiCacheConfig"],
  ["src/config/etapiConfig.ts", "AiModelDefinition"],
  ["src/config/etapiConfig.ts", "AiConfig"],
  ["src/config/etapiConfig.ts", "VoiceAgentConfig"],
  ["src/config/etapiConfig.ts", "TradingConstraintsConfig"],
  ["src/config/etapiConfig.ts", "ExternalApisConfig"],
  ["src/config/otelModes.ts", "OtelFileConfig"],
  ["src/config/otelConfigPort.ts", "OtelConfigPort"],
  ["src/features/featureFlagPorts.ts", "FeatureFlagPort"],
  ["src/features/featureFlagPorts.ts", "FeatureEvaluationContext"],
  ["src/data/priceCataloguePorts.ts", "PriceCatalogue"],
  ["src/data/priceCataloguePorts.ts", "PriceEntry"],
];

/** The 25 `*Modes` files in `src/config/` (one entry each in the 77). */
const MODES_FILES: string[] = [
  "src/config/adsRevenueModes.ts",
  "src/config/agenticPaymentsModes.ts",
  "src/config/apiIngressModes.ts",
  "src/config/asyncJobModes.ts",
  "src/config/chatNlqModes.ts",
  "src/config/cloudflareBrowserMiscModes.ts",
  "src/config/discoveryRankingModes.ts",
  "src/config/etradeModes.ts",
  "src/config/goalChainModes.ts",
  "src/config/knowledgeMemoryModes.ts",
  "src/config/marketDataModes.ts",
  "src/config/nlqModes.ts",
  "src/config/otelModes.ts",
  "src/config/paymentsFlowModes.ts",
  "src/config/portfolioRepairModes.ts",
  "src/config/privacyModes.ts",
  "src/config/quoteModes.ts",
  "src/config/reportGeneratorModes.ts",
  "src/config/restTwinsModes.ts",
  "src/config/runLedgerModes.ts",
  "src/config/scheduleListModes.ts",
  "src/config/scheduleRowModes.ts",
  "src/config/scheduleSourceModes.ts",
  "src/config/schemaMigrationModes.ts",
  "src/config/screenerModes.ts",
];

/** The 19 `config/*.json` files (one entry each in the 78; #6709 adds `config/brand.json`). */
const CONFIG_JSON_FILES: string[] = [
  "config/auto-merge.json",
  "config/brand.json",
  "config/builtin-scheduled-goals.json",
  "config/channel-brokers.json",
  "config/commercial-defaults.json",
  "config/idp-profile.json",
  "config/job-catalogue.json",
  "config/lifecycle-defaults.json",
  "config/options-reports.json",
  "config/order-capabilities.json",
  "config/otel.json",
  "config/platform-context.json",
  "config/profile-limits.json",
  "config/public-data.json",
  "config/session-limits.json",
  "config/sessionstore.json",
  "config/shard-pacing.json",
  "config/social-rewards.json",
  "config/vocabulary.json",
];

/** [file, name] — the 24 misc `*Config` objects named in survey §1.5 (superset check). */
const MISC_CONFIG: Array<[string, string]> = [
  ["src/config/sessionStoreConfig.ts", "SessionStoreConfig"],
  ["src/config/platformContext.ts", "PlatformContextCacheLimits"],
  ["src/config/commercialDefaults.ts", "CommercialDefaults"],
  ["src/config/jobCatalogue.ts", "JobCatalogueFile"],
  ["src/config/jobCatalogue.ts", "JobCatalogueEntry"],
  ["src/config/jobCatalogue.ts", "JobCatalogueAgent"],
  ["src/config/tradingAgentConfig.ts", "TradingAgentConfig"],
  ["src/config/researchJobConfig.ts", "ResearchJobConfig"],
  ["src/config/brokerRegistry.ts", "BrokerRegistryEntry"],
  ["src/config/brokerRegistry.ts", "BrokerAssetAccountRegistry"],
  ["src/config/heartbeatWatchdog.ts", "HeartbeatWatchdogConfig"],
  // Issue #6503 step 13 removed the sibling `HeartbeatDueCheckConfig` row:
  // the renewal/retention due-hour checks are retired (the duties are
  // stored monthly schedules now), so the name no longer exists.
  ["src/config/lifecycleDefaults.ts", "LifecycleDefaults"],
  ["src/config/profileLimits.ts", "ProfileLimits"],
  ["src/config/sessionLimits.ts", "SessionLimits"],
  ["src/config/vocabulary.ts", "Vocabulary"],
  ["src/config/channelBrokers.ts", "ChannelBrokersConfig"],
  ["src/config/idpProfile.ts", "IdpProfileConfigShape"],
  ["src/config/orderCapabilities.ts", "OrderCapabilities"],
  ["src/config/shardPacing.ts", "ShardPacing"],
  ["src/config/sloThresholds.ts", "SloThresholds"],
  ["src/config/analyticsLakeConfig.ts", "AnalyticsLakeConfig"],
  ["src/config/opportunityHuntLevels.ts", "OpportunityHuntLevelConfig"],
  ["src/config/researchRules.ts", "ResearchRules"],
];

/** [file, const name] — the 3 client React contexts (consts, not types). */
const REACT_CONTEXTS: Array<[string, string]> = [
  ["src/client/components/ui/PageShell.tsx", "PageChromeContext"],
  ["src/client/components/ui/Toast.tsx", "ToastContext"],
  ["src/client/options/OptionsResearchPanel.tsx", "ChainContext"],
];

/** The counted non-`*Context*` identity name (survey §1.4). */
const PLATFORM_IDENTITY: [string, string] = [
  "src/services/platformIdentity.ts",
  "PlatformIdentity",
];

/** [file, name] — platform-provided receipt rows (3 types, 5 rows). */
const PLATFORM_PROVIDED: Array<[string, string, string]> = [
  ["src/server.ts", "Workers ExecutionContext", "async scheduled("],
  ["src/server.ts", "Workers ExecutionContext", "async queue("],
  ["src/server.ts", "Workers ExecutionContext", "async email("],
  ["src/security/sessionStore.ts", "DurableObjectState", "constructor(ctx: DurableObjectState, env: Env)"],
  ["src/agents/aiSearchAgent.ts", "DurableObjectState", "constructor(ctx: DurableObjectState, env: Env)"],
  ["src/agents/research-agent.ts", "DurableObjectState", "constructor(ctx: DurableObjectState, env: Env)"],
  ["src/agents/orchestrator.ts", "Agents-SDK AgentContext", 'from "agents"'],
];

/**
 * Strip `//` and `/* *\/` comments, preserving newlines and string contents.
 * A `//` inside a string (e.g. a URL) or a `/*` inside a `//` comment must
 * not start a comment — the naive regex strip gets this wrong (it once
 * swallowed a whole module after the text `evaluations/*` inside a `//` line), so
 * this is a char scanner, not a regex. Limitation, stated plainly: regex
 * literals containing `//` or `/*` are treated as code, and a `//` inside
 * a template `${...}` interpolation is treated as a comment; neither
 * shape occurs on a `*Context` definition line in this repo.
 */
function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  // Frames for template literals: { braceDepth } while inside ${ ... }.
  const interp: number[] = [];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "template" = "code";
  while (i < n) {
    const c = text[i];
    if (mode === "line") {
      if (c === "\n") {
        out.push(c);
        mode = "code";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "\n") out.push("\n");
      if (c === "*" && i + 1 < n && text[i + 1] === "/") {
        i += 2;
        mode = "code";
      } else {
        i += 1;
      }
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      const q = mode === "sq" ? "'" : '"';
      out.push(c);
      i += 1;
      if (c === "\\" && i < n) {
        out.push(text[i]);
        i += 1;
        continue;
      }
      if (c === q) mode = "code";
      continue;
    }
    if (mode === "template") {
      out.push(c);
      i += 1;
      if (c === "\\" && i < n) {
        out.push(text[i]);
        i += 1;
        continue;
      }
      if (c === "`") {
        mode = "code";
        continue;
      }
      if (c === "$" && i < n && text[i] === "{") {
        out.push(text[i]);
        i += 1;
        interp.push(0);
        mode = "code";
      }
      continue;
    }
    // mode === "code"
    if (c === "'" || c === '"') {
      mode = c === "'" ? "sq" : "dq";
      out.push(c);
      i += 1;
      continue;
    }
    if (c === "`") {
      mode = "template";
      out.push(c);
      i += 1;
      continue;
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "/") {
      mode = "line";
      i += 2;
      continue;
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "*") {
      mode = "block";
      i += 2;
      continue;
    }
    if (interp.length > 0) {
      if (c === "{") interp[interp.length - 1] += 1;
      else if (c === "}") {
        if (interp[interp.length - 1] === 0) {
          interp.pop();
          out.push(c);
          i += 1;
          mode = "template";
          continue;
        }
        interp[interp.length - 1] -= 1;
      }
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walk(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
}

const CONTEXT_DEF =
  /^\s*(export\s+)?(declare\s+)?(interface|type)\s+(\w*Context\w*)\b.*(\{|=|extends\b)/;

/** Measured `*Context` definitions: key `file\0name` -> definition-line count. */
function measure(dir: string): Map<string, number> {
  const files: string[] = [];
  walk(dir, files);
  const measured = new Map<string, number>();
  for (const file of files.sort()) {
    const text = stripComments(readFileSync(file, "utf-8"));
    for (const line of text.split("\n")) {
      const m = CONTEXT_DEF.exec(line);
      if (!m) continue;
      const key = `${file}\0${m[4]}`;
      measured.set(key, (measured.get(key) ?? 0) + 1);
    }
  }
  return measured;
}

function keyOf(file: string, name: string): string {
  return `${file}\0${name}`;
}

describe("universal context census (#6528 Phase 1)", () => {
  const measured = measure("src");
  const baselineKeys = new Set(BASELINE.map(([f, n]) => keyOf(f, n)));
  const excludedKeys = new Set(EXCLUDED.map(([f, n]) => keyOf(f, n)));
  const allowedKeys = new Set([...baselineKeys, ...excludedKeys]);

  it("the measurement actually ran (walk found the census population)", () => {
    expect(measured.size).toBeGreaterThan(150);
  });

  it("no *Context definition exists outside the baseline", () => {
    const offenders: string[] = [];
    for (const [key, count] of measured) {
      if (!allowedKeys.has(key)) {
        const [file, name] = key.split("\0");
        offenders.push(`${file} / ${name} (${count} definition${count === 1 ? "" : "s"})`);
      } else if (count > 1) {
        const [file, name] = key.split("\0");
        offenders.push(`${file} / ${name}: ${count} definitions sharing one file/name row`);
      }
    }
    expect(
      offenders,
      "new *Context definition(s) must reuse the existing context for the question, " +
        "or be recorded in the census with a disposition + reason in the same PR — see #6528 and " +
        "docs/architecture/survey/context-survey-rca-plan.md §0",
    ).toEqual([]);
  });

  it("the app-created context count only shrinks", () => {
    let countedPresent = 0;
    let aliasPresent = 0;
    let configNamedPresent = 0;
    for (const [file, name, , disposition] of BASELINE) {
      if (!measured.has(keyOf(file, name))) continue;
      countedPresent += 1;
      if (disposition === "ALIAS") aliasPresent += 1;
      if (disposition === "CONFIG-ENTRY") configNamedPresent += 1;
    }
    const [identityFile, identityName] = PLATFORM_IDENTITY;
    const identityPresent = readFileSync(identityFile, "utf-8").includes(identityName) ? 1 : 0;
    let reactPresent = 0;
    for (const [file, name] of REACT_CONTEXTS) {
      const text = readFileSync(file, "utf-8");
      if (text.includes(name) && text.includes("createContext")) reactPresent += 1;
    }
    const total =
      countedPresent -
      aliasPresent -
      configNamedPresent +
      identityPresent +
      RECORDED_CONFIG_TOTAL +
      reactPresent +
      RECORDED_UNITEMIZED_TIER_A;
    expect(
      total,
      `context count ${total} exceeds the baselined ${RECORDED_APP_CREATED_TOTAL} ` +
        `(counted *Context rows present ${countedPresent}, alias ${aliasPresent}, ` +
        `config-named ${configNamedPresent}, identity ${identityPresent}, ` +
        `config ${RECORDED_CONFIG_TOTAL}, react ${reactPresent}, ` +
        `unitemized Tier A ${RECORDED_UNITEMIZED_TIER_A}): retire a mirror or record the new ` +
        "definition in the census with a disposition + reason in the same PR — see #6528",
    ).toBeLessThanOrEqual(RECORDED_APP_CREATED_TOTAL);
  });

  it("no test-only *Context definition exists", () => {
    const testMeasured = measure("tests");
    const offenders = [...testMeasured.keys()].map((key) => {
      const [file, name] = key.split("\0");
      return `${file} / ${name}`;
    });
    expect(
      offenders,
      "test-only *Context definition(s): tests must import production types, not define " +
        "contexts — see #6528",
    ).toEqual([]);
  });

  it("the platform-provided section is intact (3 types)", () => {
    const missing: string[] = [];
    for (const [file, label, needle] of PLATFORM_PROVIDED) {
      if (!readFileSync(file, "utf-8").includes(needle)) {
        missing.push(`${file}: ${label} (${needle})`);
      }
    }
    expect(missing).toEqual([]);
    const types = new Set(PLATFORM_PROVIDED.map(([, label]) => label));
    expect(types.size).toBe(3);
  });

  it("the non-*Context* counted entries are present (config 70, misc 23, react 3, identity)", () => {
    const missing: string[] = [];
    for (const [file, name] of CONFIG_NAMES) {
      if (!readFileSync(file, "utf-8").includes(name)) missing.push(`${file}: ${name}`);
    }
    for (const file of MODES_FILES) {
      if (!existsSync(file)) missing.push(`${file}: *Modes file`);
    }
    expect(MODES_FILES.length).toBe(25);
    for (const file of CONFIG_JSON_FILES) {
      if (!existsSync(file)) missing.push(`${file}: config JSON`);
    }
    expect(CONFIG_JSON_FILES.length).toBe(19);
    const jsonOnDisk = readdirSync("config").filter((f) => f.endsWith(".json"));
    expect(jsonOnDisk.length).toBe(19);
    expect(existsSync("environment.config.json")).toBe(true);
    expect(existsSync("wrangler.jsonc")).toBe(true);
    for (const [file, name] of MISC_CONFIG) {
      if (!readFileSync(file, "utf-8").includes(name)) missing.push(`${file}: ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("the baseline is well-formed (unique file/name rows, known kinds/dispositions)", () => {
    const keys = BASELINE.map(([f, n]) => keyOf(f, n));
    expect(new Set(keys).size).toBe(keys.length);
    const exKeys = EXCLUDED.map(([f, n]) => keyOf(f, n));
    expect(new Set(exKeys).size).toBe(exKeys.length);
    expect(keys.filter((k) => excludedKeys.has(k))).toEqual([]);
    for (const [, , kind, disposition] of BASELINE) {
      expect(KINDS.has(kind), `unknown kind ${kind}`).toBe(true);
      expect(DISPOSITIONS.has(disposition), `unknown disposition ${disposition}`).toBe(true);
    }
    for (const [, , , reason] of EXCLUDED) {
      expect(reason.length).toBeGreaterThan(0);
    }
    expect(BASELINE.length).toBe(131);
    expect(EXCLUDED.length).toBe(45);
  });
});
