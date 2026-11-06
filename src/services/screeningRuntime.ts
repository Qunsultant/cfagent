/**
 * Production runtime for the unified screening stack (consolidation
 * C1, issue #1201, epic #1151 R1).
 *
 * Before C1 the #1096 stack had no production caller: the Phase 0
 * ScreeningProviderRegistry, the Phase 3 goal-driven screen, and
 * backtest-on-screen were exercised only by tests, while every
 * reachable surface ran the pre-#1096 entry points. This module is
 * the wiring that closes R1 — the production registry factory and
 * the run helpers the route, the ScreenerAgent, and the schedule
 * service compose:
 *
 *  - `createLiveStockScreener` binds the registry's stock leg to the
 *    LIVE listing-feed engine (`DynamicMarketScreener.screenLive` —
 *    the same engine `ETradeService.screenMarketsAsync` serves to
 *    NLQ/MCP screens today). The Phase 0 wrapper contract calls
 *    `IMarketScreener.screenMarkets`, whose snapshot evaluator is NOT
 *    a live production path; this adapter is what makes the wrapped
 *    call honest in production. Design decision recorded on #1201:
 *    the goal-driven screen is a discovery screen, so its stock leg
 *    binds this engine rather than the ScreenerAgent DO pipeline
 *    (whose per-run PDF/XLSX generation, run lock, and richer run
 *    record belong to the raw-filter surfaces that already execute
 *    through it).
 *  - `createProductionScreeningRegistry` builds the registry via the
 *    Phase 0 default factory under the descriptor ids
 *    (SCREENING_PROVIDER_DESCRIPTORS) — options leg is the production
 *    `DynamicOptionsScreener`.
 *  - `runProductionGoalScreen` composes registry + the Phase 3
 *    ledger-backed run (`runGoalDrivenScreenWithLedger`).
 *  - `executeGoalScreenRun` is the shared caller-side seam for the
 *    route and the schedule service: run via the ScreenerAgent, then
 *    record the run on the canonical seams — one mas_reports record
 *    (#308), one screening activity entry (Phase 6), and optional
 *    Phase 6 channel delivery. A duplicate delivery (executed=false)
 *    records nothing twice.
 *  - `executeScreenBacktest` gives backtest-on-screen its production
 *    entry: daily bars from the existing Yahoo history fetch; a
 *    symbol without history is excluded by the engine with its
 *    reason — never fabricated.
 */

import type {
  OptionScreenerFilter,
  StockScreenResult,
  StockScreenerFilter,
} from "../types";
import {
  acquireUniverse,
  createDefaultScreeningRegistry,
  DynamicMarketScreener,
  type DynamicOptionsScreener,
  type IMarketScreener,
  type NasdaqUniverseSeam,
  type ScreeningProviderAssetClass,
  type ScreeningProviderRegistry,
  type YahooHistoryDeps,
  type YahooScreenerDeps,
} from "../trading";
import {
  runGoalDrivenScreenWithLedger,
  type GoalDrivenScreenResult,
  type OptionsWorkflowDeps,
} from "./goalDrivenScreen";
import type { ScreenerTask, ScreenerTaskLedger } from "./screenerTaskLedger";
import {
  buildScenario,
  type ScenarioConstraints,
  type ScenarioDefinition,
  type ScenarioShockGrid,
} from "./goalScenarioEngine";
import type {
  GoalRecord,
  ScenarioRecord,
} from "./goalScenarioStore";
import type { ScenarioConfigSnapshot } from "./goalScenarioEngine";
import { recordGoalRunOutcome } from "./goalScreenReports";
import {
  backtestScreenCandidates,
  type BacktestResult,
  type PriceBar,
} from "./screenBacktest";
import {
  createScreeningDeliverySenders,
  deliverScreeningContent,
  formatGoalScreenDelivery,
  type ScreeningChannel,
  type ScreeningChannelResult,
} from "./screeningDelivery";
import { resolveTenantChannelGate } from "./tenantChannelGate";
import { recordScreeningActivity } from "./screeningActivity";
import type { DatabaseORM } from "../orm";

/* ------------------------------------------------------------------ */
/* Production registry                                                 */
/* ------------------------------------------------------------------ */

/**
 * IMarketScreener adapter over the live listing-feed engine. The
 * wrapped `screenMarkets` call executes `screenLive` (acquireUniverse
 * "all-listings" + screenWithQuotes — the shared pipeline core), the
 * production stock screen NLQ/MCP already run.
 */
export function createLiveStockScreener(
  inner: Pick<DynamicMarketScreener, "screenLive"> = new DynamicMarketScreener(),
  seam?: NasdaqUniverseSeam
): IMarketScreener {
  return {
    async screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult> {
      // Issue #1378: forward the seam only when one is threaded —
      // a no-seam call keeps the exact pre-slice call shape
      // (single argument), which exact-args callers assert.
      return seam === undefined ? inner.screenLive(filter) : inner.screenLive(filter, seam);
    },
  };
}

export function createProductionScreeningRegistry(deps: {
  stockScreener?: IMarketScreener;
  optionsScreener: Pick<DynamicOptionsScreener, "screenOptions">;
  /** Issue #3272: when the goal run is built on a broker-neutral engine, it
   *  is registered under the neutral id instead of masquerading as E*TRADE. */
  neutralStockScreener?: IMarketScreener;
}): ScreeningProviderRegistry {
  return createDefaultScreeningRegistry({
    stockScreener: deps.stockScreener ?? createLiveStockScreener(),
    optionsScreener: deps.optionsScreener,
    ...(deps.neutralStockScreener ? { neutralStockScreener: deps.neutralStockScreener } : {}),
  });
}

/**
 * Issue #1571: a Yahoo-backed IMarketScreener for goal-screen
 * fallback runs. Composes the shared pipeline's Yahoo acquisition
 * (acquireUniverse mode "yahoo" — live Yahoo quotes adapted to the
 * pipeline quote shape, never fabricated rows) with the same
 * screenWithQuotes evaluator the listings-feed leg uses, so filter
 * semantics are identical and only the quote source changes.
 * Honest failure: a Yahoo acquisition that returns no live quote
 * throws — the runGoalDrivenScreen per-class catch records the
 * stocks leg as failed, never as a partial fabrication.
 */
export function createYahooStockScreener(
  yahooDeps: YahooScreenerDeps
): IMarketScreener {
  const inner = new DynamicMarketScreener();
  return {
    async screenMarkets(filter?: StockScreenerFilter): Promise<StockScreenResult> {
      const acquired = await acquireUniverse({ mode: "yahoo", yahooDeps });
      if (acquired.error) {
        throw new Error(acquired.error);
      }
      return inner.screenWithQuotes(acquired.quotes, filter, false);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Goal-driven screen composition                                      */
/* ------------------------------------------------------------------ */

export interface GoalScreenRunRequest {
  scenario: ScenarioDefinition;
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin?: string;
  environment?: "TEST" | "PROD";
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  /** Issue #1571: data provider for this run's stock leg (default:
   *  the listings-feed leg). "yahoo" runs the stock leg on the Yahoo
   *  engine. Serializable — the request crosses the agent RPC stub. */
  provider?: "yahoo";
  /** Issue #1571: set when the run fell back to Yahoo because the
   *  configured provider's auth was dead. Carried onto the result
   *  so the PDF provenance names it as a Yahoo fallback. */
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
  /** Issue #1571: Yahoo fetcher override for the stock leg (test
   *  seam, mirroring runScreen's req.yahooDeps). Production binds
   *  the platform Yahoo provider inside the agent. */
  yahooDeps?: YahooScreenerDeps;
}

/** The ScreenerAgent surface executeGoalScreenRun depends on (RPC stub in production). */
export interface GoalScreenAgentPort {
  runGoalScreen(
    req: GoalScreenRunRequest
  ): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }>;
}

/**
 * The production goal-screen run: registry over production engines +
 * the Phase 3 ledger-backed execution. Composed by ScreenerAgent with
 * its DO-owned ledger; unit-tested here with fake engines + a memory
 * ledger.
 */
export async function runProductionGoalScreen(input: {
  ledger: ScreenerTaskLedger;
  stockScreener?: IMarketScreener;
  /** Issue #3272: the broker-neutral stock engine and the id it answers to. */
  neutralStockScreener?: IMarketScreener;
  stockProviderId?: string;
  optionsScreener: Pick<DynamicOptionsScreener, "screenOptions">;
  scenario: ScenarioDefinition;
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  userLogin?: string;
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  now?: Date;
  /** Issue #3186 (step 3c): the goal options leg's pipeline deps
   *  (storage, canonical, goal-leg shapeReport/deliver, claims,
   *  queue) - WITHOUT the screener. The pipeline runs on
   *  input.optionsScreener when it is a full DynamicOptionsScreener
   *  (production always is); a Pick-only fake fails closed, never
   *  silently. Absent -> the registry path, unchanged. */
  optionsWorkflow?: Omit<OptionsWorkflowDeps, "screener">;
}): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }> {
  const registry = createProductionScreeningRegistry({
    stockScreener: input.stockScreener,
    optionsScreener: input.optionsScreener,
    ...(input.neutralStockScreener ? { neutralStockScreener: input.neutralStockScreener } : {}),
  });
  let optionsWorkflow: OptionsWorkflowDeps | undefined;
  if (input.optionsWorkflow) {
    const screener = input.optionsScreener as DynamicOptionsScreener;
    if (typeof screener.fetchChains !== "function") {
      throw new Error(
        "options workflow: the goal options leg needs a full DynamicOptionsScreener, not a screenOptions-only pick",
      );
    }
    optionsWorkflow = { screener, ...input.optionsWorkflow };
  }
  return runGoalDrivenScreenWithLedger({
    ledger: input.ledger,
    registry,
    ...(input.stockProviderId ? { stockProviderId: input.stockProviderId } : {}),
    scenario: input.scenario,
    trigger: input.trigger,
    idempotencyKey: input.idempotencyKey,
    userLogin: input.userLogin,
    assetClasses: input.assetClasses,
    symbols: input.symbols,
    baseStockFilter: input.baseStockFilter,
    baseOptionsFilter: input.baseOptionsFilter,
    now: input.now,
    ...(optionsWorkflow ? { optionsWorkflow } : {}),
  });
}

/**
 * Rebuild a runnable ScenarioDefinition from a stored goal + scenario
 * (Phase 0 store). The store does not persist a direction — the
 * taxonomy default applies, exactly as buildScenario defaults it —
 * and a config snapshot embedded in the stored constraints (the
 * persistScenario idiom) is restored as the scenario's snapshot;
 * absent one, the current defaults' snapshot is used.
 */
export function scenarioFromStoredRecord(
  goal: GoalRecord,
  record: ScenarioRecord
): ScenarioDefinition {
  const base = buildScenario({ goalKind: goal.kind, portfolioRef: record.portfolioRef });
  const stored = (record.constraints ?? {}) as Record<string, unknown>;
  const { configSnapshot, ...storedConstraints } = stored;
  return {
    ...base,
    portfolioRef: record.portfolioRef,
    shocks: (record.shocks as ScenarioShockGrid | undefined) ?? base.shocks,
    constraints: {
      ...base.constraints,
      ...(storedConstraints as ScenarioConstraints),
    },
    configSnapshot:
      (configSnapshot as ScenarioConfigSnapshot | undefined) ?? base.configSnapshot,
  };
}

/* ------------------------------------------------------------------ */
/* Shared run execution (route + schedule service)                     */
/* ------------------------------------------------------------------ */

export interface GoalScreenRunOutcome {
  taskId: string;
  taskStatus: string;
  executed: boolean;
  result?: GoalDrivenScreenResult;
  delivery?: ScreeningChannelResult[];
  /** Consolidation C4 (#1329): the canonical mas_reports row id for
   *  this run (the serve stage verifies it). Undefined when the run
   *  was not executed or the store write was skipped. */
  canonicalReportId?: string;
  /** Issue #1571: the fallback marker for this run, when the stock
   *  leg fell back to Yahoo. Mirrors the marker on the result. */
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
}

/**
 * Run one goal-driven screen through the ScreenerAgent and record it
 * on the canonical seams. Duplicate deliveries (the agent returns
 * executed=false) store nothing and deliver nothing — the existing
 * ledger record is the run.
 */
export async function executeGoalScreenRun(input: {
  agent: GoalScreenAgentPort;
  orm: DatabaseORM;
  env: unknown;
  userLogin: string;
  scenario: ScenarioDefinition;
  scenarioSource: "built" | "stored";
  trigger: "manual" | "scheduled";
  idempotencyKey: string;
  environment?: "TEST" | "PROD";
  assetClasses?: ScreeningProviderAssetClass[];
  symbols?: string[];
  baseStockFilter?: StockScreenerFilter;
  baseOptionsFilter?: OptionScreenerFilter;
  deliver?: ScreeningChannel[];
  emailTo?: string;
  actor?: string;
  /** Issue #1571: provider + fallback marker for the stock leg,
   *  forwarded to the agent request (see GoalScreenRunRequest). */
  provider?: "yahoo";
  providerFallback?: {
    from: "etrade";
    reason: string;
  };
  yahooDeps?: YahooScreenerDeps;
}): Promise<GoalScreenRunOutcome> {
  const run = await input.agent.runGoalScreen({
    scenario: input.scenario,
    trigger: input.trigger,
    idempotencyKey: input.idempotencyKey,
    userLogin: input.userLogin,
    environment: input.environment,
    assetClasses: input.assetClasses,
    symbols: input.symbols,
    baseStockFilter: input.baseStockFilter,
    baseOptionsFilter: input.baseOptionsFilter,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
    ...(input.yahooDeps ? { yahooDeps: input.yahooDeps } : {}),
  });
  if (!run.executed || !run.result) {
    return { taskId: run.task.id, taskStatus: run.task.status, executed: false };
  }
  const result = run.result;
  // Issue #1571: the recorded result carries the fallback marker even
  // if the agent did not stamp it — the canonical report body embeds
  // `result`, so this is what the Runs read surface and the PDF
  // generator see. The agent stamps it too, before generating
  // artifacts; this is the caller-side guarantee, not a second
  // source of truth.
  if (input.providerFallback && !result.providerFallback) {
    result.providerFallback = input.providerFallback;
  }
  if (input.provider && !result.provider) {
    result.provider = input.provider;
  }
  const summary =
    `Goal screen (${result.goalKind}/${result.outlook}) ${result.status}: ` +
    `${result.counts.hits} hit(s) from ${result.counts.stocksScanned} stocks + ` +
    `${result.counts.optionsUnderlyingsScanned} option underlyings.`;
  const canonical = input.orm.storeCanonicalReport({
    runId: `goal-screen:${run.task.id}`,
    generationId: `goal-screen:${run.task.id}`,
    title: `Goal screen — ${result.goalKind} (${result.outlook})`,
    source: "goal_screen",
    summary,
    body: {
      trigger: input.trigger,
      scenarioSource: input.scenarioSource,
      taskId: run.task.id,
      // Issue #1998: the caller run id (D2) the run's data captures
      // are keyed by — the provenance link from this record alone
      // to mas_data_captures (the report runId itself is
      // goal-screen:<taskId>; captures use the idempotency key).
      idempotencyKey: input.idempotencyKey,
      result,
      // Issue #1335: artifact keys ride top-level so the Runs read
      // surface (runSummaryFromReport) finds them — the result object
      // alone is not in its lookup chain.
      ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
      ...(result.pdfStatus ? { pdfStatus: result.pdfStatus } : {}),
      ...(result.pdfError ? { pdfError: result.pdfError } : {}),
      ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
      ...(result.xlsxStatus ? { xlsxStatus: result.xlsxStatus } : {}),
      ...(result.xlsxError ? { xlsxError: result.xlsxError } : {}),
      ...(result.csvKey ? { csvKey: result.csvKey } : {}),
      ...(result.csvStatus ? { csvStatus: result.csvStatus } : {}),
      ...(result.csvError ? { csvError: result.csvError } : {}),
    },
    createdAt: result.completedAt,
    userLogin: input.userLogin,
  });
  recordGoalRunOutcome(input.orm.getSql(), {
    id: `goal-screen:${run.task.id}`,
    trigger: input.trigger,
    status: result.status === "failed" ? "failed" : result.status === "partial" ? "partial" : "completed",
    scanned: result.counts.stocksScanned + result.counts.optionsUnderlyingsScanned,
    matched: result.counts.hits,
    pdfKey: result.pdfKey,
    xlsxKey: result.xlsxKey,
    csvKey: result.csvKey,
    reportUrl: result.pdfKey
      ? `/api/screening/goal-screen/report.pdf?key=${encodeURIComponent(result.pdfKey)}`
      : undefined,
    origin: "goal-screen-direct",
    createdAt: result.completedAt,
  });
  recordScreeningActivity(input.orm as any, {
    userLogin: input.userLogin,
    kind: "screen_run",
    summary: `Goal screen ${result.goalKind} (${result.outlook}) — ${result.status}, ${result.counts.hits} hit(s).`,
    detail: {
      taskId: run.task.id,
      status: result.status,
      counts: result.counts,
      trigger: input.trigger,
      scenarioSource: input.scenarioSource,
    },
    refId: run.task.id,
    actor: input.actor,
  });

  let delivery: ScreeningChannelResult[] | undefined;
  if (input.deliver && input.deliver.length > 0) {
    const formatted = formatGoalScreenDelivery(result);
    // Issue #3169: the tenant channel gate, resolved best-effort
    // (null = ungated, prior behavior — see tenantChannelGate).
    const channelGate = await resolveTenantChannelGate(input.env, input.userLogin);
    delivery = await deliverScreeningContent({
      channels: input.deliver,
      subject: formatted.subject,
      text: formatted.text,
      event: "screening.goal_screen",
      data: {
        taskId: run.task.id,
        goalKind: result.goalKind,
        outlook: result.outlook,
        status: result.status,
        hits: result.counts.hits,
      },
      emailTo: input.emailTo,
      senders: createScreeningDeliverySenders(input.env, input.orm, input.userLogin),
      sql: input.orm as any,
      userLogin: input.userLogin,
      actor: input.actor,
      ...(channelGate ? { channelGate } : {}),
    });
  }
  return {
    taskId: run.task.id,
    taskStatus: run.task.status,
    executed: true,
    result,
    ...(delivery ? { delivery } : {}),
    ...(canonical?.reportId ? { canonicalReportId: canonical.reportId } : {}),
    ...(input.providerFallback ? { providerFallback: input.providerFallback } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Backtest-on-screen                                                  */
/* ------------------------------------------------------------------ */

/**
 * Issue #1331: live price bars through the platform history deps.
 * Without deps there is no fallback to the deleted direct fetch —
 * null, so the engine excludes the symbol with its reason (the
 * documented contract), never with synthesized bars.
 */
async function fetchLivePriceBars(
  symbol: string,
  historyDeps?: YahooHistoryDeps
): Promise<PriceBar[] | null> {
  if (!historyDeps) return null;
  const bars = await historyDeps.fetchBars(symbol);
  if (!bars) return null;
  return bars.map((b) => ({ date: b.date, close: b.close }));
}

/**
 * Backtest-on-screen over live daily history (Yahoo). Candidates are
 * the caller's symbols as stock candidates; a symbol whose history
 * cannot be fetched is excluded by the engine with its reason —
 * provenance stays "live" because every supplied bar is a live fetch
 * and nothing is synthesized.
 */
export async function executeScreenBacktest(input: {
  symbols: string[];
  fetchPrices?: (symbol: string) => Promise<PriceBar[] | null>;
  /** Issue #1331: platform history deps, bound by the caller (the
   * backtest route binds route-resolved + outcome-tracked). */
  historyDeps?: YahooHistoryDeps;
  folds?: number;
  holdingBars?: number;
  capital?: number;
}): Promise<BacktestResult> {
  const fetchPrices =
    input.fetchPrices ?? ((symbol: string) => fetchLivePriceBars(symbol, input.historyDeps));
  const prices: Record<string, PriceBar[]> = {};
  for (const symbol of input.symbols) {
    const bars = await fetchPrices(symbol);
    if (bars && bars.length > 0) prices[symbol] = bars;
  }
  return backtestScreenCandidates({
    candidates: input.symbols.map((symbol) => ({ symbol, kind: "stock" as const })),
    prices,
    provenance: "live",
    folds: input.folds,
    holdingBars: input.holdingBars,
    capital: input.capital,
  });
}
