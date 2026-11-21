/**
 * Issue #3121 #4239 — broker token renewal in the single schedule.
 *
 * The renewal duty fires today through the heartbeat due-check
 * (#4234): runRenewTokensEntryPoint runs daily after 03:00 UTC and
 * records its own ledger row via recordDispatch, but there is no
 * unified-store record and no Schedules home row, so a missed
 * renewal is invisible. This slice derives ONE stable record
 * (id token-renewal, kind internal, state active) and appends it
 * to the home list with its last renewal joined from the ledger,
 * so the row reads "Last renewal: …" — or "never" when the duty
 * has never fired.
 *
 * Record-only in the same sense as #4237: no new kind, no new
 * alarm, no new firing mechanism. The record is derived, not
 * stored — there is no alarm to adopt and no steady-state alarm
 * exists (legacy alarms are removed by migrateLegacyScreenSchedules).
 * Management ops refuse with a coded error naming the derived
 * record (pause / resume / trigger / update / delete — #5891
 * retired the delete no-op).
 * The manual trigger stays on its existing route
 * POST /api/schedules/trigger-renew.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  UNIFIED_SCHEDULE_KINDS,
} from "../src/data/unifiedSchedulePorts";
import {
  TOKEN_RENEWAL_RECORD_ID,
  TOKEN_RENEWAL_ORIGIN,
  tokenRenewalToRecord,
  tokenRenewalRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
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

describe("4239 derived token-renewal record", () => {
  it("builds the one stable renewal record (id token-renewal, internal, active)", () => {
    const record = tokenRenewalToRecord(NOW);
    expect(record.id).toBe("token-renewal");
    expect(TOKEN_RENEWAL_RECORD_ID).toBe("token-renewal");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("autoRenewETradeTokens");
    expect(record.definition.cron).toBe(RENEWAL_DISPATCH_CRON);
    expect(record.definition.cron).toBe("0 3 * * *");
    expect(record.definition.entryPoint).toBe("renewTokens");
    expect(record.provenance.origin).toBe("system");
    expect(record.provenance.reason).toBe("token-renewal");
    expect(TOKEN_RENEWAL_ORIGIN).toBe("token-renewal");
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("token-renewal");
  });

  it("preserves createdAt across in-place updates (upsert, not recreate)", () => {
    const first = tokenRenewalToRecord("2026-11-17T23:00:00.000Z");
    const second = tokenRenewalToRecord(NOW, first);
    expect(second.createdAt).toBe("2026-11-17T23:00:00.000Z");
    expect(second.updatedAt).toBe(NOW);
    expect(second.id).toBe(first.id);
  });
});

describe("4239 renewal list item (Schedules home row)", () => {
  it("carries the last renewal joined from the ledger", () => {
    const record = tokenRenewalToRecord(NOW);
    const item = tokenRenewalRecordToListItem(record, {
      started: "2026-11-18T03:00:00.000Z",
      finished: "2026-11-18T03:00:05.000Z",
      outcome: "success",
    });
    expect(item.id).toBe("token-renewal");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("autoRenewETradeTokens");
    expect(item.cron).toBe("0 3 * * *");
    expect(item.lastRunAt).toBe("2026-11-18T03:00:00.000Z");
    expect(item.lastRunOutcome).toBe("success");
  });

  it("carries no last run when the duty has never fired", () => {
    const item = tokenRenewalRecordToListItem(tokenRenewalToRecord(NOW));
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

describe("4239 management refuses the derived record with coded errors", () => {
  const alarms: any = {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "autoRenewETradeTokens" }),
  };

  it("pause / resume name the derived record instead of arming a foreign alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const paused = await pauseUnifiedSchedule({ store, alarms }, "token-renewal", NOW);
    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.status).toBe(400);
      expect(paused.error).toContain("token-renewal");
    }
    const resumed = await resumeUnifiedSchedule({ store, alarms }, "token-renewal", NOW);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.status).toBe(400);
      expect(resumed.error).toContain("token-renewal");
    }
  });

  it("trigger / update name the derived record (not the goal surface)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const triggered = await triggerUnifiedSchedule({ store, alarms }, "token-renewal", async () => {});
    expect(triggered.ok).toBe(false);
    if (!triggered.ok) {
      expect(triggered.status).toBe(400);
      expect(triggered.error).toContain("token-renewal");
      expect(triggered.error).not.toContain("Goal schedules");
    }
    const updated = await updateUnifiedSchedule({ store, alarms }, "token-renewal", { cron: "0 4 * * *" }, Date.now());
    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.status).toBe(400);
      expect(updated.error).toContain("token-renewal");
      expect(updated.error).not.toContain("Goal schedules");
    }
  });

  it("delete refuses the derived record with a named error (#5891)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const deleted = await deleteUnifiedSchedule({ store, alarms }, "token-renewal");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(400);
      expect(deleted.error).toContain("token-renewal");
      expect(deleted.error).toContain("derived record");
      expect(deleted.error).not.toContain("Goal schedules");
    }
  });
});

describe("4239 list route appends the renewal row (best-effort)", () => {
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

  it("appends the renewal row with its last renewal when the ledger has a run", async () => {
    seedRenewalRun();
    const body = await list();
    const row = body.schedules.find((s) => s.id === "token-renewal");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("internal");
    expect(row?.callback).toBe("autoRenewETradeTokens");
    expect(row?.cron).toBe("0 3 * * *");
    expect(row?.state).toBe("active");
    expect(row?.lastRunAt).toBe("2026-11-18T03:00:00.000Z");
    expect(row?.lastRunOutcome).toBe("success");
  });

  it("appends the row with no last run when the duty has never fired", async () => {
    const body = await list();
    const row = body.schedules.find((s) => s.id === "token-renewal");
    expect(row).toBeDefined();
    expect(row?.lastRunAt).toBeUndefined();
  });

  it("omits the row (list still 200) when the ledger read throws", async () => {
    // The ledger read fails but the unified-store list still works:
    // only job_run_records queries throw.
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
    expect(body.schedules.find((s) => s.id === "token-renewal")).toBeUndefined();
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

describe("4239 detail route answers the derived renewal record", () => {
  it("GET /api/schedules/token-renewal returns the derived detail, not 404", async () => {
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

  it("no new firing: the renewal still rides the heartbeat due-check", () => {
    const agent = source("src/agents/scheduled-agent.ts");
    expect(agent).toContain("runRenewTokensEntryPoint");
    // The slice adds no Worker cron and no SDK alarm for renewal.
    const dueChecks = source("src/services/heartbeatDueChecks.ts");
    expect(dueChecks).toContain('RENEWAL_DISPATCH_CRON = "0 3 * * *"');
  });
});
