// @vitest-environment node
/**
 * Issue #3788 (parent incident #3781) — copilot Think task watchdog.
 *
 * "Copilot never ran" must be distinguishable from "copilot ran and did
 * nothing": the non-declaration paths each emit an auditable signal with
 * a cause class (flag_off / no_login_context / context_error), the
 * no-SQL early return audits with a cause, a handler failure audits
 * with an error CODE instead of being swallowed, and every firing is
 * recorded in the runs ledger.
 *
 * TDD Red: declareStockCopilotTasks emits no signal today; the early
 * return is silent; the handler swallows with .catch(() => {}); Think
 * task firings leave no ledger record.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  declareStockCopilotTasks,
  runStockCopilotCycleForInstance,
  STOCK_COPILOT_TASK_ID,
  type ScheduledTasksCopilotContext,
} from "../src/agents/orchestrator/scheduledTasksCopilot";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";

/** SqlStorage-shaped executor over node:sqlite (same shim as #3784). */
function makeSql(db: DatabaseSync) {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
}

interface AuditEvent {
  type: string;
  payload: Record<string, unknown>;
}

function baseCtx(overrides: Partial<ScheduledTasksCopilotContext> = {}): {
  ctx: ScheduledTasksCopilotContext;
  audits: AuditEvent[];
} {
  const audits: AuditEvent[] = [];
  // Each harness gets its own storage map, so the non-declaration
  // dedup state is isolated per test (production: the agent's own
  // storage, shared across declarations on the instance).
  const dedupStore = new Map<string, unknown>();
  const ctx = {
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as any,
    agentCtx: {
      storage: {
        get: async (k: string) => dedupStore.get(k),
        put: async (k: string, v: unknown) => void dedupStore.set(k, v),
      },
    } as any,
    getOrm: () => undefined,
    readSettingRaw: () => null,
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    ...overrides,
  } as unknown as ScheduledTasksCopilotContext;
  return { ctx, audits };
}

describe("copilot non-declaration signal (#3788)", () => {
  it("audits flag_off when the flag is off", async () => {
    const { ctx, audits } = baseCtx({
      env: {} as any,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    expect(await declareStockCopilotTasks(ctx)).toEqual({});
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("stock_copilot.not_declared");
    expect(audits[0].payload.code).toBe("flag_off");
    expect(audits[0].payload.taskId).toBe(STOCK_COPILOT_TASK_ID);
  });

  it("audits no_login_context when the instance holds no login", async () => {
    const { ctx, audits } = baseCtx({
      getScreenerExecutionContext: async () => undefined,
    });
    expect(await declareStockCopilotTasks(ctx)).toEqual({});
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("stock_copilot.not_declared");
    expect(audits[0].payload.code).toBe("no_login_context");
  });

  it("audits context_error when the execution-context read throws", async () => {
    const { ctx, audits } = baseCtx({
      getScreenerExecutionContext: async () => {
        throw new Error("context store down");
      },
    });
    expect(await declareStockCopilotTasks(ctx)).toEqual({});
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("stock_copilot.not_declared");
    expect(audits[0].payload.code).toBe("context_error");
  });

  it("dedupes: the same cause does not re-audit on the next declaration", async () => {
    const { ctx, audits } = baseCtx({
      env: {} as any,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    await declareStockCopilotTasks(ctx);
    await declareStockCopilotTasks(ctx);
    expect(audits).toHaveLength(1);
  });

  it("re-audits when the cause class changes", async () => {
    const { ctx, audits } = baseCtx({
      env: {} as any,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    await declareStockCopilotTasks(ctx);
    expect(audits).toHaveLength(1);
    expect(audits[0].payload.code).toBe("flag_off");
    // Same module dedup state, new cause class: flag on but no login.
    (ctx as any).env = { STOCK_COPILOT_PAPER_ENABLED: "1" };
    (ctx as any).getScreenerExecutionContext = async () => undefined;
    await declareStockCopilotTasks(ctx);
    expect(audits).toHaveLength(2);
    expect(audits[1].payload.code).toBe("no_login_context");
  });

  it("emits no signal when the task is declared", async () => {
    const { ctx, audits } = baseCtx({
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    const tasks = await declareStockCopilotTasks(ctx);
    expect(Object.keys(tasks)).toHaveLength(1);
    expect(audits).toHaveLength(0);
  });
});

describe("copilot early-return signal (#3788)", () => {
  it("audits no_sql_storage when there is no SQL storage", async () => {
    const { ctx, audits } = baseCtx();
    await runStockCopilotCycleForInstance(
      ctx,
      { userLogin: "owner", environment: "TEST" } as any,
      { taskId: STOCK_COPILOT_TASK_ID } as any,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].type).toBe("stock_copilot.no_sql_storage");
    expect(audits[0].payload.code).toBe("no_sql_storage");
    expect(audits[0].payload.taskId).toBe(STOCK_COPILOT_TASK_ID);
    expect(audits[0].payload.userLogin).toBe("owner");
  });
});

describe("copilot handler failure + firing ledger record (#3788)", () => {
  it("audits cycle_failed with a code when the cycle throws (not swallowed)", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);
    const { ctx, audits } = baseCtx({
      agentCtx: { storage: { sql } } as any,
      // getOrm throws before the cycle runs: the handler's catch must
      // audit the failure with a code instead of swallowing silently.
      getOrm: () => {
        throw new Error("orm unavailable");
      },
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    const tasks = await declareStockCopilotTasks(ctx);
    const handler = tasks[STOCK_COPILOT_TASK_ID].handler;
    expect(typeof handler).toBe("function");
    await expect(handler({ taskId: STOCK_COPILOT_TASK_ID } as any)).resolves.toBeUndefined();
    const failed = audits.filter((a) => a.type === "stock_copilot.cycle_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload.code).toBe("cycle_failed");
    expect(failed[0].payload.taskId).toBe(STOCK_COPILOT_TASK_ID);
  });

  it("records a firing in the runs ledger when the cycle runs", async () => {
    const db = new DatabaseSync(":memory:");
    const sql = makeSql(db);
    const { ctx, audits } = baseCtx({
      // Flag off inside the cycle: it short-circuits to "disabled"
      // before touching the platform, so the firing is observable
      // without network or broker credentials.
      env: {} as any,
      agentCtx: { storage: { sql } } as any,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
    });
    await runStockCopilotCycleForInstance(
      ctx,
      { userLogin: "owner", environment: "TEST" } as any,
      { taskId: STOCK_COPILOT_TASK_ID, scheduledFor: Date.now(), occurrenceKey: "occ-1", idempotencyKey: "idem-1", schedule: "every 30 minutes", scheduleKind: "interval" } as any,
    );
    const store = new SqlJobRunRecordStore(sql as never);
    const latest = store.latestByJob(STOCK_COPILOT_TASK_ID);
    expect(latest).toBeDefined();
    expect(latest?.outcome).toBe("skipped");
    expect(latest?.detail).toBe("cycle disabled");
    // The per-firing cycle audit still fires.
    expect(audits.some((a) => a.type === "stock_copilot.cycle")).toBe(true);
  });
});
