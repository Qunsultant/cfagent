/**
 * Issue #5085 (S6, observability program #5080) — one runs ledger,
 * one source of truth for "did the run happen".
 *
 * RED pins (TDD, written against main d07039eb before the fix —
 * each must FAIL there and pass after):
 *
 * 1. The Loop status reads the LEDGER, never the activity table:
 *    a ledger row with no activity record still yields a lastCycle
 *    (today: lastCycle is null — the status reads activity only,
 *    the ledger is just the neverExecuted corroboration). And an
 *    activity record with NO ledger row yields NO lastCycle and
 *    neverExecuted (today: activity alone clears neverExecuted and
 *    supplies lastCycle — the two stores can disagree, the #4001
 *    shape). The door, the REST status route, and the introspection
 *    lastCycleStatus all follow the ledger.
 *
 * 2. The cycle outcome class rides the ledger row: the ledger
 *    descriptor names traded / no trade / refused / inactive /
 *    outside sessions (today: "cycle complete" carries no outcome
 *    class, so a ledger-derived lastCycle could not render the
 *    panel's badge).
 *
 * 3. A failed ledger write is NAMED through one shared namer:
 *    every recordScheduleCallbackRun site names the failure — the
 *    copilot site wires an explicit onRecordFailure hook, the nine
 *    orchestrator.ts sites pass their `audit` sink and the shared
 *    namer applies by default, and a site with neither still gets
 *    the coded OBS-1020 log floor (today: only the copilot site
 *    wires the hook, with an inline audit and no coded log; the
 *    other nine schedule callbacks swallow silently). The default
 *    (not a per-site hook in orchestrator.ts) keeps that file at
 *    the #992 line budget of 3325.
 *
 * Pins (already true on main — regression guards, not Red):
 *  - a run with no artifact still records its job/run ids (#4002).
 *  - a cycle row written through the one entry is listed by the
 *    ledger read the runs view uses.
 *
 * Behaviour-change note: the #3899 test "a cycle ledger row without
 * activity also clears the never-executed state" pins lastCycle
 * null for that state; S6 reverses it deliberately (the ledger row
 * IS the lastCycle now) — that test is updated in this slice, not
 * deleted.
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
      throw new Error("generateText disabled in #5085 tests");
    }),
  };
});
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

import { recordScheduleCallbackRun, nameLedgerWriteFailure } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import {
  latestCopilotCycleLedgerRow,
  projectCopilotLedgerRowToLastCycle,
} from "../src/services/stockCopilotLedger";
import { copilotCycleLedgerOutcome } from "../src/services/scheduleWatchdog";
import { OBS_LEDGER_WRITE_FAILED } from "../src/observability/otelMessages";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import {
  getStockCopilotStatusViaDoor,
  type StockCopilotDoorContext,
} from "../src/agents/orchestrator/meshStockCopilotDoor";
import { introspectStockCopilot } from "../src/services/stockCopilotIntrospection";
import { handleStockCopilotRoutes } from "../src/agents/routes/stockCopilot";
import {
  createStockCopilotActivityPort,
  createStockCopilotPositionPort,
  createStockCopilotControlPort,
} from "../src/data/createStockCopilotStorePorts";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { STOCK_COPILOT_TASK_ID } from "../src/agents/orchestrator/scheduledTasksCopilot";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";

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

/** Minimal D1Database stand-in over node:sqlite (the J1 suite's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
  async batch(stmts: { run: () => Promise<unknown> }[]) {
    return Promise.all(stmts.map((stmt) => stmt.run()));
  }
}

/** A fresh D1 ledger store over an in-memory mock binding (#6101). */
function ledgerD1() {
  const d1 = new MockD1Database();
  const store = new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
  return { d1, store };
}

async function emptyCommercial(): Promise<InMemoryCommercialAdapter> {
  return new InMemoryCommercialAdapter();
}

function makeDoorCtx(
  sql: SqliteTestStorage,
  d1: MockD1Database,
  overrides: Partial<StockCopilotDoorContext> = {},
): StockCopilotDoorContext {
  const settings = new Map<string, string>([
    ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
  ]);
  return {
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      STOCK_COPILOT_AROUND_THE_CLOCK: "true",
      // Issue #6101 — the door reads the D1 ledger.
      AGENT_DB: d1,
    } as any,
    sql: sql as any,
    readSettingRaw: (k: string) => settings.get(k) ?? null,
    writeSetting: (k: string, v: string) => settings.set(k, v),
    audit: vi.fn(),
    ...overrides,
  };
}

async function seedLedgerRow(
  store: D1JobRunRecordStore,
  started: string,
  outcome: "success" | "skipped" | "failure" = "success",
  descriptor = "cycle complete: no trade",
  detail?: string,
) {
  // Issue #6101 — the seed lands in D1, not the DO.
  await store.record(
    buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: STOCK_COPILOT_TASK_ID,
      operation: STOCK_COPILOT_TASK_ID,
      started,
      finished: started,
      outcome,
      triggeredBy: "scheduled",
      trigger: "scheduled",
      scheduleId: STOCK_COPILOT_TASK_ID,
      asyncJobId: null,
      workflowId: null,
      descriptor,
      ...(detail ? { detail } : {}),
    }),
  );
}

function seedActivity(
  sql: SqliteTestStorage,
  cycleAt: string,
  outcome: "traded" | "no_trade" | "refused" | "inactive" | "outside_sessions" = "no_trade",
) {
  const activity = createStockCopilotActivityPort(sql as any);
  activity.ensureSchema();
  activity.appendActivity({
    id: `act-${cycleAt}`,
    userLogin: "owner",
    cycleAt,
    outcome,
    session: "regular",
    entries: [],
    exits: [],
    detail: null,
    mode: "deterministic",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Issue #5085 — a run with no artifact still records its job/run ids (#4002 rule, pin)", () => {
  it("records the job id, operation and outcome with no artifact refs", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    await recordScheduleCallbackRun(
      sql as any,
      "stock-copilot-paper-cycle",
      { scheduleId: STOCK_COPILOT_TASK_ID, trigger: "scheduled" },
      { id: STOCK_COPILOT_TASK_ID },
      async () => ({ outcome: "success", descriptor: "cycle complete: no trade" }),
      // Issue #6101 — the callback recorder resolves the D1 store from env.
      { env: { AGENT_DB: d1 } },
    );
    const rows = await store.listByJob(STOCK_COPILOT_TASK_ID);
    expect(rows.length).toBe(1);
    expect(rows[0].jobId).toBe(STOCK_COPILOT_TASK_ID);
    expect(rows[0].operation).toBe("stock-copilot-paper-cycle");
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].artifactRefs).toBeUndefined();
  });
});

describe("Issue #5085 — the Loop status reads the ledger (door)", () => {
  it("a ledger row with no activity record still yields a lastCycle", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    const started = new Date().toISOString();
    await seedLedgerRow(store, started, "success", "cycle complete: no trade");
    const ctx = makeDoorCtx(sql, d1, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.neverExecuted).toBe(false);
    expect(status.lastCycle).not.toBeNull();
    expect((status.lastCycle as Record<string, unknown>).cycleAt).toBe(started);
    expect((status.lastCycle as Record<string, unknown>).outcome).toBe("no_trade");
    expect(status.status).toBe("live");
  });

  it("an activity record with no ledger row yields no lastCycle and never_executed", async () => {
    const sql = new SqliteTestStorage();
    const { d1 } = ledgerD1();
    seedActivity(sql, new Date().toISOString(), "no_trade");
    const ctx = makeDoorCtx(sql, d1, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect(status.lastCycle).toBeNull();
    expect(status.neverExecuted).toBe(true);
    expect(status.status).toBe("never_executed");
    // The activity feed still lists the record — it is detail, not
    // the source of truth for "did it run".
    expect(status.activity.length).toBe(1);
  });

  it("with both present, lastCycle comes from the ledger, not the activity row", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    const ledgerAt = "2026-11-04T15:00:00.000Z";
    const activityAt = "2026-11-04T14:00:00.000Z";
    await seedLedgerRow(store, ledgerAt, "success", "cycle complete: traded");
    seedActivity(sql, activityAt, "no_trade");
    const ctx = makeDoorCtx(sql, d1, { commercial: await emptyCommercial() });
    const status = await getStockCopilotStatusViaDoor(ctx, "owner");
    expect((status.lastCycle as Record<string, unknown>).cycleAt).toBe(ledgerAt);
    expect((status.lastCycle as Record<string, unknown>).outcome).toBe("traded");
    expect(status.activity.length).toBe(1);
  });
});

describe("Issue #5085 — the Loop status reads the ledger (REST route + introspection)", () => {
  it("REST status: a ledger row with no activity record yields a lastCycle", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    const started = new Date().toISOString();
    await seedLedgerRow(store, started, "success", "cycle complete: no trade");
    const settings = new Map<string, string>([
      ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
    ]);
    const req = new Request("http://localhost/api/stock-copilot/status", {
      method: "GET",
    });
    const res = await handleStockCopilotRoutes(req, new URL(req.url), "/api/stock-copilot/status", "session-1", {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: "1",
        STOCK_COPILOT_AROUND_THE_CLOCK: "true",
        // Issue #6101 — the route reads the D1 ledger.
        AGENT_DB: d1,
      } as any,
      sql: sql as any,
      getScreenerExecutionContext: async () => ({
        userLogin: "owner",
        environment: "TEST" as const,
      }),
      readSettingRaw: (key: string) =>
        key === BROKER_ENVIRONMENT_SETTING_KEY ? "TEST" : (settings.get(key) ?? null),
      commercial: await emptyCommercial(),
      audit: vi.fn(),
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, unknown>;
    expect(body.neverExecuted).toBe(false);
    expect(body.lastCycle).not.toBeNull();
    expect((body.lastCycle as Record<string, unknown>).cycleAt).toBe(started);
    expect(body.status).toBe("live");
  });

  it("introspection: lastCycleStatus comes from the ledger, not activity", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    const started = new Date().toISOString();
    await seedLedgerRow(store, started, "success", "cycle complete: traded");
    const positionPort = createStockCopilotPositionPort(sql as any);
    const activityPort = createStockCopilotActivityPort(sql as any);
    const controlPort = createStockCopilotControlPort(sql as any);
    positionPort.ensureSchema();
    activityPort.ensureSchema();
    controlPort.ensureSchema();
    const result = await introspectStockCopilot({
      // Issue #6101 — introspection reads the D1 ledger.
      env: { STOCK_COPILOT_PAPER_ENABLED: "true", AGENT_DB: d1 } as any,
      userLogin: "owner",
      readSettingRaw: () => null,
      positionPort,
      activityPort,
      controlPort,
      commercial: await emptyCommercial(),
      sql: sql as any,
    });
    expect(result.telemetry.lastCycleStatus).toBe("traded");
  });

  it("introspection: activity with no ledger row reads no last cycle", async () => {
    const sql = new SqliteTestStorage();
    const { d1 } = ledgerD1();
    seedActivity(sql, new Date().toISOString(), "no_trade");
    const positionPort = createStockCopilotPositionPort(sql as any);
    const activityPort = createStockCopilotActivityPort(sql as any);
    const controlPort = createStockCopilotControlPort(sql as any);
    positionPort.ensureSchema();
    activityPort.ensureSchema();
    controlPort.ensureSchema();
    const result = await introspectStockCopilot({
      // Issue #6101 — introspection reads the D1 ledger.
      env: { STOCK_COPILOT_PAPER_ENABLED: "true", AGENT_DB: d1 } as any,
      userLogin: "owner",
      readSettingRaw: () => null,
      positionPort,
      activityPort,
      controlPort,
      commercial: await emptyCommercial(),
      sql: sql as any,
    });
    expect(result.telemetry.lastCycleStatus).toBeNull();
  });
});

describe("Issue #5085 — the cycle outcome class rides the ledger row", () => {
  it("an ok cycle with placements descriptors as traded", () => {
    const out = copilotCycleLedgerOutcome("ok", undefined, { entriesPlaced: 1, exitsPlaced: 0 });
    expect(out.outcome).toBe("success");
    expect(out.descriptor ?? "").toMatch(/traded/);
  });

  it("an ok cycle with no placements descriptors as no trade", () => {
    const out = copilotCycleLedgerOutcome("ok", undefined, { entriesPlaced: 0, exitsPlaced: 0 });
    expect(out.outcome).toBe("success");
    expect(out.descriptor ?? "").toMatch(/no trade/);
  });

  it("refusals project to their class: refused, inactive, outside sessions", () => {
    // The outcome class rides the ledger row. For refusals it is the
    // detail — kept byte-identical for the #3788 pin (which toEquals
    // the mapping) — and the projection reads descriptor, then detail.
    const cases: Array<{
      status: Parameters<typeof copilotCycleLedgerOutcome>[0];
      refusal?: string;
      expected: string;
    }> = [
      { status: "mode_unresolved", refusal: "mode_unresolved", expected: "refused" },
      { status: "refused_mode_mismatch", refusal: "mode_unresolved", expected: "refused" },
      { status: "inactive_broker", refusal: "unsupported_broker", expected: "inactive" },
      { status: "outside_enabled_sessions", expected: "outside_sessions" },
      { status: "paused", expected: "inactive" },
      { status: "disabled", expected: "inactive" },
    ];
    for (const c of cases) {
      const mapped = copilotCycleLedgerOutcome(c.status, c.refusal);
      const projected = projectCopilotLedgerRowToLastCycle(
        buildJobRunRecord({
          system: "orchestrator-schedule",
          jobId: STOCK_COPILOT_TASK_ID,
          operation: STOCK_COPILOT_TASK_ID,
          started: "2026-11-04T15:00:00.000Z",
          finished: "2026-11-04T15:00:00.000Z",
          outcome: mapped.outcome,
          triggeredBy: "scheduled",
          trigger: "scheduled",
          scheduleId: STOCK_COPILOT_TASK_ID,
          asyncJobId: null,
          workflowId: null,
          ...(mapped.descriptor ? { descriptor: mapped.descriptor } : {}),
          ...(mapped.detail ? { detail: mapped.detail } : {}),
        }),
      );
      expect(projected.outcome).toBe(c.expected);
    }
  });

  it("the projection parses the descriptor into the panel outcome", () => {
    const traded = projectCopilotLedgerRowToLastCycle(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: STOCK_COPILOT_TASK_ID,
        operation: STOCK_COPILOT_TASK_ID,
        started: "2026-11-04T15:00:00.000Z",
        finished: "2026-11-04T15:00:00.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: STOCK_COPILOT_TASK_ID,
        asyncJobId: null,
        workflowId: null,
        descriptor: "cycle complete: traded",
      }),
    );
    expect(traded.outcome).toBe("traded");
    expect(traded.cycleAt).toBe("2026-11-04T15:00:00.000Z");
  });

  it("the projection falls back honestly for legacy rows without an outcome token", () => {
    const legacy = projectCopilotLedgerRowToLastCycle(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: STOCK_COPILOT_TASK_ID,
        operation: STOCK_COPILOT_TASK_ID,
        started: "2026-11-04T15:00:00.000Z",
        finished: "2026-11-04T15:00:00.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: STOCK_COPILOT_TASK_ID,
        asyncJobId: null,
        workflowId: null,
        descriptor: "cycle complete",
      }),
    );
    expect(legacy.outcome).toBe("no_trade");
    const legacyRefused = projectCopilotLedgerRowToLastCycle(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: STOCK_COPILOT_TASK_ID,
        operation: STOCK_COPILOT_TASK_ID,
        started: "2026-11-04T15:00:00.000Z",
        finished: "2026-11-04T15:00:00.000Z",
        outcome: "skipped",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: STOCK_COPILOT_TASK_ID,
        asyncJobId: null,
        workflowId: null,
        detail: "cycle refused: mode_unresolved",
      }),
    );
    expect(legacyRefused.outcome).toBe("refused");
  });

  it("latestCopilotCycleLedgerRow takes the newest of the task and callback ids", async () => {
    // Issue #6101 — the read takes the D1 store now.
    const { store } = ledgerD1();
    await store.record(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: `callback:${STOCK_COPILOT_TASK_ID}`,
        operation: `callback:${STOCK_COPILOT_TASK_ID}`,
        started: "2026-11-04T14:00:00.000Z",
        finished: "2026-11-04T14:00:00.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: null,
        asyncJobId: null,
        workflowId: null,
        descriptor: "cycle complete: no trade",
      }),
    );
    await store.record(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: STOCK_COPILOT_TASK_ID,
        operation: STOCK_COPILOT_TASK_ID,
        started: "2026-11-04T15:00:00.000Z",
        finished: "2026-11-04T15:00:00.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
        trigger: "scheduled",
        scheduleId: STOCK_COPILOT_TASK_ID,
        asyncJobId: null,
        workflowId: null,
        descriptor: "cycle complete: traded",
      }),
    );
    const latest = await latestCopilotCycleLedgerRow(store);
    expect(latest?.started).toBe("2026-11-04T15:00:00.000Z");
    expect(await latestCopilotCycleLedgerRow(ledgerD1().store)).toBeUndefined();
  });
});

describe("Issue #5085 — a failed ledger write is named through one shared namer", () => {
  it("the namer audits the failure and logs coded OBS-1020", async () => {
    const audit = vi.fn();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const namer = nameLedgerWriteFailure(audit, "schedule.ledger_write_failed");
    namer({
      jobId: "autonomousMarketScreen",
      operation: "autonomousMarketScreen",
      outcome: "success",
      error: "DO SQLite unavailable for job_run_records",
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      "schedule.ledger_write_failed",
      "orchestrator",
      expect.objectContaining({
        code: "ledger_write_failed",
        jobId: "autonomousMarketScreen",
        error: expect.stringMatching(/DO SQLite unavailable/),
      }),
    );
    const logged = infoSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain(OBS_LEDGER_WRITE_FAILED);
    expect(OBS_LEDGER_WRITE_FAILED).toBe("OBS-1020");
  });

  it("a throwing hook inside the namer never breaks the callback", async () => {
    const audit = vi.fn(() => {
      throw new Error("audit exploded");
    });
    const namer = nameLedgerWriteFailure(audit, "schedule.ledger_write_failed");
    expect(() =>
      namer({
        jobId: "autonomousMarketScreen",
        operation: "autonomousMarketScreen",
        outcome: "success",
        error: "DO SQLite unavailable",
      }),
    ).not.toThrow();
  });

  it("a failing store wired through the namer names the failure and never breaks the callback", async () => {
    const audit = vi.fn();
    const sql = { exec: () => { throw new Error("DO SQLite unavailable"); } };
    await expect(
      recordScheduleCallbackRun(
        sql as any,
        "autonomousMarketScreen",
        { scheduleId: "autonomousMarketScreen", trigger: "scheduled" },
        { id: "autonomousMarketScreen" },
        async () => ({ outcome: "success", descriptor: "screen complete" }),
        { onRecordFailure: nameLedgerWriteFailure(audit, "schedule.ledger_write_failed") },
      ),
    ).resolves.toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      "schedule.ledger_write_failed",
      "orchestrator",
      expect.objectContaining({ jobId: "autonomousMarketScreen" }),
    );
  });

  it("the audit option applies the shared namer by default (no explicit hook)", async () => {
    const audit = vi.fn();
    const sql = { exec: () => { throw new Error("DO SQLite unavailable"); } };
    await expect(
      recordScheduleCallbackRun(
        sql as any,
        "autonomousMarketScreen",
        { scheduleId: "autonomousMarketScreen", trigger: "scheduled" },
        { id: "autonomousMarketScreen" },
        async () => ({ outcome: "success", descriptor: "screen complete" }),
        { audit },
      ),
    ).resolves.toBeUndefined();
    expect(audit).toHaveBeenCalledWith(
      "schedule.ledger_write_failed",
      "orchestrator",
      expect.objectContaining({ jobId: "autonomousMarketScreen" }),
    );
  });

  it("a site with no hook and no audit still logs coded OBS-1020 (the floor)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const sql = { exec: () => { throw new Error("DO SQLite unavailable"); } };
    await expect(
      recordScheduleCallbackRun(
        sql as any,
        "autonomousMarketScreen",
        { scheduleId: "autonomousMarketScreen", trigger: "scheduled" },
        { id: "autonomousMarketScreen" },
        async () => ({ outcome: "success", descriptor: "screen complete" }),
      ),
    ).resolves.toBeUndefined();
    const logged = infoSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).toContain(OBS_LEDGER_WRITE_FAILED);
  });
});

describe("Issue #5085 — the runs view reads the ledger (pin)", () => {
  it("a cycle row written through the one entry is listed by the ledger read", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    await recordScheduleCallbackRun(
      sql as any,
      "stock-copilot-paper-cycle",
      { scheduleId: STOCK_COPILOT_TASK_ID, trigger: "scheduled" },
      { id: STOCK_COPILOT_TASK_ID },
      async () => ({ outcome: "success", descriptor: "cycle complete: traded" }),
      // Issue #6101 — the callback recorder resolves the D1 store from env.
      { env: { AGENT_DB: d1 } },
    );
    const recent = await store.listRecent(10);
    expect(recent.some((r) => r.jobId === STOCK_COPILOT_TASK_ID)).toBe(true);
  });
});

describe("Issue #5085 — every job/run writes through the one entry", () => {
  it("agent-schedule action rows land in the one ledger via the DO deps", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    const { createAgentScheduleExecutorDepsForDo } = await import(
      "../src/services/agentScheduleCapability"
    );
    const deps = createAgentScheduleExecutorDepsForDo(
      // Issue #6101 — the deps' recordLedger writes the D1 ledger.
      { AGENT_DB: d1 } as any,
      sql as any,
      () => {},
      {},
    );
    const record = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "agent-schedule-action-test",
      operation: "agent.schedule.test",
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
      outcome: "success",
      triggeredBy: "manual",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
      detail: "test",
    });
    await deps.recordLedger(record);
    const rows = await store.listByJob("agent-schedule-action-test");
    expect(rows.length).toBe(1);
    expect(rows[0].operation).toBe("agent.schedule.test");
    // The routing itself (recordLedger -> recordLedgerRunD1, never a
    // direct store.record) is verified by grep: the only
    // D1JobRunRecordStore.record call in src is
    // createJobRunRecordPorts.ts's recordLedgerRunD1 (#6101).
  });
});
