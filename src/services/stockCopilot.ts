/**
 * Stock Copilot cycle (issue #3391, parent #3380) — one deterministic
 * pass of the reuse-assembled paper trading loop:
 *
 *   bars → pattern signal (src/services/patternSignals.ts, the sandbox
 *   strategy set) → portfolio sizing (#36/#1769, against the live book
 *   through #34's risk aggregation) → CVaR optimizer gate (#1361: a
 *   trade must beat no-trade) → order through the TradingPlatform seam
 *   (Alpaca) → tracked position WITH its exit plan → next cycles
 *   evaluate the exit (strategy exit, stop, target) for every open
 *   position. Open positions and their exit plans are the loop's
 *   operational state (src/services/stockCopilotStore.ts); durable
 *   decision history for performance measurement is MVP2 (#3397),
 *   deliberately not built here.
 *
 * Hard boundaries (#3391):
 * - PAPER ONLY. Before any order, the cycle resolves the Alpaca
 *   environment through the adapter's own resolver (#3158,
 *   resolveAlpacaTradingBase — the same function the platform uses
 *   internally, so the guard and the platform can never disagree).
 *   A live resolution refuses the whole cycle with a named error and
 *   zero orders, whatever the source (pin, selection, inference).
 * - Flag OFF (STOCK_COPILOT_PAPER_ENABLED) = no cycles, no orders.
 * - Deterministic money path: orders come only from this
 *   signal → sizing → optimizer path. No LLM judgment places orders.
 *
 * Recommender choice (recorded per the slice brief): the full
 * recommendation bundle (#1135, buildRecommendationBundle) is NOT
 * called — its candidate contract is research-engine strategy
 * candidates (option legs priced over a scenario grid with IV and
 * Greeks inputs). A pattern-signal equity candidate has no honest
 * mapping onto that shape without fabricating options inputs. What
 * the bundle itself is built from — the CVaR optimizer (#1361) and
 * portfolio sizing (#36/#1769) over the #34 risk report — is called
 * directly, with the scenario grid built from the candidate's own
 * signal-conditioned forward returns on its real bars.
 */

import type {
  StockCopilotActivityPort,
  StockCopilotControlPort,
  StockCopilotPositionPort,
} from "../data/stockCopilotStorePorts";
import type { Env } from "../types";
import {
  resolveAlpacaTradingBase,
  type ITradingPlatform,
} from "../trading";
import {
  computePortfolioRisk,
  type PortfolioRiskReport,
  type PortfolioRiskSource,
} from "./portfolioRisk";
import { sizeCandidateAgainstPortfolio } from "./positionSizing";
import {
  computeScenarioStats,
  round2,
  shouldTrade,
  type OptimizerCandidate,
} from "./cvarOptimizer";
import {
  evaluateLatestPatternSignal,
  evaluatePatternSignalAt,
  type SandboxStrategyId,
} from "./patternSignals";
import {
  StockCopilotPositionStore,
  type CopilotPositionRecord,
} from "./stockCopilotStore";

/** Named refusal when the resolved Alpaca environment is not paper. */
export const STOCK_COPILOT_LIVE_REFUSAL = "stock_copilot_live_environment_refused";

/**
 * Copilot exit-plan policy (v1 constants, one home): every entry is
 * opened with a protective stop 5% below entry and a take-profit
 * target 10% above entry; the strategy's own exit signal is evaluated
 * alongside both every cycle. The sizing path's defined max loss per
 * share is entry − stop, so the plan and the size always agree.
 */
export const COPILOT_STOP_LOSS_PCT = 5;
export const COPILOT_TAKE_PROFIT_PCT = 10;

/** Default strategies: one representative per sandbox rule family. */
export const DEFAULT_COPILOT_STRATEGIES: readonly SandboxStrategyId[] = [
  "sma_crossover",
  "mean_reversion",
];

/** Default universe when STOCK_COPILOT_UNIVERSE is unset. */
export const DEFAULT_COPILOT_UNIVERSE: readonly string[] = [
  "SPY",
  "QQQ",
  "AAPL",
  "MSFT",
  "NVDA",
];

/**
 * Issue #3391: the copilot master switch, read with the exact idiom of
 * isAiSearchReportIndexingEnabled (#2246): "1"/"true"/"on"
 * (case-insensitive, trimmed) means ON; absence means OFF.
 */
export function isStockCopilotPaperEnabled(
  env?: { STOCK_COPILOT_PAPER_ENABLED?: string } | null,
): boolean {
  const v = env?.STOCK_COPILOT_PAPER_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

export function copilotUniverseFromEnv(
  env?: { STOCK_COPILOT_UNIVERSE?: string } | null,
): string[] {
  const raw = env?.STOCK_COPILOT_UNIVERSE;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (parsed.length > 0) return parsed;
  }
  return [...DEFAULT_COPILOT_UNIVERSE];
}

/**
 * US equity regular-session window, America/New_York, Mon–Fri
 * 09:30–16:00. Approximation by design: no exchange holiday calendar
 * is consulted (none exists in the platform); on a holiday the paper
 * venue simply leaves orders unfilled, and the cycle's tracked state
 * stays consistent because positions are recorded only on accepted
 * submissions.
 */
export function isUsMarketOpen(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export interface StockCopilotDeps {
  env: Env;
  /** The copilot's position store, through the data layer's
   *  port (composed by the host via createStockCopilotStorePorts). */
  positions: StockCopilotPositionPort;
  /** #3422: the per-instance pause control, read at firing —
   *  optional so the cycle stays runnable in hosts that do not
   *  compose it (the production host always does). */
  control?: StockCopilotControlPort;
  /** #3422: the cycle activity log sink — one record per cycle
   *  that evaluated the market (or was guard-refused). */
  activity?: StockCopilotActivityPort;
  /** The instance's acting login (order attribution + store scope). */
  userLogin: string;
  /** The Alpaca platform, obtained through the TradingPlatform seam. */
  platform: ITradingPlatform;
  /** Recent daily closes for a symbol, oldest → newest. */
  loadBars: (symbol: string) => Promise<number[]>;
  now?: () => Date;
  /** Broker environment selection forwarded to the paper resolver
   *  (the instance's TEST/PROD selection, when one exists). */
  overrideEnv?: string;
  universe?: string[];
  strategies?: readonly SandboxStrategyId[];
}

export interface StockCopilotRejection {
  symbol: string;
  strategy: string;
  reason: string;
}

export interface StockCopilotCycleError {
  symbol: string;
  stage: string;
  message: string;
}

export interface StockCopilotCycleResult {
  status:
    | "disabled"
    | "refused_live_environment"
    | "skipped_outside_market_hours"
    | "paused"
    | "ok";
  /** Named refusal code when status is refused_live_environment. */
  refusal?: string;
  entriesPlaced: number;
  exitsPlaced: number;
  /** #3422: the entries that landed, by symbol + strategy (the
   *  activity record's payload; entriesPlaced counts these). */
  entries: Array<{ symbol: string; strategy: string }>;
  /** #3422: the exits that landed, by symbol + exit reason. */
  exits: Array<{ symbol: string; reason: string }>;
  rejections: StockCopilotRejection[];
  errors: StockCopilotCycleError[];
}

/** The Alpaca book as a #34 PortfolioRiskSource (the bundle route's
 *  E*TRADE adapter, etradePortfolioRiskSource, is the same shape). */
export function alpacaPortfolioRiskSource(
  platform: ITradingPlatform,
): PortfolioRiskSource {
  return {
    readBook: () => platform.getPositions(),
    optionChain: async (symbol, expiry) => {
      if (typeof platform.getOptionChains !== "function") return null;
      return platform.getOptionChains({
        symbol,
        ...(expiry
          ? {
              expiryYear: expiry.year,
              expiryMonth: expiry.month,
              expiryDay: expiry.day,
            }
          : {}),
      });
    },
    spotPrice: async (symbol) => {
      try {
        const quote = await platform.getQuote(symbol);
        return typeof quote?.lastPrice === "number" && Number.isFinite(quote.lastPrice)
          ? quote.lastPrice
          : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Scenario returns for the optimizer: replay the strategy over the
 * candidate's own bars and take the next-bar return after every
 * historical entry signal the strategy produced on this series. The
 * grid is the pattern's own in-series evidence — deterministic, from
 * real bars, no invented distribution.
 */
export function signalConditionedForwardReturns(
  strategy: SandboxStrategyId,
  closes: readonly number[],
): number[] {
  const returns: number[] = [];
  let holding = false;
  let entryPrice = 0;
  for (let i = 0; i < closes.length - 1; i++) {
    const signal = evaluatePatternSignalAt(strategy, closes, i, {
      holding,
      entryPrice,
    });
    if (signal.action === "enter_long" && !holding) {
      holding = true;
      entryPrice = closes[i];
      if (closes[i] > 0) returns.push(closes[i + 1] / closes[i] - 1);
    } else if (signal.action === "exit_long" && holding) {
      holding = false;
      entryPrice = 0;
    }
  }
  return returns;
}

async function evaluateExit(
  deps: StockCopilotDeps,
  store: StockCopilotPositionStore,
  position: CopilotPositionRecord,
  nowIso: string,
  result: StockCopilotCycleResult,
): Promise<void> {
  const closes = await deps.loadBars(position.symbol);
  const last = closes.length > 0 ? closes[closes.length - 1] : undefined;
  if (last === undefined || !Number.isFinite(last) || last <= 0) {
    result.errors.push({
      symbol: position.symbol,
      stage: "exit_bars",
      message: "no usable bars for exit evaluation",
    });
    return;
  }
  const signal = evaluateLatestPatternSignal(position.strategy, closes, {
    holding: true,
    entryPrice: position.entryPrice,
  });
  let exitReason: string | null = null;
  if (signal.action === "exit_long") exitReason = "strategy_exit";
  else if (last <= position.stopPrice) exitReason = "stop_loss";
  else if (last >= position.targetPrice) exitReason = "take_profit";
  if (exitReason === null) return;

  const placed = await deps.platform.placeOrderRemote!({
    orderId: `copilot-${crypto.randomUUID()}`,
    symbol: position.symbol,
    action: "SELL",
    quantity: position.quantity,
    orderType: "MARKET",
    userLogin: deps.userLogin,
  });
  if (!placed.success) {
    result.errors.push({
      symbol: position.symbol,
      stage: "exit_order",
      message: placed.message || "exit order was not accepted",
    });
    return;
  }
  const exitPrice = placed.executionPrice > 0 ? placed.executionPrice : last;
  const exitRef = placed.brokerOrderRef || placed.executionId;
  await store.closePosition(position.id, {
    exitBrokerOrderRef: exitRef,
    exitPrice,
    exitReason,
    closedAt: nowIso,
  });
  result.exitsPlaced += 1;
  result.exits.push({ symbol: position.symbol, reason: exitReason });
}

async function attemptEntry(
  deps: StockCopilotDeps,
  store: StockCopilotPositionStore,
  getReport: () => Promise<PortfolioRiskReport>,
  args: {
    symbol: string;
    strategy: SandboxStrategyId;
    closes: readonly number[];
    nowIso: string;
  },
  result: StockCopilotCycleResult,
): Promise<void> {
  const { symbol, strategy, closes, nowIso } = args;
  const entry = closes[closes.length - 1];
  const reject = (reason: string): void => {
    result.rejections.push({ symbol, strategy, reason });
  };

  if (!Number.isFinite(entry) || entry <= 0) {
    reject("non_positive_entry_price");
    return;
  }
  const stopPrice = round2(entry * (1 - COPILOT_STOP_LOSS_PCT / 100));
  const targetPrice = round2(entry * (1 + COPILOT_TAKE_PROFIT_PCT / 100));

  let report: PortfolioRiskReport;
  try {
    report = await getReport();
  } catch (err) {
    reject(
      `risk_report_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // Sizing (#36/#1769): one "contract" unit = one share; per-share
  // delta dollars = price; defined max loss per share = entry − stop
  // (the copilot's own exit plan defines the risk). Beta-weighted
  // basis is left null — the sizing engine then uses and LABELS the
  // unweighted basis rather than assuming a beta.
  const sizing = sizeCandidateAgainstPortfolio(report, {
    symbol,
    perContract: {
      deltaDollars: entry,
      betaWeightedDeltaDollars: null,
      definedMaxLoss: round2(entry - stopPrice),
    },
  });
  const qty = sizing.recommendedContracts;
  if (qty <= 0) {
    reject(`sizing refused: bound by ${sizing.bindingConstraint}`);
    return;
  }

  // Optimizer gate (#1361): the candidate must beat no-trade (score 0)
  // over the scenario grid built from its own signal-conditioned
  // forward returns. No historical evidence → empty grid → score 0 →
  // no trade.
  const stats = computeScenarioStats(
    signalConditionedForwardReturns(strategy, closes).map((r) => ({
      pnlTotal: qty * entry * r,
    })),
  );
  const candidate: OptimizerCandidate = {
    id: `${symbol}:${strategy}`,
    label: `${symbol} ${strategy}`,
    stats,
    sizing: { recommendedContracts: qty, bindingConstraint: sizing.bindingConstraint },
  };
  if (!shouldTrade(candidate)) {
    reject(`optimizer: scenario score ${stats.score} does not beat no-trade`);
    return;
  }

  const placed = await deps.platform.placeOrderRemote!({
    orderId: `copilot-${crypto.randomUUID()}`,
    symbol,
    action: "BUY",
    quantity: qty,
    orderType: "MARKET",
    userLogin: deps.userLogin,
  });
  if (!placed.success) {
    reject(`order refused: ${placed.message || "not accepted"}`);
    return;
  }

  const entryRef = placed.brokerOrderRef || placed.executionId;
  await store.openPosition({
    userLogin: deps.userLogin,
    symbol,
    strategy,
    quantity: qty,
    entryPrice: placed.executionPrice > 0 ? placed.executionPrice : entry,
    stopPrice,
    targetPrice,
    brokerOrderRef: entryRef,
    openedAt: nowIso,
  });
  result.entriesPlaced += 1;
  result.entries.push({ symbol, strategy });
}

/**
 * #3422: write the cycle's activity record through the port, when
 * the host composed one. Display-grade data: a failed append is
 * collected into the result's errors, never thrown — the cycle's
 * contract is that per-item failures surface in the result.
 */
function appendCycleActivity(
  deps: StockCopilotDeps,
  result: StockCopilotCycleResult,
  cycleAt: string,
  outcome: "traded" | "no_trade" | "refused",
  detail: string | null,
): void {
  if (!deps.activity) return;
  try {
    deps.activity.ensureSchema();
    deps.activity.appendActivity({
      id: crypto.randomUUID(),
      userLogin: deps.userLogin,
      cycleAt,
      outcome,
      entries: result.entries.map((e) => e.symbol),
      exits: result.exits.map((e) => ({ symbol: e.symbol, reason: e.reason })),
      detail,
    });
  } catch (err) {
    result.errors.push({
      symbol: "",
      stage: "activity",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * One copilot cycle. Gate order is deliberate: flag → paper guard →
 * market hours → work. The first two gates make zero platform calls;
 * per-symbol failures are collected, never thrown — one bad symbol
 * must not stop the loop's other positions from being managed.
 *
 * #3422: after the platform gate, the per-instance pause control
 * is read. Paused ⇒ exits are still evaluated (open positions are
 * never left unmanaged) but no entries are placed, and the firing
 * is not recorded as a cycle. Unpaused cycles that evaluated the
 * market write one activity record (traded / no-trade); a guard
 * refusal writes one refused record. Flag-off and outside-hours
 * firings record nothing.
 */
export async function runStockCopilotCycle(
  deps: StockCopilotDeps,
): Promise<StockCopilotCycleResult> {
  const result: StockCopilotCycleResult = {
    status: "ok",
    entriesPlaced: 0,
    exitsPlaced: 0,
    entries: [],
    exits: [],
    rejections: [],
    errors: [],
  };

  if (!isStockCopilotPaperEnabled(deps.env)) {
    result.status = "disabled";
    return result;
  }

  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  // PAPER-ONLY GUARD — the adapter's own resolver (#3158), evaluated
  // before the platform is touched at all.
  const resolved = resolveAlpacaTradingBase(deps.env, deps.overrideEnv);
  if (resolved.isLive) {
    result.status = "refused_live_environment";
    result.refusal = STOCK_COPILOT_LIVE_REFUSAL;
    appendCycleActivity(deps, result, nowIso, "refused", STOCK_COPILOT_LIVE_REFUSAL);
    return result;
  }

  if (!isUsMarketOpen(now)) {
    result.status = "skipped_outside_market_hours";
    return result;
  }

  if (typeof deps.platform.placeOrderRemote !== "function") {
    result.errors.push({
      symbol: "",
      stage: "platform",
      message: "platform_remote_submit_unavailable",
    });
    return result;
  }

  const store = new StockCopilotPositionStore(deps.positions);
  const universe = (deps.universe ?? copilotUniverseFromEnv(deps.env)).map((s) =>
    s.toUpperCase(),
  );
  const strategies = deps.strategies ?? DEFAULT_COPILOT_STRATEGIES;

  // Exits first: capital protection precedes new risk. Shared by
  // the normal and paused paths — a pause never suspends exit
  // management.
  const evaluateAllExits = async (): Promise<void> => {
    const openBefore = await store.listOpenPositions(deps.userLogin);
    for (const position of openBefore) {
      try {
        await evaluateExit(deps, store, position, nowIso, result);
      } catch (err) {
        result.errors.push({
          symbol: position.symbol,
          stage: "exit",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // #3422: the per-instance pause control, read at firing time.
  let paused = false;
  if (deps.control) {
    deps.control.ensureSchema();
    paused = deps.control.getControl(deps.userLogin)?.paused === true;
  }
  if (paused) {
    await evaluateAllExits();
    result.status = "paused";
    return result;
  }

  await evaluateAllExits();

  // 2. Entries for symbols the copilot does not already hold.
  const stillOpen = await store.listOpenPositions(deps.userLogin);
  const held = new Set(stillOpen.map((p) => p.symbol));
  let reportPromise: Promise<PortfolioRiskReport> | null = null;
  const getReport = (): Promise<PortfolioRiskReport> => {
    if (!reportPromise) {
      reportPromise = computePortfolioRisk(alpacaPortfolioRiskSource(deps.platform));
    }
    return reportPromise;
  };

  for (const symbol of universe) {
    if (held.has(symbol)) continue;
    try {
      const closes = await deps.loadBars(symbol);
      if (closes.length === 0) {
        result.errors.push({ symbol, stage: "entry_bars", message: "no bars returned" });
        continue;
      }
      for (const strategy of strategies) {
        const signal = evaluateLatestPatternSignal(strategy, closes, {
          holding: false,
          entryPrice: 0,
        });
        if (signal.action !== "enter_long") continue;
        await attemptEntry(
          deps,
          store,
          getReport,
          { symbol, strategy, closes, nowIso },
          result,
        );
        break; // One decision per symbol per cycle, whichever way it lands.
      }
    } catch (err) {
      result.errors.push({
        symbol,
        stage: "entry",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // #3422: record the evaluated cycle — traded when anything
  // landed, otherwise no-trade with the reason (the rejection
  // reasons, or the plain no-signal outcome when nothing was
  // even attempted).
  if (result.entriesPlaced + result.exitsPlaced > 0) {
    appendCycleActivity(deps, result, nowIso, "traded", null);
  } else {
    const detail =
      result.rejections.length > 0
        ? [...new Set(result.rejections.map((r) => r.reason))].join("; ")
        : "no_entry_signals";
    appendCycleActivity(deps, result, nowIso, "no_trade", detail);
  }

  return result;
}
