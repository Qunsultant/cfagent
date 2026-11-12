/**
 * Issue #1395 ([AGENTIC] Phase 1, sub-issue of #1362) — capability
 * registry.
 *
 * One typed definition per capability, read by the planner, the
 * validator, and (later, Phase 5) MCP `tools/list`. Registry ONLY:
 * it does not compile goals (Phase 2), synthesize schedules
 * (Phase 3), or expose MCP tools (Phase 5). It does not duplicate
 * #1355's execution substrate and does not rebuild #1224's executor.
 *
 * Honesty rule (same as the #1070 F1 registry): `shipped` means a
 * test passes, not that an interface exists. Every shipped entry
 * names its verification test file; `tests/capability_registry.test.ts`
 * pins that rule, the worked-example chains, and the known honesty
 * cases. Seeded from the #1362 inventory
 * (~/workspace/cfagent-rsi/agentic-capabilities-inventory.md) and
 * re-verified against the merged tree at implementation time —
 * which corrected two inventory claims:
 *  - CSV generation SHIPS: `src/trading/screenerReportCsv.ts` landed
 *    with #1346 (consumed by #1355 job2.4's generate.csv shard),
 *    after the inventory was written. The inventory's "no CSV
 *    generator — planned" seed is stale and is NOT carried over.
 *  - Channel delivery SHIPS: #1279 merged and #1310 landed as
 *    #1399, so the inventory's in_flight seed is promoted, with
 *    `tests/channel_consolidation.test.ts` as its verification.
 * Still honest: `news` is contract-only (no adapter declares it),
 * vector recall has no referencing test (in_flight, not shipped),
 * and plan-level composition memory SHIPS with #1461 (Phase 4 of
 * #1362) — see the COMPOSITION_MEMORY entry below.
 */

/**
 * The registry's stage vocabulary. #4178 (step 1 of programme
 * #4177) adds "enrich" and "analyze": the pipeline chain's two
 * middle stages had job registries but no registry home. The
 * compiler's CHAIN_STAGE_ORDER (src/orchestrate.ts) is NOT
 * extended in this slice — chains still validate against the
 * five-stage order; enrich/analyze steps become compilable when
 * the spec-based workflows land (later programme steps).
 */
export type RegistryStage =
  | "feed"
  | "enrich"
  | "analyze"
  | "generate"
  | "store"
  | "serve"
  | "deliver";

export type RegistryStatus = "shipped" | "in_flight" | "planned";

export interface CapabilityEntry {
  /** Stable id, e.g. `feed-dataprovider`. */
  id: string;
  stage: RegistryStage;
  /** What it does, in one line. */
  capability: string;
  /** Module / route / tool that implements it today. */
  source: string;
  /** Datasets and formats consumed. */
  inputs: string[];
  /** Datasets and formats produced. */
  outputs: string[];
  /** Identifier travelling with the output. */
  provenance: string;
  /** Lane / issue that owns it. */
  owner: string;
  status: RegistryStatus;
  /**
   * Test file reference, or null. REQUIRED before anything is marked
   * shipped: supported means a test passes, not that an interface
   * exists.
   */
  verification: string | null;
}

export const CAPABILITY_REGISTRY: CapabilityEntry[] = [
  // ---- Feed ----
  {
    id: "feed-dataprovider",
    stage: "feed",
    capability:
      "Quotes, options chains, universe screening, historical bars, and fundamentals via the DataProvider contract",
    source: "src/trading/dataProviders/contract.ts (#1118, epic #1116)",
    inputs: ["symbols", "universe definition", "provider credentials"],
    outputs: ["quotes", "options chains", "screened universe", "bars", "fundamentals"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "shipped",
    verification: "tests/data_provider_platform_p1.test.ts",
  },
  {
    id: "feed-dataprovider-news",
    stage: "feed",
    capability: "News articles via the DataProvider contract",
    source: "src/trading/dataProviders/contract.ts (#1118, epic #1116)",
    inputs: ["symbols"],
    outputs: ["normalized news articles"],
    provenance: "provider id + article id",
    owner: "#1118 / #1116",
    status: "planned",
    // Contract-only: the contract names `news`, but no adapter
    // declares it (contract.ts: "no declaring adapter yet") and no
    // route serves it. Must NOT seed as shipped.
    verification: null,
  },
  {
    id: "feed-screener-pipeline",
    stage: "feed",
    capability: "NASDAQ100 (and universe) screening pipeline producing scored runs",
    source: "src/trading/screenerPipeline.ts (#259, #959)",
    inputs: ["universe", "provider quotes/chains"],
    outputs: ["ScreenerRunResult"],
    provenance: "run id",
    owner: "#259 / #959",
    status: "shipped",
    verification: "tests/screener_pipeline.test.ts",
  },
  // ---- Feed: provider adapters (#4178) ----
  // One entry per declared adapter in the DataProvider registry.
  // Per-run provider/broker selection as a stage input rides on
  // #3960 — these rows bind the adapters as they are today
  // (registry-fixed sourceId); the selection mechanism is not
  // re-implemented here.
  {
    id: "feed-provider-yahoo",
    stage: "feed",
    capability:
      "Yahoo quotes, bars, fundamentals, technicals, and sentiment via the DataProvider contract",
    source: "src/trading/dataProviders/adapters.ts#createYahooDataProvider (#1118)",
    inputs: ["symbols", "universe definition"],
    outputs: ["quotes", "bars", "fundamentals", "technicals", "sentiment"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "shipped",
    verification: "tests/data_provider_yahoo_p1317.test.ts",
  },
  {
    id: "feed-provider-etrade",
    stage: "feed",
    capability:
      "E*TRADE quotes, options chains, bars, and fundamentals via the DataProvider contract",
    source: "src/trading/dataProviders/adapters.ts#createETradeDataProvider (#1118)",
    inputs: ["symbols", "universe definition", "provider credentials"],
    outputs: ["quotes", "options chains", "bars", "fundamentals"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "shipped",
    verification: "tests/etrade_adapter_reads_3937.test.ts",
  },
  {
    id: "feed-provider-alpaca",
    stage: "feed",
    capability: "Alpaca market-data quotes via the DataProvider contract",
    source: "src/trading/dataProviders/adapters.ts#createAlpacaDataProvider (#1118)",
    inputs: ["symbols", "universe definition"],
    outputs: ["quotes"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "shipped",
    verification: "tests/data_provider_alpaca_p1385.test.ts",
  },
  {
    id: "feed-provider-nasdaq",
    stage: "feed",
    capability: "Nasdaq symbols and delayed quotes via the DataProvider contract",
    source: "src/trading/dataProviders/adapters.ts#createNasdaqDataProvider (#1118)",
    inputs: ["symbols"],
    outputs: ["symbols", "delayed quotes"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "shipped",
    verification: "tests/data_provider_nasdaq_p1368.test.ts",
  },
  {
    id: "feed-provider-public",
    stage: "feed",
    capability: "Public.com quotes via the DataProvider contract",
    source: "src/trading/dataProviders/adapters.ts#createPublicDataProvider (#1118)",
    inputs: ["symbols"],
    outputs: ["quotes"],
    provenance: "provider id + symbol",
    owner: "#1118 / #1116",
    status: "planned",
    // Contract-only, mirroring feed-dataprovider-news: the
    // factory exists but no adapter is registered in the live
    // DataProviderRegistry (routes/dataProviders.ts registers
    // etrade/yahoo/alpaca/nasdaq only). Must NOT seed as shipped.
    verification: null,
  },
  // ---- Feed: ScheduledAgent feed executors (#4178) ----
  {
    id: "feed-index-refresh",
    stage: "feed",
    capability: "Index-list refresh: Wikipedia tables and ETF holdings files into the stored index lists",
    source: "src/services/indexListJob.ts#executeIndexListRefreshJob (#1980)",
    inputs: ["index list store", "index list fetch service", "index ids"],
    outputs: ["index list descriptors", "per-index failures"],
    provenance: "index id + snapshot date",
    owner: "#1980",
    status: "shipped",
    verification: "tests/index_list_goals_scheduled_1980.test.ts",
  },
  {
    id: "feed-refresh-all",
    stage: "feed",
    capability: "Hourly dispatch of every J2 feed job through the pipeline control plane's scheduled-firing seam",
    source: "src/agents/scheduledTasksPipeline.ts#dispatchScheduledPipelineJob (#3787)",
    inputs: ["feed job catalog"],
    outputs: ["per-job dispatch outcomes"],
    provenance: "goal id + dispatch time",
    owner: "#3787",
    status: "shipped",
    verification: "tests/pipeline_scheduled_goals.test.ts",
  },

  // ---- Enrich (#4178) ----
  {
    id: "enrich-dataset",
    stage: "enrich",
    capability: "Enrich a quotes copy with fundamentals, technicals, and sentiment joins into the enriched dataset",
    source: "src/services/enrichJobs.ts#runEnrichJob (#3536)",
    inputs: ["persisted quotes artifact", "fundamentals/technicals/sentiment copies"],
    outputs: ["enriched dataset artifact"],
    provenance: "feed job id + enrich job id",
    owner: "#3536",
    status: "shipped",
    verification: "tests/enrich_jobs_3536.test.ts",
  },

  // ---- Analyze (#4178) ----
  {
    id: "analyze-dataset",
    stage: "analyze",
    capability: "Apply rule sets to the enriched artifact into the analyzed dataset",
    source: "src/services/analyzeJobs.ts#runAnalyzeJob (#3537)",
    inputs: ["persisted enriched artifact", "rule sets", "thresholds"],
    outputs: ["analyzed dataset artifact", "rule gaps", "rule coverage"],
    provenance: "enrich job id + analyze job id",
    owner: "#3537",
    status: "shipped",
    verification: "tests/analyze_jobs_3537.test.ts",
  },

  // ---- Generate ----
  {
    id: "generate-screener-pdf",
    stage: "generate",
    capability: "Screener run rendered as a stored PDF report",
    source: "src/trading/screenerReportPdf.ts",
    inputs: ["ScreenerRunResult"],
    outputs: ["PDF bytes"],
    provenance: "run id + report key",
    owner: "#259",
    status: "shipped",
    verification: "tests/screener_options_pdf_pipeline.test.ts",
  },
  {
    id: "generate-screener-xlsx",
    stage: "generate",
    capability: "Screener run rendered as a stored XLSX workbook",
    source: "src/trading/screenerReportXlsx.ts",
    inputs: ["ScreenerRunResult"],
    outputs: ["XLSX bytes"],
    provenance: "run id + report key",
    owner: "#259",
    status: "shipped",
    verification: "tests/screener_xlsx_and_sector_enrichment.test.ts",
  },
  {
    id: "generate-screener-csv",
    stage: "generate",
    capability: "Screener run rendered as a stored CSV report",
    source: "src/trading/screenerReportCsv.ts (#1346; consumed by #1355 job2.4)",
    inputs: ["ScreenerRunResult", "OptionScreenResult"],
    outputs: ["CSV bytes"],
    provenance: "run id + report key (screener:csv: / options:csv:)",
    owner: "#1346 / #1355",
    status: "shipped",
    verification: "tests/sharded_jobs_p1355.test.ts",
  },
  {
    id: "generate-options-pdf",
    stage: "generate",
    capability: "Options screen rendered as a stored PDF report",
    source: "src/trading/optionsReportPdf.ts",
    inputs: ["OptionScreenResult"],
    outputs: ["PDF bytes"],
    provenance: "run id + report key",
    owner: "#915",
    status: "shipped",
    verification: "tests/options-pdf-naming.test.ts",
  },
  {
    id: "generate-options-xlsx",
    stage: "generate",
    capability: "Options screen rendered as a stored XLSX workbook",
    source: "src/trading/optionsReportXlsx.ts",
    inputs: ["OptionScreenResult"],
    outputs: ["XLSX bytes"],
    provenance: "run id + report key",
    owner: "#915",
    status: "shipped",
    verification: "tests/options_report_xlsx.test.ts",
  },
  {
    id: "generate-research-pdf",
    stage: "generate",
    capability: "Research output rendered as a stored PDF report",
    source: "src/trading/researchReportPdf.ts",
    inputs: ["research result"],
    outputs: ["PDF bytes"],
    provenance: "run id + report key",
    owner: "research pipeline",
    status: "shipped",
    verification: "tests/research-report-pdf.test.ts",
  },

  // ---- Store ----
  {
    id: "store-mas-reports",
    stage: "store",
    capability: "Canonical report store: every generated report recorded with its key/URL",
    source: "src/services/scheduledReports.ts (storeReportAtGenerationWithR2), mas_reports",
    inputs: ["generated report + metadata"],
    outputs: ["stored report record"],
    provenance: "report id + per-run key",
    owner: "screener program",
    status: "shipped",
    verification: "tests/scheduled-reports.test.ts",
  },
  {
    id: "store-r2-binaries",
    stage: "store",
    capability: "Report binaries in the R2 screener bucket",
    source: "R2 screener bucket via src/services/scheduledReports.ts",
    inputs: ["PDF/XLSX/CSV bytes"],
    outputs: ["R2 object"],
    provenance: "report key",
    owner: "screener program",
    status: "shipped",
    verification: "tests/report_body_r2_s2.test.ts",
  },
  // ---- Store: per-family dataset stores (#4178) ----
  // One persisted copy per pipeline stage: the store step of the
  // canonical flow. These rows bind the persistence ports, which
  // execute. They do NOT decide #3642 — the store stage's
  // async-job executor disposition (build it or remove "store"
  // from the PipelineStage vocabulary) belongs to #3642.
  {
    id: "store-feed-dataset",
    stage: "store",
    capability: "Persisted feed copy: one artifact per (source, dataset) with its run record; reads never fetch",
    source: "src/data/createFeedDatasetPorts.ts#createFeedDatasetAdapter (#3530)",
    inputs: ["fetched dataset rows"],
    outputs: ["stored feed artifact + run record"],
    provenance: "source id + dataset + run id",
    owner: "#3530",
    status: "shipped",
    verification: "tests/feed_jobs_s1_3530.test.ts",
  },
  {
    id: "store-enriched-dataset",
    stage: "store",
    capability: "Persisted enriched copy: one artifact per enrich job with its run record",
    source: "src/data/createEnrichedDatasetPorts.ts#createEnrichedDatasetAdapter (#3536)",
    inputs: ["enriched dataset rows"],
    outputs: ["stored enriched artifact + run record"],
    provenance: "enrich job id + run id",
    owner: "#3536",
    status: "shipped",
    verification: "tests/enriched_dataset_store_3536.test.ts",
  },
  {
    id: "store-analyzed-dataset",
    stage: "store",
    capability: "Persisted analyzed copy: one artifact per analyze job with its run record",
    source: "src/data/createAnalyzedDatasetPorts.ts#createAnalyzedDatasetPorts (#3537)",
    inputs: ["analyzed dataset rows"],
    outputs: ["stored analyzed artifact + run record"],
    provenance: "analyze job id + run id",
    owner: "#3537",
    status: "shipped",
    verification: "tests/analyzed_dataset_store_3537.test.ts",
  },
  {
    id: "store-generated-dataset",
    stage: "store",
    capability: "Persisted generated copy: one artifact per generate job with its run record",
    source: "src/data/createGeneratedDatasetPorts.ts#createGeneratedDatasetPorts (#3538)",
    inputs: ["generated report documents"],
    outputs: ["stored generated artifact + run record"],
    provenance: "generate job id + run id",
    owner: "#3538",
    status: "shipped",
    verification: "tests/generated_dataset_store_3538.test.ts",
  },
  {
    id: "store-delivery-dataset",
    stage: "store",
    capability: "Persisted delivery copy: one artifact per deliver job with its run record",
    source: "src/data/createDeliveryDatasetPorts.ts#createDeliveryDatasetPorts (#3539)",
    inputs: ["delivery outcomes per channel"],
    outputs: ["stored delivery artifact + run record"],
    provenance: "deliver job id + run id",
    owner: "#3539",
    status: "shipped",
    verification: "tests/delivery_dataset_store_3539.test.ts",
  },
  // ---- Store: ScheduledAgent resource executors (#4178) ----
  {
    id: "store-resource-rollup",
    stage: "store",
    capability: "Roll the previous UTC day's resource projection totals into daily rollup rows",
    source: "src/agents/resourceGoals.ts#runResourceRollup (#1819)",
    inputs: ["D1 resource projection"],
    outputs: ["daily rollup rows"],
    provenance: "day",
    owner: "#1819",
    status: "shipped",
    verification: "tests/resource_rollup_alert_1819.test.ts",
  },
  {
    id: "store-resource-comparison",
    stage: "store",
    capability: "Build the comparison report for the latest completed rollup day and store it",
    source: "src/agents/resourceGoals.ts#runResourceComparison (#1819)",
    inputs: ["daily rollup rows"],
    outputs: ["comparison report"],
    provenance: "day",
    owner: "#1819",
    status: "shipped",
    verification: "tests/resource_rollup_alert_1819.test.ts",
  },

  // ---- Serve ----
  {
    id: "serve-options-latest",
    stage: "serve",
    capability: "List completed options runs with their report URLs",
    source: "GET /api/options/latest",
    inputs: ["report key query"],
    outputs: ["run list with reportUrl"],
    provenance: "per-run key",
    owner: "options screener",
    status: "shipped",
    verification: "tests/options_latest_runs.test.ts",
  },
  {
    id: "serve-report-pdf",
    stage: "serve",
    capability: "Serve a stored report PDF by per-run key",
    source: "GET /api/options/report.pdf, GET /api/screener/report.pdf",
    inputs: ["per-run key"],
    outputs: ["PDF bytes"],
    provenance: "per-run key",
    owner: "screener program",
    status: "shipped",
    verification: "tests/scheduled_report_pdf_url.test.ts",
  },
  {
    id: "serve-feed-dataset",
    stage: "serve",
    capability: "Serve reads from the persisted feed copy (latest / latestUsable); a missing copy is a typed missing, never a fetch",
    source: "src/data/feedDatasetPorts.ts#resolveFeedQuotesFromArtifact (#3530)",
    inputs: ["stored feed artifact"],
    outputs: ["quotes resolution"],
    provenance: "source id + dataset",
    owner: "#3530",
    status: "shipped",
    verification: "tests/feed_jobs_s1_3530.test.ts",
  },

  // ---- Deliver ----
  {
    id: "deliver-slack",
    stage: "deliver",
    capability: "Deliver a stored report to Slack",
    source: "src/events/screenerPublishers.ts (cfpay A2A primary, #951)",
    inputs: ["stored report record"],
    outputs: ["Slack message with report link"],
    provenance: "report id + Slack channel/message id",
    owner: "#951",
    status: "shipped",
    verification: "tests/screener-publishers-pdf.test.ts",
  },
  {
    id: "deliver-email",
    stage: "deliver",
    capability: "Deliver a stored report by email",
    source: "worker EMAIL.send with EMAIL_TO_ALLOWED_DOMAINS",
    inputs: ["stored report record"],
    outputs: ["email with report link"],
    provenance: "report id + recipient",
    owner: "screener program",
    status: "shipped",
    verification: "tests/screener_email_delivery_complete.test.ts",
  },
  {
    id: "deliver-channel",
    stage: "deliver",
    capability:
      "Channel delivery via NLQ: email/Slack/voice with mapped-principal identity, shared approval engine, and signed email links",
    source:
      "src/trading/channels/intake.ts, approval.ts, signedLinks.ts (#1262 Phases 1–5)",
    inputs: ["stored report record", "resolved channel principal"],
    outputs: ["channel message with report link / approval flow"],
    provenance: "report id + channel principal login",
    owner: "#1262",
    status: "shipped",
    verification: "tests/channel_consolidation.test.ts",
  },
  // ---- Deliver: ScheduledAgent executors (#4178) ----
  {
    id: "deliver-social",
    stage: "deliver",
    capability: "Social publish: build daily drafts then publish due drafts under the approval gating",
    source: "src/agents/social/goalExecutor.ts#executeSocialGoal (#1077)",
    inputs: ["brief", "social ledger", "approvals"],
    outputs: ["drafts + publish results + catch-up"],
    provenance: "date + channel",
    owner: "#1077",
    status: "shipped",
    verification: "tests/social_goal_executor.test.ts",
  },
  {
    id: "deliver-resource-cap-alert",
    stage: "deliver",
    capability: "Resource cap alert: evaluate the UTC day-to-date against the 70%/90%/100% tiers and post breaches to Slack, deduped per budget-day",
    source: "src/agents/resourceGoals.ts#runResourceCapAlert (#1819)",
    inputs: ["D1 resource projection", "Slack destination"],
    outputs: ["alerted / undelivered / noDestination per budget"],
    provenance: "budget + day",
    owner: "#1819",
    status: "shipped",
    verification: "tests/resource_rollup_alert_1819.test.ts",
  },
];

/**
 * Scheduling substrates. Recorded, NOT decided: #1362 Phase 3 settles
 * which substrate job synthesis targets. A goal today is a cron + ONE
 * operation + a budget, not a plan.
 */
export interface SchedulingSubstrate {
  id: string;
  capability: string;
  source: string;
  decision: string;
}

export const SCHEDULING_SUBSTRATES: SchedulingSubstrate[] = [
  {
    id: "schedule-scheduled-agent",
    capability: "ScheduledAgent DO goals: ScheduledGoal { cron, operation, budgetCents }",
    source: "src/agents/scheduled-agent.ts",
    decision: "Undecided — #1362 Phase 3 decides which substrate job synthesis targets.",
  },
  {
    id: "schedule-nlq-agents-api",
    capability: "NLQ scheduling via the Cloudflare Agents Schedule API",
    source: "src/schedule.ts, src/client/jobsApi.ts",
    decision: "Undecided — #1362 Phase 3 decides which substrate job synthesis targets.",
  },
];

/**
 * Memory / vector capabilities. Not chain stages, so they live beside
 * the registry rather than inside it. The verification rule applies
 * here too: vector recall is in_flight because no test references
 * src/memory/vector-memory.ts; plan-level composition memory
 * (goal text → plan used → outcome → reuse) does not exist yet.
 */
export interface MemoryEntry {
  id: string;
  capability: string;
  source: string;
  status: RegistryStatus;
  verification: string | null;
}

export const COMPOSITION_MEMORY: MemoryEntry[] = [
  {
    id: "memory-vector-recall",
    capability: "remember(outcome) after every job; recallForPlan(goal) injects up to 8 chunks",
    source: "src/memory/vector-memory.ts",
    status: "in_flight",
    verification: null,
  },
  {
    id: "memory-report-semantic-index",
    capability: "Stored reports embedded at generation time for semantic recall",
    source: "src/services/reportSemanticIndex.ts (#337)",
    status: "shipped",
    verification: "tests/report-semantic-index.test.ts",
  },
  {
    id: "memory-plan-composition",
    capability: "Plan-level composition memory: goal text → plan used → outcome → reuse",
    source: "src/agentic/compositionMemory.ts + src/memory/vector-memory.ts rememberPlan/recallPlans (#1461, Phase 4 of #1362)",
    status: "shipped",
    verification: "tests/composition_memory.test.ts",
  },
];

/** MCP status: ~30 single-capability tools exist; chain/goal tools ship with Phase 5 (#1466). */
export const MCP_CHAIN_STATUS = {
  source: "src/mcps/openaimp/index.ts + commands.ts (per-user cfk_ keys, #180)",
  singleCapabilityTools: "shipped",
  chainTool: "shipped",
  goalTool: "shipped",
} as const;

export interface WorkedExampleStep {
  stage: RegistryStage;
  entryIds: string[];
}

export interface WorkedExample {
  id: string;
  description: string;
  steps: WorkedExampleStep[];
}

/**
 * The registry's first test: #1395's two worked examples, as chains
 * over registry entries. The NASDAQ100 → Slack chain is the full
 * chain, Slack only; yesterday's report by email is serve → deliver
 * only, reusing the stored report with no regeneration.
 */
export const WORKED_EXAMPLES: WorkedExample[] = [
  {
    id: "example-nasdaq100-slack",
    description:
      "NASDAQ100 screen → Slack: full chain, Slack only, budget-capped synthesized schedule requiring owner confirmation before it goes live",
    steps: [
      { stage: "feed", entryIds: ["feed-dataprovider", "feed-screener-pipeline"] },
      {
        stage: "generate",
        entryIds: ["generate-screener-pdf", "generate-screener-xlsx"],
      },
      { stage: "store", entryIds: ["store-mas-reports", "store-r2-binaries"] },
      { stage: "serve", entryIds: ["serve-report-pdf"] },
      { stage: "deliver", entryIds: ["deliver-slack"] },
    ],
  },
  {
    id: "example-yesterday-report-email",
    description:
      "Yesterday's report by email: serve → deliver only, stored report reused, no regeneration",
    steps: [
      { stage: "serve", entryIds: ["serve-options-latest", "serve-report-pdf"] },
      { stage: "deliver", entryIds: ["deliver-email"] },
    ],
  },
];
