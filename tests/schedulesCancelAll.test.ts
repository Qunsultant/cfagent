import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";

/** Minimal D1Database stand-in over node:sqlite (same as the #6503 repro). */
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
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
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
  async batch(statements: any[]) {
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

const PATH = "/api/schedules/cancel-all";

/**
 * Issue #6503 step 8 (G1) — cancel-all is a control op touching
 * every schedule including the platform-level system rows, so the
 * whole route (preview included) is platform-admin only. The
 * fixture calls as a platform-admin. Alias KV + membership store
 * stubs, same shape as
 * tests/schedule-6482-runaway-alarm-loop.test.ts.
 */
const ADMIN_LOGIN = "venus-admin";
const ADMIN_USER_ID = "user-admin-1";

function stubKv(entries: Record<string, string>) {
  const store = new Map<string, string>();
  for (const [login, userId] of Object.entries(entries)) {
    store.set(`iaaa-alias:login:${login}`, JSON.stringify({ internalUserId: userId }));
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function stubMembershipStore(adminIds: string[]) {
  return {
    getMembershipsByUser: async (internalUserId: string) =>
      adminIds.includes(internalUserId)
        ? [
            {
              membershipId: "m-admin-1",
              internalUserId,
              tenantId: "platform",
              roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
              createdBy: "test",
              createdAtMs: 1,
            },
          ]
        : [],
    put: async () => {},
    revokeMembership: async () => false,
  };
}

function pausedRow(id: string) {
  return {
    id,
    callback: "autonomousOptionsAnalysis",
    payload_json: null,
    sched_type: "cron",
    cron: "30 12 * * 1-5",
    interval_seconds: null,
    time: null,
    delay_seconds: null,
    paused_at: "2026-10-29T00:00:00.000Z",
  };
}

function makeCtx(opts: {
  schedules?: Array<{ id: string; callback: string }>;
  cancel?: (id: string) => Promise<boolean>;
  pausedIds?: string[];
}) {
  const cancelled: string[] = [];
  const cancelFn =
    opts.cancel ??
    (async (id: string) => {
      cancelled.push(id);
      return true;
    });
  const sql = {
    exec: (query: string) => {
      if (query.includes("SELECT")) return (opts.pausedIds ?? []).map(pausedRow);
      return [];
    },
  };
  // Issue #6503 step 8 (G1) — the route reads the paused count
  // from the D1 store, not the DO-sql stub: the fixture binds a
  // MockD1 AGENT_DB and seeds one paused stored row per pausedId
  // (pre-existing D1-cutover gap in this fixture — the route
  // counted 0 paused rows here before the gate landed).
  const d1 = new MockD1Database();
  const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
  const seedPaused = (async () => {
    // The D1 store seeds goal rows on schema-ensure; clear them so
    // the paused count is exactly the pausedIds (same as the step-7
    // fixtures' seedStoredSystemRows).
    for (const goal of await store.listByKind("goal")) {
      await store.remove(goal.id);
    }
    for (const id of opts.pausedIds ?? []) {
      const record: UnifiedScheduleRecord = {
        id,
        kind: "screen",
        state: "paused",
        callback: "autonomousOptionsAnalysis",
        definition: {
          type: "interval",
          intervalSeconds: 2_592_000,
          callback: "autonomousOptionsAnalysis",
        } as unknown as UnifiedScheduleRecord["definition"],
        ownerLogin: null,
        provenance: { origin: "user", createdBy: "venus", reason: id, createdAt: "2026-10-29T00:00:00.000Z" },
        alarmId: null,
        pausedAt: "2026-10-29T00:00:00.000Z",
        createdAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z",
      };
      await store.save(record);
    }
  })();
  const ctx = {
    env: { AGENT_DB: d1 },
    agentCtx: { storage: { sql } },
    audit: vi.fn(),
    // Issue #6503 step 9 (G2) — cancel-all audits-before-write
    // through this store; without it the wired fallback (no
    // SESSION_STORE in tests) blocks every confirmed cancel with 503.
    auditStore: createMemoryAuditStore(),
    listSchedules: vi.fn(async () => opts.schedules ?? []),
    cancelSchedule: vi.fn(cancelFn),
    getScheduleById: vi.fn(async () => undefined),
    getScreenerExecutionContext: vi.fn(async () => undefined),
    flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID }),
    flagMembershipStore: stubMembershipStore([ADMIN_USER_ID]),
  } as unknown as SchedulesRouteContext;
  return { ctx, cancelled, seedPaused };
}

async function postCancelAll(ctx: unknown, body: Record<string, unknown>) {
  const req = new Request(`https://agent.test${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-login": ADMIN_LOGIN },
    body: JSON.stringify(body),
  });
  const res = await handleSchedulesRoutes(
    req,
    new URL(`https://agent.test${PATH}`),
    PATH,
    "session-1",
    ctx as SchedulesRouteContext,
  );
  return { status: res!.status, body: (await res!.json()) as any };
}

const QUEUE = [
  { id: "v95599sHp", callback: "autonomousStockScreen" },
  { id: "_D6hWyU_S", callback: "executeAsyncJob" },
];

describe("POST /api/schedules/cancel-all (#2280)", () => {
  it("without confirm returns the preview and cancels nothing", async () => {
    const { ctx } = makeCtx({ schedules: QUEUE });
    const { status, body } = await postCancelAll(ctx, {});
    expect(status).toBe(200);
    expect(body.cancelled).toBe(0);
    expect(body.confirmRequired).toBe(true);
    expect(body.wouldCancelCount).toBe(2);
    expect(body.wouldCancel).toEqual(QUEUE);
    expect(ctx.cancelSchedule).not.toHaveBeenCalled();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("with confirm cancels every listed id and audits once", async () => {
    const { ctx, cancelled, seedPaused } = makeCtx({ schedules: QUEUE, pausedIds: ["paused-1"] });
    await seedPaused;
    const { status, body } = await postCancelAll(ctx, { confirm: true });
    expect(status).toBe(200);
    expect(body.cancelled).toBe(2);
    expect(body.cancelledIds).toEqual(["v95599sHp", "_D6hWyU_S"]);
    expect(body.failed).toEqual([]);
    expect(body.pausedPreserved).toBe(1);
    expect(cancelled).toEqual(["v95599sHp", "_D6hWyU_S"]);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
    const audit = (ctx.audit as any).mock.calls[0];
    expect(audit[0]).toBe("schedules.cancelled.all");
    expect(audit[2].cancelledCount).toBe(2);
    expect(audit[2].pausedPreserved).toBe(1);
  });

  it("a failed cancel is reported, the rest still cancel", async () => {
    const { ctx } = makeCtx({
      schedules: QUEUE,
      cancel: async (id) => {
        if (id === "v95599sHp") throw new Error("boom");
        return true;
      },
    });
    const { status, body } = await postCancelAll(ctx, { confirm: true });
    expect(status).toBe(200);
    expect(body.cancelled).toBe(1);
    expect(body.cancelledIds).toEqual(["_D6hWyU_S"]);
    expect(body.failed).toEqual([{ id: "v95599sHp", error: "boom" }]);
  });

  it("an empty queue with confirm audits a zero-count run", async () => {
    const { ctx } = makeCtx({ schedules: [] });
    const { status, body } = await postCancelAll(ctx, { confirm: true });
    expect(status).toBe(200);
    expect(body.cancelled).toBe(0);
    expect(body.cancelledIds).toEqual([]);
    expect(ctx.audit).toHaveBeenCalledTimes(1);
  });
});
