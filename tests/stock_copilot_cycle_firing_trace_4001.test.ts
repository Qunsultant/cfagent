/**
 * Issue #4001 — Stock Copilot cycle still never fired: the 9:05 slot was
 * consumed with no execution (#3899 fix did not hold).
 *
 * RED pins (TDD, written against main before the fix — each must FAIL
 * there and pass after):
 *
 * The 9:05 firing dispatched — the Think SDK advanced the schedule to
 * 10:05:08, which only happens in `_runDeclaredScheduledTask`'s
 * `finally` after the handler-invocation try is entered — but left
 * zero trace: no runs-ledger row, no cycle audit, no `cycle_failed`
 * audit, no activity record. Cause: in
 * `runStockCopilotCycleForInstance` the trace wrapper
 * `recordScheduleCallbackRun` starts AFTER the failure-prone setup
 * (trading selection / platform construction / sessions / universe
 * resolution). A throw in any of them skips the ledger entirely, and
 * the only backup (the `cycle_failed` audit) swallows its own
 * failures.
 *
 * Fix: move ALL firing setup inside the `recordScheduleCallbackRun`
 * callback, so any throw there yields a named failure ledger row.
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

import {
  declareStockCopilotTasks,
  STOCK_COPILOT_TASK_ID,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import { TradingPlatformRegistry } from "../src/trading";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
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

async function emptyCommercial(): Promise<InMemoryCommercialAdapter> {
  return new InMemoryCommercialAdapter();
}

/** The declared task's handler, invoked the way the Think SDK invokes it. */
async function runDeclaredHandler(
  sql: SqliteTestStorage,
  audits: Array<{ type: string; payload: Record<string, unknown> }>,
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
  // taskId is the DECLARED task id (what the SDK passes), so the
  // ledger row's jobId resolves to STOCK_COPILOT_TASK_ID — the same
  // id the status surface reads.
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

describe("Issue #4001 — a firing whose setup throws still leaves a trace", () => {
  it("a platform-construction throw records a failure ledger row for the cycle", async () => {
    const sql = new SqliteTestStorage();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    vi.spyOn(TradingPlatformRegistry, "getPlatform").mockImplementation(
      () => {
        throw new Error("Trading platform [alpaca] is not registered.");
      },
    );
    // The handler catches internally (it never throws out), so the
    // firing "completes" — the question is only whether it left a
    // trace.
    await runDeclaredHandler(sql, audits);
    const store = new SqlJobRunRecordStore(sql as any);
    const rows = store.listByJob(STOCK_COPILOT_TASK_ID);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("failure");
    expect(rows[0].error).toMatch(/not registered/);
    // The backup signal still fires too.
    expect(
      audits.find((a) => a.type === "stock_copilot.cycle_failed"),
    ).toBeDefined();
  });

  it("a successful firing records exactly one ledger row (no double-recording)", async () => {
    const sql = new SqliteTestStorage();
    const audits: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    await runDeclaredHandler(sql, audits);
    const store = new SqlJobRunRecordStore(sql as any);
    const rows = store.listByJob(STOCK_COPILOT_TASK_ID);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).not.toBe("failure");
    expect(
      audits.find((a) => a.type === "stock_copilot.cycle"),
    ).toBeDefined();
  });
});
