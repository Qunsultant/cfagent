/**
 * Issue #4001 (follow-up) — a firing whose ledger write fails must say so.
 *
 * RED pins (TDD, written against main before the fix — each must FAIL
 * there and pass after):
 *
 * The 13:05 and 14:05 firings ran cleanly (stock_copilot.cycle audit,
 * status ok, errors 0) and left no runs-ledger row. The wrapper IS on
 * the cycle's path and the record's shape is valid for the cycle's exact
 * inputs, so the row write itself never landed — and the ONLY firing
 * write whose failure is silent is the ledger store: `storeRecord`
 * swallows ALL errors ("Recording never breaks the callback"). A
 * production-only failure inside `recordSync` is therefore unobservable.
 *
 * Fix: thread an optional `onRecordFailure` hook through
 * `recordScheduleCallbackRun` and wire it at the copilot call site to a
 * named `stock_copilot.ledger_write_failed` audit — so the next firing
 * either leaves the row or names the error. Recording still never breaks
 * the callback.
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
      throw new Error("generateText disabled in #4001 tests");
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

import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import {
  declareStockCopilotTasks,
  STOCK_COPILOT_TASK_ID,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { BROKER_ENVIRONMENT_SETTING_KEY } from "../src/agents/routes/brokerEnvironment";

/** Minimal D1Database stand-in over node:sqlite (the #6101 double). */
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
}

/**
 * Issue #6101 — a D1 binding whose ledger-row INSERTs fail, like the
 * production gap (the DO-sql throw this file used to inject). Schema
 * work and reads still succeed, so the failure is observable as a
 * missing row rather than a dead binding.
 */
class LedgerThrowingD1Database extends MockD1Database {
  override prepare(sql: string) {
    const bound = super.prepare(sql);
    return {
      bind(...params: unknown[]) {
        const stmt = bound.bind(...params);
        return {
          ...stmt,
          async run() {
            if (/INSERT\s+INTO\s+"?job_run_records"?/i.test(sql)) {
              throw new Error("D1 unavailable for job_run_records");
            }
            return stmt.run();
          },
        };
      },
    };
  }
}

/** The D1 run-ledger store over one mock binding (#6101). */
function ledgerD1(d1: MockD1Database) {
  return new D1JobRunRecordStore(createD1JobRunRecordDb(d1 as unknown as D1Database));
}

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

async function emptyCommercial(): Promise<InMemoryCommercialAdapter> {
  return new InMemoryCommercialAdapter();
}

const CYCLE_PAYLOAD = {
  scheduleId: STOCK_COPILOT_TASK_ID,
  trigger: "scheduled",
};
const CYCLE_SCHEDULE = { id: STOCK_COPILOT_TASK_ID };

/** The declared task's handler, invoked the way the Think SDK invokes it. */
async function runDeclaredHandler(
  sql: unknown,
  audits: Array<{ type: string; payload: Record<string, unknown> }>,
  // Issue #6101 — the firing records its ledger row in D1: the
  // handler resolves the store from env.AGENT_DB.
  d1: MockD1Database,
) {
  const settings = new Map<string, string>([
    ["stock_copilot:sessions", "pre_market,regular,after_hours,exto"],
    ["stock_copilot:universe", "NASDAQ100"],
    [BROKER_ENVIRONMENT_SETTING_KEY, "TEST"],
  ]);
  const tasks = await declareStockCopilotTasks({
    env: {
      STOCK_COPILOT_PAPER_ENABLED: "1",
      STOCK_COPILOT_AROUND_THE_CLOCK: "true",
      AGENT_DB: d1,
    } as any,
    agentCtx: { storage: { sql: sql as any } } as any,
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
  await tasks[STOCK_COPILOT_TASK_ID].handler({
    taskId: STOCK_COPILOT_TASK_ID,
    scheduledFor: Date.now(),
    scheduledForDate: new Date(),
    occurrenceKey: "4001-test-1",
    idempotencyKey: "4001-test-1",
    schedule: "every 1 hour",
    scheduleKind: "interval",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Issue #4001 — a ledger-write failure is reported, never swallowed", () => {
  it("a failing ledger store calls onRecordFailure with the job id and the error", async () => {
    const hook = vi.fn();
    const sql = { exec: () => { throw new Error("DO SQLite unavailable"); } };
    await recordScheduleCallbackRun(
      sql as any,
      "stock-copilot-paper-cycle",
      CYCLE_PAYLOAD,
      CYCLE_SCHEDULE,
      async () => ({ outcome: "success", descriptor: "cycle complete" }),
      // Issue #6101 — the failing store is the D1 binding now.
      { onRecordFailure: hook, env: { AGENT_DB: new LedgerThrowingD1Database() } },
    );
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: STOCK_COPILOT_TASK_ID,
        // The D1 stack wraps the injected store failure in
        // drizzle's "Failed query: insert into job_run_records ..."
        // — the hook carries the failed ledger statement, not the
        // raw injected message.
        error: expect.stringMatching(/job_run_records/),
      }),
    );
  });

  it("a failing ledger store never breaks the callback, with or without the hook", async () => {
    const sql = { exec: () => { throw new Error("DO SQLite unavailable"); } };
    const hook = vi.fn();
    await expect(
      recordScheduleCallbackRun(
        sql as any,
        "stock-copilot-paper-cycle",
        CYCLE_PAYLOAD,
        CYCLE_SCHEDULE,
        async () => ({ outcome: "success", descriptor: "cycle complete" }),
        // Issue #6101 — the failing store is the D1 binding now.
        { onRecordFailure: hook, env: { AGENT_DB: new LedgerThrowingD1Database() } },
      ),
    ).resolves.toBeUndefined();
    expect(hook).toHaveBeenCalledTimes(1);
    await expect(
      recordScheduleCallbackRun(
        sql as any,
        "stock-copilot-paper-cycle",
        CYCLE_PAYLOAD,
        CYCLE_SCHEDULE,
        async () => ({ outcome: "success", descriptor: "cycle complete" }),
        // Issue #6101 — the failing store is the D1 binding now.
        { env: { AGENT_DB: new LedgerThrowingD1Database() } },
      ),
    ).resolves.toBeUndefined();
  });

  it("a successful record never calls onRecordFailure", async () => {
    const sql = new SqliteTestStorage();
    const d1 = new MockD1Database();
    const hook = vi.fn();
    await recordScheduleCallbackRun(
      sql as any,
      "stock-copilot-paper-cycle",
      CYCLE_PAYLOAD,
      CYCLE_SCHEDULE,
      async () => ({ outcome: "success", descriptor: "cycle complete" }),
      // Issue #6101 — the ledger is D1: the store resolves from env.
      { onRecordFailure: hook, env: { AGENT_DB: d1 } },
    );
    expect(hook).not.toHaveBeenCalled();
    const store = ledgerD1(d1);
    expect((await store.listByJob(STOCK_COPILOT_TASK_ID)).length).toBe(1);
  });

  it("a throwing callback still rethrows AND reports its failed failure-record", async () => {
    const hook = vi.fn();
    const sql = { exec: () => { throw new Error("DO SQLite unavailable"); } };
    await expect(
      recordScheduleCallbackRun(
        sql as any,
        "stock-copilot-paper-cycle",
        CYCLE_PAYLOAD,
        CYCLE_SCHEDULE,
        async () => { throw new Error("platform exploded"); },
        // Issue #6101 — the failing store is the D1 binding now.
        { onRecordFailure: hook, env: { AGENT_DB: new LedgerThrowingD1Database() } },
      ),
    ).rejects.toThrow("platform exploded");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: STOCK_COPILOT_TASK_ID,
        // See the first test: drizzle wraps the injected failure
        // in "Failed query: insert into job_run_records ...".
        error: expect.stringMatching(/job_run_records/),
      }),
    );
  });

  it("a clean firing whose ledger store throws audits ledger_write_failed with the job id", async () => {
    const sql = new SqliteTestStorage();
    const d1 = new LedgerThrowingD1Database();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await runDeclaredHandler(sql, audits, d1);
    // The cycle itself completed (the callback ran to its audit).
    expect(audits.find((a) => a.type === "stock_copilot.cycle")).toBeDefined();
    // The failed ledger write is named, not swallowed.
    const failure = audits.find((a) => a.type === "stock_copilot.ledger_write_failed");
    expect(failure).toBeDefined();
    expect(failure?.payload.jobId).toBe(STOCK_COPILOT_TASK_ID);
    expect(String(failure?.payload.error ?? "")).toMatch(/job_run_records/);
    // And no ledger row exists — the write really did fail (the
    // failing D1 binding still answers reads, so read it back
    // through the D1 store).
    const store = ledgerD1(d1);
    expect((await store.listByJob(STOCK_COPILOT_TASK_ID)).length).toBe(0);
  });
});
