/**
 * Issue #1122 (Phase 3 of epic #1096) — Screeners v2 pins.
 *
 *  - Goal-driven screens: the screen plan is derived from a Phase 1
 *    scenario (goal outlook, gate-admissible taxonomy structures,
 *    constraint-derived DTE/liquidity/spread filters) and the run goes
 *    through the Phase 0 ScreeningProvider registry only. One asset
 *    class failing is a QUALIFIED PARTIAL (screenerEvents contract);
 *    both failing is a failure; zero hits is a legitimate complete.
 *  - Durability: goal-driven runs adopt the screener task ledger
 *    (#607, mirror of researchTaskLedger #577): idempotent duplicate
 *    delivery (one record, one execution), heartbeat, deterministic
 *    evaluation, total failure ends ESCALATED for a human.
 *  - Nightly strategy-bank re-selection: schedule guard in the
 *    researchScheduleGuard idiom (own durable marker, weekday ≥21:00
 *    UTC, no new cron); re-selection is per-regime over track-record
 *    evidence under a hard cost cap (#495 pattern — remainder logged
 *    not-evaluated, never dropped); the recorded transparency log
 *    INCLUDES LOSERS with metrics + reasons; the run is propose/record
 *    only — strategy weights are byte-identical afterwards and the
 *    module never calls the weights writer (source pin).
 *  - Backtest-on-screen: walk-forward folds, portfolio-level
 *    aggregation, options repriced ONLY by researchEconomics
 *    (valueAtHorizon ground-truth check + source pin: no BS/payoff
 *    code in the new module), costs netted from config fee/slippage,
 *    provenance + limitations labeled on every result, insufficient
 *    history excluded with reasons — never fabricated.
 *  - Research-agent discovery run type: Phase 1 discovery runs over
 *    the agent's provider seam; a null portfolio SKIPS portfolio
 *    triggers with the limitation recorded (never assumed healthy);
 *    persisted goals stay proposed-only; the due-guard fires at most
 *    once per weekday.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MockSqlStorage } from "./mock-sql";
import {
  buildGoalScreenPlan,
  runGoalDrivenScreen,
  runGoalDrivenScreenWithLedger,
  type GoalScreenHit,
} from "../src/services/goalDrivenScreen";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  ScreeningProviderRegistry,
  type ScreeningProvider,
  type ScreeningResult,
} from "../src/trading/screeningProvider";
import {
  ScreenerTaskLedger,
  type ScreenerTaskStore,
} from "../src/services/screenerTaskLedger";
import {
  STRATEGY_BANK_LAST_RUN_KEY,
  shouldFireStrategyBankTick,
  buildStrategyRegimeEvidence,
  reselectStrategyBank,
  ensureStrategyBankProposalTable,
  recordReselectionProposal,
  listReselectionProposals,
  RESELECTION_GOVERNANCE,
  type StrategyRegimeEvidence,
} from "../src/services/strategyBankReselection";
import {
  backtestScreenCandidates,
  type BacktestCandidate,
  type PriceBar,
} from "../src/services/screenBacktest";
import {
  ironCondorEconomics,
  valueAtHorizon,
  type ResearchLeg,
} from "../src/services/researchEconomics";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import {
  ensureWeightsV2Tables,
  getStrategyWeightsV2Collapsed,
} from "../src/services/strategyWeightsV2";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function stockResult(symbols: string[]): any {
  return {
    totalScanned: 500,
    totalScreened: 500,
    matchedCount: symbols.length,
    filterApplied: {},
    filterSummary: "fixture",
    stocks: symbols.map((symbol) => ({ symbol, lastPrice: 100 })),
    scannedAt: "2026-10-22T20:00:00.000Z",
  };
}

function optionsResult(underlyings: string[]): any {
  return {
    totalUnderlyingsScanned: 40,
    totalContractsEvaluated: 900,
    matchedCount: underlyings.length * 3,
    filterApplied: {},
    filterSummary: "fixture",
    contracts: underlyings.flatMap((u) =>
      [0, 1, 2].map((i) => ({ underlyingSymbol: u, strikePrice: 100 + i }))
    ),
    scannedAt: "2026-10-22T20:00:00.000Z",
    dataSource: "live",
  };
}

function fakeProvider(
  id: string,
  assetClass: "stocks" | "options",
  behavior: () => any
): ScreeningProvider {
  return {
    id,
    assetClasses: [assetClass],
    async screen(): Promise<ScreeningResult> {
      const result = behavior();
      return { assetClass, providerId: id, result } as ScreeningResult;
    },
  };
}

function registryWith(opts: {
  stocks?: () => any;
  options?: () => any;
}): ScreeningProviderRegistry {
  const registry = new ScreeningProviderRegistry();
  if (opts.stocks) registry.register(fakeProvider("fake-stocks", "stocks", opts.stocks));
  if (opts.options) registry.register(fakeProvider("fake-options", "options", opts.options));
  return registry;
}

function incomeScenario() {
  return buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    constraints: {
      dteWindow: { min: 21, max: 60 },
      liquidityFloor: { minOpenInterest: 500, minVolume: 100, maxSpreadPct: 8 },
    },
  });
}

/* ------------------------------------------------------------------ */
/* Screen plan derivation                                              */
/* ------------------------------------------------------------------ */

describe("goal-driven screen plan (Phase 3)", () => {
  it("derives outlook, structures and constraint filters from the scenario", () => {
    const plan = buildGoalScreenPlan(incomeScenario(), { symbols: ["NVDA", "MSFT"] });
    expect(plan.goalKind).toBe("income");
    expect(plan.outlook).toBe("range_bound");
    expect(plan.structures).toEqual(["iron_condor", "butterfly"]);
    expect(plan.optionsFilter.minDte).toBe(21);
    expect(plan.optionsFilter.maxDte).toBe(60);
    expect(plan.optionsFilter.minOpenInterest).toBe(500);
    expect(plan.optionsFilter.minVolume).toBe(100);
    expect(plan.optionsFilter.maxSpreadPct).toBe(8);
    expect(plan.optionsFilter.underlyingSymbols).toEqual(["NVDA", "MSFT"]);
  });

  it("maps outlook to the stock momentum filter", () => {
    const bullish = buildGoalScreenPlan(
      buildScenario({ goalKind: "directional", portfolioRef: { kind: "hypothetical" } })
    );
    expect(bullish.stockFilter.momentum).toBe("bullish_breakout");
    const bearish = buildGoalScreenPlan(
      buildScenario({ goalKind: "hedge_protect", portfolioRef: { kind: "hypothetical" } })
    );
    expect(bearish.stockFilter.momentum).toBe("bearish_pullback");
    const volatilePlan = buildGoalScreenPlan(
      buildScenario({ goalKind: "volatility_event", portfolioRef: { kind: "hypothetical" } })
    );
    expect(volatilePlan.stockFilter.momentum).toBe("high_relative_volume");
  });

  it("an unknown direction means everything — no thesis named (#1963 correction)", () => {
    const directionalUnknown = buildGoalScreenPlan(
      buildScenario({ goalKind: "directional", portfolioRef: { kind: "hypothetical" }, direction: "unknown" })
    );
    expect(directionalUnknown.outlook).toBe("unknown");
    expect(directionalUnknown.stockFilter.momentum).toBe("any");
    // Contrast: no direction sent ("Goal default") resolves to the taxonomy outlook.
    const directionalDefault = buildGoalScreenPlan(
      buildScenario({ goalKind: "directional", portfolioRef: { kind: "hypothetical" } })
    );
    expect(directionalDefault.outlook).toBe("bullish");
    expect(directionalDefault.stockFilter.momentum).toBe("bullish_breakout");
  });

  it("caller base filters win per-field over plan defaults", () => {
    const plan = buildGoalScreenPlan(incomeScenario(), {
      baseOptionsFilter: { minDte: 30 },
      baseStockFilter: { minPrice: 25 },
    });
    expect(plan.optionsFilter.minDte).toBe(30); // caller wins
    expect(plan.optionsFilter.maxDte).toBe(60); // plan default survives
    expect(plan.stockFilter.minPrice).toBe(25);
  });
});

/* ------------------------------------------------------------------ */
/* Unified goal-driven run                                             */
/* ------------------------------------------------------------------ */

describe("runGoalDrivenScreen (Phase 3)", () => {
  it("runs both asset classes through the registry and normalizes hits", async () => {
    const registry = registryWith({
      stocks: () => stockResult(["AAPL", "MSFT"]),
      options: () => optionsResult(["NVDA"]),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("complete");
    expect(out.partial).toBeUndefined();
    const stockHits = out.hits.filter((h: GoalScreenHit) => h.assetClass === "stocks");
    const optionHits = out.hits.filter((h: GoalScreenHit) => h.assetClass === "options");
    expect(stockHits.map((h) => h.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(stockHits[0].providerId).toBe("fake-stocks");
    // Options hits are distinct underlyings carrying the plan structures.
    expect(optionHits.map((h) => h.symbol)).toEqual(["NVDA"]);
    expect(optionHits[0].structures).toEqual(["iron_condor", "butterfly"]);
    expect(out.counts.stocksMatched).toBe(2);
    expect(out.counts.optionsContractsMatched).toBe(3);
  });

  it("one failing asset class is a qualified partial, never a silent complete", async () => {
    const registry = registryWith({
      stocks: () => stockResult(["AAPL"]),
      options: () => {
        throw new Error("chain provider timeout");
      },
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("partial");
    expect(out.partial?.failedClasses).toEqual(["options"]);
    expect(out.partial?.reasons.options).toMatch(/timeout/);
    expect(out.hits.map((h) => h.symbol)).toEqual(["AAPL"]);
  });

  it("an error-status options leg is a qualified partial, never a silent complete (#1963)", async () => {
    const registry = registryWith({
      stocks: () => stockResult(["AAPL"]),
      options: () => ({
        ...optionsResult([]),
        totalUnderlyingsScanned: 0,
        matchedCount: 0,
        contracts: [],
        status: "error",
        validationError:
          "Specify underlying symbols or set the visible maximum-underlyings limit before scanning option chains.",
      }),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("partial");
    expect(out.partial?.failedClasses).toEqual(["options"]);
    expect(out.partial?.reasons.options).toMatch(/Specify underlying symbols/);
    expect(out.hits.map((h) => h.symbol)).toEqual(["AAPL"]);
    expect(out.counts.optionsUnderlyingsScanned).toBe(0);
  });

  it("an options leg whose fetches all fail surfaces as partial with its reason (#1963)", async () => {
    const registry = registryWith({
      stocks: () => stockResult(["AAPL"]),
      options: () => ({
        ...optionsResult([]),
        totalUnderlyingsScanned: 3,
        matchedCount: 0,
        contracts: [],
        status: "error",
        fetchErrors: [{ symbol: "AAPL", reason: "E*TRADE auth unavailable" }],
      }),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("partial");
    expect(out.partial?.failedClasses).toEqual(["options"]);
    expect(out.partial?.reasons.options).toMatch(/AAPL/);
  });

  it("a no-universe stock leg is a qualified partial, never a silent complete (#1963)", async () => {
    const registry = registryWith({
      stocks: () => ({ ...stockResult([]), totalScanned: 0, matchedCount: 0, stocks: [], status: "no_universe" }),
      options: () => optionsResult(["NVDA"]),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("partial");
    expect(out.partial?.failedClasses).toEqual(["stocks"]);
    expect(out.hits.map((h) => h.symbol)).toEqual(["NVDA"]);
  });

  it("a stock leg whose filter the feed cannot evaluate surfaces as partial with its reason (#1963)", async () => {
    const registry = registryWith({
      stocks: () => ({
        ...stockResult([]),
        totalScanned: 6594,
        totalScreened: 6594,
        matchedCount: 0,
        stocks: [],
        status: "no_matches",
        validationError:
          "The dynamic listing feed does not provide technical momentum data. Those criteria were not applied; use only price, daily change, market cap, and ticker/company search.",
      }),
      options: () => optionsResult(["NVDA"]),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("partial");
    expect(out.partial?.failedClasses).toEqual(["stocks"]);
    expect(out.partial?.reasons.stocks).toMatch(/technical momentum/);
    expect(out.hits.map((h) => h.symbol)).toEqual(["NVDA"]);
  });

  it("both legs error-status is a failure with no hits (#1963)", async () => {
    const registry = registryWith({
      stocks: () => ({ ...stockResult([]), totalScanned: 0, matchedCount: 0, stocks: [], status: "no_universe" }),
      options: () => ({
        ...optionsResult([]),
        totalUnderlyingsScanned: 0,
        matchedCount: 0,
        contracts: [],
        status: "error",
        validationError: "Specify underlying symbols.",
      }),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("failed");
    expect(out.hits).toEqual([]);
    expect(out.partial?.failedClasses).toEqual(["stocks", "options"]);
  });

  it("both classes failing is a failure with no hits", async () => {
    const registry = registryWith({
      stocks: () => {
        throw new Error("stocks down");
      },
      options: () => {
        throw new Error("options down");
      },
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("failed");
    expect(out.hits).toEqual([]);
    expect(out.partial?.failedClasses).toEqual(["stocks", "options"]);
  });

  it("zero hits is a legitimate complete result, distinct from partial", async () => {
    const registry = registryWith({
      stocks: () => stockResult([]),
      options: () => optionsResult([]),
    });
    const out = await runGoalDrivenScreen({ registry, scenario: incomeScenario() });
    expect(out.status).toBe("complete");
    expect(out.hits).toEqual([]);
  });

  it("a single requested asset class runs only that class", async () => {
    let stockCalls = 0;
    const registry = registryWith({
      stocks: () => {
        stockCalls++;
        return stockResult(["AAPL"]);
      },
      options: () => optionsResult(["NVDA"]),
    });
    const out = await runGoalDrivenScreen({
      registry,
      scenario: incomeScenario(),
      assetClasses: ["options"],
    });
    expect(out.status).toBe("complete");
    expect(stockCalls).toBe(0);
    expect(out.hits.map((h) => h.symbol)).toEqual(["NVDA"]);
  });
});

/* ------------------------------------------------------------------ */
/* Ledger adoption (durability)                                        */
/* ------------------------------------------------------------------ */

function memoryStore(): ScreenerTaskStore {
  const map = new Map<string, string>();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async list(prefix) {
      return [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

describe("goal-driven screen ledger adoption (Phase 3)", () => {
  it("records a completed run with a passing deterministic evaluation", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const registry = registryWith({
      stocks: () => stockResult(["AAPL"]),
      options: () => optionsResult(["NVDA"]),
    });
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry,
      scenario: incomeScenario(),
      trigger: "manual",
      idempotencyKey: "goal-screen:test:1",
    });
    expect(out.executed).toBe(true);
    expect(out.task.status).toBe("completed");
    expect(out.task.evaluation?.verdict).toBe("pass");
    expect(out.task.partial).toBe(false);
    expect(out.result?.status).toBe("complete");
  });

  it("duplicate delivery shares one record and does not re-execute", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    let stockCalls = 0;
    const registry = registryWith({
      stocks: () => {
        stockCalls++;
        return stockResult(["AAPL"]);
      },
      options: () => optionsResult(["NVDA"]),
    });
    const input = {
      ledger,
      registry,
      scenario: incomeScenario(),
      trigger: "scheduled" as const,
      idempotencyKey: "goal-screen:test:dup",
    };
    const first = await runGoalDrivenScreenWithLedger(input);
    const second = await runGoalDrivenScreenWithLedger(input);
    expect(first.executed).toBe(true);
    expect(second.executed).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(stockCalls).toBe(1);
    const all = await ledger.list(50);
    expect(all.filter((t) => t.idempotencyKey === "goal-screen:test:dup")).toHaveLength(1);
  });

  it("total failure ends escalated, visible to a human", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const registry = registryWith({
      stocks: () => {
        throw new Error("stocks down");
      },
      options: () => {
        throw new Error("options down");
      },
    });
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry,
      scenario: incomeScenario(),
      trigger: "manual",
      idempotencyKey: "goal-screen:test:fail",
    });
    expect(out.executed).toBe(true);
    expect(out.task.status).toBe("escalated");
    expect(out.result?.status).toBe("failed");
  });

  it("a qualified-partial run completes as partial with its qualification", async () => {
    const ledger = new ScreenerTaskLedger(memoryStore());
    const registry = registryWith({
      stocks: () => stockResult(["AAPL"]),
      options: () => {
        throw new Error("chain timeout");
      },
    });
    const out = await runGoalDrivenScreenWithLedger({
      ledger,
      registry,
      scenario: incomeScenario(),
      trigger: "manual",
      idempotencyKey: "goal-screen:test:partial",
    });
    expect(out.task.status).toBe("completed");
    expect(out.task.partial).toBe(true);
    expect(out.task.evaluation?.verdict).toBe("pass");
  });
});

/* ------------------------------------------------------------------ */
/* Nightly strategy-bank re-selection                                  */
/* ------------------------------------------------------------------ */

describe("strategy bank schedule guard (Phase 3)", () => {
  const wedEvening = new Date("2026-10-21T22:30:00.000Z"); // Wednesday UTC

  it("has its own durable marker (issue #6503 retired the research run marker it used to differ from)", () => {
    expect(STRATEGY_BANK_LAST_RUN_KEY).toBe("strategy_bank_reselection_last_run");
  });

  it("fires once per weekday at/after 21:00 UTC", () => {
    expect(shouldFireStrategyBankTick(wedEvening, null)).toEqual({
      fire: true,
      dateKey: "2026-10-21",
    });
    expect(shouldFireStrategyBankTick(wedEvening, "2026-10-21").fire).toBe(false);
    expect(
      shouldFireStrategyBankTick(new Date("2026-10-21T20:30:00.000Z"), null).fire
    ).toBe(false);
    expect(
      shouldFireStrategyBankTick(new Date("2026-10-24T22:30:00.000Z"), null).fire // Saturday
    ).toBe(false);
  });
});

function evidence(
  strategy: string,
  regime: StrategyRegimeEvidence["regime"],
  evaluated: number,
  winRate: number | null,
  avgRMultiple: number | null
): StrategyRegimeEvidence {
  return { strategy, regime, published: evaluated, evaluated, winRate, avgRMultiple };
}

describe("reselectStrategyBank (Phase 3)", () => {
  const bank: StrategyRegimeEvidence[] = [
    evidence("iron_condor", "chop", 40, 0.65, 0.4),
    evidence("butterfly", "chop", 30, 0.4, -0.2), // the loser
    evidence("bull_call_spread", "chop", 4, 0.75, 0.9), // thin sample
    evidence("pmcc", "chop", 25, 0.55, 0.1),
    evidence("long_straddle", "bull", 30, 0.7, 0.5), // other regime
  ];

  it("selects per-regime winners and logs losers with metrics + reasons", () => {
    const proposal = reselectStrategyBank({
      evidence: bank,
      weights: { iron_condor: 1.1 },
      regime: "chop",
      overallWinRate: 0.52,
      now: new Date("2026-10-21T21:00:00.000Z"),
    });
    expect(proposal.governance).toBe(RESELECTION_GOVERNANCE);
    expect(proposal.activeSet.map((a) => a.strategy)).toEqual(["iron_condor", "pmcc"]);
    expect(proposal.activeSet[0].weight).toBe(1.1); // informational only
    const loser = proposal.log.find((e) => e.strategy === "butterfly");
    expect(loser?.outcome).toBe("deselected");
    expect(loser?.loser).toBe(true);
    expect(loser?.winRate).toBe(0.4);
    expect(loser?.avgRMultiple).toBe(-0.2);
    expect(loser?.reason).toMatch(/below|negative/i);
    // Other-regime evidence is not silently mixed in.
    expect(proposal.log.find((e) => e.strategy === "long_straddle")).toBeUndefined();
  });

  it("thin evidence is insufficient-evidence, never selected", () => {
    const proposal = reselectStrategyBank({
      evidence: bank,
      weights: {},
      regime: "chop",
      overallWinRate: 0.52,
      now: new Date("2026-10-21T21:00:00.000Z"),
    });
    const thin = proposal.log.find((e) => e.strategy === "bull_call_spread");
    expect(thin?.outcome).toBe("insufficient_evidence");
    expect(proposal.activeSet.map((a) => a.strategy)).not.toContain("bull_call_spread");
  });

  it("the cost cap is hard: the remainder are logged not-evaluated", () => {
    const many: StrategyRegimeEvidence[] = Array.from({ length: 6 }, (_, i) =>
      evidence(`strat_${String(i).padStart(2, "0")}`, "chop", 30, 0.6, 0.3)
    );
    const proposal = reselectStrategyBank({
      evidence: many,
      weights: {},
      regime: "chop",
      overallWinRate: 0.5,
      now: new Date("2026-10-21T21:00:00.000Z"),
      config: { costCapUnits: 30, costPerStrategyUnits: 10 },
    });
    expect(proposal.evaluatedCount).toBe(3);
    expect(proposal.costUnitsUsed).toBe(30);
    const notEvaluated = proposal.log.filter((e) => e.outcome === "not_evaluated_cost_cap");
    expect(notEvaluated).toHaveLength(3);
    expect(proposal.log).toHaveLength(6); // nobody is silently dropped
  });

  it("builds evidence from track-record ideas joined to their run regime", () => {
    const ideas = [
      {
        structure: "iron_condor",
        regime: "chop" as const,
        evaluation: { pnlEstimatePerUnit: 12, rMultiple: 0.3 },
      },
      {
        structure: "iron_condor",
        regime: "chop" as const,
        evaluation: { pnlEstimatePerUnit: -8, rMultiple: -0.2 },
      },
      { structure: "iron_condor", regime: "chop" as const, evaluation: null },
    ];
    const slices = buildStrategyRegimeEvidence(ideas as any);
    expect(slices).toHaveLength(1);
    expect(slices[0].evaluated).toBe(2);
    expect(slices[0].winRate).toBe(0.5);
    expect(slices[0].avgRMultiple).toBeCloseTo(0.05, 6);
  });

  it("recording a proposal never mutates strategy weights (governance pin)", () => {
    const sql = new MockSqlStorage() as any;
    ensureWeightsV2Tables(sql);
    (sql as any).tables.set("mas_strategy_weights_v2", [
      { strategy: "iron_condor", regime: "bull", weight: 1.25, version: 1, updated_at: "2026-10-20T00:00:00.000Z" },
    ]);
    const before = getStrategyWeightsV2Collapsed(sql);
    const proposal = reselectStrategyBank({
      evidence: bank,
      weights: before,
      regime: "chop",
      overallWinRate: 0.52,
      now: new Date("2026-10-21T21:00:00.000Z"),
    });
    ensureStrategyBankProposalTable(sql);
    const id = recordReselectionProposal(sql, "alice", proposal);
    expect(typeof id).toBe("string");
    expect(getStrategyWeightsV2Collapsed(sql)).toEqual(before);
    const stored = listReselectionProposals(sql, "alice");
    expect(stored).toHaveLength(1);
    expect(stored[0].proposal.activeSet.map((a: any) => a.strategy)).toEqual([
      "iron_condor",
      "pmcc",
    ]);
    // The loser survives in the durable log too.
    expect(
      stored[0].proposal.log.find((e: any) => e.strategy === "butterfly")?.loser
    ).toBe(true);
    expect(listReselectionProposals(sql, "bob")).toEqual([]);
  });

  it("the reselection module never calls the weights writer (source pin)", () => {
    const src = readFileSync("src/services/strategyBankReselection.ts", "utf8");
    expect(src).not.toMatch(/setStrategyWeight|runStrategyWeightAdjustment|applyAdaptation/);
  });
});

/* ------------------------------------------------------------------ */
/* Backtest-on-screen                                                  */
/* ------------------------------------------------------------------ */

function risingSeries(symbol: string, start: number, days = 30): PriceBar[] {
  const bars: PriceBar[] = [];
  const t0 = Date.UTC(2026, 8, 1);
  for (let i = 0; i < days; i++) {
    bars.push({
      date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
      close: start + i,
    });
  }
  return bars;
}

function condorCandidate(symbol: string): BacktestCandidate {
  const legs: ResearchLeg[] = [
    { optionType: "put", strike: 90, expiry: "2026-12-18", dte: 60, bid: 1.0, ask: 1.2, iv: 0.4, volume: 100, openInterest: 600, quantity: -1 },
    { optionType: "put", strike: 85, expiry: "2026-12-18", dte: 60, bid: 0.5, ask: 0.6, iv: 0.4, volume: 100, openInterest: 600, quantity: 1 },
    { optionType: "call", strike: 110, expiry: "2026-12-18", dte: 60, bid: 1.0, ask: 1.2, iv: 0.4, volume: 100, openInterest: 600, quantity: -1 },
    { optionType: "call", strike: 115, expiry: "2026-12-18", dte: 60, bid: 0.5, ask: 0.6, iv: 0.4, volume: 100, openInterest: 600, quantity: 1 },
  ] as ResearchLeg[];
  return {
    symbol,
    kind: "options",
    economics: ironCondorEconomics(legs, 100),
    contracts: 2,
  };
}

describe("backtestScreenCandidates (Phase 3)", () => {
  it("walk-forward folds trade every fold and aggregate at portfolio level", () => {
    const out = backtestScreenCandidates({
      candidates: [{ symbol: "AAPL", kind: "stock" }],
      prices: { AAPL: risingSeries("AAPL", 100) },
      provenance: "live",
      folds: 3,
      holdingBars: 5,
      capital: 100_000,
    });
    expect(out.provenance).toBe("live");
    expect(out.folds).toHaveLength(3);
    for (const fold of out.folds) {
      expect(fold.trades).toHaveLength(1);
      expect(fold.trades[0].symbol).toBe("AAPL");
      expect(fold.trades[0].exitSpot).toBeGreaterThan(fold.trades[0].entrySpot);
      expect(fold.netPnl).toBeGreaterThan(0); // rising series, costs netted
    }
    expect(out.aggregate.totalTrades).toBe(3);
    expect(out.aggregate.winRate).toBe(1);
    expect(out.aggregate.equityCurve).toHaveLength(3);
    expect(out.limitations.join(" ")).toMatch(/constant|IV held/i);
  });

  it("options candidates are repriced by valueAtHorizon exactly (ground truth)", () => {
    const candidate = condorCandidate("XYZ");
    const flat: PriceBar[] = risingSeries("XYZ", 100).map((b) => ({ ...b, close: 100 }));
    const out = backtestScreenCandidates({
      candidates: [candidate],
      prices: { XYZ: flat },
      provenance: "live",
      folds: 1,
      holdingBars: 10,
      capital: 100_000,
    });
    const trade = out.folds[0].trades[0];
    const econ = candidate.economics!;
    const expectedGross =
      valueAtHorizon(
        econ.legs,
        econ.netDebit,
        econ.netCredit,
        100,
        0,
        10 / 365,
        RESEARCH_CONFIG_DEFAULTS.riskFreeRate,
        RESEARCH_CONFIG_DEFAULTS.dividendYield
      ) *
      100 *
      (trade.contracts ?? 1);
    // Trades report money rounded to cents; the ground truth is
    // compared at that reporting precision.
    expect(trade.grossPnl).toBeCloseTo(expectedGross, 2);
    // Round-trip costs are netted: 2 sides × (fee + slippage) × contracts.
    const perContract = RESEARCH_CONFIG_DEFAULTS.feePerContract + RESEARCH_CONFIG_DEFAULTS.slippagePerContract;
    expect(trade.costs).toBeCloseTo(2 * perContract * (trade.contracts ?? 1), 6);
    expect(trade.netPnl).toBeCloseTo(trade.grossPnl - trade.costs, 2);
  });

  it("insufficient history is excluded with a reason, never fabricated", () => {
    const out = backtestScreenCandidates({
      candidates: [
        { symbol: "AAPL", kind: "stock" },
        { symbol: "THIN", kind: "stock" },
      ],
      prices: { AAPL: risingSeries("AAPL", 100), THIN: risingSeries("THIN", 50, 3) },
      provenance: "static",
      folds: 1,
      holdingBars: 10,
      capital: 100_000,
    });
    expect(out.folds[0].trades.map((t) => t.symbol)).toEqual(["AAPL"]);
    const excluded = out.folds[0].excluded.find((e) => e.symbol === "THIN");
    expect(excluded?.reason).toMatch(/insufficient/i);
    expect(out.provenance).toBe("static");
    expect(out.limitations.join(" ")).toMatch(/static|not live/i);
  });

  it("the backtest module adds no pricing engine of its own (source pin)", () => {
    const src = readFileSync("src/services/screenBacktest.ts", "utf8");
    expect(src).toContain("valueAtHorizon");
    expect(src).not.toMatch(/blackScholesPrice|normCdf|payoffAtExpiry/);
  });
});

/* ------------------------------------------------------------------ */
/* Research-agent discovery run type (integration over the real engine) */
/* ------------------------------------------------------------------ */

describe("Phase 1 discovery with an absent portfolio (Phase 3 scheduled path)", () => {
  it("skips portfolio triggers with the limitation recorded, never assumed healthy", async () => {
    const { runGoalScenarioDiscovery } = await import(
      "../src/services/goalScenarioEngine"
    );
    const provider = {
      getUniverseSymbols: async () => [],
      getQuote: async () => null,
      getChain: async () => {
        throw new Error("not used in discovery mode");
      },
      getTechnicals: async () => null,
      getCatalysts: async () => null,
      getRegime: async () => ({ regime: "chop" as const, notes: ["fixture"], asOf: 0 }),
    } as any;
    const out = await runGoalScenarioDiscovery({
      provider,
      portfolio: null,
      symbols: [],
    });
    // Regime proposals still flow (chop → income); portfolio triggers do not.
    expect(out.proposals.map((p) => p.kind)).toContain("income");
    expect(out.proposals.every((p) => p.trigger.startsWith("regime"))).toBe(true);
    expect(out.limitations.join(" ")).toMatch(/portfolio state not supplied/i);
  });
});
