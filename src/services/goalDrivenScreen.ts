/**
 * Issue #1122 (epic #1096 Phase 3) — Screeners v2: goal/scenario-driven
 * stock + options screens.
 *
 * A Phase 1 scenario (goalScenarioEngine.ScenarioDefinition) becomes a
 * screen plan — goal outlook, the taxonomy's gate-admissible
 * structures, and filters derived from the scenario's constraints
 * (DTE window, liquidity floor, spread cap) — and the run executes
 * through the Phase 0 ScreeningProvider registry ONLY. There is no
 * second screening implementation here and no parallel pipeline: this
 * service is a plan + orchestration layer over the existing provider
 * contract, the way researchDiscovery is a mode over researchPipeline.
 *
 * Partial semantics follow the screenerEvents contract (#462): one
 * asset class failing yields a QUALIFIED PARTIAL result — the other
 * class's hits plus the failed class and its reason, never presented
 * as a complete screen. Both classes failing is a failure. Zero hits
 * is a legitimate complete result, distinct from partial.
 *
 * Durability: runGoalDrivenScreenWithLedger adopts the screener task
 * ledger (#607 — the screener mirror of researchTaskLedger #577) for
 * goal-driven runs: idempotent by run key (a duplicate delivery
 * returns the existing record and does NOT re-execute), heartbeat,
 * the ledger's deterministic outcome evaluation, and total failure
 * ending ESCALATED, visible to a human.
 *
 * Issue #3186 (step 3c): the options leg migrates onto the one
 * options pipeline - goal dispatch becomes a CALLER on it (#2038 Q1),
 * not a parallel executor. The registry path stays until every entry
 * migrates; it is the legacy entry, not a second implementation.
 *
 * READ-ONLY: screening never places, modifies, or cancels orders.
 */

import type {
  OptionScreenerFilter,
  StockScreenResult,
  StockScreenerFilter,
  ScreenedStockItem,
  Env,
} from "../types";
import type { Outlook } from "./researchGates";
import type { GoalKind } from "./goalScenarioStore";
import {
  GOAL_TAXONOMY,
  type ScenarioDefinition,
} from "./goalScenarioEngine";
import type {
  DynamicOptionsScreener,
  ScreeningProviderAssetClass,
  ScreeningProviderRegistry,
  ScreeningResult,
} from "../trading";
import {
  evaluateScreenerOutcome,
  type ScreenerTask,
  type ScreenerTaskLedger,
} from "./screenerTaskLedger";
import { goalStockSpecFromPlan } from "../workflows/goalStockScreenSpec";
import type { StockScreenRunSpec } from "../workflows/stockScreenRunSpec";
import type { GoalScreenCommand } from "../workflows/workflowPorts";

/**
 * Issue #4279 ([One engine] #3550 S4): the goal command's provider
 * literal, reused by the leg's signatures so they name no provider
 * brand inline (the neutrality census counts matching lines).
 */
export type GoalScreenProvider = GoalScreenCommand["provider"];
import type { OptionsCanonicalStore } from "./optionsServeRecord";
import {
  createOptionsScreenPorts,
  optionsArtifactKey,
  type OptionsDeliverFn,
  type OptionsShapeReportFn,
  type OptionsStageStorage,
} from "../workflows/optionsScreenPorts";
import { runOptionsScreenViaEngine } from "../workflows/optionsScreenEngine";
import {
  aggregateShardResults,
  runStockScreenViaEngine,
  type RunStockScreenViaEngine,
  type RunStockScreenViaEngineInput,
  type ScreenEngineAgentGates,
} from "../workflows/runStockScreenViaEngine";
import type { ScannedStock } from "../trading";
import type { StageClaimStore } from "../workflows/stageReportConsumer";
import type { StageQueueSend } from "../workflows/stageQueueTransport";

/**
 * Issue #3186 (step 3c) - the options pipeline's deps for a goal leg.
 * The screener is the same DynamicOptionsScreener the registry path
 * used; storage is the caller's DO storage (checkpoint artifacts);
 * canonical is the ORM's canonical store (the leg's mas_reports row);
 * shapeReport/deliver are the goal leg's (createGoalOptionsLegDelivery)
 * - the leg's report section + the handoff to the goal run's delivery.
 * Claims default to an in-memory store (a retried leg re-runs its
 * stages); production threads the durable mas_stage_claims store.
 */
export interface OptionsWorkflowDeps {
  screener: DynamicOptionsScreener;
  storage: OptionsStageStorage;
  /** Optional: a leg inside a composed run omits it (see
   * OptionsScreenPortDeps.canonical) — the leg writes no
   * mas_reports row; the composing run's row is the single home. */
  canonical?: OptionsCanonicalStore;
  shapeReport: OptionsShapeReportFn;
  deliver: OptionsDeliverFn;
  claims?: StageClaimStore;
  queue?: StageQueueSend | null;
}

function memoryStageClaimStore(): StageClaimStore {
  const claimed = new Set<string>();
  return {
    has: (key) => claimed.has(key),
    add: (key) => {
      claimed.add(key);
    },
    delete: (key) => {
      claimed.delete(key);
    },
  };
}

/**
 * The goal options leg as a CALLER on the one pipeline: build the
 * PlannerInput from the goal plan, run the eight stages, and map the
 * outcome back onto the ScreeningResult the leg's downstream code
 * already consumes. A failed pipeline run throws (the leg's catch
 * records it as a failed class, exactly like a registry throw); a
 * completed run returns the screen artifact's result, so the #1963
 * error-status check downstream still sees the real result status
 * (the pipeline's screen stage throws on the error case, so a
 * completed result is never an error result). The provider id is the
 * registry's options provider id when one is registered, so hits
 * keep their provenance across the migration.
 *
 * Issue #4290 — the durable path for this leg is the goal seam
 * (startGoalOptionsLegWorkflow in optionsWorkflowHost.ts): the job
 * definition persists in the workflow residency and the workflow
 * step is the engine's journal. This sync dispatch stays until the
 * cutover gaps land — the residency binds one chain source while
 * this leg's source is broker-aware (#3960), discovery-mode legs
 * need universe deps as a stage input (#4473), and the workflow
 * binding's reachability from this residency is unverified — and
 * the seam refuses discovery-mode legs by name until #4473 lands.
 */
async function runGoalOptionsLegViaWorkflow(args: {
  workflow: OptionsWorkflowDeps;
  registry: ScreeningProviderRegistry;
  plan: GoalScreenPlan;
  userLogin?: string;
  trigger: "manual" | "scheduled";
  idempotencyKey?: string;
}): Promise<ScreeningResult> {
  const { workflow } = args;
  if (!args.userLogin) {
    throw new Error(
      "options workflow: no userLogin - refusing to run the options leg without an identity",
    );
  }
  const legRunId = `goal-screen:${args.idempotencyKey ?? crypto.randomUUID()}:options`;
  const ports = createOptionsScreenPorts({
    screener: workflow.screener,
    storage: workflow.storage,
    canonical: workflow.canonical,
    shapeReport: workflow.shapeReport,
    deliver: workflow.deliver,
  });
  const outcome = await runOptionsScreenViaEngine(
    {
      runId: legRunId,
      userLogin: args.userLogin,
      trigger: args.trigger,
      request: {
        assetClass: "options",
        runIdentity: { runId: legRunId },
        trigger: args.trigger,
        provenanceTrigger: "goal",
        classInput: {
          goalPlan: {
            optionsFilter: args.plan.optionsFilter,
            structures: args.plan.structures,
          },
        },
      },
    },
    {
      stages: ports,
      claims: workflow.claims ?? memoryStageClaimStore(),
      queue: workflow.queue ?? null,
    },
  );
  if (outcome.outcome === "failed") {
    throw new Error(
      `options leg failed at ${outcome.failedStage}: ${outcome.reason ?? "unknown reason"}`,
    );
  }
  const screened = await workflow.storage.get<{ result: unknown }>(
    optionsArtifactKey(legRunId, "screen"),
  );
  if (!screened || screened.result === undefined) {
    throw new Error(
      `options leg completed but its screen artifact is missing for run ${legRunId}`,
    );
  }
  let providerId = "options-screen-workflow";
  try {
    providerId = args.registry.resolve("options").id;
  } catch {
    // No options provider registered - the workflow is the provider.
  }
  return { assetClass: "options", providerId, result: screened.result as never };
}

/**
 * Issue #4279 ([One engine] #3550 S4) - the stock pipeline's deps
 * for a goal leg. The env + agent are the S3 seam's caller-owned
 * pieces (the agent supplies the seam's gates + HISTORY read-back);
 * the remaining seam injectables ride through for tests. The
 * `runStockScreen` override exists only so a test can substitute
 * the seam (the A2A deps' `runStockScreenViaEngine?` idiom) -
 * production omits it and the leg calls the one seam directly.
 */
export interface StockWorkflowDeps {
  env: Env;
  agent: ScreenEngineAgentGates;
  /** Injectable for tests; defaults to the one S3 seam. */
  runStockScreen?: RunStockScreenViaEngine;
  workflowPort?: RunStockScreenViaEngineInput["workflowPort"];
  readWorkflowJobHistory?: RunStockScreenViaEngineInput["readWorkflowJobHistory"];
  sleep?: RunStockScreenViaEngineInput["sleep"];
  nowMs?: RunStockScreenViaEngineInput["nowMs"];
  awaitDeadlineMs?: number;
  pollIntervalMs?: number;
}

/**
 * A leg-job ScannedStock mapped onto the ScreenedStockItem the
 * goal composition consumes. The composition reads symbol +
 * counts only — the quote-detail fields the leg does not carry
 * (bid/ask, open/high/low, volume) stand on the last price (0
 * for volume: unknown, never read), and the display strings the
 * leg does not carry are empty. `change` + `previousClose` are
 * derived exactly from the two carried fields (lastPrice +
 * changePercent). The leg job's market rows hold the full quote
 * detail; nothing here invents a quote.
 */
function scannedStockToScreenedItem(scanned: ScannedStock, timestamp: string): ScreenedStockItem {
  const price = scanned.lastPrice;
  const changePercent = scanned.changePercent;
  const previousClose =
    changePercent === -100 ? price : price / (1 + changePercent / 100);
  const signal =
    scanned.signal === "BULLISH_MOMENTUM" ||
    scanned.signal === "OVERSOLD_BOUNCE" ||
    scanned.signal === "RANGE_BOUND" ||
    scanned.signal === "OVERBOUGHT"
      ? scanned.signal
      : "RANGE_BOUND";
  return {
    symbol: scanned.symbol,
    companyName: scanned.companyName,
    lastPrice: price,
    price,
    change: price - previousClose,
    changePercent,
    bid: price,
    ask: price,
    volume: 0,
    open: price,
    high: price,
    low: price,
    previousClose,
    timestamp,
    ...(scanned.rsi14 != null ? { rsi14: scanned.rsi14 } : {}),
    ...(scanned.sector ? { sector: scanned.sector } : {}),
    ...(scanned.peRatio != null ? { peRatio: scanned.peRatio } : {}),
    macdSignal: "",
    signal,
    technicalSignal: "",
    momentumScore: scanned.momentumScore,
    highlightReason: "",
  };
}

/**
 * The goal stock leg as a CALLER on the one stock engine: build the
 * canonical goal stock spec from the plan, run it through the S3
 * seam, and map the aggregate back onto the ScreeningResult the
 * leg's downstream code already consumes. A failed leg (no shard
 * succeeded) throws (the leg's catch records it as a failed class,
 * exactly like a registry throw); a completed leg returns the mapped
 * result, so the #1963 error-status check downstream still sees the
 * real result status. The provider id is the registry's stock
 * provider id when one is registered, so hits keep their provenance
 * across the migration. A symbol matched in two shards is ONE hit
 * (first shard wins) — the goal result's contract is one hit per
 * symbol, matching the direct leg; totalScanned sums across shards
 * (the unique scanned count is not derivable from the aggregates).
 */
async function runGoalStockLegViaWorkflow(args: {
  stock: StockWorkflowDeps;
  registry: ScreeningProviderRegistry;
  plan: GoalScreenPlan;
  userLogin?: string;
  trigger: "manual" | "scheduled";
  idempotencyKey?: string;
  environment?: "TEST" | "PROD";
  provider?: GoalScreenProvider;
}): Promise<ScreeningResult> {
  const { stock } = args;
  if (!args.userLogin) {
    throw new Error(
      "stock workflow: no userLogin - refusing to run the stock leg without an identity",
    );
  }
  const legRunId = `goal-screen:${args.idempotencyKey ?? crypto.randomUUID()}:stocks`;
  const spec = goalStockSpecFromPlan(args.plan, {
    goalId: args.idempotencyKey,
    userLogin: args.userLogin,
  });
  const runStockScreen = stock.runStockScreen ?? runStockScreenViaEngine;
  const outcome = await runStockScreen({
    env: stock.env,
    spec,
    userLogin: args.userLogin,
    ...(args.environment ? { environment: args.environment } : {}),
    agent: stock.agent,
    commandOverrides: {
      jobId: legRunId,
      ...(args.provider ? { provider: args.provider } : {}),
    },
    ...(stock.workflowPort !== undefined ? { workflowPort: stock.workflowPort } : {}),
    ...(stock.readWorkflowJobHistory !== undefined
      ? { readWorkflowJobHistory: stock.readWorkflowJobHistory }
      : {}),
    ...(stock.sleep !== undefined ? { sleep: stock.sleep } : {}),
    ...(stock.nowMs !== undefined ? { nowMs: stock.nowMs } : {}),
    ...(stock.awaitDeadlineMs !== undefined ? { awaitDeadlineMs: stock.awaitDeadlineMs } : {}),
    ...(stock.pollIntervalMs !== undefined ? { pollIntervalMs: stock.pollIntervalMs } : {}),
  });
  const aggregate = aggregateShardResults(outcome.results, "ALL");
  if (!aggregate.success) {
    throw new Error(
      `stock leg failed: ${aggregate.error ?? "no shard succeeded"}`,
    );
  }
  // One hit per symbol: a symbol matched in two shards (overlapping
  // index memberships) is a single hit, first shard wins.
  const seen = new Set<string>();
  const stocks: ScreenedStockItem[] = [];
  for (const scanned of aggregate.allStocks) {
    if (seen.has(scanned.symbol)) continue;
    seen.add(scanned.symbol);
    stocks.push(scannedStockToScreenedItem(scanned, aggregate.timestamp));
  }
  const result: StockScreenResult = {
    totalScanned: aggregate.totalScanned,
    totalScreened: aggregate.totalScanned,
    matchedCount: stocks.length,
    filterApplied: args.plan.stockFilter,
    filterSummary: aggregate.filterSummary ?? "",
    stocks,
    scannedAt: aggregate.timestamp,
    status: stocks.length > 0 ? "matches_found" : "no_matches",
  };
  let providerId = "stock-screen-workflow";
  try {
    providerId = args.registry.resolve("stocks").id;
  } catch {
    // No stocks provider registered - the workflow is the provider.
  }
  return { assetClass: "stocks", providerId, result };
}

/* ------------------------------------------------------------------ */
/* Screen plan                                                         */
/* ------------------------------------------------------------------ */

export interface GoalScreenPlan {
  goalKind: GoalKind;
  outlook: Outlook;
  /** Taxonomy default structures for the goal (gate-admissible families). */
  structures: string[];
  stockFilter: StockScreenerFilter;
  optionsFilter: OptionScreenerFilter;
}

const MOMENTUM_BY_OUTLOOK: Record<string, NonNullable<StockScreenerFilter["momentum"]>> = {
  bullish: "bullish_breakout",
  bearish: "bearish_pullback",
  volatile: "high_relative_volume",
  range_bound: "any",
  unknown: "any",
};

/** Merge filter fields: only fields actually set on `override` win. */
function mergeDefined<T extends object>(base: T, override?: Partial<T>): T {
  if (!override) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/**
 * Derive the screen plan from a scenario. Constraint mapping is the
 * scenario's own language (goalScenarioEngine.ScenarioConstraints):
 * dteWindow → min/max DTE, liquidityFloor → OI/volume/spread floors.
 * Caller base filters win per-field — explicit caller intent over
 * plan defaults, never the reverse.
 */
export function buildGoalScreenPlan(
  scenario: ScenarioDefinition,
  opts?: {
    symbols?: string[];
    baseStockFilter?: StockScreenerFilter;
    baseOptionsFilter?: OptionScreenerFilter;
  }
): GoalScreenPlan {
  const taxonomy = GOAL_TAXONOMY[scenario.goalKind];
  // Issue #1963 (correction): an "unknown" direction is the no-thesis
  // mode — it deliberately means "everything", i.e. momentum "any"
  // and the whole universe. It is NOT a broken direction and must NOT
  // be "fixed" to the taxonomy outlook: naming a thesis (bullish /
  // bearish) where the user stated none would misrepresent the run.
  // "Goal default" (no direction sent) is the path that resolves to
  // the taxonomy outlook.
  const outlook = scenario.direction ?? taxonomy.outlook;
  const constraints = scenario.constraints;

  const planStock: StockScreenerFilter = {
    momentum: MOMENTUM_BY_OUTLOOK[outlook] ?? "any",
  };
  const planOptions: OptionScreenerFilter = {};
  if (constraints.dteWindow) {
    planOptions.minDte = constraints.dteWindow.min;
    planOptions.maxDte = constraints.dteWindow.max;
  }
  if (constraints.liquidityFloor?.minOpenInterest !== undefined) {
    planOptions.minOpenInterest = constraints.liquidityFloor.minOpenInterest;
  }
  if (constraints.liquidityFloor?.minVolume !== undefined) {
    planOptions.minVolume = constraints.liquidityFloor.minVolume;
  }
  if (constraints.liquidityFloor?.maxSpreadPct !== undefined) {
    planOptions.maxSpreadPct = constraints.liquidityFloor.maxSpreadPct;
  }
  if (opts?.symbols && opts.symbols.length > 0) {
    planOptions.underlyingSymbols = [...opts.symbols];
  }

  return {
    goalKind: scenario.goalKind,
    outlook,
    structures: [...taxonomy.defaultStructures],
    stockFilter: mergeDefined(planStock, opts?.baseStockFilter),
    optionsFilter: mergeDefined(planOptions, opts?.baseOptionsFilter),
  };
}

/* ------------------------------------------------------------------ */
/* Unified run                                                         */
/* ------------------------------------------------------------------ */

export interface GoalScreenHit {
  assetClass: ScreeningProviderAssetClass;
  providerId: string;
  symbol: string;
  /** Plan structures this underlying is a candidate for (options hits). */
  structures?: string[];
}

export interface GoalDrivenScreenResult {
  goalKind: GoalKind;
  outlook: Outlook;
  plan: GoalScreenPlan;
  /** Issue #2882: canonical stock-leg spec, present when stocks were requested. Additive record only — execution stays goal-owned. */
  stockSpec?: StockScreenRunSpec;
  status: "complete" | "partial" | "failed";
  hits: GoalScreenHit[];
  counts: {
    stocksScanned: number;
    stocksMatched: number;
    optionsUnderlyingsScanned: number;
    optionsContractsMatched: number;
    hits: number;
  };
  /** Present whenever any requested asset class failed (screenerEvents qualification). */
  partial?: {
    failedClasses: ScreeningProviderAssetClass[];
    reasons: Record<string, string>;
  };
  completedAt: string;
  /** Issue #1571: the data provider that produced this run's stock
   *  leg. Absent keeps the default (listings-feed) shape. */
  provider?: string;
  /** Issue #1571: set when the run's stock leg fell back to Yahoo
   *  because the configured provider's auth was dead — carried so
   *  the PDF provenance names it as a Yahoo fallback, never as
   *  E*TRADE live. Mirrors the #1527 market-screen marker. */
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
  /** Issue #1998: persisted-gather summary for the stock leg, when
   *  the leg ran through the gather hook. Absent = no gather (the
   *  leg refused technical filters or did not need them). */
  gather?: import("../types").StockScreenGatherSummary;
  /** Issue #1335: stored report artifacts (PDF + XLSX + CSV), set by
   *  the agent after the run completes — 0-hit runs included. Each
   *  format records its own generated/failed state; a failed artifact
   *  never fails the run. */
  pdfKey?: string;
  pdfStatus?: "generated" | "failed";
  pdfError?: string;
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed";
  xlsxError?: string;
  csvKey?: string;
  csvStatus?: "generated" | "failed";
  csvError?: string;
}

export async function runGoalDrivenScreen(input: {
  registry: ScreeningProviderRegistry;
  /** Issue #3272: forwarded to the ledger run so the stock leg keeps its id. */
  stockProviderId?: string;
  scenario: ScenarioDefinition;
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  now?: Date;
  /** Issue #3186 (step 3c): goal dispatch as a CALLER on the one
   *  options pipeline (#2038 Q1). Present -> the options leg runs
   *  the pipeline; absent -> the registry path, unchanged. The
   *  trigger + idempotencyKey + userLogin ride the pipeline's
   *  PlannerInput + stage messages; absent an identity the leg
   *  fails closed rather than publishing under a fabricated login. */
  userLogin?: string;
  trigger?: "manual" | "scheduled";
  idempotencyKey?: string;
  optionsWorkflow?: OptionsWorkflowDeps;
  /** Issue #4279 ([One engine] #3550 S4): goal dispatch as a
   *  CALLER on the one stock engine (the S3 seam). Present -> the
   *  stock leg runs the engine; absent -> the registry path,
   *  unchanged. The environment + provider ride the leg's seam
   *  call (a goal run carrying the provider override runs its
   *  stock leg on that provider). */
  stockWorkflow?: StockWorkflowDeps;
  environment?: "TEST" | "PROD";
  provider?: GoalScreenProvider;
}): Promise<GoalDrivenScreenResult> {
  const plan = buildGoalScreenPlan(input.scenario, {
    symbols: input.symbols,
    baseStockFilter: input.baseStockFilter,
    baseOptionsFilter: input.baseOptionsFilter,
  });
  const requested: ScreeningProviderAssetClass[] = input.assetClasses ?? ["stocks", "options"];

  const hits: GoalScreenHit[] = [];
  const counts = {
    stocksScanned: 0,
    stocksMatched: 0,
    optionsUnderlyingsScanned: 0,
    optionsContractsMatched: 0,
    hits: 0,
  };
  const failedClasses: ScreeningProviderAssetClass[] = [];
  const reasons: Record<string, string> = {};
  // Issue #1998: the stock leg's gather summary, when it gathered.
  let stockGather: import("../types").StockScreenGatherSummary | undefined;

  for (const assetClass of requested) {
    try {
      const screened: ScreeningResult =
        assetClass === "stocks"
          ? input.stockWorkflow
            ? await runGoalStockLegViaWorkflow({
                stock: input.stockWorkflow,
                registry: input.registry,
                plan,
                userLogin: input.userLogin,
                trigger: input.trigger ?? "manual",
                idempotencyKey: input.idempotencyKey,
                ...(input.environment ? { environment: input.environment } : {}),
                ...(input.provider ? { provider: input.provider } : {}),
              })
            : await input.registry.screen({
                assetClass: "stocks",
                filter: plan.stockFilter,
                ...(input.stockProviderId ? { providerId: input.stockProviderId } : {}),
              })
          : input.optionsWorkflow
            ? await runGoalOptionsLegViaWorkflow({
                workflow: input.optionsWorkflow,
                registry: input.registry,
                plan,
                userLogin: input.userLogin,
                trigger: input.trigger ?? "manual",
                idempotencyKey: input.idempotencyKey,
              })
            : await input.registry.screen({ assetClass: "options", filter: plan.optionsFilter });
      // Issue #1963: a leg is failed by its RESULT STATUS, not only
      // by throwing. The options screener returns error-status
      // results without throwing (no-symbols validation error; all
      // chain fetches failed, e.g. dead E*TRADE auth), and the stock
      // screener returns "no_universe" without throwing — the old
      // code read all three as successful empty legs and reported
      // the run "complete". An error-status leg is a failed class
      // with its reason surfaced, per the #462 partial contract;
      // "no_matches" stays a legitimate empty.
      // Issue #1963 (second case): the listings-feed stock leg
      // refuses technical filters (momentum, RSI) with matchedCount 0
      // plus a validationError message (screener.ts unsupported
      // branch — the sole validationError assignment in the stock
      // screener) and status "no_matches". A validationError on the
      // stock leg is therefore also a failed class: the filter was
      // not evaluated, so "Complete, 0 hits" would be a lie.
      const legResult = screened.result as {
        status?: string;
        validationError?: string;
        fetchErrors?: Array<{ symbol?: string; reason?: string }>;
      };
      if (assetClass === "options" && legResult.status === "error") {
        failedClasses.push(assetClass);
        reasons[assetClass] =
          legResult.validationError ??
          (legResult.fetchErrors && legResult.fetchErrors.length > 0
            ? legResult.fetchErrors
                .map((e) => `${e.symbol ?? "options"}: ${e.reason ?? "fetch failed"}`)
                .join("; ")
            : "options screen failed");
        continue;
      }
      if (
        assetClass === "stocks" &&
        (legResult.status === "no_universe" || legResult.validationError)
      ) {
        failedClasses.push(assetClass);
        reasons[assetClass] =
          legResult.validationError ?? "stock universe unavailable (no_universe)";
        continue;
      }
      if (screened.assetClass === "stocks") {
        const result = screened.result as {
          totalScanned?: number;
          matchedCount?: number;
          stocks?: Array<{ symbol: string }>;
          gather?: import("../types").StockScreenGatherSummary;
        };
        if (result.gather) stockGather = result.gather;
        counts.stocksScanned = result.totalScanned ?? 0;
        counts.stocksMatched = result.matchedCount ?? result.stocks?.length ?? 0;
        for (const stock of result.stocks ?? []) {
          hits.push({ assetClass: "stocks", providerId: screened.providerId, symbol: stock.symbol });
        }
      } else {
        const result = screened.result as {
          totalUnderlyingsScanned?: number;
          matchedCount?: number;
          contracts?: Array<{ underlyingSymbol: string }>;
        };
        counts.optionsUnderlyingsScanned = result.totalUnderlyingsScanned ?? 0;
        counts.optionsContractsMatched = result.matchedCount ?? result.contracts?.length ?? 0;
        const seen = new Set<string>();
        for (const contract of result.contracts ?? []) {
          if (seen.has(contract.underlyingSymbol)) continue;
          seen.add(contract.underlyingSymbol);
          hits.push({
            assetClass: "options",
            providerId: screened.providerId,
            symbol: contract.underlyingSymbol,
            structures: [...plan.structures],
          });
        }
      }
    } catch (err) {
      failedClasses.push(assetClass);
      reasons[assetClass] = err instanceof Error ? err.message : String(err);
    }
  }

  counts.hits = hits.length;
  const status: GoalDrivenScreenResult["status"] =
    failedClasses.length === 0
      ? "complete"
      : failedClasses.length >= requested.length
        ? "failed"
        : "partial";

  return {
    goalKind: plan.goalKind,
    outlook: plan.outlook,
    plan,
    // Issue #2882: the goal stock leg's canonical spec rides
    // the result when stocks were requested. Record only:
    // nothing in the result path executes from it. (#2991:
    // the broker guard that once guaranteed this is retired —
    // the record status comes from this path, not the guard.)
    ...(requested.includes("stocks") ? { stockSpec: goalStockSpecFromPlan(plan) } : {}),
    status,
    hits,
    counts,
    ...(stockGather ? { gather: stockGather } : {}),
    ...(failedClasses.length > 0
      ? { partial: { failedClasses, reasons } }
      : {}),
    completedAt: (input.now ?? new Date()).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Ledger adoption (durable, idempotent autonomous runs)               */
/* ------------------------------------------------------------------ */

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "escalated", "cancelled"]);

/**
 * Run a goal-driven screen under the screener task ledger.
 *
 * Idempotency: any existing record carrying the run key — active or
 * terminal — is authoritative; a duplicate delivery returns it with
 * `executed: false` and the providers are never re-invoked. A fresh
 * run is claimed, started, and heartbeated before execution; total
 * failure is failed-then-escalated (the ledger's human-visible
 * terminal state), partial completion completes with the ledger's
 * partial flag + deterministic evaluation.
 */
export async function runGoalDrivenScreenWithLedger(input: {
  ledger: ScreenerTaskLedger;
  registry: ScreeningProviderRegistry;
  /** Issue #3272: the stock provider this run was built with, so the legs
   *  (and their provenance) name the engine that actually served them. */
  stockProviderId?: string;
  scenario: ScenarioDefinition;
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin?: string;
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  now?: Date;
  /** Issue #3186 (step 3c): threaded to runGoalDrivenScreen - the options leg runs the pipeline when present. */
  optionsWorkflow?: OptionsWorkflowDeps;
  /** Issue #4279 ([One engine] #3550 S4): threaded to runGoalDrivenScreen - the stock leg runs the engine when present. */
  stockWorkflow?: StockWorkflowDeps;
  environment?: "TEST" | "PROD";
  provider?: GoalScreenProvider;
}): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }> {
  const existing = (await input.ledger.list(200)).find(
    (t) => t.idempotencyKey === input.idempotencyKey
  );
  if (existing) return { task: existing, executed: false };

  const { task, created } = await input.ledger.create({
    trigger: input.trigger,
    universe: `goal:${input.scenario.goalKind}`,
    sector: input.scenario.direction,
    userLogin: input.userLogin,
    idempotencyKey: input.idempotencyKey,
  });
  if (!created) return { task, executed: false };

  await input.ledger.claim(task.id);
  await input.ledger.start(task.id);
  await input.ledger.heartbeat(task.id);

  let result: GoalDrivenScreenResult;
  try {
    result = await runGoalDrivenScreen({
      registry: input.registry,
    ...(input.stockProviderId ? { stockProviderId: input.stockProviderId } : {}),
      scenario: input.scenario,
      assetClasses: input.assetClasses,
      symbols: input.symbols,
      baseStockFilter: input.baseStockFilter,
      baseOptionsFilter: input.baseOptionsFilter,
      now: input.now,
      userLogin: input.userLogin,
      trigger: input.trigger,
      idempotencyKey: input.idempotencyKey,
      ...(input.optionsWorkflow ? { optionsWorkflow: input.optionsWorkflow } : {}),
      ...(input.stockWorkflow ? { stockWorkflow: input.stockWorkflow } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await input.ledger.fail(task.id, message);
    const escalated = await input.ledger.escalate(
      task.id,
      "goal-driven screen threw unexpectedly; awaiting human review"
    );
    return { task: escalated, executed: true };
  }

  if (result.status === "failed") {
    const reasons = result.partial
      ? Object.entries(result.partial.reasons)
          .map(([klass, reason]) => `${klass}: ${reason}`)
          .join("; ")
      : "all requested asset classes failed";
    await input.ledger.fail(task.id, reasons);
    const escalated = await input.ledger.escalate(
      task.id,
      "goal-driven screen failed on every requested asset class; awaiting human review"
    );
    return { task: escalated, executed: true, result };
  }

  const partial = result.status === "partial";
  const evaluation = evaluateScreenerOutcome(
    {
      success: true,
      runTimestamp: result.completedAt,
      totalScanned: result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
      matchedCount: result.counts.hits,
      opportunities: result.counts.hits,
      partial,
      qualificationPresent: partial ? result.partial !== undefined : false,
      error: null,
    },
    result.completedAt
  );
  const completed = await input.ledger.complete(task.id, {
    runTimestamp: result.completedAt,
    totalScanned: result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
    matchedCount: result.counts.hits,
    opportunitiesCount: result.counts.hits,
    partial,
    evaluation,
  });
  return { task: completed, executed: true, result };
}
