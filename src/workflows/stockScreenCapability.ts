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
    engine: "Broker workflow when available; planner direct fallback",
    provider: "planner default (etrade) or requested",
    persistence: "Canonical report store via runScreen",
    delivery: "Delivery bridge via runScreen",
    canonical: ["screenExecutionBroker.shardsForUniverse", "stockScreenPlanner.planStockScreenRun", "screenRunAspects"],
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
    canonical: ["screenExecutionBroker.shardsForUniverse", "screenRunAspects"],
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
    engine: "Async-job chain (planFeedStart + shardSubmit) + collation",
    provider: "requested, else planner default (etrade); fallback forces yahoo with marker",
    persistence: "Canonical report store per shard",
    delivery: "Delivery bridge via chain",
    canonical: ["stockScreenPlanner.planScheduledScreen", "screenerWorkflowFlow.collateShards (qualified partial rule)", "screenRunAspects"],
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
    canonical: ["goalStockScreenSpec (source: goal, deliver: false)", "stockScreenPlanner.planGoalStockLeg", "screenExecutionBroker goal guard (returns null)"],
    status: "target",
    current: "goalDrivenScreen.buildGoalScreenPlan + goalScreenDispatch own execution; translation (spec + broker guard + planner mapping, #2882) built, execution migration still open",
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
    id: "report-generation",
    name: "Report generation (generate/store/serve)",
    entry: "unifiedReportPipeline via ReportAssetAgent (analysis-done consumer)",
    engine: "unifiedReportPipeline.runReportPipeline (persisted result input)",
    provider: "none (report generation never fetches)",
    persistence: "mas_reports via storeReportStage (idempotent on generationId)",
    delivery: "Delivery bridge via serveReportStage consumers",
    canonical: ["stageReportConsumer.consumeAnalysisDone", "stageMessage (analysis-done)"],
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
    id: "preset-resolution",
    name: "Preset resolution",
    entry: "ScreenerPresetManager / schedules carrying a preset id",
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
