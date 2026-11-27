/**
 * Issue #6690 — the Alpaca batch-quotes feed leg returned zero
 * usable quotes on a 2xx ("Alpaca batch quotes returned no
 * results", 0/25 rows, 33/33 attempts, 2026-11-26).
 *
 * RCA: the multi-symbol stocks snapshots endpoint returns a
 * TOP-LEVEL symbol map (`{ "AAPL": { latestTrade, … } }`), but
 * getQuotes merged `data.snapshots` — the wrapped shape the
 * crypto/options endpoints use — so every chunk merged zero
 * snapshots and the leg threw "no results" on a healthy 2xx.
 * The #3530/#6278 fixtures encoded the same wrong wrapped shape,
 * so the suites stayed green while production returned nothing.
 *
 * These tests pin the fix:
 * 1. The documented top-level map maps onto quote rows.
 * 2. A malformed JSON body is a distinct, named failure — never
 *    folded into "no results".
 * 3. An empty-but-valid payload throws "no results" WITH
 *    response-shape evidence (HTTP status, feed, snapshot count,
 *    requested count); snapshots present but carrying no positive
 *    price are counted separately from absent snapshots.
 * 4. Feed selection is externalized (`ALPACA_STOCKS_FEED`, the
 *    ALPACA_OPTIONS_FEED pattern): set → the request carries it;
 *    unset → no feed parameter, so Alpaca applies its entitled
 *    default (sip with the unlimited subscription, else iex).
 * 5. An HTTP failure names the feed used, so an entitlement
 *    refusal is diagnosable from the terminal error alone.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { AlpacaMarketDataProvider } from "../src/services/marketDataResearch";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAPER_ENV = {
  ALPACA_PAPER_API_KEY: "PAPER_KEY",
  ALPACA_PAPER_SECRET_KEY: "PAPER_SECRET",
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as unknown as Env;

function snapshotRow(price = 232.5) {
  return {
    latestTrade: { p: price, s: 100, t: "2026-11-26T14:00:00.000Z" },
    latestQuote: { bp: price - 0.1, bs: 3, ap: price + 0.1, as: 2, t: "2026-11-26T14:00:00.000Z" },
    dailyBar: { o: 230.0, h: 233.0, l: 229.0, c: price, v: 1_000_000, vw: 231.8, t: "2026-11-26T14:00:00.000Z" },
    prevDailyBar: { o: 228.0, h: 231.0, l: 227.5, c: 231.3, v: 900_000, vw: 230.1, t: "2026-11-25T14:00:00.000Z" },
  };
}

/** The documented multi-symbol shape: a top-level symbol map. */
function topLevelPayload() {
  return { AAPL: snapshotRow(), MSFT: snapshotRow(410.25) };
}

function stubFetch(handler: (url: string) => Promise<unknown>) {
  const mock = vi.fn(async (input: unknown) => handler(String(input)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Alpaca batch quotes response shape (#6690)", () => {
  it("maps the documented top-level symbol map onto quote rows", async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => topLevelPayload() }));
    const provider = new AlpacaMarketDataProvider(PAPER_ENV);
    const quotes = await provider.getQuotes(["AAPL", "MSFT", "NVDA"]);
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(quotes[0]).toMatchObject({ price: 232.5, previousClose: 231.3, bid: 232.4, ask: 232.6 });
  });

  it("a malformed JSON body is a distinct named failure, not 'no results'", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    const provider = new AlpacaMarketDataProvider(PAPER_ENV);
    await expect(provider.getQuotes(["AAPL"])).rejects.toThrow(/malformed body/);
    await expect(provider.getQuotes(["AAPL"])).rejects.not.toThrow(/returned no results/);
  });

  it("an empty valid payload throws 'no results' with response-shape evidence", async () => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const provider = new AlpacaMarketDataProvider(PAPER_ENV);
    await expect(provider.getQuotes(["AAPL", "MSFT"])).rejects.toThrow(
      /returned no results \(HTTP 200, feed=default, snapshots=0, unusable=0, requested=2\)/,
    );
  });

  it("snapshots present but carrying no positive price are counted apart from absent ones", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        AAPL: { latestTrade: null, latestQuote: null, dailyBar: null, prevDailyBar: { c: 231.3 } },
      }),
    }));
    const provider = new AlpacaMarketDataProvider(PAPER_ENV);
    await expect(provider.getQuotes(["AAPL", "MSFT"])).rejects.toThrow(
      /snapshots=1, unusable=1, requested=2/,
    );
  });

  it("ALPACA_STOCKS_FEED set → the request carries it; unset → no feed parameter (entitled default)", async () => {
    const seen: string[] = [];
    stubFetch(async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => topLevelPayload() };
    });
    const pinned = new AlpacaMarketDataProvider({ ...PAPER_ENV, ALPACA_STOCKS_FEED: "iex" } as Env);
    await pinned.getQuotes(["AAPL"]);
    expect(new URL(seen[0]).searchParams.get("feed")).toBe("iex");

    const unpinned = new AlpacaMarketDataProvider(PAPER_ENV);
    await unpinned.getQuotes(["AAPL"]);
    expect(new URL(seen[1]).searchParams.has("feed")).toBe(false);
  });

  it("an HTTP failure names the feed used", async () => {
    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({ message: "forbidden" }) }));
    const provider = new AlpacaMarketDataProvider({ ...PAPER_ENV, ALPACA_STOCKS_FEED: "sip" } as Env);
    await expect(provider.getQuotes(["AAPL"])).rejects.toThrow(/Alpaca batch quotes HTTP 403 \(feed=sip\)/);
  });
});
