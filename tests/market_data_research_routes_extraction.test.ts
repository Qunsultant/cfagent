/**
 * Issue #359-14: characterization for the market-data research route extraction.
 *
 * Pins (a) the route inventory and relative order of the two extracted
 * handlers in src/agents/routes/marketDataResearch.ts — the matching order in
 * routeRequest is load-bearing, so each module handler must match the
 * (path, method) pairs in the same sequence as the original inline blocks;
 * (b) the two delegation call sites in orchestrator.ts, at the exact
 * original positions (quote-research group before the slice #359-13
 * handleAlpacaMarketDataRoutes delegation; compare/screen group after it); (c)
 * behavior with a mocked MarketDataResearchService and a mocked ScreenerAgent
 * pipeline seam (issue #1007 adaptation, disclosed: the screen route
 * previously constructed the retired YFinanceMarketScreener engine; it
 * now runs ScreenerAgent.runScreen with provider "yahoo" and stores a
 * canonical report via ctx.persistScreenerReportCanonical — the mocks
 * and the two screen tests below were re-pointed to that seam with
 * assertion strength unchanged): owned paths return a Response (200 / 500 exactly
 * as before), non-owned paths return null (the orchestrator keeps routing)
 * — each handler ends with an explicit `return null`, never undefined
 * (slice #359-08 caught a missing-return-null bug on exactly this); (d)
 * audit events stay funneled through ctx.audit with the same event names;
 * (e) MarketDataResearchService is constructed with ctx.env byte-identically (no
 * credential/env semantics change); (f) the alpaca-named market-data routes
 * (/market-data/snapshot, /market-data/alpaca/*) stay OUT of this module — they belong to
 * slice #359-13's handleAlpacaMarketDataRoutes, which is not moved.
 *
 * LANDMARK RULE (#405): position assertions anchor to DELEGATION CALLS or
 * own-domain markers, never to a neighboring domain's inline comments or
 * blocks. The quote-research delegation's lower bound anchors to the
 * alpaca-trading delegation call (own slice-13 domain); the market-data screening
 * delegation's lower bound anchors to the handleAlpacaMarketDataRoutes(...)
 * delegation call (the reciprocal note slice #359-13 left in
 * tests/alpaca_routes_extraction.test.ts). The upper bound (the Task
 * Scheduling banner + screener routes, slice #359-15/#359-16's domain) is
 * NOT asserted here: slice #378 must anchor its delegation's lower bound to
 * the handleMarketDataCompareScreenRoutes(...) delegation call when it extracts
 * that block (reciprocal of this note).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/services/marketDataResearch", () => {
  const fns = {
    getQuote: vi.fn(async (symbol: string) => ({ symbol, price: 195.5, provider: "hybrid" })),
    getFundamentals: vi.fn(async (symbol: string) => ({ symbol, companyName: "Test Corp" })),
    getHistoricalBars: vi.fn(async (_symbol: string, _tf: string, _limit: number) => [
      { t: 1, c: 100, provenance: "live" },
    ]),
    generateResearchReport: vi.fn(async (symbol: string) => ({
      symbol,
      analystRating: "buy",
      agentAttestation: { did: "did:test:123" },
      provenance: "hybrid",
    })),
    compareStocks: vi.fn(async (symbols: string[]) => symbols.map((s) => ({ symbol: s }))),
    getProviderStatuses: vi.fn(() => [{ provider: "yfinance", ok: true }]),
  };
  const seen: any[] = [];
  class MockMarketDataResearchService {
    constructor(...args: any[]) {
      seen.push({ ctor: args, svc: this });
      Object.assign(this, fns);
    }
  }
  const marketDataResearchBarsSourceLabel = (provider: string, provenance: string) =>
    provenance === "live" ? `MOCK-LIVE ${provider}` : `MOCK-GENERATED ${provider}`;
  return {
    MarketDataResearchService: MockMarketDataResearchService,
    marketDataResearchBarsSourceLabel,
    __mockMarketData: { fns, seen },
  };
});

vi.mock("../src/trading", async () => {
  // Issue #959 harness note: the market-data screen route imports
  // parseStockScreenRequest from the trading barrel, so the barrel
  // fake must provide it. It re-exports the REAL parser (imported
  // from its definition module to avoid loading the whole barrel) —
  // the route's validation behaviour under test stays genuine.
  // Issue #1007: the route no longer imports any engine class from
  // the barrel — the pipeline seam is the ScreenerAgent, mocked via
  // the route context below (__mockScreener).
  const schemas = await vi.importActual<any>("../src/trading/screeningSchemas");
  return {
    parseStockScreenRequest: schemas.parseStockScreenRequest,
  };
});

// Issue #1007: the ScreenerAgent seam the market-data screen route now runs
// through (provider "yahoo"), plus the canonical-report seam.
const screenerMocks = vi.hoisted(() => {
  const fns = {
    runScreen: vi.fn(async (_req: any) => ({
      timestamp: "2026-10-22T00:00:00.000Z",
      trigger: "manual",
      provider: "yahoo",
      universe: "NASDAQ100",
      sector: "ALL",
      success: true,
      totalScanned: 1,
      matchedCount: 1,
      opportunities: [],
      allStocks: [{ symbol: "NVDA" }],
      discoveryMessage: "mocked",
      filterSummary: "mocked",
    })),
    runSharded: vi.fn(async (_req: any) => []),
  };
  const persist = vi.fn();
  return { fns, persist };
});

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen. The seam fake delegates to the stub agent's
// runScreen: it flattens the seam input back into the runScreen
// request (provider/sector ride the spec on the routes, the
// overrides on the scheduled path) and returns the stub's result
// as the engine run's one shard. The seam itself is pinned in
// tests/stock_entry_routing_4278.test.ts.
const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
  const flat = {
    trigger: input.spec.trigger,
    sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
    universe: input.spec.universe,
    maxSymbols: input.commandOverrides?.maxSymbols,
    filters: input.spec.filters,
    userLogin: input.userLogin,
    environment: input.environment,
    portfolioContext: input.portfolioContext,
    provider: input.commandOverrides?.provider ?? input.spec.provider,
    broker: input.commandOverrides?.broker,
    ...(input.commandOverrides?.mode
      ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
      : {}),
  };
  const result = await runScreen(flat);
  return {
    results: [result],
    collation: null,
    jobId: input.spec?.jobId ?? "test-job",
    workflowId: "wf-1",
  };
};

import {
  handleMarketDataQuoteResearchRoutes,
  handleMarketDataCompareScreenRoutes,
  type MarketDataResearchRouteContext,
} from "../src/agents/routes/marketDataResearch";
import * as marketDataMod from "../src/services/marketDataResearch";

const marketDataMocks = (marketDataMod as any).__mockMarketData as {
  fns: Record<string, ReturnType<typeof vi.fn>>;
  seen: Array<{ ctor: any[]; svc: any }>;
};

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

const baseCtx = (overrides: Partial<MarketDataResearchRouteContext> = {}): MarketDataResearchRouteContext =>
  ({
    env: { MARKER: "env" } as any,
    audit: vi.fn(),
    getScreenerAgent: () => ({ runScreen: screenerMocks.fns.runScreen, runSharded: screenerMocks.fns.runSharded }),
    runStockScreenViaEngine: delegateSeamFake(screenerMocks.fns.runScreen),
    persistScreenerReportCanonical: screenerMocks.persist,
    ...overrides,
  }) as unknown as MarketDataResearchRouteContext;

// Issue #1185: requests model the production session gate (x-user-login
// set by src/server.ts from the verified session; handlers fail closed
// without it).
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://agent.internal${path}`, {
    method,
    headers: { "x-user-login": "alice", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  marketDataMocks.seen.length = 0;
});

// #1906: each branch matches the canonical /market-data/* path first,
// with the deprecated /foss/* path as alias on the same branch (the
// bars branch already had this shape since #1888).
const QUOTE_MARKERS = [
  '(path.endsWith(\"/market-data/quote\") || path.endsWith(\"/foss/quote\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/fundamentals\") || path.endsWith(\"/foss/fundamentals\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/bars\") || path.endsWith(\"/foss/bars\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/research\") || path.endsWith(\"/foss/research\")) && request.method === \"GET\"',
];
const SCREEN_MARKERS = [
  '(path.endsWith(\"/market-data/compare\") || path.endsWith(\"/foss/compare\")) && (request.method === \"POST\" || request.method === \"GET\")',
  '(path.endsWith(\"/market-data/providers\") || path.endsWith(\"/foss/providers\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/screen\") || path.endsWith(\"/foss/screen\") || path.endsWith(\"/yfinance/screen\")) && (request.method === \"POST\" || request.method === \"GET\")',
];

function assertOrdered(srcText: string, markers: string[]) {
  let last = -1;
  for (const marker of markers) {
    const idx = srcText.indexOf(marker, last + 1);
    expect(idx, `expected route marker in module: ${marker}`).toBeGreaterThan(-1);
    expect(idx, `route marker out of order: ${marker}`).toBeGreaterThan(last);
    last = idx;
  }
}

describe("market-data research route inventory (extraction #377)", () => {
  it("the quote/research route conditions appear in the module in the original relative order", () => {
    assertOrdered(src("agents/routes/marketDataResearch.ts").split("handleMarketDataCompareScreenRoutes")[0], QUOTE_MARKERS);
  });

  it("the compare/screen route conditions appear in the module in the original relative order", () => {
    assertOrdered(src("agents/routes/marketDataResearch.ts").split("handleMarketDataCompareScreenRoutes")[1], SCREEN_MARKERS);
  });

  it("the alpaca-named market-data routes are NOT owned by this module", () => {
    const moduleSrc = src("agents/routes/marketDataResearch.ts");
    for (const p of ["/market-data/snapshot", "/market-data/alpaca/account", "/market-data/alpaca/order"]) {
      expect(moduleSrc).not.toContain(`"${p}"`);
    }
  });

  it("the original inline blocks are gone from orchestrator.ts", () => {
    const orchSrc = src("agents/orchestrator.ts");
    for (const cond of [
  '(path.endsWith(\"/market-data/quote\") || path.endsWith(\"/foss/quote\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/fundamentals\") || path.endsWith(\"/foss/fundamentals\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/bars\") || path.endsWith(\"/foss/bars\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/research\") || path.endsWith(\"/foss/research\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/compare\") || path.endsWith(\"/foss/compare\")) && (request.method === \"POST\" || request.method === \"GET\")',
  '(path.endsWith(\"/market-data/providers\") || path.endsWith(\"/foss/providers\")) && request.method === \"GET\"',
  '(path.endsWith(\"/market-data/screen\") || path.endsWith(\"/foss/screen\") || path.endsWith(\"/yfinance/screen\")) && (request.method === \"POST\" || request.method === \"GET\")',
    ]) {
      expect(orchSrc, `leftover inline condition: ${cond}`).not.toContain(cond);
    }
  });

  it("both delegations stand at the exact original positions around the alpaca-market-data delegation", () => {
    const orchSrc = src("agents/orchestrator.ts");
    const dispatchSrc = src("agents/orchestrator/routeRequest.ts");
    const quoteIdx = dispatchSrc.indexOf("handleMarketDataQuoteResearchRoutes(request, url, path, sessionId,");
    const alpacaIdx = dispatchSrc.indexOf("handleAlpacaMarketDataRoutes(request, url, path, sessionId,");
    const screenIdx = dispatchSrc.indexOf("handleMarketDataCompareScreenRoutes(request, url, path, sessionId,");
    expect(quoteIdx, "quote-research delegation missing").toBeGreaterThan(-1);
    expect(alpacaIdx, "slice-13 alpaca-market-data delegation missing").toBeGreaterThan(-1);
    expect(screenIdx, "market-data-screening delegation missing").toBeGreaterThan(-1);
    expect(quoteIdx).toBeLessThan(alpacaIdx);
    expect(alpacaIdx).toBeLessThan(screenIdx);
  });
});

describe("market-data research handler behavior (extraction #377)", () => {
  it("GET /market-data/quote returns the service result (200)", async () => {
    const res = await handleMarketDataQuoteResearchRoutes(req("GET", "/api/market-data/quote?symbol=NVDA"), urlOf("/api/market-data/quote?symbol=NVDA"), "/api/market-data/quote", "s", baseCtx());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ symbol: "NVDA", price: 195.5 });
    expect(marketDataMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");
    // MarketDataResearchService constructed with ctx.env, byte-identically.
    expect(marketDataMocks.seen[0].ctor[0]).toMatchObject({ MARKER: "env" });
  });

  it("GET /market-data/bars stamps live provenance and the source label", async () => {
    const res = await handleMarketDataQuoteResearchRoutes(req("GET", "/api/market-data/bars?symbol=NVDA"), urlOf("/api/market-data/bars?symbol=NVDA"), "/api/market-data/bars", "s", baseCtx());
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(res!.status).toBe(200);
    expect(body.symbol).toBe("NVDA");
    expect(body.provenance).toBe("live");
    expect(body.source).toContain("MOCK-LIVE");
    expect(body.count).toBe(1);
  });

  it("GET /market-data/bars falls back to generated provenance when bars carry none", async () => {
    marketDataMocks.fns.getHistoricalBars.mockResolvedValueOnce([{ t: 1, c: 100 }]);
    const res = await handleMarketDataQuoteResearchRoutes(req("GET", "/api/market-data/bars?symbol=NVDA"), urlOf("/api/market-data/bars?symbol=NVDA"), "/api/market-data/bars", "s", baseCtx());
    const body = (await res!.json()) as any;
    expect(body.provenance).toBe("generated");
    expect(body.source).toContain("MOCK-GENERATED");
  });

  it("GET /market-data/research returns the report and audits the generation", async () => {
    const ctx = baseCtx();
    const res = await handleMarketDataQuoteResearchRoutes(req("GET", "/api/market-data/research?symbol=NVDA"), urlOf("/api/market-data/research?symbol=NVDA"), "/api/market-data/research", "s", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.analystRating).toBe("buy");
    expect(ctx.audit).toHaveBeenCalledWith(
      "market_data.research_generated",
      "research",
      expect.objectContaining({ symbol: "NVDA", rating: "buy", did: "did:test:123", provenance: "hybrid" })
    );
  });

  it("POST /market-data/compare honors the body symbols", async () => {
    const res = await handleMarketDataCompareScreenRoutes(
      req("POST", "/api/market-data/compare", { symbols: ["NVDA", "AMD"] }),
      urlOf("/api/market-data/compare"),
      "/api/market-data/compare",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.count).toBe(2);
    expect(marketDataMocks.fns.compareStocks).toHaveBeenCalledWith(["NVDA", "AMD"]);
  });

  it("GET /market-data/providers returns the provider statuses", async () => {
    const res = await handleMarketDataCompareScreenRoutes(req("GET", "/api/market-data/providers"), urlOf("/api/market-data/providers"), "/api/market-data/providers", "s", baseCtx());
    expect(res).not.toBeNull();
    expect(await res!.json()).toEqual({ providers: [{ provider: "yfinance", ok: true }] });
  });

  it("POST /market-data/screen runs the screener and audits, returning stocks as results", async () => {
    const ctx = baseCtx();
    const filters = { sector: "Technology", maxRsi: 65 };
    const res = await handleMarketDataCompareScreenRoutes(req("POST", "/api/market-data/screen", filters), urlOf("/api/market-data/screen"), "/api/market-data/screen", "s", ctx);
    expect(res).not.toBeNull();
    const body = (await res!.json()) as any;
    expect(body.stocks).toEqual([{ symbol: "NVDA" }]);
    expect(body.results).toEqual([{ symbol: "NVDA" }]);
    // Issue #1007: the run goes through the one pipeline — ScreenerAgent
    // with provider "yahoo" and the validated filters. Issue #4278: the
    // canonical copy is stored by the workflow's own store step, not by
    // the route — a SUCCESS run skips the route's persist finalizer.
    expect(screenerMocks.fns.runScreen).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "yahoo", trigger: "manual", filters })
    );
    expect(screenerMocks.persist).not.toHaveBeenCalled();
    expect(ctx.audit).toHaveBeenCalledWith(
      "market_data.screener.executed",
      "research",
      expect.objectContaining({ filterSummary: "mocked", count: 1 })
    );
  });

  it("GET /market-data/screen maps query params to filters", async () => {
    const res = await handleMarketDataCompareScreenRoutes(
      req("GET", "/api/market-data/screen?sector=Tech&maxRsi=70&gainersOnly=true"),
      urlOf("/api/market-data/screen?sector=Tech&maxRsi=70&gainersOnly=true"),
      "/api/market-data/screen",
      "s",
      baseCtx()
    );
    expect(res).not.toBeNull();
    expect(screenerMocks.fns.runScreen).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "yahoo",
        filters: expect.objectContaining({ sector: "Tech", maxRsi: 70, gainersOnly: true }),
      })
    );
  });

  it("non-owned paths return null, never undefined (both handlers)", async () => {
    const ctx = baseCtx();
    for (const p of ["/api/market-data/snapshot", "/api/market-data/alpaca/account", "/api/audit"]) {
      expect(
        await handleMarketDataQuoteResearchRoutes(req("GET", p), urlOf(p), p, "s", ctx),
        `quote-research handler on ${p}`
      ).toBeNull();
      expect(
        await handleMarketDataCompareScreenRoutes(req("GET", p), urlOf(p), p, "s", ctx),
        `compare-screen handler on ${p}`
      ).toBeNull();
    }
  });
});
