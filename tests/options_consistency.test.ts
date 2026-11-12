import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import { runPanelPipelineRetired4068 } from "../src/trading/options/index";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";
import type { ChainView, StrategyContext } from "../src/trading/options/strategies/types";
import { STRATEGY_LIBRARY } from "../src/client/options/strategyLibrary";
import { FAQ_QUESTIONS } from "../src/client/workflowsFaqData";
import { PLATFORM_WORKFLOWS_KNOWLEDGE } from "../src/services/platformKnowledge";

/**
 * Issue #29 consistency guards:
 *  - every surface answers "best strategy" through the one server pipeline,
 *    so the same input must produce the same winner on every call;
 *  - published strategy counts are derived from the catalogs themselves;
 *  - the union catalog invariant: every structure in the (legacy) client
 *    library must exist in the server registry.
 */

const expiry30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const expiry60 = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function makeContracts(): ScreenedOptionContractItem[] {
  const quoteTimestamp = Date.now();
  return [expiry30, expiry60].flatMap((expirationDate, idx) =>
    [90, 95, 100, 105, 110].flatMap((strike) => {
      const timeValue = Math.max(0.3, 3 - Math.abs(strike - 100) * 0.12);
      const callMid = Math.max(0.3, Math.max(100 - strike, 0) + timeValue);
      const putMid = Math.max(0.3, Math.max(strike - 100, 0) + timeValue);
      const delta = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strike) / 40));
      const base = {
        underlyingSymbol: "XYZ",
        underlyingPrice: 100,
        daysToExpiration: idx === 0 ? 30 : 60,
        expirationDate,
        moneyness: "ATM" as const,
        strikeDistancePct: Math.abs(strike - 100),
        spreadPct: 8,
        quoteAgeSeconds: 0,
        quoteTimestamp: new Date(quoteTimestamp).toISOString(),
        quoteFreshness: "FRESH" as const,
        bidSize: 10,
        askSize: 10,
        lastPrice: 2.5,
        volume: 1_000,
        openInterest: 2_000,
        gamma: 0.02,
        theta: -0.03,
        vega: 0.12,
        impliedVolatility: 0.3,
        timeStamp: quoteTimestamp,
        adjustedFlag: false,
        technicalSignal: "Consistency fixture",
        highlightReason: "Consistency fixture",
        volumeOiRatio: 0.5,
      };
      return [
        { ...base, optionType: "CALL" as const, symbol: `XYZ${strike}C${idx}`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
        { ...base, optionType: "PUT" as const, symbol: `XYZ${strike}P${idx}`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
      ] as ScreenedOptionContractItem[];
    }),
  );
}

function fakeScreener(contracts: ScreenedOptionContractItem[]) {
  return {
    screenOptions: async () => ({
      contracts,
      scannedAt: new Date().toISOString(),
      totalUnderlyingsScanned: 1,
      totalContractsEvaluated: contracts.length,
      matchedCount: contracts.length,
      quoteQuality: "HIGH",
      fetchErrors: [],
      warnings: [],
      rejections: [],
    }),
  } as any;
}

const REQUEST: StrategyRequest = {
  symbol: "XYZ",
  thesis: "bullish",
  targetPrice: 110,
  targetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 1_000,
  minRewardRisk: 0.1,
  allowedStrategies: ["all"],
};

describe("cross-surface consistency (issue #29)", () => {
  it("same input through the shared pipeline yields the same winner and ranking", async () => {
    const first = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), REQUEST);
    const second = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), REQUEST);
    expect(first.bestTrade.status).toBe("recommended");
    expect(first.bestTrade.best?.candidate.id).toBeTruthy();
    expect(second.bestTrade.best?.candidate.id).toBe(first.bestTrade.best?.candidate.id);
    expect(second.ranked.map((r) => r.candidate.id)).toEqual(first.ranked.map((r) => r.candidate.id));
  });

  it("surface default options (balanced profile, 3 alternatives) do not change the winner", async () => {
    const bare = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), REQUEST);
    const unifiedStyle = await runPanelPipelineRetired4068(fakeScreener(makeContracts()), REQUEST, { riskProfile: "balanced", alternatives: 3 });
    expect(unifiedStyle.bestTrade.best?.candidate.id).toBe(bare.bestTrade.best?.candidate.id);
  });

  it("published strategy counts are derived from the catalogs", () => {
    const workflow = PLATFORM_WORKFLOWS_KNOWLEDGE.find((w) => w.id === "options-strategy-discovery");
    expect(workflow?.badge).toBe(`${defaultRegistry.list().length}-Strategy Catalog`);
    const scans = FAQ_QUESTIONS.map((q) => q.quickTakeaway ?? "").find((t) => t.includes("engine scans"));
    expect(scans).toContain(`${STRATEGY_LIBRARY.length} strategies`);
  });
});

function rankMap(vals: number[]): Map<number, number> {
  const uniq = Array.from(new Set(vals)).sort((a, b) => a - b);
  return new Map(uniq.map((v, i) => [v, i]));
}
function signature(legs: Array<{ optionType: string; side: string; quantity: number; strike: number; dte: number }>): string {
  const kRank = rankMap(legs.filter((l) => l.optionType !== "STOCK").map((l) => l.strike));
  const eRank = rankMap(legs.map((l) => l.dte));
  return legs
    .map((l) => (l.optionType === "STOCK" ? `STOCK:${l.side}:q${l.quantity}` : `${l.optionType}:${l.side}:q${l.quantity}:k${kRank.get(l.strike)}:e${eRank.get(l.dte)}`))
    .sort()
    .join("|");
}

describe("union catalog completeness (issue #29)", () => {
  it("every client-library structure exists in the server registry", () => {
    const expiries = [
      { expiration: "2026-11-13", dte: 30 },
      { expiration: "2026-12-13", dte: 60 },
      { expiration: "2027-11-13", dte: 400 },
    ];
    const item = (optionType: "CALL" | "PUT", strikePrice: number, expirationDate: string, daysToExpiration: number) =>
      ({
        optionType, strikePrice, expirationDate, daysToExpiration, bid: 1.0, ask: 1.1,
        underlyingSymbol: "XYZ", underlyingPrice: 100, moneyness: "ATM", strikeDistancePct: 0,
        spreadPct: 0.1, technicalSignal: "", highlightReason: "", symbol: `XYZ${expirationDate}${strikePrice}${optionType}`,
      }) as unknown as ScreenedOptionContractItem;
    const chains: ChainView[] = expiries.map(({ expiration, dte }) => {
      const calls = new Map<number, ScreenedOptionContractItem>();
      const puts = new Map<number, ScreenedOptionContractItem>();
      for (let k = 60; k <= 140; k += 5) {
        calls.set(k, item("CALL", k, expiration, dte));
        puts.set(k, item("PUT", k, expiration, dte));
      }
      return { expiration, dte, calls, puts };
    });
    const context = { request: REQUEST, symbol: "XYZ", underlying: 100, chains, stockShares: 100 } as unknown as StrategyContext;

    const serverSignatures = new Set<string>();
    for (const def of defaultRegistry.list()) {
      for (const set of def.generate(context, 500).sets) {
        serverSignatures.add(signature(set.map((l) => ({ optionType: l.optionType, side: l.side, quantity: l.quantity, strike: l.strike, dte: l.daysToExpiration }))));
      }
    }
    const missing: string[] = [];
    for (const entry of STRATEGY_LIBRARY) {
      const legs = entry.buildLegs(100, 30, "2026-11-13", 0.3).map((l) => ({ optionType: l.optionType, side: l.side, quantity: l.quantity, strike: l.strike, dte: l.dte }));
      if (!serverSignatures.has(signature(legs))) missing.push(`${entry.name} (${entry.id})`);
    }
    expect(missing).toEqual([]);
  });
});
