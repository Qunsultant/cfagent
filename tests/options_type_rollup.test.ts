/**
 * Issue #26: strategy-type roll-up in ranked output. Until now "best
 * strategy" meant the single best-scoring candidate instance; a user
 * asking for the best strategy TYPE (iron condor vs put credit spread
 * on a name) could not see per-type winners or compare types.
 *
 * Pinned here:
 *  1. buildTypeRollup (single-name) — per type: the best ranked
 *     candidate (flattened to the ScanMatrixCellBest shape) plus the
 *     evaluation ledger's counts (evaluated = generated, passed =
 *     accepted the acceptance rules). Sums reconcile with the ledger
 *     exactly. A type that passed acceptance but was screened out
 *     before ranking keeps passedCount > 0 with best = null.
 *  2. rollupScanTypes (scan) — the fit matrix aggregated across
 *     symbols per type: symbol counts, candidate totals that reconcile
 *     with the matrix cells, merged rejection reasons, and the best
 *     candidate per type overall (with its symbol). Skipped symbols
 *     contribute nothing.
 *  3. Wiring — both single-name NLQ actions carry typeRollup and a
 *     "Best by type:" summary clause; the scan result carries
 *     typeRollup reconciling with its matrix and the NLQ scan summary
 *     gains the clause; the unified single-name actions carry it too.
 *
 * Semantics kept distinct (as in the builders' comments): single-name
 * "passed" = passed the acceptance rules; scan "passed" = passed the
 * risk screen (the #22 matrix meaning).
 *
 * Fixtures are deterministic (stub-client / fake-screener patterns
 * from tests/options_scanner.test.ts and
 * tests/options_scan_persistence.test.ts). No live market data.
 */
import { describe, expect, it, vi} from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import {
  parseOptionsStrategyIntent,
  runOptionsStrategyAction,
} from "../src/agents/nlqOptionsStrategy";
import {
  buildTypeRollup,
  type StrategyTypeRollup,
} from "../src/trading/options/strategies/ledger";
import {
  OpportunityScanner,
  rollupScanTypes,
  type ScanMatrixCellBest,
  type ScanMatrixRow,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { StrategyEvaluation } from "../src/trading/options/strategies/types";
import type { RankedStrategy } from "../src/trading/options/recommendationAgent";
import type { BestTradePick } from "../src/trading/options/recommendationAgent";
import type { ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

// ---------------------------------------------------------------------------
// Fabrications for the pure builders
// ---------------------------------------------------------------------------

function evaluation(partial: Partial<StrategyEvaluation> & { id: string }): StrategyEvaluation {
  return {
    label: partial.id,
    category: "vertical",
    status: "accepted",
    generated: 0,
    accepted: 0,
    summary: "",
    reasons: [],
    ...partial,
  };
}

function rankedEntry(type: string, compositeScore: number, candidateId: string): RankedStrategy {
  return {
    candidate: {
      id: candidateId,
      type,
      label: `${type} candidate`,
      score: compositeScore - 5,
      expirationDate: "2026-11-20",
      legs: [{ symbol: `NVDA260C`, strike: 260 }],
      netDebit: 320,
      maxLoss: 320,
      maxProfit: 680,
      maxProfitUnbounded: false,
      targetRewardRisk: 2.1,
      modelImpliedProbabilityOfProfit: 0.42,
    },
    rank: 1,
    compositeScore,
    components: {},
  } as unknown as RankedStrategy;
}

function cellBest(candidateId: string, compositeScore: number): ScanMatrixCellBest {
  return {
    candidateId,
    label: `${candidateId} label`,
    compositeScore,
    score: compositeScore - 5,
    expirationDate: "2026-11-20",
    legs: [],
    netDebit: 100,
    maxLoss: 100,
    maxProfit: 200,
    maxProfitUnbounded: false,
    targetRewardRisk: 2,
    probabilityOfProfit: 0.5,
  };
}

function matrixRow(symbol: string, verdict: ScanMatrixRow["verdict"], cells: ScanMatrixRow["cells"]): ScanMatrixRow {
  return {
    symbol,
    verdict,
    targetPrice: verdict === "skipped" ? null : 100,
    targetSource: verdict === "skipped" ? null : "thesis",
    targetEmUnits: null,
    cells,
    gateBucket: verdict === "skipped" ? null : "fit",
    gateReasons: [],
  };
}

// ---------------------------------------------------------------------------
// buildTypeRollup (single-name)
// ---------------------------------------------------------------------------

describe("buildTypeRollup (issue #26)", () => {
  const evaluations: StrategyEvaluation[] = [
    evaluation({
      id: "long_call", label: "Long Call", category: "single", status: "accepted",
      generated: 5, accepted: 5, reasons: [],
    }),
    evaluation({
      id: "covered_call", label: "Covered Call", category: "stock", status: "accepted",
      generated: 3, accepted: 1,
      reasons: [{ reason: "Covered Call is not profitable at the stated target under the selected assumptions", count: 2 }],
    }),
    evaluation({
      id: "iron_condor", label: "Iron Condor", category: "condor", status: "accepted",
      generated: 10, accepted: 4,
      reasons: [
        { reason: "Iron Condor exceeds the max planned loss", count: 4 },
        { reason: "Iron Condor is below the minimum target reward/risk", count: 2 },
      ],
    }),
    evaluation({
      id: "bull_put_spread", label: "Bull Put Spread", category: "vertical", status: "accepted",
      generated: 8, accepted: 3,
      reasons: [{ reason: "Bull Put Spread is not profitable at the stated target under the selected assumptions", count: 5 }],
    }),
    evaluation({
      id: "short_straddle", label: "Short Straddle", category: "volatility", status: "skipped",
      generated: 0, accepted: 0, reasons: [],
    }),
  ];
  const ranked: RankedStrategy[] = [
    rankedEntry("long_call", 92, "lc-1"),
    rankedEntry("covered_call", 92, "cc-1"),
    rankedEntry("iron_condor", 88.5, "ic-1"),
    rankedEntry("iron_condor", 71.2, "ic-2"),
  ];
  const rollup = buildTypeRollup(evaluations, ranked);
  const byType = new Map(rollup.map((t) => [t.strategyType, t]));

  it("reports ledger counts and flattened reasons per type", () => {
    const condor = byType.get("iron_condor")!;
    expect(condor.label).toBe("Iron Condor");
    expect(condor.category).toBe("condor");
    expect(condor.evaluatedCount).toBe(10);
    expect(condor.passedCount).toBe(4);
    expect(condor.rejectedCount).toBe(6);
    expect(condor.rejectionReasons).toEqual({
      "Iron Condor exceeds the max planned loss": 4,
      "Iron Condor is below the minimum target reward/risk": 2,
    });
    const covered = byType.get("covered_call")!;
    expect(covered.evaluatedCount).toBe(3);
    expect(covered.passedCount).toBe(1);
    expect(covered.rejectedCount).toBe(2);
  });

  it("picks the highest-composite ranked candidate of each type as its best", () => {
    const condor = byType.get("iron_condor")!;
    expect(condor.bestComposite).toBe(88.5);
    expect(condor.best).toMatchObject({
      candidateId: "ic-1",
      compositeScore: 88.5,
      score: 83.5,
      expirationDate: "2026-11-20",
      netDebit: 320,
      maxLoss: 320,
      maxProfit: 680,
      maxProfitUnbounded: false,
      targetRewardRisk: 2.1,
      probabilityOfProfit: 0.42,
    });
    expect(condor.best!.legs).toHaveLength(1);
    expect(byType.get("long_call")!.best!.candidateId).toBe("lc-1");
  });

  it("keeps passed-but-unranked types honest: passedCount > 0, best null", () => {
    const bullPut = byType.get("bull_put_spread")!;
    expect(bullPut.passedCount).toBe(3);
    expect(bullPut.best).toBeNull();
    expect(bullPut.bestComposite).toBeNull();
    const straddle = byType.get("short_straddle")!;
    expect(straddle.evaluatedCount).toBe(0);
    expect(straddle.passedCount).toBe(0);
    expect(straddle.rejectedCount).toBe(0);
    expect(straddle.best).toBeNull();
  });

  it("orders by best composite descending, ties by type ascending, best-less last", () => {
    expect(rollup.map((t) => t.strategyType)).toEqual([
      "covered_call", // 92 — ties with long_call, type ascending wins
      "long_call", // 92
      "iron_condor", // 88.5
      "bull_put_spread", // best-less, type ascending among best-less
      "short_straddle", // best-less
    ]);
  });

  it("reconciles with the ledger totals (acceptance criterion 2)", () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(rollup.map((t) => t.evaluatedCount))).toBe(sum(evaluations.map((e) => e.generated)));
    expect(sum(rollup.map((t) => t.passedCount))).toBe(sum(evaluations.map((e) => e.accepted)));
    expect(sum(rollup.map((t) => t.rejectedCount))).toBe(
      sum(evaluations.map((e) => e.generated)) - sum(evaluations.map((e) => e.accepted)),
    );
  });
});

// ---------------------------------------------------------------------------
// rollupScanTypes (scan)
// ---------------------------------------------------------------------------

describe("rollupScanTypes (issue #26)", () => {
  const matrix: ScanMatrixRow[] = [
    matrixRow("NVDA", "pass", [
      {
        strategyType: "iron_condor", best: cellBest("nvda-ic", 88.5),
        evaluatedCount: 6, passedCount: 2, rejectedCount: 4,
        rejectionReasons: { "spread too wide": 3, "low POP": 1 },
      },
      {
        strategyType: "long_call", best: cellBest("nvda-lc", 91),
        evaluatedCount: 3, passedCount: 3, rejectedCount: 0,
        rejectionReasons: {},
      },
    ]),
    matrixRow("AMD", "pass", [
      {
        strategyType: "iron_condor", best: cellBest("amd-ic", 90.25),
        evaluatedCount: 4, passedCount: 1, rejectedCount: 3,
        rejectionReasons: { "spread too wide": 2, "stale quote": 1 },
      },
      {
        strategyType: "long_call", best: null,
        evaluatedCount: 2, passedCount: 0, rejectedCount: 2,
        rejectionReasons: { "low POP": 2 },
      },
      {
        strategyType: "bull_put_spread", best: null,
        evaluatedCount: 5, passedCount: 0, rejectedCount: 5,
        rejectionReasons: { "low POP": 5 },
      },
    ]),
    matrixRow("ZZZ", "skipped", []),
  ];
  const rollup = rollupScanTypes(matrix);
  const byType = new Map(rollup.map((t) => [t.strategyType, t]));

  it("aggregates counts, symbol coverage and merged reasons per type", () => {
    const condor = byType.get("iron_condor")!;
    expect(condor.symbolsEvaluated).toBe(2);
    expect(condor.symbolsPassed).toBe(2);
    expect(condor.evaluatedCount).toBe(10);
    expect(condor.passedCount).toBe(3);
    expect(condor.rejectedCount).toBe(7);
    expect(condor.rejectionReasons).toEqual({ "spread too wide": 5, "low POP": 1, "stale quote": 1 });

    const longCall = byType.get("long_call")!;
    expect(longCall.symbolsEvaluated).toBe(2);
    expect(longCall.symbolsPassed).toBe(1); // AMD's cell passed nothing
    expect(longCall.evaluatedCount).toBe(5);
    expect(longCall.passedCount).toBe(3);
    expect(longCall.rejectedCount).toBe(2);

    const bullPut = byType.get("bull_put_spread")!;
    expect(bullPut.symbolsEvaluated).toBe(1);
    expect(bullPut.symbolsPassed).toBe(0);
    expect(bullPut.bestOverall).toBeNull();
  });

  it("names the symbol behind each type's best overall candidate", () => {
    expect(byType.get("iron_condor")!.bestOverall).toMatchObject({ symbol: "AMD", candidateId: "amd-ic", compositeScore: 90.25 });
    expect(byType.get("long_call")!.bestOverall).toMatchObject({ symbol: "NVDA", candidateId: "nvda-lc", compositeScore: 91 });
  });

  it("orders by best overall composite descending, best-less last", () => {
    expect(rollup.map((t) => t.strategyType)).toEqual(["long_call", "iron_condor", "bull_put_spread"]);
  });

  it("reconciles with the matrix cell totals (acceptance criterion 2)", () => {
    const cells = matrix.flatMap((r) => r.cells);
    const sumCells = (pick: (c: ScanMatrixRow["cells"][number]) => number) => cells.reduce((a, c) => a + pick(c), 0);
    const sumRollup = (pick: (t: (typeof rollup)[number]) => number) => rollup.reduce((a, t) => a + pick(t), 0);
    expect(sumRollup((t) => t.evaluatedCount)).toBe(sumCells((c) => c.evaluatedCount));
    expect(sumRollup((t) => t.passedCount)).toBe(sumCells((c) => c.passedCount));
    expect(sumRollup((t) => t.rejectedCount)).toBe(sumCells((c) => c.rejectedCount));
    // Symbol coverage: each (symbol, type) cell is counted exactly once.
    expect(sumRollup((t) => t.symbolsEvaluated)).toBe(cells.length);
  });

  it("an empty matrix rolls up to an empty list", () => {
    expect(rollupScanTypes([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end wiring. Stub E*TRADE client + chain fixture (pattern from
// tests/options_scanner.test.ts) driving the real screener/pipeline.
// ---------------------------------------------------------------------------

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function chainFor(symbol: string, spot: number, expiry: { year: number; month: number; day: number }): ETradeOptionChain {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

function stubEtrade(spots: Record<string, number>) {
  const client = {
    getOptionExpireDates: async () => [expiryObj],
    getOptionChains: async (args: { symbol: string }) =>
      spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol], expiryObj) : null,
  };
  return {
    client: client as never,
    fetchQuoteRemote: async (symbol: string) => ({ lastPrice: spots[symbol] ?? 0 }),
    getWatchlists: async () => [{ name: "Semis", symbols: Object.keys(spots) }],
    screenMarketsAsync: async () => ({ stocks: [] }),
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("single-name type roll-up wiring (issue #26)", () => {
  it("best-trade action carries the roll-up next to the overall best", async () => {
    const intent = parseOptionsStrategyIntent(
      "What is the best trade for NVDA bullish target $260 in 30 days max loss $5000 conservative",
    );
    expect(intent?.action).toBe("options_best_trade");
    const out = await runOptionsStrategyAction(stubEtrade({ NVDA: 250 }) as never, intent!.action, intent!.filters);

    const rollup = out.typeRollup as StrategyTypeRollup[] | undefined;
    expect(rollup).toBeDefined();
    expect(rollup!.length).toBeGreaterThan(0);

    // Counts reconcile with the evaluations riding on the same result.
    const evaluations = out.evaluations as StrategyEvaluation[];
    expect(sum(rollup!.map((t) => t.evaluatedCount))).toBe(sum(evaluations.map((e) => e.generated)));
    expect(sum(rollup!.map((t) => t.passedCount))).toBe(sum(evaluations.map((e) => e.accepted)));

    // The overall best pick's type entry names that very candidate as
    // the type's best, at the pick's composite score (acceptance 1).
    const pick = out.bestTrade as BestTradePick;
    expect(pick.best).not.toBeNull();
    const entry = rollup!.find((t) => t.strategyType === pick.best!.candidate.type);
    expect(entry).toBeDefined();
    expect(entry!.best).not.toBeNull();
    expect(entry!.best!.candidateId).toBe(pick.best!.candidate.id);
    expect(entry!.bestComposite).toBe(pick.best!.compositeScore);

    expect(out.summary).toContain("Best by type:");
  });

  it("strategies action carries the roll-up next to the ranked list", async () => {
    const intent = parseOptionsStrategyIntent(
      "Rank bullish NVDA call debit spreads and put credit spreads target $260 in 30 days max loss $5000",
    );
    expect(intent?.action).toBe("options_strategies");
    const out = await runOptionsStrategyAction(stubEtrade({ NVDA: 250 }) as never, intent!.action, intent!.filters);

    const rollup = out.typeRollup as StrategyTypeRollup[] | undefined;
    expect(rollup).toBeDefined();
    const evaluations = out.evaluations as StrategyEvaluation[];
    expect(sum(rollup!.map((t) => t.evaluatedCount))).toBe(sum(evaluations.map((e) => e.generated)));
    expect(sum(rollup!.map((t) => t.passedCount))).toBe(sum(evaluations.map((e) => e.accepted)));
    // Only the two requested types can have bests; both were requested
    // precisely because they produce ranked candidates on this chain.
    const withBest = rollup!.filter((t) => t.best !== null).map((t) => t.strategyType);
    expect(withBest.length).toBeGreaterThan(0);
    expect(withBest.every((t) => t === "call_debit_spread" || t === "put_credit_spread")).toBe(true);
    expect(out.summary).toContain("Best by type:");
  });

  it("unified best_trade and strategies actions carry the roll-up", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: chainFor("NVDA", 250, expiryObj) });
    try {
      const service = new UnifiedOptionsService({ ETRADE_ENVIRONMENT: "sandbox" } as never, "test_trader");
      const best = await service.execute({ action: "best_trade", symbol: "NVDA", thesis: "bullish" });
      expect(best.success).toBe(true);
      const bestRollup = (best.data as { typeRollup?: StrategyTypeRollup[] }).typeRollup;
      expect(bestRollup).toBeDefined();
      expect(bestRollup!.length).toBeGreaterThan(0);
      expect(sum(bestRollup!.map((t) => t.evaluatedCount))).toBeGreaterThan(0);

      const strategies = await service.execute({ action: "strategies", symbol: "NVDA", thesis: "bullish" });
      expect(strategies.success).toBe(true);
      const stratRollup = (strategies.data as { typeRollup?: StrategyTypeRollup[] }).typeRollup;
      expect(stratRollup).toBeDefined();
      expect(stratRollup!.length).toBeGreaterThan(0);
    } finally {
      DynamicOptionsScreener.clearTestChainsFixture();
    }
  });
});

// ---------------------------------------------------------------------------
// Scan end-to-end: scanner result roll-up + NLQ scan summary clause.
// Fake screener pattern from tests/options_scanner.test.ts.
// ---------------------------------------------------------------------------

const scanExpiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function scanTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: scanExpiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

function makeContracts(symbol: string, spot: number): ScreenedOptionContractItem[] {
  const now = Date.now();
  return [0.9, 0.95, 1, 1.05, 1.1].flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: scanExpiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

describe("scan type roll-up wiring (issue #26)", () => {
  it("scanner result roll-up reconciles with its own matrix", async () => {
    const screener = {
      screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
        const symbol = filter.underlyingSymbols?.[0] ?? "";
        const spot = symbol === "NVDA" ? 250 : 40;
        const contracts = makeContracts(symbol, spot);
        return {
          contracts,
          matchedCount: contracts.length,
          totalContractsEvaluated: contracts.length,
          totalUnderlyingsScanned: 1,
          scannedAt: new Date().toISOString(),
          rejections: [],
        } as unknown as OptionScreenResult;
      },
    } as unknown as DynamicOptionsScreener;
    const scanner = new OpportunityScanner(screener);
    const result = await scanner.scan(["NVDA", "AMD"], scanTemplate());

    expect(result.typeRollup.length).toBeGreaterThan(0);
    const cells = result.matrix.flatMap((r) => r.cells);
    const sumCells = (pick: (c: ScanMatrixRow["cells"][number]) => number) => cells.reduce((a, c) => a + pick(c), 0);
    expect(sum(result.typeRollup.map((t) => t.evaluatedCount))).toBe(sumCells((c) => c.evaluatedCount));
    expect(sum(result.typeRollup.map((t) => t.passedCount))).toBe(sumCells((c) => c.passedCount));
    expect(sum(result.typeRollup.map((t) => t.rejectedCount))).toBe(sumCells((c) => c.rejectedCount));
    expect(sum(result.typeRollup.map((t) => t.symbolsEvaluated))).toBe(cells.length);
    // bestOverall is the max cell best per type, with its symbol.
    for (const entry of result.typeRollup) {
      const typeCells = result.matrix.flatMap((r) =>
        r.cells.filter((c) => c.strategyType === entry.strategyType).map((c) => ({ symbol: r.symbol, cell: c })),
      );
      expect(entry.symbolsEvaluated).toBe(typeCells.length);
      const bests = typeCells.filter((x) => x.cell.best !== null);
      if (!bests.length) {
        expect(entry.bestOverall).toBeNull();
      } else {
        const max = Math.max(...bests.map((x) => x.cell.best!.compositeScore));
        expect(entry.bestOverall!.compositeScore).toBe(max);
        expect(bests.some((x) => x.symbol === entry.bestOverall!.symbol && x.cell.best!.compositeScore === max)).toBe(true);
      }
    }
  });

  it("NLQ scan summary gains the Best by type clause and the result carries the roll-up", async () => {
    const intent = parseOptionsStrategyIntent("Best bullish option trades for NVDA and AMD max loss $5000");
    expect(intent?.action).toBe("options_opportunities");
    const out = await runOptionsStrategyAction(stubEtrade({ NVDA: 250, AMD: 40 }) as never, intent!.action, intent!.filters);

    expect(out.summary).toContain("Best by type:");
    const rollup = out.typeRollup as import("../src/trading/options/opportunityScanner").ScanTypeRollup[] | undefined;
    expect(rollup).toBeDefined();
    expect(rollup!.length).toBeGreaterThan(0);
    const cells = out.matrix!.flatMap((r) => r.cells);
    expect(sum(rollup!.map((t) => t.evaluatedCount))).toBe(cells.reduce((a, c) => a + c.evaluatedCount, 0));
    expect(sum(rollup!.map((t) => t.passedCount))).toBe(cells.reduce((a, c) => a + c.passedCount, 0));
    // The clause names the roll-up's top type with its best symbol.
    const top = rollup!.find((t) => t.bestOverall !== null)!;
    expect(out.summary).toContain(`${top.strategyType} ${top.bestOverall!.compositeScore.toFixed(1)} (${top.bestOverall!.symbol})`);
  });
});
