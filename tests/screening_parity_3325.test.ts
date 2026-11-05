/**
 * Issue #3325: Alpaca screens its own quotes.
 *
 * The declaration said `marketScreening: false` because "Alpaca has no screener
 * API". That is a fact about the vendor, not about the platform: the screening
 * math is ours (#3272), and the only broker input is quotes. These tests defend
 * the capability the adapter now actually has, and the refusals that must
 * survive it — a screen that cannot resolve its universe, or read its quotes,
 * says so instead of reporting "no matches".
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const listings = [
  { symbol: "AAA", companyName: "Alpha Systems", exchange: "NASDAQ", change: 1, changePercent: 1, marketCap: 3_000_000_000_000, lastPrice: 100 },
  { symbol: "BBB", companyName: "Beta Devices", exchange: "NASDAQ", change: -1, changePercent: -1, marketCap: 2_000_000_000_000, lastPrice: 90 },
  { symbol: "CCC", companyName: "Gamma Corp", exchange: "NASDAQ", change: 0, changePercent: 0, marketCap: 1_000_000_000_000, lastPrice: 80 },
  { symbol: "DDD", companyName: "Delta Tools", exchange: "NYSE", change: 0, changePercent: 0, marketCap: 500_000_000_000, lastPrice: 70 },
];

vi.mock("../src/services/nasdaqListings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/nasdaqListings")>();
  return { ...actual, fetchAllUsStockListings: async () => listings };
});

import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";
import { AlpacaTradingPlatform as BarrelPlatform } from "../src/trading";
import { brokerSupports } from "../src/trading/brokerCatalog";

const ENV = { ALPACA_API_KEY: "key", ALPACA_SECRET_KEY: "secret" } as any;

function quote(symbol: string, lastPrice: number) {
  return {
    symbol,
    companyName: symbol,
    lastPrice,
    price: lastPrice,
    change: 1,
    changePercent: 1,
    bid: lastPrice - 0.05,
    ask: lastPrice + 0.05,
    volume: 1_000_000,
    open: lastPrice - 1,
    high: lastPrice + 1,
    low: lastPrice - 2,
    source: "test",
    timestamp: "2026-11-05T00:00:00.000Z",
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the declaration matches the adapter (#3325)", () => {
  it("Alpaca declares market screening", () => {
    expect(brokerSupports("alpaca", "marketScreening")).toBe(true);
    expect(brokerSupports("etrade", "marketScreening")).toBe(true);
  });

  it("the method the declaration points at exists, through the public barrel too", () => {
    expect(typeof AlpacaTradingPlatform.prototype.screenMarkets).toBe("function");
    expect(typeof BarrelPlatform.prototype.screenMarkets).toBe("function");
  });
});

describe("the Alpaca screen reads Alpaca quotes (#3325)", () => {
  it("screens the resolved universe and reports which universe was scanned", async () => {
    const platform = new AlpacaTradingPlatform(ENV, undefined, "user-1", "TEST");
    const getQuote = vi
      .spyOn(platform, "getQuote")
      .mockImplementation(async (symbol: string) => quote(symbol.trim().toUpperCase(), symbol === "AAA" ? 100 : 20));

    const result = await platform.screenMarkets({ universe: "NASDAQ100" });

    expect(result.status).not.toBe("no_universe");
    expect(result.totalScanned).toBe(3); // the three NASDAQ listings, not the NYSE one
    expect(result.filterSummary).toContain("NASDAQ100");
    expect(getQuote).toHaveBeenCalled();
    expect(result.stocks.map((s) => s.symbol).sort()).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("a quote that fails is reported under its own name, not filled in", async () => {
    const platform = new AlpacaTradingPlatform(ENV, undefined, "user-1", "TEST");
    vi.spyOn(platform, "getQuote").mockImplementation(async (symbol: string) => {
      if (symbol.trim().toUpperCase() === "BBB") throw new Error("Alpaca quote feed unavailable");
      return quote(symbol.trim().toUpperCase(), 100);
    });

    const result = await platform.screenMarkets({ universe: "NASDAQ100" });
    expect(result.totalScanned).toBe(2);
    expect(result.stocks.map((s) => s.symbol)).not.toContain("BBB");
  });

  it("an unresolvable universe is a named refusal, never an empty success", async () => {
    const platform = new AlpacaTradingPlatform(ENV, undefined, "user-1", "TEST");
    // A universe id the catalogue does not offer: resolveUniverse yields nothing,
    // and the screener must say that rather than report "no matches".
    const result = await platform.screenMarkets({ universe: "NOT_A_UNIVERSE" });
    expect(result.status).toBe("no_universe");
    expect(result.filterSummary.toLowerCase()).toContain("could not be resolved");
    expect(result.validationError).toBeDefined();
    expect(result.stocks).toEqual([]);
  });
});
