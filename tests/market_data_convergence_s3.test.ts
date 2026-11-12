/**
 * Issue #1007 (screening consolidation S3) — Market-data convergence pins.
 *
 * (a) Adapter: a fixture Yahoo payload feeds the ONE pipeline —
 *     acquireUniverse({mode:"yahoo"}) returns pipeline quotes, and
 *     screenUniverse produces the same scored row shape as an
 *     E*TRADE-provider run. Yahoo's RSI-14 is a DATA field the
 *     pipeline's own RSI filter consumes.
 * (b) market-data route: POST /api/market-data/screen executes through ScreenerAgent
 *     with provider "yahoo" and stores a canonical report in the REST
 *     idiom (persistScreenerReportCanonical → source "screener", body
 *     carrying provider + trigger provenance), so the run is visible
 *     via GET /api/reports. Yahoo failure → visible 502, still stored.
 * (c) Premium stock-signals: no `0.88` constant anywhere in
 *     premium.ts; the returned confidence derives from the pipeline
 *     result (indicators.screenScore / 100) of a pipeline run executed
 *     with provider "yahoo".
 * (d) Retired engine: no production source constructs or calls
 *     YFinanceMarketScreener / screenMarkets as a screening engine,
 *     and the module file is gone.
 * (e) Scheduling: the S1 schedule schema accepts provider "yahoo" for
 *     autonomousMarketScreen (and rejects unknown providers), so a
 *     Yahoo-provider screen is schedulable through the existing stock
 *     schedule path.
 * (f) Client: the ScreenersHub Yahoo adapter declares the full stock
 *     filter set the pipeline now supports for Yahoo runs.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  acquireUniverse,
  screenUniverse,
  buildAllStocks,
} from "../src/trading/screenerPipeline";
import { DynamicMarketScreener } from "../src/trading/screener";
import { buildSchedulePayload } from "../src/trading/screeningSchemas";
import {
  handleMarketDataCompareScreenRoutes,
  type MarketDataResearchRouteContext,
} from "../src/agents/routes/marketDataResearch";
import { persistScreenerReportCanonical } from "../src/agents/orchestrator/reportDispatch";
import {
  handlePremiumRoutes,
  type PremiumRouteContext,
} from "../src/agents/routes/premium";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env, MarketDataResearchQuote, X402PaymentProof } from "../src/types";

// On-chain verification is covered by the x402 verifier suites; here
// the verifier accepts any claim (same stub as
// agentic_payments_identity_binding.test.ts), so the premium pin
// exercises the route's fulfillment, not the chain.
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) => ({
    ok: true,
    payer: proof.payer,
    txHash: proof.txHash,
  })),
}));

/* ------------------------------------------------------------------ */
/* (a) Adapter → pipeline                                              */
/* ------------------------------------------------------------------ */

function yahooFixture(overrides: Partial<MarketDataResearchQuote> = {}): MarketDataResearchQuote {
  return {
    symbol: "NVDA",
    provider: "yfinance",
    provenance: "live",
    companyName: "NVIDIA Corporation",
    price: 180,
    change: 9,
    changePercent: 5.26,
    bid: 179.9,
    ask: 180.1,
    volume: 42_000_000,
    open: 172,
    high: 181,
    low: 171,
    previousClose: 171,
    trailingPE: 40,
    marketCap: 4_400_000_000_000,
    rsi14: 28,
    macdSignal: "Bullish MACD Crossover (Line > Signal)",
    timestamp: "2026-10-22T00:00:00.000Z",
    currency: "USD",
    ...overrides,
  } as MarketDataResearchQuote;
}

const LISTINGS = [
  { symbol: "NVDA", companyName: "NVIDIA Corporation", exchange: "NASDAQ", change: 0, changePercent: 0, sector: "Technology" },
  { symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", change: 0, changePercent: 0, sector: "Technology" },
] as any[];

describe("S3 (a) — Yahoo adapter feeds the one pipeline", () => {
  it("fixture Yahoo payload → pipeline quotes → pipeline-shaped scored result", async () => {
    const deps = {
      fetchYahooQuote: vi.fn(async (sym: string) =>
        sym === "NVDA"
          ? yahooFixture()
          : yahooFixture({ symbol: "AAPL", companyName: "Apple Inc.", price: 230, change: 2, changePercent: 0.88, previousClose: 228, rsi14: 55 })
      ),
    };
    const acquired = await acquireUniverse({ mode: "yahoo", symbols: LISTINGS, yahooDeps: deps });
    expect(acquired.provider).toBe("yahoo");
    expect(acquired.quotes).toHaveLength(2);
    expect(acquired.quotes[0].source).toBe("Yahoo Finance");
    // RSI-14 rides through as a data field on the pipeline quote.
    expect(acquired.quotes.find((q) => q.symbol === "NVDA")?.rsi).toBe(28);

    const result = screenUniverse(new DynamicMarketScreener(), acquired, {});
    expect(result.totalScanned).toBe(2);
    expect(result.matchedCount).toBe(2);
    const nvda = result.stocks.find((s) => s.symbol === "NVDA")!;
    // Pipeline semantics: RSI 28 < 35 → the pipeline's own signal.
    expect(nvda.signal).toBe("OVERSOLD_BOUNCE");
    expect(nvda.momentumScore).toBe(Math.round(50 + 5.26 * 5));
    // The provider's MACD signal survives as data on the screened row.
    expect(nvda.macdSignal).toContain("Bullish MACD");

    // Same row shape as an E*TRADE-provider run through the same shaping.
    const yahooRows = buildAllStocks(acquired.quotes, result.stocks);
    const etradeAcquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: LISTINGS,
      quoteDeps: {
        fetchQuote: vi.fn(async (sym: string) => ({
          symbol: sym, companyName: sym, lastPrice: 100, price: 100, change: 1, changePercent: 1,
          bid: 0, ask: 0, volume: 0, open: 0, high: 0, low: 0, source: "E*TRADE live",
          quoteStatus: "LIVE", timestamp: "2026-10-22T00:00:00.000Z",
        }) as any),
      },
    });
    const etradeResult = screenUniverse(new DynamicMarketScreener(), etradeAcquired, {});
    const etradeRows = buildAllStocks(etradeAcquired.quotes, etradeResult.stocks);
    expect(Object.keys(yahooRows[0]).sort()).toEqual(Object.keys(etradeRows[0]).sort());
    expect(typeof yahooRows[0].indicators.screenScore).toBe("number");
    expect(yahooRows[0].rsi14).toBe(28);
  });

  it("the pipeline's RSI filter consumes the adapter's RSI data field", async () => {
    const deps = {
      fetchYahooQuote: vi.fn(async (sym: string) =>
        sym === "NVDA" ? yahooFixture() : yahooFixture({ symbol: "AAPL", rsi14: 55 })
      ),
    };
    const acquired = await acquireUniverse({ mode: "yahoo", symbols: LISTINGS, yahooDeps: deps });
    const result = screenUniverse(new DynamicMarketScreener(), acquired, { maxRsi: 40 });
    expect(result.stocks.map((s) => s.symbol)).toEqual(["NVDA"]);
  });

  it("honest failure: every Yahoo lookup failing fails the run — no fallback, no rows", async () => {
    const deps = { fetchYahooQuote: vi.fn(async () => { throw new Error("network down"); }) };
    await expect(acquireUniverse({ mode: "yahoo", symbols: LISTINGS, yahooDeps: deps }))
      .rejects.toThrow(/Yahoo Finance unavailable/);
  });

  it("honest failure: a non-live (generated/static) provider quote never enters the pipeline", async () => {
    const deps = {
      fetchYahooQuote: vi.fn(async (sym: string) =>
        yahooFixture({ symbol: sym, provenance: "generated" as any })
      ),
    };
    await expect(acquireUniverse({ mode: "yahoo", symbols: LISTINGS, yahooDeps: deps }))
      .rejects.toThrow(/Yahoo Finance unavailable/);
  });

  it("a partial Yahoo set is qualified, exactly like the E*TRADE path", async () => {
    const deps = {
      fetchYahooQuote: vi.fn(async (sym: string) => {
        if (sym === "AAPL") throw new Error("network down");
        return yahooFixture();
      }),
    };
    const acquired = await acquireUniverse({ mode: "yahoo", symbols: LISTINGS, yahooDeps: deps });
    expect(acquired.quotes.map((q) => q.symbol)).toEqual(["NVDA"]);
    expect(acquired.partial?.failedSymbols).toEqual(["AAPL"]);
    expect(acquired.discovery.message).toContain("Partial screen");
  });
});

/* ------------------------------------------------------------------ */
/* (b) market-data route → pipeline + canonical report                        */
/* ------------------------------------------------------------------ */

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen. The seam fake delegates to the stub agent's
// runScreen: it flattens the seam input back into the runScreen
// request (the symbols shard rides commandOverrides.shards) and
// returns the stub's result as the engine run's one shard. The seam
// itself is pinned in tests/stock_entry_routing_4278.test.ts.
const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
  const flat = {
    trigger: input.spec.trigger,
    sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
    universe: input.spec.universe,
    symbols: input.commandOverrides?.shards?.[0]?.symbols,
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

function marketDataResult(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-10-22T12:00:00.000Z",
    trigger: "manual",
    provider: "yahoo",
    universe: "NASDAQ100",
    sector: "ALL",
    success: true,
    totalScanned: 2,
    matchedCount: 1,
    opportunities: [],
    allStocks: [
      {
        symbol: "NVDA", companyName: "NVIDIA Corporation", signal: "OVERSOLD_BOUNCE",
        momentumScore: 76, lastPrice: 180, changePercent: 5.26, rsi14: 28,
        source: "Yahoo Finance", indicators: { screenScore: 73 }, factorGrades: {}, technicals: {},
      },
    ],
    discoveryMessage: "Yahoo Finance live quotes; 2 of 2 symbols quoted.",
    filterSummary: "mocked",
    userLogin: "octocat-s3",
    ...overrides,
  };
}

describe("S3 (b) — market-data route persists a canonical report with provider provenance", () => {
  it("POST /api/market-data/screen runs the pipeline (provider yahoo) and stores the canonical copy", async () => {
    const runScreen = vi.fn(async () => marketDataResult());
    const persist = vi.fn();
    const audit = vi.fn();
    const ctx = {
      env: {} as any,
      audit,
      getScreenerAgent: vi.fn(() => ({ runScreen })),
      runStockScreenViaEngine: delegateSeamFake(runScreen),
      persistScreenerReportCanonical: persist,
    } as unknown as MarketDataResearchRouteContext;
    const req = new Request("https://agent.internal/api/market-data/screen", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": "octocat-s3" },
      body: JSON.stringify({ sector: "Technology", maxRsi: 65 }),
    });
    const res = await handleMarketDataCompareScreenRoutes(req, new URL(req.url), "/api/market-data/screen", "sess-s3", ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.provider).toBe("yahoo");
    expect(body.stocks).toHaveLength(1);
    expect(body.stocks[0].source).toBe("Yahoo Finance");
    expect(body.results).toEqual(body.stocks);

    // The pipeline run was requested with the Yahoo provider.
    expect(runScreen).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "manual",
      provider: "yahoo",
      filters: expect.objectContaining({ sector: "Technology", maxRsi: 65 }),
      userLogin: "octocat-s3",
    }));
    // Issue #4278: a SUCCESS result is stored by the workflow's own
    // store step, so the route no longer persists it here (re-persisting
    // would double it) — the no-re-persist-on-success contract is
    // pinned in tests/stock_entry_routing_4278.test.ts. The canonical
    // copy still carries provider + trigger provenance; that shape is
    // pinned by the REST canonical seam test below.
    expect(persist).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "market_data.screener.executed",
      "research",
      expect.objectContaining({ provider: "yahoo", count: 1 })
    );
  });

  it("the REST canonical seam stores source 'screener' with provider + trigger in the body", async () => {
    // Issue #338 S2b: the seam is async now and stores through the R2
    // write path (ensureTables + env, inline when no bucket is bound) —
    // the assertions read the stored rows back instead of spying on the
    // old synchronous ORM call.
    const sql = new MockSqlStorage();
    const ctx = {
      env: {},
      ensureTables: () => sql,
    } as any;
    await persistScreenerReportCanonical(ctx, marketDataResult() as any);
    const { listScheduledReports } = await import("../src/services/scheduledReports");
    let hits = listScheduledReports(sql as any, {});
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("screener");
    expect(hits[0].runId).toBe("screener:2026-10-22T12:00:00.000Z");
    expect(JSON.parse(hits[0].body).provider).toBe("yahoo");
    expect(JSON.parse(hits[0].body).trigger).toBe("manual");
    // An E*TRADE run (no provider named) records the etrade default.
    // (Distinct timestamp: the seam dedupes on screener:<timestamp>.)
    const { provider: _drop, ...etradeResult } = marketDataResult({
      timestamp: "2026-10-22T12:05:00.000Z",
    }) as any;
    await persistScreenerReportCanonical(ctx, etradeResult);
    hits = listScheduledReports(sql as any, {});
    expect(hits).toHaveLength(2);
    const etradeHit = hits.find((h) => h.runId === "screener:2026-10-22T12:05:00.000Z");
    expect(JSON.parse(etradeHit!.body).provider).toBe("etrade");
  });

  it("Yahoo failure → visible 502, and the failed run is still stored (REST idiom)", async () => {
    const runScreen = vi.fn(async () => marketDataResult({
      success: false,
      error: "Yahoo Finance unavailable: no live quotes returned (0 of 2 symbols quoted). No fallback data substituted.",
      allStocks: [],
      totalScanned: 0,
      matchedCount: 0,
    }));
    const persist = vi.fn();
    const ctx = {
      env: {} as any,
      audit: vi.fn(),
      getScreenerAgent: vi.fn(() => ({ runScreen })),
      runStockScreenViaEngine: delegateSeamFake(runScreen),
      persistScreenerReportCanonical: persist,
    } as unknown as MarketDataResearchRouteContext;
    const req = new Request("https://agent.internal/api/market-data/screen", {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-login": "octocat-s3" },
      body: JSON.stringify({}),
    });
    const res = await handleMarketDataCompareScreenRoutes(req, new URL(req.url), "/api/market-data/screen", "sess-s3", ctx);
    expect(res!.status).toBe(502);
    const body = (await res!.json()) as any;
    expect(body.error).toContain("Yahoo Finance unavailable");
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ success: false, provider: "yahoo" }));
  });
});

/* ------------------------------------------------------------------ */
/* (c) Premium stock-signals                                           */
/* ------------------------------------------------------------------ */

describe("S3 (c) — premium stock-signals: no constant confidence, pipeline-derived values", () => {
  it("source pins: the 0.88 constant and the retired engine are gone from premium.ts", () => {
    const src = readFileSync("src/agents/routes/premium.ts", "utf8");
    expect(src).not.toContain("0.88");
    expect(src).not.toContain("YFinanceMarketScreener");
    expect(src).not.toContain("confidence: 0.");
    expect(src).toContain('provider: "yahoo"');
    expect(src).toContain("screenScore");
  });

  it("paid fulfillment returns confidence from the pipeline result (screenScore / 100)", async () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql as any);
    (orm as any).initializeSchema("s3_test");
    const env = {
      X402_NETWORK: "base-sepolia",
      X402_RECIPIENT_ADDRESS: "0x71C8363837918a211797E3c76A8B3C4258759550",
      X402_FACILITATOR_URL: "https://x402.org/facilitator",
      X402_AUTO_APPROVE_LIMIT: "0.05",
      X402_AGENT_WALLET_KEY: "test-agent-wallet-s3",
    } as unknown as Env;

    const runScreen = vi.fn(async () => marketDataResult());
    const persist = vi.fn();
    // Issue #2408: the route meters served calls through ctx.sql —
    // the production host always supplies it (makePremiumRouteContext),
    // so this route-level served expectation supplies it too.
    const ctx = {
      env,
      sql: new MockSqlStorage(),
      getOrm: () => orm,
      getScreenerAgent: vi.fn(() => ({ runScreen })),
      runStockScreenViaEngine: delegateSeamFake(runScreen),
      persistScreenerReportCanonical: persist,
    } as unknown as PremiumRouteContext;

    const url = new URL("https://agent.internal/premium/stock-signals");
    // Unpaid call → challenge nonce.
    const challengeRes = await handlePremiumRoutes(
      new Request(url, { method: "GET" }), url, "/premium/stock-signals", "gateway-s3", ctx
    );
    expect(challengeRes!.status).toBe(402);
    const challengeBody = (await challengeRes!.json()) as any;
    const nonce = challengeBody.protocols.x402.challenge.nonce as string;

    const proof: X402PaymentProof = {
      payer: "0xPayerS3",
      signature: "0x_sig_s3_valid",
      txHash: "0x_tx_s3_1",
      nonce,
      timestamp: Date.now(),
    } as X402PaymentProof;
    const res = await handlePremiumRoutes(
      new Request(url, {
        method: "GET",
        headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(proof)).toString("base64") },
      }),
      url, "/premium/stock-signals", "gateway-s3", ctx
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    // screenScore 73 → confidence 0.73 — derived, not the old constant.
    expect(body.signals[0].confidence).toBe(0.73);
    expect(body.signals[0].confidence).not.toBe(0.88);
    expect(body.signals[0].symbol).toBe("NVDA");
    expect(body.signals[0].rsi).toBe(28);
    expect(body.signals[0].signalType).toBe("OVERSOLD_BOUNCE");
    // Executed through the pipeline with the Yahoo provider + paid symbols.
    expect(runScreen).toHaveBeenCalledWith(expect.objectContaining({
      provider: "yahoo",
      trigger: "manual",
    }));
    const runArg = runScreen.mock.calls[0][0] as any;
    expect(runArg.symbols.map((s: any) => s.symbol)).toEqual(["NVDA", "AAPL", "MSFT", "TSLA"]);
    // Issue #4278: a SUCCESS result is stored by the workflow's own
    // store step, so the route no longer persists it here (pinned in
    // tests/stock_entry_routing_4278.test.ts: no re-persist on success).
    expect(persist).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* (d) Retired engine — no production caller                           */
/* ------------------------------------------------------------------ */

describe("S3 (d) — no production caller executes the retired engine path", () => {
  it("the engine module is gone and no src file references the class or its screen entry points", () => {
    expect(existsSync("src/trading/yfinanceScreener.ts")).toBe(false);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          // Comments may name the retired class historically; code may not.
          const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
          if (/YFinanceMarketScreener/.test(code)) offenders.push(`${full}: class reference`);
          if (/yfinanceScreener/.test(code)) offenders.push(`${full}: retired module reference`);
          if (/new YFinance/.test(code)) offenders.push(`${full}: construction`);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
    // The two former caller routes must not call ANY screenMarkets
    // engine entry point (screenMarkets is also a generic platform
    // method name elsewhere — the retired path is scoped to these).
    for (const route of ["src/agents/routes/marketDataResearch.ts", "src/agents/routes/premium.ts"]) {
      expect(readFileSync(route, "utf8")).not.toContain("screenMarkets");
    }
  });

  it("the trading barrel no longer exports the retired engine", () => {
    const barrel = readFileSync("src/trading/index.ts", "utf8");
    expect(barrel).not.toContain("yfinanceScreener");
    expect(barrel).not.toContain("yahooDataSource");
  });
});

/* ------------------------------------------------------------------ */
/* (e) Schedulable via the S1 schema                                   */
/* ------------------------------------------------------------------ */

describe("S3 (e) — a Yahoo-provider screen validates through the stock schedule schema", () => {
  it("buildSchedulePayload carries provider 'yahoo' for autonomousMarketScreen", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", provider: "yahoo" },
      { userLogin: "octocat-s3", trigger: "scheduled" }
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.provider).toBe("yahoo");
      expect(built.value.universe).toBe("NASDAQ100");
      expect(built.value.trigger).toBe("scheduled");
    }
  });

  it("an unknown provider is rejected with the field named", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100", provider: "bloomberg" },
      { userLogin: "octocat-s3", trigger: "scheduled" }
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error).toContain("provider");
  });

  it("a payload without provider still builds (E*TRADE default unchanged)", () => {
    const built = buildSchedulePayload(
      "autonomousMarketScreen",
      { universe: "NASDAQ100" },
      { userLogin: "octocat-s3", trigger: "scheduled" }
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.value.provider).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* (f) Client adapter                                                  */
/* ------------------------------------------------------------------ */

describe("S3 (f) — ScreenersHub Yahoo adapter declares the pipeline's filter set", () => {
  it("yahoo-finance exposes the same stock filters as etrade", async () => {
    const { getScreeningProviders, providerSupportsFilter } = await import(
      "../src/client/screeningAdapters"
    );
    const [etrade, yahoo] = getScreeningProviders("stocks");
    expect(yahoo.id).toBe("yahoo-finance");
    expect(yahoo.endpointByAssetClass.stocks).toBe("/api/market-data/screen");
    for (const filter of ["search", "limit", "exchange", "price-range", "trend"] as const) {
      expect(providerSupportsFilter(yahoo, "stocks", filter)).toBe(true);
      expect(providerSupportsFilter(yahoo, "stocks", filter)).toBe(
        providerSupportsFilter(etrade, "stocks", filter)
      );
    }
  });
});
