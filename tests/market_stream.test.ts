import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyAssetType,
  formatPrice,
  formatChangePercent,
  formatVolume,
  getBaselineMarketTick,
  generateNextTick,
  getBatchMarketQuotes,
  handleMarketQuotesHttp,
  handleMarketQuotesWebSocket,
  liveMarketCache,
} from "../src/services/marketStream";
import { SEARCH_SYMBOLS } from "../src/client/quotes/symbolSets";

// Mock WebSocket implementation for unit testing
class MockDuplexWebSocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  addEventListener(event: string, cb: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(cb);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    for (const cb of this.listeners["close"] || []) {
      cb({ code, reason });
    }
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

describe("Real-Time Market Data WebSocket Streaming (Issue #21)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Asset Classification & Formatting", () => {
    it("correctly classifies asset types for stocks, ETFs, and cryptocurrencies", () => {
      expect(classifyAssetType("NVDA")).toBe("stock");
      expect(classifyAssetType("AAPL")).toBe("stock");
      expect(classifyAssetType("TSLA")).toBe("stock");
      expect(classifyAssetType("SPY")).toBe("etf");
      expect(classifyAssetType("QQQ")).toBe("etf");
      expect(classifyAssetType("BTC/USD")).toBe("crypto");
      expect(classifyAssetType("ETH/USD")).toBe("crypto");
      expect(classifyAssetType("SOL/USD")).toBe("crypto");
      expect(classifyAssetType("BTC-USD")).toBe("crypto");
    });

    it("formats prices with currency symbols and comma separators", () => {
      expect(formatPrice(138.25)).toBe("$138.25");
      expect(formatPrice(64250.0)).toBe("$64,250.00");
      expect(formatPrice(0.05)).toBe("$0.05");
    });

    it("formats percentage changes with + / - signs", () => {
      expect(formatChangePercent(3.42)).toBe("+3.42%");
      expect(formatChangePercent(-1.24)).toBe("-1.24%");
      expect(formatChangePercent(0)).toBe("0.00%");
    });

    it("formats trading volumes appropriately for equities and crypto", () => {
      expect(formatVolume(48200000, false)).toBe("48.2M");
      expect(formatVolume(28400000000, true)).toBe("$28.4B");
    });
  });

  describe("Baseline Market Ticks & Volatility Generation", () => {
    it("returns null for uncached symbols and the cached live tick when present (#929)", () => {
      liveMarketCache.clear();
      expect(getBaselineMarketTick("NVDA")).toBeNull();
      expect(getBaselineMarketTick("BTC/USD")).toBeNull();

      const live: any = {
        symbol: "NVDA",
        name: "NVDA",
        type: "stock",
        price: 200,
        formattedPrice: "$200.00",
        change: 1,
        formattedChange: "+0.50%",
        changePercent: 0.5,
        bid: 199.99,
        ask: 200.01,
        formattedBid: "$199.99",
        formattedAsk: "$200.01",
        volume: "10.0M",
        isPositive: true,
        timestamp: Date.now(),
        source: "Yahoo Finance",
      };
      liveMarketCache.set("NVDA", { tick: live, expiresAt: Date.now() + 60000 });
      const nvda = getBaselineMarketTick("NVDA");
      expect(nvda).toEqual(live);
      expect(nvda!.bid).toBeLessThanOrEqual(nvda!.ask);
      liveMarketCache.clear();
    });

    it("generates realistic next price ticks with consistent NBBO spread and change", () => {
      const initial: any = {
        symbol: "NVDA",
        name: "NVDA",
        type: "stock",
        price: 200,
        formattedPrice: "$200.00",
        change: 1,
        formattedChange: "+0.50%",
        changePercent: 0.5,
        bid: 199.99,
        ask: 200.01,
        formattedBid: "$199.99",
        formattedAsk: "$200.01",
        volume: "10.0M",
        isPositive: true,
        timestamp: Date.now(),
        source: "Yahoo Finance",
      };
      const next = generateNextTick(initial);

      expect(next.symbol).toBe("NVDA");
      expect(next.price).toBeGreaterThan(0);
      expect(next.bid).toBeLessThanOrEqual(next.ask);
      expect(next.formattedPrice).toBeDefined();
      expect(next.formattedChange).toBeDefined();
      expect(next.timestamp).toBeGreaterThanOrEqual(initial.timestamp);
    });

    it("returns batch market quotes for multiple symbols", () => {
      liveMarketCache.clear();
      const mk = (symbol: string, price: number): any => ({
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
        timestamp: Date.now(),
        source: "Yahoo Finance",
      });
      liveMarketCache.set("NVDA", { tick: mk("NVDA", 200), expiresAt: Date.now() + 60000 });
      liveMarketCache.set("AAPL", { tick: mk("AAPL", 250), expiresAt: Date.now() + 60000 });
      liveMarketCache.set("BTC/USD", {
        tick: { ...mk("BTC/USD", 65000), type: "crypto" },
        expiresAt: Date.now() + 60000,
      });
      const batch = getBatchMarketQuotes(["NVDA", "AAPL", "BTC/USD"]);
      expect(batch.length).toBe(3);
      expect(batch.map((b) => b.symbol)).toEqual(["NVDA", "AAPL", "BTC/USD"]);
      liveMarketCache.clear();
    });
  });

  describe("HTTP Batch Fallback Handler", () => {
    it("returns 200 Response with quotes payload and CORS headers", async () => {
      liveMarketCache.clear();
      const mk = (symbol: string, price: number): any => ({
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
        timestamp: Date.now(),
        source: "Yahoo Finance",
      });
      liveMarketCache.set("NVDA", { tick: mk("NVDA", 200), expiresAt: Date.now() + 60000 });
      liveMarketCache.set("SOL/USD", {
        tick: { ...mk("SOL/USD", 200), type: "crypto" },
        expiresAt: Date.now() + 60000,
      });
      // #2692: the handler now awaits its upstream refresh before
      // serving — stub the fetch so this stays hermetic (a live
      // answer would replace the seeded ticks mid-test).
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
      const res = await handleMarketQuotesHttp(["NVDA", "SOL/USD"]);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const data = (await res.json()) as any;
      expect(data.quotes).toBeDefined();
      expect(data.quotes.length).toBe(2);
      expect(data.quotes[0].symbol).toBe("NVDA");
      expect(data.quotes[1].symbol).toBe("SOL/USD");
      expect(data.unavailable).toEqual([]);
      expect(data.dataUnavailable).toBe(false);
      vi.unstubAllGlobals();
      liveMarketCache.clear();
    });
  });

  describe("Duplex WebSocket Real-Time Quote Streaming", () => {
    it("handles client subscribe message and returns snapshot of requested tickers", async () => {
      liveMarketCache.clear();
      const mk = (symbol: string, price: number, type: string): any => ({
        symbol,
        name: symbol,
        type,
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
        timestamp: Date.now(),
        source: "Yahoo Finance",
      });
      for (const [s, p, t] of [
        ["NVDA", 200, "stock"],
        ["AAPL", 250, "stock"],
        ["BTC/USD", 65000, "crypto"],
        ["SOL/USD", 200, "crypto"],
      ] as const) {
        liveMarketCache.set(s, { tick: mk(s, p, t), expiresAt: Date.now() + 60000 });
      }
      const ws = new MockDuplexWebSocket();
      await handleMarketQuotesWebSocket(ws as any);

      await ws.emitClientMessage({
        type: "subscribe",
        symbols: ["NVDA", "AAPL", "BTC/USD", "SOL/USD"],
      });

      const messages = ws.getParsedMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("snapshot");
      expect(messages[0].quotes.length).toBe(4);
      expect(messages[0].quotes.map((q: any) => q.symbol)).toEqual([
        "NVDA",
        "AAPL",
        "BTC/USD",
        "SOL/USD",
      ]);
      expect(messages[0].unavailable).toEqual([]);
      liveMarketCache.clear();
    });

    it("streams tick updates on periodic timer intervals", async () => {
      liveMarketCache.clear();
      const mk = (symbol: string, price: number): any => ({
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
        timestamp: Date.now(),
        source: "Yahoo Finance",
      });
      liveMarketCache.set("NVDA", {
        tick: mk("NVDA", 200),
        expiresAt: Date.now() + 60000,
      });
      liveMarketCache.set("TSLA", {
        tick: mk("TSLA", 250),
        expiresAt: Date.now() + 60000,
      });

      const ws = new MockDuplexWebSocket();
      await handleMarketQuotesWebSocket(ws as any);

      await ws.emitClientMessage({
        type: "subscribe",
        symbols: ["NVDA", "TSLA"],
      });

      // Clear initial snapshot from sent count
      expect(ws.sent.length).toBe(1);

      // Advance timers by tick interval and flush async ticks
      await vi.advanceTimersByTimeAsync(5050);

      const messages = ws.getParsedMessages();
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const tickMsg = messages.find((m) => m.type === "ticks" || m.type === "tick");
      expect(tickMsg).toBeDefined();
      const tick = tickMsg.type === "ticks" ? tickMsg.ticks[0] : tickMsg.tick;
      expect(["NVDA", "TSLA"]).toContain(tick.symbol);
      expect(tick.formattedPrice).toBeDefined();
    });

    it("handles ping heartbeat and returns pong", async () => {
      const ws = new MockDuplexWebSocket();
      await handleMarketQuotesWebSocket(ws as any);

      await ws.emitClientMessage({ type: "ping" });

      const messages = ws.getParsedMessages();
      expect(messages.length).toBe(1);
      expect(messages[0].type).toBe("pong");
      expect(messages[0].timestamp).toBeDefined();
    });

    it("handles unsubscribe and cleans up on socket close", async () => {
      const ws = new MockDuplexWebSocket();
      await handleMarketQuotesWebSocket(ws as any);

      await ws.emitClientMessage({
        type: "subscribe",
        symbols: ["NVDA", "QQQ"],
      });

      await ws.emitClientMessage({
        type: "unsubscribe",
        symbols: ["NVDA"],
      });

      // Close the socket
      ws.close(1000, "Modal Closed");
      expect(ws.closed).toBe(true);
    });
  });

  describe("SEARCH_SYMBOLS Preset Coverage (moved from POPULAR_TICKERS, #2100)", () => {
    it("includes all required benchmark equities and crypto pairs in search bar", () => {
      const symbols = SEARCH_SYMBOLS.map((t) => t.symbol);
      expect(symbols).toContain("NVDA");
      expect(symbols).toContain("AAPL");
      expect(symbols).toContain("MSFT");
      expect(symbols).toContain("TSLA");
      expect(symbols).toContain("SPY");
      expect(symbols).toContain("QQQ");
      expect(symbols).toContain("BTC/USD");
      expect(symbols).toContain("ETH/USD");
      expect(symbols).toContain("SOL/USD");
    });

    it("verifies every ticker has valid initial pricing and classification", () => {
      for (const ticker of SEARCH_SYMBOLS) {
        expect(ticker.symbol).toBeTruthy();
        expect(ticker.name).toBeTruthy();
        expect(ticker.price).toMatch(/^\$[0-9,]+\.[0-9]{2}$/);
        expect(ticker.change).toMatch(/^[+-][0-9]+\.[0-9]{2}%$/);
        expect(typeof ticker.isPositive).toBe("boolean");
        expect(["stock", "crypto", "etf"]).toContain(ticker.type);
      }
    });
  });
});
