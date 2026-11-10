/**
 * Issue #4001 (follow-up) — the 11:05 slot ran under the #4008 fix and
 * still left zero trace: no ledger row, no audit, no activity record.
 *
 * RED pins (TDD, written against main before the fix — each must FAIL
 * there and pass after):
 *
 * The deployed wrapper records a row on every path that reaches it,
 * and the SDK's own advance write proves the firing instance's
 * storage handle was writable at fire time — so the 11:05 firing
 * either never entered the handler (the live declaration lacked the
 * task at fire time) or entered and every sql write failed while the
 * SDK's own write succeeded. The deployed code cannot discriminate:
 * every in-handler sink shares the same DO SQLite, and every failure
 * is swallowed.
 *
 * Fix: a dispatch-boundary firing marker, written to DO KV storage
 * (independent of sql — the observe task's proven storage.get/put
 * pattern) in the handler closure BEFORE delegating, surfaced in the
 * copilot status read, plus the last non-declaration cause read from
 * the existing dedup key. The next firing leaves either a marker
 * (handler entered) or no marker (handler never entered).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("@cloudflare/think", () => {
  return {
    Think: class StubThink {
      ctx: any;
      env: any;
      lifecycle: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.lifecycle = { start: async () => {} };
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
      async listSchedules() {
        return [];
      }
      async cancelSchedule(_id: string) {
        return true;
      }
      async clearMessages() {}
    },
  };
});
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      messages: any[];
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.messages = [];
      }
    },
  };
});
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      throw new Error("generateText disabled in #4001 probe tests");
    }),
  };
});
// The cycle host builds its own MarketDataResearchService (a live-fetch
// boundary). Stub ONLY that class — every other export of the module
// stays real — so the host runs the real cycle with empty bars (no
// signals, no platform calls) instead of hitting the network.
vi.mock("../src/services/marketDataResearch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/marketDataResearch")>();
  return {
    ...actual,
    MarketDataResearchService: class StubMarketDataResearchService {
      constructor(_env: unknown) {}
      async getHistoricalBars() {
        return [];
      }
    },
  };
});

import {
  declareStockCopilotTasks,
  readCopilotCycleDispatchProbe,
  STOCK_COPILOT_TASK_ID,
  STOCK_COPILOT_CYCLE_FIRING_PROBE_KEY,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import { TradingPlatformRegistry } from "../src/trading";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";
import { handleStockCopilotRoutes } from "../src/agents/routes/stockCopilot";

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    const info = stmt.run(...(params as never[]));
    const out = [] as unknown[] & { rowsWritten?: number };
    out.rowsWritten = Number(info.changes);
    return out;
  }
}

/** In-memory stand-in for the DO storage KV surface (get/put). */
function makeKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key: string): Promise<unknown> => map.get(key),
    put: async (key: string, value: unknown): Promise<void> => {
      map.set(key, value);
    },
  };
}

type Kv = ReturnType<typeof makeKv>;

async function emptyCommercial(): Promise<InMemoryCommercialAdapter> {
  return new InMemoryCommercialAdapter();
}

function copilotSettings(): Map<string, string> {
  return new Map<string, string>([
    ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
    ["stock_copilot:universe", "NASDAQ100"],
    [BROKER_ENVIRONMENT_SETTING_KEY, "TEST"],
  ]);
}

/** The declared task's handler, invoked the way the Think SDK invokes it. */
async function runDeclaredHandler(
  sql: SqliteTestStorage,
  audits: Array<{ type: string; payload: Record<string, unknown> }>,
  kv?: Kv,
) {
  const settings = copilotSettings();
  const tasks = await declareStockCopilotTasks({
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      STOCK_COPILOT_AROUND_THE_CLOCK: "true",
    } as any,
    agentCtx: {
      storage: kv
        ? { sql: sql as any, get: kv.get, put: kv.put }
        : { sql: sql as any },
    } as any,
    getScreenerExecutionContext: async () => ({
      userLogin: "owner",
      environment: "TEST" as const,
    }),
    getOrm: () => undefined,
    readSettingRaw: (key: string) => settings.get(key) ?? null,
    commercial: await emptyCommercial(),
    audit: (type, _agent, payload) => {
      audits.push({ type, payload });
    },
  });
  expect(Object.keys(tasks)).toEqual([STOCK_COPILOT_TASK_ID]);
  const scheduledFor = Date.now();
  await tasks[STOCK_COPILOT_TASK_ID].handler({
    taskId: STOCK_COPILOT_TASK_ID,
    scheduledFor,
    scheduledForDate: new Date(scheduledFor),
    occurrenceKey: "4001-probe-1",
    idempotencyKey: "4001-probe-1",
    schedule: "every 1 hour",
    scheduleKind: "interval",
  });
  return scheduledFor;
}

async function statusBody(
  sql: SqliteTestStorage,
  kv: Kv | undefined,
): Promise<Record<string, unknown>> {
  const settings = copilotSettings();
  const req = new Request("http://localhost/api/stock-copilot/status", {
    method: "GET",
  });
  const res = await handleStockCopilotRoutes(
    req,
    new URL(req.url),
    "/api/stock-copilot/status",
    "session-1",
    {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "1",
        STOCK_COPILOT_AROUND_THE_CLOCK: "true",
      } as any,
      sql: sql as any,
      ...(kv ? { storage: kv } : {}),
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "TEST" as const,
      }),
      readSettingRaw: (key: string) =>
        key === BROKER_ENVIRONMENT_SETTING_KEY
          ? "TEST"
          : (settings.get(key) ?? null),
      commercial: await emptyCommercial(),
      audit: vi.fn(),
    } as any,
  );
  expect(res).not.toBeNull();
  expect(res!.status).toBe(200);
  return (await res!.json()) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Issue #4001 follow-up — the firing leaves a dispatch-boundary probe", () => {
  it("a firing writes a dispatch probe to KV storage before the cycle runs, even when setup throws", async () => {
    const sql = new SqliteTestStorage();
    const kv = makeKv();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(
      () => {
        throw new Error("Trading platform registry unavailable.");
      },
    );
    const scheduledFor = await runDeclaredHandler(sql, audits, kv);
    const probe = (await kv.get(
      STOCK_COPILOT_CYCLE_FIRING_PROBE_KEY,
    )) as Record<string, unknown> | undefined;
    expect(probe).toBeDefined();
    expect(probe!.taskId).toBe(STOCK_COPILOT_TASK_ID);
    expect(probe!.scheduledFor).toBe(scheduledFor);
    expect(probe!.occurrenceKey).toBe("4001-probe-1");
    expect(typeof probe!.receivedAt).toBe("string");
    // The #4008 behavior still holds: the throw also records a
    // failure ledger row.
    const store = new SqlJobRunRecordStore(sql as any);
    const rows = store.listByJob(STOCK_COPILOT_TASK_ID);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("failure");
  });

  it("a successful firing writes the probe too", async () => {
    const sql = new SqliteTestStorage();
    const kv = makeKv();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await runDeclaredHandler(sql, audits, kv);
    const probe = (await kv.get(
      STOCK_COPILOT_CYCLE_FIRING_PROBE_KEY,
    )) as Record<string, unknown> | undefined;
    expect(probe).toBeDefined();
    expect(probe!.taskId).toBe(STOCK_COPILOT_TASK_ID);
    const store = new SqlJobRunRecordStore(sql as any);
    expect(store.listByJob(STOCK_COPILOT_TASK_ID).length).toBe(1);
  });

  it("the probe write is best-effort: a storage handle without KV leaves the firing working", async () => {
    const sql = new SqliteTestStorage();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await runDeclaredHandler(sql, audits);
    const store = new SqlJobRunRecordStore(sql as any);
    const rows = store.listByJob(STOCK_COPILOT_TASK_ID);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).not.toBe("failure");
  });

  it("readCopilotCycleDispatchProbe returns the stored probe and the last non-declaration cause", async () => {
    const sql = new SqliteTestStorage();
    const kv = makeKv();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await runDeclaredHandler(sql, audits, kv);
    // A flag-off declaration on the same storage records the
    // non-declaration cause under the existing dedup key.
    await declareStockCopilotTasks({
      env: {} as any,
      agentCtx: {
        storage: { sql: sql as any, get: kv.get, put: kv.put },
      } as any,
      getScreenerExecutionContext: async () => undefined,
      getOrm: () => undefined,
      readSettingRaw: () => null,
      audit: (type, _agent, payload) => {
        audits.push({ type, payload });
      },
    });
    const probe = await readCopilotCycleDispatchProbe(kv);
    expect(probe.lastFiringAttempt).not.toBeNull();
    expect(probe.lastFiringAttempt!.taskId).toBe(STOCK_COPILOT_TASK_ID);
    expect(probe.lastNotDeclared).not.toBeNull();
    expect(probe.lastNotDeclared!.cause).toBe("flag_off");
    expect(typeof probe.lastNotDeclared!.atMs).toBe("number");
  });

  it("readCopilotCycleDispatchProbe returns nulls on empty storage", async () => {
    const kv = makeKv();
    const probe = await readCopilotCycleDispatchProbe(kv);
    expect(probe.lastFiringAttempt).toBeNull();
    expect(probe.lastNotDeclared).toBeNull();
  });

  it("REST status surfaces lastCycleFiringAttempt after a firing", async () => {
    const sql = new SqliteTestStorage();
    const kv = makeKv();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await runDeclaredHandler(sql, audits, kv);
    const body = await statusBody(sql, kv);
    const attempt = body.lastCycleFiringAttempt as Record<string, unknown> | null;
    expect(attempt).not.toBeNull();
    expect(attempt!.taskId).toBe(STOCK_COPILOT_TASK_ID);
    expect(body.lastCycleNotDeclared).toBeNull();
  });

  it("REST status surfaces lastCycleNotDeclared when the cycle was never declared", async () => {
    const sql = new SqliteTestStorage();
    const kv = makeKv();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await declareStockCopilotTasks({
      env: {} as any,
      agentCtx: {
        storage: { sql: sql as any, get: kv.get, put: kv.put },
      } as any,
      getScreenerExecutionContext: async () => undefined,
      getOrm: () => undefined,
      readSettingRaw: () => null,
      audit: (type, _agent, payload) => {
        audits.push({ type, payload });
      },
    });
    const body = await statusBody(sql, kv);
    expect(body.lastCycleFiringAttempt).toBeNull();
    const notDeclared = body.lastCycleNotDeclared as Record<string, unknown> | null;
    expect(notDeclared).not.toBeNull();
    expect(notDeclared!.cause).toBe("flag_off");
  });

  it("REST status without storage reads null probes, never 500s", async () => {
    const sql = new SqliteTestStorage();
    const body = await statusBody(sql, undefined);
    expect(body.lastCycleFiringAttempt).toBeNull();
    expect(body.lastCycleNotDeclared).toBeNull();
  });
});
