/**
 * Issue #3272 (S2): the stock quote source port and the neutral stock screen.
 *
 * What these tests defend:
 *   1. A broker that only offers quotes can drive the stock screen — the math
 *      is the platform's, the data is the broker's.
 *   2. A symbol that cannot be quoted is reported under its own name and
 *      contributes no row; nothing is filled in from another source.
 *   3. The route refuses an empty or oversized universe and a broker without a
 *      quote read, naming it — never a silent "no matches".
 *   4. The screening provider catalogue advertises the neutral route, so the
 *      client can discover it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  gatherQuotes,
  platformQuoteSource,
  screenSymbolsWithSource,
  type StockQuoteSource,
} from "../src/trading/stockQuoteSource";
import type { BrokerQuote } from "../src/types";

const tenant = vi.hoisted(() => ({ broker: "alpaca" as "etrade" | "alpaca" }));

vi.mock("../src/services/tenantProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/tenantProviders")>();
  return { ...actual, resolveTenantBroker: async () => tenant.broker };
});

import { handleBrokerScreenRoutes, MAX_SCREEN_SYMBOLS, type BrokerScreenRouteContext } from "../src/agents/routes/brokerScreen";
import { TradingPlatformRegistry } from "../src/trading/registry";
import { BROKER_CATALOG } from "../src/trading/brokerCatalog";

function quote(symbol: string, lastPrice = 100): BrokerQuote {
  return {
    symbol,
    lastPrice,
    changePercent: 1.5,
    volume: 1_000_000,
    week52High: 120,
    week52Low: 80,
  } as BrokerQuote;
}

function sourceFor(available: string[]): StockQuoteSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getQuote: async (symbol: string) => {
      asked.push(symbol);
      if (!available.includes(symbol)) throw new Error(`upstream rejected ${symbol}`);
      return quote(symbol);
    },
  };
}

describe("quotes come from one source, failures are named (#3272)", () => {
  it("gathers, normalises and de-duplicates symbols", async () => {
    const source = sourceFor(["AAPL", "MSFT"]);
    const gathered = await gatherQuotes(source, ["aapl", "AAPL", " msft "], 2);
    expect(gathered.quotes.map((q) => q.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    expect(gathered.failures).toEqual([]);
    expect(source.asked).toEqual(["AAPL", "MSFT"]);
  });

  it("reports a failing symbol by name and keeps the rest", async () => {
    const source = sourceFor(["AAPL"]);
    const gathered = await gatherQuotes(source, ["AAPL", "NOPE"], 2);
    expect(gathered.quotes).toHaveLength(1);
    expect(gathered.failures).toEqual([{ symbol: "NOPE", reason: "upstream rejected NOPE" }]);
  });

  it("adapts a platform into a quote source, and refuses one without getQuote", () => {
    const platform = { getQuote: vi.fn(async (s: string) => quote(s)) } as any;
    const source = platformQuoteSource(platform)!;
    expect(source).toBeTruthy();
    expect(platformQuoteSource({} as any)).toBeNull();
    expect(platformQuoteSource(null)).toBeNull();
  });

  it("screens with the pure screener over the gathered quotes", async () => {
    const source = sourceFor(["AAPL", "MSFT"]);
    const { result, quotes } = await screenSymbolsWithSource(source, ["AAPL", "MSFT"], {});
    expect(quotes.quotes).toHaveLength(2);
    expect(result.status).not.toBe("error");
    // The screener's own matching rules are covered by its suite; this proves
    // the neutral path produced a real screen result from broker quotes.
    expect(result.filterApplied).toBeTruthy();
  });
});

describe("the neutral stock screen route (#3272)", () => {
  // Issue #4433: the route screens through the one engine seam — the fake
  // seam answers with a run over exactly the shard it was given.
  function fakeAgent() {
    return {
      isScreenRunning: async () => ({ running: false, startedAt: null, runId: null, status: "idle" as const }),
      chargeScreenQuota: async () => {},
      getHistory: async () => [],
    };
  }

  let seam: ReturnType<typeof vi.fn>;

  function defaultSeam() {
    return vi.fn(async (input: any) => {
      const shardSymbols = input.commandOverrides.shards[0].symbols as Array<{ symbol: string }>;
      return {
        results: [
          {
            timestamp: "2026-11-18T00:00:00.000Z",
            trigger: "manual",
            provider: "alpaca",
            universe: input.spec.universe,
            sector: "ALL",
            success: true,
            totalScanned: shardSymbols.length,
            matchedCount: shardSymbols.length,
            opportunities: [],
            allStocks: shardSymbols.map((s) => ({ symbol: s.symbol })),
            discoveryMessage: "",
          },
        ],
        collation: null,
        jobId: "screener:manual:test:1",
        workflowId: "wf-test",
      };
    });
  }

  function ctx(): BrokerScreenRouteContext {
    return {
      env: { APP_ENV: "TEST" } as any,
      getOrm: () => undefined,
      readSettingRaw: () => null,
      getScreenerAgent: () => fakeAgent() as any,
      runStockScreenViaEngine: seam as any,
    };
  }

  function post(body: unknown) {
    const url = new URL("https://example.test/api/broker/screen");
    const request = new Request(url.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { request, url };
  }

  let getPlatform: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tenant.broker = "alpaca";
    seam = defaultSeam();
    getPlatform = vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(
      () => ({ getQuote: async (s: string) => quote(s) }) as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("screens the selected broker's quotes and names it", async () => {
    const { request, url } = post({ symbols: ["AAPL", "MSFT"] });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx());
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.broker).toBe("alpaca");
    expect(body.quotesRead).toBe(2);
    expect(body.failures).toEqual([]);
    // Issue #4433: the broker names the run's provider + broker on the
    // engine command, and the route constructs no platform itself.
    expect(seam).toHaveBeenCalledTimes(1);
    const input = seam.mock.calls[0][0];
    expect(input.spec.provider).toBe("alpaca");
    expect(input.commandOverrides.broker).toBe("alpaca");
    expect(input.commandOverrides.shards[0].symbols.map((s: any) => s.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(getPlatform).not.toHaveBeenCalled();
  });

  it("surfaces a partial quote failure instead of hiding it", async () => {
    // Issue #4433: the engine run's own quote trace names the symbol
    // whose read failed; the route surfaces it under its own name.
    seam = vi.fn(async () => ({
      results: [
        {
          timestamp: "2026-11-18T00:00:00.000Z",
          trigger: "manual",
          provider: "alpaca",
          universe: "symbols",
          sector: "ALL",
          success: true,
          totalScanned: 1,
          matchedCount: 1,
          opportunities: [],
          allStocks: [{ symbol: "AAPL" }],
          discoveryMessage: "",
          quoteTrace: {
            traceId: "t1",
            symbolCount: 2,
            batchCount: 1,
            quotesReceived: 1,
            quotesFailed: 1,
            failuresByCategory: { unknown_symbol: 1 },
            batches: [
              {
                batchIndex: 0,
                symbolCount: 2,
                httpStatus: 200,
                quotesReceived: 1,
                failures: [{ symbol: "NOPE", category: "unknown_symbol", detail: "no such symbol" }],
                durationMs: 5,
              },
            ],
          },
        },
      ],
      collation: null,
      jobId: "screener:manual:test:2",
      workflowId: "wf-test",
    }));
    const { request, url } = post({ symbols: ["AAPL", "NOPE"] });
    const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx());
    const body = await res!.json();
    expect(body.quotesRead).toBe(1);
    expect(body.failures).toEqual([{ symbol: "NOPE", reason: "no such symbol" }]);
  });

  it("caps an explicit symbolic list", async () => {
    const tooMany = post({ symbols: Array.from({ length: MAX_SCREEN_SYMBOLS + 1 }, (_, i) => `S${i}`) });
    const tooManyRes = await handleBrokerScreenRoutes(tooMany.request, tooMany.url, tooMany.url.pathname, "sid", ctx());
    expect(tooManyRes!.status).toBe(400);
    expect((await tooManyRes!.json()).message).toContain(String(MAX_SCREEN_SYMBOLS));
    expect(seam).not.toHaveBeenCalled();
  });

  it("resolves a default universe rather than demanding symbols", async () => {
    // Since the stock-UI slice, an empty body means "the default universe";
    // in this hermetic suite the listings feed is blocked, so the honest
    // answer is a coded 503 — never a curated substitute.
    const empty = post({});
    const res = await handleBrokerScreenRoutes(empty.request, empty.url, empty.url.pathname, "sid", ctx());
    expect(res!.status).toBe(503);
    expect((await res!.json()).code).toBe("LISTINGS_UNAVAILABLE");
  });

  it("refuses a broker with no quote read, without constructing it", async () => {
    const original = BROKER_CATALOG.alpaca.supports.quote;
    try {
      (BROKER_CATALOG.alpaca.supports as { quote: boolean }).quote = false;
      const { request, url } = post({ symbols: ["AAPL"] });
      const res = await handleBrokerScreenRoutes(request, url, url.pathname, "sid", ctx());
      expect(res!.status).toBe(501);
      expect(await res!.json()).toMatchObject({ code: "provider_unsupported", broker: "alpaca" });
      expect(getPlatform).not.toHaveBeenCalled();
      expect(seam).not.toHaveBeenCalled();
    } finally {
      (BROKER_CATALOG.alpaca.supports as { quote: boolean }).quote = original;
    }
  });

  it("ignores other paths and methods", async () => {
    const url = new URL("https://example.test/api/broker/screen");
    const get = new Request(url.toString(), { method: "GET" });
    expect(await handleBrokerScreenRoutes(get, url, url.pathname, "sid", ctx())).toBeNull();

    const other = new URL("https://example.test/api/broker/screens");
    const otherReq = new Request(other.toString(), { method: "POST", body: "{}" });
    expect(await handleBrokerScreenRoutes(otherReq, other, other.pathname, "sid", ctx())).toBeNull();
  });
});
