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


import { MockSqlStorage } from "./mock-sql";

import type { YahooDailyBar } from "../src/trading/technicals";
import {
  chainAggregatesFromContracts,
  type ChainContractLike,
} from "../src/trading/options/discoverySignals";
import {
  InMemoryDiscoverySetupStore,
  type DiscoverySetupItem,
} from "../src/trading/options/discoverySetupStore";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";
import type { PipelineResult } from "../src/trading/options/index";
import type {
  BestTradePick,
  RankedStrategy,
} from "../src/trading/options/recommendationAgent";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";
import {
  hashDiscoveryConfig,
  runDiscovery,
  type DiscoveryServiceDeps,
} from "../src/services/discoveryService";

/**
 * Issue #14 slice 5a — the discovery service: per-name orchestration
 * of slices 1–4 (characterize -> prescreen -> infer -> express ->
 * persist + deltas), plus the chain-aggregates adapter.
 *
 * Acceptance (a)/(e) live here: a run over a mixed universe returns
 * expressed setups with evidence or explicit abstentions per name,
 * and the coverage counts reconcile exactly. All market deps are
 * fakes; the pipeline is stubbed per symbol.
 */

describe("chainAggregatesFromContracts", () => {
  const contracts: ChainContractLike[] = [
    { strikePrice: 95, openInterest: 10_000, volume: 900, spreadPct: 2, impliedVolatility: 0.28 },
    { strikePrice: 100, openInterest: 30_000, volume: 5_000, spreadPct: 4, impliedVolatility: 0.3 },
    { strikePrice: 105, openInterest: 12_000, volume: 2_500, spreadPct: 6, impliedVolatility: 0.33 },
  ];

  it("sums OI/volume, medians the spread, and takes the nearest-strike IV as ATM", () => {
    const agg = chainAggregatesFromContracts(contracts, 101);
    expect(agg.contractCount).toBe(3);
    expect(agg.totalOpenInterest).toBe(52_000);
    expect(agg.totalVolume).toBe(8_400);
    expect(agg.medianSpreadPct).toBe(4);
    expect(agg.atmIv).toBe(0.3);
  });

  it("empty chain -> zero totals, null spread/IV, zero count", () => {
    const agg = chainAggregatesFromContracts([], 100);
    expect(agg).toEqual({
      contractCount: 0,
      totalOpenInterest: 0,
      totalVolume: 0,
      medianSpreadPct: null,
      atmIv: null,
    });
  });

  it("unreported fields sum to zero and stay null where the type allows", () => {
    const agg = chainAggregatesFromContracts([{ strikePrice: 100 }], 100);
    expect(agg.totalOpenInterest).toBe(0);
    expect(agg.atmIv).toBeNull();
  });
});

function barsFromCloses(closes: number[]): YahooDailyBar[] {
  return closes.map((close, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1_000_000,
  }));
}

function linearCloses(start: number, end: number, n: number): number[] {
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

function snapshot(symbol: string, spot: number, contractCount: number): OptionsDataSnapshot {
  const contracts = Array.from({ length: contractCount }, (_, i) => ({
    symbol: `${symbol}251120C${100 + i * 5}`,
    underlyingSymbol: symbol,
    underlyingPrice: spot,
    strikePrice: spot - 10 + i * 5,
    expirationDate: "2026-11-20",
    daysToExpiration: 29,
    moneyness: "ATM" as const,
    strikeDistancePct: 0,
    spreadPct: 3,
    technicalSignal: "",
    highlightReason: "",
    bid: 1,
    ask: 1.05,
    volume: 900,
    openInterest: 6_000,
    impliedVolatility: 0.3,
  }));
  return {
    symbol,
    contracts: contracts as unknown as OptionsDataSnapshot["contracts"],
    dataSource: "live",
    screen: { underlyingsScanned: 1, contractsEvaluated: contractCount, contractsMatched: contractCount },
    rejections: [],
  };
}

function pickWithScore(score: number): BestTradePick {
  const candidate = {
    id: "cand-1",
    type: "long_call",
    label: "Long call",
    symbol: "TREND",
    expirationDate: "2026-11-20",
    dataFreshness: "FRESH",
    modelImpliedProbabilityOfProfit: 0.42,
  } as unknown as StrategyCandidate;
  const best: RankedStrategy = {
    candidate,
    rank: 1,
    compositeScore: score,
    components: { engineScore: 0, probability: 0, rewardRisk: 0, capitalSafety: 0, liquidity: 0 },
  };
  return {
    status: "recommended",
    riskProfile: "balanced",
    confidence: "MEDIUM",
    best,
    alternatives: [],
    rationale: [],
    blockers: [],
    humanApprovalRequired: true,
    disclaimer: "fixture",
  };
}

function pipelineResult(score: number): PipelineResult {
  const pick = pickWithScore(score);
  return {
    snapshot: {},
    strategies: {},
    screenedOut: [],
    ranked: pick.best ? [pick.best] : [],
    riskReports: [],
    bestTrade: pick,
  } as unknown as PipelineResult;
}

const TREND_BARS = barsFromCloses([...linearCloses(100, 132, 60), 130]);
const SAWTOOTH_BARS = barsFromCloses(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 103 : 97)));

function makeDeps(store: InMemoryDiscoverySetupStore, score = 72): DiscoveryServiceDeps {
  return {
    loadSnapshot: async (symbol) => {
      if (symbol === "BROKEN") throw new Error("broker timeout");
      if (symbol === "NOCHAIN") return snapshot(symbol, 50, 0);
      if (symbol === "FLAT") return snapshot(symbol, 97, 12);
      return snapshot(symbol, 130, 12);
    },
    fetchBars: async (symbol) => (symbol === "FLAT" ? SAWTOOTH_BARS : TREND_BARS),
    ivStatsFor: async () => null,
    calendarFor: async (symbol) => ({
      symbol,
      covered: false,
      source: "test",
      earningsDate: null,
      daysToEarnings: null,
      exDividendDate: null,
      daysToExDiv: null,
      fetchedAt: "2026-10-22T12:00:00.000Z",
    }),
    flowFor: async () => [],
    runPipeline: async () => pipelineResult(score),
    store,
    now: () => new Date("2026-10-22T12:00:00.000Z"),
  };
}

const REQUEST = {
  symbols: ["TREND", "FLAT", "NOCHAIN", "BROKEN"],
  scopeKey: "test:scope",
  source: "test",
  caps: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
};

describe("runDiscovery", () => {
  it("expresses setups with evidence, abstains explicitly, and reconciles counts (acceptance (a)+(e))", async () => {
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-1" });
    const { run, deltas, errors } = await runDiscovery(makeDeps(store), REQUEST);

    expect(run.counts).toEqual({ considered: 4, setups: 1, abstentions: 1, prescreenedOut: 1, errors: 1 });
    expect(errors).toEqual([{ symbol: "BROKEN", message: "broker timeout" }]);

    const setupItem = run.items.find((i) => i.symbol === "TREND");
    expect(setupItem?.kind).toBe("setup");
    if (setupItem?.kind === "setup") {
      expect(setupItem.ruleId).toBe("trend-up");
      expect(setupItem.discoveryScore).toBe(72);
      expect(setupItem.gateBucket).toBe("fit");
      expect(setupItem.evidence.length).toBeGreaterThan(0);
      expect(setupItem.targetPrice).toBeGreaterThan(130);
    }
    const flatItem = run.items.find((i) => i.symbol === "FLAT");
    expect(flatItem?.kind).toBe("abstention");
    if (flatItem?.kind === "abstention") expect(flatItem.stage).toBe("inference");

    // First run for the scope: the one setup is NEW.
    expect(deltas).toEqual([expect.objectContaining({ symbol: "TREND", kind: "NEW" })]);

    // The run is actually persisted.
    const stored = await store.get("run-1");
    expect(stored?.id).toBe("run-1");
    expect(stored?.modelVersion).toBe("discovery-v1");
    expect(stored?.configHash).toBe(hashDiscoveryConfig());
  });

  it("classifies the second comparable run against the first", async () => {
    let n = 0;
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => `run-${++n}` });
    await runDiscovery(makeDeps(store, 72), REQUEST);
    const second = await runDiscovery(makeDeps(store, 85), REQUEST);
    expect(second.deltas).toEqual([
      expect.objectContaining({ symbol: "TREND", kind: "STRENGTHENED", prevScore: 72, score: 85 }),
    ]);
    expect(await store.list({ scopeKey: "test:scope" })).toHaveLength(2);
  });

  it("an empty universe produces a valid empty run", async () => {
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-e" });
    const { run, deltas } = await runDiscovery(makeDeps(store), { ...REQUEST, symbols: [] });
    expect(run.counts).toEqual({ considered: 0, setups: 0, abstentions: 0, prescreenedOut: 0, errors: 0 });
    expect(run.items).toEqual([]);
    expect(deltas).toEqual([]);
  });
});

describe("hashDiscoveryConfig", () => {
  it("is a stable short hex fingerprint", () => {
    const h = hashDiscoveryConfig();
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(hashDiscoveryConfig()).toBe(h);
  });
});

describe("unified discovery action wiring", () => {
  it("fails honestly when the discovery SQL seam is not wired", async () => {
    const { UnifiedOptionsService } = await import("../src/trading/options/unifiedOptionsService");
    const service = new UnifiedOptionsService({} as never, "trader");
    const res = await service.execute({ action: "discovery", symbols: ["SPY"] });
    expect(res.success).toBe(false);
    expect(res.summary).toContain("isn't wired");
  });

  it("requires at least one symbol before running", async () => {
    const { UnifiedOptionsService } = await import("../src/trading/options/unifiedOptionsService");
    const service = new UnifiedOptionsService({} as never, "trader", undefined, undefined, undefined, undefined, new MockSqlStorage());
    const res = await service.execute({ action: "discovery", symbols: [] });
    expect(res.success).toBe(false);
    expect(res.summary).toContain("at least one symbol");
  });
});

describe("formatDiscoveryRunSummary", () => {
  it("renders a card line per setup with its evidence, and per abstention with its stage", async () => {
    const { formatDiscoveryRunSummary } = await import("../src/services/discoveryService");
    const store = new InMemoryDiscoverySetupStore({ idFactory: () => "run-f" });
    const outcome = await runDiscovery(makeDeps(store), REQUEST);
    const text = formatDiscoveryRunSummary(outcome);
    expect(text).toContain("Discovery run over 4 names: 1 setup, 1 abstention, 1 pre-screened out, 1 error.");
    expect(text).toContain("TREND bullish — rule trend-up, score 72 (fit)");
    expect(text).toContain("Evidence:");
    expect(text).toContain("FLAT — abstained (inference)");
    expect(text).toContain("BROKEN — error: broker timeout");
  });
});
