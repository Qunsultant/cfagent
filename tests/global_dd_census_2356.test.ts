// @vitest-environment node
/**
 * #2356 (#1976 step 4c) — the GLOBAL D-D census pin (ADR 0022
 * D-D.2, mandated warn-first and never landed until this
 * slice; audit R-4).
 *
 * Three surfaces are counted over ALL of src/:
 *
 *  1. storage-shaped exec sites (the landed pins' pattern)
 *     ABOVE the data layer — pinned as an exact, shrink-only
 *     allow-list: every remaining file with its site count
 *     and its owning slice. A NEW above-layer site, a new
 *     file, or a count change in either direction fails.
 *  2. `(x as any).exec(` sites above the layer — same
 *     treatment (the landed pins were blind to this surface).
 *  3. D1 `prepare()` sites outside src/data/ — same
 *     treatment (never counted by any prior census).
 *
 * Plus the by-table rule (the R-2/R-3 lesson — file-list
 * pins let writers of already-ported tables survive in
 * unlisted files): for every table ported in steps 1–3 or
 * in this slice, the pin detects the table's WRITER SET
 * (INSERT / UPDATE / DELETE / CREATE TABLE / CREATE INDEX
 * statements naming the table, directly or through a
 * same-file or imported table-name constant, comments
 * stripped) across all of src/ and pins it exactly. A
 * writer of a ported table outside its port fails the pin
 * WHEREVER the file lives. Known bypasses of OTHER slices'
 * tables are named allow-list entries with owners — they
 * are not fixed here and they are not silently passed.
 *
 * And mas_settings (audit §5, gate G-7): pinned as a
 * remainder while unported (4 writers / 3 ensurers); since
 * step 4g (#2390) the pin asserts the port-owned end state —
 * the settings adapter is the only writer and only ensurer.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_FILES: string[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) SRC_FILES.push(path);
  }
}
walk("src");
const TEXT = new Map(SRC_FILES.map((f) => [f, readFileSync(f, "utf8")]));

/** Strip // and block comments while respecting string literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? "";
    if (mode === "line") {
      if (c === "\n") { mode = null; out += c; } else out += " ";
      i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = null; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (mode) {
      out += c;
      if (c === "\\") { out += n; i += 2; continue; }
      if (c === mode) mode = null;
      i++; continue;
    }
    if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
    if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") mode = c;
    out += c; i++;
  }
  return out;
}
const STRIPPED = new Map(SRC_FILES.map((f) => [f, stripComments(TEXT.get(f)!)]));
const isAboveLayer = (f: string): boolean => !f.startsWith("src/data/");

const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
const ANY_EXEC_PATTERN = /\(\s*[\w.[\]]+\s+as\s+any\s*\)\s*\.\s*exec\s*\(/g;
const PREPARE_PATTERN = /\.prepare\s*\(/g;

const countIn = (pattern: RegExp, file: string): number =>
  (TEXT.get(file)!.match(pattern) ?? []).length;

function aboveLayerCounts(pattern: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of SRC_FILES) {
    if (!isAboveLayer(f)) continue;
    const n = countIn(pattern, f);
    if (n > 0) out.set(f, n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surface 1 — storage-shaped sites above the layer (shrink-only allow-list)
// ---------------------------------------------------------------------------

/** [file, sites, owner] — every entry retires only in its owner's slice. */
const STORAGE_ALLOW_LIST: Array<[string, number, string]> = [
  ["src/agents/orchestrator.ts", 3, "permanent remainder: ADR-out ai-chat lift (3)"],
  ["src/services/learnings.ts", 7, "R-1 gated — NOT step 4c (two-host question open)"],
  ["src/security/sessionStore.ts", 2, "step 5 (SessionStore / kv_store)"],
  ["src/actors/cfAgentsAdapter.ts", 1, "permanent — Agents-SDK shim (ADR-out)"],
  ["src/services/receiptSurface.ts", 2, "issue #2543 receipt read-back: meter + tier reads over the sql seam (usage port drops detail_json; no port path exists)"],
];

/** The step-4c families: zero above-layer sites remain. */
const STEP4C_SERVICE_FILES = [
  "src/services/goalScenarioStore.ts",
  "src/services/jobOutcomes.ts",
  "src/services/strategyReviews.ts",
  "src/services/outcomeTracking.ts",
  "src/services/screeningActivity.ts",
  "src/services/comparisonRunner.ts",
  "src/services/recommendationKernel.ts",
  "src/services/reflection.ts",
] as const;

/** The step-4c statements live in the data layer, exactly. */
const STEP4C_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteGoalScenarioAdapter.ts", 18],
  ["src/data/doSqliteJobOutcomeAdapter.ts", 13],
  ["src/data/doSqliteStrategyReviewAdapter.ts", 6],
  ["src/data/doSqliteOutcomeTrackingAdapter.ts", 3],
  ["src/data/doSqliteComparisonLedgerAdapter.ts", 4],
  ["src/data/doSqliteScreeningActivityAdapter.ts", 5],
  ["src/data/inMemoryGoalScenarioAdapter.ts", 0],
  ["src/data/inMemoryJobOutcomeAdapter.ts", 0],
  ["src/data/inMemoryStrategyReviewAdapter.ts", 0],
  ["src/data/inMemoryOutcomeTrackingAdapter.ts", 0],
  ["src/data/inMemoryComparisonLedgerAdapter.ts", 0],
  ["src/data/inMemoryScreeningActivityAdapter.ts", 0],
  ["src/data/goalScenarioPorts.ts", 0],
  ["src/data/jobOutcomePorts.ts", 0],
  ["src/data/strategyReviewPorts.ts", 0],
  ["src/data/outcomeTrackingPorts.ts", 0],
  ["src/data/comparisonLedgerPorts.ts", 0],
  ["src/data/screeningActivityPorts.ts", 0],
  ["src/data/createEvidenceSatellitePorts.ts", 0],
];

/** The step-4b families: zero above-layer sites remain. */
const STEP4B_SERVICE_FILES = [
  "src/services/championChallenger.ts",
  "src/services/strategyWeightsV2.ts",
  "src/services/strategyPolicyState.ts",
  "src/services/adaptationAudit.ts",
  "src/services/strategyBankReselection.ts",
] as const;

/** The step-4b statements live in the data layer, exactly.
 *  (Adaptation's two mas_settings SELECTs are served by the
 *  step-3a read-only settings adapter, counted there.) */
const STEP4B_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteChallengerAdapter.ts", 15],
  ["src/data/doSqliteStrategyWeightsAdapter.ts", 11],
  ["src/data/doSqliteStrategyPolicyAdapter.ts", 11],
  ["src/data/doSqliteAdaptationAuditAdapter.ts", 5],
  ["src/data/doSqliteReselectionAdapter.ts", 3],
  ["src/data/inMemoryChallengerAdapter.ts", 0],
  ["src/data/inMemoryStrategyWeightsAdapter.ts", 0],
  ["src/data/inMemoryStrategyPolicyAdapter.ts", 0],
  ["src/data/inMemoryAdaptationAuditAdapter.ts", 0],
  ["src/data/inMemoryReselectionAdapter.ts", 0],
  ["src/data/challengerPorts.ts", 0],
  ["src/data/strategyWeightsPorts.ts", 0],
  ["src/data/strategyPolicyPorts.ts", 0],
  ["src/data/adaptationAuditPorts.ts", 0],
  ["src/data/reselectionPorts.ts", 0],
  ["src/data/createStrategyClusterPorts.ts", 0],
];

/** The step-4a family: zero above-layer sites remain. */
const STEP4A_SERVICE_FILES = [
  "src/agents/orchestrator/asyncJobs.ts",
  "src/agents/routes/maintenance.ts",
  "src/agentic/chainExecutor.ts",
  "src/agents/routes/workflowRuns.ts",
  "src/services/asyncJobGate.ts",
  "src/services/shardJobs.ts",
] as const;

/** The step-4a statements live in the data layer, exactly. */
const STEP4A_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteAsyncJobAdapter.ts", 34],
  ["src/data/inMemoryAsyncJobAdapter.ts", 0],
  ["src/data/asyncJobPorts.ts", 0],
  ["src/data/createAsyncJobPorts.ts", 0],
];

/** The step-4d families: zero above-layer sites remain. */
const STEP4D_SERVICE_FILES = [
  "src/services/scheduledReports.ts",
  "src/agents/orchestrator/autopilot.ts",
  "src/agents/routes/screenerPresets.ts",
  "src/agents/routes/reports.ts",
  "src/agents/routes/autopilot.ts",
  "src/agents/orchestrator/chatTurnHelpers.ts",
  "src/services/reportSemanticIndex.ts",
  "src/services/screenerPresetResolution.ts",
] as const;

/** The step-4d statements live in the data layer, exactly. */
const STEP4D_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteAutopilotStateAdapter.ts", 3],
  ["src/data/doSqlitePolicyVerdictAdapter.ts", 4],
  ["src/data/doSqliteReportConfirmationAdapter.ts", 9],
  ["src/data/doSqliteScreenerPresetAdapter.ts", 6],
  // 21 at step 4d; 22 since #2528 slice 1: the canonical
  // backfill's updateBody UPDATE (artifact-key merge on
  // redelivery) lives in the data layer, behind the port.
  ["src/data/doSqliteCanonicalReportStoreAdapter.ts", 22],
  ["src/data/doSqliteUsageEventAdapter.ts", 4],
  ["src/data/orchestratorTablePorts.ts", 0],
  ["src/data/canonicalReportStorePorts.ts", 0],
  ["src/data/createOrchestratorTablePorts.ts", 0],
  ["src/data/createCanonicalReportStorePorts.ts", 0],
  ["src/data/inMemoryOrchestratorTableAdapters.ts", 0],
  ["src/data/inMemoryCanonicalReportStoreAdapters.ts", 0],
];

/** The step-4e families: zero above-layer sites remain. */
const STEP4E_SERVICE_FILES = [
  "src/agents/research-agent.ts",
  "src/agents/screener-agent.ts",
] as const;

/** The step-4e statements live in the data layer, exactly. */
const STEP4E_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/doSqliteResearchStoreAdapter.ts", 20],
  ["src/data/doSqliteScreenRunLockAdapter.ts", 7],
  ["src/data/researchStorePorts.ts", 0],
  ["src/data/inMemoryResearchStoreAdapters.ts", 0],
  ["src/data/createResearchStorePorts.ts", 0],
  ["src/data/screenRunLockPorts.ts", 0],
  ["src/data/inMemoryScreenRunLockAdapter.ts", 0],
  ["src/data/createScreenRunLockPorts.ts", 0],
];

/** The step-4g settings doors: zero above-layer sites remain. */
const STEP4G_SERVICE_FILES = [
  "src/agents/orchestrator/reportDispatch.ts",
  "src/services/screeningFlags.ts",
] as const;

/** The step-4f index helpers: zero above-layer sites remain. */
const STEP4F_SERVICE_FILES = [
  "src/services/masRetentionIndexes.ts",
  "src/services/frameworkQueueIndexes.ts",
] as const;

/** The step-4f index statements live in the data layer, exactly. */
const STEP4F_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/masRetentionIndexSchema.ts", 3],
  ["src/data/frameworkQueueIndexSchema.ts", 1],
];

describe("global D-D census: surface 1 — storage-shaped sites above the layer", () => {
  it("the above-layer population is exactly the shrink-only allow-list", () => {
    const actual = aboveLayerCounts(STORAGE_EXEC_PATTERN);
    const expected = new Map(STORAGE_ALLOW_LIST.map(([f, n]) => [f, n]));
    expect(actual).toEqual(expected);
    const total = [...actual.values()].reduce((a, b) => a + b, 0);
    // Base (7c985ca0) measured 240; step 4c retires exactly 48
    // (the six families minus learnings' 7, which is R-1-gated)
    // → 192; step 4b (#2357) retires the strategy cluster's 48
    // → 144; step 4a (#2358) retires the async-job family's 33
    // plus 2 of orchestrator.ts's sites (the mas_async_jobs DDL
    // third; its remaining 17 are #2359's) → 109; step 4d
    // (#2359) retires 55 more (scheduledReports 24,
    // orchestrator 13 of 17, reportDispatch 4 of 7, presets 4,
    // autopilot 3+1, reports 3, chatTurnHelpers 1,
    // reportSemanticIndex 1, screenerPresetResolution 1) → 54;
    // step 4d-2 (#2360) retires the payments route's 8 → 46;
    // step 4e (#2361) retires research-agent's 21 and
    // screener-agent's 1 → 24; step 4f (#2362) retires the
    // two index helpers' 3 → 21; step 4g (#2390) retires
    // reportDispatch's 3, screeningFlags' 4 and the
    // orchestrator's G-7 CREATE → 13; issue #2543 adds the
    // receipt surface's 2 (meter + tier reads over the sql
    // seam — the usage port drops detail_json) → 15.
    expect(total).toBe(15);
  });

  for (const file of STEP4C_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4C_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4B_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4B_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4A_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4A_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4D_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4D_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4E_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4E_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4F_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4F_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(sites);
    });
  }

  for (const file of STEP4G_SERVICE_FILES) {
    it(`${file} holds zero storage-exec sites (serves through its port)`, () => {
      expect(countIn(STORAGE_EXEC_PATTERN, file)).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Surface 2 — (x as any).exec sites above the layer
// ---------------------------------------------------------------------------

const ANY_EXEC_ALLOW_LIST: Array<[string, number, string]> = [
  // EMPTY since step 4e (#2361): both facade-shim sites retired.
  // The surface stays pinned — any new (x as any).exec above the
  // layer fails this census.
];

describe("global D-D census: surface 2 — (x as any).exec above the layer", () => {
  it("the population is exactly the allow-list", () => {
    const actual = aboveLayerCounts(ANY_EXEC_PATTERN);
    const expected = new Map(ANY_EXEC_ALLOW_LIST.map(([f, n]) => [f, n]));
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Surface 3 — D1 prepare() sites outside src/data/
// ---------------------------------------------------------------------------

const PREPARE_ALLOW_LIST: Array<[string, number, string]> = [
  ["src/aspects/transactionAspect.ts", 1, "permanent — the aspect's own D1 leg, in-role"],
  // Since step 4f (#2362) this is the ONLY above-layer prepare
  // population: the surface is fully regularized.
];

describe("global D-D census: surface 3 — prepare() outside the data layer", () => {
  it("the population is exactly the allow-list", () => {
    const actual = new Map<string, number>();
    for (const f of SRC_FILES) {
      if (!isAboveLayer(f)) continue;
      const n = countIn(PREPARE_PATTERN, f);
      if (n > 0) actual.set(f, n);
    }
    const expected = new Map(PREPARE_ALLOW_LIST.map(([f, n]) => [f, n]));
    expect(actual).toEqual(expected);
  });
});

/** The step-4f D1 families (#2362): the retired modules hold zero
 *  prepare sites; the statements live in the data layer, exactly. */
const STEP4F_PREPARE_SERVICE_FILES = [
  "src/services/quoteSourceSetting.ts",
  "src/telemetry/d1ResourceUsageAdapter.ts",
  "src/telemetry/resourceRollupStore.ts",
] as const;

const STEP4F_PREPARE_DATA_LAYER_FILES: Array<[string, number]> = [
  ["src/data/d1QuoteSourceAdapter.ts", 3],
  ["src/data/d1ResourceUsageAdapter.ts", 3],
  ["src/data/d1ResourceRollupAdapter.ts", 8],
  ["src/data/quoteSourcePorts.ts", 0],
  ["src/data/inMemoryQuoteSourceAdapter.ts", 0],
  ["src/data/createQuoteSourcePorts.ts", 0],
  ["src/data/resourceRollupPorts.ts", 0],
  ["src/data/inMemoryResourceRollupAdapter.ts", 0],
  ["src/data/createResourceRollupPorts.ts", 0],
];

describe("global D-D census: step-4f prepare placement", () => {
  for (const file of STEP4F_PREPARE_SERVICE_FILES) {
    it(`${file} holds zero prepare sites (serves through its port)`, () => {
      expect(countIn(PREPARE_PATTERN, file)).toBe(0);
    });
  }

  for (const [file, sites] of STEP4F_PREPARE_DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} prepare sites`, () => {
      expect(countIn(PREPARE_PATTERN, file)).toBe(sites);
    });
  }
});

// ---------------------------------------------------------------------------
// By-table writer sets for ported tables (steps 1–3 + step 4c + step 4b + step 4a + step 4d)
// ---------------------------------------------------------------------------

const PORTED_TABLES = [
  // step 1
  "mas_data_providers", "mas_data_provider_routes", "mas_data_captures",
  // step 2
  "mas_opportunity_scans", "mas_discovery_runs", "mas_discovery_setup_runs",
  "mas_discovery_alerts", "mas_iv_history", "mas_strategy_profiles",
  "mas_feed_snapshots", "paused_schedules", "mas_enrichment_runs",
  // step 3a (+ marketplace)
  "mas_messages", "mas_events", "mas_memory", "mas_watchlists",
  "mas_transactions", "mas_trades", "mas_categories", "mas_external_ads",
  "mas_ads", "mas_referrals", "webhook_replay_nonces",
  "mas_options_chain_cache", "mas_reports",
  // step 4c (this slice)
  "mas_goals", "mas_scenarios", "mas_outcomes", "mas_job_outcomes",
  "mas_job_outcomes_meta", "mas_strategy_reviews", "mas_outcome_tracking",
  "mas_comparison_arm_outcomes", "mas_screening_activity",
  // step 4b (#2357)
  "mas_challengers", "mas_challenger_approvals", "mas_challenger_promotions",
  "mas_strategy_bank_active", "mas_strategy_weights_v2",
  "mas_strategy_weight_versions", "mas_strategy_weight_caps",
  "mas_strategy_gates", "mas_strategy_bank_proposals", "mas_adaptation_audit",
  // step 4a (#2358)
  "mas_async_jobs",
  // step 4d (#2359)
  "mas_autopilot", "mas_policy_verdicts", "mas_report_confirmations",
  "mas_screener_presets", "usage_events",
  // step 4e (#2361)
  "research_settings", "research_task_store", "research_runs",
  "research_evaluations", "screen_run_locks",
  // step 4f (#2362)
  "quote_source_setting", "resource_sql_ops", "resource_daily_rollups",
  "resource_alert_state", "resource_comparison_reports",
] as const;

/**
 * The pinned writer set per ported table: the layer files that
 * own the writes, plus NAMED bypass entries (above-layer
 * writers owned by later slices — audit R-2/R-3). A writer
 * appearing anywhere else fails the pin.
 */
const PORTED_TABLE_WRITERS: Record<string, { layer: string[]; bypass?: Record<string, string> }> = {
  mas_data_providers: { layer: ["src/data/doSqliteProviderConfigAdapter.ts"] },
  mas_data_provider_routes: { layer: ["src/data/doSqliteProviderConfigAdapter.ts"] },
  mas_data_captures: { layer: ["src/data/doSqliteProviderCaptureAdapter.ts"] },
  mas_opportunity_scans: { layer: ["src/data/doSqliteScanRunAdapter.ts"] },
  mas_discovery_runs: { layer: ["src/data/doSqliteDiscoveryRunAdapter.ts"] },
  mas_discovery_setup_runs: { layer: ["src/data/doSqliteDiscoverySetupAdapter.ts"] },
  mas_discovery_alerts: { layer: ["src/data/doSqliteDiscoveryAlertAdapter.ts"] },
  mas_iv_history: { layer: ["src/data/doSqliteIvHistoryAdapter.ts"] },
  mas_strategy_profiles: { layer: ["src/data/doSqliteStrategyProfileAdapter.ts"] },
  mas_feed_snapshots: { layer: ["src/data/doSqliteFeedSnapshotAdapter.ts"] },
  paused_schedules: {
    layer: ["src/data/doSqlitePausedScheduleAdapter.ts"],
  },
  mas_enrichment_runs: { layer: ["src/data/doSqliteEnrichmentAdapter.ts"] },
  mas_messages: {
    layer: ["src/data/doSqliteOrmAdapters.ts", "src/data/ormSchema.ts", "src/data/masRetentionIndexSchema.ts"],
  },
  mas_events: {
    layer: ["src/data/ormSchema.ts", "src/data/masRetentionIndexSchema.ts"],
    bypass: { "src/agents/routes/maintenance.ts": "#2489 auditConfirm-gated selective wipe" },
  },
  mas_memory: { layer: ["src/data/doSqliteOrmAdapters.ts", "src/data/ormSchema.ts"] },
  mas_watchlists: { layer: ["src/data/ormSchema.ts"] },
  mas_transactions: {
    layer: ["src/data/doSqliteOrmAdapters.ts", "src/data/ormSchema.ts"],
  },
  mas_trades: { layer: ["src/data/ormFacade.ts"] },
  mas_categories: { layer: ["src/data/ormFacade.ts"] },
  mas_external_ads: { layer: ["src/data/ormFacade.ts"] },
  mas_ads: {
    layer: ["src/data/doSqliteMarketplaceAdapter.ts", "src/data/ormSchema.ts"],
  },
  mas_referrals: { layer: ["src/data/ormSchema.ts"] },
  webhook_replay_nonces: { layer: ["src/data/ormFacade.ts"] },
  mas_options_chain_cache: { layer: ["src/data/ormFacade.ts"] },
  mas_reports: { layer: ["src/data/doSqliteCanonicalReportStoreAdapter.ts"] },
  mas_goals: { layer: ["src/data/doSqliteGoalScenarioAdapter.ts"] },
  mas_scenarios: { layer: ["src/data/doSqliteGoalScenarioAdapter.ts"] },
  mas_outcomes: { layer: ["src/data/doSqliteGoalScenarioAdapter.ts"] },
  mas_job_outcomes: {
    layer: ["src/data/doSqliteJobOutcomeAdapter.ts"],
  },
  mas_job_outcomes_meta: {
    layer: ["src/data/doSqliteJobOutcomeAdapter.ts"],
    bypass: { "src/agents/routes/maintenance.ts": "#2489 selective wipe watermark reset" },
  },
  mas_strategy_reviews: { layer: ["src/data/doSqliteStrategyReviewAdapter.ts"] },
  mas_outcome_tracking: { layer: ["src/data/doSqliteOutcomeTrackingAdapter.ts"] },
  mas_comparison_arm_outcomes: { layer: ["src/data/doSqliteComparisonLedgerAdapter.ts"] },
  mas_screening_activity: { layer: ["src/data/doSqliteScreeningActivityAdapter.ts"] },
  mas_challengers: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_challenger_approvals: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_challenger_promotions: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_strategy_bank_active: { layer: ["src/data/doSqliteChallengerAdapter.ts"] },
  mas_strategy_weights_v2: { layer: ["src/data/doSqliteStrategyWeightsAdapter.ts"] },
  mas_strategy_weight_versions: { layer: ["src/data/doSqliteStrategyWeightsAdapter.ts"] },
  mas_strategy_weight_caps: { layer: ["src/data/doSqliteStrategyPolicyAdapter.ts"] },
  mas_strategy_gates: { layer: ["src/data/doSqliteStrategyPolicyAdapter.ts"] },
  mas_strategy_bank_proposals: { layer: ["src/data/doSqliteReselectionAdapter.ts"] },
  mas_adaptation_audit: { layer: ["src/data/doSqliteAdaptationAuditAdapter.ts"] },
  mas_async_jobs: { layer: ["src/data/doSqliteAsyncJobAdapter.ts"] },
  mas_autopilot: { layer: ["src/data/doSqliteAutopilotStateAdapter.ts"] },
  mas_policy_verdicts: { layer: ["src/data/doSqlitePolicyVerdictAdapter.ts"] },
  mas_report_confirmations: { layer: ["src/data/doSqliteReportConfirmationAdapter.ts"] },
  mas_screener_presets: { layer: ["src/data/doSqliteScreenerPresetAdapter.ts"] },
  usage_events: { layer: ["src/data/doSqliteUsageEventAdapter.ts"] },
  research_settings: { layer: ["src/data/doSqliteResearchStoreAdapter.ts"] },
  research_task_store: { layer: ["src/data/doSqliteResearchStoreAdapter.ts"] },
  research_runs: { layer: ["src/data/doSqliteResearchStoreAdapter.ts"] },
  research_evaluations: { layer: ["src/data/doSqliteResearchStoreAdapter.ts"] },
  screen_run_locks: { layer: ["src/data/doSqliteScreenRunLockAdapter.ts"] },
  quote_source_setting: { layer: ["src/data/d1QuoteSourceAdapter.ts", "src/data/migrationRunner.ts"] },
  resource_sql_ops: { layer: ["src/data/d1ResourceUsageAdapter.ts", "src/data/migrationRunner.ts"] },
  resource_daily_rollups: { layer: ["src/data/d1ResourceRollupAdapter.ts", "src/data/migrationRunner.ts"] },
  resource_alert_state: { layer: ["src/data/d1ResourceRollupAdapter.ts", "src/data/migrationRunner.ts"] },
  resource_comparison_reports: { layer: ["src/data/d1ResourceRollupAdapter.ts", "src/data/migrationRunner.ts"] },
};

const WRITE_VERB =
  "(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?[^;]*?ON)";

/** Table-name constants (name -> table) for imported consts;
 *  short ambiguous names (bare TABLE) resolve per-file only. */
const GLOBAL_CONSTANTS = new Map<string, string>();
for (const text of STRIPPED.values()) {
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z_0-9]+)"/g)) {
    if ((PORTED_TABLES as readonly string[]).includes(m[2]) && m[1].length > 5) {
      GLOBAL_CONSTANTS.set(m[1], m[2]);
    }
  }
}

function fileWritesTable(file: string, table: string): boolean {
  const text = STRIPPED.get(file)!;
  const constants = new Map(GLOBAL_CONSTANTS);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z_0-9]+)"/g)) {
    if ((PORTED_TABLES as readonly string[]).includes(m[2])) constants.set(m[1], m[2]);
  }
  const names = [`${table}(?![\\w])`];
  for (const [name, t] of constants) {
    if (t === table) names.push(`\\$\\{${name}\\}`);
  }
  return new RegExp(`${WRITE_VERB}\\s+(?:${names.join("|")})`, "gi").test(text);
}

describe("global D-D census: writer sets by table for ported tables", () => {
  for (const table of PORTED_TABLES) {
    it(`${table} is written only by its port (+ named bypasses)`, () => {
      const expected = PORTED_TABLE_WRITERS[table];
      const allowed = new Set([
        ...expected.layer,
        ...Object.keys(expected.bypass ?? {}),
      ]);
      const actual = SRC_FILES.filter((f) => fileWritesTable(f, table));
      expect(actual.sort()).toEqual([...allowed].sort());
    });
  }
});

// ---------------------------------------------------------------------------
// G-7 — mas_settings writer sets (audit §5.3; port-owned since #2390)
// ---------------------------------------------------------------------------

describe("global D-D census: G-7 — mas_settings (port-owned since #2390)", () => {
  it("the only value writer is the settings port's adapter", () => {
    const re = /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+mas_settings(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual([
      "src/data/doSqliteOrmAdapters.ts",
    ]);
  });

  it("the only DDL ensurer is the settings port's adapter", () => {
    const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+mas_settings(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual([
      "src/data/doSqliteOrmAdapters.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Step 5 (#2432, slice 5a) — the SessionStore funnel census
// ---------------------------------------------------------------------------
//
// Step 5's population is invisible to the three surfaces above:
// the client funnel (src/security/durableKv.ts) speaks an HTTP
// protocol to the SessionStore DO, so no storage-shaped exec or
// prepare() site exists above the DO itself (audit §1.2, R-2).
// This section pins that population in the step-4 style:
//
//  - every composition site of the funnel's four entry points
//    (createStoreKv / createStoreSender / listStoreEntries /
//    consumeStoreKey) outside the funnel itself, as an exact
//    [file, function, bucket] multiset — a NEW call site
//    anywhere in src/, a removed one, or a bucket change fails
//    (shrink-only: entries retire only in their owning step-5
//    slice, 5b–5e, which edits this list in its own PR);
//  - kv_store's writer set: the SessionStore DO is the table's
//    only writer and only DDL ensurer (the by-table rule,
//    G-7 style).
//
// The bucket is the call's namespaceName — a string literal, a
// same-file string constant (DRAFT_OWNER_NAMESPACE,
// SLACK_LINK_STORE_NAMESPACE), createStoreSender's positional
// bucket, or "<dynamic>" for the one per-call bucket
// (publicOAuth's sessionstore: credential-ref resolver, whose
// bucket is part of the reference being resolved).

const FUNNEL_FUNCTIONS = [
  "createStoreKv",
  "createStoreSender",
  "listStoreEntries",
  "consumeStoreKey",
] as const;

function sameFileStringConst(text: string, name: string): string | null {
  const m = text.match(
    new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;]+)?=\\s*"([^"]+)"`),
  );
  return m ? m[1] : null;
}

function funnelCallSites(): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const f of SRC_FILES) {
    if (f === "src/security/durableKv.ts") continue; // the funnel itself
    const text = STRIPPED.get(f)!;
    for (const fn of FUNNEL_FUNCTIONS) {
      for (const m of text.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))) {
        const window = text.slice(m.index, m.index + 500);
        let bucket: string | null = null;
        if (fn === "createStoreSender") {
          const args = window.match(
            /^createStoreSender\s*\(\s*[^,]+,\s*"([^"]+)"/,
          );
          bucket = args ? args[1] : null;
        } else {
          const literal = window.match(/namespaceName:\s*"([^"]+)"/);
          if (literal) {
            bucket = literal[1];
          } else {
            const ident = window.match(
              /namespaceName:\s*([A-Za-z_$][A-Za-z0-9_$]*)/,
            );
            if (ident) bucket = sameFileStringConst(text, ident[1]);
          }
        }
        out.push([f, fn, bucket ?? "<dynamic>"]);
      }
    }
  }
  return out.sort((a, b) => a.join("|").localeCompare(b.join("|")));
}

/** [file, funnel function, bucket] — the step-5 population (audit §2.3).
 *  Step 5b (#2433) delta, honestly recorded: server.ts's three
 *  sessions-bucket list sites RETIRE into session.ts's
 *  listSessionFamilyEntries factory (one new listStoreEntries
 *  site there); the family's composition root
 *  (src/data/createSessionPorts.ts) is a NEW funnel composition
 *  site (2x createStoreKv + 2x listStoreEntries, bucket
 *  "sessions" — its env and namespace factory functions);
 *  session.ts's own createStoreKv site REMAINS (the flag-off
 *  branch still calls the funnel from inside the factory). */
const STEP5_FUNNEL_SITES: Array<[string, string, string]> = [
  ["src/agents/routes/adminTenantQueues.ts", "listStoreEntries", "sessions"],
  ["src/agents/routes/adminTenantQueues.ts", "listStoreEntries", "sessions"],
  ["src/agents/routes/kvWipe.ts", "createStoreKv", "etrade"],
  ["src/agents/routes/kvWipe.ts", "listStoreEntries", "etrade"],
  ["src/agents/routes/kvWipe.ts", "listStoreEntries", "sessions"],
  ["src/data/createSessionPorts.ts", "createStoreKv", "sessions"],
  ["src/data/createSessionPorts.ts", "createStoreKv", "sessions"],
  ["src/data/createSessionPorts.ts", "listStoreEntries", "sessions"],
  ["src/data/createSessionPorts.ts", "listStoreEntries", "sessions"],
  ["src/payments/draftOwners.ts", "consumeStoreKey", "payments"],
  ["src/payments/draftOwners.ts", "createStoreKv", "payments"],
  ["src/security/apiKeys.ts", "createStoreKv", "api_keys"],
  ["src/security/etradeOAuth.ts", "consumeStoreKey", "etrade"],
  ["src/security/etradeOAuth.ts", "createStoreKv", "etrade"],
  ["src/security/etradeOAuth.ts", "listStoreEntries", "etrade"],
  ["src/security/iaaaAuditStore.ts", "createStoreSender", "sessions"],
  ["src/security/iaaaAuditStore.ts", "listStoreEntries", "sessions"],
  ["src/security/publicOAuth.ts", "createStoreKv", "<dynamic>"],
  ["src/security/publicOAuth.ts", "createStoreKv", "public"],
  ["src/security/session.ts", "createStoreKv", "sessions"],
  ["src/security/session.ts", "listStoreEntries", "sessions"],
  ["src/server.ts", "listStoreEntries", "etrade"],
  ["src/services/agenticPayments.ts", "consumeStoreKey", "payments"],
  ["src/services/agenticPayments.ts", "createStoreKv", "payments"],
  ["src/trading/channels/intake.ts", "consumeStoreKey", "slack_principal_links"],
  ["src/trading/channels/intake.ts", "createStoreKv", "slack_principal_links"],
];

describe("global D-D census: step 5 — SessionStore funnel composition sites (#2432)", () => {
  it("the funnel's composition sites are exactly the pinned set", () => {
    expect(funnelCallSites()).toEqual(STEP5_FUNNEL_SITES);
  });
});

describe("global D-D census: step 5 — kv_store writer set (#2432)", () => {
  it("the only value writer is the SessionStore DO", () => {
    const re = /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+kv_store(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual(["src/security/sessionStore.ts"]);
  });

  it("the only DDL ensurer is the SessionStore DO", () => {
    const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+kv_store(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual(["src/security/sessionStore.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Step 5b (#2433) — session/identity family port composition
// ---------------------------------------------------------------------------
//
// The "composes ports" evidence for 5b: the family's factories
// route through the composition root / wired helpers as an
// exact [file, function, count] set (definition sites counted,
// comments stripped). A factory that stops composing ports —
// or a new composition site — fails here.

const STEP5B_PORT_FUNCTIONS = [
  "createSessionPorts",
  "sessionFamilyPorts",
  "wiredMembershipStore",
  "wiredAccessRequestStore",
  "listSessionFamilyEntries",
] as const;

function step5bPortSites(): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = [];
  for (const f of SRC_FILES) {
    const text = STRIPPED.get(f)!;
    for (const fn of STEP5B_PORT_FUNCTIONS) {
      const n = (text.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length;
      if (n > 0) out.push([f, fn, n]);
    }
  }
  return out.sort((a, b) => a.join("|").localeCompare(b.join("|")));
}

const STEP5B_PORT_SITES: Array<[string, string, number]> = [
  ["src/data/createSessionPorts.ts", "createSessionPorts", 1],
  ["src/security/iaaaLogin.ts", "sessionFamilyPorts", 1],
  ["src/security/iaaaLogin.ts", "wiredMembershipStore", 2],
  ["src/security/session.ts", "createSessionPorts", 1],
  ["src/security/session.ts", "listSessionFamilyEntries", 1],
  ["src/security/session.ts", "sessionFamilyPorts", 10],
  ["src/security/session.ts", "wiredAccessRequestStore", 1],
  ["src/security/session.ts", "wiredMembershipStore", 1],
  ["src/server.ts", "listSessionFamilyEntries", 3],
  ["src/server.ts", "wiredAccessRequestStore", 1],
  ["src/server.ts", "wiredMembershipStore", 10],
];

describe("global D-D census: step 5b — session family port composition sites (#2433)", () => {
  it("the family's factories compose ports at exactly the pinned sites", () => {
    expect(step5bPortSites()).toEqual(STEP5B_PORT_SITES);
  });

  it("sessions-bucket funnel use outside the factories is exactly the named remainder", () => {
    // Outside the family's factories (session.ts) and its
    // composition root (createSessionPorts.ts), the only
    // remaining funnel-for-"sessions" sites are the audit
    // family's (5d) and the admin-tenant-queues route's
    // ctx-injected listing seams (its ctx overrides remain
    // the composition point there). Any NEW outside-factory
    // consumer for this family's bucket fails here.
    const factories = new Set([
      "src/security/session.ts",
      "src/data/createSessionPorts.ts",
    ]);
    const rest = funnelCallSites().filter(
      ([f, , bucket]) => bucket === "sessions" && !factories.has(f),
    );
    expect(rest).toEqual([
      ["src/agents/routes/adminTenantQueues.ts", "listStoreEntries", "sessions"],
      ["src/agents/routes/adminTenantQueues.ts", "listStoreEntries", "sessions"],
      ["src/agents/routes/kvWipe.ts", "listStoreEntries", "sessions"],
      ["src/security/iaaaAuditStore.ts", "createStoreSender", "sessions"],
      ["src/security/iaaaAuditStore.ts", "listStoreEntries", "sessions"],
    ]);
  });
});
