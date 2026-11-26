/**
 * Issue #3121 #4239 — broker token renewal in the single schedule.
 *
 * The renewal duty fires today through its stored schedule
 * (#6503): the six system duties are real stored platform-level
 * rows (monthly, created paused), fired through their entry
 * points when the stored schedule fires, and the Schedules home
 * lists the stored token-renewal row with its last renewal joined
 * from the ledger, so the row reads "Last renewal: …" — or
 * "never" when the duty has never fired. The old derived record
 * (synthesized at read time, management refused with a coded
 * "derived record" error) is deleted: the row renders only when
 * stored, and the verbs operate on the stored row (404 when it
 * is missing).
 *
 * Record-only in the same sense as #4237: no new kind, no new
 * alarm, no new firing mechanism. The manual trigger stays on its
 * existing route POST /api/schedules/trigger-renew.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  UNIFIED_SCHEDULE_KINDS,
  type UnifiedScheduleRecord,
} from "../src/data/unifiedSchedulePorts";
import {
  TOKEN_RENEWAL_RECORD_ID,
  TOKEN_RENEWAL_ORIGIN,
  tokenRenewalRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
  reconcileSystemScheduleRecords,
} from "../src/services/unifiedScheduleManagement";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { buildJobRunRecord, scheduleIdToLedgerJobId } from "../src/services/jobRunRecords";
import { RENEWAL_DISPATCH_CRON } from "../src/services/heartbeatDueChecks";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { scheduleTitle } from "../src/client/scheduledOptionsManager/scheduleDetail";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
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

const NOW = "2026-11-18T23:00:00.000Z";
const MONTHLY_SECONDS = 2_592_000;

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

/** A stored token-renewal row, as the seed creates it (state set by the test). */
function storedRenewalRecord(
  state: "active" | "paused",
  createdAt = NOW,
): UnifiedScheduleRecord {
  return {
    id: "token-renewal",
    kind: "internal",
    state,
    callback: "autoRenewETradeTokens",
    definition: {
      type: "interval",
      intervalSeconds: MONTHLY_SECONDS,
      callback: "autoRenewETradeTokens",
    } as unknown as UnifiedScheduleRecord["definition"],
    ownerLogin: null,
    provenance: { origin: "system", createdBy: "system", reason: "token-renewal", createdAt },
    alarmId: null,
    pausedAt: state === "paused" ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
  };
}

function alarmsStub(overrides: Record<string, unknown> = {}): any {
  return {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "autoRenewETradeTokens" }),
    ...overrides,
  };
}

describe("4239 stored token-renewal record", () => {
  it("reconcile seeds the one stable renewal record (id token-renewal, internal, paused, monthly)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const result = await reconcileSystemScheduleRecords(
      { store, alarms: alarmsStub() },
      NOW,
    );
    expect(result.seeded).toContain("token-renewal");
    const record = await store.get("token-renewal");
    expect(record?.id).toBe("token-renewal");
    expect(TOKEN_RENEWAL_RECORD_ID).toBe("token-renewal");
    expect(record?.kind).toBe("internal");
    expect(record?.state).toBe("paused");
    expect(record?.callback).toBe("autoRenewETradeTokens");
    expect(
      (record?.definition as unknown as Record<string, unknown>).intervalSeconds,
    ).toBe(MONTHLY_SECONDS);
    expect(
      (record?.definition as unknown as Record<string, unknown>).cron,
    ).toBeUndefined();
    expect(record?.provenance.origin).toBe("system");
    expect(record?.provenance.reason).toBe("token-renewal");
    expect(TOKEN_RENEWAL_ORIGIN).toBe("token-renewal");
    expect(record?.alarmId).toBeNull();
    expect(record?.createdAt).toBe(NOW);
    expect(record?.updatedAt).toBe(NOW);
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("token-renewal");
  });

  it("an in-place update preserves createdAt (upsert, not recreate)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRenewalRecord("active", "2026-11-17T23:00:00.000Z"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "token-renewal", NOW);
    expect(paused.ok).toBe(true);
    const after = await store.get("token-renewal");
    expect(after?.createdAt).toBe("2026-11-17T23:00:00.000Z");
    expect(after?.updatedAt).toBe(NOW);
    expect(after?.pausedAt).toBe(NOW);
    expect(after?.id).toBe("token-renewal");
  });
});

describe("4239 renewal list item (Schedules home row)", () => {
  it("carries the last renewal joined from the ledger", () => {
    const record = storedRenewalRecord("active");
    const item = tokenRenewalRecordToListItem(record, {
      started: "2026-11-18T03:00:00.000Z",
      finished: "2026-11-18T03:00:05.000Z",
      outcome: "success",
    });
    expect(item.id).toBe("token-renewal");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("autoRenewETradeTokens");
    // The stored row is a monthly interval, not the old daily cron.
    expect(item.cron).toBeUndefined();
    expect(item.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(item.state).toBe("active");
    expect(item.lastRunAt).toBe("2026-11-18T03:00:00.000Z");
    expect(item.lastRunOutcome).toBe("success");
  });

  it("carries no last run when the duty has never fired", () => {
    const item = tokenRenewalRecordToListItem(storedRenewalRecord("paused"));
    expect(item.lastRunAt).toBeUndefined();
    expect(item.lastRunOutcome).toBeUndefined();
  });
});

describe("4239 home naming + classifier", () => {
  it("names the renewal callback 'Scheduled token renewal'", () => {
    expect(scheduleTitle({ callback: "autoRenewETradeTokens" } as never)).toBe("Scheduled token renewal");
  });

  it("classifies the renewal callback as system, not trading", () => {
    // The callback name contains "trade" (ETrade); the trading rule
    // must not shadow the system rule for token upkeep.
    expect(classifyScheduleKind({ callback: "autoRenewETradeTokens" })).toBe("system");
  });

  it("resolves the renewal record id to its ledger job id", () => {
    expect(scheduleIdToLedgerJobId("token-renewal")).toBe(RENEWAL_DISPATCH_CRON);
    expect(scheduleIdToLedgerJobId("token-renewal")).toBe("0 3 * * *");
    expect(scheduleIdToLedgerJobId("other-schedule")).toBe("other-schedule");
  });
});

describe("4239 management works on the stored renewal record (no derived refusal)", () => {
  it("pause pauses a stored active renewal row", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRenewalRecord("active"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "token-renewal", NOW);
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.record.state).toBe("paused");
      expect(paused.record.id).toBe("token-renewal");
    }
    expect((await store.get("token-renewal"))?.state).toBe("paused");
  });

  it("resume re-arms a stored paused renewal row from its own monthly timing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRenewalRecord("paused"));
    const arm = vi.fn(async () => ({ id: "alarm-9", callback: "autoRenewETradeTokens" }));
    const resumed = await resumeUnifiedSchedule(
      { store, alarms: alarmsStub({ arm }) },
      "token-renewal",
      NOW,
    );
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.record.state).toBe("active");
      expect(resumed.record.alarmId).toBe("alarm-9");
    }
    expect(arm).toHaveBeenCalledTimes(1);
    const [timing] = arm.mock.calls[0] as unknown as Array<Record<string, unknown>>;
    expect(timing).toEqual({ type: "interval", intervalSeconds: MONTHLY_SECONDS });
  });

  it("trigger runs a stored active renewal row and stamps triggered, not manual", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save({ ...storedRenewalRecord("active"), alarmId: "alarm-1" });
    const seen: Array<{ callback: string; payload: unknown }> = [];
    const triggered = await triggerUnifiedSchedule(
      {
        store,
        alarms: alarmsStub({
          get: async () => ({ id: "alarm-1", callback: "autoRenewETradeTokens", payload: {} }),
        }),
      },
      "token-renewal",
      async (callback: string, payload: unknown) => {
        seen.push({ callback, payload });
      },
    );
    expect(triggered.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].callback).toBe("autoRenewETradeTokens");
    expect((seen[0].payload as Record<string, unknown>).trigger).toBe("triggered");
  });

  it("update re-times a stored paused renewal row without an alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRenewalRecord("paused"));
    const updated = await updateUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "token-renewal",
      { intervalSeconds: MONTHLY_SECONDS * 2 },
      Date.parse(NOW),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.record.state).toBe("paused");
      const def = updated.record.definition as unknown as Record<string, unknown>;
      expect(def.intervalSeconds).toBe(MONTHLY_SECONDS * 2);
      expect(updated.record.createdAt).toBe(NOW);
    }
  });

  it("delete removes a stored renewal row and it stays gone", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRenewalRecord("paused"));
    const deleted = await deleteUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "token-renewal",
    );
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.cancelled).toBe(true);
    expect(await store.get("token-renewal")).toBeUndefined();
  });

  it("a missing renewal row 404s every verb, never a derived refusal", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    // The strict alarms port: cancelling an unknown id is false
    // (nothing was there), like the real port's contract.
    const deps = { store, alarms: alarmsStub({ cancel: async () => false }) };
    // Each verb 404s a missing row; resume names the missing
    // pause instead of "not found" (it resumes paused rows only).
    const cases: Array<{ result: Awaited<ReturnType<typeof pauseUnifiedSchedule>>; message: string }> = [
      { result: await pauseUnifiedSchedule(deps, "token-renewal", NOW), message: "not found" },
      { result: await resumeUnifiedSchedule(deps, "token-renewal", NOW), message: "is not paused" },
      { result: await deleteUnifiedSchedule(deps, "token-renewal"), message: "not found" },
      { result: await triggerUnifiedSchedule(deps, "token-renewal", async () => {}), message: "not found" },
      {
        result: await updateUnifiedSchedule(deps, "token-renewal", { intervalSeconds: MONTHLY_SECONDS }, Date.parse(NOW)),
        message: "not found",
      },
    ];
    for (const { result, message } of cases) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error).toContain("token-renewal");
        expect(result.error).toContain(message);
        expect(result.error).not.toContain("derived");
      }
    }
  });
});

describe("4239 list route reads the stored renewal row (no synthesis)", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;
  let d1: MockD1Database;

  function baseCtx(overrides: Partial<SchedulesRouteContext> = {}): SchedulesRouteContext {
    return {
      env: { AGENT_DB: d1 },
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
      ...overrides,
    } as unknown as SchedulesRouteContext;
  }

  function seedRenewalRun() {
    new SqlJobRunRecordStore(sql.sql as never).record(
      buildJobRunRecord({
        system: "worker-cron",
        jobId: RENEWAL_DISPATCH_CRON,
        operation: "renewTokens",
        started: "2026-11-18T03:00:00.000Z",
        finished: "2026-11-18T03:00:05.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
      }),
    );
  }

  /** The stored renewal row the list renders (D1 only, #6503 fail-closed). */
  async function seedStoredRenewalRow() {
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    // Paused: the seed default — and the list renders a stored row
    // from the store only when paused (an active row renders
    // through its live alarm, which this fixture has none of).
    await store.save(storedRenewalRecord("paused"));
  }

  beforeEach(async () => {
    sql = new SqliteTestStorage();
    d1 = new MockD1Database();
    ctx = baseCtx();
    await seedStoredRenewalRow();
  });

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  it("shows the stored renewal row with its last renewal when the ledger has a run", async () => {
    seedRenewalRun();
    const body = await list();
    const row = body.schedules.find((s) => s.id === "token-renewal");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("internal");
    expect(row?.callback).toBe("autoRenewETradeTokens");
    expect(row?.cron).toBeUndefined();
    expect(row?.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(row?.state).toBe("paused");
    expect(row?.lastRunAt).toBe("2026-11-18T03:00:00.000Z");
    expect(row?.lastRunOutcome).toBe("success");
  });

  it("shows the stored row with no last run when the duty has never fired", async () => {
    const body = await list();
    const row = body.schedules.find((s) => s.id === "token-renewal");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });

  it("keeps the stored row without a last run (list still 200) when the ledger read throws", async () => {
    // The ledger read fails but the unified-store list still works:
    // only job_run_records queries throw. The stored row renders
    // without its last run — a ledger failure never drops a row.
    const ledgerDownSql = {
      exec: (query: string, ...params: unknown[]) => {
        if (query.includes("job_run_records")) throw new Error("sql down");
        return sql.exec(query, ...params);
      },
    };
    const throwing = baseCtx({
      agentCtx: { storage: { sql: ledgerDownSql as never } } as never,
    });
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", throwing);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { schedules: Array<Record<string, unknown>> };
    const row = body.schedules.find((s) => s.id === "token-renewal");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });
});

describe("4239 runs routes join the renewal record to its ledger rows", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;

  function baseCtx(): SchedulesRouteContext {
    return {
      env: {},
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

  beforeEach(() => {
    sql = new SqliteTestStorage();
    ctx = baseCtx();
    new SqlJobRunRecordStore(sql.sql as never).record(
      buildJobRunRecord({
        system: "worker-cron",
        jobId: RENEWAL_DISPATCH_CRON,
        operation: "renewTokens",
        started: "2026-11-18T03:00:00.000Z",
        finished: "2026-11-18T03:00:05.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
      }),
    );
  });

  async function call(path: string, url = `https://agent.internal${path}`) {
    return handleSchedulesRoutes(
      new Request(url, { method: "GET" }),
      new URL(url),
      path,
      "session-1",
      ctx,
    );
  }

  it("GET /schedules/token-renewal/runs returns the renewal ledger rows", async () => {
    const res = await call("/schedules/token-renewal/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe(RENEWAL_DISPATCH_CRON);
  });

  it("GET /schedules/runs?scheduleId=token-renewal returns the same rows", async () => {
    const res = await call("/schedules/runs", "https://agent.internal/schedules/runs?scheduleId=token-renewal");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe(RENEWAL_DISPATCH_CRON);
  });
});

describe("4239 detail route answers the stored renewal record", () => {
  it("GET /api/schedules/token-renewal returns the stored detail, not 404", async () => {
    const sql = new SqliteTestStorage();
    const d1 = new MockD1Database();
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    await store.save(storedRenewalRecord("active"));
    const ctx = {
      env: { AGENT_DB: d1 },
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
    const path = "/api/schedules/token-renewal";
    const res = await handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method: "GET" }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    const detail = data.schedule ?? data;
    expect(detail.id).toBe("token-renewal");
    expect(detail.callback).toBe("autoRenewETradeTokens");
  });
});

describe("4239 Schedules home renders the renewal row (source pins)", () => {
  it("the panel names the renewal row and shows its last renewal", () => {
    const panel = source("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("Last renewal");
    expect(panel).toContain('s.id === "token-renewal"');
    expect(panel).toContain("lastRunAt");
  });

  it("the client list item carries the renewal fields", () => {
    const jobsApi = source("src/client/jobsApi.ts");
    expect(jobsApi).toContain("lastRunAt");
    expect(jobsApi).toContain("lastRunOutcome");
  });

  it("no new firing: the renewal fires through its stored schedule, not the heartbeat due-check", () => {
    // Issue #6503 — the heartbeat due-checks are retired: the duty
    // fires through its stored schedule's entry point, which lives
    // in consolidatedCronEntries (not the scheduled agent).
    const entries = source("src/services/consolidatedCronEntries.ts");
    expect(entries).toContain("runRenewTokensEntryPoint");
    // The slice adds no Worker cron and no SDK alarm for renewal.
    // The old dispatch cron survives only as the ledger job id.
    const dueChecks = source("src/services/heartbeatDueChecks.ts");
    expect(dueChecks).toContain('RENEWAL_DISPATCH_CRON = "0 3 * * *"');
  });
});
