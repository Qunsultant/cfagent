/**
 * Issue #3121 #4237 — ticker push in the single schedule.
 *
 * The TickerAgent pushTicks feed is a live data feed, not a scheduled
 * run: this slice records its cadence as ONE unified-store record
 * (kind ticker-push, record-only — no per-push ledger rows) and
 * surfaces it in the Schedules home list with interval, last push,
 * and health, so a stopped push is visible as a missed run.
 *
 * Decision recorded on Qunsultant/cfagent#4237 (comment 6826841267):
 * record-only; one record, updated in place; health derived from
 * lastPushAt vs interval x stale-after-intervals; the record lives
 * in the TickerAgent's own store (ADR 0029 D-0) and the list route
 * reads it through a typed RPC, best-effort.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  UNIFIED_SCHEDULE_KINDS,
  type UnifiedScheduleRecord,
} from "../src/data/unifiedSchedulePorts";
import {
  TICKER_PUSH_RECORD_ID,
  tickerPushScheduleToRecord,
  tickerPushHealth,
  tickerPushRecordToListItem,
  unifiedRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import { MockSqlStorage } from "./mock-sql";
import {
  TickerAgent,
  TICKER_PUSH_INTERVAL_SECONDS,
  resolveTickerPushStaleAfterIntervals,
} from "../src/agents/ticker-agent";
import { handleSchedulesRoutes } from "../src/agents/routes/schedules";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

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
 * Instantiate the agent without a Durable Object runtime, the
 * ticker-test idiom (tests/ticker_idle_cancel_2443.test.ts): the
 * methods under test touch only overridable scheduler/connection
 * methods plus the defensive store seam (agent.ctx) — never a real DO.
 */
function bareAgent(sql?: MockSqlStorage): any {
  const agent = Object.create(TickerAgent.prototype);
  agent.env = {};
  if (sql) agent.ctx = { storage: { sql } };
  agent.scheduleEvery = async (secs: number, cb: string) => {
    return { id: "sched-1", callback: cb };
  };
  agent.listSchedules = async () => [];
  agent.cancelSchedule = async (_id: string) => true;
  return agent;
}

function tickerRecord(): UnifiedScheduleRecord {
  return tickerPushScheduleToRecord(
    { intervalSeconds: 3000, armed: true, lastPushAt: "2026-11-12T14:00:00.000Z" },
    "2026-11-12T14:00:00.000Z",
  );
}

describe("4237 kind + record shape", () => {
  it("declares the ticker-push kind in the unified-store union", () => {
    expect((UNIFIED_SCHEDULE_KINDS as readonly string[])).toContain("ticker-push");
  });

  it("builds the one stable ticker-push record (id = kind, alarm rides as alarmId)", () => {
    const rec = tickerPushScheduleToRecord(
      { intervalSeconds: 3000, alarmId: "sdk-alarm-9", armed: true, lastPushAt: "2026-11-12T14:00:00.000Z" },
      "2026-11-12T14:00:00.000Z",
    );
    expect(rec.id).toBe(TICKER_PUSH_RECORD_ID);
    expect(TICKER_PUSH_RECORD_ID).toBe("ticker-push");
    expect(rec.kind).toBe("ticker-push");
    expect(rec.state).toBe("active");
    expect(rec.callback).toBe("pushTicks");
    expect(rec.definition.type).toBe("interval");
    expect(rec.definition.intervalSeconds).toBe(3000);
    expect(rec.definition.armed).toBe(true);
    expect(rec.definition.lastPushAt).toBe("2026-11-12T14:00:00.000Z");
    expect(rec.alarmId).toBe("sdk-alarm-9");
    expect(rec.createdAt).toBe("2026-11-12T14:00:00.000Z");
    expect(rec.updatedAt).toBe("2026-11-12T14:00:00.000Z");
  });

  it("preserves createdAt across in-place updates (upsert, not recreate)", () => {
    const first = tickerPushScheduleToRecord(
      { intervalSeconds: 3000, alarmId: "sdk-alarm-9", armed: true },
      "2026-11-12T14:00:00.000Z",
    );
    const second = tickerPushScheduleToRecord(
      { intervalSeconds: 3000, alarmId: "sdk-alarm-10", armed: true, lastPushAt: "2026-11-12T14:50:00.000Z" },
      "2026-11-12T14:50:00.000Z",
      first,
    );
    expect(second.id).toBe("ticker-push");
    expect(second.createdAt).toBe("2026-11-12T14:00:00.000Z");
    expect(second.updatedAt).toBe("2026-11-12T14:50:00.000Z");
    expect(second.alarmId).toBe("sdk-alarm-10");
    expect(second.definition.lastPushAt).toBe("2026-11-12T14:50:00.000Z");
  });

  it("round-trips the ticker-push kind through the in-memory store", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(tickerRecord());
    expect((await store.listByKind("ticker-push")).map((r) => r.id)).toEqual(["ticker-push"]);
    expect((await store.get("ticker-push"))?.kind).toBe("ticker-push");
  });
});

describe("4237 stale threshold config", () => {
  it("resolves the stale threshold from TICKER_PUSH_STALE_AFTER_INTERVALS, defaulting to 2", () => {
    expect(resolveTickerPushStaleAfterIntervals(undefined)).toBe(2);
    expect(resolveTickerPushStaleAfterIntervals({} as any)).toBe(2);
    expect(resolveTickerPushStaleAfterIntervals({ TICKER_PUSH_STALE_AFTER_INTERVALS: "3" } as any)).toBe(3);
    expect(resolveTickerPushStaleAfterIntervals({ TICKER_PUSH_STALE_AFTER_INTERVALS: "0" } as any)).toBe(2);
    expect(resolveTickerPushStaleAfterIntervals({ TICKER_PUSH_STALE_AFTER_INTERVALS: "-1" } as any)).toBe(2);
    expect(resolveTickerPushStaleAfterIntervals({ TICKER_PUSH_STALE_AFTER_INTERVALS: "abc" } as any)).toBe(2);
  });
});

describe("4237 ticker push health (stopped push is visible, idle is not missed)", () => {
  const nowMs = Date.parse("2026-11-12T15:00:00.000Z");
  const intervalSeconds = 3000;

  function healthRecord(lastPushAt: string | undefined, armed: boolean, createdAt = "2026-11-12T14:00:00.000Z"): UnifiedScheduleRecord {
    return tickerPushScheduleToRecord(
      { intervalSeconds, armed, ...(lastPushAt ? { lastPushAt } : {}) },
      createdAt,
    );
  }

  it("is healthy while the last push is within the threshold", () => {
    // Last push 50 min ago = exactly one 3000s interval: within 2 intervals.
    expect(tickerPushHealth(healthRecord("2026-11-12T14:10:00.000Z", true), nowMs, 2)).toBe("healthy");
  });

  it("is stale once the last push is older than the threshold", () => {
    // Last push 100 min + 1s ago: past 2 x 3000s.
    expect(tickerPushHealth(healthRecord("2026-11-12T13:19:59.000Z", true), nowMs, 2)).toBe("stale");
  });

  it("is healthy exactly at the threshold boundary (stale only past it)", () => {
    // Exactly 2 x 3000s = 100 min ago: not yet stale.
    expect(tickerPushHealth(healthRecord("2026-11-12T13:20:00.000Z", true), nowMs, 2)).toBe("healthy");
  });

  it("is idle, not stale, when the feed is disarmed (no listeners)", () => {
    expect(tickerPushHealth(healthRecord("2026-11-12T10:00:00.000Z", false), nowMs, 2)).toBe("idle");
  });

  it("falls back to createdAt when armed but never pushed", () => {
    // Armed 10 min ago, no push yet: within the threshold.
    expect(tickerPushHealth(healthRecord(undefined, true, "2026-11-12T14:50:00.000Z"), nowMs, 2)).toBe("healthy");
    // Armed 3 hours ago, no push yet: stale.
    expect(tickerPushHealth(healthRecord(undefined, true, "2026-11-12T12:00:00.000Z"), nowMs, 2)).toBe("stale");
  });

  it("is stale when armed but the cadence is unknown (fail toward visible)", () => {
    const rec = healthRecord("2026-11-12T14:59:00.000Z", true);
    (rec.definition as Record<string, unknown>).intervalSeconds = undefined;
    expect(tickerPushHealth(rec, nowMs, 2)).toBe("stale");
  });
});

describe("4237 list item (Schedules home row)", () => {
  it("carries interval, last push, and armed state for a ticker-push record", () => {
    const item = unifiedRecordToListItem(tickerRecord());
    expect(item.kind).toBe("ticker-push");
    expect(item.callback).toBe("pushTicks");
    expect(item.type).toBe("interval");
    expect(item.intervalSeconds).toBe(3000);
    expect((item as any).lastPushAt).toBe("2026-11-12T14:00:00.000Z");
    expect((item as any).armed).toBe(true);
  });

  it("attaches the derived health on the ticker list item", () => {
    const nowMs = Date.parse("2026-11-12T15:00:00.000Z");
    const fresh = tickerPushRecordToListItem(
      tickerPushScheduleToRecord(
        { intervalSeconds: 3000, armed: true, lastPushAt: "2026-11-12T14:50:00.000Z" },
        "2026-11-12T14:00:00.000Z",
      ),
      nowMs,
      2,
    );
    expect(fresh.health).toBe("healthy");
    const stale = tickerPushRecordToListItem(
      tickerPushScheduleToRecord(
        { intervalSeconds: 3000, armed: true, lastPushAt: "2026-11-12T13:00:00.000Z" },
        "2026-11-12T13:00:00.000Z",
      ),
      nowMs,
      2,
    );
    expect(stale.health).toBe("stale");
  });
});

describe("4237 TickerAgent records its own feed (best-effort, never breaks the feed)", () => {
  it("onStart with listeners arms and records the push (armed, alarm id, interval)", async () => {
    const sql = new MockSqlStorage();
    const agent = bareAgent(sql);
    agent.getConnections = () => [new FakeConnection("conn-1")];
    await agent.onStart();
    const stored = new SqlUnifiedScheduleStore(sql as any).get("ticker-push");
    expect(stored?.kind).toBe("ticker-push");
    expect(stored?.state).toBe("active");
    expect((stored?.definition as any).armed).toBe(true);
    expect(stored?.alarmId).toBe("sched-1");
    expect((stored?.definition as any).intervalSeconds).toBe(TICKER_PUSH_INTERVAL_SECONDS);
  });

  it("pushTicks stamps lastPushAt on the record", async () => {
    const sql = new MockSqlStorage();
    const agent = bareAgent(sql);
    const conn = new FakeConnection("conn-1");
    conn.setState({ symbols: [], expiryMode: "continuity", streamProvenance: "bare" });
    agent.getConnections = () => [conn];
    await agent.pushTicks();
    const stored = new SqlUnifiedScheduleStore(sql as any).get("ticker-push");
    expect(stored?.kind).toBe("ticker-push");
    expect(typeof (stored?.definition as any).lastPushAt).toBe("string");
    expect((stored?.definition as any).armed).toBe(true);
  });

  it("last disconnect records the feed as disarmed (idle, not missed)", async () => {
    const sql = new MockSqlStorage();
    const agent = bareAgent(sql);
    const closing = new FakeConnection("conn-1");
    agent.getConnections = () => [closing];
    await agent.onClose(closing, 1000, "", true);
    const stored = new SqlUnifiedScheduleStore(sql as any).get("ticker-push");
    expect(stored?.kind).toBe("ticker-push");
    expect((stored?.definition as any).armed).toBe(false);
  });

  it("a store failure never breaks the push (record write is best-effort)", async () => {
    const sql = new MockSqlStorage();
    sql.exec = () => {
      throw new Error("sqlite unavailable");
    };
    const agent = bareAgent(sql as any);
    const conn = new FakeConnection("conn-1");
    conn.setState({ symbols: [], expiryMode: "continuity", streamProvenance: "bare" });
    agent.getConnections = () => [conn];
    await expect(agent.pushTicks()).resolves.toBeUndefined();
  });

  it("exposes the record for the list route's RPC read", async () => {
    const sql = new MockSqlStorage();
    const agent = bareAgent(sql);
    expect(await agent.getTickerPushRecord()).toBeNull();
    agent.getConnections = () => [new FakeConnection("conn-1")];
    await agent.onStart();
    const record = await agent.getTickerPushRecord();
    expect(record?.id).toBe("ticker-push");
    expect(record?.kind).toBe("ticker-push");
  });

  it("with no DO storage the agent runs without recording (test doubles)", async () => {
    const agent = bareAgent();
    agent.getConnections = () => [new FakeConnection("conn-1")];
    await agent.onStart();
    await expect(agent.getTickerPushRecord()).resolves.toBeNull();
  });
});

describe("4237 management refuses the live feed with coded errors", () => {
  const alarms: any = {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "pushTicks" }),
  };

  async function storeWithTicker() {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(tickerRecord());
    return store;
  }

  it("pause / resume name the kind instead of arming a foreign alarm", async () => {
    const store = await storeWithTicker();
    const paused = await pauseUnifiedSchedule({ store, alarms }, "ticker-push", "2026-11-12T15:00:00.000Z");
    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.status).toBe(400);
      expect(paused.error).toContain("ticker-push");
    }
    const resumed = await resumeUnifiedSchedule({ store, alarms }, "ticker-push", "2026-11-12T15:00:00.000Z");
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.status).toBe(400);
      expect(resumed.error).toContain("ticker-push");
    }
  });

  it("trigger / update name the kind (not the goal surface)", async () => {
    const store = await storeWithTicker();
    const triggered = await triggerUnifiedSchedule({ store, alarms }, "ticker-push", async () => {});
    expect(triggered.ok).toBe(false);
    if (!triggered.ok) {
      expect(triggered.status).toBe(400);
      expect(triggered.error).toContain("ticker-push");
      expect(triggered.error).not.toContain("Goal schedules");
    }
    const updated = await updateUnifiedSchedule({ store, alarms }, "ticker-push", { intervalSeconds: 60 }, Date.now());
    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.status).toBe(400);
      expect(updated.error).toContain("ticker-push");
      expect(updated.error).not.toContain("Goal schedules");
    }
  });

  it("delete is a no-op for the live feed record", async () => {
    const store = await storeWithTicker();
    const deleted = await deleteUnifiedSchedule({ store, alarms }, "ticker-push");
    expect(deleted).toEqual({ ok: true, cancelled: false });
    expect(await store.get("ticker-push")).toBeDefined();
  });
});

describe("4237 list route appends the ticker row (best-effort)", () => {
  let sql: MockSqlStorage;
  let ctx: any;

  function fakeTickerNamespace(record: UnifiedScheduleRecord | null, throwing = false) {
    return {
      idFromName: (_name: string) => "ticker-id",
      get: (_id: unknown) => ({
        getTickerPushRecord: async () => {
          if (throwing) throw new Error("ticker DO unreachable");
          return record;
        },
      }),
    };
  }

  beforeEach(() => {
    sql = new MockSqlStorage();
    ctx = {
      env: {},
      agentCtx: { storage: { sql } },
      audit: vi.fn(),
      listSchedules: async () => [],
      cancelSchedule: async () => true,
      getScheduleById: async () => undefined,
      schedule: async () => ({ id: "new-1", callback: "pushTicks" }),
      scheduleEvery: async () => ({ id: "new-1", callback: "pushTicks" }),
      getScreenerExecutionContext: async () => ({ userLogin: "venus", environment: "PROD" }),
      getOrm: () => ({}),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: async () => {},
    };
  });

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  it("appends the ticker-push row with health when the ticker answers", async () => {
    const lastPushAt = new Date().toISOString();
    ctx.env = {
      TICKER_AGENT: fakeTickerNamespace(
        tickerPushScheduleToRecord(
          { intervalSeconds: 3000, armed: true, lastPushAt },
          new Date(Date.now() - 1000).toISOString(),
        ),
      ),
    };
    const body = await list();
    const row = body.schedules.find((s) => s.id === "ticker-push");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("ticker-push");
    expect(row?.callback).toBe("pushTicks");
    expect(row?.intervalSeconds).toBe(3000);
    expect(row?.lastPushAt).toBe(lastPushAt);
    expect(row?.health).toBe("healthy");
  });

  it("omits the row (list still 200) when the ticker RPC throws", async () => {
    ctx.env = { TICKER_AGENT: fakeTickerNamespace(null, true) };
    const body = await list();
    expect(body.schedules.find((s) => s.id === "ticker-push")).toBeUndefined();
  });

  it("omits the row (list still 200) when no ticker binding exists", async () => {
    const body = await list();
    expect(body.schedules.find((s) => s.id === "ticker-push")).toBeUndefined();
  });
});

describe("4237 Schedules home renders the ticker row (source pins)", () => {
  it("the panel names the ticker row and shows its health (#4237, #4389)", () => {
    const panel = source("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("Ticker push");
    expect(panel).toContain("Missed push");
    expect(panel).toContain('s.kind === "ticker-push"');
    // Issue #4389 supersedes the #4237 exception: the live feed now carries the
    // same five controls as every row, so the badge that stood in for them is gone.
    expect(panel).not.toContain("Live feed");
  });

  it("the client list item carries the ticker fields", () => {
    const jobsApi = source("src/client/jobsApi.ts");
    expect(jobsApi).toContain("lastPushAt");
    expect(jobsApi).toContain("health");
  });

  it("no per-push ledger rows: the ticker never writes through recordLedgerRun", () => {
    const ticker = source("src/agents/ticker-agent.ts");
    expect(ticker).not.toContain("recordLedgerRun");
  });
});
