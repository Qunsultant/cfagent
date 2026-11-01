/**
 * Issue #2692 — HTTP quotes handler must refresh before serving.
 *
 * The handler used to fire `void refreshQuotesInBackground(...)` and
 * serve the isolate-local cache immediately, so on a cold cache it
 * always answered quotes: [] even when upstream Yahoo answers
 * normally. After the fix it awaits the refresh (refresh-then-serve,
 * mirroring pushTicks), so a cold cache + healthy upstream returns
 * quotes on the FIRST call, and a second call within TTL still does.
 * A failed upstream stays safe: the handler reports unavailable,
 * never a fabricated number.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleMarketQuotesHttp, liveMarketCache } from "../src/services/marketStream";

function yahooChartPayload() {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "TST",
            regularMarketPrice: 204.64,
            regularMarketPreviousClose: 213.66,
            chartPreviousClose: 213.66,
            regularMarketDayHigh: 210.0,
            regularMarketDayLow: 200.0,
            regularMarketOpen: 205.0,
            regularMarketVolume: 1000000,
            longName: "Test Inc.",
            currency: "USD",
          },
          indicators: { quote: [{ close: [200, 201, 202] }] },
        },
      ],
    },
  };
}

describe("HTTP quotes handler awaits refresh before serving (#2692)", () => {
  beforeEach(() => {
    liveMarketCache.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    liveMarketCache.clear();
  });

  it("cold cache + healthy Yahoo returns quotes on the FIRST call, not unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("yahoo")) {
          return { ok: true, json: async () => yahooChartPayload() } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const data = (await (await handleMarketQuotesHttp(["NVDA"])).json()) as any;
    expect(data.quotes.map((q: any) => q.symbol)).toEqual(["NVDA"]);
    expect(data.unavailable).toEqual([]);
    expect(data.dataUnavailable).toBe(false);
  });

  it("second call within TTL also returns quotes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        if (String(url).includes("yahoo")) {
          return { ok: true, json: async () => yahooChartPayload() } as any;
        }
        return { ok: false, json: async () => ({}) } as any;
      })
    );
    const first = (await (await handleMarketQuotesHttp(["AAPL"])).json()) as any;
    expect(first.quotes.map((q: any) => q.symbol)).toEqual(["AAPL"]);
    const second = (await (await handleMarketQuotesHttp(["AAPL"])).json()) as any;
    expect(second.quotes.map((q: any) => q.symbol)).toEqual(["AAPL"]);
    expect(second.unavailable).toEqual([]);
  });

  it("cold cache + failed upstream still reports unavailable, never a fabricated quote", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const data = (await (await handleMarketQuotesHttp(["ZZQFAIL"])).json()) as any;
    expect(data.quotes).toEqual([]);
    expect(data.unavailable).toEqual(["ZZQFAIL"]);
    expect(data.dataUnavailable).toBe(true);
  });
});
