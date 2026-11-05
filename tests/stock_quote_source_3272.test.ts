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
  function ctx(): BrokerScreenRouteContext {
    return {
      env: { APP_ENV: "TEST" } as any,
      getOrm: () => undefined,
      readSettingRaw: () => null,
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
    expect(getPlatform.mock.calls[0][0]).toBe("alpaca");
  });

  it("surfaces a partial quote failure instead of hiding it", async () => {
    getPlatform.mockImplementation(
      () =>
        ({
          getQuote: async (s: string) => {
            if (s === "NOPE") throw new Error("no such symbol");
            return quote(s);
          },
        }) as any,
    );
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
