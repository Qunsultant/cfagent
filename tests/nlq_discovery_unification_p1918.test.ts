import { describe, expect, it } from "vitest";

import {
  parseOptionsStrategyIntent,
  runOptionsStrategyAction,
} from "../src/agents/nlqOptionsStrategy";
import { nlqPlanSchema } from "../src/agents/nlq/schema";
import type { DiscoveryRunOutcome } from "../src/services/discoveryService";
import type { StoredDiscoverySetupRun } from "../src/trading";

/**
 * Issue #1918 — one NLQ discovery action on the kernel path.
 *
 * The surviving action is `options_fit_discovery` (kernel research
 * entries via src/services/fitDiscoveryRunner.ts). The discovery
 * phrase family ("discover setups", "find setups") routes to the
 * SAME action, served by its scope leg (the discovery runner,
 * kernel discoverPanel via runPanelPipelineRetired4068) — one action name,
 * one dispatch branch, both families still producing results.
 * No phrase family goes dead, no silent fallback is introduced:
 * a leg without its runner fails explicitly.
 */

const FAKE_OUTCOME: DiscoveryRunOutcome = {
  run: {
    id: "run-nlq-1918",
    createdAt: "2026-10-22T12:00:00.000Z",
    scopeKey: "nlq:venus:watchlist:all",
    source: "nlq",
    configHash: "abc12345",
    modelVersion: "discovery-v1",
    counts: { considered: 2, setups: 1, abstentions: 1, prescreenedOut: 0, errors: 0 },
    items: [
      {
        kind: "setup",
        symbol: "AAA",
        thesis: "bullish",
        ruleId: "trend-up",
        confidence: "MEDIUM",
        discoveryScore: 72,
        gateBucket: "fit",
        targetPrice: 105.16,
        targetDate: "2026-11-20",
        firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
        evidence: "trend fixture evidence",
      },
      { kind: "abstention", symbol: "BBB", stage: "inference", reason: "no setup for BBB — no signals fired", nearMissSignals: [] },
    ],
    userLogin: "venus",
  } as StoredDiscoverySetupRun,
  deltas: [],
  errors: [],
};

function fakeEtrade(watchlists: Array<{ name: string; symbols: string[] }> = []) {
  return {
    client: undefined as never,
    fetchQuoteRemote: async () => ({ lastPrice: 100 }),
    getWatchlists: async () => watchlists,
    screenMarketsAsync: async () => ({ stocks: [] as Array<{ symbol: string; marketCap?: number }> }),
  };
}

describe("intent schema exposes exactly one discovery action (#1918)", () => {
  it("rejects the removed options_discovery action", () => {
    expect(nlqPlanSchema.safeParse({ tradingData: { action: "options_discovery" } }).success).toBe(false);
  });

  it("accepts the surviving options_fit_discovery action", () => {
    expect(nlqPlanSchema.safeParse({ tradingData: { action: "options_fit_discovery" } }).success).toBe(true);
  });
});

describe("both phrase families resolve to the surviving action (#1918)", () => {
  it("discovery phrasing routes to options_fit_discovery with the watchlist default scope", () => {
    const intent = parseOptionsStrategyIntent("discover setups across my watchlist");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.scope?.kind).toBe("watchlist");
  });

  it("named-watchlist discovery phrasing keeps its scope on the surviving action", () => {
    const intent = parseOptionsStrategyIntent("find setups in my Semis watchlist");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.scope).toMatchObject({ kind: "watchlist" });
  });

  it("fit phrasing (name direction) routes to options_fit_discovery", () => {
    const intent = parseOptionsStrategyIntent("What strategies fit NVDA?");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.fitDiscovery).toMatchObject({ direction: "name_to_strategies", symbol: "NVDA" });
  });

  it("fit phrasing (strategy direction) routes to options_fit_discovery", () => {
    const intent = parseOptionsStrategyIntent("find me income names for an iron condor");
    expect(intent?.action).toBe("options_fit_discovery");
    expect(intent?.filters.fitDiscovery).toMatchObject({ direction: "strategy_to_names", structure: "iron_condor" });
  });

  it("controls keep their routes (no hijack)", () => {
    expect(parseOptionsStrategyIntent("scan my watchlist for bullish option trades")?.action).toBe("options_opportunities");
    expect(parseOptionsStrategyIntent("What strategies fit my watchlist?")?.action).not.toBe("options_fit_discovery");
    expect(parseOptionsStrategyIntent("Which names in my Semis watchlist fit an iron condor?")?.action).toBe("options_opportunities");
  });
});

describe("unified dispatch: one action, two explicit legs (#1918)", () => {
  it("scope-only filters run the discovery leg and return the run id", async () => {
    const runner = { run: async () => FAKE_OUTCOME };
    const res = await runOptionsStrategyAction(
      fakeEtrade(),
      "options_fit_discovery",
      {
        request: {},
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: { kind: "symbols", symbols: ["AAA", "BBB"] },
      } as never,
      { discoveryRunner: runner as never, userLogin: "venus" },
    );
    expect(res.status).toBe("success");
    expect(res.count).toBe(1);
    expect(res.discoveryRunId).toBe("run-nlq-1918");
  });

  it("fit-spec filters without a fit runner fail explicitly, never a different answer", async () => {
    const intent = parseOptionsStrategyIntent("What strategies fit NVDA?");
    const res = await runOptionsStrategyAction(fakeEtrade(), "options_fit_discovery", intent!.filters, {});
    expect(res.status).toBe("invalid_request");
    expect(res.summary).toMatch(/fit discovery/i);
    expect(res.count).toBe(0);
  });

  it("scope-only filters without a discovery runner fail explicitly", async () => {
    const res = await runOptionsStrategyAction(
      fakeEtrade(),
      "options_fit_discovery",
      {
        request: {},
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: { kind: "symbols", symbols: ["AAA"] },
      } as never,
      { userLogin: "venus" },
    );
    expect(res.status).toBe("invalid_request");
    expect(res.summary).toContain("isn't wired");
  });
});
