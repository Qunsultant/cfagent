/**
 * Issue #3197: Alpaca non-placement routes must surface AOP
 * outcome-encoded errors, never raw upstream messages. The connect
 * entry (menu "Connect Alpaca") reads the market-data account route,
 * so its failure body must carry an outcome code + business message.
 *
 * Boundary: the order-placement routes are #3158's domain and are
 * NOT touched here — the last test pins that the placement path
 * still delegates to placeAlpacaOrder unchanged.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/marketDataResearch", () => {
  const fns = {
    placeAlpacaOrder: vi.fn(async (args: any) => ({
      success: true,
      status: "accepted",
      orderId: "order-1",
      order: args,
    })),
    getAlpacaAccount: vi.fn(async () => ({
      success: true,
      account: { id: "acct-1", buying_power: "100000", portfolio_value: "250000" },
    })),
    getAlpacaPositions: vi.fn(async () => ({
      success: true,
      positions: [{ symbol: "NVDA", qty: "10" }],
    })),
    getAlpacaOrders: vi.fn(async (status: string) => ({
      success: true,
      status,
      orders: [{ id: "o1" }],
    })),
    getAlpacaSnapshot: vi.fn(async (symbol: string) => ({
      symbol,
      latestTrade: { price: 140.5 },
      latestQuote: { bidPrice: 140.4, askPrice: 140.6 },
      assetClass: "us_equity",
    })),
  };
  class MockMarketDataResearchService {
    constructor(..._args: any[]) {
      Object.assign(this, fns);
    }
  }
  return { MarketDataResearchService: MockMarketDataResearchService, __mockMarketData: { fns } };
});

import {
  handleAlpacaTradingRoutes,
  handleAlpacaMarketDataRoutes,
  type AlpacaRouteContext,
} from "../src/agents/routes/alpaca";
import * as marketDataMod from "../src/services/marketDataResearch";

const mocks = (marketDataMod as any).__mockMarketData as {
  fns: Record<string, ReturnType<typeof vi.fn>>;
};

const baseCtx = (overrides: Partial<AlpacaRouteContext> = {}): AlpacaRouteContext =>
  ({
    env: { MARKER: "env" } as any,
    audit: vi.fn(),
    ...overrides,
  }) as AlpacaRouteContext;

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Alpaca non-placement routes are outcome-encoded (#3197)", () => {
  it("trading account throw maps to FAILURE_ALPACA_UPSTREAM with no raw message", async () => {
    mocks.fns.getAlpacaAccount.mockRejectedValueOnce(
      new Error("<!doctype html><html><body>Alpaca 500</body></html>"),
    );
    const res = await handleAlpacaTradingRoutes(
      req("GET", "/api/trading/alpaca/account"),
      urlOf("/api/trading/alpaca/account"),
      "/api/trading/alpaca/account",
      "sess",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_ALPACA_UPSTREAM");
    expect(body.error).toMatch(/\[FAILURE_ALPACA_UPSTREAM\]/);
    expect(body.error).not.toMatch(/<!doctype|<html|Alpaca 500/);
  });

  it("market-data account throw maps to FAILURE_ALPACA_UPSTREAM with no raw message", async () => {
    mocks.fns.getAlpacaAccount.mockRejectedValueOnce(new Error("upstream exploded"));
    const res = await handleAlpacaMarketDataRoutes(
      req("GET", "/api/market-data/alpaca/account"),
      urlOf("/api/market-data/alpaca/account"),
      "/api/market-data/alpaca/account",
      "sess",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_ALPACA_UPSTREAM");
    expect(body.error).toMatch(/\[FAILURE_ALPACA_UPSTREAM\]/);
    expect(body.error).not.toMatch(/upstream exploded/);
  });

  it("market-data account !success result carries the outcome code, not the raw provider message", async () => {
    mocks.fns.getAlpacaAccount.mockResolvedValueOnce({
      success: false,
      message: "Alpaca Trading error: ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required.",
    });
    const res = await handleAlpacaMarketDataRoutes(
      req("GET", "/api/market-data/alpaca/account"),
      urlOf("/api/market-data/alpaca/account"),
      "/api/market-data/alpaca/account",
      "sess",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.success).toBe(false);
    expect(body.code).toBe("FAILURE_ALPACA_UPSTREAM");
    expect(body.error).toMatch(/\[FAILURE_ALPACA_UPSTREAM\]/);
    expect(body.message).not.toMatch(/ALPACA_API_KEY_ID/);
  });

  it("market-data positions throw maps to FAILURE_ALPACA_UPSTREAM", async () => {
    mocks.fns.getAlpacaPositions.mockRejectedValueOnce(new Error("boom"));
    const res = await handleAlpacaMarketDataRoutes(
      req("GET", "/api/market-data/alpaca/positions"),
      urlOf("/api/market-data/alpaca/positions"),
      "/api/market-data/alpaca/positions",
      "sess",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_ALPACA_UPSTREAM");
    expect(body.error).not.toMatch(/boom/);
  });

  it("order placement still delegates to placeAlpacaOrder unchanged (#3158 boundary)", async () => {
    const res = await handleAlpacaMarketDataRoutes(
      req("POST", "/api/market-data/alpaca/order", { symbol: "NVDA", qty: 1, side: "buy" }),
      urlOf("/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "sess",
      baseCtx(),
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("order-1");
    expect(mocks.fns.placeAlpacaOrder).toHaveBeenCalledTimes(1);
  });
});
