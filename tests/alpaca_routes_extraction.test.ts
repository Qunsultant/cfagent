/**
 * Issue #359-13: characterization for the alpaca route extraction.
 *
 * Pins (a) the route inventory and relative order of the two extracted
 * handlers in src/agents/routes/alpaca.ts — the matching order in
 * routeRequest is load-bearing, so each module handler must match the
 * (path, method) pairs in the same sequence as the original inline blocks;
 * (b) the two delegation call sites in orchestrator.ts, at the exact
 * original positions (trading group after the watchlists delegation; market-data
 * group between /market-data/research and /market-data/compare); (c) behavior with a
 * mocked MarketDataResearchService: owned paths return a Response (200 / 400 /
 * 500 exactly as before), non-owned paths return null (the orchestrator
 * keeps routing) — each handler ends with an explicit `return null`, never
 * undefined (slice #359-08 caught a missing-return-null bug on exactly
 * this); (d) audit events stay funneled through ctx.audit with the same
 * event names; (e) MarketDataResearchService is constructed with ctx.env
 * byte-identically (no credential/env semantics change).
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The trading delegation's lower bound anchors to the slice-12
 * watchlists delegation call (the reciprocal note slice #359-12 left in
 * tests/watchlists_routes_extraction.test.ts). The market-data delegation anchors
 * to the trading delegation call (both own-domain). The upper bound is
 * NOT asserted: the /market-data/compare block is slice #359-14's (market-data research)
 * domain and still inline; slice #377 must anchor its market-data delegation's
 * lower bound to the handleAlpacaMarketDataRoutes(...) delegation call when it
 * extracts that block (reciprocal of this note).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
  const seen: any[] = [];
  class MockMarketDataResearchService {
    constructor(...args: any[]) {
      seen.push({ ctor: args, svc: this });
      Object.assign(this, fns);
    }
  }
  return { MarketDataResearchService: MockMarketDataResearchService, __mockMarketData: { fns, seen } };
});

import {
  handleAlpacaTradingRoutes,
  handleAlpacaMarketDataRoutes,
  type AlpacaRouteContext,
} from "../src/agents/routes/alpaca";
import * as marketDataMod from "../src/services/marketDataResearch";

const mocks = (marketDataMod as any).__mockMarketData as {
  fns: Record<string, ReturnType<typeof vi.fn>>;
  seen: Array<{ ctor: any[]; svc: any }>;
};

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

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
  mocks.seen.length = 0;
});

const TRADING_MARKERS = [
  'path.endsWith("/trading/alpaca/order") && request.method === "POST"',
  'path.endsWith("/trading/alpaca/account") && request.method === "GET"',
  'path.endsWith("/trading/alpaca/positions") && request.method === "GET"',
  'path.endsWith("/trading/alpaca/orders") && request.method === "GET"',
];

// #1906: each branch matches the canonical /market-data/* path first,
// with the deprecated /foss/* path as alias on the same branch.
const ALPACA_MARKERS = [
  '(path.endsWith(\"/market-data/snapshot\") || path.endsWith(\"/foss/snapshot\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/alpaca/account\") || path.endsWith(\"/foss/alpaca/account\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/alpaca/positions\") || path.endsWith(\"/foss/alpaca/positions\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/alpaca/orders\") || path.endsWith(\"/foss/alpaca/orders\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/alpaca/order\") || path.endsWith(\"/foss/alpaca/order\")) && request.method === \"POST\"',
];

function assertOrdered(moduleSrc: string, markers: string[]) {
  let last = -1;
  for (const marker of markers) {
    const idx = moduleSrc.indexOf(marker, last + 1);
    expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
    expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
    last = idx;
  }
}

describe("alpaca route inventory (extraction #376)", () => {
  it("the trading route conditions appear in the module in the original relative order", () => {
    const tradingSrc = src("agents/routes/alpaca.ts").split("handleAlpacaMarketDataRoutes")[0];
    assertOrdered(tradingSrc, TRADING_MARKERS);
  });

  it("the alpaca route conditions appear in the module in the original relative order", () => {
    const alpacaSrc = src("agents/routes/alpaca.ts").split("handleAlpacaMarketDataRoutes")[1];
    assertOrdered(alpacaSrc, ALPACA_MARKERS);
    // The non-alpaca market-data routes are NOT moved (slice #359-14's domain).
    for (const cond of [
      'path.endsWith("/market-data/quote")',
      'path.endsWith("/market-data/fundamentals")',
      'path.endsWith("/market-data/bars")',
      'path.endsWith("/market-data/research")',
      'path.endsWith("/market-data/compare")',
    ]) {
      expect(alpacaSrc, `sibling market-data route must stay inline: ${cond}`).not.toContain(cond);
    }
  });

  it("the original inline blocks are gone from orchestrator.ts; two delegations stand at the original positions", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const moduleSrc = src("agents/routes/alpaca.ts");
    expect(moduleSrc).toContain("export async function handleAlpacaTradingRoutes");
    expect(moduleSrc).toContain("export async function handleAlpacaMarketDataRoutes");
    expect(moduleSrc).toContain("export interface AlpacaRouteContext");
    for (const cond of [...TRADING_MARKERS, ...ALPACA_MARKERS].map((m) =>
      m.split(" && ")[0]
    )) {
      expect(orchSrc, `inline condition should be gone: ${cond}`).not.toContain(cond);
    }
    // Exactly one call site each.
    for (const needle of [
      "handleAlpacaTradingRoutes(request, url, path, sessionId,",
      "handleAlpacaMarketDataRoutes(request, url, path, sessionId,",
    ]) {
      expect(orchSrc.split(needle).length - 1, `expected exactly one call site: ${needle}`).toBe(1);
    }
    // Slice #359-14 (market-data research) legitimately moved this import: no
    // inline market-data blocks remain in orchestrator.ts, so MarketDataResearchService
    // and marketDataResearchBarsSourceLabel are owned by src/agents/routes/marketDataResearch.ts
    // now (swap per the #405 landmark rule - the "stays inline" premise was
    // stale after extraction).
    expect(moduleSrc).toContain('import { MarketDataResearchService } from "../../services/marketDataResearch"');
    expect(orchSrc).not.toContain('import { MarketDataResearchService, marketDataResearchBarsSourceLabel } from "../services/marketDataResearch"');
    expect(src("agents/routes/marketDataResearch.ts")).toContain('import { MarketDataResearchService, marketDataResearchBarsSourceLabel } from "../../services/marketDataResearch"');
  });

  it("the trading delegation sits after the watchlists delegation; the market-data delegation follows it", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const tradingIdx = orchSrc.indexOf("handleAlpacaTradingRoutes(request, url, path, sessionId,");
    const alpacaIdx = orchSrc.indexOf("handleAlpacaMarketDataRoutes(request, url, path, sessionId,");
    // Lower bound: the slice-12 watchlists delegation call (delegation-call
    // anchor per the #405 rule).
    const watchlistsIdx = orchSrc.indexOf("handleWatchlistsRoutes(request, url, path, sessionId,");
    expect(watchlistsIdx).toBeGreaterThan(-1);
    expect(tradingIdx, "trading delegation must follow the watchlists delegation").toBeGreaterThan(
      watchlistsIdx
    );
    expect(alpacaIdx, "alpaca delegation must follow the trading delegation").toBeGreaterThan(
      tradingIdx
    );
    // NOTE for slice #359-14 (market-data research): anchor its delegation's lower
    // bound to the handleAlpacaMarketDataRoutes(...) delegation call above.
  });
});

describe("handleAlpacaTradingRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    expect(
      await handleAlpacaTradingRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", baseCtx())
    ).toBeNull();
    // Wrong method for an owned path is not owned.
    expect(
      await handleAlpacaTradingRoutes(
        req("GET", "/api/trading/alpaca/order"),
        urlOf("/api/trading/alpaca/order"),
        "/api/trading/alpaca/order",
        "s",
        baseCtx()
      )
    ).toBeNull();
    // Sibling-domain paths are not owned (market-data alpaca belongs to the other handler).
    expect(
      await handleAlpacaTradingRoutes(
        req("GET", "/api/market-data/alpaca/account"),
        urlOf("/api/market-data/alpaca/account"),
        "/api/market-data/alpaca/account",
        "s",
        baseCtx()
      )
    ).toBeNull();
  });

  it("returns an explicit null, never undefined, for non-owned paths", async () => {
    for (const h of [handleAlpacaTradingRoutes, handleAlpacaMarketDataRoutes]) {
      const res = await h(req("GET", "/api/nothing-here"), urlOf("/api/nothing-here"), "/api/nothing-here", "s", baseCtx());
      expect(res).not.toBeUndefined();
      expect(res).toBeNull();
    }
  });

  it("places an order and audits with the original event name", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaTradingRoutes(
      req("POST", "/api/trading/alpaca/order", { symbol: "NVDA", qty: 2, side: "buy" }),
      urlOf("/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ success: true, status: "accepted" });
    expect(mocks.fns.placeAlpacaOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "NVDA", qty: 2, side: "buy" })
    );
    expect(ctx.audit).toHaveBeenCalledWith(
      "alpaca.order_placed",
      "trading",
      expect.objectContaining({ symbol: "NVDA", qty: 2, side: "buy" })
    );
    // Credential/env handling: the service is constructed with ctx.env untouched.
    expect(mocks.seen[0].ctor[0]).toBe(ctx.env);
  });

  it("rejects an order without a symbol with 400 (no audit, no service call)", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaTradingRoutes(
      req("POST", "/api/trading/alpaca/order", { qty: 1 }),
      urlOf("/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctx
    );
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Stock symbol is required" });
    expect(mocks.fns.placeAlpacaOrder).not.toHaveBeenCalled();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("serves account, positions, and orders list", async () => {
    const ctx = baseCtx();
    for (const p of ["/api/trading/alpaca/account", "/api/trading/alpaca/positions"]) {
      const res = await handleAlpacaTradingRoutes(req("GET", p), urlOf(p), p, "s", ctx);
      expect(res!.status).toBe(200);
      expect((await res!.json()).success).toBe(true);
    }
    const res = await handleAlpacaTradingRoutes(
      req("GET", "/api/trading/alpaca/orders?status=closed"),
      urlOf("/api/trading/alpaca/orders?status=closed"),
      "/api/trading/alpaca/orders",
      "s",
      ctx
    );
    expect(res!.status).toBe(200);
    expect(mocks.fns.getAlpacaOrders).toHaveBeenCalledWith("closed");
  });

  it("returns 500 when the service throws", async () => {
    mocks.fns.getAlpacaAccount.mockRejectedValueOnce(new Error("boom"));
    const res = await handleAlpacaTradingRoutes(
      req("GET", "/api/trading/alpaca/account"),
      urlOf("/api/trading/alpaca/account"),
      "/api/trading/alpaca/account",
      "s",
      baseCtx()
    );
    expect(res!.status).toBe(500);
    // Issue #3197: the raw thrown message is no longer surfaced —
    // the body carries the outcome code + business message instead.
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FAILURE_ALPACA_UPSTREAM");
    expect(body.error).toMatch(/\[FAILURE_ALPACA_UPSTREAM\]/);
    expect(body.error).not.toMatch(/boom/);
  });
});

describe("handleAlpacaMarketDataRoutes behavior", () => {
  it("returns null for paths it does not own (orchestrator keeps routing)", async () => {
    expect(
      await handleAlpacaMarketDataRoutes(req("GET", "/api/audit"), urlOf("/api/audit"), "/api/audit", "s", baseCtx())
    ).toBeNull();
    // Sibling-domain paths are not owned (slice #359-14's domain stays inline).
    for (const p of ["/api/market-data/quote", "/api/market-data/bars", "/api/market-data/research", "/api/market-data/compare"]) {
      expect(
        await handleAlpacaMarketDataRoutes(req("GET", p), urlOf(p), p, "s", baseCtx()),
        p
      ).toBeNull();
    }
    // Trading-alpaca paths belong to the other handler.
    expect(
      await handleAlpacaMarketDataRoutes(
        req("POST", "/api/trading/alpaca/order"),
        urlOf("/api/trading/alpaca/order"),
        "/api/trading/alpaca/order",
        "s",
        baseCtx()
      )
    ).toBeNull();
  });

  it("serves the snapshot and audits with the original event name", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaMarketDataRoutes(
      req("GET", "/api/market-data/snapshot?symbol=NVDA"),
      urlOf("/api/market-data/snapshot?symbol=NVDA"),
      "/api/market-data/snapshot",
      "s",
      ctx
    );
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ symbol: "NVDA" });
    expect(ctx.audit).toHaveBeenCalledWith(
      "alpaca.snapshot_queried",
      "trading",
      expect.objectContaining({ symbol: "NVDA", price: 140.5 })
    );
  });

  it("serves market-data alpaca account/positions/orders and audits each", async () => {
    const ctx = baseCtx();
    for (const [p, event] of [
      ["/api/market-data/alpaca/account", "alpaca.account_queried"],
      ["/api/market-data/alpaca/positions", "alpaca.positions_queried"],
      ["/api/market-data/alpaca/orders", "alpaca.orders_queried"],
    ] as const) {
      const res = await handleAlpacaMarketDataRoutes(req("GET", p), urlOf(p), p, "s", ctx);
      expect(res!.status, p).toBe(200);
      expect((await res!.json()).success, p).toBe(true);
      expect(ctx.audit, event).toHaveBeenCalledWith(event, "trading", expect.anything());
    }
  });

  it("places a market-data alpaca order with the original body aliases and audits", async () => {
    const ctx = baseCtx();
    const res = await handleAlpacaMarketDataRoutes(
      req("POST", "/api/market-data/alpaca/order", { symbol: "aapl", quantity: 5, orderAction: "sell" }),
      urlOf("/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "s",
      ctx
    );
    expect(res!.status).toBe(200);
    expect(mocks.fns.placeAlpacaOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "AAPL", qty: 5, side: "sell" })
    );
    expect(ctx.audit).toHaveBeenCalledWith(
      "alpaca.order_placed",
      "trading",
      expect.objectContaining({ symbol: "AAPL", qty: 5, side: "sell" })
    );
  });

  it("rejects a market-data order without a symbol with 400", async () => {
    const res = await handleAlpacaMarketDataRoutes(
      req("POST", "/api/market-data/alpaca/order", {}),
      urlOf("/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "s",
      baseCtx()
    );
    expect(res!.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Symbol is required" });
  });
});
