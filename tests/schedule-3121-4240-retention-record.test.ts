/**
 * Issue #3121 #4240 — retention pass in the single schedule.
 *
 * The retention duty fires today through its stored schedule
 * (#6503): the six system duties are real stored platform-level
 * rows (monthly, created paused), fired through their entry
 * points when the stored schedule fires, and the Schedules home
 * lists the stored retention row with its last pass joined from
 * the ledger, so the row reads "Last pass: …" with the
 * prune/export summary — or "never" when the duty has never
 * fired. The old derived record (synthesized at read time,
 * management refused with a coded "derived record" error) is
 * deleted: the row renders only when stored, and the verbs
 * operate on the stored row (404 when it is missing).
 *
 * Record-only in the same sense as #4239: no new kind, no new
 * alarm, no new firing mechanism. The manual trigger stays
 * on its existing route POST /api/schedules/trigger-retention.
 * The pass-outcome summary is built by the entry point from the
 * route's own response (prune counts, orphan sweep, snapshot
 * export status) and stored as the dispatch row's `detail`, so the
 * home renders it verbatim — no second parser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  UNIFIED_SCHEDULE_KINDS,
  type UnifiedScheduleRecord,
} from "../src/data/unifiedSchedulePorts";
import {
  RETENTION_RECORD_ID,
  RETENTION_ORIGIN,
  retentionRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
  reconcileSystemScheduleRecords,
} from "../src/services/unifiedScheduleManagement";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import { buildJobRunRecord, scheduleIdToLedgerJobId } from "../src/services/jobRunRecords";
import { RETENTION_DISPATCH_CRON } from "../src/services/heartbeatDueChecks";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { scheduleTitle } from "../src/client/scheduledOptionsManager/scheduleDetail";
import {
  retentionPassSummary,
  runRetentionEntryPoint,
  type CronDispatchRecordInput,
  type CronEntryPointDeps,
} from "../src/services/consolidatedCronEntries";
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

const NOW = "2026-11-19T06:00:00.000Z";

const RETENTION_BODY = {
  success: true,
  skipped: false,
  pruned: 12,
  eventsPruned: 2,
  memoryPruned: 0,
  jobOutcomesPruned: 3,
  orphanSweep: {
    scanned: 9,
    orphans: 2,
    danglingRows: 0,
    deleted: 0,
    deleteFailed: 0,
    deleteEnabled: false,
    truncated: false,
    error: null,
  },
  snapshot: {
    tables: 41,
    rows: 1234,
    truncatedTables: [],
    key: "snapshots/orchestrator/2026-11-19.json",
    error: null,
    skipped: null,
  },
};

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

/** A stored retention row, as the seed creates it (state set by the test). */
function storedRetentionRecord(
  state: "active" | "paused",
  createdAt = NOW,
): UnifiedScheduleRecord {
  return {
    id: "retention",
    kind: "internal",
    state,
    callback: "retention",
    definition: {
      type: "interval",
      intervalSeconds: MONTHLY_SECONDS,
      callback: "retention",
    } as unknown as UnifiedScheduleRecord["definition"],
    ownerLogin: null,
    provenance: { origin: "system", createdBy: "system", reason: "retention", createdAt },
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
    arm: async () => ({ id: "new-1", callback: "retention" }),
    ...overrides,
  };
}

describe("4240 stored retention record", () => {
  it("reconcile seeds the one stable retention record (id retention, internal, paused, monthly)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const result = await reconcileSystemScheduleRecords(
      { store, alarms: alarmsStub() },
      NOW,
    );
    expect(result.seeded).toContain("retention");
    const record = await store.get("retention");
    expect(record?.id).toBe("retention");
    expect(RETENTION_RECORD_ID).toBe("retention");
    expect(record?.kind).toBe("internal");
    expect(record?.state).toBe("paused");
    expect(record?.callback).toBe("retention");
    expect(
      (record?.definition as unknown as Record<string, unknown>).intervalSeconds,
    ).toBe(MONTHLY_SECONDS);
    expect(
      (record?.definition as unknown as Record<string, unknown>).cron,
    ).toBeUndefined();
    expect(record?.provenance.origin).toBe("system");
    expect(record?.provenance.reason).toBe("retention");
    expect(RETENTION_ORIGIN).toBe("retention");
    expect(record?.alarmId).toBeNull();
    expect(record?.createdAt).toBe(NOW);
    expect(record?.updatedAt).toBe(NOW);
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("retention");
  });

  it("an in-place update preserves createdAt (upsert, not recreate)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRetentionRecord("active", "2026-11-18T06:00:00.000Z"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "retention", NOW);
    expect(paused.ok).toBe(true);
    const after = await store.get("retention");
    expect(after?.createdAt).toBe("2026-11-18T06:00:00.000Z");
    expect(after?.updatedAt).toBe(NOW);
    expect(after?.pausedAt).toBe(NOW);
    expect(after?.id).toBe("retention");
  });
});

describe("4240 retention list item (Schedules home row)", () => {
  it("carries the last pass joined from the ledger, detail verbatim", () => {
    const record = storedRetentionRecord("active");
    const item = retentionRecordToListItem(record, {
      started: "2026-11-19T04:00:00.000Z",
      finished: "2026-11-19T04:00:05.000Z",
      outcome: "success",
      detail: "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    });
    expect(item.id).toBe("retention");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("retention");
    // The stored row is a monthly interval, not the old daily cron.
    expect(item.cron).toBeUndefined();
    expect(item.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(item.state).toBe("active");
    expect(item.lastRunAt).toBe("2026-11-19T04:00:00.000Z");
    expect(item.lastRunOutcome).toBe("success");
    expect(item.lastRunDetail).toBe(
      "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    );
  });

  it("carries no last run when the duty has never fired", () => {
    const item = retentionRecordToListItem(storedRetentionRecord("paused"));
    expect(item.lastRunAt).toBeUndefined();
    expect(item.lastRunOutcome).toBeUndefined();
    expect(item.lastRunDetail).toBeUndefined();
  });
});

describe("4240 retention pass summary (dispatch detail)", () => {
  it("summarizes a full pass: total pruned, job outcomes, orphans, snapshot", () => {
    expect(retentionPassSummary(RETENTION_BODY)).toBe(
      "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    );
  });

  it("names a skipped storage prune and a disabled snapshot export", () => {
    expect(
      retentionPassSummary({
        skipped: true,
        pruned: 0,
        eventsPruned: 0,
        memoryPruned: 0,
        jobOutcomesPruned: 0,
        orphanSweep: { scanned: 0, orphans: 0, deleted: 0, error: null },
        snapshot: { skipped: "disabled by RETENTION_SNAPSHOT_ENABLED=false" },
      }),
    ).toBe(
      "pruned=skipped jobOutcomes=0 orphans=0/0 deleted=0 snapshot=skipped: disabled by RETENTION_SNAPSHOT_ENABLED=false",
    );
  });

  it("names a failed orphan sweep and a failed snapshot export", () => {
    expect(
      retentionPassSummary({
        pruned: 5,
        jobOutcomesPruned: 1,
        orphanSweep: { error: "referenced-keys read failed: boom" },
        snapshot: { error: "bucket write failed" },
      }),
    ).toBe(
      "pruned=5 jobOutcomes=1 orphanSweep=error: referenced-keys read failed: boom snapshot=error: bucket write failed",
    );
  });

  it("returns undefined for a non-object or empty body (no fabricated detail)", () => {
    expect(retentionPassSummary(null)).toBeUndefined();
    expect(retentionPassSummary("ok")).toBeUndefined();
    expect(retentionPassSummary({})).toBeUndefined();
  });
});

describe("4240 home naming + classifier", () => {
  it("names the retention callback 'Scheduled retention pass'", () => {
    expect(scheduleTitle({ callback: "retention" } as never)).toBe("Scheduled retention pass");
  });

  it("classifies the retention callback as system upkeep", () => {
    expect(classifyScheduleKind({ callback: "retention" })).toBe("system");
  });

  it("resolves the retention record id to its ledger job id", () => {
    expect(scheduleIdToLedgerJobId("retention")).toBe(RETENTION_DISPATCH_CRON);
    expect(scheduleIdToLedgerJobId("retention")).toBe("0 4 * * *");
    expect(scheduleIdToLedgerJobId("other-schedule")).toBe("other-schedule");
  });
});

describe("4240 management works on the stored retention record (no derived refusal)", () => {
  it("pause pauses a stored active retention row", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRetentionRecord("active"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "retention", NOW);
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.record.state).toBe("paused");
      expect(paused.record.id).toBe("retention");
    }
    expect((await store.get("retention"))?.state).toBe("paused");
  });

  it("resume re-arms a stored paused retention row from its own monthly timing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRetentionRecord("paused"));
    const arm = vi.fn(async () => ({ id: "alarm-9", callback: "retention" }));
    const resumed = await resumeUnifiedSchedule(
      { store, alarms: alarmsStub({ arm }) },
      "retention",
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

  it("trigger runs a stored active retention row and stamps triggered, not manual", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save({ ...storedRetentionRecord("active"), alarmId: "alarm-1" });
    const seen: Array<{ callback: string; payload: unknown }> = [];
    const triggered = await triggerUnifiedSchedule(
      {
        store,
        alarms: alarmsStub({
          get: async () => ({ id: "alarm-1", callback: "retention", payload: {} }),
        }),
      },
      "retention",
      async (callback: string, payload: unknown) => {
        seen.push({ callback, payload });
      },
    );
    expect(triggered.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].callback).toBe("retention");
    expect((seen[0].payload as Record<string, unknown>).trigger).toBe("triggered");
  });

  it("update re-times a stored paused retention row without an alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRetentionRecord("paused"));
    const updated = await updateUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "retention",
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

  it("delete removes a stored retention row and it stays gone", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedRetentionRecord("paused"));
    const deleted = await deleteUnifiedSchedule(
      { store, alarms: alarmsStub() },
      "retention",
    );
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.cancelled).toBe(true);
    expect(await store.get("retention")).toBeUndefined();
  });

  it("a missing retention row 404s every verb, never a derived refusal", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    // The strict alarms port: cancelling an unknown id is false
    // (nothing was there), like the real port's contract.
    const deps = { store, alarms: alarmsStub({ cancel: async () => false }) };
    const cases: Array<{ result: Awaited<ReturnType<typeof pauseUnifiedSchedule>>; message: string }> = [
      { result: await pauseUnifiedSchedule(deps, "retention", NOW), message: "not found" },
      { result: await resumeUnifiedSchedule(deps, "retention", NOW), message: "is not paused" },
      { result: await deleteUnifiedSchedule(deps, "retention"), message: "not found" },
      { result: await triggerUnifiedSchedule(deps, "retention", async () => {}), message: "not found" },
      {
        result: await updateUnifiedSchedule(deps, "retention", { intervalSeconds: MONTHLY_SECONDS }, Date.parse(NOW)),
        message: "not found",
      },
    ];
    for (const { result, message } of cases) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error).toContain("retention");
        expect(result.error).toContain(message);
        expect(result.error).not.toContain("derived");
      }
    }
  });
});

describe("4240 entry point records the pass summary in the dispatch detail", () => {
  it("success with a retention body stores the summary as detail", async () => {
    const records: CronDispatchRecordInput[] = [];
    const deps = {
      cron: RETENTION_DISPATCH_CRON,
      entryPoint: "retention",
      serviceUserLogin: "svc-background",
      serviceProvisioned: true,
      orchestrator: {
        fetch: async () =>
          new Response(JSON.stringify(RETENTION_BODY), { status: 200 }),
      },
      dispatchAndAwait: async (promise: Promise<unknown>) => {
        await promise;
      },
      recordDispatch: async (input: CronDispatchRecordInput) => {
        records.push(input);
      },
      now: () => new Date("2026-11-19T04:00:05.000Z"),
      logError: () => {},
      logInfo: () => {},
    } as unknown as CronEntryPointDeps;
    await runRetentionEntryPoint(deps);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      cron: RETENTION_DISPATCH_CRON,
      entryPoint: "retention",
      outcome: "success",
    });
    expect(records[0].detail).toBe(
      "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    );
  });

  it("an unparseable body never fails the dispatch (detail omitted)", async () => {
    const records: CronDispatchRecordInput[] = [];
    const deps = {
      cron: RETENTION_DISPATCH_CRON,
      entryPoint: "retention",
      serviceUserLogin: "svc-background",
      serviceProvisioned: true,
      orchestrator: {
        fetch: async () => new Response("not-json", { status: 200 }),
      },
      dispatchAndAwait: async (promise: Promise<unknown>) => {
        await promise;
      },
      recordDispatch: async (input: CronDispatchRecordInput) => {
        records.push(input);
      },
      now: () => new Date("2026-11-19T04:00:05.000Z"),
      logError: () => {},
      logInfo: () => {},
    } as unknown as CronEntryPointDeps;
    await expect(runRetentionEntryPoint(deps)).resolves.toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].detail).toBeUndefined();
  });
});

/**
 * Issue #6101 — the ledger-down double: a D1 binding whose
 * job_run_records statements throw, while every other table still
 * reads (the unified-schedule list the route renders alongside).
 */
function ledgerDownD1(d1: MockD1Database) {
  return {
    prepare(sql: string) {
      if (sql.includes("job_run_records")) throw new Error("d1 down");
      return d1.prepare(sql);
    },
    batch: (statements: any[]) => d1.batch(statements),
  };
}

describe("4240 list route reads the stored retention row (no synthesis)", () => {
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

  async function seedRetentionRun() {
    // Issue #6101 — the seed lands in D1, not the DO.
    const store = new D1JobRunRecordStore(
      createD1JobRunRecordDb(d1 as unknown as D1Database),
    );
    await store.record(
      buildJobRunRecord({
        system: "worker-cron",
        jobId: RETENTION_DISPATCH_CRON,
        operation: "retention",
        started: "2026-11-19T04:00:00.000Z",
        finished: "2026-11-19T04:00:05.000Z",
        outcome: "success",
        detail:
          "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
        triggeredBy: "scheduled",
      }),
    );
  }

  /** The stored retention row the list renders (D1 only, #6503 fail-closed). */
  async function seedStoredRetentionRow() {
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    // Paused: the seed default — and the list renders a stored row
    // from the store only when paused (an active row renders
    // through its live alarm, which this fixture has none of).
    await store.save(storedRetentionRecord("paused"));
  }

  beforeEach(async () => {
    sql = new SqliteTestStorage();
    d1 = new MockD1Database();
    ctx = baseCtx();
    await seedStoredRetentionRow();
  });

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  it("shows the stored retention row with its last pass when the ledger has a run", async () => {
    await seedRetentionRun();
    const body = await list();
    const row = body.schedules.find((s) => s.id === "retention");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("internal");
    expect(row?.callback).toBe("retention");
    expect(row?.cron).toBeUndefined();
    expect(row?.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(row?.state).toBe("paused");
    expect(row?.lastRunAt).toBe("2026-11-19T04:00:00.000Z");
    expect(row?.lastRunOutcome).toBe("success");
    expect(row?.lastRunDetail).toBe(
      "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    );
  });

  it("shows the stored row with no last run when the duty has never fired", async () => {
    const body = await list();
    const row = body.schedules.find((s) => s.id === "retention");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });

  it("keeps the stored row without a last run (list still 200) when the ledger read throws", async () => {
    // The ledger read fails but the unified-store list still works:
    // only job_run_records statements throw. The stored row renders
    // without its last run — a ledger failure never drops a row.
    const throwing = baseCtx({
      env: { AGENT_DB: ledgerDownD1(d1) as never },
    });
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", throwing);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { schedules: Array<Record<string, unknown>> };
    const row = body.schedules.find((s) => s.id === "retention");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });
});

describe("4240 runs routes join the retention record to its ledger rows", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;
  let d1: MockD1Database;

  function baseCtx(): SchedulesRouteContext {
    return {
      // Issue #6101 — the runs routes read the D1 ledger.
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
  }

  beforeEach(async () => {
    sql = new SqliteTestStorage();
    d1 = new MockD1Database();
    ctx = baseCtx();
    const store = new D1JobRunRecordStore(
      createD1JobRunRecordDb(d1 as unknown as D1Database),
    );
    await store.record(
      buildJobRunRecord({
        system: "worker-cron",
        jobId: RETENTION_DISPATCH_CRON,
        operation: "retention",
        started: "2026-11-19T04:00:00.000Z",
        finished: "2026-11-19T04:00:05.000Z",
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

  it("GET /schedules/retention/runs returns the retention ledger rows", async () => {
    const res = await call("/schedules/retention/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe(RETENTION_DISPATCH_CRON);
  });

  it("GET /schedules/runs?scheduleId=retention returns the same rows", async () => {
    const res = await call("/schedules/runs", "https://agent.internal/schedules/runs?scheduleId=retention");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe(RETENTION_DISPATCH_CRON);
  });
});

describe("4240 detail route answers the stored retention record", () => {
  it("GET /api/schedules/retention returns the stored detail, not 404", async () => {
    const sql = new SqliteTestStorage();
    const d1 = new MockD1Database();
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    await store.save(storedRetentionRecord("active"));
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
    const path = "/api/schedules/retention";
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
    expect(detail.id).toBe("retention");
    expect(detail.callback).toBe("retention");
  });
});

describe("4240 Schedules home renders the retention row (source pins)", () => {
  it("the panel names the retention row and shows its last pass", () => {
    const panel = source("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("Last pass");
    expect(panel).toContain('s.id === "retention"');
    expect(panel).toContain("lastRunDetail");
  });

  it("the client list item carries the retention fields", () => {
    const jobsApi = source("src/client/jobsApi.ts");
    expect(jobsApi).toContain("lastRunDetail");
  });

  it("no new firing: the retention fires through its stored schedule, not the heartbeat due-check", () => {
    // Issue #6503 — the heartbeat due-checks are retired: the duty
    // fires through its stored schedule's entry point, which lives
    // in consolidatedCronEntries (not the scheduled agent).
    const entries = source("src/services/consolidatedCronEntries.ts");
    expect(entries).toContain("runRetentionEntryPoint");
    // The slice adds no Worker cron and no SDK alarm for retention.
    // The old dispatch cron survives only as the ledger job id.
    const dueChecks = source("src/services/heartbeatDueChecks.ts");
    expect(dueChecks).toContain('RETENTION_DISPATCH_CRON = "0 4 * * *"');
  });
});
