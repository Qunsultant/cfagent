/**
 * Issue #3233 (program #3216) — Alpaca capability parity, and the trading type
 * as an explicit choice.
 *
 * What these tests defend:
 *   1. A broker's declared capabilities in the catalog match what the platform
 *      actually implements — so "Alpaca does not support X" is a checked fact,
 *      not a claim in a doc.
 *   2. The new Alpaca options plane maps only what Alpaca sends: no invented
 *      bid/ask/last, contracts without a two-sided quote are omitted, greeks
 *      appear only when present.
 *   3. Paper vs live is a stated choice (ALPACA_TRADING_TYPE) with the legacy
 *      base-URL inference preserved when it is unset.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { PublicTradingPlatform } from "../src/trading/public/platform";
import { BROKER_CATALOG, brokerSupports, type BrokerId, type BrokerOperation } from "../src/trading/brokerCatalog";

const CREDS = { ALPACA_API_KEY: "key", ALPACA_SECRET_KEY: "secret" } as any;

/**
 * Catalog operation → the platform method that implements it. `optionsDiscovery`
 * (#3374) is an ENGINE capability — the discovery service, not a platform
 * method — so it is excluded here and declared per broker in the catalog, where
 * the run-history surface reads it.
 */
const OPERATION_METHOD: Record<Exclude<BrokerOperation, "optionsDiscovery">, string> = {
  quote: "getQuote",
  detailedQuote: "getQuoteDetailed",
  accounts: "getAccounts",
  positions: "getPositions",
  positionLots: "getPositionLots",
  optionChains: "getOptionChains",
  optionExpireDates: "getOptionExpireDates",
  orderPreview: "previewOrder",
  orderPlace: "placeOrderRemote",
  // Issue #3390: cancelling is a platform capability too, so it belongs in the
  // same total map as placement — a broker that declares it must implement it.
  orderCancel: "cancelOrderRemote",
  marketScreening: "screenMarkets",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as any;
}

describe("declared capabilities match the implementation (#3233)", () => {
  it("every broker's catalog entry agrees with the methods its platform exposes", () => {
    const prototypes: Record<BrokerId, any> = {
      etrade: ETradeTradingPlatform.prototype,
      alpaca: AlpacaTradingPlatform.prototype,
      // Issue #3990: Public joins the parity total — every capability
      // the catalog declares for public must have a platform method.
      public: PublicTradingPlatform.prototype,
    };
    for (const broker of Object.keys(BROKER_CATALOG) as BrokerId[]) {
      for (const [operation, method] of Object.entries(OPERATION_METHOD) as [BrokerOperation, string][]) {
        const implemented = typeof prototypes[broker][method] === "function";
        expect(implemented, `${broker} declares ${operation}=${brokerSupports(broker, operation)} but ${method} ${implemented ? "exists" : "is absent"}`).toBe(
          brokerSupports(broker, operation),
        );
      }
    }
  });

  it("states what Alpaca now has, and what it still does not (#3325, #3328)", () => {
    // #3328: lots are derived from fills, so the adapter implements the method.
    expect(brokerSupports("alpaca", "positionLots")).toBe(true);
    // #3325: screening is the platform's math on the broker's own quotes.
    expect(brokerSupports("alpaca", "marketScreening")).toBe(true);
    const platform = new AlpacaTradingPlatform(CREDS, undefined, "user@example.com") as any;
    expect(typeof platform.getPositionLots).toBe("function");
    expect(typeof platform.screenMarkets).toBe("function");
    // Issue #3990: Public declares the same screening capability, and
    // its platform implements it over its own quotes.
    expect(brokerSupports("public", "marketScreening")).toBe(true);
    const publicPlatform = new PublicTradingPlatform({} as any, undefined, "user@example.com") as any;
    expect(typeof publicPlatform.screenMarkets).toBe("function");
    // Option ORDER placement is still equity-only in the adapter; #3329 closes
    // that, and until then the declaration must keep saying what is true.
    expect(brokerSupports("alpaca", "orderPlace")).toBe(true);
  });

  it("states E*TRADE's full support", () => {
    for (const operation of Object.keys(OPERATION_METHOD) as BrokerOperation[]) {
      expect(brokerSupports("etrade", operation), operation).toBe(true);
    }
  });
});

describe("Alpaca options data plane (#3233)", () => {
  function stubOptions(contracts: any[], snapshots: Record<string, any>) {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/v2/options/contracts")) {
          return jsonResponse({ option_contracts: contracts });
        }
        if (url.includes("/v1beta1/options/snapshots/")) {
          return jsonResponse({ snapshots });
        }
        return jsonResponse({}, false, 404);
      }),
    );
    return calls;
  }

  const AAPL = { ALPACA_API_KEY: "key", ALPACA_SECRET_KEY: "secret" } as any;

  it("derives distinct, ascending expiry dates from the contracts list", async () => {
    stubOptions(
      [
        { symbol: "AAPL260116C00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "200", type: "call" },
        { symbol: "AAPL260116P00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "200", type: "put" },
        { symbol: "AAPL260102C00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-02", strike_price: "200", type: "call" },
      ],
      {},
    );
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    const dates = await platform.getOptionExpireDates("AAPL");
    expect(dates).toEqual([
      { year: 2026, month: 1, day: 2 },
      { year: 2026, month: 1, day: 16 },
    ]);
  });

  it("builds call/put pairs from contracts + snapshots, carrying greeks only when sent", async () => {
    stubOptions(
      [
        { symbol: "AAPL260116C00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "200", type: "call" },
        { symbol: "AAPL260116P00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "200", type: "put" },
      ],
      {
        AAPL260116C00200000: {
          latestQuote: { bp: 5.1, ap: 5.3 },
          latestTrade: { p: 5.25 },
          dailyBar: { v: 1234 },
          greeks: { delta: 0.52, gamma: 0.01 },
          impliedVolatility: 0.31,
        },
        AAPL260116P00200000: {
          latestQuote: { bp: 4.4, ap: 4.6 },
          // no latestTrade: lastPrice is the documented midpoint derivation
        },
      },
    );
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    vi.spyOn(platform, "getQuote").mockResolvedValue({ symbol: "AAPL", lastPrice: 201.5 } as any);

    const chain = await platform.getOptionChains({ symbol: "AAPL", expiryYear: 2026, expiryMonth: 1, expiryDay: 16 });
    expect(chain).not.toBeNull();
    expect(chain!.underlyingPrice).toBe(201.5);
    expect(chain!.selectedExpiry).toEqual({ year: 2026, month: 1, day: 16 });
    expect(chain!.pairs).toHaveLength(1);
    const pair = chain!.pairs[0];
    expect(pair.call).toMatchObject({ optionType: "CALL", strikePrice: 200, bid: 5.1, ask: 5.3, lastPrice: 5.25, volume: 1234, delta: 0.52, gamma: 0.01, impliedVolatility: 0.31 });
    // Midpoint derivation, stated rather than invented; no greeks were sent.
    expect(pair.put).toMatchObject({ optionType: "PUT", lastPrice: 4.5 });
    expect(pair.put!.delta).toBeUndefined();
    expect(pair.put!.impliedVolatility).toBeUndefined();
  });

  it("omits a contract with no two-sided quote instead of inventing prices", async () => {
    stubOptions(
      [
        { symbol: "AAPL260116C00150000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "150", type: "call" },
        { symbol: "AAPL260116C00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "200", type: "call" },
      ],
      {
        // Only one side quoted — not tradable, so not emitted.
        AAPL260116C00150000: { latestQuote: { bp: 50.0 } },
        AAPL260116C00200000: { latestQuote: { bp: 5.1, ap: 5.3 }, latestTrade: { p: 5.2 } },
      },
    );
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    vi.spyOn(platform, "getQuote").mockResolvedValue({ symbol: "AAPL", lastPrice: 201.5 } as any);

    const chain = await platform.getOptionChains({ symbol: "AAPL", expiryYear: 2026, expiryMonth: 1 });
    expect(chain!.pairs).toHaveLength(1);
    expect(chain!.pairs[0].call!.strikePrice).toBe(200);
  });

  it("returns null when nothing is quotable rather than an empty success", async () => {
    stubOptions(
      [{ symbol: "AAPL260116C00200000", underlying_symbol: "AAPL", expiration_date: "2026-01-16", strike_price: "200", type: "call" }],
      {},
    );
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    vi.spyOn(platform, "getQuote").mockResolvedValue({ symbol: "AAPL", lastPrice: 201.5 } as any);
    expect(await platform.getOptionChains({ symbol: "AAPL", expiryYear: 2026, expiryMonth: 1 })).toBeNull();
  });

  it("honours the request budget instead of making an unbounded call", async () => {
    stubOptions([], {});
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    const exhausted = { tryConsume: () => false };
    await expect(platform.getOptionChains({ symbol: "AAPL" }, exhausted)).rejects.toThrow(/budget exhausted/);
  });

  it("surfaces an upstream failure as a short broker-named error, never the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "<html>raw upstream</html>" }, false, 500)));
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    await expect(platform.getOptionExpireDates("AAPL")).rejects.toThrow(/Alpaca option contracts unavailable \[HTTP 500\]/);
  });

  it("getQuoteDetailed carries the error instead of throwing", async () => {
    const platform = new AlpacaTradingPlatform(AAPL, undefined, "user@example.com");
    vi.spyOn(platform, "getQuote").mockRejectedValue(new Error("Alpaca quote unavailable"));
    expect(await platform.getQuoteDetailed("AAPL")).toEqual({ quote: null, error: "Alpaca quote unavailable" });
  });
});

describe("paper vs live is a stated choice (#3233)", () => {
  it("ALPACA_TRADING_TYPE=paper wins over a live-looking base URL", async () => {
    const status = await new AlpacaTradingPlatform(
      { ...CREDS, ALPACA_BASE_URL: "https://api.alpaca.markets", ALPACA_TRADING_TYPE: "paper" } as any,
      undefined,
      "user@example.com",
    ).getStatus();
    expect(status.environment).toBe("paper");
    expect(status.mode).toBe("paper_api");
    expect(status.activeEnvironment).toBe("TEST");
    expect(status.apiUrl).toBe("https://paper-api.alpaca.markets");
  });

  it("ALPACA_TRADING_TYPE=live wins over a paper base URL", async () => {
    const status = await new AlpacaTradingPlatform(
      { ...CREDS, ALPACA_BASE_URL: "https://paper-api.alpaca.markets", ALPACA_TRADING_TYPE: "live" } as any,
      undefined,
      "user@example.com",
    ).getStatus();
    expect(status.environment).toBe("live");
    expect(status.mode).toBe("live_api");
    expect(status.activeEnvironment).toBe("PROD");
    expect(status.apiUrl).toBe("https://api.alpaca.markets");
  });

  it("unset keeps the legacy inference, so no environment changes silently", async () => {
    const paper = await new AlpacaTradingPlatform(CREDS, undefined, "user@example.com").getStatus();
    expect(paper.environment).toBe("paper");
    expect(paper.apiUrl).toBe("https://paper-api.alpaca.markets");

    const live = await new AlpacaTradingPlatform(
      { ...CREDS, ALPACA_BASE_URL: "https://api.alpaca.markets" } as any,
      undefined,
      "user@example.com",
    ).getStatus();
    expect(live.environment).toBe("live");
  });
});
