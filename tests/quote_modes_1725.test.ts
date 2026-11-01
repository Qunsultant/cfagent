/**
 * #1725 (parent #1717, slice (e)): market-data / quote unification.
 *
 * NEVER EITHER/OR, ALWAYS CONFIGURABLE: eight switches, each with
 * the calling surface's own legacy as the built-in default, both
 * code paths kept, no endpoint removed, no store merged, live-only
 * provenance preserved (a cache read is never labelled "live").
 *
 * TDD Red: this suite was written against the #1725 spec before the
 * call-site wiring landed — the switch-mode pins (WS provenance,
 * HTTP continuity, no-substitution fallback, hybrid either-key,
 * wire open, unset indicators, E*TRADE unknown-mode overrides)
 * fail on the unwired legacy tree, and the legacy pins pass
 * throughout. No failing test was deleted to go green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  QUOTE_EXPIRY_MODE_SWITCH,
  QUOTE_STREAM_PROVENANCE_SWITCH,
  QUOTE_HTTP_PROVIDER_MODE_SWITCH,
  QUOTE_ALPACA_KEY_MODE_SWITCH,
  QUOTE_FALLBACK_MODE_SWITCH,
  QUOTE_ETRADE_UNKNOWN_MODE_SWITCH,
  QUOTE_YAHOO_OPEN_MODE_SWITCH,
  QUOTE_YAHOO_INDICATORS_MODE_SWITCH,
  isAlpacaConfigured,
  levelsForQuoteSwitch,
  quotesConfigErrorEvent,
  resolveQuoteAlpacaKeyMode,
  resolveQuoteEtradeUnknownMode,
  resolveQuoteExpiryMode,
  resolveQuoteFallbackMode,
  resolveQuoteHttpProviderMode,
  resolveQuoteStreamProvenance,
  resolveQuoteYahooIndicatorsMode,
  resolveQuoteYahooOpenMode,
} from "../src/config/quoteModes";
import {
  annotateStreamTicks,
  fetchRealMarketQuote,
  getBatchMarketQuotes,
  handleMarketQuotesHttp,
  handleMarketQuotesWebSocket,
  liveMarketCache,
  type MarketTickData,
} from "../src/services/marketStream";
import { resolveMarketDataQuotes } from "../src/services/marketDataService";
import {
  __resetQuoteCache,
  getCachedQuoteWithAge,
  setCachedQuote,
} from "../src/services/quoteCache";
import {
  AlpacaMarketDataProvider,
  MarketDataResearchService,
  HybridMarketDataProvider,
  YahooFinanceProvider,
} from "../src/services/marketDataResearch";
import { ETradeService } from "../src/services/etrade";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { fetchQuoteLiveStrict, isStubQuote } from "../src/trading/quotePolicies";
import { mapPublicQuoteRow } from "../src/services/publicData";
import {
  createAlpacaDataProvider,
  createYahooDataProvider,
} from "../src/trading/dataProviders/adapters";
import {
  DataProviderNotFoundError,
  DataProviderRegistry,
} from "../src/trading/dataProviders/registry";
import type { Env } from "../src/types";

// --- Mock WebSocket (same shape as tests/market_stream.test.ts) ---
class MockDuplexWebSocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  sent: string[] = [];
  addEventListener(event: string, cb: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    for (const cb of this.listeners["close"] || []) cb({});
  }
  async emitClientMessage(data: any) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const cb of this.listeners["message"] || []) await cb({ data: payload });
  }
  getParsedMessages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function makeTick(symbol: string, price: number, timestamp: number, source: "Alpaca" | "Yahoo Finance" = "Yahoo Finance"): MarketTickData {
  return {
    symbol,
    name: symbol,
    type: "stock",
    price,
    formattedPrice: `$${price.toFixed(2)}`,
    change: 0,
    formattedChange: "+0.00%",
    changePercent: 0,
    bid: price - 0.01,
    ask: price + 0.01,
    formattedBid: `$${(price - 0.01).toFixed(2)}`,
    formattedAsk: `$${(price + 0.01).toFixed(2)}`,
    volume: "15.4M",
    isPositive: true,
    timestamp,
    source,
  };
}

function yahooChartPayload(overrides: Record<string, unknown> = {}) {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "TST",
            regularMarketPrice: 152,
            regularMarketPreviousClose: 150,
            chartPreviousClose: 150,
            regularMarketDayHigh: 170,
            regularMarketDayLow: 130,
            regularMarketOpen: 155,
            regularMarketVolume: 1000000,
            longName: "Test Inc.",
            currency: "USD",
            ...overrides,
          },
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  liveMarketCache.clear();
  __resetQuoteCache();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  liveMarketCache.clear();
  __resetQuoteCache();
});

describe("quote switch resolvers (run > session > user > env > builtin)", () => {
  it("exposes the eight switch names and the audit event name", () => {
    expect(QUOTE_EXPIRY_MODE_SWITCH).toBe("QUOTE_EXPIRY_MODE");
    expect(QUOTE_STREAM_PROVENANCE_SWITCH).toBe("QUOTE_STREAM_PROVENANCE");
    expect(QUOTE_HTTP_PROVIDER_MODE_SWITCH).toBe("QUOTE_HTTP_PROVIDER_MODE");
    expect(QUOTE_ALPACA_KEY_MODE_SWITCH).toBe("QUOTE_ALPACA_KEY_MODE");
    expect(QUOTE_FALLBACK_MODE_SWITCH).toBe("QUOTE_FALLBACK_MODE");
    expect(QUOTE_ETRADE_UNKNOWN_MODE_SWITCH).toBe("QUOTE_ETRADE_UNKNOWN_MODE");
    expect(QUOTE_YAHOO_OPEN_MODE_SWITCH).toBe("QUOTE_YAHOO_OPEN_MODE");
    expect(QUOTE_YAHOO_INDICATORS_MODE_SWITCH).toBe("QUOTE_YAHOO_INDICATORS_MODE");
    expect(quotesConfigErrorEvent()).toBe("quotes.config_error");
  });

  it("resolves in run > session > user > env > builtin order", () => {
    const r = resolveQuoteExpiryMode(
      { run: "continuity", session: "honour", user: "honour", env: "honour" },
      "honour"
    );
    expect(r.mode).toBe("continuity");
    expect(r.level).toBe("run");
    expect(resolveQuoteExpiryMode({ session: "continuity", user: "honour", env: "honour" }, "honour").level).toBe("session");
    expect(resolveQuoteExpiryMode({ user: "continuity", env: "honour" }, "honour").level).toBe("user");
    expect(resolveQuoteExpiryMode({ env: "continuity" }, "honour").level).toBe("env");
    expect(resolveQuoteExpiryMode({}, "honour")).toEqual(
      expect.objectContaining({ mode: "honour", level: "builtin", invalid: false })
    );
  });

  it("normalizes case/whitespace and falls through blanks", () => {
    expect(resolveQuoteFallbackMode({ run: "  No-Substitution " }, "fallthrough").mode).toBe("no-substitution");
    expect(resolveQuoteHttpProviderMode({ run: "   ", env: "ENV" }, "yahoo-only").mode).toBe("env");
    expect(resolveQuoteYahooOpenMode({ run: undefined, env: undefined }, "midpoint").mode).toBe("midpoint");
  });

  it("fails closed to the surface legacy with NO fall-through on an invalid winner", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resolveQuoteExpiryMode({ run: "bogus", env: "continuity" }, "honour");
    expect(r.mode).toBe("honour");
    expect(r.invalid).toBe(true);
    expect(r.raw).toBe("bogus");
    expect(r.level).toBe("run");
    expect(warn).toHaveBeenCalled();
    const nonString = resolveQuoteEtradeUnknownMode({ run: 42 as any }, "throw");
    expect(nonString.mode).toBe("throw");
    expect(nonString.invalid).toBe(true);
  });

  it("levelsForQuoteSwitch wires scoped carriers in order", () => {
    const levels = levelsForQuoteSwitch({ session: "continuity", user: "honour" }, undefined, undefined);
    expect(resolveQuoteExpiryMode(levels, "honour").mode).toBe("continuity");
    expect(resolveQuoteExpiryMode(levels, "honour").level).toBe("session");
    const userLevels = levelsForQuoteSwitch({ user: "continuity" }, undefined, undefined);
    expect(resolveQuoteExpiryMode(userLevels, "honour").level).toBe("user");
  });

  it("each switch accepts only its own pair", () => {
    expect(resolveQuoteStreamProvenance({ run: "provenance" }, "bare").mode).toBe("provenance");
    expect(resolveQuoteStreamProvenance({ run: "continuity" }, "bare").invalid).toBe(true);
    expect(resolveQuoteAlpacaKeyMode({ run: "id-only" }, "either").mode).toBe("id-only");
    expect(resolveQuoteYahooIndicatorsMode({ run: "unset" }, "computed").mode).toBe("unset");
    expect(resolveQuoteYahooIndicatorsMode({ run: "computed" }, "unset").mode).toBe("computed");
  });
});

describe("M6 unified Alpaca-configured rule", () => {
  const nonId = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as unknown as Env;
  const idOnly = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
  const mixed = { ALPACA_API_KEY_ID: "k", ALPACA_SECRET_KEY: "s" } as unknown as Env;

  it("either-spelling accepts both spellings, id-only accepts only _ID/_SECRET_KEY", () => {
    expect(isAlpacaConfigured(nonId, "either")).toBe(true);
    expect(isAlpacaConfigured(idOnly, "either")).toBe(true);
    expect(isAlpacaConfigured(nonId, "id-only")).toBe(false);
    expect(isAlpacaConfigured(idOnly, "id-only")).toBe(true);
    expect(isAlpacaConfigured(mixed, "id-only")).toBe(false);
    expect(isAlpacaConfigured(mixed, "either")).toBe(true);
  });

  it("one-sided keys and undefined env are unconfigured in both modes", () => {
    expect(isAlpacaConfigured({ ALPACA_API_KEY: "k" } as unknown as Env, "either")).toBe(false);
    expect(isAlpacaConfigured(undefined, "either")).toBe(false);
    expect(isAlpacaConfigured(undefined, "id-only")).toBe(false);
  });
});

describe("M2 expiry: facade + batch + HTTP + WS", () => {
  it("facade honours expiry by default and serves expired entries under continuity", () => {
    const now = Date.now();
    const read = (s: string) =>
      s === "FRESH"
        ? { tick: makeTick("FRESH", 100, now - 1000), expiresAt: now + 30000 }
        : { tick: makeTick("STALE", 200, now - 60000), expiresAt: now - 1000 };
    const honoured = resolveMarketDataQuotes(["FRESH", "STALE"], read, now);
    expect(honoured.quotes.map((q) => q.symbol)).toEqual(["FRESH"]);
    expect(honoured.unavailable).toEqual(["STALE"]);
    const continued = resolveMarketDataQuotes(["FRESH", "STALE"], read, now, { expiry: "continuity" });
    expect(continued.quotes.map((q) => q.symbol)).toEqual(["FRESH", "STALE"]);
    expect(continued.unavailable).toEqual([]);
    // Provenance is "cached" in both modes — never "live".
    expect(continued.quotes.every((q) => q.provenance === "cached")).toBe(true);
    expect(continued.quotes.find((q) => q.symbol === "STALE")!.ageMs).toBeGreaterThan(0);
  });

  it("getBatch defaults to continuity and filters expired entries under honour", () => {
    const now = Date.now();
    liveMarketCache.set("FRESH", { tick: makeTick("FRESH", 100, now - 1000), expiresAt: now + 30000 });
    liveMarketCache.set("STALE", { tick: makeTick("STALE", 200, now - 60000), expiresAt: now - 1000 });
    expect(getBatchMarketQuotes(["FRESH", "STALE"]).map((t) => t.symbol)).toEqual(["FRESH", "STALE"]);
    expect(getBatchMarketQuotes(["FRESH", "STALE"], "honour").map((t) => t.symbol)).toEqual(["FRESH"]);
    expect(getBatchMarketQuotes(["MISSING"], "honour")).toEqual([]);
  });

  it("HTTP handler defaults to honour (expired → unavailable, 200 shape)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const now = Date.now();
    liveMarketCache.set("FRESH", { tick: makeTick("FRESH", 100, now - 1000), expiresAt: now + 30000 });
    liveMarketCache.set("STALE", { tick: makeTick("STALE", 200, now - 60000), expiresAt: now - 1000 });
    const res = await handleMarketQuotesHttp(["FRESH", "STALE"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.quotes.map((q: any) => q.symbol)).toEqual(["FRESH"]);
    expect(body.unavailable).toEqual(["STALE"]);
    expect(body.dataUnavailable).toBe(true);
    expect(body.quotes[0].provenance).toBe("cached");
    expect(typeof body.quotes[0].fetchedAtMs).toBe("number");
    expect(typeof body.quotes[0].ageMs).toBe("number");
    expect(typeof body.timestamp).toBe("number");
  });

  it("HTTP handler serves expired entries under continuity, with true age", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const now = Date.now();
    liveMarketCache.set("STALE", { tick: makeTick("STALE", 200, now - 60000), expiresAt: now - 1000 });
    const res = await handleMarketQuotesHttp(["STALE"], undefined, { expiryMode: "continuity" });
    const body = (await res.json()) as any;
    expect(body.quotes.map((q: any) => q.symbol)).toEqual(["STALE"]);
    expect(body.unavailable).toEqual([]);
    expect(body.dataUnavailable).toBe(false);
    expect(body.quotes[0].provenance).toBe("cached");
    expect(body.quotes[0].ageMs).toBeGreaterThanOrEqual(60000);
  });

  it("HTTP handler with no symbols at all stays 200 with unavailable[] empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const body = (await (await handleMarketQuotesHttp(["ZZQNONE"])).json()) as any;
    expect(body.quotes).toEqual([]);
    expect(body.unavailable).toEqual(["ZZQNONE"]);
    expect(body.dataUnavailable).toBe(true);
  });

  it("WS snapshot defaults to continuity + bare, honour filters, provenance annotates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const now = Date.now();
    liveMarketCache.set("FRESH", { tick: makeTick("FRESH", 100, now - 1000), expiresAt: now + 30000 });
    liveMarketCache.set("STALE", { tick: makeTick("STALE", 200, now - 60000), expiresAt: now - 1000 });

    const wsDefault = new MockDuplexWebSocket();
    await handleMarketQuotesWebSocket(wsDefault as any, undefined);
    await wsDefault.emitClientMessage({ type: "subscribe", symbols: ["FRESH", "STALE"] });
    const snapDefault = wsDefault.getParsedMessages().find((m) => m.type === "snapshot");
    expect(snapDefault.quotes.map((q: any) => q.symbol).sort()).toEqual(["FRESH", "STALE"]);
    expect(snapDefault.unavailable).toEqual([]);
    expect(snapDefault.quotes.every((q: any) => !("provenance" in q))).toBe(true);
    wsDefault.close();

    const wsHonour = new MockDuplexWebSocket();
    await handleMarketQuotesWebSocket(wsHonour as any, undefined, { expiryMode: "honour" });
    await wsHonour.emitClientMessage({ type: "subscribe", symbols: ["FRESH", "STALE"] });
    const snapHonour = wsHonour.getParsedMessages().find((m) => m.type === "snapshot");
    expect(snapHonour.quotes.map((q: any) => q.symbol)).toEqual(["FRESH"]);
    expect(snapHonour.unavailable).toEqual(["STALE"]);
    wsHonour.close();

    const wsProv = new MockDuplexWebSocket();
    await handleMarketQuotesWebSocket(wsProv as any, undefined, { streamProvenance: "provenance" });
    await wsProv.emitClientMessage({ type: "subscribe", symbols: ["FRESH"] });
    const snapProv = wsProv.getParsedMessages().find((m) => m.type === "snapshot");
    expect(snapProv.quotes[0].provenance).toBe("cached");
    expect(snapProv.quotes[0].fetchedAtMs).toBe(now - 1000);
    expect(snapProv.quotes[0].ageMs).toBeGreaterThanOrEqual(1000);
    expect(snapProv.quotes[0].provenance).not.toBe("live");
    wsProv.close();
  });

  it("annotateStreamTicks passes ticks through unchanged under bare", () => {
    const tick = makeTick("AAA", 10, 1000);
    expect(annotateStreamTicks([tick], "bare")).toEqual([tick]);
    const annotated = annotateStreamTicks([tick], "provenance", 5000);
    expect(annotated[0]).toMatchObject({ provenance: "cached", fetchedAtMs: 1000, ageMs: 4000 });
  });
});

describe("M2b runtime confirmation: HTTP env-drop", () => {
  it("handleMarketQuotesHttp with NO env issues no Alpaca request (Yahoo-only)", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        urls.push(String(url));
        if (String(url).includes("yahoo")) {
          return { ok: true, json: async () => yahooChartPayload() } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const res = await handleMarketQuotesHttp(["M2BNOENV"]);
    const body = (await res.json()) as any;
    // #2692: refresh-then-serve — the Yahoo answer now populates the
    // cache BEFORE the response, so the symbol is quoted on the first
    // call instead of unavailable (the old fire-and-forget behavior).
    expect(body.quotes.map((q: any) => q.symbol)).toEqual(["M2BNOENV"]);
    expect(body.unavailable).toEqual([]);
    await flush();
    await flush();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes("alpaca"))).toBe(true);
    expect(urls.some((u) => u.includes("yahoo"))).toBe(true);
  });

  it("handleMarketQuotesHttp WITH env can issue an Alpaca request", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        urls.push(String(url));
        if (String(url).includes("alpaca")) {
          return { ok: true, json: async () => ({ quote: { bp: 101, ap: 103 } }) } as any;
        }
        if (String(url).includes("yahoo")) {
          return { ok: true, json: async () => yahooChartPayload() } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
    await handleMarketQuotesHttp(["M2BWITHENV"], env);
    await flush();
    await flush();
    expect(urls.some((u) => u.includes("alpaca"))).toBe(true);
  });

  it("marketStream with only non-ID spellings uses Alpaca (either legacy)", async () => {
    const now = Date.now();
    // Expired previous tick: cache-hit misses, but the Alpaca leg still
    // reads it for change derivation (prevClose = 100 - 0).
    liveMarketCache.set("M2BEITH", {
      tick: makeTick("M2BEITH", 100, now - 60000, "Yahoo Finance"),
      expiresAt: now - 1000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("alpaca")) {
          return { ok: true, json: async () => ({ quote: { bp: 101, ap: 103 } }) } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as unknown as Env;
    const tick = await fetchRealMarketQuote("M2BEITH", env);
    expect(tick).not.toBeNull();
    expect(tick!.source).toBe("Alpaca");
    expect(tick!.price).toBe(102);
    expect(tick!.change).toBe(2);
  });
});

describe("M3/M9 fallback: marketStream fallthrough vs no-substitution", () => {
  it("fallthrough (default): Alpaca failure falls through to Yahoo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("alpaca")) return { ok: false, json: async () => ({}) } as any;
        if (String(url).includes("yahoo")) return { ok: true, json: async () => yahooChartPayload() } as any;
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
    const tick = await fetchRealMarketQuote("M3FALL", env);
    expect(tick).not.toBeNull();
    expect(tick!.source).toBe("Yahoo Finance");
  });

  it("no-substitution: Alpaca failure returns null and never fetches Yahoo", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        urls.push(String(url));
        if (String(url).includes("alpaca")) return { ok: false, json: async () => ({}) } as any;
        if (String(url).includes("yahoo")) return { ok: true, json: async () => yahooChartPayload() } as any;
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
    const tick = await fetchRealMarketQuote("M3NOSUB", env, { fallbackMode: "no-substitution" });
    expect(tick).toBeNull();
    expect(urls.some((u) => u.includes("yahoo"))).toBe(false);
  });

  it("no-substitution: no previous tick for change derivation returns null, not Yahoo", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        urls.push(String(url));
        if (String(url).includes("alpaca")) {
          return { ok: true, json: async () => ({ quote: { bp: 101, ap: 103 } }) } as any;
        }
        if (String(url).includes("yahoo")) return { ok: true, json: async () => yahooChartPayload() } as any;
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
    const tick = await fetchRealMarketQuote("M3NOPREV", env, { fallbackMode: "no-substitution" });
    expect(tick).toBeNull();
    expect(urls.some((u) => u.includes("yahoo"))).toBe(false);
  });

  it("no-substitution with Alpaca unconfigured still reads Yahoo (not a substitution)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("yahoo")) return { ok: true, json: async () => yahooChartPayload() } as any;
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const tick = await fetchRealMarketQuote("M3UNCFG", undefined, { fallbackMode: "no-substitution" });
    expect(tick).not.toBeNull();
    expect(tick!.source).toBe("Yahoo Finance");
  });

  it("invalid fallback value fails closed to fallthrough", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("alpaca")) return { ok: false, json: async () => ({}) } as any;
        if (String(url).includes("yahoo")) return { ok: true, json: async () => yahooChartPayload() } as any;
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
    const tick = await fetchRealMarketQuote("M3INVAL", env, { fallbackMode: "bogus" });
    expect(tick).not.toBeNull();
    expect(tick!.source).toBe("Yahoo Finance");
  });

  it("registry no-substitution is pinned: unservable primary throws, never substitutes", () => {
    const registry = new DataProviderRegistry();
    expect(() => registry.resolve("quote" as any, [])).toThrow(DataProviderNotFoundError);
  });
});

describe("M6 hybrid gate + M4/M5 Market-data provider contracts", () => {
  function routeFetch(alpacaOk: boolean) {
    return vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("alpaca")) {
        return alpacaOk
          ? { ok: true, json: async () => ({ quote: { bp: 101, ap: 103, bs: 10, as: 12, t: "2026-10-26T00:00:00Z" } }) } as any
          : ({ ok: false, json: async () => ({}) } as any);
      }
      if (u.includes("v8/finance/chart")) {
        return { ok: true, json: async () => yahooChartPayload() } as any;
      }
      return { ok: false, json: async () => ({}) } as any;
    });
  }

  it("hybrid default (id-only): non-ID spellings select Yahoo, not Alpaca", async () => {
    const fetchMock = routeFetch(true);
    vi.stubGlobal("fetch", fetchMock);
    const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as unknown as Env;
    const hybrid = new HybridMarketDataProvider(env);
    const quote = await hybrid.getQuote("M6HYB1");
    expect(quote.provider).toBe("hybrid");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("alpaca"))).toBe(false);
    expect(urls.some((u) => u.includes("yahoo"))).toBe(true);
  });

  it("hybrid under either: non-ID spellings select the Alpaca price leg", async () => {
    const fetchMock = routeFetch(true);
    vi.stubGlobal("fetch", fetchMock);
    const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as unknown as Env;
    const hybrid = new HybridMarketDataProvider(env);
    const quote = await hybrid.getQuote("M6HYB2", { alpacaKeyMode: "either" });
    expect(quote.provider).toBe("hybrid");
    expect(quote.price).toBe(102);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("alpaca"))).toBe(true);
  });

  it("hybrid invalid key mode fails closed to id-only (Yahoo leg)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = routeFetch(true);
    vi.stubGlobal("fetch", fetchMock);
    const env = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as unknown as Env;
    const hybrid = new HybridMarketDataProvider(env);
    const quote = await hybrid.getQuote("M6HYB3", { alpacaKeyMode: "bogus" });
    expect(quote.provider).toBe("hybrid");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("alpaca"))).toBe(false);
  });

  it("Alpaca contract pinned: change 0, volume 0, OHLC all = mid, no throw on success", async () => {
    vi.stubGlobal("fetch", routeFetch(true));
    const env = { ALPACA_API_KEY_ID: "k", ALPACA_API_SECRET_KEY: "s" } as unknown as Env;
    const provider = new AlpacaMarketDataProvider(env);
    const quote = await provider.getQuote("M5ALP");
    expect(quote.change).toBe(0);
    expect(quote.changePercent).toBe(0);
    expect(quote.volume).toBe(0);
    expect(quote.open).toBe(102);
    expect(quote.high).toBe(102);
    expect(quote.low).toBe(102);
    expect(quote.previousClose).toBe(102);
    expect(quote.companyName).toBe("M5ALP Asset");
  });

  it("Yahoo single default: midpoint open + computed indicators", async () => {
    vi.stubGlobal("fetch", routeFetch(false));
    const provider = new YahooFinanceProvider({} as unknown as Env);
    const quote = await provider.getQuote("M4DEF");
    // Midpoint (170+130)/2 = 150, NOT the wire open 155.
    expect(quote.open).toBe(150);
    expect(typeof quote.rsi14).toBe("number");
    expect(typeof quote.macdSignal).toBe("string");
    expect(quote.provenance).toBe("live");
    expect(quote.volume).toBe(1000000);
  });

  it("Yahoo single under wire: wire open when present", async () => {
    vi.stubGlobal("fetch", routeFetch(false));
    const provider = new YahooFinanceProvider({} as unknown as Env);
    const quote = await provider.getQuote("M4WIRE", { yahooOpenMode: "wire" });
    expect(quote.open).toBe(155);
  });

  it("Yahoo single under wire with no wire open falls back to midpoint (no invention)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        const u = String(url);
        if (u.includes("v8/finance/chart")) {
          const payload = yahooChartPayload({ regularMarketOpen: undefined });
          delete (payload.chart.result[0].meta as any).regularMarketOpen;
          return { ok: true, json: async () => payload } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const provider = new YahooFinanceProvider({} as unknown as Env);
    const quote = await provider.getQuote("M4WIRE2", { yahooOpenMode: "wire" });
    expect(quote.open).toBe(150);
  });

  it("Yahoo single under unset: indicators undefined, never zero-filled", async () => {
    vi.stubGlobal("fetch", routeFetch(false));
    const provider = new YahooFinanceProvider({} as unknown as Env);
    const quote = await provider.getQuote("M4UNSET", { yahooIndicatorsMode: "unset" });
    expect(quote.rsi14).toBeUndefined();
    expect(quote.macdSignal).toBeUndefined();
    expect(quote.price).toBe(152);
  });

  it("Yahoo single total failure throws explicit unavailable (live-only, M10 500-shape source)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const provider = new YahooFinanceProvider({} as unknown as Env);
    await expect(provider.getQuote("M4FAIL")).rejects.toThrow(/Market data quote unavailable for M4FAIL/);
  });

  it("Market-data service forwards switch opts to the provider", async () => {
    vi.stubGlobal("fetch", routeFetch(false));
    const service = new MarketDataResearchService({} as unknown as Env);
    const quote = await service.getQuote("M4SVC", "yfinance", { yahooOpenMode: "wire" });
    expect(quote.open).toBe(155);
  });
});

describe("M7 E*TRADE unknown-symbol tail + stub unification", () => {
  function stubPlatform(env: Env) {
    const client = { fetchQuote: async () => null, getLastError: () => undefined } as any;
    return new ETradeTradingPlatform(env, undefined, "tester", undefined, client);
  }

  it("platform default throws #294-style on unknown (fail-fast legacy)", async () => {
    const platform = stubPlatform({} as unknown as Env);
    await expect(platform.getQuote("ZZQUNKNOWN")).rejects.toThrow(/E\*TRADE auth required for ZZQUNKNOWN/);
  });

  it("platform under zero-object returns the AUTH_REQUIRED zero-price object", async () => {
    const platform = stubPlatform({} as unknown as Env);
    const quote = await platform.getQuote("ZZQUNKNOWN", { unknownMode: "zero-object" });
    expect(quote.lastPrice).toBe(0);
    expect(quote.price).toBe(0);
    expect(quote.quoteStatus).toBe("AUTH_REQUIRED");
  });

  it("platform env override zero-object works without method opts", async () => {
    const platform = stubPlatform({ QUOTE_ETRADE_UNKNOWN_MODE: "zero-object" } as unknown as Env);
    const quote = await platform.getQuote("ZZQUNKNOWN");
    expect(quote.quoteStatus).toBe("AUTH_REQUIRED");
    expect(quote.lastPrice).toBe(0);
  });

  it("platform invalid value fails closed to throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const platform = stubPlatform({ QUOTE_ETRADE_UNKNOWN_MODE: "bogus" } as unknown as Env);
    await expect(platform.getQuote("ZZQUNKNOWN")).rejects.toThrow(/E\*TRADE auth required/);
  });

  it("service sync default returns the zero-price AUTH_REQUIRED object", () => {
    const service = new ETradeService({} as any, undefined as any, "tester");
    const quote = service.getQuote("ZZQUNKNOWN");
    expect(quote.lastPrice).toBe(0);
    expect(quote.quoteStatus).toBe("AUTH_REQUIRED");
  });

  it("service sync under throw fails fast like the platform", () => {
    const service = new ETradeService({} as any, undefined as any, "tester");
    expect(() => service.getQuote("ZZQUNKNOWN", { unknownMode: "throw" })).toThrow(/E\*TRADE auth required/);
  });

  it("service sync env override throw works without method opts", () => {
    const service = new ETradeService(
      { QUOTE_ETRADE_UNKNOWN_MODE: "throw" } as any,
      undefined as any,
      "tester"
    );
    expect(() => service.getQuote("ZZQUNKNOWN")).toThrow(/E\*TRADE auth required/);
  });

  it("shared isStubQuote predicate pinned (577.51 / GOOGLE INC, GOOG/GOOGL exempt)", () => {
    const base = { symbol: "AAPL", companyName: "Apple Inc.", lastPrice: 100 } as any;
    expect(isStubQuote({ ...base, lastPrice: 577.51 }, "AAPL")).toBe(true);
    expect(isStubQuote({ ...base, lastPrice: 577.51 }, "GOOG")).toBe(false);
    expect(isStubQuote({ ...base, lastPrice: 577.51 }, "GOOGL")).toBe(false);
    expect(isStubQuote({ ...base, companyName: "GOOGLE INC" }, "MSFT")).toBe(true);
    expect(isStubQuote({ ...base, companyName: "GOOGLE INC" }, "GOOG")).toBe(false);
    expect(isStubQuote(base, "AAPL")).toBe(false);
  });

  it("fetchQuoteLiveStrict pinned: live + no good quote throws; non-live uses platform default", async () => {
    const stub = {
      platformId: "etrade",
      getQuoteDetailed: async () => ({ quote: null, error: "boom" }),
      getQuote: async () => ({ symbol: "ZZQ", lastPrice: 0, quoteStatus: "AUTH_REQUIRED" }),
    } as any;
    await expect(fetchQuoteLiveStrict(stub, "ZZQ", { isLive: true })).rejects.toThrow(/boom/);
    const fallback = await fetchQuoteLiveStrict(stub, "ZZQ", { isLive: false });
    expect((fallback as any).quoteStatus).toBe("AUTH_REQUIRED");
  });
});

describe("M8 caches stay separate, M9 adapter batch asymmetry, M11 Public partial", () => {
  it("a symbol can be fresh in quoteCache and stale/missing in liveMarketCache (and vice versa)", () => {
    const now = Date.now();
    const marketDataQuote = { symbol: "M8A", price: 111 } as any;
    setCachedQuote("yahoo:M8A", marketDataQuote);
    liveMarketCache.set("M8A", { tick: makeTick("M8A", 222, now - 60000), expiresAt: now - 1000 });
    // quoteCache read honours its own 5-min TTL: fresh.
    expect(getCachedQuoteWithAge("yahoo:M8A")?.value).toEqual(marketDataQuote);
    // Facade (honour) over liveMarketCache: the same symbol is unavailable.
    const resolved = resolveMarketDataQuotes(["M8A"], (s) => liveMarketCache.get(s), now);
    expect(resolved.unavailable).toEqual(["M8A"]);
    // Batch continuity over liveMarketCache still serves the stale tick.
    expect(getBatchMarketQuotes(["M8A"]).map((t) => t.price)).toEqual([222]);
  });

  it("adapter getQuotesBatch exists for Yahoo only, not Alpaca", () => {
    const yahoo = createYahooDataProvider(new YahooFinanceProvider({} as unknown as Env), {} as unknown as Env);
    const alpaca = createAlpacaDataProvider(new AlpacaMarketDataProvider({} as unknown as Env), {} as unknown as Env);
    expect("getQuotesBatch" in yahoo).toBe(true);
    expect("getQuotesBatch" in alpaca).toBe(false);
  });

  it("Public row mapping stays partial: absent fields omitted, never zero-filled, no quoteStatus", () => {
    const mapped = mapPublicQuoteRow({ symbol: "ZZQ", lastPrice: 123.45 }, "2026-10-26T00:00:00.000Z");
    expect(mapped).not.toBeNull();
    expect(mapped!.symbol).toBe("ZZQ");
    expect(mapped!.lastPrice).toBe(123.45);
    expect("bid" in mapped!).toBe(false);
    expect("ask" in mapped!).toBe(false);
    expect("volume" in mapped!).toBe(false);
    expect("open" in mapped!).toBe(false);
    expect("quoteStatus" in mapped!).toBe(false);
    expect("source" in mapped!).toBe(false);
  });
});
