// @vitest-environment node
/**
 * #6528 Phase 1 (Config: census + pins) — the universal-resolver census pin.
 *
 * This pin re-runs the resolver measurement over `src/` and holds the
 * result SHRINK-ONLY against the baseline recorded below, seeded from
 * main at `e5541ff` (2026-11-25, Phase 1):
 *  - a `resolve*` definition that is NOT in the baseline fails;
 *  - a definition whose count in its file EXCEEDS its baseline count fails
 *    (overload-collapsed: `resolveOne` has 5 definitions in
 *    `src/config/otelModes.ts`, one per enclosing `resolveOtel*Settings`
 *    function — a 6th fails);
 *  - a new definition whose NAME already exists in the baseline at another
 *    file fails as a same-question duplicate;
 *  - the resolver definition total above its baselined 595 fails;
 *  - decreases and vanished rows pass — that is the shrink the programme
 *    wants, and retiring a duplicate means lowering or removing its
 *    baseline entry in the same PR.
 *
 * Adding or raising a baseline entry is a deliberate, reviewed act: it
 * requires the new row's census disposition and reason, stated in the PR
 * that does it.
 *
 * Counting rule (from
 * `docs/architecture/survey/resolvers-and-issues-survey.md` §1 + §4,
 * quoted):
 * > A **resolver** is a function named `resolve*`, a `create*Resolver`
 * > factory, or a `*Resolver` type/class/object, that turns raw inputs (env
 * > vars, config files, headers, ids, names, stored settings) into a
 * > resolved/validated value or object — i.e. it applies a **priority
 * > cascade, lookup, validation, or defaulting** and returns a typed result.
 * > Definitions were counted, not usages. Overload signatures were collapsed
 * > to one resolver.
 * >
 * > **Line drawn:** counted — a function that applies a fallback chain (env
 * > > file > builtin), validates against an allow-list, or maps a raw
 * > string/id to a typed object/enum with a default. **Not counted** — plain
 * > getters with no fallback/validation, pure string parsers, and generic
 * > DI-container `resolve(name)` methods.
 * >
 * > **Borderline, disclosed:** `const resolveX = deps.x ?? default`
 * > DI-fallback bindings — 3 of these in `src/observability/otelAlerting.ts`
 * > *are* in the count … while 4 same-shaped bindings are *not*. So the
 * > headline is **±4–6** depending on where you put that boundary.
 *
 * Seed numbers (re-derived on the PR base by exhaustive re-measurement
 * with the scanner in this file — the recount is
 * `~/workspace/6528-recount.md`; the seed reconciliation is
 * `docs/architecture/survey/6528-census-seed.md`):
 * - standalone `resolve*` functions / const arrows (+ 5 `create*Resolver`
 *   factories), overload-collapsed: 565 (557 survey rows, all present, +
 *   the 7 new #6482 schedule-firing resolvers, named in the census seed,
 *   + the 1 new #6540 universal resolver below).
 * - `resolve*` class methods (implementations): 18.
 * - `*Resolver` type/interface definitions: 9.
 * - `resolve*` interface method declarations (contracts only): 4 — NOT 3.
 *   The survey lists 3; this pin's exhaustive scan finds a 4th,
 *   `resolveTokenSet` (`src/data/tokenPorts.ts:220`, a method of the
 *   `EtradeTokenPort` interface, implemented anonymously in
 *   `src/data/tokenFamilyKvImpl.ts:188`), which the survey and the recount
 *   both missed (the recount verified the 3 listed, it did not scan for
 *   others). Total seeded: 565 + 18 + 9 + 4 = **596**, not the recount's
 *   594. Landing 594 would fail this pin on its first run, so the pin
 *   seeds the measured 595 and records the +1 here and in the census seed.
 * - Distinct questions: ≈306, recorded as a RANGE (285–320, central
 *   estimate — `copies-and-overlaps.md` §5: "an estimate, not a recount")
 *   and NEVER asserted exact. Implied copies at the seeded total: 275–310
 *   (595 − 320 … 595 − 285). The lossless check is that every definition
 *   maps to a question; per-row question keys are UNMAPPED at seed (the
 *   survey itemizes ≈190 of the long tail, not all 596) — the same-name
 *   duplicate check below is the name-as-question proxy until the #3786
 *   census maps every row.
 *
 * Phase 2 (#6540, 2026-11-25) raises the baseline 595 → 596 with ONE
 * row: `resolveUniversalContext` (`src/config/environment.ts`,
 * standalone, CANONICAL) — the one universal resolver, a NEW resolver
 * that calls `resolveEnvironmentConfig` (reuse first) rather than an
 * extension of it, so the old resolver's row is untouched and the
 * count grows by exactly one. Disposition: CANONICAL — it is the
 * survey's U-group resolver (`target-state-counts.md` §2.2, the
 * extended `resolveEnvironmentConfig`), the home the later phases
 * resolve against. No other row changes: the source helpers it uses
 * (`sourceOfEnvironmentName`, `sourceOfBrokerBaseUrl`) are not
 * `resolve*`-named and are internal to the universal-resolution
 * module, hence 0 separate resolvers by the §2.1 counting rule.
 *
 * Issue #6103 (2026-11-25) lowers the baseline 596 → 595 by removing
 * ONE row: `resolveLedgerReadMode` (`src/services/runLedgerReads.ts`)
 * — the resolver is deleted with the merged read path; there is one
 * D1-only read mode now, so the question it answered no longer exists.
 * No other row changes.
 *
 * Exclusions (recorded as data, not follow-up notes — #3786 Scope):
 * - Aliases (0 definitions): `resolveTradeEnvironmentFromSettings`
 *   (`brokerEnvironment.ts:105`), `resolveCanonicalWorkspacePath`
 *   (`routes/workspace.ts:28`).
 * - DI-fallback bindings NOT counted (4 same-shaped): `resolveIdentity`
 *   (`platformContext.ts:233`), `resolvePlatform`
 *   (`brokerChainSourceResidency.ts:104`), `resolveSymbols`
 *   (`meshOptionsStrategyDoor.ts:302`), `resolveUserLogin`
 *   (`screenerQueueConsumer.ts:44`) — while the 3 in
 *   `src/observability/otelAlerting.ts` ARE counted. A uniform
 *   re-adjudication moves the standalone total to 561 (all out) or 568
 *   (all in); this pin keeps the survey's boundary as seeded.
 * - Not functions: `resolveInput` (`mcpToolContext.ts:309`, a `const`
 *   holding the built input object), `resolveRoles` (`mcpToolContext.ts:330`,
 *   a `const` holding a call result).
 * - Generic `resolve()` methods (8, name exactly `resolve`) and
 *   Resolver-typed object-field implementations are excluded, as in the
 *   baseline.
 * - Tests-only resolvers (measured set below — the survey names 7; the
 *   exhaustive scan finds 15 rows / 14 keys, the extra 8 named in the
 *   census seed) and `scripts/` (`resolveBase`, a CI lint helper) are
 *   excluded from the production census.
 *
 * Hermeticity: the pin reads FILES only — never env, never the network,
 * never git. Scope is `src/` (`.ts`/`.tsx`); `tests/` and `scripts/` are
 * scanned separately against their own small baselines.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Kind = "standalone" | "class-method" | "resolver-type" | "interface-method";
type Disposition = "CANONICAL" | "DUPLICATE-NAME";

const KINDS: ReadonlySet<string> = new Set([
  "standalone",
  "class-method",
  "resolver-type",
  "interface-method",
]);
const DISPOSITIONS: ReadonlySet<string> = new Set(["CANONICAL", "DUPLICATE-NAME"]);

/** [file, name, kind, definition count, disposition] — shrink-only baseline. */
const BASELINE: Array<[string, string, Kind, number, Disposition]> = [
  ["src/a2a/resolution.ts", "resolveA2AAgent", "standalone", 1, "CANONICAL"],
  ["src/a2a/resolution.ts", "resolveA2AInstanceName", "standalone", 1, "CANONICAL"],
  ["src/actors/agentEmailRouting.ts", "createPortThinkEmailResolver", "standalone", 1, "CANONICAL"],
  ["src/actors/agentEmailRouting.ts", "resolveAgentEmailNamespace", "standalone", 1, "CANONICAL"],
  ["src/actors/agentEmailRouting.ts", "resolveEmailSecret", "standalone", 1, "CANONICAL"],
  ["src/actors/capabilityManifest.ts", "resolveAgentCapabilityManifest", "standalone", 1, "CANONICAL"],
  ["src/actors/thinkPortMapping.ts", "resolveThinkWebhookSecret", "standalone", 1, "CANONICAL"],
  ["src/actors/thinkPortMapping.ts", "resolveThinkWorkspacePath", "standalone", 1, "CANONICAL"],
  ["src/agentic/chainGovernance.ts", "resolveChainAuthority", "standalone", 1, "CANONICAL"],
  ["src/agentic/compositionMemory.ts", "resolveServeLeg", "standalone", 1, "CANONICAL"],
  ["src/agentic/compositionMemory.ts", "resolveStoredReportForServe", "standalone", 1, "CANONICAL"],
  ["src/agentic/unitDrivers.ts", "resolveUnitDriver", "standalone", 1, "CANONICAL"],
  ["src/agents/chatPrompt.ts", "resolveMasMaxSteps", "standalone", 1, "CANONICAL"],
  ["src/agents/chatPrompt.ts", "resolvePromptBrokerTools", "standalone", 1, "CANONICAL"],
  ["src/agents/chatPrompt.ts", "resolveShadowMaxSteps", "standalone", 1, "CANONICAL"],
  ["src/agents/copilotTradingMode.ts", "resolveCopilotTradingSelection", "standalone", 1, "CANONICAL"],
  ["src/agents/did.ts", "resolveAgentDidDocument", "standalone", 1, "CANONICAL"],
  ["src/agents/model.ts", "resolveAiModelName", "standalone", 1, "CANONICAL"],
  ["src/agents/nlqOptionsStrategy.ts", "resolveScopeSymbols", "standalone", 1, "CANONICAL"],
  ["src/agents/nlqOptionsStrategy.ts", "resolveStrategyProfile", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/orchestrator/asyncJobs.ts", "resolveAsyncJobMaxRuntimeMs", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/asyncJobs.ts", "resolveFeedDispatchJobId", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/asyncJobs.ts", "resolveFeedDispatchPipelineRunId", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/asyncJobs.ts", "resolveJobFailureCode", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/asyncJobs.ts", "resolveJobProvenance", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/asyncJobs.ts", "resolveSubmissionTenant", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/chatAwaitBudget.ts", "resolveChatAwaitDeadlineMs", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/chatAwaitBudget.ts", "resolveChatAwaitPollMs", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolveAnalyzeJobOrThrow", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolveDeliverJobOrThrow", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolveEnrichJobOrThrow", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolveFeedJobOrThrow", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolveGenerateJobOrThrow", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolvePipelineChainOrThrow", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshDoors.ts", "resolveStub", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshMcpClient.ts", "resolveStockCopilotMcpActivation", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "resolveRiskProfile", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "resolveThesis", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshStockCopilotDoor.ts", "resolveCopilotChatExecutionMode", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/meshStockCopilotDoor.ts", "resolveStockCopilotActiveBinding", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/scheduleMaintenance.ts", "resolveScheduledLogin", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/scheduledCallbacks.ts", "resolveCallbackDispatch", "standalone", 1, "CANONICAL"],
  ["src/agents/orchestrator/usageEventsReconcile.ts", "resolveBackfillTenant", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/adminTenantQueues.ts", "resolveCaller", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/adsRevenueReferrals.ts", "resolveAdsViewer", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/adsRevenueReferrals.ts", "resolveRouteMode", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/agenticPayments.ts", "resolveAgenticRouteMode", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/agenticPayments.ts", "resolveEmailTier", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/agenticPayments.ts", "resolvePrice", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/audit.ts", "resolveAuditAspects", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/brokerConnect.ts", "resolveEnvironmentFor", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/brokerConnect.ts", "resolveSide", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/brokerEnvironment.ts", "resolveBrokerEnvironment", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/brokerEnvironment.ts", "resolveBrokerEnvironmentDefault", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/brokerEnvironment.ts", "resolveBrokerEnvironmentFromSettings", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/brokerEnvironment.ts", "resolveSharedTradingEnvironment", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/dataLifecycle.ts", "resolveLoginsForTenant", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/dataLifecycle.ts", "resolveOperator", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/dataLifecycle.ts", "resolveStores", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/dataLifecycle.ts", "resolveWiredCaller", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/delegations.ts", "resolveDelegationCaller", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/etradeOptionsEvaluate.ts", "resolveEvaluateHostDispatch", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/kvWipe.ts", "resolveCaller", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/meter.ts", "createMeterTierResolver", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/orchestratorMigration.ts", "resolveAdmin", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/paymentAssuranceLive.ts", "resolveCheckoutPorts", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/payments.ts", "resolvePaymentsFlowMode", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/payments.ts", "resolvePaymentsRouteMode", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/platformAccounts.ts", "resolvePorts", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/platformChannels.ts", "resolveOperator", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/platformTenants.ts", "resolveOperator", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/platformUsers.ts", "resolveOperatorCaller", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/platformUsers.ts", "resolvePorts", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/premium.ts", "resolvePremiumRouteMode", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/premium.ts", "resolvePremiumTier", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/schedules.ts", "resolveFlagManagedBy", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/schedules.ts", "resolveScheduleFlagsCaller", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/schedules.ts", "resolveTrustedScheduleIdentity", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/screenerResearch.ts", "resolveResearchD1", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/screenerResearch.ts", "resolveResearchSql", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/serviceUser.ts", "resolveActingSession", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/serviceUser.ts", "resolveCaller", "standalone", 1, "DUPLICATE-NAME"],
  ["src/agents/routes/serviceUser.ts", "resolveServiceLoginForEtrade", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/serviceUser.ts", "resolveTokenServiceLogin", "standalone", 1, "CANONICAL"],
  ["src/agents/routes/serviceUser.ts", "resolveTokenStore", "standalone", 1, "CANONICAL"],
  ["src/agents/scheduled-agent.ts", "resolveReaderHalt", "standalone", 1, "CANONICAL"],
  ["src/agents/screenerAgentName.ts", "resolveScreenerAgentName", "standalone", 1, "CANONICAL"],
  ["src/agents/social/briefStore.ts", "resolveBriefDate", "standalone", 1, "CANONICAL"],
  ["src/agents/social/config.ts", "resolveChannelDisposition", "standalone", 1, "CANONICAL"],
  ["src/agents/social/delivery.ts", "resolveSocialSlackChannel", "standalone", 1, "CANONICAL"],
  ["src/agents/social/publisher.ts", "resolvePostUrl", "standalone", 1, "CANONICAL"],
  ["src/agents/social/publisher.ts", "resolvePublishTarget", "standalone", 1, "CANONICAL"],
  ["src/agents/social/publisher.ts", "resolveSubmissionEndpoint", "standalone", 1, "CANONICAL"],
  ["src/agents/ticker-agent.ts", "resolveTickerPushIntervalSeconds", "standalone", 1, "CANONICAL"],
  ["src/agents/ticker-agent.ts", "resolveTickerPushStaleAfterIntervals", "standalone", 1, "CANONICAL"],
  ["src/agents/trading-agent.ts", "resolveTradingPlatform", "standalone", 1, "CANONICAL"],
  ["src/aspects/errorCodes.ts", "resolveErrorAspect", "standalone", 1, "CANONICAL"],
  ["src/breakers/breakerPorts.ts", "resolveBreakerPolicyFor", "standalone", 1, "CANONICAL"],
  ["src/client/ScreenersHub.tsx", "resolveSelectedRun", "standalone", 1, "DUPLICATE-NAME"],
  ["src/client/StockHub.tsx", "resolveSelectedRun", "standalone", 1, "DUPLICATE-NAME"],
  ["src/client/options/strategyLibrary.ts", "resolveCatalogStrategyLabels", "standalone", 1, "CANONICAL"],
  ["src/client/pollingConfig.ts", "resolvePollingConfig", "standalone", 1, "CANONICAL"],
  ["src/client/pollingConfig.ts", "resolvePollingConfigFromEnv", "standalone", 1, "CANONICAL"],
  ["src/client/quotes/symbolSetResolver.ts", "resolveTapeSymbols", "standalone", 1, "CANONICAL"],
  ["src/client/routes.ts", "resolveRouteId", "standalone", 1, "CANONICAL"],
  ["src/client/screeningAdapters.ts", "resolveInitialScreeningProviderId", "standalone", 1, "CANONICAL"],
  ["src/config/adsRevenueModes.ts", "resolveAdsRevenueMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolveAgenticWalletMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolvePaymentsConfirmMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolvePaymentsCreateMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolvePaymentsSwitchByKey", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolvePaymentsTransactionsMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolvePremiumResearchMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolvePremiumScreenerMode", "standalone", 1, "CANONICAL"],
  ["src/config/agenticPaymentsModes.ts", "resolveSwitch", "standalone", 1, "DUPLICATE-NAME"],
  ["src/config/analyticsLakeConfig.ts", "resolveAnalyticsLakeConfig", "standalone", 1, "CANONICAL"],
  ["src/config/apiIngressModes.ts", "resolveApiIngressMode", "standalone", 1, "CANONICAL"],
  ["src/config/asyncJobModes.ts", "resolveHttpDeliveryMode", "standalone", 1, "CANONICAL"],
  ["src/config/asyncJobModes.ts", "resolveJobListEnvelope", "standalone", 1, "CANONICAL"],
  ["src/config/chatNlqModes.ts", "resolveChatNlqMode", "standalone", 1, "CANONICAL"],
  ["src/config/chatNlqModes.ts", "resolveChatNlqTurnMode", "standalone", 1, "CANONICAL"],
  ["src/config/dlqDepthAlert.ts", "resolveDlqDepthAlertThreshold", "standalone", 1, "CANONICAL"],
  ["src/config/environment.ts", "resolveETradeBaseUrl", "standalone", 1, "CANONICAL"],
  ["src/config/environment.ts", "resolveEnvironmentConfig", "standalone", 1, "CANONICAL"],
  ["src/config/environment.ts", "resolveUniversalContext", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradeDiscoveryMode", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradePositionsMode", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradePreviewMode", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradeQuoteMode", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradeRestSwitch", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradeScanMode", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveEtradeStatusMode", "standalone", 1, "CANONICAL"],
  ["src/config/etradeModes.ts", "resolveSwitch", "standalone", 1, "DUPLICATE-NAME"],
  ["src/config/goalChainModes.ts", "resolveGoalCompileMode", "standalone", 1, "CANONICAL"],
  ["src/config/goalChainModes.ts", "resolveSwitch", "standalone", 1, "DUPLICATE-NAME"],
  ["src/config/heartbeatWatchdog.ts", "resolveDueHourUtc", "standalone", 1, "CANONICAL"],
  ["src/config/heartbeatWatchdog.ts", "resolveHeartbeatDueCheckConfig", "standalone", 1, "CANONICAL"],
  ["src/config/heartbeatWatchdog.ts", "resolveHeartbeatIntervalSeconds", "standalone", 1, "CANONICAL"],
  ["src/config/heartbeatWatchdog.ts", "resolveHeartbeatRenewalDueHourUtc", "standalone", 1, "CANONICAL"],
  ["src/config/heartbeatWatchdog.ts", "resolveHeartbeatRetentionDueHourUtc", "standalone", 1, "CANONICAL"],
  ["src/config/heartbeatWatchdog.ts", "resolveHeartbeatWatchdogConfig", "standalone", 1, "CANONICAL"],
  ["src/config/heartbeatWatchdog.ts", "resolveHeartbeatWatchdogStaleAfterMs", "standalone", 1, "CANONICAL"],
  ["src/config/ibkr.ts", "resolveIbkrMcpUrl", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionCatalog.ts", "resolveJobDefinitionSpec", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionCatalog.ts", "resolveNumberField", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionCatalog.ts", "resolveParameter", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionCatalog.ts", "resolveSpecAxes", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionCatalog.ts", "resolveStage", "standalone", 1, "DUPLICATE-NAME"],
  ["src/config/jobDefinitionCatalog.ts", "resolveStageSchedule", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionParamRegistry.ts", "resolveEnumSource", "standalone", 1, "CANONICAL"],
  ["src/config/jobDefinitionParamRegistry.ts", "resolveParamDerivation", "standalone", 1, "CANONICAL"],
  ["src/config/knowledgeMemoryModes.ts", "resolveKnowledgeMode", "standalone", 1, "CANONICAL"],
  ["src/config/knowledgeMemoryModes.ts", "resolveMemoryReadMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveAlpacaOrderMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveAlpacaReadsMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveMarketDataBarsMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveMarketDataFundamentalsMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveMarketDataQuoteMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveMarketDataResearchMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveMarketDataRestSwitch", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveMarketDataSnapshotMode", "standalone", 1, "CANONICAL"],
  ["src/config/marketDataModes.ts", "resolveSwitch", "standalone", 1, "DUPLICATE-NAME"],
  ["src/config/missedScheduleAlert.ts", "resolveMissedScheduleGraceMs", "standalone", 1, "CANONICAL"],
  ["src/config/nlqModes.ts", "resolveNlqMode", "standalone", 1, "CANONICAL"],
  ["src/config/orderCapabilities.ts", "resolveOrderType", "standalone", 1, "CANONICAL"],
  ["src/config/orderCapabilities.ts", "resolveTimeInForce", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOne", "standalone", 5, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelAlertingSettings", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelArchiveSettings", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelBackendSettings", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelDestinationEnabled", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelDomainEnabled", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelDomainLevel", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelDomainSampling", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelMaster", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelMetricsSettings", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelSignalExporter", "standalone", 1, "CANONICAL"],
  ["src/config/otelModes.ts", "resolveOtelTracesSettings", "standalone", 1, "CANONICAL"],
  ["src/config/paymentsFlowModes.ts", "resolvePaymentsFlowModeScoped", "standalone", 1, "CANONICAL"],
  ["src/config/privacyModes.ts", "resolvePrivacyModeScoped", "standalone", 1, "CANONICAL"],
  ["src/config/publicData.ts", "resolvePublicBarsRequest", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteAlpacaKeyMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteEtradeUnknownMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteExpiryMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteFallbackMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteHttpProviderMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteStreamProvenance", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteYahooIndicatorsMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveQuoteYahooOpenMode", "standalone", 1, "CANONICAL"],
  ["src/config/quoteModes.ts", "resolveSwitch", "standalone", 1, "DUPLICATE-NAME"],
  ["src/config/researchJobConfig.ts", "resolveResearchJobConfig", "standalone", 1, "CANONICAL"],
  ["src/config/researchJobConfig.ts", "resolveResearchSettlementWaitMs", "standalone", 1, "CANONICAL"],
  ["src/config/researchJobConfig.ts", "resolveResearchStageModes", "standalone", 1, "CANONICAL"],
  ["src/config/researchJobConfig.ts", "resolveResearchStageRetryBuckets", "standalone", 1, "CANONICAL"],
  ["src/config/researchJobConfig.ts", "resolveResearchStageTimeouts", "standalone", 1, "CANONICAL"],
  ["src/config/researchRules.ts", "resolveResearchRules", "standalone", 1, "CANONICAL"],
  ["src/config/restTwinsModes.ts", "resolveAuditWriteMode", "standalone", 1, "CANONICAL"],
  ["src/config/restTwinsModes.ts", "resolveAuditWriteRestSwitch", "standalone", 1, "CANONICAL"],
  ["src/config/restTwinsModes.ts", "resolveSnapIdentity", "standalone", 1, "CANONICAL"],
  ["src/config/runLedgerModes.ts", "resolveRunLedgerDefaultFilter", "standalone", 1, "CANONICAL"],
  ["src/config/runLedgerModes.ts", "resolveRunLedgerFilters", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleFiringKillSwitch.ts", "resolveScheduleFiringEnabled", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleFiringRateAlert.ts", "resolveScheduleFiringRateAlertThreshold", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleFiringRateAlert.ts", "resolveScheduleFiringRateAlertWindowMinutes", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleFrequencyFloor.ts", "resolveScheduleMinIntervalSeconds", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleListModes.ts", "resolveScheduleListDefaultFilter", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleListModes.ts", "resolveScheduleListFilters", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleListModes.ts", "resolveScheduleListStatusFilters", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleRowModes.ts", "resolveScheduleRowColumns", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSections.ts", "resolveGoalScheduleDefaultSection", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSections.ts", "resolveGoalScheduleSections", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSections.ts", "resolveQueueScheduleDefaultSection", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSections.ts", "resolveQueueScheduleSections", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSections.ts", "resolveSectionDefault", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSections.ts", "resolveSections", "standalone", 1, "CANONICAL"],
  ["src/config/scheduleSourceModes.ts", "resolveScheduleSourceFilters", "standalone", 1, "CANONICAL"],
  ["src/config/scheduledJobAlert.ts", "resolveScheduledJobAlertThreshold", "standalone", 1, "CANONICAL"],
  ["src/config/schemaMigrationModes.ts", "resolveSchemaMigrationMode", "standalone", 1, "CANONICAL"],
  ["src/config/schemaMigrationModes.ts", "resolveSchemaMigrationModeFromEnv", "standalone", 1, "CANONICAL"],
  ["src/config/screenerExecutionMode.ts", "resolveScreenerDefaultExecutionMode", "standalone", 1, "CANONICAL"],
  ["src/config/screenerModes.ts", "resolveScreenerNdGate", "standalone", 1, "CANONICAL"],
  ["src/config/screenerModes.ts", "resolveScreenerNdGateForHost", "standalone", 1, "CANONICAL"],
  ["src/config/screenerModes.ts", "resolveScreenerNdGateFromEnv", "standalone", 1, "CANONICAL"],
  ["src/config/screenerModes.ts", "resolveScreenerNdGateResolved", "standalone", 1, "CANONICAL"],
  ["src/config/sessionLimits.ts", "resolveIdleTimeoutMs", "standalone", 1, "CANONICAL"],
  ["src/config/sessionStoreConfig.ts", "resolvePositiveInteger", "standalone", 1, "CANONICAL"],
  ["src/config/sessionStoreConfig.ts", "resolveSessionStoreConfig", "standalone", 1, "CANONICAL"],
  ["src/config/shardPacing.ts", "resolveShardPacing", "standalone", 1, "CANONICAL"],
  ["src/config/sloThresholds.ts", "resolveSloThresholds", "standalone", 1, "CANONICAL"],
  ["src/config/stuckRunAlert.ts", "resolveStuckRunAlertThresholdMs", "standalone", 1, "CANONICAL"],
  ["src/config/turnStepTimeout.ts", "resolveTurnStepTimeoutMs", "standalone", 1, "CANONICAL"],
  ["src/config/vocabulary.ts", "resolveJobSubset", "standalone", 1, "CANONICAL"],
  ["src/config/vocabulary.ts", "resolveProviderDataset", "standalone", 1, "CANONICAL"],
  ["src/config/vocabulary.ts", "resolveValue", "standalone", 1, "CANONICAL"],
  ["src/config/workflowRunsStageRead.ts", "resolveWorkflowRunsStageReadLimit", "standalone", 1, "CANONICAL"],
  ["src/data/auditPolicyPorts.ts", "resolveAuditPolicy", "standalone", 1, "CANONICAL"],
  ["src/data/commercialPorts.ts", "resolveUnlimitedFreeGrantUpdate", "standalone", 1, "CANONICAL"],
  ["src/data/d1QueryLogger.ts", "resolveD1QueryLoggerPolicy", "standalone", 1, "CANONICAL"],
  ["src/data/d1RetryPolicy.ts", "resolveD1RetryPolicy", "standalone", 1, "CANONICAL"],
  ["src/data/doSqliteJobOutcomeAdapter.ts", "resolveDays", "standalone", 1, "DUPLICATE-NAME"],
  ["src/data/doSqliteRunRegistryAdapter.ts", "resolveId", "class-method", 1, "DUPLICATE-NAME"],
  ["src/data/feedDatasetPorts.ts", "resolveFeedQuotesFromArtifact", "standalone", 1, "CANONICAL"],
  ["src/data/feedSnapshotPorts.ts", "resolveFeedSnapshotForSymbol", "standalone", 1, "CANONICAL"],
  ["src/data/inMemoryJobOutcomeAdapter.ts", "resolveDays", "standalone", 1, "DUPLICATE-NAME"],
  ["src/data/inMemoryRunRegistryAdapter.ts", "resolveId", "class-method", 1, "DUPLICATE-NAME"],
  ["src/data/productAccess.ts", "resolveProductAccess", "standalone", 1, "CANONICAL"],
  ["src/data/productAccess.ts", "resolveStockScreeningPrimary", "standalone", 1, "CANONICAL"],
  ["src/data/productCatalogue.ts", "resolveProductPrice", "standalone", 1, "CANONICAL"],
  ["src/data/productPorts.ts", "resolveEffectiveVersion", "standalone", 1, "CANONICAL"],
  ["src/data/providerCapturePorts.ts", "resolveCaptureUserLogin", "standalone", 1, "CANONICAL"],
  ["src/data/providerCapturePorts.ts", "resolveRunContext", "standalone", 1, "CANONICAL"],
  ["src/data/refundPorts.ts", "RefundPaymentSourceResolver", "resolver-type", 1, "CANONICAL"],
  ["src/data/retention1766.ts", "resolveOrphanSweepDelete", "standalone", 1, "CANONICAL"],
  ["src/data/retention1766.ts", "resolveSnapshotEnabled", "standalone", 1, "CANONICAL"],
  ["src/data/runLedgerProjection.ts", "resolveLinkedJobRunId", "standalone", 1, "CANONICAL"],
  ["src/data/runLedgerProjection.ts", "resolveReportLink", "standalone", 1, "CANONICAL"],
  ["src/data/runRegistryPorts.ts", "resolveId", "interface-method", 1, "DUPLICATE-NAME"],
  ["src/data/scanRunPorts.ts", "resolveScanBackfillLinkage", "standalone", 1, "CANONICAL"],
  ["src/data/schemaComponent/executor.ts", "resolveStatementText", "standalone", 1, "CANONICAL"],
  ["src/data/schemaComponent/recreateRunner.ts", "resolveRecreatePlan", "standalone", 1, "CANONICAL"],
  ["src/data/socialRewardModel.ts", "resolveFreeMonthEligibility", "standalone", 1, "CANONICAL"],
  ["src/data/socialRewardModel.ts", "resolveRunCoverage", "standalone", 1, "CANONICAL"],
  ["src/data/socialRewardModel.ts", "resolveSocialRewardAvailability", "standalone", 1, "CANONICAL"],
  ["src/data/subscriptionPorts.ts", "resolveEffectiveTier", "standalone", 1, "CANONICAL"],
  ["src/data/subscriptionPorts.ts", "resolveTierTransition", "standalone", 1, "CANONICAL"],
  ["src/data/tokenFamilyKvImpl.ts", "resolveTokenSet", "standalone", 1, "DUPLICATE-NAME"],
  ["src/data/tokenPorts.ts", "resolveTokenSet", "interface-method", 1, "DUPLICATE-NAME"],
  ["src/enrichment/enrichmentPorts.ts", "resolveEnrichmentSelection", "standalone", 1, "CANONICAL"],
  ["src/enrichment/enrichmentPorts.ts", "resolveMinuteTimeframe", "standalone", 1, "CANONICAL"],
  ["src/events/screenerPublishers.ts", "resolveAndVerifyPublisherEmailTo", "standalone", 1, "CANONICAL"],
  ["src/events/screenerPublishers.ts", "resolveAndVerifyPublisherSlackChannel", "standalone", 1, "CANONICAL"],
  ["src/events/screenerPublishers.ts", "resolveAndVerifyPublisherWebhookUrl", "standalone", 1, "CANONICAL"],
  ["src/features/scheduleChannelFlags.ts", "resolveScheduleChannelFlagsView", "standalone", 1, "CANONICAL"],
  ["src/features/scheduleChannelFlags.ts", "resolveScheduleChannelState", "standalone", 1, "CANONICAL"],
  ["src/gateway/gatewayConfig.ts", "resolveGatewayConfig", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/agenticPaymentCommands.ts", "resolveAgenticPaymentsCommandMode", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/bizCopilotTenantCommands.ts", "resolveAxisValue", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/brokerOrderCommands.ts", "resolveRequestedEnv", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/cancelOrderCommands.ts", "resolveSelectedAlpacaPlatform", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/commands.ts", "resolveCommandMode", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/commands.ts", "resolveJobListEnvelopeForTool", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/commands.ts", "resolveKnowledgeForTool", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/commands.ts", "resolveMemoryReadForList", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/commands.ts", "resolveNlqCommandMode", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/commands.ts", "resolvePaymentsCommandMode", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/mcpPermissionPorts.ts", "McpRoleResolver", "resolver-type", 1, "CANONICAL"],
  ["src/mcps/openaimp/mcpPermissionPorts.ts", "resolveMcpPrincipalFromHeaders", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/mcpPermissionPorts.ts", "resolveScopesWithRoleAdapter", "standalone", 1, "CANONICAL"],
  ["src/mcps/openaimp/mcpPermissionPorts.ts", "resolveToolScope", "standalone", 1, "CANONICAL"],
  ["src/observability/otelAlerting.ts", "resolveEmailSender", "standalone", 1, "CANONICAL"],
  ["src/observability/otelAlerting.ts", "resolveLogger", "standalone", 1, "CANONICAL"],
  ["src/observability/otelAlerting.ts", "resolveSlackPost", "standalone", 1, "CANONICAL"],
  ["src/observability/otelBackend.ts", "resolveOtelBackendCredentials", "standalone", 1, "CANONICAL"],
  ["src/observability/otelJobPipelineObservers.ts", "resolveJobPipelineControlObservers", "standalone", 1, "CANONICAL"],
  ["src/observability/otelMessages.ts", "resolveAlertRule", "standalone", 1, "CANONICAL"],
  ["src/observability/otelMessages.ts", "resolveCatalogMessage", "standalone", 1, "CANONICAL"],
  ["src/observability/otelMessages.ts", "resolveCatalogSeverity", "standalone", 1, "CANONICAL"],
  ["src/observability/otelMetricsProvider.ts", "resolveOtelMetricsConfig", "standalone", 1, "CANONICAL"],
  ["src/observability/otelProvider.ts", "resolveOtelLoggingConfig", "standalone", 1, "CANONICAL"],
  ["src/observability/otelTracesProvider.ts", "resolveOtelTracesConfig", "standalone", 1, "CANONICAL"],
  ["src/observability/tenantObservabilityView.ts", "resolveRecordKind", "standalone", 1, "CANONICAL"],
  ["src/orchestrations/socialDigestFeed.ts", "resolveSocialFeedSource", "standalone", 1, "CANONICAL"],
  ["src/outcomes/outcomeAspects.ts", "resolveOutcome", "standalone", 1, "CANONICAL"],
  ["src/outcomes/outcomeAspects.ts", "resolveRunDetailMessage", "standalone", 1, "DUPLICATE-NAME"],
  ["src/patterns/paymentStrategies.ts", "resolveApiKey", "class-method", 1, "CANONICAL"],
  ["src/payments/draftOwners.ts", "resolveDraftOwner", "standalone", 1, "CANONICAL"],
  ["src/privacy/privacyDsar.ts", "resolvePrivacyDsarMode", "standalone", 1, "CANONICAL"],
  ["src/retrieval/d1MarketGraphAdapter.ts", "resolveSymbols", "class-method", 1, "DUPLICATE-NAME"],
  ["src/retrieval/inMemoryMarketGraphAdapter.ts", "resolveSymbols", "class-method", 1, "DUPLICATE-NAME"],
  ["src/retrieval/retrievalPorts.ts", "resolveSymbols", "interface-method", 1, "DUPLICATE-NAME"],
  ["src/security/agentAccess.ts", "resolveAgentAccessMode", "standalone", 1, "CANONICAL"],
  ["src/security/attributionEnvelope.ts", "resolveAttributionEnvelope", "standalone", 1, "CANONICAL"],
  ["src/security/attributionEnvelope.ts", "resolvePlatformId", "standalone", 1, "CANONICAL"],
  ["src/security/backgroundAttribution.ts", "resolveActorAttribution", "standalone", 1, "CANONICAL"],
  ["src/security/commercialExecutionContext.ts", "resolveLedgerWriteContext", "standalone", 1, "CANONICAL"],
  ["src/security/commercialExecutionContext.ts", "resolveLedgerWriteContextHeader", "standalone", 1, "CANONICAL"],
  ["src/security/etradeOAuth.ts", "resolveAliasLogin", "standalone", 1, "CANONICAL"],
  ["src/security/executionContext.ts", "resolveExecutionContext", "standalone", 1, "CANONICAL"],
  ["src/security/grantProposals.ts", "resolveAdminGrantProposal", "standalone", 1, "CANONICAL"],
  ["src/security/grantRules.ts", "resolveGrantDefaultExpiryDays", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaBootstrap.ts", "resolveBootstrapEntries", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaEnforcement.ts", "resolveWiredFreshnessMs", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaGithubEndToEnd.ts", "resolveEntryUserId", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaGithubEndToEnd.ts", "resolveIaaaTenant", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaLifecycleWiring.ts", "resolveOffboardSessions", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaLoggedInUsers.ts", "ProviderResolver", "resolver-type", 1, "CANONICAL"],
  ["src/security/iaaaLogin.ts", "resolveGithubBinding", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaLogin.ts", "resolveProviderBinding", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaLoginKey.ts", "ProviderIssuerResolver", "resolver-type", 1, "CANONICAL"],
  ["src/security/iaaaMembershipStore.ts", "resolveMembershipIndexRepairMode", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaMigration.ts", "resolveDoNameForUser", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaMigration.ts", "resolveDoNameInput", "standalone", 1, "CANONICAL"],
  ["src/security/iaaaStaleCleanup.ts", "resolveStaleCleanupMode", "standalone", 1, "CANONICAL"],
  ["src/security/identityBinding.ts", "resolveOrCreateBinding", "standalone", 1, "CANONICAL"],
  ["src/security/identityDisplay.ts", "resolveLogins", "standalone", 1, "CANONICAL"],
  ["src/security/oidcProvider.ts", "resolveClientSecret", "standalone", 1, "CANONICAL"],
  ["src/security/outboundRateLimiter.ts", "resolveOutboundRateLimitConfig", "standalone", 1, "CANONICAL"],
  ["src/security/payerWalletIdentity.ts", "WalletLoginResolver", "resolver-type", 1, "CANONICAL"],
  ["src/security/payerWalletIdentity.ts", "resolvePayerWalletIdentity", "standalone", 1, "CANONICAL"],
  ["src/security/pdpPorts.ts", "resolvePdpPolicySource", "standalone", 1, "CANONICAL"],
  ["src/security/platformContext.ts", "resolveBrokerFacts", "standalone", 1, "CANONICAL"],
  ["src/security/platformContext.ts", "resolveIdentityFacts", "standalone", 1, "CANONICAL"],
  ["src/security/platformContext.ts", "resolvePlatformContext", "standalone", 1, "CANONICAL"],
  ["src/security/providers.ts", "resolveLoginProvider", "standalone", 1, "CANONICAL"],
  ["src/security/publicOAuth.ts", "resolvePublicCredentialRef", "standalone", 1, "CANONICAL"],
  ["src/security/serviceDispatch.ts", "resolveAsyncJobIdentity", "standalone", 1, "CANONICAL"],
  ["src/security/serviceDispatch.ts", "resolveDispatchCandidate", "standalone", 1, "CANONICAL"],
  ["src/security/sessionCap.ts", "resolveSessionCap", "standalone", 1, "CANONICAL"],
  ["src/security/storageRetention.ts", "resolveRetentionDays", "standalone", 1, "CANONICAL"],
  ["src/security/storageRetention.ts", "resolveRetentionWindowDays", "standalone", 1, "CANONICAL"],
  ["src/security/storeOperatorGate.ts", "resolveStoreOperatorAccess", "standalone", 1, "CANONICAL"],
  ["src/security/tenantQueueMapping.ts", "resolveTenantLogins", "standalone", 1, "CANONICAL"],
  ["src/security/userRequestQuota.ts", "resolveUserRequestQuota", "standalone", 1, "CANONICAL"],
  ["src/security/webhookReplay.ts", "resolveScheduleWebhookIdempotencyTtlMs", "standalone", 1, "CANONICAL"],
  ["src/server/routes/auth.ts", "resolveCurrentList", "standalone", 1, "CANONICAL"],
  ["src/server/routes/nav.ts", "resolveNavCaller", "standalone", 1, "CANONICAL"],
  ["src/server/routes/otelSlo.ts", "resolveReadThresholds", "standalone", 1, "CANONICAL"],
  ["src/services/accountBindings.ts", "resolveExecutionAccountContext", "standalone", 1, "CANONICAL"],
  ["src/services/accountBindings.ts", "resolveExecutionAccountTuple", "standalone", 1, "CANONICAL"],
  ["src/services/accountBindings.ts", "resolveScheduleBindingDefaults", "standalone", 1, "CANONICAL"],
  ["src/services/accountBindings.ts", "resolveUserAccountBinding", "standalone", 1, "CANONICAL"],
  ["src/services/accountBindings.ts", "resolveValidatedExecutionAccountContext", "standalone", 1, "CANONICAL"],
  ["src/services/accountTenant.ts", "resolveAccountTenantId", "standalone", 1, "CANONICAL"],
  ["src/services/adsTier.ts", "resolveAdsTier", "standalone", 1, "CANONICAL"],
  ["src/services/adsTier.ts", "resolveServerAdsConfig", "standalone", 1, "CANONICAL"],
  ["src/services/agentConfigResolver.ts", "resolveAgentConfig", "standalone", 1, "CANONICAL"],
  ["src/services/agentScheduleCapability.ts", "resolveAgentScheduleTenant", "standalone", 1, "CANONICAL"],
  ["src/services/agentScheduleCapability.ts", "resolvePendingScheduleApproval", "standalone", 1, "CANONICAL"],
  ["src/services/agentScheduleCapability.ts", "resolveStage", "interface-method", 1, "DUPLICATE-NAME"],
  ["src/services/aiSearchCache.ts", "resolveAiSearchCacheConfig", "standalone", 1, "CANONICAL"],
  ["src/services/analyzeJobs.ts", "resolveAnalyzeThresholds", "standalone", 1, "CANONICAL"],
  ["src/services/analyzeJobs.ts", "resolveMinutesKnob", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/analyzeJobs.ts", "resolveRuleSetsKnob", "standalone", 1, "CANONICAL"],
  ["src/services/analyzeJobs.ts", "resolveScreenerHandOff", "standalone", 1, "CANONICAL"],
  ["src/services/analyzePipelineJobs.ts", "resolveAnalyzeJob", "standalone", 1, "CANONICAL"],
  ["src/services/analyzePipelineJobs.ts", "resolveAnalyzeStepJob", "standalone", 1, "CANONICAL"],
  ["src/services/autopilotVerdictTrend.ts", "resolveAutopilotVerdictTrendPolicy", "standalone", 1, "CANONICAL"],
  ["src/services/autopilotVerdictTrend.ts", "resolveBool", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/autopilotVerdictTrend.ts", "resolvePositiveInt", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/betaService.ts", "resolveUncached", "class-method", 1, "CANONICAL"],
  ["src/services/bracketLadder.ts", "resolveLadderExitDeltas", "standalone", 1, "CANONICAL"],
  ["src/services/chainPipelineJobs.ts", "resolvePipelineChain", "standalone", 1, "CANONICAL"],
  ["src/services/championChallenger.ts", "resolveChallengerOutcome", "standalone", 1, "CANONICAL"],
  ["src/services/channelRecipientVerification.ts", "resolveAndVerifySlackRecipientAtDelivery", "standalone", 1, "CANONICAL"],
  ["src/services/channelRecipientVerification.ts", "resolveAndVerifyWebhookRecipientAtDelivery", "standalone", 1, "CANONICAL"],
  ["src/services/channelRecipientVerification.ts", "resolveEnvChannelRecipientBinding", "standalone", 1, "CANONICAL"],
  ["src/services/channelRecipientVerification.ts", "resolveTenantOwnerEmailBinding", "standalone", 1, "CANONICAL"],
  ["src/services/checkoutDisplay.ts", "resolveBrowserPaymentScope", "standalone", 1, "CANONICAL"],
  ["src/services/checkoutPortGuard.ts", "resolveCheckoutPortTimeoutMs", "standalone", 1, "CANONICAL"],
  ["src/services/comparisonHostDispatch.ts", "resolveComparisonHostDispatch", "standalone", 1, "CANONICAL"],
  ["src/services/consolidatedCronEntries.ts", "resolveCronEntryPoint", "standalone", 1, "CANONICAL"],
  ["src/services/consolidatedScheduling.ts", "resolveLedgerTrigger", "standalone", 1, "CANONICAL"],
  ["src/services/consolidatedScheduling.ts", "resolveLifecycleAction", "standalone", 1, "CANONICAL"],
  ["src/services/consolidatedScheduling.ts", "resolveTimingForm", "standalone", 1, "CANONICAL"],
  ["src/services/copilotChannels.ts", "resolveCopilotChannel", "standalone", 1, "CANONICAL"],
  ["src/services/copilotChannels.ts", "resolveCopilotChannels", "standalone", 1, "CANONICAL"],
  ["src/services/copilotVoiceBackend.ts", "resolveCopilotVoiceBackend", "standalone", 1, "CANONICAL"],
  ["src/services/copilotVoiceBackend.ts", "resolveVoiceBackend", "standalone", 1, "CANONICAL"],
  ["src/services/deliverJobs.ts", "resolveChannelsKnob", "standalone", 1, "CANONICAL"],
  ["src/services/deliverJobs.ts", "resolveMinutesKnob", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/deliverJobs.ts", "resolveStringKnob", "standalone", 1, "CANONICAL"],
  ["src/services/deliverPipelineJobs.ts", "resolveDeliverJob", "standalone", 1, "CANONICAL"],
  ["src/services/enrichJobs.ts", "resolveElementsKnob", "standalone", 1, "CANONICAL"],
  ["src/services/enrichJobs.ts", "resolveFeedInputArtifact", "standalone", 1, "CANONICAL"],
  ["src/services/enrichJobs.ts", "resolveFundamentalsJoinMode", "standalone", 1, "CANONICAL"],
  ["src/services/enrichJobs.ts", "resolveMinutesKnob", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/enrichJobs.ts", "resolveSentimentJoinMode", "standalone", 1, "CANONICAL"],
  ["src/services/enrichJobs.ts", "resolveTechnicalsJoinMode", "standalone", 1, "CANONICAL"],
  ["src/services/enrichPipelineJobs.ts", "resolveEnrichHandOffInput", "standalone", 1, "CANONICAL"],
  ["src/services/enrichPipelineJobs.ts", "resolveEnrichJob", "standalone", 1, "CANONICAL"],
  ["src/services/etradeExecutionGate.ts", "resolveEtradeAuthorizerDid", "standalone", 1, "CANONICAL"],
  ["src/services/feedJobTimeouts.ts", "resolveFeedJobTimeoutMs", "standalone", 1, "CANONICAL"],
  ["src/services/feedJobTimeouts.ts", "resolveFeedJobTimeouts", "standalone", 1, "CANONICAL"],
  ["src/services/feedJobs.ts", "resolveFeedJobCadenceMinutes", "standalone", 1, "CANONICAL"],
  ["src/services/feedJobs.ts", "resolveFeedJobStaleMinutes", "standalone", 1, "CANONICAL"],
  ["src/services/feedJobs.ts", "resolveMinutesKnob", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/feedJobs.ts", "resolveRunUniverse", "standalone", 1, "CANONICAL"],
  ["src/services/feedJobs.ts", "resolveUniverseListWithHydration", "standalone", 1, "CANONICAL"],
  ["src/services/feedPipelineJobs.ts", "resolveFeedJob", "standalone", 1, "CANONICAL"],
  ["src/services/feedPipelineJobs.ts", "resolveUniverseIndex", "standalone", 1, "CANONICAL"],
  ["src/services/generateJobs.ts", "resolveListKnob", "standalone", 1, "CANONICAL"],
  ["src/services/generateJobs.ts", "resolveMinutesKnob", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/generateJobs.ts", "resolveOwnerLoginKnob", "standalone", 1, "CANONICAL"],
  ["src/services/generatePipelineJobs.ts", "resolveGenerateJob", "standalone", 1, "CANONICAL"],
  ["src/services/goalLegHostDispatch.ts", "resolveGoalLegHostDispatch", "standalone", 1, "CANONICAL"],
  ["src/services/hedgeProposals.ts", "resolveSpyPutContract", "standalone", 1, "CANONICAL"],
  ["src/services/indexListConsumer.ts", "resolveStoredIndexList", "standalone", 1, "CANONICAL"],
  ["src/services/jobDefinitionParamBinders.ts", "SettingResolver", "resolver-type", 1, "CANONICAL"],
  ["src/services/jobPipelineConfig.ts", "resolveExecutionMode", "standalone", 1, "CANONICAL"],
  ["src/services/jobPipelineConfig.ts", "resolveJobDefinition", "standalone", 1, "CANONICAL"],
  ["src/services/jobPipelineConfig.ts", "resolveNode", "standalone", 1, "CANONICAL"],
  ["src/services/jobPipelineConfig.ts", "resolveSchedule", "standalone", 1, "CANONICAL"],
  ["src/services/jobPipelineControlFactory.ts", "JobPipelineControlOtelResolver", "resolver-type", 1, "CANONICAL"],
  ["src/services/jobPipelineControlFactory.ts", "resolveWiredObservers", "standalone", 1, "CANONICAL"],
  ["src/services/jobPipelineEngine.ts", "resolveFeedExecutionDeadlineMs", "standalone", 1, "CANONICAL"],
  ["src/services/jobPipelineEngine.ts", "resolveRunNowTrigger", "standalone", 1, "CANONICAL"],
  ["src/services/jobRunRecords.ts", "resolveScheduleRunJobId", "standalone", 1, "CANONICAL"],
  ["src/services/jobRunRecords.ts", "resolveScheduleRunTrigger", "standalone", 1, "CANONICAL"],
  ["src/services/jobStageStatus.ts", "resolveSubJob", "standalone", 1, "CANONICAL"],
  ["src/services/judgeScoreFeedback.ts", "resolveBool", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/judgeScoreFeedback.ts", "resolveInt", "standalone", 1, "CANONICAL"],
  ["src/services/judgeScoreFeedback.ts", "resolveJudgeScoreFeedbackPolicy", "standalone", 1, "CANONICAL"],
  ["src/services/marketDataService.ts", "resolveMarketDataQuotes", "standalone", 1, "CANONICAL"],
  ["src/services/memoryConsolidation.ts", "resolveBool", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/memoryConsolidation.ts", "resolveMemoryConsolidationPolicy", "standalone", 1, "CANONICAL"],
  ["src/services/memoryConsolidation.ts", "resolvePositiveInt", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/memoryConsolidation.ts", "resolvePrefixes", "standalone", 1, "CANONICAL"],
  ["src/services/meteredPaymentGate.ts", "resolveMeteredTier", "standalone", 1, "CANONICAL"],
  ["src/services/nativeMonetization.ts", "resolveChargePricing", "class-method", 1, "CANONICAL"],
  ["src/services/optionsProviderContext.ts", "resolveTenantProviderContext", "standalone", 1, "CANONICAL"],
  ["src/services/optionsRunEmail.ts", "resolveOptionsRunEmailRecipient", "standalone", 1, "CANONICAL"],
  ["src/services/paidScreenSubmission.ts", "resolvePaidScreenAccount", "standalone", 1, "CANONICAL"],
  ["src/services/paidScreenSubmission.ts", "resolvePaidScreenAction", "standalone", 1, "CANONICAL"],
  ["src/services/paidScreenSubmission.ts", "resolveTickTenant", "standalone", 1, "CANONICAL"],
  ["src/services/pipelineChains.ts", "resolveMinutesKnob", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/pipelinePolicy.ts", "resolveFetchTimeoutMs", "standalone", 1, "CANONICAL"],
  ["src/services/pipelinePolicy.ts", "resolvePipelinePolicy", "standalone", 1, "CANONICAL"],
  ["src/services/platformIdentity.ts", "resolveCurrentTenant", "standalone", 1, "CANONICAL"],
  ["src/services/platformIdentity.ts", "resolveEffectiveTenantId", "standalone", 1, "CANONICAL"],
  ["src/services/platformIdentity.ts", "resolvePlatformIdentity", "standalone", 1, "CANONICAL"],
  ["src/services/portfolioRisk.ts", "BetaResolver", "resolver-type", 1, "CANONICAL"],
  ["src/services/portfolioRisk.ts", "resolvePositionsSnapshot", "standalone", 1, "CANONICAL"],
  ["src/services/providerConnections.ts", "resolveScreenExecutionContext", "standalone", 1, "CANONICAL"],
  ["src/services/providerConnections.ts", "resolveScreenSelection", "standalone", 1, "CANONICAL"],
  ["src/services/provisioningWelcome.ts", "resolveTier", "standalone", 1, "CANONICAL"],
  ["src/services/publicData.ts", "resolveAccountId", "standalone", 1, "CANONICAL"],
  ["src/services/receiptSurface.ts", "resolveGatewayProvenance", "standalone", 1, "CANONICAL"],
  ["src/services/receiptSurface.ts", "resolveMeterProvenance", "standalone", 1, "CANONICAL"],
  ["src/services/referralAttribution.ts", "resolveSignupReferrer", "standalone", 1, "CANONICAL"],
  ["src/services/refundPaymentIntent.ts", "createBundlePaymentResolver", "standalone", 1, "CANONICAL"],
  ["src/services/refundPaymentIntent.ts", "createPayPerRunPaymentResolver", "standalone", 1, "CANONICAL"],
  ["src/services/refundService.ts", "createSubscriptionPaymentResolver", "standalone", 1, "CANONICAL"],
  ["src/services/researchVenue.ts", "resolveResearchVenue", "standalone", 1, "CANONICAL"],
  ["src/services/runBrokerContext.ts", "resolveRunBrokerContext", "standalone", 1, "CANONICAL"],
  ["src/services/runDetails.ts", "resolveRunDetailMessage", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/scheduleControls.ts", "resolveEffectiveScheduleFiringEnabled", "standalone", 1, "CANONICAL"],
  ["src/services/scheduleControls.ts", "resolveEffectiveScheduleFloor", "standalone", 1, "CANONICAL"],
  ["src/services/scheduleControls.ts", "resolveScheduleControlsView", "standalone", 1, "CANONICAL"],
  ["src/services/scheduleManagement.deprecated.ts", "resolveScheduleUpdate", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/scheduledEffectiveMode.ts", "resolveScheduledEffectiveMode", "standalone", 1, "CANONICAL"],
  ["src/services/scheduledReports.ts", "resolveCanonicalReportBody", "standalone", 1, "CANONICAL"],
  ["src/services/scheduledReports.ts", "resolveCanonicalReportBodyWithBackfill", "standalone", 1, "CANONICAL"],
  ["src/services/scheduledTasks.ts", "resolveDeliveryTenant", "class-method", 1, "CANONICAL"],
  ["src/services/scheduledTasks.ts", "resolveDiscoveryRunMode", "standalone", 1, "CANONICAL"],
  ["src/services/scheduledTasks.ts", "resolveScheduledFirerHostDispatch", "standalone", 1, "CANONICAL"],
  ["src/services/scheduledTasks.ts", "resolveScheduledStockProvider", "standalone", 1, "CANONICAL"],
  ["src/services/scheduledTasks.ts", "resolveWatchlistSymbols", "class-method", 1, "CANONICAL"],
  ["src/services/screenerFollowupDelivery.ts", "resolveDeliveryGate", "standalone", 1, "CANONICAL"],
  ["src/services/screenerFollowups.ts", "resolveHttpJobChain", "standalone", 1, "CANONICAL"],
  ["src/services/screenerFollowups.ts", "resolveScreenerFollowupConfig", "standalone", 1, "CANONICAL"],
  ["src/services/screenerPipelineJobs.ts", "resolveGoalOptionsLegSymbols", "standalone", 1, "CANONICAL"],
  ["src/services/screenerPipelineJobs.ts", "resolveGoalStockLegSymbols", "standalone", 1, "CANONICAL"],
  ["src/services/screenerPresetResolution.ts", "resolvePresetFilter", "standalone", 1, "CANONICAL"],
  ["src/services/shardExecutors.ts", "resolveShardChainSource", "standalone", 1, "CANONICAL"],
  ["src/services/shardExecutors.ts", "resolveShardHostDispatch", "standalone", 1, "CANONICAL"],
  ["src/services/stageTimeouts.ts", "resolveGoalScreenAwaitDeadlineMs", "standalone", 1, "CANONICAL"],
  ["src/services/stageTimeouts.ts", "resolveStageTimeoutMs", "standalone", 1, "CANONICAL"],
  ["src/services/stageTimeouts.ts", "resolveStageTimeoutMsForNode", "standalone", 1, "CANONICAL"],
  ["src/services/stageTimeouts.ts", "resolveStockScreenAwaitDeadlineMs", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotCadence.ts", "resolveCopilotCadence", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotConfiguration.ts", "resolveCopilotStrategies", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotConfiguration.ts", "resolveCopilotUniverse", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotConfiguration.ts", "resolveCopilotUniverseFull", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotConfiguration.ts", "resolveCopilotUniversePreset", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotExecutionMode.ts", "resolveCopilotExecutionMode", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotLearningPolicy.ts", "resolveBoolean", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotLearningPolicy.ts", "resolveCopilotLearningPolicyThresholds", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotLearningPolicy.ts", "resolvePositiveInt", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/stockCopilotProposalFiling.ts", "resolveCopilotProposalFiler", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotRsiMode.ts", "resolveRequestedStockCopilotRsiMode", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotRsiMode.ts", "resolveStockCopilotRsiMode", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotRsiMode.ts", "resolveStockCopilotRsiModeState", "standalone", 1, "CANONICAL"],
  ["src/services/stockCopilotSessions.ts", "resolveCopilotSessions", "standalone", 1, "CANONICAL"],
  ["src/services/stockReportFormatStatus.ts", "resolveStockReportFormatStatus", "standalone", 1, "CANONICAL"],
  ["src/services/tenantChannelGate.ts", "resolveTenantChannelGate", "standalone", 1, "CANONICAL"],
  ["src/services/tenantCredentialStore.ts", "resolveTenantCredentials", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveEffectiveTenantProviders", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveManualScreenProviders", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveScreenProviderForRun", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveTenantBroker", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveTenantBrokerSelection", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveTenantDataProviderSelection", "standalone", 1, "CANONICAL"],
  ["src/services/tenantProviders.ts", "resolveTenantProviders", "standalone", 1, "CANONICAL"],
  ["src/services/unifiedScanHostDispatch.ts", "resolveUnifiedScanHostDispatch", "standalone", 1, "CANONICAL"],
  ["src/services/unifiedScheduleManagement.ts", "resolveScheduleSource", "standalone", 1, "CANONICAL"],
  ["src/services/unifiedScheduleManagement.ts", "resolveScheduleUpdate", "standalone", 1, "DUPLICATE-NAME"],
  ["src/services/upgradeOffers.ts", "resolveOffer", "standalone", 1, "CANONICAL"],
  ["src/services/usageBillingSurface.ts", "resolveRefundProvenance", "standalone", 1, "CANONICAL"],
  ["src/services/usageBillingSurface.ts", "resolveSubscriptionProvenance", "standalone", 1, "CANONICAL"],
  ["src/services/userEmailDestination.ts", "resolveEmailDestination", "standalone", 1, "CANONICAL"],
  ["src/services/versionMoves.ts", "resolveBulkMovePopulation", "standalone", 1, "CANONICAL"],
  ["src/services/webSearch.ts", "resolveWebSearchChain", "standalone", 1, "CANONICAL"],
  ["src/services/webSearch.ts", "resolveWebSearchProvider", "standalone", 1, "CANONICAL"],
  ["src/services/workflowLifecycle.ts", "resolveScheduleBranch", "standalone", 1, "CANONICAL"],
  ["src/services/workflowStageSchedule.ts", "resolveStageNode", "standalone", 1, "CANONICAL"],
  ["src/services/workflowStageSchedule.ts", "resolveWorkflowStage", "standalone", 1, "CANONICAL"],
  ["src/services/x402Networks.ts", "resolveX402Network", "standalone", 1, "CANONICAL"],
  ["src/telemetry/telemetryPorts.ts", "resolveCalibratedPrompt", "class-method", 1, "CANONICAL"],
  ["src/trading/accountBindings.ts", "resolveAccountByLabel", "standalone", 1, "CANONICAL"],
  ["src/trading/accountBindings.ts", "resolveEffectiveAccountBinding", "standalone", 1, "CANONICAL"],
  ["src/trading/alpaca/credentialResolution.ts", "resolveAlpacaPair", "standalone", 1, "CANONICAL"],
  ["src/trading/alpaca/optionsData.ts", "resolveAlpacaTradingBase", "standalone", 1, "CANONICAL"],
  ["src/trading/baseBreakout.ts", "resolveBaseBreakoutCaps", "standalone", 1, "CANONICAL"],
  ["src/trading/brokerCatalog.ts", "resolveBrokerSelection", "standalone", 1, "CANONICAL"],
  ["src/trading/cancelFilters.ts", "resolveCancelTargets", "standalone", 1, "CANONICAL"],
  ["src/trading/channelBroker.ts", "resolveChannelBroker", "standalone", 1, "CANONICAL"],
  ["src/trading/channelBroker.ts", "resolveNoSelectionBroker", "standalone", 1, "CANONICAL"],
  ["src/trading/channels/intake.ts", "resolvePrincipal", "standalone", 1, "CANONICAL"],
  ["src/trading/dataProviders/registry.ts", "resolveRoute", "class-method", 1, "CANONICAL"],
  ["src/trading/etrade/platform.ts", "resolveTokenIdentity", "class-method", 1, "CANONICAL"],
  ["src/trading/limits.ts", "resolveSessionWindow", "standalone", 1, "CANONICAL"],
  ["src/trading/limits.ts", "resolveTradingLimits", "standalone", 1, "CANONICAL"],
  ["src/trading/options/discoveryExpression.ts", "resolveDiscoveryFitGate", "standalone", 1, "CANONICAL"],
  ["src/trading/options/flows/flowService.ts", "resolveDynamicFlowSymbols", "standalone", 1, "CANONICAL"],
  ["src/trading/options/ivCollector.ts", "resolveTrackedSymbols", "standalone", 1, "CANONICAL"],
  ["src/trading/options/llmIdeas.ts", "resolveSymbol", "standalone", 1, "CANONICAL"],
  ["src/trading/options/opportunityScanner.ts", "resolveScanClock", "standalone", 1, "CANONICAL"],
  ["src/trading/options/opportunityScanner.ts", "resolveScanTarget", "standalone", 1, "CANONICAL"],
  ["src/trading/options/strategies/registry.ts", "resolveMany", "class-method", 1, "CANONICAL"],
  ["src/trading/options/strategyChoice.ts", "resolveAllowedStrategyIds", "standalone", 1, "CANONICAL"],
  ["src/trading/options/strategyChoice.ts", "resolvePanelFetchBands", "standalone", 1, "CANONICAL"],
  ["src/trading/options/strategyChoice.ts", "resolveStrategyMode", "standalone", 1, "CANONICAL"],
  ["src/trading/options/strategyEngine.ts", "resolveNoViewScoreWeights", "standalone", 1, "CANONICAL"],
  ["src/trading/options/strategyEngine.ts", "resolveScoreWeights", "standalone", 1, "CANONICAL"],
  ["src/trading/options/unifiedOptionsService.ts", "resolveEngineClient", "class-method", 1, "CANONICAL"],
  ["src/trading/options/unifiedOptionsService.ts", "resolveStrategyProfile", "class-method", 1, "DUPLICATE-NAME"],
  ["src/trading/optionsReportScope.ts", "resolveOptionsReportScope", "standalone", 1, "CANONICAL"],
  ["src/trading/optionsScreener.ts", "resolveUnderlyings", "class-method", 1, "CANONICAL"],
  ["src/trading/platformHistory.ts", "resolveYahooHistoryDeps", "standalone", 1, "CANONICAL"],
  ["src/trading/platformHistory.ts", "resolveYahooHistoryProvider", "standalone", 1, "CANONICAL"],
  ["src/trading/public/platform.ts", "resolveAccount", "class-method", 1, "CANONICAL"],
  ["src/trading/screener.ts", "resolveStockSector", "standalone", 1, "CANONICAL"],
  ["src/trading/screenerPipeline.ts", "resolveAllListings", "standalone", 1, "CANONICAL"],
  ["src/trading/screenerPipeline.ts", "resolveUniverseListings", "standalone", 1, "CANONICAL"],
  ["src/trading/screenerReportTemplate.ts", "resolveScreenerPdfSectionConfig", "standalone", 1, "CANONICAL"],
  ["src/trading/stockQuoteSource.ts", "resolveUniverseSymbols", "standalone", 1, "CANONICAL"],
  ["src/trading/tastytrade/credentials.ts", "resolveTastytradeBaseUrl", "standalone", 1, "CANONICAL"],
  ["src/trading/tastytrade/credentials.ts", "resolveTastytradeCredentials", "standalone", 1, "CANONICAL"],
  ["src/trading/tastytrade/platform.ts", "resolveDefaultAccountNumber", "class-method", 1, "CANONICAL"],
  ["src/trading/universes.ts", "resolveUniverse", "standalone", 1, "CANONICAL"],
  ["src/trading/voice/stockCopilotVoiceActivation.ts", "resolveStockCopilotVoiceActivation", "standalone", 1, "CANONICAL"],
  ["src/workflows/brokerChainSourceResidency.ts", "BrokerChainSourceResolver", "resolver-type", 1, "CANONICAL"],
  ["src/workflows/brokerChainSourceResidency.ts", "resolveChainSourceForRequest", "standalone", 1, "CANONICAL"],
  ["src/workflows/optionsScreenEngine.ts", "resolveOptionsStageId", "standalone", 1, "CANONICAL"],
  ["src/workflows/optionsStageControl.ts", "resolveScreenJobId", "standalone", 1, "CANONICAL"],
  ["src/workflows/researchDataPorts.ts", "resolveResearchDatasets", "standalone", 1, "CANONICAL"],
  ["src/workflows/researchScreenEngine.ts", "resolveResearchEngineAdapters", "standalone", 1, "CANONICAL"],
  ["src/workflows/stageConfig.ts", "resolveStageConfig", "standalone", 1, "CANONICAL"],
  ["src/workflows/stageRunnerPorts.ts", "resolveStageRetryBudget", "standalone", 1, "CANONICAL"],
  ["src/workflows/universeDepsResidency.ts", "resolveUniverseDepsFromStageInput", "standalone", 1, "CANONICAL"],
  ["src/workflows/workflowInstanceSeam.ts", "resolveWorkflowRunId", "standalone", 1, "CANONICAL"],
];

/** [file, name, kind, definition count] — the measured tests-only resolver set. */
const TEST_ONLY_BASELINE: Array<[string, string, Kind, number]> = [
  ["tests/broker_stage_input_3960.test.ts", "resolvePlatform", "standalone", 1],
  ["tests/checkout_ui_top_up_wcag_3574.test.tsx", "resolveVar", "standalone", 1],
  ["tests/iaaa_logged_in_users_2836.test.ts", "resolveProvider", "standalone", 1],
  ["tests/mcp_tool_context_6173.test.ts", "resolveRoles", "standalone", 2],
  ["tests/mesh_registry_s1_2322.test.ts", "resolveClassName", "standalone", 1],
  ["tests/s2_tenant_isolation_matrix.test.ts", "resolvePositive", "standalone", 1],
  ["tests/schedule-3121-s0-parity.test.ts", "resolveCommercialBarePaths", "standalone", 1],
  ["tests/schema_equality_harness.ts", "resolveCombinedSteps", "standalone", 1],
  ["tests/security_hub_coherent_6164.test.ts", "resolveProvider", "standalone", 1],
  ["tests/server_route_inventory_2902.test.ts", "resolveCommercialPrefixes", "standalone", 1],
  ["tests/single_pdf_path_s4.test.ts", "resolveEngineClient", "class-method", 1],
  ["tests/single_pdf_path_s4.test.ts", "resolveStrategyProfile", "class-method", 1],
  ["tests/template_route_tree.ts", "resolveImport", "standalone", 1],
  ["tests/thin_router_inventory.test.ts", "resolveCommercialRefs", "standalone", 1],
];

/** [file, name] — the 8 `const resolve*` non-functions excluded from the count (§4). */
const EXCLUDED_CONST_NONFN: Array<[string, string]> = [
  ["src/agents/orchestrator/meshOptionsStrategyDoor.ts", "resolveSymbols"],
  ["src/agents/routes/brokerEnvironment.ts", "resolveTradeEnvironmentFromSettings"],
  ["src/agents/routes/workspace.ts", "resolveCanonicalWorkspacePath"],
  ["src/messaging/screenerQueueConsumer.ts", "resolveUserLogin"],
  ["src/security/mcpToolContext.ts", "resolveInput"],
  ["src/security/mcpToolContext.ts", "resolveRoles"],
  ["src/security/platformContext.ts", "resolveIdentity"],
  ["src/workflows/brokerChainSourceResidency.ts", "resolvePlatform"],
];

/** Distinct questions: a RANGE, never asserted exact (`copies-and-overlaps.md` §5). */
const QUESTION_RANGE_LOW = 285;
const QUESTION_CENTRAL_ESTIMATE = 306;
const QUESTION_RANGE_HIGH = 320;

/** `scripts/` resolver: the one known CI lint helper (excluded from production). */
const SCRIPTS_BASELINE: Array<[string, string]> = [
  ["scripts/lint-changed.mjs", "resolveBase"],
];

/**
 * Strip `//` and `/* *\/` comments, preserving newlines and string contents.
 * See the context pin for why this is a char scanner, not a regex: a `//`
 * inside a string or a `/*` inside a `//` comment must not start a comment.
 * Same stated limitation as the context pin (regex literals and template
 * `${...}` edge cases; neither occurs on a resolver definition line here).
 */
function stripComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
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

function walk(dir: string, out: string[], exts: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) walk(path, out, exts);
    else if (exts.some((ext) => path.endsWith(ext))) out.push(path);
  }
}

/**
 * The next non-space char after the `(` at (lineIdx, parenCol)'s matching
 * `)`, or null. Paren depth is tracked across lines.
 */
function nextAfterParen(lines: string[], lineIdx: number, parenCol: number): string | null {
  let depth = 0;
  let i = lineIdx;
  let j = parenCol;
  while (i < lines.length) {
    let line = lines[i];
    while (j < line.length) {
      const ch = line[j];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          let k = j + 1;
          for (;;) {
            while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
            if (k < line.length) return line[k];
            i += 1;
            if (i >= lines.length) return null;
            line = lines[i];
            k = 0;
          }
        }
      }
      j += 1;
    }
    i += 1;
    j = 0;
  }
  return null;
}

/**
 * After a function/method signature's matching `)`: `{` => implementation,
 * `;` => overload signature, anything else => a call site. A `: ReturnType`
 * annotation is skipped brace-aware (object return types contain `;`
 * inside braces).
 */
function afterSignature(lines: string[], lineIdx: number, parenCol: number): string | null {
  const first = nextAfterParen(lines, lineIdx, parenCol);
  if (first === "{") return "{";
  if (first !== ":") return first;
  // Skip the return-type annotation to the first top-level `{` or `;`.
  let dParen = 0;
  let dBrace = 0;
  let dAngle = 0;
  let i = lineIdx;
  let j = parenCol;
  let d = 0;
  outer: while (i < lines.length) {
    const line = lines[i];
    while (j < line.length) {
      const ch = line[j];
      if (ch === "(") d += 1;
      else if (ch === ")") {
        d -= 1;
        if (d === 0) {
          j += 1;
          break outer;
        }
      }
      j += 1;
    }
    i += 1;
    j = 0;
  }
  while (i < lines.length) {
    const line = lines[i];
    while (j < line.length) {
      const ch = line[j];
      if (ch === "{") {
        if (dBrace === 0 && dParen === 0 && dAngle === 0) return "{";
        dBrace += 1;
      } else if (ch === "}") {
        dBrace = Math.max(0, dBrace - 1);
      } else if (ch === "(") {
        dParen += 1;
      } else if (ch === ")") {
        dParen = Math.max(0, dParen - 1);
      } else if (ch === "<") {
        dAngle += 1;
      } else if (ch === ">") {
        dAngle = Math.max(0, dAngle - 1);
      } else if (ch === ";" && dBrace === 0 && dParen === 0 && dAngle === 0) {
        return ";";
      }
      j += 1;
    }
    i += 1;
    j = 0;
  }
  return null;
}

type MeasuredRow = [string, string, Kind];
type ScanResult = { counts: Map<string, number>; rows: MeasuredRow[] };

/**
 * Scan one file for resolver definitions. Tracks interface/class context
 * (including multi-line declarations, whose `{` lands on a later line, and
 * `type X = { ... }` object literals, which are contract contexts) so a
 * call site inside a method body is never mistaken for a definition: a
 * candidate method line only counts when the char after its signature is
 * `{` (implementation) — `;` is an overload signature, anything else is a
 * call.
 */
function scanFile(file: string, lines: string[]): ScanResult {
  const counts = new Map<string, number>();
  const rows: MeasuredRow[] = [];
  const add = (name: string, kind: Kind): void => {
    const key = `${file}\0${name}\0${kind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    rows.push([file, name, kind]);
  };
  const stack: Array<[string, number]> = [];
  let depth = 0;
  let pending: string | null = null;
  const fnRe =
    /^(\s*)(export\s+)?(async\s+)?function\s+(resolve[A-Z]\w*|create\w*Resolver)\s*(<[^>]*>)?\s*\(/;
  const constRe = /^(\s*)(export\s+)?const\s+(resolve[A-Z]\w*)\s*[:=]/;
  const typeRe = /^(\s*)(export\s+)?(interface|type)\s+(\w*Resolver)\b.*(\{|=|extends\b)/;
  for (let ln = 0; ln < lines.length; ln += 1) {
    const line = lines[ln];
    const decl = /\b(class|interface)\s+\w+/.exec(line);
    if (decl && !line.includes("{")) pending = decl[1];
    if (/^\s*(export\s+)?type\s+\w+\s*(<[^>]*>)?\s*=/.test(line) && !line.includes("{")) {
      pending = "interface";
    }
    const fm = fnRe.exec(line);
    if (fm) {
      const name = fm[4];
      const paren = line.indexOf("(", fm[0].length - 1);
      const after = afterSignature(lines, ln, paren);
      if (after === "{") add(name, "standalone");
    } else {
      const cm = constRe.exec(line);
      if (cm) {
        const rhs = line.includes("=") ? line.slice(line.indexOf("=") + 1) : "";
        if (/^\s*(async\s*)?(\(|function\b|<)/.test(rhs)) add(cm[3], "standalone");
      } else {
        const ctx = stack.length > 0 ? stack[stack.length - 1][0] : null;
        if (ctx === "interface" || ctx === "class") {
          const mm =
            /^(\s*)(private\s+)?(protected\s+)?(public\s+)?(static\s+)?(async\s+)?(resolve[A-Z]\w*)\s*\(/.exec(
              line,
            );
          if (mm) {
            const name = mm[7];
            const paren = line.indexOf("(", mm[0].length - 1);
            const after = afterSignature(lines, ln, paren);
            if (ctx === "interface" && (after === ";" || after === "{")) {
              add(name, "interface-method");
            } else if (ctx === "class" && after === "{") {
              add(name, "class-method");
            }
          }
        }
      }
    }
    const tm = typeRe.exec(line);
    if (tm) add(tm[4], "resolver-type");
    for (let idx = 0; idx < line.length; idx += 1) {
      const ch = line[idx];
      if (ch === "{") {
        if (pending) {
          stack.push([pending, depth]);
          pending = null;
        } else {
          const here = /\b(interface|class)\s+\w+/.exec(line.slice(0, idx + 1));
          if (here) stack.push([here[1], depth]);
          else if (/^\s*(export\s+)?type\s+\w+\s*(<[^>]*>)?\s*=/.test(line.slice(0, idx + 1))) {
            stack.push(["interface", depth]);
          }
        }
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        while (stack.length > 0 && depth <= stack[stack.length - 1][1]) stack.pop();
      }
    }
    if (line.includes(";") && pending && !line.includes("{")) pending = null;
  }
  return { counts, rows };
}

/** Measured resolver definitions under `dir`: key `file\0name\0kind` -> count. */
function measure(dir: string): Map<string, number> {
  const files: string[] = [];
  walk(dir, files, [".ts", ".tsx"]);
  const measured = new Map<string, number>();
  for (const file of files.sort()) {
    const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
    const { counts } = scanFile(file, lines);
    for (const [key, n] of counts) {
      measured.set(key, (measured.get(key) ?? 0) + n);
    }
  }
  return measured;
}

function keyOf(file: string, name: string, kind: Kind): string {
  return `${file}\0${name}\0${kind}`;
}

describe("universal resolver census (#6528 Phase 1)", () => {
  const measured = measure("src");
  const baseline = new Map(BASELINE.map(([f, n, k, c]) => [keyOf(f, n, k), c]));
  const baselineByName = new Map<string, Set<string>>();
  for (const [f, n] of BASELINE) {
    if (!baselineByName.has(n)) baselineByName.set(n, new Set());
    baselineByName.get(n)!.add(f);
  }
  const baselineTotal = BASELINE.reduce((sum, [, , , c]) => sum + c, 0);

  it("the measurement actually ran", () => {
    let total = 0;
    for (const n of measured.values()) total += n;
    expect(total).toBeGreaterThan(400);
    expect(measured.size).toBeGreaterThan(400);
  });

  it("no resolve* definition exists outside the baseline", () => {
    const offenders: string[] = [];
    for (const [key, count] of measured) {
      const [file, name, kind] = key.split("\0") as [string, string, Kind];
      const allowed = baseline.get(key);
      if (allowed === undefined) {
        offenders.push(`${file} / ${name} (${kind}, ${count})`);
      } else if (count > allowed) {
        offenders.push(`${file} / ${name} (${kind}): ${count} definitions, above its baseline of ${allowed}`);
      }
    }
    expect(
      offenders,
      "new resolve* definition(s) must reuse the existing resolver for the question, or record " +
        "the new question in the census with a disposition + reason in the same PR — see #6528 and " +
        "docs/architecture/survey/resolvers-and-issues-survey.md §1",
    ).toEqual([]);
  });

  it("no new same-question duplicate without a disposition", () => {
    const offenders: string[] = [];
    for (const [key] of measured) {
      if (baseline.has(key)) continue;
      const [file, name] = key.split("\0");
      const elsewhere = [...(baselineByName.get(name) ?? new Set())].filter((f) => f !== file);
      if (elsewhere.length > 0) {
        offenders.push(
          `${file} / ${name} answers a question already answered by ${elsewhere.join(", ")}: ` +
            "reuse the existing resolver, or record the duplicate in the census with a " +
            "disposition + reason in the same PR — see #6528 (one resolver per question, #3786 Outcome §2)",
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the resolver definition count only shrinks", () => {
    let total = 0;
    for (const n of measured.values()) total += n;
    expect(
      total,
      `resolver count ${total} exceeds the baselined ${baselineTotal}: consolidate a duplicate or ` +
        "record the new definition in the census with a disposition + reason in the same PR — see #6528",
    ).toBeLessThanOrEqual(baselineTotal);
  });

  it("the distinct-question count is a range, never an exact number", () => {
    expect(QUESTION_RANGE_LOW).toBeLessThan(QUESTION_CENTRAL_ESTIMATE);
    expect(QUESTION_CENTRAL_ESTIMATE).toBeLessThan(QUESTION_RANGE_HIGH);
    // Implied copies at the seeded total: 595 − 320 = 275 … 595 − 285 = 310.
    expect(baselineTotal - QUESTION_RANGE_HIGH).toBe(275);
    expect(baselineTotal - QUESTION_RANGE_LOW).toBe(310);
  });

  it("no test-only or scripts-only resolver is counted as production", () => {
    const testMeasured = measure("tests");
    const testBaseline = new Map(
      TEST_ONLY_BASELINE.map(([f, n, k, c]) => [keyOf(f, n, k), c]),
    );
    const offenders: string[] = [];
    for (const [key, count] of testMeasured) {
      const [file, name, kind] = key.split("\0") as [string, string, Kind];
      const allowed = testBaseline.get(key);
      if (allowed === undefined) {
        offenders.push(`${file} / ${name} (${kind}, ${count})`);
      } else if (count > allowed) {
        offenders.push(`${file} / ${name} (${kind}): ${count}, above its baseline of ${allowed}`);
      }
    }
    expect(
      offenders,
      "new test-only resolver definition(s): record them in TEST_ONLY_BASELINE with a reason, " +
        "or move the helper into src/ and record it in the production census — see #6528",
    ).toEqual([]);
    // scripts/: only the known CI lint helper.
    const scriptFiles: string[] = [];
    walk("scripts", scriptFiles, [".mjs", ".js", ".ts"]);
    const scriptFound: Array<[string, string]> = [];
    for (const file of scriptFiles) {
      const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
      for (const line of lines) {
        const m = /^\s*(export\s+)?(async\s+)?function\s+(resolve[A-Z]\w*)\s*\(/.exec(line);
        if (m) scriptFound.push([file, m[3]]);
        const cm = /^\s*(export\s+)?const\s+(resolve[A-Z]\w*)\s*=/.exec(line);
        if (cm && /^\s*(async\s*)?(\(|function\b|<)/.test(line.slice(line.indexOf("=") + 1))) {
          scriptFound.push([file, cm[3]]);
        }
      }
    }
    expect(scriptFound).toEqual(SCRIPTS_BASELINE);
  });

  it("the DI-fallback boundary is recorded (8 const-nonfn names stay uncounted)", () => {
    for (const [file, name] of EXCLUDED_CONST_NONFN) {
      expect(
        baseline.has(keyOf(file, name, "standalone")),
        `${file} / ${name} must stay out of the standalone census (DI-fallback / alias / non-function)`,
      ).toBe(false);
    }
    expect(EXCLUDED_CONST_NONFN.length).toBe(8);
  });

  it("the baseline is well-formed (unique file/name/kind rows, positive counts)", () => {
    const keys = BASELINE.map(([f, n, k]) => keyOf(f, n, k));
    expect(new Set(keys).size).toBe(keys.length);
    for (const [, , kind, count, disposition] of BASELINE) {
      expect(KINDS.has(kind), `unknown kind ${kind}`).toBe(true);
      expect(count, `${kind} count`).toBeGreaterThan(0);
      expect(DISPOSITIONS.has(disposition), `unknown disposition ${disposition}`).toBe(true);
    }
    expect(baselineTotal).toBe(595);
    const byKind = new Map<Kind, number>();
    for (const [, , kind, count] of BASELINE) {
      byKind.set(kind, (byKind.get(kind) ?? 0) + count);
    }
    expect(byKind.get("standalone")).toBe(564);
    expect(byKind.get("class-method")).toBe(18);
    expect(byKind.get("resolver-type")).toBe(9);
    expect(byKind.get("interface-method")).toBe(4);
  });
});
