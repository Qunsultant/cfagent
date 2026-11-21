/**
 * Issue #3121 #4240 — retention pass in the single schedule.
 *
 * The retention duty fires today through the heartbeat due-check
 * (#4234): runRetentionEntryPoint runs daily after 04:00 UTC and
 * records its own ledger row via recordDispatch, but there is no
 * unified-store record and no Schedules home row, so a missed pass
 * is invisible. This slice derives ONE stable record (id retention,
 * kind internal, state active) and appends it to the home list with
 * its last pass joined from the ledger, so the row reads
 * "Last pass: …" with the prune/export summary — or "never" when
 * the duty has never fired.
 *
 * Record-only in the same sense as #4239: no new kind, no new
 * alarm, no new firing mechanism. The record is derived, not
 * stored — there is no alarm to adopt and no steady-state alarm
 * exists (the Worker cron is OFF per #4112). Management ops refuse
 * with a coded error naming the derived record (pause / resume /
 * trigger / update / delete — #5891 retired the delete no-op). The manual trigger stays
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
} from "../src/data/unifiedSchedulePorts";
import {
  RETENTION_RECORD_ID,
  RETENTION_ORIGIN,
  retentionToRecord,
  retentionRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
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

describe("4240 derived retention record", () => {
  it("builds the one stable retention record (id retention, internal, active)", () => {
    const record = retentionToRecord(NOW);
    expect(record.id).toBe("retention");
    expect(RETENTION_RECORD_ID).toBe("retention");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("retention");
    expect(record.definition.cron).toBe(RETENTION_DISPATCH_CRON);
    expect(record.definition.cron).toBe("0 4 * * *");
    expect(record.definition.entryPoint).toBe("retention");
    expect(record.provenance.origin).toBe("system");
    expect(record.provenance.reason).toBe("retention");
    expect(RETENTION_ORIGIN).toBe("retention");
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("retention");
  });

  it("preserves createdAt across in-place updates (upsert, not recreate)", () => {
    const first = retentionToRecord("2026-11-18T06:00:00.000Z");
    const second = retentionToRecord(NOW, first);
    expect(second.createdAt).toBe("2026-11-18T06:00:00.000Z");
    expect(second.updatedAt).toBe(NOW);
    expect(second.id).toBe(first.id);
  });
});

describe("4240 retention list item (Schedules home row)", () => {
  it("carries the last pass joined from the ledger, detail verbatim", () => {
    const record = retentionToRecord(NOW);
    const item = retentionRecordToListItem(record, {
      started: "2026-11-19T04:00:00.000Z",
      finished: "2026-11-19T04:00:05.000Z",
      outcome: "success",
      detail: "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    });
    expect(item.id).toBe("retention");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("retention");
    expect(item.cron).toBe("0 4 * * *");
    expect(item.lastRunAt).toBe("2026-11-19T04:00:00.000Z");
    expect(item.lastRunOutcome).toBe("success");
    expect(item.lastRunDetail).toBe(
      "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    );
  });

  it("carries no last run when the duty has never fired", () => {
    const item = retentionRecordToListItem(retentionToRecord(NOW));
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

describe("4240 management refuses the derived record with coded errors", () => {
  const alarms: any = {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "retention" }),
  };

  it("pause / resume name the derived record instead of arming a foreign alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const paused = await pauseUnifiedSchedule({ store, alarms }, "retention", NOW);
    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.status).toBe(400);
      expect(paused.error).toContain("retention");
    }
    const resumed = await resumeUnifiedSchedule({ store, alarms }, "retention", NOW);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.status).toBe(400);
      expect(resumed.error).toContain("retention");
    }
  });

  it("trigger / update name the derived record (not the goal surface)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const triggered = await triggerUnifiedSchedule({ store, alarms }, "retention", async () => {});
    expect(triggered.ok).toBe(false);
    if (!triggered.ok) {
      expect(triggered.status).toBe(400);
      expect(triggered.error).toContain("retention");
      expect(triggered.error).not.toContain("Goal schedules");
    }
    const updated = await updateUnifiedSchedule({ store, alarms }, "retention", { cron: "0 5 * * *" }, Date.now());
    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.status).toBe(400);
      expect(updated.error).toContain("retention");
      expect(updated.error).not.toContain("Goal schedules");
    }
  });

  it("delete refuses the derived record with a named error (#5891)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const deleted = await deleteUnifiedSchedule({ store, alarms }, "retention");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(400);
      expect(deleted.error).toContain("retention");
      expect(deleted.error).toContain("derived record");
      expect(deleted.error).not.toContain("Goal schedules");
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

describe("4240 list route appends the retention row (best-effort)", () => {
  let sql: SqliteTestStorage;
  let ctx: SchedulesRouteContext;

  function baseCtx(overrides: Partial<SchedulesRouteContext> = {}): SchedulesRouteContext {
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
      ...overrides,
    } as unknown as SchedulesRouteContext;
  }

  function seedRetentionRun() {
    new SqlJobRunRecordStore(sql.sql as never).record(
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

  beforeEach(() => {
    sql = new SqliteTestStorage();
    ctx = baseCtx();
  });

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  it("appends the retention row with its last pass when the ledger has a run", async () => {
    seedRetentionRun();
    const body = await list();
    const row = body.schedules.find((s) => s.id === "retention");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("internal");
    expect(row?.callback).toBe("retention");
    expect(row?.cron).toBe("0 4 * * *");
    expect(row?.state).toBe("active");
    expect(row?.lastRunAt).toBe("2026-11-19T04:00:00.000Z");
    expect(row?.lastRunOutcome).toBe("success");
    expect(row?.lastRunDetail).toBe(
      "pruned=14 jobOutcomes=3 orphans=2/9 deleted=0 snapshot=ok tables=41 rows=1234",
    );
  });

  it("appends the row with no last run when the duty has never fired", async () => {
    const body = await list();
    const row = body.schedules.find((s) => s.id === "retention");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });

  it("omits the row (list still 200) when the ledger read throws", async () => {
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
    expect(body.schedules.find((s) => s.id === "retention")).toBeUndefined();
  });
});

describe("4240 runs routes join the retention record to its ledger rows", () => {
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

describe("4240 detail route answers the derived retention record", () => {
  it("GET /api/schedules/retention returns the derived detail, not 404", async () => {
    const sql = new SqliteTestStorage();
    const ctx = {
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

  it("no new firing: the retention still rides the heartbeat due-check", () => {
    const agent = source("src/agents/scheduled-agent.ts");
    expect(agent).toContain("runRetentionEntryPoint");
    // The slice adds no Worker cron and no SDK alarm for retention.
    const dueChecks = source("src/services/heartbeatDueChecks.ts");
    expect(dueChecks).toContain('RETENTION_DISPATCH_CRON = "0 4 * * *"');
  });
});
