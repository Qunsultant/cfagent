/**
 * Issue #2108 (slice C) — the quote source setting.
 *
 * The feed's provider selection is a deployment-wide setting (the WS +
 * HTTP surfaces share one Worker-level liveMarketCache, so a per-user
 * pick is architecturally blocked). Tests pin: the setting normalizes
 * safely, persists through a D1-shaped store, gates fetchRealMarketQuote
 * per provider, and is honored by the background refresh.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  fetchRealMarketQuote,
  refreshQuotesInBackground,
  liveMarketCache,
} from "../src/services/marketStream";
import {
  normalizeQuoteSource,
  getQuoteSource,
  setQuoteSource,
} from "../src/services/quoteSourceSetting";
import { createD1QuoteSourceDb } from "../src/data/d1QuoteSourceAdapter";
import { MockD1Database } from "./mock-d1";

/**
 * #4282 P6a (#4384): the quote-source adapter now runs through the
 * Drizzle builder, so the old prepare/bind/first/run stub (which
 * also read the source from bound-param position 0 — the new
 * builder upsert binds (id, source, updatedAt)) cannot stand in
 * for a D1Database. These tests use the shared MockD1Database
 * (real node:sqlite) via createD1QuoteSourceDb instead.
 */
function mockFetch(handler: (url: string) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return handler(url);
    }),
  );
  return calls;
}

function yahooPayload(price: number, prevClose: number) {
  return {
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: price,
              regularMarketPreviousClose: prevClose,
              chartPreviousClose: prevClose,
              longName: "Test Co",
              regularMarketVolume: 1000,
            },
          },
        ],
      },
    }),
  };
}

describe("quote source setting (#2108)", () => {
  beforeEach(() => {
    liveMarketCache.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes unknown values to auto", () => {
    expect(normalizeQuoteSource("alpaca")).toBe("alpaca");
    expect(normalizeQuoteSource("yahoo")).toBe("yahoo");
    expect(normalizeQuoteSource("auto")).toBe("auto");
    expect(normalizeQuoteSource("ALPACA")).toBe("auto");
    expect(normalizeQuoteSource(undefined)).toBe("auto");
    expect(normalizeQuoteSource(42)).toBe("auto");
  });

  it("persists and reads back through a D1-shaped store", async () => {
    const db = new MockD1Database();
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("auto");
    await setQuoteSource(createD1QuoteSourceDb(db as never), "yahoo");
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("yahoo");
    await setQuoteSource(createD1QuoteSourceDb(db as never), "alpaca");
    expect(await getQuoteSource(createD1QuoteSourceDb(db as never))).toBe("alpaca");
  });

  it("returns auto without a store", async () => {
    expect(await getQuoteSource(undefined)).toBe("auto");
    expect(await getQuoteSource(null as never)).toBe("auto");
  });

  it("yahoo provider skips Alpaca entirely", async () => {
    const calls = mockFetch((url) => {
      if (url.startsWith("https://query1.finance.yahoo.com/")) return yahooPayload(50, 48);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const tick = await fetchRealMarketQuote("YHOO1", {} as never, { provider: "yahoo" });
    expect(tick?.source).toBe("Yahoo Finance");
    expect(tick?.price).toBe(50);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("query1.finance.yahoo.com");
  });

  it("yahoo provider ignores a cached Alpaca tick from the old source", async () => {
    liveMarketCache.set("YHOO2", {
      tick: {
        symbol: "YHOO2",
        name: "YHOO2",
        type: "stock",
        price: 100,
        formattedPrice: "$100.00",
        change: 0,
        formattedChange: "+0.00%",
        changePercent: 0,
        bid: 100,
        ask: 100,
        formattedBid: "$100.00",
        formattedAsk: "$100.00",
        volume: "—",
        isPositive: true,
        timestamp: Date.now(),
        source: "Alpaca",
      },
      expiresAt: Date.now() + 20000,
    });
    const calls = mockFetch((url) => {
      if (url.startsWith("https://query1.finance.yahoo.com/")) return yahooPayload(55, 50);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const tick = await fetchRealMarketQuote("YHOO2", {} as never, { provider: "yahoo" });
    expect(tick?.source).toBe("Yahoo Finance");
    expect(tick?.price).toBe(55);
    expect(calls).toHaveLength(1);
  });

  it("alpaca provider with no keys returns null and never touches Yahoo", async () => {
    const calls = mockFetch(() => {
      throw new Error("no fetch expected");
    });
    const tick = await fetchRealMarketQuote("ALP0", {} as never, { provider: "alpaca" });
    expect(tick).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("alpaca provider on Alpaca failure returns null without Yahoo substitution", async () => {
    const calls = mockFetch((url) => {
      if (url.startsWith("https://data.alpaca.markets/")) return { ok: false, json: async () => ({}) };
      throw new Error(`unexpected fetch: ${url}`);
    });
    const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" };
    const tick = await fetchRealMarketQuote("ALP1", env as never, { provider: "alpaca" });
    expect(tick).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("alpaca.markets");
  });

  it("auto provider keeps the legacy Alpaca-first behavior", async () => {
    liveMarketCache.set("AUTO1", {
      tick: {
        symbol: "AUTO1",
        name: "AUTO1",
        type: "stock",
        price: 100,
        formattedPrice: "$100.00",
        change: 0,
        formattedChange: "+0.00%",
        changePercent: 0,
        bid: 100,
        ask: 100,
        formattedBid: "$100.00",
        formattedAsk: "$100.00",
        volume: "—",
        isPositive: true,
        timestamp: Date.now(),
        source: "Alpaca",
      },
      expiresAt: 0,
    });
    const calls = mockFetch((url) => {
      if (url.startsWith("https://data.alpaca.markets/")) {
        return { ok: true, json: async () => ({ quote: { bp: 102, ap: 102 } }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" };
    const tick = await fetchRealMarketQuote("AUTO1", env as never);
    expect(tick?.source).toBe("Alpaca");
    expect(tick?.price).toBe(102);
    expect(calls).toHaveLength(1);
  });

  it("background refresh honors a stored yahoo setting", async () => {
    const db = new MockD1Database();
    await setQuoteSource(createD1QuoteSourceDb(db as never), "yahoo");
    const calls = mockFetch((url) => {
      if (url.startsWith("https://query1.finance.yahoo.com/")) return yahooPayload(70, 68);
      throw new Error(`unexpected fetch: ${url}`);
    });
    await refreshQuotesInBackground(["REF1"], { AGENT_DB: db } as never);
    expect(liveMarketCache.get("REF1")?.tick.source).toBe("Yahoo Finance");
    expect(calls.every((u) => u.startsWith("https://query1.finance.yahoo.com/"))).toBe(true);
  });

  it("background refresh honors a stored alpaca setting without keys", async () => {
    const db = new MockD1Database();
    await setQuoteSource(createD1QuoteSourceDb(db as never), "alpaca");
    const calls = mockFetch(() => {
      throw new Error("no fetch expected");
    });
    await refreshQuotesInBackground(["REF2"], { AGENT_DB: db } as never);
    expect(liveMarketCache.get("REF2")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
