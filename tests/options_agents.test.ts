import { describe, expect, it } from "vitest";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../src/types";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  runPanelPipelineRetired4068,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  validateStrategyRequest,
  type StrategyRequest,
} from "../src/trading/options";

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function makeContracts(opts: { sharedSymbol?: boolean; fresh?: boolean } = {}): ScreenedOptionContractItem[] {
  const now = Date.now();
  const fresh = opts.fresh ?? true;
  return [90, 95, 100, 105, 110].flatMap((strike) => {
    const timeValue = Math.max(0.3, 3 - Math.abs(strike - 100) * 0.12);
    const callMid = Math.max(0.3, Math.max(100 - strike, 0) + timeValue);
    const putMid = Math.max(0.3, Math.max(strike - 100, 0) + timeValue);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strike) / 40));
    const base = {
      underlyingSymbol: "XYZ",
      underlyingPrice: 100,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: Math.abs(strike - 100),
      spreadPct: 8,
      quoteAgeSeconds: fresh ? 0 : 50_000,
      quoteTimestamp: new Date(fresh ? now : now - 50_000_000).toISOString(),
      quoteFreshness: fresh ? ("FRESH" as const) : ("STALE" as const),
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
      { ...base, optionType: "CALL" as const, symbol: opts.sharedSymbol ? "XYZ" : `XYZ${strike}C`, osiKey: `XYZ-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: opts.sharedSymbol ? "XYZ" : `XYZ${strike}P`, osiKey: `XYZ-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

function request(overrides: Partial<StrategyRequest> = {}): StrategyRequest {
  return {
    symbol: "XYZ",
    thesis: "bullish",
    targetPrice: 110,
    targetDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 1_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    ...overrides,
  };
}

function fakeScreener(contracts: ScreenedOptionContractItem[]): DynamicOptionsScreener {
  const result = {
    contracts,
    matchedCount: contracts.length,
    totalContractsEvaluated: contracts.length,
    totalUnderlyingsScanned: 1,
    scannedAt: new Date().toISOString(),
    rejections: [],
  } as unknown as OptionScreenResult;
  return { screenOptions: async () => result } as unknown as DynamicOptionsScreener;
}

describe("Options data agent", () => {
  it("loads a snapshot with screen metadata", async () => {
    const agent = new OptionsDataAgent(fakeScreener(makeContracts()));
    const snapshot = await agent.loadSnapshot(request());
    expect(snapshot.symbol).toBe("XYZ");
    expect(snapshot.contracts).toHaveLength(10);
    expect(snapshot.screen.contractsMatched).toBe(10);
  });
});

describe("Strategy risk agent", () => {
  const agent = new StrategyRiskAgent();

  it("builds distinct legs even when every contract shares the underlying ticker as symbol", () => {
    const result = agent.buildStrategies(makeContracts({ sharedSymbol: true }), request({ allowedStrategies: ["call_debit_spread"] }));
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(new Set(c.legs.map((l) => l.symbol)).size).toBe(2);
    }
  });

  it("builds bounded-risk credit spreads for a bullish thesis", () => {
    const result = agent.buildStrategies(makeContracts(), request({ allowedStrategies: ["put_credit_spread"], targetPrice: 102 }));
    const spread = result.candidates[0];
    expect(spread.type).toBe("put_credit_spread");
    expect(spread.netDebit).toBeLessThan(0);
    expect(spread.maxProfitUnbounded).toBe(false);
    expect(spread.maxLoss).toBeGreaterThan(0);
    expect(agent.riskReport(spread, { maxPlannedLoss: 1_000 }).isCredit).toBe(true);
  });

  it("screens strategies by risk limits and reports reasons", () => {
    const { candidates } = agent.buildStrategies(makeContracts(), request());
    const { matched, rejected } = agent.screenStrategies(candidates, { strategyTypes: ["long_call"], minProbabilityOfProfit: 0.01 });
    expect(matched.every((c) => c.type === "long_call")).toBe(true);
    expect(rejected.some((r) => r.reason.includes("not in selected strategy types"))).toBe(true);
    expect(agent.screenStrategies(makeContracts().length ? candidates : [], { maxLegs: 1 }).matched.every((c) => c.legs.length === 1)).toBe(true);
  });

  it("validates strategy requests", () => {
    expect(validateStrategyRequest(request())).toBeNull();
    expect(validateStrategyRequest({ ...request(), allowedStrategies: ["bogus" as never] })).not.toBeNull();
    expect(validateStrategyRequest(null)).not.toBeNull();
  });
});

describe("Recommendation agent and pipeline", () => {
  it("picks a best trade with plan, rationale and alternatives", async () => {
    const result = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), request(), { riskProfile: "balanced" });
    const pick = result.bestTrade;
    expect(pick.status).toBe("recommended");
    expect(pick.best?.rank).toBe(1);
    expect(pick.tradePlan?.length).toBe(pick.best?.candidate.legs.length);
    expect(pick.alternatives.length).toBeLessThanOrEqual(3);
    expect(pick.humanApprovalRequired).toBe(true);
    expect(result.ranked[0].compositeScore).toBeGreaterThanOrEqual(result.ranked[1].compositeScore);
  });

  it("flags stale data as research-only with low confidence", async () => {
    const { bestTrade } = await runPanelPipelineRetired4068(fakeScreener(makeContracts({ fresh: false })), request());
    expect(bestTrade.status).toBe("research_only");
    expect(bestTrade.confidence).toBe("LOW");
    expect(bestTrade.blockers[0]).toContain("STALE");
  });

  it("returns no_trade when nothing qualifies", async () => {
    const { bestTrade } = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), request({ maxPlannedLoss: 1 }));
    expect(bestTrade.status).toBe("no_trade");
    expect(bestTrade.best).toBeUndefined();
  });

  it("changes ranking weights by risk profile", () => {
    const agent = new RecommendationAgent();
    expect(agent.weightsFor("conservative").probability).toBeGreaterThan(agent.weightsFor("aggressive").probability);
    expect(agent.weightsFor("aggressive").rewardRisk).toBeGreaterThan(agent.weightsFor("conservative").rewardRisk);
  });
});
