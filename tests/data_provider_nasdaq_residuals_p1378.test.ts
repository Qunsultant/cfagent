/**
 * Issue #1378 (Nasdaq residuals, epic #1116) — the slice's NEW behaviour.
 * TDD Red: these pins FAIL on the pre-slice tree (the dep-less default
 * in acquireUniverse, the direct feedNasdaq fetch, the direct
 * research/options/symbol-leg fetches) and pass after the reroute.
 *
 * Pins (all fetches stubbed — no network on the build tree):
 *  - (a) all-listings: routed via universeDeps and via universeRoute
 *    bundle (with capture under the run id); neither → the existing
 *    error-result shape naming the missing seam (D1), never a throw
 *    and never a direct fetch; route-not-naming-nasdaq and
 *    nasdaq-not-enabled → error results naming the route (D1);
 *  - (a) screenLive forwarding: seam in → routed stocks; no seam →
 *    discovery.error naming the missing seam, empty stocks;
 *  - (c2) symbol legs: symbols absent + no seam → throw mirroring
 *    the quoteDeps throw; with seam → technology filter preserved;
 *  - (c3) resolveUnderlyings: explicit passthrough, fixture, routed
 *    sorted+capped discovery, neither → throw naming the seam;
 *  - (c1) research provider: stub parity + lifetime-cache-kept (D3);
 *    no deps → degrade to [] / empty map with a warn (never a throw,
 *    never a direct fetch);
 *  - (b)/(c4) route bundle helper: full capture with storage,
 *    outcome-only without storage (no capture_failed pollution);
 *  - consumer forwarding: ETradeService / platform / factory /
 *    flowService pass the seam through to screenLive.
 *
 * New symbols (route bundle helper, filterTechnologySymbols) are
 * imported dynamically inside their tests so a missing export fails
 * that test (not the whole file at collection) on control.
 *
 * No secret-shaped literals: this file contains no credentials, keys,
 * or tokens in any form.
 */
import { describe, it, expect, vi } from "vitest";
import {
  acquireUniverse,
  bindNasdaqUniverseDeps,
  nasdaqUniverseProviderFromRoute,
} from "../src/trading/screenerPipeline";
import { DynamicMarketScreener } from "../src/trading/screener";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { EtradeResearchDataProvider } from "../src/services/researchProviders";
import { ETradeService } from "../src/services/etrade";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { createLiveStockScreener } from "../src/services/screeningRuntime";
import { resolveDynamicFlowSymbols } from "../src/trading/options/flows/flowService";
import {
  createNasdaqDataProvider,
  verifyNasdaqDataProvider,
} from "../src/trading/dataProviders/adapters";
import {
  ensureCaptureTable,
  listCapturesByRun,
  listCaptureFailures,
} from "../src/trading/dataProviders/captureStore";
import {
  bootstrapDataProviders,
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
} from "../src/trading/dataProviders/providerConfigStore";
import { transitionProvider } from "../src/trading/dataProviders/lifecycle";
import { DataProviderRegistry } from "../src/trading/dataProviders/registry";
import { MockSqlStorage } from "./mock-sql";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { Env } from "../src/types";

const RUN = { runId: "run-nasdaq-1378", tenantId: "test-tenant", userLogin: "tester" };

function listing(
  symbol: string,
  companyName: string,
  exchange: string,
  lastPrice: number,
  marketCap = 0,
  sector = "Technology"
): NasdaqStockListing {
  return { symbol, companyName, exchange, lastPrice, change: 1, changePercent: 0.5, sector, marketCap } as NasdaqStockListing;
}

function stubListings(): NasdaqStockListing[] {
  return [
    listing("AAPL", "Apple Inc.", "NASDAQ", 150, 3e12),
    listing("MSFT", "Microsoft Corp.", "NASDAQ", 300, 2.5e12),
    listing("IBM", "IBM Corp.", "NYSE", 140, 1.5e11),
    listing("F", "Ford Motor Co.", "NYSE", 12, 4e10, "Consumer"),
    listing("XLF", "Financial Select ETF", "AMEX", 40, 1e10, "Financial"),
  ];
}

function techListings(): NasdaqStockListing[] {
  return [
    listing("TECH1", "Techtronics Software Inc.", "NASDAQ", 100),
    listing("DATA1", "DataWorks Systems", "NASDAQ", 50),
    listing("SEMI1", "Global Semiconductor Corp.", "NYSE", 80),
    listing("NET1", "Internet Holdings Group", "NASDAQ", 40),
    listing("COMP1", "Computer Parts Co.", "AMEX", 20),
    listing("FORD", "Ford Motor Co.", "NYSE", 12, 0, "Consumer"),
    listing("ACME", "Acme Foods Inc.", "NASDAQ", 8, 0, "Consumer"),
  ];
}

function fakeBlobStorage() {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

function quoteDepsStub() {
  return {
    fetchQuote: async (symbol: string) => ({ symbol, lastPrice: 10, companyName: "", sector: "" }) as never,
    fetchQuotes: async (symbols: string[]) =>
      symbols.map((s) => ({ symbol: s, lastPrice: 10, companyName: "", sector: "" }) as never),
  };
}

async function enabledNasdaqSql(stub: () => Promise<NasdaqStockListing[]>): Promise<MockSqlStorage> {
  const sql = new MockSqlStorage();
  bootstrapDataProviders(sql as never);
  await transitionProvider(sql as never, "nasdaq", "verify", "tester", {
    verifier: async () => verifyNasdaqDataProvider({ fetchListings: stub as never }),
  });
  await transitionProvider(sql as never, "nasdaq", "enable", "tester", {});
  return sql;
}

describe("(a) all-listings routing", () => {
  it("routes via universeDeps: quotes and counts come from the stub", async () => {
    const stub = stubListings();
    const adapter = createNasdaqDataProvider(async () => stub);
    const acquired = await acquireUniverse({
      mode: "all-listings",
      universeDeps: bindNasdaqUniverseDeps(adapter, RUN),
    });
    expect(acquired.error).toBeUndefined();
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(stub.map((l) => l.symbol).sort());
    expect(acquired.discovery.listingCount).toBe(stub.length);
    expect(acquired.discovery.sourceCounts?.NASDAQ).toBe(2);
    expect(acquired.discovery.sourceCounts?.NYSE).toBe(2);
    expect(acquired.discovery.sourceCounts?.AMEX).toBe(1);
  });

  it("routes via universeRoute bundle: same quotes plus a capture row under the run id (D2)", async () => {
    const sql = await enabledNasdaqSql(async () => stubListings());
    ensureCaptureTable(sql as never);
    const { nasdaqUniverseRouteBundle } = (await import(
      "../src/trading/screenerPipeline"
    )) as typeof import("../src/trading/screenerPipeline");
    const bundle = await nasdaqUniverseRouteBundle({
      sql: sql as never,
      storage: fakeBlobStorage() as never,
      env: {} as never,
      userLogin: "tester",
      runId: RUN.runId,
      tenantId: "test-tenant",
      fetchListings: (async () => stubListings()) as never,
    });
    const acquired = await acquireUniverse({ mode: "all-listings", universeRoute: bundle as never });
    expect(acquired.error).toBeUndefined();
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(
      stubListings().map((l) => l.symbol).sort()
    );
    const byRun = listCapturesByRun(sql as never, "test-tenant", RUN.runId);
    expect(byRun.length).toBe(1);
    expect(byRun[0].providerId).toBe("nasdaq");
  });

  it("neither deps nor route → the existing error-result shape naming the missing seam (D1)", async () => {
    const acquired = await acquireUniverse({ mode: "all-listings" });
    expect(acquired.quotes).toEqual([]);
    expect(acquired.error).toMatch(/requires universeDeps or universeRoute/);
    expect(acquired.discovery.error).toMatch(/requires universeDeps or universeRoute/);
  });

  it("route not naming nasdaq → error result naming the route (D1)", async () => {
    const sql = await enabledNasdaqSql(async () => stubListings());
    const adapter = createNasdaqDataProvider(async () => stubListings());
    const registry = new DataProviderRegistry();
    registry.register(adapter);
    const bundle = {
      registry,
      configs: listProviderConfigs(sql as never),
      routes: [
        { capability: "screenUniverse", primaryProviderId: "yahoo", gapFillProviderId: null, minTier: "freemium" },
      ],
      runContext: RUN,
    };
    const acquired = await acquireUniverse({ mode: "all-listings", universeRoute: bundle as never });
    expect(acquired.quotes).toEqual([]);
    expect(acquired.error).toMatch(/does not name nasdaq as primary/);
  });

  it("nasdaq not enabled → error result naming the enabled check (D1)", async () => {
    const sql = new MockSqlStorage();
    bootstrapDataProviders(sql as never);
    const adapter = createNasdaqDataProvider(async () => stubListings());
    const registry = new DataProviderRegistry();
    registry.register(adapter);
    const bundle = {
      registry,
      configs: listProviderConfigs(sql as never),
      routes: listCapabilityRoutes(sql as never),
      runContext: RUN,
    };
    const acquired = await acquireUniverse({ mode: "all-listings", universeRoute: bundle as never });
    expect(acquired.quotes).toEqual([]);
    expect(acquired.error).toMatch(/not enabled/);
  });

  it("screenLive forwards the seam; without one it reports the missing seam (consumer pin)", async () => {
    const stub = stubListings();
    const adapter = createNasdaqDataProvider(async () => stub);
    const routed = await new DynamicMarketScreener().screenLive(
      {},
      { universeDeps: bindNasdaqUniverseDeps(adapter, RUN) } as never
    );
    expect(routed.discovery.error).toBeUndefined();
    expect(routed.stocks.map((s) => s.symbol).sort()).toEqual(stub.map((l) => l.symbol).sort());
    const unrouted = await new DynamicMarketScreener().screenLive({});
    expect(unrouted.stocks).toEqual([]);
    expect(unrouted.discovery.error).toMatch(/requires universeDeps or universeRoute/);
  });
});

describe("(c2) symbol legs require the universe seam", () => {
  it("filterTechnologySymbols keeps exactly the name-heuristic matches", async () => {
    const { filterTechnologySymbols } = (await import("../src/trading/liveScreener")) as typeof import(
      "../src/trading/liveScreener"
    );
    expect(filterTechnologySymbols(techListings()).map((l) => l.symbol)).toEqual([
      "TECH1",
      "DATA1",
      "SEMI1",
      "NET1",
      "COMP1",
    ]);
  });

  it("live-quotes with symbols absent and no seam throws naming the seam (quoteDeps-throw mirror)", async () => {
    await expect(
      acquireUniverse({ mode: "live-quotes", quoteDeps: quoteDepsStub() as never })
    ).rejects.toThrow(/requires universeDeps or universeRoute when symbols are absent/);
  });

  it("live-quotes with symbols absent and a seam quotes only the technology-filtered listings", async () => {
    const adapter = createNasdaqDataProvider(async () => techListings());
    const acquired = await acquireUniverse({
      mode: "live-quotes",
      quoteDeps: quoteDepsStub() as never,
      universeDeps: bindNasdaqUniverseDeps(adapter, RUN),
    });
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual([
      "COMP1",
      "DATA1",
      "NET1",
      "SEMI1",
      "TECH1",
    ]);
  });

  it("etrade-only with symbols absent and no seam throws naming the seam", async () => {
    await expect(
      acquireUniverse({ mode: "etrade-only", quoteDeps: quoteDepsStub() as never })
    ).rejects.toThrow(/requires universeDeps or universeRoute when symbols are absent/);
  });

  it("etrade-only with symbols absent and a seam quotes the technology-filtered listings", async () => {
    const adapter = createNasdaqDataProvider(async () => techListings());
    const acquired = await acquireUniverse({
      mode: "etrade-only",
      quoteDeps: quoteDepsStub() as never,
      universeDeps: bindNasdaqUniverseDeps(adapter, RUN),
    });
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual([
      "COMP1",
      "DATA1",
      "NET1",
      "SEMI1",
      "TECH1",
    ]);
  });
});

describe("(c3) options discovery routing", () => {
  it("explicit underlyings pass through deduped and uppercased (unchanged)", async () => {
    const screener = new DynamicOptionsScreener();
    await expect(
      screener.resolveUnderlyings({ underlyingSymbols: ["aapl", "AAPL", " msft "] } as never)
    ).resolves.toEqual(["AAPL", "MSFT"]);
  });

  it("test fixture still wins (precondition pin — pre-existing behavior)", async () => {
    const screener = new DynamicOptionsScreener();
    try {
      DynamicOptionsScreener.setTestListingsFixture(stubListings());
      await expect(screener.resolveUnderlyings({} as never)).resolves.toEqual(
        ["AAPL", "F", "IBM", "MSFT", "XLF"]
      );
    } finally {
      DynamicOptionsScreener.setTestListingsFixture(null);
    }
  });

  it("routed discovery is sorted and capped (determinism preserved)", async () => {
    const adapter = createNasdaqDataProvider(async () => techListings());
    const screener = new DynamicOptionsScreener(
      undefined,
      undefined,
      bindNasdaqUniverseDeps(adapter, RUN) as never
    );
    await expect(screener.resolveUnderlyings({ maxUnderlyings: 3 } as never)).resolves.toEqual([
      "ACME",
      "COMP1",
      "DATA1",
    ]);
    await expect(screener.resolveUnderlyings({} as never)).resolves.toEqual(
      ["ACME", "COMP1", "DATA1", "FORD", "NET1", "SEMI1", "TECH1"]
    );
  });

  it("neither fixture nor deps → throw naming the missing seam (never a direct fetch)", async () => {
    const screener = new DynamicOptionsScreener();
    await expect(screener.resolveUnderlyings({} as never)).rejects.toThrow(
      /requires universeDeps/
    );
  });
});

describe("(c1) research provider routing", () => {
  it("stub parity: symbols and ETF markers match the direct-fetch behavior for the same listings", async () => {
    let calls = 0;
    // NOTE (correction to the build brief): getUniverseSymbols'
    // `universe as "NASDAQ100"` is a TYPE-ONLY cast — at runtime
    // the passed universe reaches resolveUniverse unchanged. So
    // parity is against resolveUniverse("TECH", stub), and the
    // stub needs technology names for a non-vacuous comparison.
    const stub = [...techListings(), listing("XLF", "Financial Select ETF", "AMEX", 40, 1e10, "Financial")];
    const adapter = createNasdaqDataProvider(async () => {
      calls += 1;
      return stub;
    });
    const provider = new EtradeResearchDataProvider(
      {} as Env,
      "tester",
      undefined,
      bindNasdaqUniverseDeps(adapter, RUN) as never
    );
    const { resolveUniverse } = await import("../src/trading/universes");
    const symbols = await provider.getUniverseSymbols("TECH");
    expect(symbols.sort()).toEqual(
      resolveUniverse("TECH", stub).map((l) => l.symbol).sort()
    );
    expect(symbols.sort()).toEqual(["COMP1", "DATA1", "NET1", "SEMI1", "TECH1"]);
    const etfs = await provider.etfMap();
    expect(etfs.get("XLF")).toBe(true);
    expect(etfs.get("TECH1")).toBe(false);
    expect(calls).toBe(1);
    await provider.getUniverseSymbols("TECH");
    expect(calls).toBe(1);
  });

  it("no deps → degrade to [] / empty map with a warn naming the seam (D3 cache kept, never a throw)", async () => {
    // #3515 S3: the warn now travels as a structured
    // researchProviders.universe_deps_missing event (level warn) on the
    // console-info JSON fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const provider = new EtradeResearchDataProvider({} as Env, "tester");
      await expect(provider.getUniverseSymbols("TECH")).resolves.toEqual([]);
      await expect(provider.etfMap()).resolves.toEqual(new Map());
      const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
      for (const call of infoSpy.mock.calls) {
        try {
          const parsed = JSON.parse(String(call[0])) as {
            operation?: unknown;
            level?: unknown;
            fields?: unknown;
          };
          if (parsed && typeof parsed.operation === "string") {
            events.push({
              operation: parsed.operation,
              level: typeof parsed.level === "string" ? parsed.level : "",
              fields:
                parsed.fields && typeof parsed.fields === "object"
                  ? (parsed.fields as Record<string, unknown>)
                  : {},
            });
          }
        } catch {
          // Non-JSON console.info lines are not structured events.
        }
      }
      const missing = events.find((e) => e.operation === "researchProviders.universe_deps_missing");
      expect(missing).toBeDefined();
      expect(missing?.level).toBe("warn");
      expect(String(missing?.fields.message ?? "")).toContain("universeDeps");
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("(b)/(c4) route bundle helper", () => {
  it("full capture with storage: bound fetch returns the stub and writes a capture row under the run id", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql as never);
    const { nasdaqUniverseRouteBundle } = (await import(
      "../src/trading/screenerPipeline"
    )) as typeof import("../src/trading/screenerPipeline");
    const bundle = await nasdaqUniverseRouteBundle({
      sql: sql as never,
      storage: fakeBlobStorage() as never,
      env: {} as never,
      userLogin: "tester",
      runId: RUN.runId,
      tenantId: "test-tenant",
      fetchListings: (async () => stubListings()) as never,
    });
    const provider = nasdaqUniverseProviderFromRoute(
      bundle.registry,
      bundle.configs,
      bundle.routes
    );
    const deps = bindNasdaqUniverseDeps(provider, bundle.runContext);
    expect(await deps.fetchListings()).toEqual(stubListings());
    const byRun = listCapturesByRun(sql as never, "test-tenant", RUN.runId);
    expect(byRun.length).toBe(1);
    expect(byRun[0].providerId).toBe("nasdaq");
  });

  it("outcome-only without storage: bound fetch returns the stub with zero capture rows and zero capture_failed pollution", async () => {
    const sql = new MockSqlStorage();
    ensureCaptureTable(sql as never);
    const { nasdaqUniverseRouteBundle } = (await import(
      "../src/trading/screenerPipeline"
    )) as typeof import("../src/trading/screenerPipeline");
    const bundle = await nasdaqUniverseRouteBundle({
      sql: sql as never,
      env: {} as never,
      userLogin: "tester",
      runId: RUN.runId,
      tenantId: "test-tenant",
      fetchListings: (async () => stubListings()) as never,
    });
    const provider = nasdaqUniverseProviderFromRoute(
      bundle.registry,
      bundle.configs,
      bundle.routes
    );
    const deps = bindNasdaqUniverseDeps(provider, bundle.runContext);
    expect(await deps.fetchListings()).toEqual(stubListings());
    expect(listCapturesByRun(sql as never, "test-tenant", RUN.runId)).toEqual([]);
    expect(listCaptureFailures(sql as never, "test-tenant")).toEqual([]);
  });
});

describe("consumer forwarding: the seam reaches screenLive", () => {
  it("ETradeService.screenMarketsAsync forwards a provided seam (routed, no network)", async () => {
    const stub = stubListings();
    const adapter = createNasdaqDataProvider(async () => stub);
    const service = new ETradeService({} as Env, undefined, "tester");
    const res = await service.screenMarketsAsync(
      {},
      { universeDeps: bindNasdaqUniverseDeps(adapter, RUN) } as never
    );
    expect(res.stocks.map((s) => s.symbol).sort()).toEqual(stub.map((l) => l.symbol).sort());
  });

  it("ETradeTradingPlatform.screenMarkets forwards a provided seam (routed, no network)", async () => {
    const stub = stubListings();
    const adapter = createNasdaqDataProvider(async () => stub);
    const platform = new ETradeTradingPlatform({} as Env, undefined, "tester");
    const res = await platform.screenMarkets(
      {},
      { universeDeps: bindNasdaqUniverseDeps(adapter, RUN) } as never
    );
    expect(res.stocks.map((s) => s.symbol).sort()).toEqual(stub.map((l) => l.symbol).sort());
  });

  it("createLiveStockScreener forwards a provided seam to the inner screener", async () => {
    let seen: unknown;
    const inner = {
      screenLive: async (_filter: unknown, seam: unknown) => {
        seen = seam;
        return { stocks: [], discovery: {} } as never;
      },
    };
    const screener = createLiveStockScreener(inner as never, { universeDeps: { fetchListings: async () => [] } } as never);
    await screener.screenMarkets({});
    expect(seen).toEqual({ universeDeps: { fetchListings: expect.any(Function) } });
  });

  it("resolveDynamicFlowSymbols with a seam returns routed symbols (not the curated fallback)", async () => {
    const big = listing("BGTCH", "Big Tech Software", "NASDAQ", 100, 50e9);
    const adapter = createNasdaqDataProvider(async () => [big]);
    const symbols = await resolveDynamicFlowSymbols(
      { marketCaps: ["large"] } as never,
      { universeDeps: bindNasdaqUniverseDeps(adapter, RUN) } as never
    );
    expect(symbols).toContain("BGTCH");
  });
});
