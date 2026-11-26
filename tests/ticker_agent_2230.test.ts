/** @vitest-environment node */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TickerAgent, TICKER_PUSH_INTERVAL_SECONDS } from "../src/agents/ticker-agent";
import { liveMarketCache } from "../src/services/marketStream";

/** Minimal stand-in for an SDK Connection: state + send capture. */
class FakeConnection {
  id = "conn-1";
  state: any = undefined;
  sent: string[] = [];
  setState(s: any) {
    this.state = s;
  }
  send(m: string) {
    this.sent.push(m);
  }
  parsed() {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function mkTick(symbol: string, price: number): any {
  return {
    symbol,
    name: symbol,
    type: "stock",
    price,
    formattedPrice: `$${price}.00`,
    change: 1,
    formattedChange: "+0.50%",
    changePercent: 0.5,
    bid: price - 0.01,
    ask: price + 0.01,
    formattedBid: `$${price - 0.01}`,
    formattedAsk: `$${price + 0.01}`,
    volume: "10.0M",
    isPositive: true,
    timestamp: Date.now(),
    source: "Yahoo Finance",
  };
}

/**
 * Instantiate the agent without a Durable Object runtime: the methods
 * under test touch only connection state, the quote cache, and (for
 * pushTicks) overridable `getConnections`/`env` fields — never ctx.
 */
function bareAgent(): any {
  const agent = Object.create(TickerAgent.prototype);
  // Phase 3 (#6550): TICKER_PUSH_INTERVAL_S lives in
  // environment.config.json (3000 in production — the moved
  // wrangler value, verbatim), so a bare env no longer resolves
  // the 5s code default. These tests pin the arming behaviour,
  // not the interval value, so the 5s interval is set explicitly.
  agent.env = { TICKER_PUSH_INTERVAL_S: "5" };
  // onConnect arms the tick schedule (issue #2443); the scheduler is
  // stubbed here so connection tests do not need a real one. The
  // onStart tests below override this stub with a recording one.
  agent.scheduleEvery = async () => ({ id: "stub-schedule", callback: "pushTicks" });
  return agent;
}

describe("TickerAgent (Issue #2230)", () => {
  beforeEach(() => {
    liveMarketCache.clear();
    liveMarketCache.set("NVDA", { tick: mkTick("NVDA", 200), expiresAt: Date.now() + 60000 });
  });

  afterEach(() => {
    liveMarketCache.clear();
    vi.unstubAllGlobals();
  });

  it("onStart with zero listeners installs nothing (issue #2443: lazy-arm)", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [];
    agent.listSchedules = async () => [];
    const cancelled: string[] = [];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    const calls: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      calls.push([secs, cb]);
    };
    await agent.onStart();
    expect(calls).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("onStart with listeners present re-arms the 5s pushTicks schedule (issue #2443)", async () => {
    const agent = bareAgent();
    const conn = new FakeConnection();
    agent.getConnections = () => [conn];
    const calls: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      calls.push([secs, cb]);
    };
    await agent.onStart();
    expect(calls).toEqual([[TICKER_PUSH_INTERVAL_SECONDS, "pushTicks"]]);
  });

  it("disables SDK protocol messages for plain WebSocket clients", () => {
    expect(bareAgent().shouldSendProtocolMessages()).toBe(false);
  });

  it("answers subscribe with a snapshot and records the symbols", async () => {
    const agent = bareAgent();
    const conn = new FakeConnection();
    await agent.onConnect(conn, {
      request: new Request("https://example.test/api/market/quotes/ws"),
    });
    await agent.onMessage(conn, JSON.stringify({ type: "subscribe", symbols: ["nvda", "MSFT"] }));
    expect(conn.state.symbols).toEqual(["NVDA", "MSFT"]);
    const frames = conn.parsed();
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe("snapshot");
    expect(frames[0].quotes.map((q: any) => q.symbol)).toEqual(["NVDA"]);
    expect(frames[0].unavailable).toEqual(["MSFT"]);
  });

  it("drops symbols on unsubscribe", async () => {
    const agent = bareAgent();
    const conn = new FakeConnection();
    await agent.onConnect(conn, {
      request: new Request("https://example.test/api/market/quotes/ws"),
    });
    await agent.onMessage(conn, JSON.stringify({ type: "subscribe", symbols: ["NVDA", "AAPL"] }));
    await agent.onMessage(conn, JSON.stringify({ type: "unsubscribe", symbols: ["NVDA"] }));
    expect(conn.state.symbols).toEqual(["AAPL"]);
  });

  it("answers ping with pong and malformed frames with error", async () => {
    const agent = bareAgent();
    const conn = new FakeConnection();
    await agent.onConnect(conn, {
      request: new Request("https://example.test/api/market/quotes/ws"),
    });
    await agent.onMessage(conn, JSON.stringify({ type: "ping" }));
    await agent.onMessage(conn, "{not json");
    const frames = conn.parsed();
    expect(frames[0].type).toBe("pong");
    expect(typeof frames[0].timestamp).toBe("number");
    expect(frames[1].type).toBe("error");
  });

  it("pushes cached-first ticks per connection, filtered to its symbols", async () => {
    const agent = bareAgent();
    const conn = new FakeConnection();
    await agent.onConnect(conn, {
      request: new Request("https://example.test/api/market/quotes/ws"),
    });
    await agent.onMessage(conn, JSON.stringify({ type: "subscribe", symbols: ["NVDA"] }));
    conn.sent = [];
    // The background refresh must not reach the network in this test:
    // its failure is the contract path (last known quote stays visible).
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    agent.getConnections = () => [conn];
    await agent.pushTicks();
    const ticks = conn.parsed().filter((f: any) => f.type === "ticks");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].ticks.map((q: any) => q.symbol)).toEqual(["NVDA"]);
  });
});
