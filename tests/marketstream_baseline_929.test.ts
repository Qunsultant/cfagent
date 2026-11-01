import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getBaselineMarketTick,
  getBatchMarketQuotes,
  handleMarketQuotesHttp,
  handleMarketQuotesWebSocket,
  liveMarketCache,
  type MarketTickData,
} from "../src/services/marketStream";

// Mock WebSocket implementation for unit testing (mirrors tests/market_stream.test.ts)
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

  async emitClientMessage(data: any) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const cb of this.listeners["message"] || []) {
      await cb({ data: payload });
    }
  }

  getParsedMessages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function liveTick(symbol: string, price: number): MarketTickData {
  return {
    symbol,
    name: symbol,
    type: "stock",
    price,
    formattedPrice: `$${price.toFixed(2)}`,
    change: 1.0,
    formattedChange: "+0.50%",
    changePercent: 0.5,
    bid: price - 0.01,
    ask: price + 0.01,
    formattedBid: `$${(price - 0.01).toFixed(2)}`,
    formattedAsk: `$${(price + 0.01).toFixed(2)}`,
    volume: "10.0M",
    isPositive: true,
    timestamp: Date.now(),
    source: "Yahoo Finance",
  };
}

describe("[#913 S11] marketStream baseline ticks (#929)", () => {
  beforeEach(() => {
    liveMarketCache.clear();
    // #2692: the HTTP handler now awaits its upstream refresh before
    // serving, so "uncached" must also mean "upstream fails" — stub
    // the fetch so these tests stay hermetic (no real Yahoo calls).
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getBaselineMarketTick returns null when no live tick is cached (no static profile tick)", () => {
    expect(getBaselineMarketTick("NVDA")).toBeNull();
    expect(getBaselineMarketTick("AAPL")).toBeNull();
  });

  it("getBaselineMarketTick returns null for an unknown symbol (no deterministic hash fallback)", () => {
    expect(getBaselineMarketTick("ZZZZUNKNOWN")).toBeNull();
  });

  it("getBaselineMarketTick returns the cached live tick when one is present", () => {
    const tick = liveTick("NVDA", 200.0);
    liveMarketCache.set("NVDA", { tick, expiresAt: Date.now() + 60000 });
    expect(getBaselineMarketTick("NVDA")).toEqual(tick);
  });

  it("getBatchMarketQuotes emits only live-cached ticks, never static ticks", () => {
    liveMarketCache.set("NVDA", {
      tick: liveTick("NVDA", 200.0),
      expiresAt: Date.now() + 60000,
    });
    const batch = getBatchMarketQuotes(["NVDA", "AAPL", "BTC/USD"]);
    expect(batch.map((b) => b.symbol)).toEqual(["NVDA"]);
    expect(batch.every((b) => b.source !== "Reference")).toBe(true);
  });

  it("handleMarketQuotesHttp reports uncached symbols as unavailable with no substitute numbers", async () => {
    const res = await handleMarketQuotesHttp(["NVDA", "SOL/USD"]);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.quotes).toEqual([]);
    expect(data.unavailable).toEqual(["NVDA", "SOL/USD"]);
    expect(data.dataUnavailable).toBe(true);
    expect(JSON.stringify(data)).not.toContain('"source":"Reference"');
  });

  it("handleMarketQuotesHttp returns live ticks plus the unavailable list for mixed symbols", async () => {
    liveMarketCache.set("NVDA", {
      tick: liveTick("NVDA", 200.0),
      expiresAt: Date.now() + 60000,
    });
    const data = (await (await handleMarketQuotesHttp(["NVDA", "AAPL"])).json()) as any;
    expect(data.quotes.map((q: any) => q.symbol)).toEqual(["NVDA"]);
    expect(data.unavailable).toEqual(["AAPL"]);
    expect(data.dataUnavailable).toBe(true);
  });

  it("WebSocket subscribe snapshot reports an uncached symbol as unavailable, never as a static tick", async () => {
    const ws = new MockDuplexWebSocket();
    await handleMarketQuotesWebSocket(ws as any);
    await ws.emitClientMessage({ type: "subscribe", symbols: ["NVDA"] });
    const messages = ws.getParsedMessages();
    const snapshot = messages.find((m) => m.type === "snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.quotes).toEqual([]);
    expect(snapshot.unavailable).toEqual(["NVDA"]);
    expect(JSON.stringify(messages)).not.toContain('"source":"Reference"');
  });
});
