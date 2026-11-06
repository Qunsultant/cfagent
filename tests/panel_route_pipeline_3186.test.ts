/**
 * Issue #3186 step 3e - the manual panel route
 * (POST /trading/options/strategies + /best-trade) runs through the
 * one panel pipeline instead of calling RecommendationService
 * .discoverPanel directly. Pin: a live route invocation with
 * fixture chains returns the same response shape the UI reads
 * (ranked / riskReports / bestTrade / snapshot / artifact links).
 *
 * Chains come from DynamicOptionsScreener's static test fixture
 * (the same seam the unified pin uses); the auth guard is mocked
 * to proceed (its own wiring is pinned in
 * tests/options_auth_freshness_route_2599.test.ts); storage is the
 * Map-backed memory store + MockSqlStorage, so the durable claims
 * and the canonical strategy-run record both run for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/optionsAuthFreshness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/optionsAuthFreshness")>();
  return { ...actual, panelAuthResponse: vi.fn(async () => null) };
});

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

// Same economics as the unified pin (tests/unified_options_pipeline_3186.test.ts):
// intrinsic + time value per strike, so the engine's candidate
// scoring sees realistic reward/risk.
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

const panelBody = {
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

describe("manual panel route through the pipeline (#3186 step 3e)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
    vi.restoreAllMocks();
  });

  async function runPanel(path: string) {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL", 150) });
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as never);
    const storage = memoryStorage();
    const fakeAgent = {
      generateAndStoreStrategyReport: async () => ({}),
    };
    const ctx = {
      env: {},
      requestedEnv: undefined,
      getOrm: () => orm,
      agentCtx: { storage: { ...storage, sql } },
      ensureTables: () => sql,
      getScreenerAgent: () => fakeAgent,
    } as unknown as EtradeOptionsRouteContext;
    const request = new Request(`https://agent.internal${path}`, {
      method: "POST",
      headers: { "x-user-login": "tester", "content-type": "application/json" },
      body: JSON.stringify(panelBody),
    });
    const response = await handleEtradeOptionsRoutes(
      request,
      new URL(`https://agent.internal${path}`),
      path,
      "sess-panel-3186",
      ctx,
    );
    return { response, storage };
  }

  it("strategies returns the panel result (ranked + riskReports + snapshot)", async () => {
    const { response, storage } = await runPanel("/api/trading/options/strategies");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    // The route ran the pipeline: all 8 stage artifacts are in storage.
    expect(
      storage.keys().filter((k) => k.startsWith("options:options-panel:route:")).length,
    ).toBe(8);
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body.status).toBe("ranked_candidates");
    expect(Array.isArray(body.ranked)).toBe(true);
    expect((body.ranked as unknown[]).length).toBeGreaterThan(0);
    expect(
      ((body.ranked as { candidate: { type: string; symbol: string } }[])[0]).candidate,
    ).toMatchObject({ type: "long_call", symbol: "AAPL" });
    expect(Array.isArray(body.riskReports)).toBe(true);
    expect((body.riskReports as unknown[]).length).toBe(
      (body.ranked as unknown[]).length,
    );
    // The route spreads the snapshot as top-level screen/contracts
    // (there is no `snapshot` key on the body) - see `common`.
    expect(body.screen).toBeDefined();
    expect(Array.isArray(body.contracts)).toBe(true);
    expect((body.contracts as { symbol: string }[]).length).toBeGreaterThan(0);
    expect(
      (body.contracts as { symbol: string }[]).every((c) => c.symbol.startsWith("AAPL")),
    ).toBe(true);
  });

  it("best-trade returns the pick from the same panel result", async () => {
    const { response } = await runPanel("/api/trading/options/best-trade");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body.bestTrade).toBeDefined();
    expect((body.bestTrade as { status?: string }).status).toBe("recommended");
    expect(body.screen).toBeDefined();
    expect(Array.isArray(body.contracts)).toBe(true);
  });
});
