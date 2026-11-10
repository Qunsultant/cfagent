/**
 * Issue #1317 (Yahoo provider slice, epic #1116) — the slice's NEW
 * behaviour. TDD Red: these pins FAIL on the pre-slice tree (the
 * binding, the capture option, and the yahoo verifier do not exist
 * yet) and pass after the reroute.
 *
 * Pins:
 *  - bindYahooScreenerDeps: a platform yahoo provider bound to the
 *    pipeline's YahooScreenerDeps seam (per-symbol + batch when the
 *    provider offers it);
 *  - pipeline-via-platform parity: acquireUniverse yahoo mode through
 *    platform-bound deps returns the identical quotes as direct deps;
 *  - capture (E1 semantics) on every yahoo adapter fetch, run-linked,
 *    with a capture_failed marker (never a throw) on blob failure;
 *  - outcome (E7): a throwing platform fetch writes fetch_failed and
 *    rethrows the identical error; the pipeline still fails honestly;
 *  - lifecycle: verify → enable yahoo through transitionProvider with
 *    the yahoo verifier; the routes GET then serves yahoo enabled
 *    with a health block, and the quotes route names yahoo gap-fill;
 *  - route-table selection: the yahoo-mode quote provider resolves
 *    from the seeded quotes route's gap-fill assignment;
 *  - conformance: the yahoo adapter passes the kit over a fixture
 *    Market-data engine (drop-in replacement claim).
 *
 * No secret-shaped literals: this file contains no credentials, keys,
 * or tokens in any form.
 */
import { describe, it, expect } from "vitest";
import {
  acquireUniverse,
  bindYahooScreenerDeps,
  yahooQuoteProviderFromRoute,
  type YahooScreenerDeps,
} from "../src/trading/screenerPipeline";
import {
  createYahooDataProvider,
  verifyYahooDataProvider,
  type YahooCaptureDeps,
} from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByProvider,
  listCapturesByRun,
  listCaptureFailures,
  listFetchFailures,
} from "../src/trading/dataProviders/captureStore";
import {
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
  seedProviderConfigs,
} from "../src/trading/dataProviders/providerConfigStore";
import { transitionProvider } from "../src/trading/dataProviders/lifecycle";
import { DataProviderRegistry } from "../src/trading/dataProviders/registry";
import { runDataProviderConformance } from "../src/trading/dataProviders/conformance";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import { MockSqlStorage } from "./mock-sql";
import type { MarketDataResearchQuote } from "../src/types";
import type { IMarketDataProvider } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

const fastPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const noSleep = async () => {};
const RUN = { runId: "run-yahoo-1317", tenantId: "test-tenant", userLogin: "tester" };

function liveQuote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    companyName: `${symbol} Inc.`,
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    bid: price - 0.05,
    ask: price + 0.05,
    volume: 1000,
    open: price,
    high: price,
    low: price,
    previousClose: price - 1,
    timestamp: "2026-10-24T00:00:00.000Z",
    currency: "USD",
    rsi14: 55,
    macdSignal: "bullish",
  };
}

type FixtureMarketData = IMarketDataProvider & {
  getQuotes?: (symbols: string[]) => Promise<MarketDataResearchQuote[]>;
};

function fixtureMarketData(over: Partial<FixtureMarketData> = {}): FixtureMarketData {
  return {
    providerId: "yfinance",
    name: "fixture",
    isConfigured: () => true,
    getQuote: async (s: string) => liveQuote(s),
    getFundamentals: async (s: string) => ({
      provenance: "live",
      symbol: s,
      companyName: `${s} Inc.`,
      sector: "Technology",
      industry: "Software",
      description: "fixture",
      marketCap: 1_000_000,
      fiftyTwoWeekHigh: 300,
      fiftyTwoWeekLow: 200,
    }),
    getHistoricalBars: async (s: string, _tf?: string, limit?: number) => {
      const n = limit ?? 5;
      return Array.from({ length: n }, (_, i) => ({
        provenance: "live" as const,
        timestamp: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: 1000,
      }));
    },
    getQuotes: async (syms: string[]) => syms.map((s) => liveQuote(s)),
    ...over,
  };
}

function fakeBlobStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

function failingBlobStorage() {
  return {
    get: async (_key: string) => undefined,
    put: async (_key: string, _value: unknown) => {
      throw new Error("forced blob put failure");
    },
  };
}

function captureDeps(sql: MockSqlStorage, storage: unknown = fakeBlobStorage()): YahooCaptureDeps {
  ensureCaptureTable(sql as never);
  return { sql: sql as never, blobStorage: storage as never, env: {} as never };
}

function directDeps(over: Partial<YahooScreenerDeps> = {}): YahooScreenerDeps {
  return {
    fetchYahooQuote: async (s: string) => liveQuote(s),
    retryPolicy: fastPolicy,
    retrySleep: noSleep,
    ...over,
  };
}

const LISTINGS = (symbols: string[]) =>
  symbols.map((symbol) => ({
    symbol,
    companyName: `${symbol} Inc.`,
    exchange: "NASDAQ",
    change: 0,
    changePercent: 0,
    marketCap: 0,
    sector: "Technology",
  }));

describe("binding: platform yahoo provider → YahooScreenerDeps", () => {
  it("per-symbol fetch returns the platform MarketDataResearchQuote; batch present iff the provider offers it", async () => {
    const adapter = createYahooDataProvider(fixtureMarketData());
    const bound = bindYahooScreenerDeps(adapter, RUN);
    const q = await bound.fetchYahooQuote("AAPL");
    expect(q.symbol).toBe("AAPL");
    expect(q.provenance).toBe("live");
    expect(typeof bound.fetchYahooBatchQuotes).toBe("function");
    const batch = await bound.fetchYahooBatchQuotes!(["AAPL", "MSFT"]);
    expect(batch.map((b) => b.symbol)).toEqual(["AAPL", "MSFT"]);

    const noBatchMarketData = fixtureMarketData();
    delete (noBatchMarketData as Partial<FixtureMarketData>).getQuotes;
    const noBatchAdapter = createYahooDataProvider(noBatchMarketData);
    expect(noBatchAdapter.getQuotesBatch).toBeUndefined();
    expect(bindYahooScreenerDeps(noBatchAdapter, RUN).fetchYahooBatchQuotes).toBeUndefined();
  });

  it("pipeline-via-platform quotes are identical to direct-deps quotes", async () => {
    const symbols = ["AAPL", "MSFT", "GOOG"];
    const direct = await acquireUniverse({
      mode: "yahoo",
      symbols: LISTINGS(symbols),
      maxSymbols: 3,
      yahooDeps: directDeps(),
    });
    const platform = await acquireUniverse({
      mode: "yahoo",
      symbols: LISTINGS(symbols),
      maxSymbols: 3,
      yahooDeps: bindYahooScreenerDeps(createYahooDataProvider(fixtureMarketData()), RUN),
    });
    expect(platform.quotes).toEqual(direct.quotes);
    expect(platform.provider).toBe("yahoo");
    expect(platform.partial).toBeUndefined();
  });
});

describe("capture: every yahoo adapter fetch is captured, run-linked, never throwing", () => {
  it("quote/bars/fundamentals/batch each write a capture row under the run id", async () => {
    const sql = new MockSqlStorage();
    const adapter = createYahooDataProvider(fixtureMarketData(), undefined, {
      capture: captureDeps(sql),
    });
    await adapter.getQuote!("AAPL", RUN);
    await adapter.getHistoricalBars!("AAPL", "1D", 5, RUN);
    await adapter.getFundamentals!("AAPL", RUN);
    await adapter.getQuotesBatch!(["AAPL", "MSFT"], RUN);
    const byRun = listCapturesByRun(sql as never, "test-tenant", "run-yahoo-1317");
    expect(byRun.length).toBe(4);
    expect(byRun.map((r) => r.capability).sort()).toEqual([
      "fundamentals",
      "historicalBars",
      "quotes",
      "quotes",
    ]);
    expect(byRun.every((r) => r.providerId === "yahoo")).toBe(true);
    const byProvider = listCapturesByProvider(sql as never, "test-tenant", "yahoo");
    expect(byProvider.length).toBe(4);
    const quoteRows = byRun.filter((r) => r.capability === "quotes");
    expect(quoteRows.every((r) => r.rawKind === "provider-result")).toBe(true);
  });

  it("a blob failure writes a capture_failed marker and the fetch still returns", async () => {
    const sql = new MockSqlStorage();
    const adapter = createYahooDataProvider(fixtureMarketData(), undefined, {
      capture: captureDeps(sql, failingBlobStorage()),
    });
    const q = await adapter.getQuote!("AAPL", RUN);
    expect(q.result.symbol).toBe("AAPL");
    const failures = listCaptureFailures(sql as never, "test-tenant");
    expect(failures.length).toBe(1);
    expect(failures[0].providerId).toBe("yahoo");
    expect(failures[0].capability).toBe("quotes");
  });
});

describe("outcome: throwing platform fetches are tracked and rethrown identically", () => {
  it("a throwing market-data fetch writes fetch_failed and the pipeline still fails honestly", async () => {
    const sql = new MockSqlStorage();
    const boom = new Error("yahoo down");
    const adapter = createYahooDataProvider(
      fixtureMarketData({
        getQuote: async () => { throw boom; },
        // The batch path must fail too, or it covers the symbol and
        // the run legitimately succeeds — batch-first is the design.
        getQuotes: async () => { throw boom; },
      }),
      undefined,
      { capture: captureDeps(sql) }
    );
    let caught: unknown;
    try {
      await adapter.getQuote!("AAPL", RUN);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    const failed = listFetchFailures(sql as never, "test-tenant");
    expect(failed.length).toBe(1);
    expect(failed[0].providerId).toBe("yahoo");
    // The E7 classifier is honest: a bare message carries no
    // auth/rate-limit/timeout/network/upstream/parse signal, so it
    // classifies "unknown" (the taxonomy itself is pinned by E7's
    // own tests). What this pin owns: the row exists and the error
    // is the identical object.
    expect(failed[0].failureKind).toBe("unknown");

    await expect(
      acquireUniverse({
        mode: "yahoo",
        symbols: LISTINGS(["AAPL"]),
        maxSymbols: 1,
        yahooDeps: bindYahooScreenerDeps(adapter, RUN),
      })
    ).rejects.toThrow(/Yahoo Finance unavailable/);
  });
});

describe("lifecycle + routes: yahoo verifies, enables, and serves with health", () => {
  it("verify → enable through transitionProvider; GET serves yahoo enabled with a health block", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    expect(getProviderConfig(sql as never, "yahoo")?.lifecycleState).toBe("configured");
    const verifier = () =>
      verifyYahooDataProvider(undefined, {
        provider: fixtureMarketData(),
        // #3932: the verifier runs the conformance kit over the
        // adapter, which now probes news — the live Yahoo News
        // fetch is blocked in tests (#411), so the fetcher is
        // injected (production uses the live fetch by default).
        news: async (symbol: string) => [
          {
            headline: `${symbol} surges on strong earnings`,
            source: "Yahoo Finance",
            publishedAt: new Date().toISOString(),
            symbol,
          },
        ],
      });
    const verified = await transitionProvider(sql as never, "yahoo", "verify", "tester", {
      verifier: verifier as never,
    });
    expect(verified.lifecycleState).toBe("verified");
    const enabled = await transitionProvider(sql as never, "yahoo", "enable", "tester", {});
    expect(enabled.lifecycleState).toBe("enabled");
    expect(enabled.enabled).toBe(true);

    // A capture under the run gives the health block activity to report.
    const blob = fakeBlobStorage();
    const adapter = createYahooDataProvider(fixtureMarketData(), undefined, {
      capture: captureDeps(sql, blob),
    });
    await adapter.getQuote!("AAPL", RUN);

    const ctx: DataProviderRoutesContext = {
      env: {} as Env,
      sql: sql as never,
      userLogin: "tester",
      recordAudit: () => ({ id: "audit-1", type: "t", agent: "a", payload: {}, created_at: "" }) as never,
    };
    const request = new Request("https://agent.internal/data-providers", { method: "GET" });
    const res = (await handleDataProviderRoutes(
      request,
      new URL("https://agent.internal/data-providers"),
      "/data-providers",
      "session-1",
      ctx
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const yahoo = body.providers.find((p: any) => p.id === "yahoo");
    expect(yahoo.lifecycleState).toBe("enabled");
    expect(yahoo.enabled).toBe(true);
    expect(yahoo.health).toBeDefined();
    expect(typeof yahoo.health.status).toBe("string");
    const quotesRoute = body.routes.find((r: any) => r.capability === "quotes");
    // Issue #2144: the seed names no quotes gap-fill.
    expect(quotesRoute.gapFillProviderId).toBeNull();
  });

  it("the seeded quotes route names NO gap-fill (issue #2144)", () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const routes = listCapabilityRoutes(sql as never);
    expect(routes.find((r) => r.capability === "quotes")?.gapFillProviderId).toBeNull();
    expect(routes.find((r) => r.capability === "historicalBars")?.primaryProviderId).toBe("yahoo");
    expect(routes.find((r) => r.capability === "fundamentals")?.primaryProviderId).toBe("yahoo");
  });
});

describe("route-table selection: yahoo mode resolves from the quotes route", () => {
  it("returns the registered yahoo adapter when yahoo is enabled (route gap-fill no longer required, issue #2144)", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    await transitionProvider(sql as never, "yahoo", "verify", "tester", {
      verifier: (async () => ({ ok: true, summary: "fixture ok" })) as never,
    });
    await transitionProvider(sql as never, "yahoo", "enable", "tester", {});
    const registry = new DataProviderRegistry();
    const adapter = createYahooDataProvider(fixtureMarketData());
    registry.register(adapter);
    const resolved = yahooQuoteProviderFromRoute(
      registry,
      listProviderConfigs(sql as never),
      listCapabilityRoutes(sql as never)
    );
    expect(resolved.id).toBe("yahoo");
    expect(resolved).toBe(adapter);
  });

  it("throws when yahoo is not enabled or no quotes-capable adapter is registered", async () => {
    const sql = new MockSqlStorage();
    seedProviderConfigs(sql as never);
    const registry = new DataProviderRegistry();
    registry.register(createYahooDataProvider(fixtureMarketData()));
    // Yahoo registered but not enabled.
    expect(() =>
      yahooQuoteProviderFromRoute(
        registry,
        listProviderConfigs(sql as never),
        listCapabilityRoutes(sql as never)
      )
    ).toThrow();
    // Yahoo enabled but no adapter registered.
    await transitionProvider(sql as never, "yahoo", "verify", "tester", {
      verifier: (async () => ({ ok: true, summary: "fixture ok" })) as never,
    });
    await transitionProvider(sql as never, "yahoo", "enable", "tester", {});
    expect(() =>
      yahooQuoteProviderFromRoute(
        new DataProviderRegistry(),
        listProviderConfigs(sql as never),
        listCapabilityRoutes(sql as never)
      )
    ).toThrow();
  });
});

describe("conformance: yahoo adapter is a drop-in for the Market-data engine", () => {
  it("passes the kit for quotes, historicalBars, fundamentals, and news", async () => {
    const report = await runDataProviderConformance(
      createYahooDataProvider(fixtureMarketData(), undefined, {
        // #3932: the kit now probes the news capability — the
        // live Yahoo News fetch is blocked in tests (#411), so
        // the fetcher is injected (production uses the live
        // fetch by default).
        news: async (symbol: string) => [
          {
            headline: `${symbol} surges on strong earnings`,
            source: "Yahoo Finance",
            publishedAt: new Date().toISOString(),
            symbol,
          },
        ],
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.capability).sort()).toEqual([
      "fundamentals",
      "historicalBars",
      "news",
      "quotes",
    ]);
    expect(report.checks.every((c) => c.failures.length === 0)).toBe(true);
  });
});
