/**
 * Issue #1643 (parent #1638, doc §7) — MarketDataService facade over
 * quote routes/providers, with #913 live-source provenance rules:
 * live failure is explicit, never a fabricated fallback; cached
 * quotes are never presented as live.
 *
 * Gap pinned here: `getBatchMarketQuotes` serves cached ticks
 * WITHOUT checking `expiresAt`, and `handleMarketQuotesHttp` stamps
 * the RESPONSE time as `timestamp` — so a long-stale tick could be
 * presented as a current quote. The facade resolves quotes with
 * explicit provenance instead: a fresh cache entry serves as
 * `cached` with its fetch time + age; an expired or missing entry
 * is `unavailable`, never stale-served.
 *
 * Scope notes (verified on main, recorded on #1643): /api/market/quotes
 * and /api/market-data/quotes are already aliases to one handler; no
 * /api/trading/etrade/quotes HTTP route exists (E*TRADE quotes live
 * in the platform service). The WS stream is deliberately untouched:
 * it publishes the last cached quote for stream continuity and its
 * ticks already carry fetch timestamps. TTLs are NOT changed (doc
 * 1-minute matches neither live regime: 20s Alpaca / 30s Yahoo in
 * marketStream, 5-min in quoteCache) — the facade documents per-path
 * TTLs instead of inventing one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  liveMarketCache,
  handleMarketQuotesHttp,
  type MarketTickData,
} from "../src/services/marketStream";
import {
  resolveMarketDataQuotes,
  type MarketCacheEntry,
} from "../src/services/marketDataService";

function tick(symbol: string, price: number, timestamp: number): MarketTickData {
  return {
    symbol,
    name: symbol,
    type: "stock",
    price,
    formattedPrice: `$${price.toFixed(2)}`,
    change: 0,
    formattedChange: "0.00%",
    changePercent: 0,
    bid: price - 0.01,
    ask: price + 0.01,
    formattedBid: `$${(price - 0.01).toFixed(2)}`,
    formattedAsk: `$${(price + 0.01).toFixed(2)}`,
    volume: "10.0M",
    isPositive: true,
    timestamp,
    source: "Yahoo Finance",
  };
}

beforeEach(() => {
  liveMarketCache.clear();
});

describe("MarketDataService facade (#1643 §7)", () => {
  it("a fresh cache entry serves as cached with fetch time + age, never live", () => {
    const now = Date.now();
    const entries = new Map<string, MarketCacheEntry>([
      ["NVDA", { tick: tick("NVDA", 200, now - 5000), expiresAt: now + 60000 }],
    ]);
    const out = resolveMarketDataQuotes(["NVDA"], (s) => entries.get(s), now);
    expect(out.unavailable).toEqual([]);
    expect(out.quotes).toHaveLength(1);
    expect(out.quotes[0].provenance).toBe("cached");
    expect(out.quotes[0].fetchedAtMs).toBe(now - 5000);
    expect(out.quotes[0].ageMs).toBe(5000);
    expect(out.quotes[0].symbol).toBe("NVDA");
  });

  it("an expired entry is unavailable, never stale-served", () => {
    const now = Date.now();
    const entries = new Map<string, MarketCacheEntry>([
      ["NVDA", { tick: tick("NVDA", 200, now - 3600000), expiresAt: now - 1000 }],
    ]);
    const out = resolveMarketDataQuotes(["NVDA"], (s) => entries.get(s), now);
    expect(out.quotes).toEqual([]);
    expect(out.unavailable).toEqual(["NVDA"]);
  });

  it("a missing entry is unavailable with no fabricated price", () => {
    const out = resolveMarketDataQuotes(["AAPL"], () => undefined, Date.now());
    expect(out.quotes).toEqual([]);
    expect(out.unavailable).toEqual(["AAPL"]);
  });

  it("symbols normalize (case/whitespace) and empties drop out", () => {
    const now = Date.now();
    const entries = new Map<string, MarketCacheEntry>([
      ["NVDA", { tick: tick("NVDA", 200, now), expiresAt: now + 60000 }],
    ]);
    const out = resolveMarketDataQuotes(["  nvda ", "", "  "], (s) => entries.get(s), now);
    expect(out.quotes.map((q) => q.symbol)).toEqual(["NVDA"]);
    expect(out.unavailable).toEqual([]);
  });
});

describe("HTTP handler through the facade (#1643 §7)", () => {
  it("an expired cached tick is unavailable on HTTP, not served as current", async () => {
    // #2692: the handler now awaits its upstream refresh before
    // serving, so stub the fetch — otherwise a live Yahoo answer
    // would overwrite the seeded expired tick mid-test.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const now = Date.now();
    liveMarketCache.set("NVDA", {
      tick: tick("NVDA", 200, now - 3600000),
      expiresAt: now - 1000,
    });
    const data = (await (await handleMarketQuotesHttp(["NVDA"])).json()) as any;
    expect(data.quotes).toEqual([]);
    expect(data.unavailable).toEqual(["NVDA"]);
    expect(data.dataUnavailable).toBe(true);
  });

  it("a fresh cached tick carries provenance + age + fetch time on HTTP", async () => {
    // #2692: same fetch stub as above — a live answer would replace
    // the seeded tick and break the provenance/age assertions.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const now = Date.now();
    liveMarketCache.set("NVDA", {
      tick: tick("NVDA", 200, now - 5000),
      expiresAt: now + 60000,
    });
    const data = (await (await handleMarketQuotesHttp(["NVDA"])).json()) as any;
    expect(data.quotes).toHaveLength(1);
    expect(data.quotes[0].provenance).toBe("cached");
    expect(data.quotes[0].fetchedAtMs).toBe(now - 5000);
    expect(data.quotes[0].ageMs).toBeGreaterThanOrEqual(5000);
    expect(data.unavailable).toEqual([]);
  });
});
