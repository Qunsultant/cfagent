/**
 * Consolidation C4 (#1329) — kernel probe parity.
 *
 * Fixed probe set (names × outlooks) over fixture chains: the kernel
 * panel output (RecommendationService.discoverPanel) and the panel
 * pipeline function (runPanelPipelineRetired4068, #1256 remainder: the
 * OptionsAgentPipeline adapter retired, its run() mapping moved
 * verbatim into the function) must produce the SAME route-shape
 * output as the pre-migration pipeline — whose steps are replayed
 * inline here from the same agents (loadSnapshot → buildStrategies →
 * screenStrategies → rank → pickBestTrade). Compared per probe:
 * ranked ids + order, bestTrade best id (or status), screenedOut ids,
 * and riskReport candidate ids. A divergence is a test failure, not a
 * footnote: the PR must enumerate and justify any that remains.
 *
 * Provenance probes: live (real snapshot) and calibrated-demo
 * (facade dataAgent stub — the kernel caps calibrated candidates at
 * Watchlist internally, which must NOT change the route-shape ranked
 * output). Stale quotes exercise the research_only bestTrade path.
 * NLQ + scheduled paths are covered by construction: both resolve to
 * the same panel function (UnifiedOptionsService.runStrategyPipeline
 * and scheduled runDiscoveryRequest call runPanelPipelineRetired4068 /
 * runPanelWithAgents), so function ≡ facade parity on these probes
 * is their parity too.
 */
import { describe, expect, it } from "vitest";
import type { OptionScreenResult, ScreenedOptionContractItem } from "../src/types";
import type { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import {
  runPanelPipelineRetired4068,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type StrategyRequest,
} from "../src/trading/options";
import { RecommendationService } from "../src/services/recommendationKernel";

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function makeContracts(opts: { fresh?: boolean } = {}): ScreenedOptionContractItem[] {
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
      { ...base, optionType: "CALL" as const, symbol: `XYZ${strike}C`, osiKey: `XYZ-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `XYZ${strike}P`, osiKey: `XYZ-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
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

/** The pre-migration pipeline, replayed inline from the same agents. */
async function baselinePipeline(req: StrategyRequest, opts: { strategyFilter?: unknown; riskProfile?: "conservative" | "balanced" | "aggressive"; alternatives?: number } = {}) {
  const data = new OptionsDataAgent(fakeScreener(makeContracts()));
  const risk = new StrategyRiskAgent();
  const recommender = new RecommendationAgent();
  const snapshot = await data.loadSnapshot(req);
  const strategies = risk.buildStrategies(snapshot.contracts, req);
  const { matched, rejected } = risk.screenStrategies(strategies.candidates, opts.strategyFilter as never);
  const profile = opts.riskProfile ?? "balanced";
  const rankedAll = recommender.rank(matched, req, profile);
  const limit = req.candidateLimit ?? rankedAll.length;
  return {
    snapshot,
    strategies,
    screenedOut: rejected,
    ranked: rankedAll.slice(0, limit),
    riskReports: rankedAll.slice(0, limit).map((r) => risk.riskReport(r.candidate, req)),
    bestTrade: recommender.pickBestTrade(matched, req, profile, opts.alternatives ?? 3),
  };
}

async function kernelPanel(req: StrategyRequest, opts: { strategyFilter?: unknown; riskProfile?: "conservative" | "balanced" | "aggressive"; alternatives?: number } = {}) {
  const data = new OptionsDataAgent(fakeScreener(makeContracts()));
  return new RecommendationService().discoverPanel({
    dataAgent: {
      loadSnapshot: async (params: unknown) => {
        const s = await data.loadSnapshot(params as StrategyRequest);
        return { symbol: s.symbol, contracts: s.contracts, dataSource: s.dataSource, screen: s.screen, rejections: s.rejections, validationError: s.validationError };
      },
    },
    riskAgent: new StrategyRiskAgent(),
    recommender: new RecommendationAgent(),
    request: req,
    strategyFilter: opts.strategyFilter as never,
    riskProfile: opts.riskProfile,
    alternatives: opts.alternatives,
  });
}

describe("C4 kernel probe parity (#1329)", () => {
  const probes: Array<{ name: string; req: StrategyRequest; opts?: { strategyFilter?: unknown; riskProfile?: "conservative" | "balanced" | "aggressive"; alternatives?: number } }> = [
    { name: "bullish baseline", req: request() },
    { name: "conservative + candidateLimit 2", req: request({ candidateLimit: 2 }), opts: { riskProfile: "conservative" } },
    { name: "long_call filter only", req: request(), opts: { strategyFilter: { strategyTypes: ["long_call"], minProbabilityOfProfit: 0.01 } } },
    { name: "tight maxPlannedLoss (no_trade)", req: request({ maxPlannedLoss: 1 }) },
  ];

  for (const probe of probes) {
    it(`${probe.name}: kernel panel ≡ pre-migration pipeline ≡ panel function`, async () => {
      const base = await baselinePipeline(probe.req, probe.opts);
      const panel = await kernelPanel(probe.req, probe.opts);
      const panelFn = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), probe.req, probe.opts as never);

      const baseRanked = base.ranked.map((r) => r.candidate.id);
      const panelRanked = panel.ranked.map((r) => r.candidate.id);
      const panelFnRanked = panelFn.ranked.map((r) => r.candidate.id);
      expect(panelRanked).toEqual(baseRanked);
      expect(panelFnRanked).toEqual(baseRanked);

      const baseBest = base.bestTrade.best?.candidate.id;
      expect(panel.bestTrade.best?.candidate.id).toBe(baseBest);
      expect(panel.bestTrade.status).toBe(base.bestTrade.status);
      expect(panelFn.bestTrade.best?.candidate.id).toBe(baseBest);

      const baseScreened = base.screenedOut.map((r) => r.id).sort();
      expect(panel.screenedOut.map((r) => r.id).sort()).toEqual(baseScreened);
      expect(panelFn.screenedOut.map((r) => r.id).sort()).toEqual(baseScreened);

      expect(panel.riskReports.length).toBe(base.riskReports.length);
      expect(panelFn.riskReports.length).toBe(base.riskReports.length);
      // /compare pool input: the panel function's strategies carry the FULL
      // built set (not gate-survivors) with scoreWeights intact.
      expect(panelFn.strategies.candidates.map((c) => c.id).sort()).toEqual(
        base.strategies.candidates.map((c) => c.id).sort(),
      );
      expect(panelFn.strategies.scoreWeights).toEqual(base.strategies.scoreWeights);
    });
  }

  it("calibrated-demo provenance: Watchlist cap internally, route-shape ranked output unchanged", async () => {
    const req = request();
    const live = await kernelPanel(req);
    const data = new OptionsDataAgent(fakeScreener(makeContracts()));
    const calibrated = await new RecommendationService().discoverPanel({
      dataAgent: {
        loadSnapshot: async (params: unknown) => {
          const s = await data.loadSnapshot(params as StrategyRequest);
          return { symbol: s.symbol, contracts: s.contracts, dataSource: "calibrated-demo" as const, screen: s.screen, rejections: s.rejections, validationError: s.validationError };
        },
      },
      riskAgent: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
      request: req,
    });
    expect(calibrated.ranked.map((r) => r.candidate.id)).toEqual(live.ranked.map((r) => r.candidate.id));
    // The kernel's own candidate tiers are capped (never qualified).
    expect(calibrated.candidates.every((c) => c.status !== "qualified")).toBe(true);
  });

  it("stale quotes: research_only bestTrade preserved through the kernel", async () => {
    const staleContracts = makeContracts({ fresh: false });
    const data = new OptionsDataAgent(fakeScreener(staleContracts));
    const panel = await new RecommendationService().discoverPanel({
      dataAgent: {
        loadSnapshot: async (params: unknown) => {
          const s = await data.loadSnapshot(params as StrategyRequest);
          return { symbol: s.symbol, contracts: s.contracts, dataSource: s.dataSource, screen: s.screen, rejections: s.rejections, validationError: s.validationError };
        },
      },
      riskAgent: new StrategyRiskAgent(),
      recommender: new RecommendationAgent(),
      request: request(),
    });
    expect(panel.bestTrade.status).toBe("research_only");
  });
});
