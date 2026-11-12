/**
 * Issue #3186 step 3e - the compare route
 * (POST /trading/options/compare) runs through the one panel
 * pipeline instead of calling runPanelPipelineRetired4068 directly. Pin: a
 * live route invocation with fixture chains returns the same
 * response shape the UI reads (same_candidate_ranking mode, quant
 * ranked + scoreWeights + candidateCount, quantStrategyPool,
 * screen/contracts).
 *
 * Chains come from DynamicOptionsScreener's static test fixture
 * (the same seam the panel-route pin uses); storage is the
 * Map-backed memory store + MockSqlStorage, so the durable claims
 * run for real. The LLM arm has no AI binding in the test env, so
 * it deterministically reports llm.status "error" (the route's own
 * catch) - the pin asserts the quant arm, which is what the swap
 * must preserve.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  handleEtradeOptionsRoutes,
  type EtradeOptionsRouteContext,
} from "../src/agents/routes/etradeOptions";
import { DynamicOptionsScreener } from "../src/trading";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { ETradeOptionChain } from "../src/trading/etrade/client";
import type { OptionsStageStorage } from "../src/workflows/optionsScreenPorts";

const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

// Same economics as the panel-route pin
// (tests/panel_route_pipeline_3186.test.ts): intrinsic + time value
// per strike, so the engine's candidate scoring sees realistic
// reward/risk.
function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

function makeChain(symbol: string, spot: number) {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: mid - 0.1,
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? delta : -delta,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiryObj,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

const targetDate = expiryDateObj.toISOString().slice(0, 10);

const compareBody = {
  symbol: "AAPL",
  thesis: "bullish",
  targetPrice: 160,
  targetDate,
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 5000,
  minRewardRisk: 0.1,
  allowedStrategies: ["long_call"],
  riskProfile: "balanced",
  alternatives: 3,
};

describe("compare route through the pipeline (#3186 step 3e)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
    vi.restoreAllMocks();
  });

  it("compare returns the same_candidate_ranking response over the pipeline result", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL", 150) });
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const storage = memoryStorage();
    const ctx = {
      env: {},
      requestedEnv: undefined,
      getOrm: () => orm,
      agentCtx: { storage: { ...storage, sql } },
      ensureTables: () => sql,
      getScreenerAgent: () => ({}),
    } as unknown as EtradeOptionsRouteContext;
    const path = "/api/trading/options/compare";
    const request = new Request(`https://agent.internal${path}`, {
      method: "POST",
      headers: { "x-user-login": "tester", "content-type": "application/json" },
      body: JSON.stringify(compareBody),
    });
    const response = await handleEtradeOptionsRoutes(
      request,
      new URL(`https://agent.internal${path}`),
      path,
      "sess-compare-3186",
      ctx,
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body.mode).toBe("same_candidate_ranking");
    const quant = body.quant as {
      ranked: { candidate: { type: string; symbol: string } }[];
      scoreWeights: unknown;
      candidateCount: number;
    };
    expect(quant.candidateCount).toBeGreaterThan(0);
    expect(quant.ranked[0].candidate).toMatchObject({ type: "long_call", symbol: "AAPL" });
    expect(quant.scoreWeights).toBeDefined();
    expect(Array.isArray(body.quantStrategyPool)).toBe(true);
    expect((body.quantStrategyPool as unknown[]).length).toBeGreaterThan(0);
    expect(body.screen).toBeDefined();
    expect(Array.isArray(body.contracts)).toBe(true);
    // The route ran the pipeline: all 8 stage artifacts are in storage.
    expect(
      storage.keys().filter((k) => k.startsWith("options:options-panel:route:")).length,
    ).toBe(8);
  });
});
