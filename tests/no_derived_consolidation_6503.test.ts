/**
 * Issue #6503 — no-derived consolidation: red-first repro.
 *
 * Every schedule is a real stored schedule (one scheduler, one
 * control plane). The six derived records (token-renewal,
 * retention, nightly-research, sweep-stale-ledger-tasks,
 * sweep-stale-async-jobs, schedule-watchdog) become stored
 * platform-level rows; the derived seam (synthesis at read time,
 * refusal branches, `derived-record` catalogue source) is deleted.
 *
 * Each test below asserts the POST-build behaviour and FAILS on
 * the pre-build tree. Derived from #6503's mechanism — NOT from
 * the retired #6496 stored-record workaround design.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createWorkflowStageSchedule,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
  reconcileSystemScheduleRecords,
  goalToRecord,
  recordToGoal,
  findStoredRecordForFiring,
  tickerPushScheduleToRecord,
  seedDeclaredTaskRecords,
  declaredTaskIntervalSeconds,
} from "../src/services/unifiedScheduleManagement";
import { isDue } from "../src/schedule";
import {
  findMissedDurableSchedule,
  SCHEDULE_WATCHDOG_FIRST_SEEN_KEY,
} from "../src/services/scheduleWatchdog";
import {
  decideScheduleWatchdogHeartbeat,
} from "../src/services/heartbeatWatchdog";
import {
  SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
  SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
  SCHEDULE_WATCHDOG_SWEEP_OPERATION,
} from "../src/services/scheduleWatchdog";
import { HEARTBEAT_WATCHDOG_CRON } from "../src/config/heartbeatWatchdog";
import {
  runWatchdogEntryPoint,
  type CronDispatchRecordInput,
  type CronEntryPointDeps,
} from "../src/services/consolidatedCronEntries";
import { watchdogMissedSchedules } from "../src/agents/orchestrator/scheduleWatchdog";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { TickerAgent } from "../src/agents/ticker-agent";
import { liveMarketCache } from "../src/services/marketStream";
import { createPausedAgentSdkScheduleRecord } from "../src/services/agentScheduleCapability";
import { refuseBelowFloorTiming } from "../src/services/scheduleFrequencyFloor";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { jobCatalogueEntryForId } from "../src/config/jobCatalogue";
import {
  resolveScheduleControlsView,
} from "../src/services/scheduleControls";
import { createSettingsPort } from "../src/data/createSettingsPorts";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";
import {
  handleMaintenanceRoutes,
  type MaintenanceRouteContext,
} from "../src/agents/routes/maintenance";
import {
  createMemoryAuditStore,
  type AuditStore,
} from "../src/security/iaaaAudit";
import {
  declareStrategyScanObserveTasks,
  STRATEGY_SCAN_OBSERVE_TASK_ID,
} from "../src/agents/orchestrator/scheduledTasksObserve";
import {
  declareStockCopilotTasks,
  STOCK_COPILOT_TASK_ID,
} from "../src/agents/orchestrator/scheduledTasksCopilot";

const NOW = "2026-11-25T13:00:00.000Z";
const MONTHLY_SECONDS = 2_592_000;

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slice 1). */
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

const SIX_IDS = [
  "token-renewal",
  "retention",
  "nightly-research",
  "sweep-stale-ledger-tasks",
  "sweep-stale-async-jobs",
  "schedule-watchdog",
] as const;

const CALLBACKS: Record<string, string> = {
  "token-renewal": "autoRenewETradeTokens",
  retention: "retention",
  "nightly-research": "runResearchSchedule",
  "sweep-stale-ledger-tasks": "sweepStaleLedgerTasks",
  "sweep-stale-async-jobs": "sweepStaleAsyncJobs",
  "schedule-watchdog": "watchdogMissedSchedules",
};

/** A stored platform-level row for one of the six, as the seed creates it. */
function storedSystemRecord(
  id: string,
  state: "active" | "paused",
  alarmId: string | null = null,
): UnifiedScheduleRecord {
  return {
    id,
    kind: "internal",
    state,
    callback: CALLBACKS[id],
    definition: {
      type: "interval",
      intervalSeconds: MONTHLY_SECONDS,
      callback: CALLBACKS[id],
      entryPoint: id,
    } as unknown as UnifiedScheduleRecord["definition"],
    ownerLogin: null,
    provenance: { origin: "system", createdBy: "system", reason: id, createdAt: NOW },
    alarmId,
    pausedAt: state === "paused" ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** node:sqlite double for the SqlStorage seam (same shape as #2337). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  get sql(): SqliteTestStorage {
    return this;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function alarmsStub(overrides: Record<string, unknown> = {}): any {
  return {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "alarm-1", callback: "autoRenewETradeTokens" }),
    ...overrides,
  };
}

describe("6503 catalogue: the six are stored, not derived; iv-history-collection's derived source is retired", () => {
  it("flips the six catalogue entries to internal-callback", () => {
    for (const id of SIX_IDS) {
      expect(jobCatalogueEntryForId(id)?.source).toBe("internal-callback");
    }
  });

  it("retires iv-history-collection's derived-record source (no stored schedule; collection stops at cutover, #6544)", () => {
    expect(jobCatalogueEntryForId("iv-history-collection")?.source).toBe(
      "internal-callback",
    );
  });

  it("leaves ticker-push derived-record (a live feed, not a schedule)", () => {
    expect(jobCatalogueEntryForId("ticker-push")?.source).toBe("derived-record");
  });
});

describe("6503 service verbs work on stored system rows (no derived refusal)", () => {
  it("pause works on a stored active system row with no live alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("token-renewal", "active"));
    const result = await pauseUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "token-renewal",
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.state).toBe("paused");
      expect(result.record.id).toBe("token-renewal");
    }
    expect((await store.get("token-renewal"))?.state).toBe("paused");
  });

  it("resume re-arms a stored paused system row from its own timing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("retention", "paused"));
    const arm = vi.fn(async () => ({ id: "alarm-9", callback: "retention" }));
    const result = await resumeUnifiedSchedule(
      { store, alarms: alarmsStub({ arm }) },
      "retention",
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.state).toBe("active");
      expect(result.record.alarmId).toBe("alarm-9");
    }
    expect(arm).toHaveBeenCalledTimes(1);
    const [timing] = arm.mock.calls[0] as unknown as Array<Record<string, unknown>>;
    expect(timing).toEqual({ type: "interval", intervalSeconds: MONTHLY_SECONDS });
  });

  it("delete removes a stored system row and it stays gone", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("nightly-research", "paused"));
    const deleted = await deleteUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "nightly-research",
    );
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.cancelled).toBe(true);
    expect(await store.get("nightly-research")).toBeUndefined();
  });

  it("update re-times a stored paused system row without an alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("sweep-stale-ledger-tasks", "paused"));
    const updated = await updateUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "sweep-stale-ledger-tasks",
      { intervalSeconds: MONTHLY_SECONDS },
      Date.parse(NOW),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.record.state).toBe("paused");
      const def = updated.record.definition as unknown as Record<string, unknown>;
      expect(def.intervalSeconds).toBe(MONTHLY_SECONDS);
    }
  });

  it("trigger runs a stored active system row and stamps triggered, not manual", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("schedule-watchdog", "active", "alarm-1"));
    const seen: Array<{ callback: string; payload: unknown }> = [];
    const run = async (callback: string, payload: unknown) => {
      seen.push({ callback, payload });
    };
    const triggered = await triggerUnifiedSchedule(
      {
        store,
        alarms: alarmsStub({
          get: async () => ({
            id: "alarm-1",
            callback: "watchdogMissedSchedules",
            payload: {},
          }),
        }),
      },
      "schedule-watchdog",
      run,
    );
    expect(triggered.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].callback).toBe("watchdogMissedSchedules");
    expect((seen[0].payload as Record<string, unknown>).trigger).toBe("triggered");
  });

  it("pause refuses nothing for any of the six once stored", async () => {
    for (const id of SIX_IDS) {
      const store = new InMemoryUnifiedScheduleStore();
      await store.save(storedSystemRecord(id, "active"));
      const result = await pauseUnifiedSchedule(
        { store, alarms: alarmsStub() },
        id,
        NOW,
      );
      expect(result.ok).toBe(true);
    }
  });
});

describe("6503 list route reads the store only (no synthesis)", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;

  function baseCtx(): SchedulesRouteContext {
    return {
      env: { AGENT_DB: new MockD1Database() },
      agentCtx: { storage: { sql: sql.sql as never } } as never,
      audit: vi.fn(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
    } as unknown as SchedulesRouteContext;
  }

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  beforeEach(() => {
    sql = new SqliteTestStorage();
    ctx = baseCtx();
  });

  it("shows none of the six when the store holds no stored row for them", async () => {
    const body = await list();
    for (const id of SIX_IDS) {
      expect(body.schedules.find((s) => s.id === id)).toBeUndefined();
    }
  });

  it("detail 404s a derived id with no stored row", async () => {
    const path = "/api/schedules/token-renewal";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "GET" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(404);
  });
});

describe("6503 control routes authorize the caller (G1)", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;

  function baseCtx(headers?: Record<string, string>): SchedulesRouteContext {
    void headers;
    return {
      env: { AGENT_DB: new MockD1Database() },
      agentCtx: { storage: { sql: sql.sql as never } } as never,
      audit: vi.fn(),
      // Issue #6503 step 9 (G2) — the control ops audit-before-write
      // through this store; without it the wired fallback (no
      // SESSION_STORE in tests) blocks every mutation with 503.
      auditStore: createMemoryAuditStore(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
    } as unknown as SchedulesRouteContext;
  }

  beforeEach(() => {
    sql = new SqliteTestStorage();
    ctx = baseCtx();
  });

  it("pause without any caller identity is 401, not a service error", async () => {
    const path = "/api/schedules/token-renewal/pause";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "POST" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(401);
  });

  it("resume without any caller identity is 401", async () => {
    const path = "/api/schedules/token-renewal/resume";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "POST" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(401);
  });

  it("trigger without any caller identity is 401", async () => {
    const path = "/api/schedules/token-renewal/trigger";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "POST" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(401);
  });

  it("update without any caller identity is 401", async () => {
    const path = "/api/schedules/token-renewal";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalSeconds: MONTHLY_SECONDS }),
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(401);
  });

  it("cancel without any caller identity is 401", async () => {
    const path = "/api/schedules/token-renewal";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "DELETE" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(401);
  });
});

describe("6503 control routes enforce the level rule (G1 matrix)", () => {
  const ADMIN_LOGIN = "venus-admin";
  const ADMIN_USER_ID = "user-admin-1";
  const TENANT_ADMIN_LOGIN = "tenant-admin";
  const TENANT_ADMIN_USER_ID = "user-tenant-admin-1";
  const OWNER_LOGIN = "venus";
  const OTHER_LOGIN = "mallory";

  // Alias KV stub, same shape as tests/schedule-6482-runaway-alarm-loop.test.ts.
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

  // Memberships keyed by internal id: a live platform-admin binding
  // for the admin, a live tenant-admin binding in the instance
  // tenant ("primary", the resolveIaaaTenant default) for the tenant
  // admin, nothing for anyone else.
  function stubMembershipStore() {
    const byUser: Record<string, Array<Record<string, unknown>>> = {
      [ADMIN_USER_ID]: [
        {
          membershipId: "m-admin-1",
          internalUserId: ADMIN_USER_ID,
          tenantId: "platform",
          roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
          createdBy: "test",
          createdAtMs: 1,
        },
      ],
      [TENANT_ADMIN_USER_ID]: [
        {
          membershipId: "m-tenant-admin-1",
          internalUserId: TENANT_ADMIN_USER_ID,
          tenantId: "primary",
          roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test" }],
          createdBy: "test",
          createdAtMs: 1,
        },
      ],
    };
    return {
      getMembershipsByUser: async (internalUserId: string) => byUser[internalUserId] ?? [],
      put: async () => {},
      revokeMembership: async () => false,
    };
  }

  /** A stored active user-level screen row owned by `ownerLogin`. */
  function userRecord(id: string, ownerLogin: string): UnifiedScheduleRecord {
    return {
      id,
      kind: "screen",
      state: "active",
      callback: "autonomousMarketScreen",
      definition: {
        type: "interval",
        intervalSeconds: MONTHLY_SECONDS,
        callback: "autonomousMarketScreen",
      } as unknown as UnifiedScheduleRecord["definition"],
      ownerLogin,
      provenance: { origin: "user", createdBy: ownerLogin, reason: id, createdAt: NOW },
      alarmId: null,
      pausedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  function matrixCtx(mockD1: MockD1Database): SchedulesRouteContext {
    return {
      env: { AGENT_DB: mockD1 },
      agentCtx: { storage: { sql: new SqliteTestStorage().sql as never } } as never,
      audit: vi.fn(),
      // Issue #6503 step 9 (G2) — see the G1 baseCtx note above.
      auditStore: createMemoryAuditStore(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: [],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
      flagAliasKv: stubKv({
        [ADMIN_LOGIN]: ADMIN_USER_ID,
        [TENANT_ADMIN_LOGIN]: TENANT_ADMIN_USER_ID,
      }),
      flagMembershipStore: stubMembershipStore(),
    } as unknown as SchedulesRouteContext;
  }

  async function seed(mockD1: MockD1Database, record: UnifiedScheduleRecord) {
    const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
    await store.save(record);
  }

  async function pauseAs(
    ctx: SchedulesRouteContext,
    scheduleId: string,
    login: string,
  ): Promise<number> {
    const path = `/api/schedules/${scheduleId}/pause`;
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "x-user-login": login },
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res).not.toBeNull();
    return res!.status;
  }

  it("platform-admin CAN pause a system schedule", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    expect(await pauseAs(matrixCtx(mockD1), "token-renewal", ADMIN_LOGIN)).toBe(200);
  });

  it("tenant-admin CANNOT pause a system schedule (403)", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    expect(await pauseAs(matrixCtx(mockD1), "token-renewal", TENANT_ADMIN_LOGIN)).toBe(403);
  });

  it("the owning user CAN pause their own user-level schedule", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, userRecord("sched-own-1", OWNER_LOGIN));
    expect(await pauseAs(matrixCtx(mockD1), "sched-own-1", OWNER_LOGIN)).toBe(200);
  });

  it("a non-owning user CANNOT pause another user's user-level schedule (403)", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, userRecord("sched-own-1", OWNER_LOGIN));
    expect(await pauseAs(matrixCtx(mockD1), "sched-own-1", OTHER_LOGIN)).toBe(403);
  });

  // Issue #6503 step 15 — the rest of the ops×levels matrix: bulk
  // verbs, create, trigger, and the clear-table gate, each pinning
  // only the status code the level rule assigns.
  async function bulkPauseAs(
    ctx: SchedulesRouteContext,
    scope: string,
    login: string,
  ): Promise<number> {
    const path = "/api/schedules/pause";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": login },
        body: JSON.stringify({ scope }),
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res).not.toBeNull();
    return res!.status;
  }

  async function triggerAs(
    ctx: SchedulesRouteContext,
    scheduleId: string,
    login: string,
  ): Promise<number> {
    const path = `/api/schedules/${scheduleId}/trigger`;
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "x-user-login": login },
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res).not.toBeNull();
    return res!.status;
  }

  async function createAs(
    ctx: SchedulesRouteContext,
    login?: string,
  ): Promise<number> {
    const path = "/api/schedules";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(login ? { "x-user-login": login } : {}),
        },
        body: JSON.stringify({
          callback: "autonomousMarketScreen",
          scheduleType: "interval",
          intervalSeconds: MONTHLY_SECONDS,
        }),
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res).not.toBeNull();
    return res!.status;
  }

  function maintenanceCtx(mockD1: MockD1Database): MaintenanceRouteContext {
    return {
      env: { AGENT_DB: mockD1 },
      agentCtx: { storage: { sql: new SqliteTestStorage().sql as never } } as never,
      audit: vi.fn(),
      // Issue #6503 step 9 (G2) — see the G1 baseCtx note above.
      auditStore: createMemoryAuditStore(),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      flagAliasKv: stubKv({
        [ADMIN_LOGIN]: ADMIN_USER_ID,
        [TENANT_ADMIN_LOGIN]: TENANT_ADMIN_USER_ID,
      }),
      flagMembershipStore: stubMembershipStore(),
    } as unknown as MaintenanceRouteContext;
  }

  async function clearTableAs(
    ctx: MaintenanceRouteContext,
    table: string,
    login: string,
  ): Promise<number> {
    const path = "/api/maintenance/clear-table";
    const res = await handleMaintenanceRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": login },
        body: JSON.stringify({ table }),
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res).not.toBeNull();
    return res!.status;
  }

  it("tenant-admin CANNOT bulk-pause the 'system' scope (403)", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    expect(await bulkPauseAs(matrixCtx(mockD1), "system", TENANT_ADMIN_LOGIN)).toBe(403);
  });

  it("platform-admin CAN bulk-pause the 'all' scope (200)", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    expect(await bulkPauseAs(matrixCtx(mockD1), "all", ADMIN_LOGIN)).toBe(200);
  });

  it("create as anonymous is 401", async () => {
    const mockD1 = new MockD1Database();
    const ctx = matrixCtx(mockD1);
    // The create route 401s anonymous callers only after the
    // callback allow-list passes, so the ctx names the creatable
    // callback and the body clears the floor/sub-daily gates.
    (ctx as any).creatableScheduleCallbacks = ["autonomousMarketScreen"];
    expect(await createAs(ctx)).toBe(401);
  });

  it("clear-table 'unified_schedules' as tenant-admin is 403", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    expect(
      await clearTableAs(maintenanceCtx(mockD1), "unified_schedules", TENANT_ADMIN_LOGIN),
    ).toBe(403);
  });

  it("the owning user CAN trigger their own user-level schedule (200)", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, userRecord("sched-own-1", OWNER_LOGIN));
    const ctx = matrixCtx(mockD1);
    // triggerUnifiedSchedule dispatches through the row's live
    // alarm, read via getScheduleById; the matrix ctx stubs it.
    (ctx as any).getScheduleById = vi.fn(async (id: string) =>
      id === "sched-own-1"
        ? { id: "sched-own-1", callback: "autonomousMarketScreen", payload: {} }
        : undefined,
    );
    expect(await triggerAs(ctx, "sched-own-1", OWNER_LOGIN)).toBe(200);
  });

  it("a tenant-admin CAN trigger a user-level schedule of their tenant (200)", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, userRecord("sched-own-1", OWNER_LOGIN));
    const ctx = matrixCtx(mockD1);
    (ctx as any).getScheduleById = vi.fn(async (id: string) =>
      id === "sched-own-1"
        ? { id: "sched-own-1", callback: "autonomousMarketScreen", payload: {} }
        : undefined,
    );
    expect(await triggerAs(ctx, "sched-own-1", TENANT_ADMIN_LOGIN)).toBe(200);
  });
});

describe("6503 start-paused is a managed control (default paused)", () => {
  it("the controls view carries startPaused, effective true by default", async () => {
    const sql = new SqliteTestStorage();
    // Issue #6101 — the controls view is async now (the firing-rate
    // read behind it is a D1 read).
    const view = await resolveScheduleControlsView(sql.sql as never, {}, [], Date.parse(NOW));
    expect((view as unknown as Record<string, unknown>).startPaused).toBe(true);
  });
});

describe("6503 firing-rate thresholds are managed settings", () => {
  it("a managed threshold overrides the env default in the controls view", async () => {
    const sql = new SqliteTestStorage();
    const port = createSettingsPort(sql.sql as never);
    port.ensureSchema();
    port.set("schedule.firingRateAlertThreshold", "5");
    port.set("schedule.firingRateAlertWindowMinutes", "10");
    // Issue #6101 — the controls view is async now (see above).
    const view = await resolveScheduleControlsView(sql.sql as never, {}, [], Date.parse(NOW));
    expect(view.firingRate.threshold).toBe(5);
    expect(view.firingRate.windowMinutes).toBe(10);
  });
});

describe("6503 start-paused control is honored at creation", () => {
  function createCtx(sql: SqliteTestStorage): SchedulesRouteContext {
    return {
      env: { AGENT_DB: new MockD1Database() },
      agentCtx: { storage: { sql: sql.sql as never } } as never,
      audit: vi.fn(),
      // Issue #6503 step 9 (G2) — see the G1 baseCtx note above.
      auditStore: createMemoryAuditStore(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: ["autonomousMarketScreen"],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
    } as unknown as SchedulesRouteContext;
  }

  async function createScreen(
    sql: SqliteTestStorage,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, any> }> {
    const path = "/api/schedules/create";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "venus" },
        body: JSON.stringify(body),
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      createCtx(sql),
    );
    expect(res).not.toBeNull();
    return { status: res!.status, json: (await res!.json()) as Record<string, any> };
  }

  it("screen create starts active when the control is off (armed, not paused)", async () => {
    const sql = new SqliteTestStorage();
    const port = createSettingsPort(sql.sql as never);
    port.ensureSchema();
    port.set("schedule.startPaused", "false");
    const { status, json } = await createScreen(sql, {
      callback: "autonomousMarketScreen",
      scheduleType: "interval",
      intervalSeconds: MONTHLY_SECONDS,
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.paused).toBe(false);
    expect(json.schedule.state).toBe("active");
    expect(json.schedule.alarmId).toBe("sched-every");
  });

  it("screen create stays paused by default (control unset)", async () => {
    const sql = new SqliteTestStorage();
    const { status, json } = await createScreen(sql, {
      callback: "autonomousMarketScreen",
      scheduleType: "interval",
      intervalSeconds: MONTHLY_SECONDS,
    });
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.paused).toBe(true);
    expect(json.schedule.state).toBe("paused");
    expect(json.schedule.alarmId).toBeNull();
  });

  it("stage create starts active when the control is off", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const created = await createWorkflowStageSchedule(
      { store, alarms: alarmsStub() },
      {
        jobId: "job-1",
        nodePath: "stage-1",
        stageId: "stage-1",
        callback: "runWorkflowStage",
        timing: { type: "interval", intervalSeconds: MONTHLY_SECONDS },
        ownerLogin: "venus",
      },
      NOW,
      { startPaused: false },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.record.state).toBe("active");
    expect(created.record.alarmId).toBe("alarm-1");
  });

  it("stage create with a below-floor timing and the control off fails whole (no record left)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    // The real alarms port refuses a below-floor arm with the coded
    // floor error; the stub must do the same for this test to exercise
    // the activation's failure path.
    const floorCheckingAlarms = alarmsStub({
      arm: async (timing: { type: string; intervalSeconds?: number }) => {
        const refusal = refuseBelowFloorTiming(
          { type: "interval", intervalSeconds: timing.intervalSeconds ?? 0 },
          MONTHLY_SECONDS,
        );
        if (!refusal.ok) throw refusal.error;
        return { id: "alarm-1", callback: "runWorkflowStage" };
      },
    });
    const created = await createWorkflowStageSchedule(
      { store, alarms: floorCheckingAlarms },
      {
        jobId: "job-1",
        nodePath: "stage-1",
        stageId: "stage-1",
        callback: "runWorkflowStage",
        timing: { type: "interval", intervalSeconds: 60 },
        ownerLogin: "venus",
      },
      NOW,
      { startPaused: false },
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.status).toBe(400);
    expect(await store.list()).toEqual([]);
  });

  it("SDK create starts active when the control is off and an alarms port is given", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const item = await createPausedAgentSdkScheduleRecord(
      store,
      { timing: { type: "interval", intervalSeconds: MONTHLY_SECONDS }, callback: "autonomousMarketScreen" },
      NOW,
      { startPaused: false, alarms: alarmsStub() },
    );
    const record = await store.get(item.id);
    expect(record?.state).toBe("active");
    expect(record?.alarmId).toBe("alarm-1");
  });

  it("SDK create with the control off but no alarms port refuses and leaves nothing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await expect(
      createPausedAgentSdkScheduleRecord(
        store,
        { timing: { type: "interval", intervalSeconds: MONTHLY_SECONDS }, callback: "autonomousMarketScreen" },
        NOW,
        { startPaused: false },
      ),
    ).rejects.toThrow(/no alarms port/i);
    expect(await store.list()).toEqual([]);
  });
});

describe("6503 seeding: reconcile creates the six as stored paused rows", () => {
  it("seeds all six paused on a monthly interval with no alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const result = await reconcileSystemScheduleRecords(
      { store, alarms: alarmsStub() },
      NOW,
      { userLogin: "mars" },
    );
    expect(result.seeded).toEqual([...SIX_IDS]);
    for (const id of SIX_IDS) {
      const record = await store.get(id);
      expect(record?.state).toBe("paused");
      expect(record?.kind).toBe("internal");
      expect(record?.callback).toBe(CALLBACKS[id]);
      expect(record?.definition).toMatchObject({ type: "interval", intervalSeconds: MONTHLY_SECONDS });
      expect(record?.alarmId).toBeNull();
    }
    const ledger = await store.get("sweep-stale-ledger-tasks");
    expect((ledger?.definition as Record<string, unknown>).payload).toEqual({ userLogin: "mars" });
  });

  it("skips the ledger-sweep seed when no userLogin is known", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const result = await reconcileSystemScheduleRecords({ store, alarms: alarmsStub() }, NOW);
    expect(result.skippedLedgerSweepNoUser).toBe(true);
    expect(await store.get("sweep-stale-ledger-tasks")).toBeUndefined();
    expect(result.seeded).toHaveLength(5);
  });

  it("never overwrites an existing record", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const existing = storedSystemRecord("token-renewal", "active", "alarm-9");
    await store.save({ ...existing, definition: { type: "interval", intervalSeconds: 123, callback: CALLBACKS["token-renewal"] } });
    const alarms = alarmsStub({ list: async () => [{ id: "alarm-9", callback: "autoRenewETradeTokens", intervalSeconds: 123 }] });
    const result = await reconcileSystemScheduleRecords({ store, alarms }, NOW, { userLogin: "mars" });
    expect(result.seeded).not.toContain("token-renewal");
    const record = await store.get("token-renewal");
    expect((record?.definition as Record<string, unknown>).intervalSeconds).toBe(123);
    expect(record?.alarmId).toBe("alarm-9");
  });

  it("re-arms an active record whose alarm died, at its stored timing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("schedule-watchdog", "active", "alarm-gone"));
    const armed: Array<unknown[]> = [];
    const alarms = alarmsStub({
      list: async () => [],
      arm: async (...args: unknown[]) => {
        armed.push(args);
        return { id: "alarm-new", callback: "watchdogMissedSchedules" };
      },
    });
    const result = await reconcileSystemScheduleRecords({ store, alarms }, NOW, { userLogin: "mars" });
    expect(result.armed).toEqual(["schedule-watchdog"]);
    expect(armed).toHaveLength(1);
    expect((armed[0][0] as Record<string, unknown>).intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(await (await store.get("schedule-watchdog"))?.alarmId).toBe("alarm-new");
  });

  it("cancels stale sub-floor arms for the six callbacks", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const cancelled: string[] = [];
    const alarms = alarmsStub({
      list: async () => [
        { id: "stale-1", callback: "sweepStaleAsyncJobs", intervalSeconds: 900 },
        { id: "stale-2", callback: "watchdogMissedSchedules", intervalSeconds: 900 },
        { id: "keep-1", callback: "autonomousMarketScreen", intervalSeconds: 900 },
      ],
      cancel: async (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    const result = await reconcileSystemScheduleRecords({ store, alarms }, NOW, { userLogin: "mars" });
    expect(result.cancelledStaleAlarms).toEqual(["stale-1", "stale-2"]);
    expect(cancelled).not.toContain("keep-1");
  });

  it("does not cancel a live alarm a stored active record claims", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedSystemRecord("sweep-stale-async-jobs", "active", "live-1"));
    const cancelled: string[] = [];
    const alarms = alarmsStub({
      list: async () => [{ id: "live-1", callback: "sweepStaleAsyncJobs", intervalSeconds: 900 }],
      cancel: async (id: string) => {
        cancelled.push(id);
        return true;
      },
    });
    const result = await reconcileSystemScheduleRecords({ store, alarms }, NOW, { userLogin: "mars" });
    expect(result.cancelledStaleAlarms).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(result.armed).toEqual([]);
  });
});

describe("6503 audit-before-write on the schedule control plane (G2)", () => {
  const ADMIN_LOGIN = "venus-admin";
  const ADMIN_USER_ID = "user-admin-1";
  const TENANT_ADMIN_LOGIN = "tenant-admin";
  const TENANT_ADMIN_USER_ID = "user-tenant-admin-1";

  // Alias KV + membership stubs, same shape as the G1 matrix above
  // (and tests/schedule-6482-runaway-alarm-loop.test.ts): a live
  // platform-admin binding for the admin, a live tenant-admin
  // binding in the instance tenant ("primary") for the tenant
  // admin, nothing for anyone else.
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

  function stubMembershipStore() {
    const byUser: Record<string, Array<Record<string, unknown>>> = {
      [ADMIN_USER_ID]: [
        {
          membershipId: "m-admin-1",
          internalUserId: ADMIN_USER_ID,
          tenantId: "platform",
          roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
          createdBy: "test",
          createdAtMs: 1,
        },
      ],
      [TENANT_ADMIN_USER_ID]: [
        {
          membershipId: "m-tenant-admin-1",
          internalUserId: TENANT_ADMIN_USER_ID,
          tenantId: "primary",
          roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test" }],
          createdBy: "test",
          createdAtMs: 1,
        },
      ],
    };
    return {
      getMembershipsByUser: async (internalUserId: string) => byUser[internalUserId] ?? [],
      put: async () => {},
      revokeMembership: async () => false,
    };
  }

  /** An audit store whose appends always fail (the audit store is down) — the #5867 shape. */
  function failingAuditStore(): AuditStore {
    return {
      append: async () => {
        throw new Error("audit store down");
      },
      list: async () => [],
    };
  }

  function auditCtx(mockD1: MockD1Database, auditStore?: AuditStore) {
    const audit = vi.fn();
    const store = auditStore ?? createMemoryAuditStore();
    const ctx = {
      env: { AGENT_DB: mockD1 },
      agentCtx: { storage: { sql: new SqliteTestStorage().sql as never } } as never,
      audit,
      auditStore: store,
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: ["autonomousMarketScreen"],
      accountScopedScheduleCallbacks: new Set(),
      runScheduleCallback: vi.fn(async () => undefined),
      flagAliasKv: stubKv({
        [ADMIN_LOGIN]: ADMIN_USER_ID,
        [TENANT_ADMIN_LOGIN]: TENANT_ADMIN_USER_ID,
      }),
      flagMembershipStore: stubMembershipStore(),
    } as unknown as SchedulesRouteContext;
    return { ctx, audit, auditStore: store };
  }

  async function seed(mockD1: MockD1Database, record: UnifiedScheduleRecord) {
    const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
    await store.save(record);
  }

  async function call(
    ctx: SchedulesRouteContext,
    method: string,
    path: string,
    login?: string,
    body?: unknown,
  ) {
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method,
        headers: {
          ...(login ? { "x-user-login": login } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res).not.toBeNull();
    return res!;
  }

  it("a pause by platform-admin writes ONE chain record naming the action, id, and caller login", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    const { ctx, audit, auditStore } = auditCtx(mockD1);
    const res = await call(ctx, "POST", "/api/schedules/token-renewal/pause", ADMIN_LOGIN);
    expect(res.status).toBe(200);
    const events = await auditStore.list();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.action).toBe("schedule.paused");
    expect(event.type).toBe("schedule-admin");
    expect(event.resourceId).toBe("token-renewal");
    expect(event.actorPrincipalId).toBe(ADMIN_LOGIN);
    expect(event.initiatingPrincipalId).toBe(ADMIN_LOGIN);
    expect(event.actorType).toBe("human");
    expect(event.tenantId).toBe("primary");
    expect(event.decision).toBe("allow");
    expect(event.policyVersion).toBe("iaaa-audit-1");
    // The record lands before the write, so its outcome is pending.
    expect(event.outcome).toBe("pending");
    expect(typeof event.correlationId).toBe("string");
    expect(event.correlationId.length).toBeGreaterThan(0);
    // The funnel annotation after the write carries the caller
    // attribution and the before-state.
    expect(audit).toHaveBeenCalledWith(
      "schedule.paused",
      "orchestrator",
      expect.objectContaining({
        scheduleId: "token-renewal",
        changedBy: ADMIN_LOGIN,
        callerLevel: "platform-admin",
        fromState: "active",
      }),
    );
    expect((await createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules.get("token-renewal"))?.state).toBe("paused");
  });

  it("a refused pause (tenant-admin on a system schedule) writes a refusal audit naming the action, id, and reason", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    const { ctx, audit, auditStore } = auditCtx(mockD1);
    const res = await call(ctx, "POST", "/api/schedules/token-renewal/pause", TENANT_ADMIN_LOGIN);
    expect(res.status).toBe(403);
    const events = await auditStore.list();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.action).toBe("schedule.paused");
    expect(event.decision).toBe("deny");
    expect(event.resourceId).toBe("token-renewal");
    expect(event.actorPrincipalId).toBe(TENANT_ADMIN_LOGIN);
    expect(event.outcome).toBe("failed");
    expect(event.errorCode).toContain("platform-admin only");
    expect(audit).toHaveBeenCalledWith(
      "schedule.control-refused",
      "orchestrator",
      expect.objectContaining({
        action: "schedule.paused",
        scheduleId: "token-renewal",
        callerLogin: TENANT_ADMIN_LOGIN,
        callerLevel: "tenant-admin",
      }),
    );
    const refusal = (audit as unknown as { mock: { calls: Array<[string, string, Record<string, unknown>]> } }).mock.calls.find(
      (c) => c[0] === "schedule.control-refused",
    );
    expect(String(refusal?.[2].reason)).toContain("platform-admin only");
    // Nothing was mutated by the refused op.
    expect((await createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules.get("token-renewal"))?.state).toBe("active");
  });

  it("a pause with a down audit store is a coded 503 and the store row is unchanged", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    const { ctx, audit } = auditCtx(mockD1, failingAuditStore());
    const res = await call(ctx, "POST", "/api/schedules/token-renewal/pause", ADMIN_LOGIN);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("FAILURE_COMMERCIAL_AUDIT_REQUIRED");
    expect(body.action).toBe("schedule.paused");
    expect((await createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules.get("token-renewal"))?.state).toBe("active");
    expect(audit).not.toHaveBeenCalled();
  });

  it("a create writes ONE schedule.created chain record naming the caller", async () => {
    const mockD1 = new MockD1Database();
    const { ctx, audit, auditStore } = auditCtx(mockD1);
    const res = await call(ctx, "POST", "/api/schedules/create", "venus", {
      callback: "autonomousMarketScreen",
      scheduleType: "interval",
      intervalSeconds: MONTHLY_SECONDS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedule: { id: string } };
    const events = await auditStore.list();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("schedule.created");
    expect(events[0]!.actorPrincipalId).toBe("venus");
    expect(events[0]!.resourceId).toBe(body.schedule.id);
    expect(events[0]!.decision).toBe("allow");
    expect(audit).toHaveBeenCalledWith(
      "schedule.created",
      "orchestrator",
      expect.objectContaining({ scheduleId: body.schedule.id, changedBy: "venus", callerLevel: "user" }),
    );
  });

  it("a 401 (no identity) writes a refusal audit naming anonymous", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    const { ctx, audit, auditStore } = auditCtx(mockD1);
    const res = await call(ctx, "POST", "/api/schedules/token-renewal/pause");
    expect(res.status).toBe(401);
    const events = await auditStore.list();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("schedule.paused");
    expect(events[0]!.decision).toBe("deny");
    expect(events[0]!.actorPrincipalId).toBe("anonymous");
    expect(audit).toHaveBeenCalledWith(
      "schedule.control-refused",
      "orchestrator",
      expect.objectContaining({ action: "schedule.paused", scheduleId: "token-renewal", callerLogin: "anonymous" }),
    );
  });

  it("a GET list writes no chain record", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("token-renewal", "active"));
    const { ctx, audit, auditStore } = auditCtx(mockD1);
    const res = await call(ctx, "GET", "/api/schedules");
    expect(res.status).toBe(200);
    expect(await auditStore.list()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("6503 paused is enforced on every scheduled firing path (G3)", () => {
  async function seed(mockD1: MockD1Database, record: UnifiedScheduleRecord) {
    const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
    await store.save(record);
  }

  /** A stale live alarm for a stored row: the SDK id the pause failed to cancel. */
  function staleAlarm(id: string) {
    return { id };
  }

  it("(a) the due-check returns false for a paused row, both branches", () => {
    const dueUtc = new Date("2026-11-25T06:30:00.000Z");
    expect(isDue("0 6 * * *", undefined, dueUtc)).toBe(true);
    expect(isDue("0 6 * * *", undefined, dueUtc, undefined, { paused: true })).toBe(false);
    // Zoned branch: 11:30 UTC is 06:30 in America/New_York, so the cron is due there.
    const dueZoned = new Date("2026-11-25T11:30:00.000Z");
    expect(isDue("0 6 * * *", undefined, dueZoned, "America/New_York")).toBe(true);
    expect(
      isDue("0 6 * * *", undefined, dueZoned, "America/New_York", { paused: true }),
    ).toBe(false);
  });

  it("(a) the firing-path resolver finds a system row by its stale alarm id", async () => {
    const mockD1 = new MockD1Database();
    const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
    await seed(mockD1, storedSystemRecord("retention", "paused", "alarm-stale-1"));
    // Direct get by catalogue id hits; the alarm-id scan is the hit
    // for an SDK firing, whose schedule.id is the alarm id, not the
    // record id.
    expect((await findStoredRecordForFiring(store, { scheduleId: "retention", alarmId: "alarm-stale-1" }))?.id).toBe(
      "retention",
    );
    expect(
      (await findStoredRecordForFiring(store, { scheduleId: "alarm-stale-1", alarmId: "alarm-stale-1" }))?.id,
    ).toBe("retention");
    expect(
      await findStoredRecordForFiring(store, { scheduleId: "alarm-unknown", alarmId: "alarm-unknown" }),
    ).toBeUndefined();
  });

  it("(b) a paused row with a stale live alarm does not fire on the alarm path", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("retention", "paused", "alarm-stale-1"));
    const storage = new SqliteTestStorage();
    const delegate = vi.fn(async () => ({ outcome: "success" as const, descriptor: "retention ran" }));
    const audit = vi.fn();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "retention",
      {},
      staleAlarm("alarm-stale-1"),
      delegate,
      { env: { AGENT_DB: mockD1 }, audit: audit as never },
    );
    expect(delegate).not.toHaveBeenCalled();
    // Issue #6101 — the paused-skip row lands in the D1 ledger.
    const runs = await new D1JobRunRecordStore(
      createD1JobRunRecordDb(mockD1 as unknown as D1Database),
    ).listByJob("alarm-stale-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("skipped");
    expect(runs[0]!.detail).toMatch(/paused/);
    expect(audit).toHaveBeenCalledWith(
      "schedule.firing_paused",
      "orchestrator",
      expect.objectContaining({ code: "schedule_firing_paused", scheduleId: "retention" }),
    );
  });

  it("(b) an active row with the same stale alarm still fires", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("retention", "active", "alarm-live-1"));
    const storage = new SqliteTestStorage();
    const delegate = vi.fn(async () => ({ outcome: "success" as const, descriptor: "retention ran" }));
    await recordScheduleCallbackRun(
      storage.sql as never,
      "retention",
      {},
      staleAlarm("alarm-live-1"),
      delegate,
      { env: { AGENT_DB: mockD1 } },
    );
    expect(delegate).toHaveBeenCalledTimes(1);
    // Issue #6101 — the firing lands in the D1 ledger.
    const runs = await new D1JobRunRecordStore(
      createD1JobRunRecordDb(mockD1 as unknown as D1Database),
    ).listByJob("alarm-live-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("success");
  });

  it("(b) a deleted row with a stale live alarm does not fire either", async () => {
    const mockD1 = new MockD1Database();
    const deleted = { ...storedSystemRecord("retention", "paused", "alarm-stale-2"), state: "deleted" as const };
    await seed(mockD1, deleted);
    const storage = new SqliteTestStorage();
    const delegate = vi.fn(async () => ({ outcome: "success" as const }));
    await recordScheduleCallbackRun(
      storage.sql as never,
      "retention",
      {},
      staleAlarm("alarm-stale-2"),
      delegate,
      { env: { AGENT_DB: mockD1 } },
    );
    expect(delegate).not.toHaveBeenCalled();
  });

  it("(b) an explicit Run Now dispatch is never blocked by the paused gate", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("nightly-research", "paused", "alarm-stale-3"));
    const storage = new SqliteTestStorage();
    const delegate = vi.fn(async () => ({ outcome: "success" as const, descriptor: "research ran" }));
    await recordScheduleCallbackRun(
      storage.sql as never,
      "runResearchSchedule",
      { trigger: "triggered", scheduleId: "nightly-research" },
      staleAlarm("alarm-stale-3"),
      delegate,
      { env: { AGENT_DB: mockD1 } },
    );
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("(b) a firing with no store to consult fires (fail-open, kill-switch precedent)", async () => {
    const storage = new SqliteTestStorage();
    const delegate = vi.fn(async () => ({ outcome: "success" as const }));
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      {},
      staleAlarm("alarm-legacy-1"),
      delegate,
    );
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("(e) a paused nightly-research row does not fire on the research callback path", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("nightly-research", "paused", "alarm-research-stale"));
    const storage = new SqliteTestStorage();
    const delegate = vi.fn(async () => ({ outcome: "success" as const, descriptor: "research ran" }));
    await recordScheduleCallbackRun(
      storage.sql as never,
      "runResearchSchedule",
      {},
      staleAlarm("alarm-research-stale"),
      delegate,
      { env: { AGENT_DB: mockD1 } },
    );
    expect(delegate).not.toHaveBeenCalled();
    // Issue #6101 — the paused-skip row lands in the D1 ledger.
    const runs = await new D1JobRunRecordStore(
      createD1JobRunRecordDb(mockD1 as unknown as D1Database),
    ).listByJob("alarm-research-stale");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("skipped");
    expect(runs[0]!.detail).toMatch(/nightly-research.*paused|paused/);
  });

  it("(c) a paused stored goal maps to enabled=false, and its due-check is false", () => {
    // Production line: recordToGoal maps state "paused" to
    // enabled=false (src/services/unifiedScheduleManagement.ts),
    // and the goals tick skips disabled goals before isDue
    // (src/agents/scheduled-agent.ts `if (!goal.enabled &&
    // !isForced) continue`). The tick-level proof is the companion
    // file tests/no_derived_consolidation_6503_g3_goals_tick.test.ts.
    const paused = goalToRecord({
      id: "test-goal",
      name: "Test goal",
      cron: "0 6 * * *",
      operation: "test.op",
      budgetCents: 1,
      enabled: false,
    } as never);
    expect(paused.state).toBe("paused");
    const goal = recordToGoal(paused);
    expect(goal?.enabled).toBe(false);
    expect(
      isDue(goal!.cron, goal!.lastRun, new Date("2026-11-25T06:30:00.000Z"), goal!.timeZone, {
        paused: !goal!.enabled,
      }),
    ).toBe(false);
    const active = recordToGoal(
      goalToRecord({
        id: "test-goal",
        name: "Test goal",
        cron: "0 6 * * *",
        operation: "test.op",
        budgetCents: 1,
        enabled: true,
      } as never),
    );
    expect(active?.enabled).toBe(true);
    expect(
      isDue(active!.cron, active!.lastRun, new Date("2026-11-25T06:30:00.000Z"), active!.timeZone, {
        paused: !active!.enabled,
      }),
    ).toBe(true);
  });

  it("(d) the watchdog does not flag a paused row as missed", () => {
    const nowMs = Date.parse("2026-11-25T13:00:00.000Z");
    const hourMs = 60 * 60 * 1000;
    const paused = {
      id: "alarm-stale-1",
      callback: "retention",
      type: "interval" as const,
      time: Math.floor(Date.parse("2026-11-20T13:00:00.000Z") / 1000),
      intervalSeconds: MONTHLY_SECONDS,
      paused: true,
    };
    expect(
      findMissedDurableSchedule({
        schedule: paused,
        firstSeenAtMs: Date.parse("2026-10-20T13:00:00.000Z"),
        nowMs,
        graceMs: hourMs,
      }),
    ).toBeNull();
    // Control: the same alarm unpaused IS flagged (expected tick
    // 2026-10-21, no run, first seen before the tick, grace passed).
    const { paused: _paused, ...unpaused } = paused;
    expect(
      findMissedDurableSchedule({
        schedule: unpaused,
        firstSeenAtMs: Date.parse("2026-10-20T13:00:00.000Z"),
        nowMs,
        graceMs: hourMs,
      }),
    ).not.toBeNull();
  });

  it("(d) the watchdog sweep skips a paused row with a stale live alarm", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("retention", "paused", "alarm-stale-1"));
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec: (query: string, ...args: unknown[]) => {
        const stmt = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA)/i.test(query)) return stmt.all(...(args as never[])) as unknown[];
        const info = stmt.run(...(args as never[]));
        const out = [] as unknown[] & { rowsWritten?: number };
        out.rowsWritten = Number(info.changes);
        return out;
      },
    };
    const firstSeen = new Map<string, unknown>();
    firstSeen.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "alarm-stale-1": "2026-10-20T13:00:00.000Z",
    });
    const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const alerts: unknown[] = [];
    const result = await watchdogMissedSchedules(
      {
        env: { AGENT_DB: mockD1 },
        sql: sql as never,
        storage: {
          get: async (k: string) => firstSeen.get(k),
          put: async (k: string, v: unknown) => void firstSeen.set(k, v),
        },
        listSchedules: async () => [
          {
            id: "alarm-stale-1",
            callback: "retention",
            type: "interval",
            time: Math.floor(Date.parse("2026-11-20T13:00:00.000Z") / 1000),
            intervalSeconds: MONTHLY_SECONDS,
          },
        ],
        audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
          audits.push({ type, payload });
        },
        notifyMissedSchedule: async (info: unknown) => {
          alerts.push(info);
        },
      } as never,
      { recordedCallbacks: ["retention"], nowMs: Date.parse("2026-11-25T13:00:00.000Z") },
    );
    expect(result.examined).toBe(0);
    expect(result.missed).toBe(0);
    expect(result.alerted).toBe(0);
    expect(audits).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it("(d) the watchdog sweep still flags the same stale alarm when the row is active", async () => {
    const mockD1 = new MockD1Database();
    await seed(mockD1, storedSystemRecord("retention", "active", "alarm-stale-1"));
    const db = new DatabaseSync(":memory:");
    const sql = {
      exec: (query: string, ...args: unknown[]) => {
        const stmt = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA)/i.test(query)) return stmt.all(...(args as never[])) as unknown[];
        const info = stmt.run(...(args as never[]));
        const out = [] as unknown[] & { rowsWritten?: number };
        out.rowsWritten = Number(info.changes);
        return out;
      },
    };
    const firstSeen = new Map<string, unknown>();
    firstSeen.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
      "alarm-stale-1": "2026-10-20T13:00:00.000Z",
    });
    const result = await watchdogMissedSchedules(
      {
        env: { AGENT_DB: mockD1 },
        sql: sql as never,
        storage: {
          get: async (k: string) => firstSeen.get(k),
          put: async (k: string, v: unknown) => void firstSeen.set(k, v),
        },
        listSchedules: async () => [
          {
            id: "alarm-stale-1",
            callback: "retention",
            type: "interval",
            time: Math.floor(Date.parse("2026-11-20T13:00:00.000Z") / 1000),
            intervalSeconds: MONTHLY_SECONDS,
          },
        ],
        audit: () => {},
      } as never,
      { recordedCallbacks: ["retention"], nowMs: Date.parse("2026-11-25T13:00:00.000Z") },
    );
    expect(result.examined).toBe(1);
    expect(result.missed).toBe(1);
  });

  it("ticker-push: a paused feed pushes nothing on the stale-alarm tick", async () => {
    const mockD1 = new MockD1Database();
    await seed(
      mockD1,
      tickerPushScheduleToRecord(
        { intervalSeconds: 5, alarmId: "alarm-feed-stale", armed: true, paused: true },
        NOW,
      ),
    );
    liveMarketCache.clear();
    liveMarketCache.set("NVDA", {
      tick: {
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
      },
      expiresAt: Date.now() + 60000,
    } as never);
    const agent = Object.create(TickerAgent.prototype);
    agent.env = { AGENT_DB: mockD1 };
    const sent: string[] = [];
    const conn = {
      id: "conn-1",
      state: { symbols: ["NVDA"] },
      setState(s: unknown) {
        (this as { state: unknown }).state = s;
      },
      send(m: string) {
        sent.push(m);
      },
    };
    agent.getConnections = () => [conn];
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    try {
      await agent.pushTicks();
    } finally {
      vi.unstubAllGlobals();
      liveMarketCache.clear();
    }
    expect(sent).toHaveLength(0);
  });

  it("ticker-push: an unpaused feed still pushes on the tick", async () => {
    const mockD1 = new MockD1Database();
    await seed(
      mockD1,
      tickerPushScheduleToRecord(
        { intervalSeconds: 5, alarmId: "alarm-feed-live", armed: true },
        NOW,
      ),
    );
    liveMarketCache.clear();
    liveMarketCache.set("NVDA", {
      tick: {
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
      },
      expiresAt: Date.now() + 60000,
    } as never);
    const agent = Object.create(TickerAgent.prototype);
    agent.env = { AGENT_DB: mockD1 };
    const sent: string[] = [];
    const conn = {
      id: "conn-1",
      state: { symbols: ["NVDA"] },
      setState(s: unknown) {
        (this as { state: unknown }).state = s;
      },
      send(m: string) {
        sent.push(m);
      },
    };
    agent.getConnections = () => [conn];
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    try {
      await agent.pushTicks();
    } finally {
      vi.unstubAllGlobals();
      liveMarketCache.clear();
    }
    const ticks = sent.map((s) => JSON.parse(s)).filter((f: { type: string }) => f.type === "ticks");
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].ticks.map((q: { symbol: string }) => q.symbol)).toEqual(["NVDA"]);
  });
});

describe("6503 step 11: declared tasks seed exactly one stored row", () => {
  // Production lines pinned here:
  // - src/services/unifiedScheduleManagement.ts `seedDeclaredTaskRecords`
  //   (+ `declaredTaskIntervalSeconds`) — seed-once, never overwrite;
  // - src/agents/orchestrator/scheduledTasksObserve.ts
  //   `declareStrategyScanObserveTasks` — seeds then filters;
  // - src/agents/orchestrator/scheduledTasksCopilot.ts
  //   `declareStockCopilotTasks` — seeds then filters (the filter is
  //   new for this declarer: #4351's filter previously covered only
  //   the observe + pipeline declarers, so a paused/deleted copilot
  //   row would have been re-declared on every reconcile);
  // - the same file's `filterUndeclaredTasks` — a paused/deleted row
  //   is not declared, so Think cancels the arm and never re-arms it.
  // Counting note: on D1, `list()` always carries the migration-0092
  // builtin-goal rows, so "exactly one row" is asserted over
  // `listByKind("screen")` (the seeded declared-task kind) + `get(id)`.
  function d1Store(mockD1: MockD1Database) {
    return createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  }

  function observeCtx(mockD1: MockD1Database, userLogin?: string) {
    return {
      agentCtx: { storage: { get: async () => undefined, put: async () => {} } } as never,
      env: { AGENT_DB: mockD1 } as never,
      getScreenerExecutionContext: async () =>
        userLogin ? { userLogin, environment: "PROD" as const } : undefined,
      audit: () => {},
    } as never;
  }

  function copilotCtx(mockD1: MockD1Database, flagOn: boolean) {
    return {
      env: {
        STOCK_COPILOT_PAPER_ENABLED: flagOn ? "1" : "0",
        AGENT_DB: mockD1,
      } as never,
      agentCtx: {} as never,
      getScreenerExecutionContext: async () => ({ userLogin: "owner", environment: "TEST" as const }),
      getOrm: () => undefined,
      readSettingRaw: () => null,
      audit: () => {},
    } as never;
  }

  it("(a) two reconciles seed exactly ONE stored row for the observe task", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    const first = await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"));
    expect(Object.keys(first)).toEqual([STRATEGY_SCAN_OBSERVE_TASK_ID]);
    const second = await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"));
    expect(Object.keys(second)).toEqual([STRATEGY_SCAN_OBSERVE_TASK_ID]);
    const rows = await store.listByKind("screen");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(STRATEGY_SCAN_OBSERVE_TASK_ID);
    expect(row.kind).toBe("screen");
    expect(row.state).toBe("active");
    expect(row.callback).toBe("_runDeclaredScheduledTask");
    expect(row.definition).toMatchObject({
      type: "interval",
      intervalSeconds: 3600,
      callback: "_runDeclaredScheduledTask",
      payload: { taskId: STRATEGY_SCAN_OBSERVE_TASK_ID },
      schedule: "every 1 hour",
    });
    // The D1 adapter round-trips a null alarmId as undefined.
    expect(row.alarmId ?? null).toBeNull();
  });

  it("(a) two reconciles seed exactly ONE stored row for the copilot cycle task", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    const first = await declareStockCopilotTasks(copilotCtx(mockD1, true));
    expect(Object.keys(first)).toEqual([STOCK_COPILOT_TASK_ID]);
    const second = await declareStockCopilotTasks(copilotCtx(mockD1, true));
    expect(Object.keys(second)).toEqual([STOCK_COPILOT_TASK_ID]);
    const rows = await store.listByKind("screen");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(STOCK_COPILOT_TASK_ID);
    expect(row.kind).toBe("screen");
    expect(row.state).toBe("active");
    expect(row.definition).toMatchObject({
      type: "interval",
      intervalSeconds: 1800,
      callback: "_runDeclaredScheduledTask",
      payload: { taskId: STOCK_COPILOT_TASK_ID },
      schedule: "every 30 minutes",
    });
  });

  it("(a) the seeder never overwrites an operator re-time (direct unit pin)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    expect(declaredTaskIntervalSeconds("every 1 hour")).toBe(3600);
    expect(declaredTaskIntervalSeconds("every 30 minutes")).toBe(1800);
    expect(declaredTaskIntervalSeconds("0 6 * * *")).toBeNull();
    const first = await seedDeclaredTaskRecords(
      store,
      [{ taskId: STRATEGY_SCAN_OBSERVE_TASK_ID, schedule: "every 1 hour", ownerLogin: "venus" }],
      NOW,
    );
    expect(first.seeded).toEqual([STRATEGY_SCAN_OBSERVE_TASK_ID]);
    // Operator re-times the seeded row through the control routes.
    const seeded = await store.get(STRATEGY_SCAN_OBSERVE_TASK_ID);
    await store.save({
      ...seeded!,
      definition: { ...seeded!.definition, intervalSeconds: 7200 },
      updatedAt: NOW,
    });
    const second = await seedDeclaredTaskRecords(
      store,
      [{ taskId: STRATEGY_SCAN_OBSERVE_TASK_ID, schedule: "every 1 hour", ownerLogin: "venus" }],
      NOW,
    );
    expect(second.seeded).toEqual([]);
    expect(await store.list()).toHaveLength(1);
    const row = await store.get(STRATEGY_SCAN_OBSERVE_TASK_ID);
    expect((row?.definition as Record<string, unknown>).intervalSeconds).toBe(7200);
    expect(row?.state).toBe("active");
  });

  it("(b) an operator pause on the seeded observe row survives a second reconcile", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"));
    const paused = await pauseUnifiedSchedule(
      { store, alarms: alarmsStub() },
      STRATEGY_SCAN_OBSERVE_TASK_ID,
      NOW,
    );
    expect(paused.ok).toBe(true);
    const after = await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"));
    expect(after).toEqual({});
    const rows = await store.listByKind("screen");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("paused");
    expect((rows[0]!.definition as Record<string, unknown>).intervalSeconds).toBe(3600);
  });

  it("(b) an operator pause on the seeded copilot row survives a second reconcile", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    await declareStockCopilotTasks(copilotCtx(mockD1, true));
    const paused = await pauseUnifiedSchedule(
      { store, alarms: alarmsStub() },
      STOCK_COPILOT_TASK_ID,
      NOW,
    );
    expect(paused.ok).toBe(true);
    const after = await declareStockCopilotTasks(copilotCtx(mockD1, true));
    expect(after).toEqual({});
    const rows = await store.listByKind("screen");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("paused");
    expect((rows[0]!.definition as Record<string, unknown>).intervalSeconds).toBe(1800);
  });

  it("(c) a deleted observe task stays deleted across reboot/reconcile (tombstone respected)", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"));
    const deleted = await deleteUnifiedSchedule(
      { store, alarms: alarmsStub() },
      STRATEGY_SCAN_OBSERVE_TASK_ID,
    );
    expect(deleted.ok).toBe(true);
    // Two further reconciles (reboots): no resurrection, no duplicate.
    expect(await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"))).toEqual({});
    expect(await declareStrategyScanObserveTasks(observeCtx(mockD1, "venus"))).toEqual({});
    const rows = await store.listByKind("screen");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(STRATEGY_SCAN_OBSERVE_TASK_ID);
    expect(rows[0]!.state).toBe("deleted");
  });

  it("(c) a deleted copilot task stays deleted across reboot/reconcile (tombstone respected)", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    await declareStockCopilotTasks(copilotCtx(mockD1, true));
    const deleted = await deleteUnifiedSchedule(
      { store, alarms: alarmsStub() },
      STOCK_COPILOT_TASK_ID,
    );
    expect(deleted.ok).toBe(true);
    expect(await declareStockCopilotTasks(copilotCtx(mockD1, true))).toEqual({});
    expect(await declareStockCopilotTasks(copilotCtx(mockD1, true))).toEqual({});
    const rows = await store.listByKind("screen");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("deleted");
  });

  it("(d) a flag-off copilot task seeds no row", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    const tasks = await declareStockCopilotTasks(copilotCtx(mockD1, false));
    expect(tasks).toEqual({});
    expect(await store.get(STOCK_COPILOT_TASK_ID)).toBeUndefined();
    expect(await store.listByKind("screen")).toEqual([]);
  });

  it("(d) an observe task with no screener context seeds no row", async () => {
    const mockD1 = new MockD1Database();
    const store = d1Store(mockD1);
    const tasks = await declareStrategyScanObserveTasks(observeCtx(mockD1, undefined));
    expect(tasks).toEqual({});
    expect(await store.get(STRATEGY_SCAN_OBSERVE_TASK_ID)).toBeUndefined();
    expect(await store.listByKind("screen")).toEqual([]);
  });
});

/* =================================================================
 * 6503 step 12 — watchdog self-watch: the outer observation.
 *
 * Production code pinned here:
 * - `runWatchdogEntryPoint` (src/services/consolidatedCronEntries.ts):
 *   the hourly Worker-cron watchdog run; after the heartbeat-alarm
 *   check + re-arm it runs the observation best-effort and appends
 *   the finding to the dispatch row.
 * - `observeScheduleWatchdogHeartbeat` (same file): the read (the
 *   ScheduledAgent stub's `listJobRuns`, filtered by operation) and
 *   the alert (audit `schedule.missed_fire` via
 *   `postGoalScheduleAuditEvent` + catalog missed-schedule Slack
 *   text via the entry point's `slackPoster`).
 * - `decideScheduleWatchdogHeartbeat`
 *   (src/services/heartbeatWatchdog.ts): the pure finding —
 *   healthy / missing / stale against the heartbeat watchdog's own
 *   `staleAfterMs` (120 min default), reusing that configured
 *   threshold, no new literal.
 * - `SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION` /
 *   `SCHEDULE_WATCHDOG_SWEEP_OPERATION`
 *   (src/services/scheduleWatchdog.ts): the two operations written
 *   under the one heartbeat job id — the observation reads the
 *   heartbeat operation's row, never the sweep's.
 * ================================================================= */

describe("6503 step 12: outer observation watches the schedule-watchdog heartbeat", () => {
  const MIN = 60 * 1000;
  const NOW_MS = Date.parse(NOW);

  function heartbeatRow(startedIso: string) {
    return {
      jobId: SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
      operation: SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
      started: startedIso,
    };
  }

  function sweepRow(startedIso: string) {
    return {
      jobId: SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
      operation: SCHEDULE_WATCHDOG_SWEEP_OPERATION,
      started: startedIso,
    };
  }

  function makeStep12Deps(overrides: {
    rows?: Array<{ jobId: string; operation: string; started: string }> | Error;
    alarm?: "healthy" | "missing";
  } = {}) {
    const records: CronDispatchRecordInput[] = [];
    const rearms: Array<{ intervalSeconds: number; force?: boolean }> = [];
    const slackTexts: string[] = [];
    const auditPosts: Array<{
      type: string;
      agent: string;
      payload: Record<string, unknown>;
    }> = [];
    const logErrors: unknown[][] = [];
    const scheduledAgent = {
      onCron: async () => undefined,
      listSchedules: async () =>
        overrides.alarm === "missing"
          ? []
          : [{ id: "s1", callback: "onCron" }],
      getTickHistory: async () => [
        { timestamp: new Date(NOW_MS - 10 * MIN).toISOString() },
      ],
      ensureHeartbeatAlarm: async (
        intervalSeconds: number,
        opts?: { force?: boolean },
      ) => {
        rearms.push({ intervalSeconds, ...opts });
        return { armed: true, alreadyArmed: false };
      },
      listJobRuns: async () => {
        if (overrides.rows instanceof Error) throw overrides.rows;
        return overrides.rows ?? [];
      },
    };
    const deps = {
      cron: HEARTBEAT_WATCHDOG_CRON,
      entryPoint: "watchdog",
      serviceUserLogin: "service-user",
      serviceProvisioned: true,
      orchestrator: {
        fetch: async (request: Request) => {
          if (request.url.endsWith("/audit/event")) {
            auditPosts.push(
              (await request.json()) as {
                type: string;
                agent: string;
                payload: Record<string, unknown>;
              },
            );
            return new Response("{}", { status: 201 });
          }
          return new Response("{}", { status: 200 });
        },
      },
      scheduledAgent,
      renewTokens: async () => ({}),
      createSink: () => {
        throw new Error("watchdog entry point uses no observability sink");
      },
      slackPoster: async (text: string) => {
        slackTexts.push(text);
      },
      dispatchAndAwait: async (promise: Promise<unknown>) => {
        await promise;
      },
      recordDispatch: async (input: CronDispatchRecordInput) => {
        records.push(input);
      },
      now: () => new Date(NOW_MS),
      logError: (...args: unknown[]) => {
        logErrors.push(args);
      },
      logInfo: () => undefined,
      heartbeatWatchdog: { intervalSeconds: 1800, staleAfterMs: 120 * MIN },
    } as unknown as CronEntryPointDeps;
    return { deps, records, rearms, slackTexts, auditPosts, logErrors };
  }

  it("(a) a missing schedule-watchdog heartbeat row triggers the outer observation alert", async () => {
    const { deps, records, slackTexts, auditPosts } = makeStep12Deps({
      rows: [],
    });
    await runWatchdogEntryPoint(deps);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("schedule-watchdog heartbeat");
    expect(records[0].detail).toContain("missing");
    expect(slackTexts).toHaveLength(1);
    expect(slackTexts[0]).toContain("Missed schedule firing");
    expect(slackTexts[0]).toContain(SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID);
    expect(slackTexts[0]).toContain(SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION);
    expect(slackTexts[0]).toContain("never");
    expect(auditPosts).toHaveLength(1);
    expect(auditPosts[0].type).toBe("schedule.missed_fire");
    expect(auditPosts[0].agent).toBe("orchestrator");
    expect(auditPosts[0].payload.scheduleId).toBe(
      SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
    );
    expect(auditPosts[0].payload.callback).toBe(
      SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
    );
    expect(auditPosts[0].payload.code).toBe("missed_fire");
    expect(auditPosts[0].payload.lastRun).toBeNull();
  });

  it("(b) a stale heartbeat row triggers it", async () => {
    const staleIso = new Date(NOW_MS - 200 * MIN).toISOString();
    const { deps, records, slackTexts, auditPosts } = makeStep12Deps({
      rows: [heartbeatRow(staleIso)],
    });
    await runWatchdogEntryPoint(deps);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("stale");
    expect(slackTexts).toHaveLength(1);
    expect(slackTexts[0]).toContain(SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID);
    expect(slackTexts[0]).toContain(staleIso);
    expect(auditPosts).toHaveLength(1);
    expect(auditPosts[0].type).toBe("schedule.missed_fire");
    expect(auditPosts[0].payload.lastRun).toBe(staleIso);
    expect(auditPosts[0].payload.expectedTick).toBe(
      new Date(NOW_MS - 200 * MIN + 1800 * 1000).toISOString(),
    );
  });

  it("(c) a fresh heartbeat row triggers nothing", async () => {
    const freshIso = new Date(NOW_MS - 10 * MIN).toISOString();
    const { deps, records, slackTexts, auditPosts } = makeStep12Deps({
      rows: [heartbeatRow(freshIso)],
    });
    await runWatchdogEntryPoint(deps);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("schedule-watchdog heartbeat");
    expect(records[0].detail).toContain("fresh");
    expect(slackTexts).toHaveLength(0);
    expect(auditPosts).toHaveLength(0);
  });

  it("(c) a heartbeat row inside the staleAfter window does not alert (threshold is the heartbeat-watchdog staleAfter, not the 60-min missed-schedule grace)", async () => {
    const { deps, slackTexts, auditPosts } = makeStep12Deps({
      rows: [heartbeatRow(new Date(NOW_MS - 90 * MIN).toISOString())],
    });
    await runWatchdogEntryPoint(deps);
    expect(slackTexts).toHaveLength(0);
    expect(auditPosts).toHaveLength(0);
  });

  it("(d) a fresh sweep row does not mask a stale heartbeat row", async () => {
    const staleIso = new Date(NOW_MS - 200 * MIN).toISOString();
    const freshSweepIso = new Date(NOW_MS - 10 * MIN).toISOString();
    const { deps, slackTexts, auditPosts } = makeStep12Deps({
      rows: [sweepRow(freshSweepIso), heartbeatRow(staleIso)],
    });
    await runWatchdogEntryPoint(deps);
    expect(slackTexts).toHaveLength(1);
    expect(slackTexts[0]).toContain(staleIso);
    expect(auditPosts).toHaveLength(1);
    expect(auditPosts[0].payload.lastRun).toBe(staleIso);
    expect(auditPosts[0].payload.callback).toBe(
      SCHEDULE_WATCHDOG_HEARTBEAT_OPERATION,
    );
  });

  it("(e) a ledger read failure does not fail the cron run (re-arm check still runs)", async () => {
    const { deps, records, rearms, slackTexts, auditPosts, logErrors } =
      makeStep12Deps({
        rows: new Error("DO storage unavailable"),
        alarm: "missing",
      });
    await expect(runWatchdogEntryPoint(deps)).resolves.toBeUndefined();
    expect(rearms).toHaveLength(1);
    expect(rearms[0]).toEqual({ intervalSeconds: 1800, force: false });
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toContain("observation failed");
    expect(slackTexts).toHaveLength(0);
    expect(auditPosts).toHaveLength(0);
    expect(logErrors.flat().join(" ")).toContain("observation failed");
  });

  it("pure decider: missing / stale / healthy follow the staleAfter threshold", () => {
    expect(
      decideScheduleWatchdogHeartbeat({
        lastHeartbeatAtMs: null,
        nowMs: NOW_MS,
        staleAfterMs: 120 * MIN,
        intervalSeconds: 1800,
      }).finding,
    ).toBe("missing");
    const stale = decideScheduleWatchdogHeartbeat({
      lastHeartbeatAtMs: NOW_MS - 200 * MIN,
      nowMs: NOW_MS,
      staleAfterMs: 120 * MIN,
      intervalSeconds: 1800,
    });
    expect(stale.finding).toBe("stale");
    expect(stale.expectedTickIso).toBe(
      new Date(NOW_MS - 200 * MIN + 1800 * 1000).toISOString(),
    );
    expect(
      decideScheduleWatchdogHeartbeat({
        lastHeartbeatAtMs: NOW_MS - 10 * MIN,
        nowMs: NOW_MS,
        staleAfterMs: 120 * MIN,
        intervalSeconds: 1800,
      }).finding,
    ).toBe("healthy");
  });
});
