/**
 * Issue #2880 (under #2764) — stock screening capability inventory.
 *
 * Every stock screening capability today, mapped to its canonical
 * component (spec / broker / planner / finalizer / suppressor /
 * aspects / stage contract / replay) or to a named future
 * extension point. Extension points are exactly five — pattern,
 * preset, provider, stage, aspect — and none of them is a new
 * parallel pipeline: each names an existing seam where a future
 * slice plugs in (registry, resolution, provider port, stage id,
 * aspect map entry), reusing the shared runtime from #2621.
 *
 * Status honesty rules for this inventory:
 *   - "canonical": the capability already runs through the named
 *     canonical component(s); the mapping is built, not planned.
 *   - "target": the capability's CURRENT path is named in
 *     `current`, and its canonical target is named in
 *     `canonical`; the target slice is NOT claimed built here.
 *   - "none": no implementation exists today (pattern
 *     application) — the entry records the gap, it does not
 *     pretend a registry exists.
 * No entry names a second recorder, second catalog, second
 * port layer, or second unit store; the shared runtime
 * (stage runner, mas_async_jobs, pipelinePolicy,
 * breakerDecorator, outcomeCatalog, one recorder, one
 * delivery bridge, Queues/Workflows/Schedules) is the only
 * runtime any entry may name.
 */

export type CapabilityStatus = "canonical" | "target" | "none";

/** The five future extension points — closed set, enforced by tests. */
export const STOCK_SCREEN_EXTENSION_POINTS = [
  "pattern",
  "preset",
  "provider",
  "stage",
  "aspect",
] as const;

export type StockScreenExtensionPoint =
  (typeof STOCK_SCREEN_EXTENSION_POINTS)[number];

export interface StockScreenCapability {
  id: string;
  name: string;
  /** Where the user (or schedule) enters this capability. */
  entry: string;
  /** Engine path today. */
  engine: string;
  /** Provider(s) today. */
  provider: string;
  /** Where results persist today. */
  persistence: string;
  /** How results are delivered today (or "none"). */
  delivery: string;
  /** Canonical component(s) — built, or the named target. */
  canonical: string[];
  status: CapabilityStatus;
  /** Current path when status is "target" or "none". */
  current?: string;
  /** Future extension point this capability plugs into, when any. */
  extensionPoint?: StockScreenExtensionPoint;
}

export const STOCK_SCREEN_CAPABILITIES: readonly StockScreenCapability[] = [
  {
    id: "rest-etrade-screen",
    name: "REST E*TRADE screen",
    entry: "POST /api/etrade/broker/screen (single + sharded ALL)",
    engine: "ScreenerAgent.runScreen via spec",
    provider: "etrade",
    persistence: "Canonical report store (persist-then-deliver)",
    delivery: "Delivery bridge (E*TRADE deliver: true)",
    canonical: ["stockScreenRunSpec", "screenExecutionBroker", "screenRunFinalize", "screenDeliverySuppression", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "rest-market-data-screen",
    name: "REST market-data screen",
    entry: "POST /api/market-data/screen (single + sharded ALL)",
    engine: "ScreenerAgent.runScreen via spec",
    provider: "yahoo",
    persistence: "Canonical report store (persist-only)",
    delivery: "none (market-data deliver: false)",
    canonical: ["stockScreenRunSpec", "screenRunFinalize", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "nlq-chat-screen",
    name: "NLQ chat screen",
    entry: "Chat/NLQ stock-screen port (buildChatScreenCommand)",
    engine: "Broker workflow when available; broker-consulted planner fallback (spec + broker null = sync branch, then sync run)",
    provider: "planner default (etrade) or requested",
    persistence: "Canonical report store via runScreen",
    delivery: "Delivery bridge via runScreen",
    canonical: ["screenExecutionBroker.buildParentScreenCommand", "screenExecutionBroker (sync-branch consult)", "stockScreenPlanner.planStockScreenRun", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "mesh-screen-door",
    name: "Mesh screen door",
    entry: "Mesh screen command (buildScreenCommand)",
    engine: "Broker workflow",
    provider: "planner default or requested",
    persistence: "Canonical report store via runScreen",
    delivery: "Delivery bridge via runScreen",
    canonical: ["screenExecutionBroker.buildParentScreenCommand", "screenExecutionBroker.shardsForUniverse", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "scheduled-monolithic",
    name: "Scheduled monolithic screen",
    entry: "ScheduledTasksService.autonomousMarketScreen (monolithic branch)",
    engine: "Broker sync branch via planner",
    provider: "requested, else planner default (etrade); fallback forces yahoo with marker",
    persistence: "Canonical report store via runScreen",
    delivery: "Delivery bridge via runScreen",
    canonical: ["stockScreenPlanner.planScheduledScreen", "screenExecutionBroker", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "scheduled-sharded",
    name: "Scheduled sharded screen",
    entry: "ScheduledTasksService.autonomousMarketScreenSharded",
    engine: "Broker-owned chain start (startScheduledShardedChain) + collation; the chain keeps its engine (see the broker's G7 note on why execution does not move to the workflow)",
    provider: "requested, else planner default (etrade); fallback forces yahoo with marker",
    persistence: "Canonical report store per shard",
    delivery: "Delivery bridge via chain",
    canonical: ["screenExecutionBroker.startScheduledShardedChain", "stockScreenPlanner.planScheduledScreen", "screenerCollation.collateShards (qualified partial rule)", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "workflow-child-screen",
    name: "Workflow-child screen",
    entry: "Async REST workflow children (ScreenerAgent.runScreenInner)",
    engine: "ScreenerAgent.runScreenInner via planner",
    provider: "planner default (etrade) or requested",
    persistence: "Canonical report store via runScreen",
    delivery: "Delivery bridge via runScreen",
    canonical: ["stockScreenPlanner.planStockScreenRun", "stockScreenPlanner.planFromSpec", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "goal-stock-leg",
    name: "Goal stock leg",
    entry: "GoalScreenPanel / goal screen dispatch",
    engine: "Goal-driven screen (stock leg via provider registry)",
    provider: "provider registry (goal stock leg)",
    persistence: "Goal screen reports (goalScreenReports)",
    delivery: "Goal dispatch delivery (goal-owned)",
    canonical: ["goalStockScreenSpec (source: goal, deliver: false)", "stockScreenPlanner.planGoalStockLeg", "screenExecutionBroker goal routing (guard retired #2991)"],
    status: "target",
    current: "Decision 2026-11-03 (G7 #2914): goal execution stays goal-owned — goalDrivenScreen.buildGoalScreenPlan + goalScreenDispatch own execution (goal engine screens thesis legs internally via the provider registry; goal reports and delivery are goal-owned surfaces). Broker guard retired (#2991, one-solution direction — the #2882 'routing decision, not a gap' premise is superseded); goal dispatch becomes a caller of the one pipeline; execution migration still open (revisit trigger per G7 #2914: the workflow gains multi-leg goal semantics + goal report/delivery parity).",
    extensionPoint: "stage",
  },
  {
    id: "research-screener-subtab",
    name: "Research screener subtab",
    entry: "MarketDataResearchHub ?tab=research&view=screener -> /api/market-data/screen",
    engine: "ScreenerAgent.runScreen via spec",
    provider: "yahoo",
    persistence: "Canonical report store (persist-only)",
    delivery: "none",
    canonical: ["stockScreenRunSpec", "screenRunFinalize", "screenRunAspects"],
    status: "canonical",
  },
  {
    id: "report-replay",
    name: "Report replay",
    entry: "ReportsPanel per-row, RunDetailView, Research Report subtab -> POST /api/reports/replay",
    engine: "reportReplay.buildReplayFromRecord (persisted record only)",
    provider: "none (zero live fetch)",
    persistence: "Canonical report store (read-only)",
    delivery: "none (envelope returned to caller, never re-delivered)",
    canonical: ["reportReplay", "scheduledReports.getScheduledReportByRunId"],
    status: "canonical",
  },
  {
    id: "pareto-evaluation",
    name: "Pareto frontier evaluation",
    entry: "Post-screening stage (ScreenerAgent.runScreenInner, before persistence)",
    engine: "paretoFrontierForScreen over allStocks (default: momentumScore + changePercent, both maximize)",
    provider: "none (pure evaluation over the run's own rows)",
    persistence: "Run result pareto field (agent run store) + canonical body pareto field (REST runs)",
    delivery: "none (view only — never a trade, never a promotion, never a re-rank)",
    canonical: ["paretoFrontier.evaluateParetoFrontier", "paretoFrontier.paretoFrontierForScreen"],
    status: "canonical",
    extensionPoint: "stage",
  },
  {
    id: "report-generation",
    name: "Report generation (generate/store/serve)",
    entry: "unifiedReportPipeline via ReportAssetAgent (analysis-done consumer)",
    engine:
      "consumeAnalysisDone (production PDF leg) via stageReportProduction.generateRunPdfViaStageConsumer; chain tabular XLSX/CSV legs via stageTabularConsumer.consumeTabularGenerate (slice 3, persisted assemble dataset only, format-specific claims); monolithic tabular legs stay in the one generation module (stockReportArtifacts); slice 1 queue transport: analysis-done published to screener-events after the canonical persist and consumed via ScreenerAgent.consumeQueuedAnalysisDone (same consumer, durable claims)",
    provider: "none (report generation never fetches)",
    persistence: "mas_reports via storeReportStage (idempotent on generationId)",
    delivery: "Delivery bridge via serveReportStage consumers",
    canonical: [
      "stageReportConsumer.consumeAnalysisDone (production PDF leg)",
      "stageTabularConsumer.consumeTabularGenerate (chain tabular legs)",
      "stageReportProduction.generateRunPdfViaStageConsumer",
      "stageMessage (analysis-done)",
      "stageQueueTransport (slice 1 queue transport + executor)",
    ],
    status: "canonical",
    extensionPoint: "stage",
  },
  {
    id: "delivery",
    name: "Delivery (followup.deliver)",
    entry: "AsyncJob followup.deliver executor",
    engine: "Pipeline-policy gates, then send, then audit",
    provider: "none",
    persistence: "Delivery audit records",
    delivery: "Delivery bridge (email/webhook/slack per destination)",
    canonical: ["screenRunFinalize.persistThenDeliverAll", "screenDeliverySuppression (runId, destination)"],
    status: "canonical",
  },
  {
    id: "screener-delivery-cache",
    name: "Screener delivery cache",
    entry: "ScreenerAgent.persistRun (LATEST/HISTORY + per-run artifact keys in DO storage)",
    engine: "DO storage puts after generation: latest result, capped history, latest + per-run artifact keys",
    provider: "none (cache, not a run)",
    persistence: "delivery cache (not a recorder): 1:1 with the canonical row, never a second count — the canonical report copy for a run is stored exactly once by OrchestratorAgent into mas_reports (#783); this cache exists only so the download getters (getPdfByKey/getXlsxByKey/getCsvByKey) can serve the latest run without a canonical read",
    delivery: "Download getters read the cache; delivery itself goes through the bridge",
    canonical: ["screener-agent.persistRun (cache only)"],
    status: "canonical",
  },
  {
    id: "preset-resolution",
    name: "Preset resolution",
    entry: "ScreenerPresetManager / presets tab (?tab=screeners&view=presets) / schedules carrying a preset id",
    engine: "screenerPresetResolution.resolvePresetFilter (run-time, caller-owned)",
    provider: "none",
    persistence: "mas_screener_presets (pre-existing store)",
    delivery: "none",
    canonical: ["screenerPresetResolution", "screenerPresets route", "doSqliteScreenerPresetAdapter"],
    status: "canonical",
    extensionPoint: "preset",
  },
  {
    id: "pattern-application",
    name: "Pattern application",
    entry: "ScreenersHub patterns tab (?tab=screeners&view=patterns) -> Apply to New Screen",
    engine: "stockPatternCatalog mapping + stockFilterToCriteria into the New Screen panel",
    provider: "none (catalog is data, not a provider)",
    persistence: "Setup catalog stock families (read-only source; no pattern store written)",
    delivery: "none",
    canonical: ["stockPatternCatalog.listStockPatterns", "PatternsPanel", "stockFilterToCriteria"],
    status: "canonical",
    extensionPoint: "pattern",
  },
];

export function stockScreenCapabilities(): readonly StockScreenCapability[] {
  return STOCK_SCREEN_CAPABILITIES;
}

export function stockScreenCapabilityById(
  id: string,
): StockScreenCapability | undefined {
  return STOCK_SCREEN_CAPABILITIES.find((c) => c.id === id);
}

/** Entries whose canonical mapping is not built yet (target or none) — the honest remainder. */
export function unbuiltStockScreenCapabilities(): StockScreenCapability[] {
  return STOCK_SCREEN_CAPABILITIES.filter((c) => c.status !== "canonical");
}
