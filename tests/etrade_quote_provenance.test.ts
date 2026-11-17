/**
 * Issue #118 (audit F12/F13): E*TRADE quote fallback provenance.
 *
 * When the live REST quote call fails, the platform/service fall back to
 * static data (curated universe table / cached screener universe). Those
 * fallbacks must never be stamped REALTIME / "E*TRADE Live Market Feed",
 * must not invent bid/ask/volume, and every surface priced or narrated from
 * them (order previews, NLQ chat/voice answers) must disclose the non-live
 * pricing basis. The genuine live path stays byte-identical.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, formatTradingQuoteHeadline } from "../src/agents/nlq";
import type { Env, ETradeQuote } from "../src/types";

const liveEnv: Env = {
  APP_BASE_URL: "https://agent.openaimp.com",
  ETRADE_ENVIRONMENT: "live",
  // Issue #5147: this suite pins the E*TRADE quote path, so the selection is
  // explicit — the no-selection default is the platform default (Alpaca).
  TENANT_BROKER_ID: "etrade",
} as Env;

const sandboxEnv: Env = {
  APP_BASE_URL: "https://agent.openaimp.com",
  ETRADE_ENVIRONMENT: "sandbox",
  TENANT_BROKER_ID: "etrade",
} as Env;

// JPM is in the curated universe (defaultPrice 222) but NOT in the screener
// test fixture, so it exercises the curated-table fallback deterministically.
const CURATED_ONLY = "JPM";
const FIXTURE_SYMBOL = "NVDA";

const nullClient = { fetchQuote: async () => null } as any;

function liveQuote(symbol: string): ETradeQuote {
  return {
    symbol,
    companyName: "Live Corp",
    lastPrice: 500.25,
    price: 500.25,
    change: 5.25,
    changePercent: 1.06,
    bid: 500.2,
    ask: 500.3,
    volume: 1234567,
    open: 495,
    high: 502,
    low: 494,
    week52High: 550,
    week52Low: 400,
    quoteStatus: "REALTIME",
    source: "E*TRADE REST API [PROD / Live]",
    timestamp: new Date().toISOString(),
  };
}

describe("Issue #118 — E*TRADE quote fallback provenance", () => {
  let orm: DatabaseORM;
  const sessionId = "quote_provenance_session";

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  afterEach(() => {
    DynamicMarketScreener.setTestUniverseFixture([]);
  });

  describe("platform getQuote (F12)", () => {
    // #922 ([#913 S4]): in the LIVE env a curated-table hit is NO LONGER
    // served as a STATIC_FALLBACK quote — the sync/async quote path fails
    // explicit instead, so no curated static price (222) is ever served.
    // Non-live behaviour is unchanged (see the TEST-env pin below).
    it("LIVE env + failed REST + curated symbol → fails explicit, no curated static price served (#922)", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      await expect(platform.getQuote(CURATED_ONLY)).rejects.toThrow(/live quote unavailable/i);
    });

    it("LIVE env + failed REST + cached universe symbol → never upgraded to REALTIME", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      const q = await platform.getQuote(FIXTURE_SYMBOL);
      expect(q.quoteStatus).not.toBe("REALTIME");
      expect(q.quoteStatus).toBe("STATIC_FALLBACK");
      expect(q.source).not.toBe("E*TRADE Live Market Feed");
    });

    it("LIVE env + successful REST → live quote returned unchanged", async () => {
      const live = liveQuote("ACME");
      const stubClient = { fetchQuote: async () => live } as any;
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, stubClient);
      const q = await platform.getQuote("ACME");
      expect(q).toBe(live);
      expect(q.quoteStatus).toBe("REALTIME");
      expect(q.source).toBe("E*TRADE REST API [PROD / Live]");
      expect(q.bid).toBe(500.2);
      expect(q.ask).toBe(500.3);
      expect(q.volume).toBe(1234567);
    });

    it("TEST env + curated symbol → SIMULATED_LEVEL1 stamps kept, invented fields removed", async () => {
      const platform = new ETradeTradingPlatform(sandboxEnv, undefined, "tester", undefined, nullClient);
      const q = await platform.getQuote(CURATED_ONLY);
      expect(q.quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(q.source).toBe("E*TRADE Market Universe Feed");
      expect(q.bid).toBe(0);
      expect(q.ask).toBe(0);
      expect(q.volume).toBe(0);
    });

    it("unknown symbol → throws auth error (issue #294)", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      await expect(platform.getQuote("ZZZZNOTREAL")).rejects.toThrow(/auth required/i);
    });
  });

  describe("service getQuote twin (F12)", () => {
    // #922 ([#913 S4]): the sync service path likewise fails explicit in
    // the LIVE env for a curated-only symbol — no STATIC_FALLBACK quote,
    // no curated static price (222), no fresh timestamp over static data.
    it("LIVE env curated symbol → throws live-quote-unavailable, no curated static price served (#922)", () => {
      const service = new ETradeService(orm, liveEnv, "test-user");
      expect(() => service.getQuote(CURATED_ONLY)).toThrow(/live quote unavailable/i);
    });

    it("LIVE env cached universe symbol → STATIC_FALLBACK, not a live-feed label", () => {
      const service = new ETradeService(orm, liveEnv, "test-user");
      const q = service.getQuote(FIXTURE_SYMBOL);
      expect(q.quoteStatus).toBe("STATIC_FALLBACK");
      expect(q.source).not.toBe("E*TRADE Market Data Feed");
    });

    it("TEST env curated symbol → SIMULATED_LEVEL1 kept (sandbox behaviour unchanged)", () => {
      const service = new ETradeService(orm, sandboxEnv, "test-user");
      const q = service.getQuote(CURATED_ONLY);
      expect(q.quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(q.source).toBe("E*TRADE Market Data Feed");
      expect(q.bid).toBe(0);
      expect(q.volume).toBe(0);
    });

    it("getQuoteAsync returns a genuine live quote unchanged", async () => {
      const service = new ETradeService(orm, liveEnv, "test-user");
      const live = liveQuote("ACME");
      // Issue #462: fetchQuoteRemote calls fetchQuoteDetailed (per-call
      // error capture) — mock the detailed seam, not the shared wrapper.
      (service.client as any).fetchQuoteDetailed = async () => ({ quote: live, error: null });
      const q = await service.getQuoteAsync("ACME");
      expect(q).toBe(live);
      expect(q.quoteStatus).toBe("REALTIME");
    });
  });

  describe("order previews priced from fallback quotes (F12)", () => {
    // #922 ([#913 S4]): a preview priced from a curated static quote no
    // longer exists in the LIVE env — preview fails explicit at the quote
    // step, so no draft is ever priced off the curated static price.
    it("platform previewOrder (LIVE, curated symbol) fails explicit instead of drafting off a static price (#922)", async () => {
      const platform = new ETradeTradingPlatform(liveEnv, undefined, "tester", undefined, nullClient);
      await expect(platform.previewOrder({
        sessionId,
        symbol: CURATED_ONLY,
        orderAction: "BUY",
        quantity: 10,
        orderType: "MARKET",
      })).rejects.toThrow(/live quote unavailable/i);
    });

    it("service previewOrder (LIVE, curated symbol) fails explicit instead of drafting off a static price (#922)", () => {
      const service = new ETradeService(orm, liveEnv, "test-user");
      expect(() => service.previewOrder({
        sessionId,
        symbol: CURATED_ONLY,
        orderAction: "BUY",
        quantity: 10,
        orderType: "MARKET",
      })).toThrow(/live quote unavailable/i);
    });

    it("service previewOrder (sandbox, simulated quote) records status without the non-live alarm", () => {
      const service = new ETradeService(orm, sandboxEnv, "test-user");
      const draft = service.previewOrder({
        sessionId,
        symbol: FIXTURE_SYMBOL,
        orderAction: "BUY",
        quantity: 10,
        orderType: "MARKET",
      });
      expect(draft.pricingQuoteStatus).toBe("SIMULATED_LEVEL1");
      expect(draft.previewMessage).not.toContain("NON-LIVE QUOTE");
    });
  });

  describe("NLQ quote + preview surfaces (F13)", () => {
    it("headline claims 'Real-time' only for a REALTIME quote", () => {
      expect(formatTradingQuoteHeadline(liveQuote("ACME"))).toContain("Real-time quote for ACME");
      const fallback = { ...liveQuote(CURATED_ONLY), quoteStatus: "STATIC_FALLBACK", bid: 0, ask: 0 };
      const headline = formatTradingQuoteHeadline(fallback);
      expect(headline).not.toContain("Real-time");
      expect(headline).toContain("Static fallback quote");
      expect(headline).toContain("not live market data");
      const simulated = { ...liveQuote(CURATED_ONLY), quoteStatus: "SIMULATED_LEVEL1" };
      expect(formatTradingQuoteHeadline(simulated)).toContain("Simulated quote");
      const delayed = { ...liveQuote("ACME"), quoteStatus: "DELAYED" };
      expect(formatTradingQuoteHeadline(delayed)).toContain("Delayed quote");
      expect(formatTradingQuoteHeadline(delayed)).not.toContain("Real-time quote");
    });

    it("sync quote action: rows carry quoteStatus and the summary never claims real-time for fallback data", async () => {
      const plan = await planNLQ(sandboxEnv, `quote ${CURATED_ONLY}`);
      expect(plan.tradingData?.action).toBe("quote");
      const result = executeNLQQuery(orm, sessionId, plan, sandboxEnv);
      expect(result.rows[0].quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(result.summary).not.toContain("Real-time quote");
      expect(result.summary).toContain("Simulated quote");
      expect(result.rows[0].bidAsk).toBe("N/A (no live bid/ask)");
    });

    it("async quote action: rows carry quoteStatus and the summary never claims real-time for fallback data", async () => {
      const plan = await planNLQ(sandboxEnv, `quote ${CURATED_ONLY}`);
      const result = await executeNLQQueryAsync(orm, sessionId, plan, sandboxEnv, "test-user");
      expect(result.rows[0].quoteStatus).toBe("SIMULATED_LEVEL1");
      expect(result.summary).not.toContain("Real-time quote");
      expect(result.summary).toContain("Simulated quote");
    });

    // #922 ([#913 S4]): the sync NLQ preview path now fails explicit at
    // the quote step for a curated-only symbol in the LIVE env — no draft
    // row is produced at all, instead of a STATIC_FALLBACK-priced draft.
    it("sync preview_order in LIVE env fails explicit for a curated-only symbol, producing no draft (#922)", async () => {
      const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY}`);
      expect(plan.tradingData?.action).toBe("preview_order");
      expect(() => executeNLQQuery(orm, sessionId, plan, liveEnv)).toThrow(/live quote unavailable/i);
    });

    it("async preview_order in LIVE env propagates quote failures instead of substituting fallback data", async () => {
      const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY}`);
      const quoteFailure = vi.spyOn(ETradeService.prototype, "fetchQuoteRemote")
        .mockRejectedValue(new Error("fixture: live quote unavailable"));
      try {
        await expect(executeNLQQueryAsync(orm, sessionId, plan, liveEnv, "test-user"))
          .rejects.toThrow("fixture: live quote unavailable");
      } finally {
        quoteFailure.mockRestore();
      }
    });
  });
});

describe("ETradeService.fetchQuotesRemote — batch acquisition (#495)", () => {
  it("normalises and delegates a live batch to the client in one call", async () => {
    const service = new ETradeService(liveEnv, undefined, "test-user");
    const fetchQuotes = vi.fn(async (symbols: string[]) =>
      symbols.map((symbol) => liveQuote(symbol))
    );
    service.client = { getEnvConfig: () => ({ isLive: true }), fetchQuotes } as any;

    const quotes = await service.fetchQuotesRemote(["aapl", "NVDA", "AAPL"]);

    // One request for the whole set: duplicates dropped, symbols uppercased.
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(fetchQuotes).toHaveBeenCalledWith(["AAPL", "NVDA"]);
    expect(quotes.map((q) => q.symbol)).toEqual(["AAPL", "NVDA"]);
  });

  it("does not pretend a sandbox batch quoted anything", async () => {
    const service = new ETradeService(sandboxEnv, undefined, "test-user");
    const fetchQuotes = vi.fn();
    service.client = { getEnvConfig: () => ({ isLive: false }), fetchQuotes } as any;

    await expect(service.fetchQuotesRemote(["NVDA"])).resolves.toEqual([]);
    expect(fetchQuotes).not.toHaveBeenCalled();
  });
});
