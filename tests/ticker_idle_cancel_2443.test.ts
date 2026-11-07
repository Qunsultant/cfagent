/** @vitest-environment node */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TickerAgent,
  TICKER_PUSH_INTERVAL_SECONDS,
  resolveTickerPushIntervalSeconds,
} from "../src/agents/ticker-agent";

/** Minimal stand-in for an SDK Connection: id + state + send capture. */
class FakeConnection {
  id: string;
  state: any = undefined;
  sent: string[] = [];
  constructor(id: string) {
    this.id = id;
  }
  setState(s: any) {
    this.state = s;
  }
  send(m: string) {
    this.sent.push(m);
  }
}

/**
 * Instantiate the agent without a Durable Object runtime: the methods
 * under test touch only overridable scheduler/connection methods —
 * never ctx. Scheduler methods are stubbed per test.
 */
function bareAgent(): any {
  const agent = Object.create(TickerAgent.prototype);
  agent.env = {};
  return agent;
}

function connectRequest(): Request {
  return new Request("https://example.test/api/market/quotes/ws");
}

describe("TickerAgent idle-cancel (Issue #2443)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("onStart with zero listeners arms nothing and cancels a legacy pushTicks schedule", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [];
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
      return { id: "sched-1", callback: cb };
    };
    const cancelled: string[] = [];
    agent.listSchedules = async () => [
      { id: "legacy-1", callback: "pushTicks" },
      { id: "other-1", callback: "somethingElse" },
    ];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    await agent.onStart();
    expect(scheduled).toEqual([]);
    expect(cancelled).toEqual(["legacy-1"]);
  });

  it("onStart with zero listeners and no schedules neither arms nor cancels", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [];
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
    };
    const cancelled: string[] = [];
    agent.listSchedules = async () => [];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    await agent.onStart();
    expect(scheduled).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("onStart with listeners present re-arms (restart-with-listeners)", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [new FakeConnection("conn-1")];
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
      return { id: "sched-1", callback: cb };
    };
    const cancelled: string[] = [];
    agent.listSchedules = async () => [];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    await agent.onStart();
    expect(scheduled).toEqual([[TICKER_PUSH_INTERVAL_SECONDS, "pushTicks"]]);
    expect(cancelled).toEqual([]);
  });

  it("onConnect arms on first connect", async () => {
    const agent = bareAgent();
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
      return { id: "sched-1", callback: cb };
    };
    await agent.onConnect(new FakeConnection("conn-1"), { request: connectRequest() });
    expect(scheduled).toEqual([[TICKER_PUSH_INTERVAL_SECONDS, "pushTicks"]]);
  });

  it("onClose with other connections remaining cancels nothing", async () => {
    const agent = bareAgent();
    const staying = new FakeConnection("conn-2");
    agent.getConnections = () => [new FakeConnection("conn-1"), staying];
    const cancelled: string[] = [];
    agent.listSchedules = async () => [{ id: "sched-1", callback: "pushTicks" }];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    await agent.onClose(new FakeConnection("conn-1"), 1000, "", true);
    expect(cancelled).toEqual([]);
  });

  it("onClose on the last connection cancels the pushTicks schedule", async () => {
    const agent = bareAgent();
    // SDK calls onClose BEFORE removing the closing connection, so the
    // closing connection is still present in getConnections here.
    agent.getConnections = () => [new FakeConnection("conn-1")];
    const cancelled: string[] = [];
    agent.listSchedules = async () => [{ id: "sched-1", callback: "pushTicks" }];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    await agent.onClose(new FakeConnection("conn-1"), 1000, "", true);
    expect(cancelled).toEqual(["sched-1"]);
  });

  it("re-arm on reconnect after idle-cancel", async () => {
    const agent = bareAgent();
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
      return { id: "sched-1", callback: cb };
    };
    const cancelled: string[] = [];
    agent.listSchedules = async () => [{ id: "sched-1", callback: "pushTicks" }];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    agent.getConnections = () => [new FakeConnection("conn-1")];
    await agent.onClose(new FakeConnection("conn-1"), 1000, "", true);
    expect(cancelled).toEqual(["sched-1"]);
    await agent.onConnect(new FakeConnection("conn-2"), { request: connectRequest() });
    expect(scheduled).toEqual([[TICKER_PUSH_INTERVAL_SECONDS, "pushTicks"]]);
  });

  it("cancel failure surfaces via console.error and does not throw", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [new FakeConnection("conn-1")];
    agent.listSchedules = async () => [{ id: "sched-1", callback: "pushTicks" }];
    agent.cancelSchedule = async () => {
      throw new Error("cancel exploded");
    };
    // Issue #3515 S3: the failure surfaces through the S2 structured
    // logger — one JSON event line via console.info. Assert on the
    // parsed event, not console.error.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(
        agent.onClose(new FakeConnection("conn-1"), 1000, "", true),
      ).resolves.toBeUndefined();
      const events = info.mock.calls
        .flatMap((args) => args.map(String))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      const failed = events.find((e) => e.type === "tickerAgent.ticker_schedule_failed" && e.level === "error");
      expect(failed).toBeDefined();
      expect(String(failed.fields?.message)).toContain("TickerAgent");
    } finally {
      info.mockRestore();
    }
  });

  it("listSchedules failure during cancel surfaces and does not throw", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [new FakeConnection("conn-1")];
    agent.listSchedules = async () => {
      throw new Error("list exploded");
    };
    agent.cancelSchedule = async () => true;
    // Issue #3515 S3: the failure surfaces through the S2 structured
    // logger — one JSON event line via console.info. Assert on the
    // parsed event, not console.error.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(
        agent.onClose(new FakeConnection("conn-1"), 1000, "", true),
      ).resolves.toBeUndefined();
      const events = info.mock.calls
        .flatMap((args) => args.map(String))
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      const failed = events.find((e) => e.type === "tickerAgent.ticker_schedule_failed" && e.level === "error");
      expect(failed).toBeDefined();
      expect(String(failed.fields?.error)).toContain("list exploded");
    } finally {
      info.mockRestore();
    }
  });

  it("pushTicks with zero connections cancels the schedule and sends nothing", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [];
    const cancelled: string[] = [];
    agent.listSchedules = async () => [{ id: "sched-1", callback: "pushTicks" }];
    agent.cancelSchedule = async (id: string) => {
      cancelled.push(id);
      return true;
    };
    await agent.pushTicks();
    expect(cancelled).toEqual(["sched-1"]);
  });

  it("subscribe does not itself arm (arm happens on connect, per #2443)", async () => {
    const agent = bareAgent();
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
      return { id: "sched-1", callback: cb };
    };
    const conn = new FakeConnection("conn-1");
    await agent.onConnect(conn, { request: connectRequest() });
    scheduled.length = 0;
    await agent.onMessage(conn, JSON.stringify({ type: "subscribe", symbols: ["NVDA"] }));
    expect(scheduled).toEqual([]);
  });

  it("resolves the interval from TICKER_PUSH_INTERVAL_S, defaulting to 5s", () => {
    expect(resolveTickerPushIntervalSeconds({})).toBe(5);
    expect(resolveTickerPushIntervalSeconds(undefined)).toBe(5);
    expect(resolveTickerPushIntervalSeconds({ TICKER_PUSH_INTERVAL_S: "12" })).toBe(12);
    expect(resolveTickerPushIntervalSeconds({ TICKER_PUSH_INTERVAL_S: "abc" })).toBe(5);
    expect(resolveTickerPushIntervalSeconds({ TICKER_PUSH_INTERVAL_S: "0" })).toBe(5);
    expect(resolveTickerPushIntervalSeconds({ TICKER_PUSH_INTERVAL_S: "-3" })).toBe(5);
  });

  it("onConnect arms with the externalized interval", async () => {
    const agent = bareAgent();
    agent.env = { TICKER_PUSH_INTERVAL_S: "12" };
    const scheduled: Array<[number, string]> = [];
    agent.scheduleEvery = async (secs: number, cb: string) => {
      scheduled.push([secs, cb]);
      return { id: "sched-1", callback: cb };
    };
    await agent.onConnect(new FakeConnection("conn-1"), { request: connectRequest() });
    expect(scheduled).toEqual([[12, "pushTicks"]]);
  });
});
