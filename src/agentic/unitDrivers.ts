/**
 * Issue #4178 (step 1 of programme #4177, sub-issue of #3549) —
 * the unit-driver table: every registry entry in the canonical
 * flow resolves to a driver, and every driver is reachable from
 * a registry entry.
 *
 * A driver is the executable entry point for one capability:
 * "module#export" (routes name their handler module the same
 * way). The table is a BINDING, not an implementation: it names
 * the function that already executes the unit — pipeline jobs
 * (runFeedJob / runEnrichJob / runAnalyzeJob / runGenerateJob /
 * runDeliverJob), provider-adapter factories, dataset-store
 * factories, scheduled executors moved into port drivers
 * (social, resource, index, feed), route handlers, and the
 * report renderers/publishers.
 *
 * Scope boundary (the #4178 narrowing, 2026-11-11):
 *  - Family registries for options, goal, strategy, and
 *    trading/saga/payment belong to #3959 — no driver row here
 *    names a family registry that does not exist yet.
 *  - Provider/broker selection as a stage input belongs to
 *    #3960 — these rows bind the adapters as they are today
 *    (registry-fixed sourceId); the selection mechanism rides
 *    on #3960, it is not re-implemented here.
 *  - The store stage's async-job executor disposition belongs
 *    to #3642 — the store rows below bind the persistence ports
 *    (dataset stores, mas_reports, R2), which execute; they do
 *    not build the executeAsyncJob store executor and do not
 *    decide #3642.
 *  - Phantom operations (qa.run_sweep, qa.supervised_fix,
 *    search.opportunity_hunt) are never units — #4174 item 6.
 *
 * Step 2 (Stock Copilot composition) turns these entry points
 * into invocations; this slice only proves the binding exists
 * (tests/unit_drivers_4178.test.ts pins both directions).
 */
import type { CapabilityEntry } from "./capabilityRegistry";

/** How a driver is invoked. */
export type UnitDriverKind =
  | "pipeline-job"
  | "provider-adapter"
  | "store-handler"
  | "scheduled-executor"
  | "route"
  | "handler";

/** One binding: a registry capability id and its executable. */
export interface UnitDriver {
  /** The capability id this driver executes (a CAPABILITY_REGISTRY id). */
  capabilityId: CapabilityEntry["id"];
  kind: UnitDriverKind;
  /**
   * Executable entry point, "src/path/module.ts#exportedFunction".
   * Routes name their handler module the same way.
   */
  entryPoint: string;
}

/** Resolution failure: an unknown capability id is a caller bug, never a silent miss. */
export class UnitDriverNotFoundError extends Error {
  readonly capabilityId: string;
  constructor(capabilityId: string) {
    super(
      `No unit driver is registered for capability "${capabilityId}". ` +
        `A canonical-flow unit without a driver is a registration gap, not a fallback.`,
    );
    this.name = "UnitDriverNotFoundError";
    this.capabilityId = capabilityId;
  }
}

/**
 * The driver table. One row per shipped canonical-flow registry
 * entry; planned entries (no adapter yet) carry no row — that is
 * what "planned" means.
 */
export const UNIT_DRIVERS: readonly UnitDriver[] = [
  // ---- Feed ----
  {
    capabilityId: "feed-dataprovider",
    kind: "pipeline-job",
    entryPoint: "src/services/feedJobs.ts#runFeedJob",
  },
  {
    capabilityId: "feed-screener-pipeline",
    kind: "handler",
    entryPoint:
      "src/agents/orchestrator/meshScreenDoor.ts#runStockScreenViaDoor",
  },
  {
    capabilityId: "feed-provider-yahoo",
    kind: "provider-adapter",
    entryPoint:
      "src/trading/dataProviders/adapters.ts#createYahooDataProvider",
  },
  {
    capabilityId: "feed-provider-etrade",
    kind: "provider-adapter",
    entryPoint:
      "src/trading/dataProviders/adapters.ts#createETradeDataProvider",
  },
  {
    capabilityId: "feed-provider-alpaca",
    kind: "provider-adapter",
    entryPoint:
      "src/trading/dataProviders/adapters.ts#createAlpacaDataProvider",
  },
  {
    capabilityId: "feed-provider-nasdaq",
    kind: "provider-adapter",
    entryPoint:
      "src/trading/dataProviders/adapters.ts#createNasdaqDataProvider",
  },
  {
    capabilityId: "feed-index-refresh",
    kind: "scheduled-executor",
    entryPoint: "src/services/indexListJob.ts#executeIndexListRefreshJob",
  },
  // ---- Enrich ----
  {
    capabilityId: "enrich-dataset",
    kind: "pipeline-job",
    entryPoint: "src/services/enrichJobs.ts#runEnrichJob",
  },
  // ---- Analyze ----
  {
    capabilityId: "analyze-dataset",
    kind: "pipeline-job",
    entryPoint: "src/services/analyzeJobs.ts#runAnalyzeJob",
  },
  // ---- Generate ----
  {
    capabilityId: "generate-screener-pdf",
    kind: "handler",
    entryPoint: "src/trading/screenerReportPdf.ts#generateScreenerPdf",
  },
  {
    capabilityId: "generate-screener-xlsx",
    kind: "handler",
    entryPoint: "src/trading/screenerReportXlsx.ts#generateScreenerXlsx",
  },
  {
    capabilityId: "generate-screener-csv",
    kind: "handler",
    entryPoint: "src/trading/screenerReportCsv.ts#generateScreenerCsv",
  },
  {
    capabilityId: "generate-options-pdf",
    kind: "handler",
    entryPoint: "src/trading/optionsReportPdf.ts#generateOptionsPdf",
  },
  {
    capabilityId: "generate-options-xlsx",
    kind: "handler",
    entryPoint: "src/trading/optionsReportXlsx.ts#generateOptionsXlsx",
  },
  {
    capabilityId: "generate-research-pdf",
    kind: "handler",
    entryPoint: "src/trading/researchReportPdf.ts#generateResearchPdf",
  },
  // ---- Store ----
  {
    capabilityId: "store-mas-reports",
    kind: "store-handler",
    entryPoint:
      "src/services/scheduledReports.ts#storeReportAtGenerationWithR2",
  },
  {
    capabilityId: "store-r2-binaries",
    kind: "store-handler",
    entryPoint:
      "src/services/scheduledReports.ts#storeReportAtGenerationWithR2",
  },
  {
    capabilityId: "store-feed-dataset",
    kind: "store-handler",
    entryPoint:
      "src/data/createFeedDatasetPorts.ts#createFeedDatasetAdapter",
  },
  {
    capabilityId: "store-enriched-dataset",
    kind: "store-handler",
    entryPoint:
      "src/data/createEnrichedDatasetPorts.ts#createEnrichedDatasetAdapter",
  },
  {
    capabilityId: "store-analyzed-dataset",
    kind: "store-handler",
    entryPoint:
      "src/data/createAnalyzedDatasetPorts.ts#createAnalyzedDatasetPorts",
  },
  {
    capabilityId: "store-generated-dataset",
    kind: "store-handler",
    entryPoint:
      "src/data/createGeneratedDatasetPorts.ts#createGeneratedDatasetPorts",
  },
  {
    capabilityId: "store-delivery-dataset",
    kind: "store-handler",
    entryPoint:
      "src/data/createDeliveryDatasetPorts.ts#createDeliveryDatasetPorts",
  },
  {
    capabilityId: "store-resource-rollup",
    kind: "scheduled-executor",
    entryPoint: "src/agents/resourceGoals.ts#runResourceRollup",
  },
  {
    capabilityId: "store-resource-comparison",
    kind: "scheduled-executor",
    entryPoint: "src/agents/resourceGoals.ts#runResourceComparison",
  },
  // ---- Serve ----
  {
    capabilityId: "serve-options-latest",
    kind: "route",
    entryPoint:
      "src/agents/routes/etradeOptions.ts#handleEtradeOptionsRoutes",
  },
  {
    capabilityId: "serve-report-pdf",
    kind: "route",
    entryPoint:
      "src/agents/routes/screenerResearch.ts#handleScreenerResearchRoutes",
  },
  {
    capabilityId: "serve-feed-dataset",
    kind: "store-handler",
    entryPoint:
      "src/data/feedDatasetPorts.ts#resolveFeedQuotesFromArtifact",
  },
  // ---- Deliver ----
  {
    capabilityId: "deliver-slack",
    kind: "handler",
    entryPoint:
      "src/events/screenerPublishers.ts#publishScreenerCompleted",
  },
  {
    capabilityId: "deliver-email",
    kind: "handler",
    entryPoint:
      "src/agents/orchestrator/reportDispatch.ts#sendReportEmail",
  },
  {
    capabilityId: "deliver-channel",
    kind: "route",
    entryPoint:
      "src/agents/routes/screenerResearch.ts#handleScreenerResearchRoutes",
  },
  {
    capabilityId: "deliver-social",
    kind: "scheduled-executor",
    entryPoint: "src/agents/social/goalExecutor.ts#executeSocialGoal",
  },
  {
    capabilityId: "deliver-resource-cap-alert",
    kind: "scheduled-executor",
    entryPoint: "src/agents/resourceGoals.ts#runResourceCapAlert",
  },
];

const DRIVERS_BY_ID = new Map<string, UnitDriver>(
  UNIT_DRIVERS.map((d) => [d.capabilityId, d]),
);

/** The driver for a capability id, or undefined when none is registered. */
export function unitDriverFor(capabilityId: string): UnitDriver | undefined {
  return DRIVERS_BY_ID.get(capabilityId);
}

/**
 * The driver for a capability id. Throws UnitDriverNotFoundError
 * by name — an unregistered unit is a registration gap, never a
 * silent miss.
 */
export function resolveUnitDriver(capabilityId: string): UnitDriver {
  const driver = DRIVERS_BY_ID.get(capabilityId);
  if (!driver) throw new UnitDriverNotFoundError(capabilityId);
  return driver;
}
