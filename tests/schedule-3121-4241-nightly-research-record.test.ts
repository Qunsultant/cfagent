/**
 * Issue #3121 #4241 — nightly research run in the single schedule.
 *
 * The nightly research run IS the #354 daily options-research run:
 * POST /research/scheduled-tick, folded into the every-30-minute tick, firing
 * exactly once per weekday (Mon-Fri UTC) at/after 21:00 UTC (guard
 * shouldFireResearchTick + durable marker research_scheduled_last_run).
 * It runs, for the configured service identity: the #319 research run
 * (research + publish), due-run evaluations, discovery if due, and the
 * #1096 screening steps (strategy-bank re-selection proposals,
 * weights-v2, delivery). It already rides the tick today (tickRiders);
 * this slice derives ONE stable record (id nightly-research, kind
 * internal, state active) and appends it to the home list with its
 * last run joined from the ledger, so the row reads "Last research: …"
 * — or "never" when the duty has never fired. The fired run writes
 * one ledger row (jobId = record id) from the scheduled-tick handler
 * itself, so the runs routes join without a new store or a new firing
 * mechanism.
 *
 * State note: the Nov-12 definition comment recorded state `disabled`
 * — "firing waits on #4234". #4234 has since landed (55e3e1f): the
 * alarm tick dispatches the research POST on every tick and the
 * route's guard decides fire/no-fire, so the duty IS live through
 * the tick like #4239/#4240 — active, not disabled. No new kind: the
 * record uses `internal`, the #4238 seventh kind for internal-only
 * callbacks. Management ops refuse with a coded error naming the
 * derived record (pause / resume / trigger / update / delete —
 * #5891 retired the delete no-op). There is no manual trigger route for the research run — the
 * run fires on the tick; the manual research route is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  UNIFIED_SCHEDULE_KINDS,
} from "../src/data/unifiedSchedulePorts";
import {
  NIGHTLY_RESEARCH_RECORD_ID,
  NIGHTLY_RESEARCH_ORIGIN,
  nightlyResearchToRecord,
  nightlyResearchRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { scheduleIdToLedgerJobId } from "../src/services/jobRunRecords";
import { nightlyResearchDispatchCron } from "../src/services/researchScheduleGuard";
import { DEFAULT_RESEARCH_JOB_CONFIG } from "../src/config/researchJobConfig";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { scheduleTitle } from "../src/client/scheduledOptionsManager/scheduleDetail";
import { recordNightlyResearchLedgerRun } from "../src/agents/routes/screenerResearch";
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

const NOW = "2026-11-19T07:00:00.000Z";
const RUN_STARTED = "2026-11-19T21:00:00.000Z";
const RUN_FINISHED = "2026-11-19T21:05:00.000Z";

describe("4241 derived nightly research record", () => {
  it("builds the one stable nightly research record (id nightly-research, internal, active)", () => {
    const record = nightlyResearchToRecord(NOW);
    expect(record.id).toBe("nightly-research");
    expect(NIGHTLY_RESEARCH_RECORD_ID).toBe("nightly-research");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("nightly-research");
    expect(record.definition.cron).toBe(nightlyResearchDispatchCron());
    expect(record.definition.cron).toBe("0 21 * * 1-5");
    expect(record.definition.entryPoint).toBe("nightly-research");
    expect(record.provenance.origin).toBe("system");
    expect(record.provenance.reason).toBe("nightly-research");
    expect(NIGHTLY_RESEARCH_ORIGIN).toBe("nightly-research");
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
  });

  it("reads the cadence from the one resolved config, never re-literalized (#6030)", () => {
    expect(DEFAULT_RESEARCH_JOB_CONFIG.scheduleUtcHour).toBe(21);
    expect(nightlyResearchDispatchCron()).toBe("0 21 * * 1-5");
    // The env moves the record's cron with the guard's fire hour.
    expect(nightlyResearchDispatchCron({ scheduleUtcHour: 22 })).toBe("0 22 * * 1-5");
    expect(nightlyResearchToRecord(NOW, null, { scheduleUtcHour: 22 }).definition.cron).toBe(
      "0 22 * * 1-5"
    );
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("nightly-research");
  });

  it("preserves createdAt across in-place updates (upsert, not recreate)", () => {
    const first = nightlyResearchToRecord("2026-11-18T07:00:00.000Z");
    const second = nightlyResearchToRecord(NOW, first);
    expect(second.createdAt).toBe("2026-11-18T07:00:00.000Z");
    expect(second.updatedAt).toBe(NOW);
    expect(second.id).toBe(first.id);
  });
});

describe("4241 nightly research list item (Schedules home row)", () => {
  it("carries the last run joined from the ledger", () => {
    const record = nightlyResearchToRecord(NOW);
    const item = nightlyResearchRecordToListItem(record, {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
    });
    expect(item.id).toBe("nightly-research");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("nightly-research");
    expect(item.cron).toBe("0 21 * * 1-5");
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunOutcome).toBe("success");
  });

  it("carries no last run when the duty has never fired", () => {
    const item = nightlyResearchRecordToListItem(nightlyResearchToRecord(NOW));
    expect(item.lastRunAt).toBeUndefined();
    expect(item.lastRunOutcome).toBeUndefined();
  });
});

describe("4241 home naming + classifier + ledger join", () => {
  it("names the nightly-research callback 'Scheduled nightly research run'", () => {
    expect(scheduleTitle({ callback: "nightly-research" } as never)).toBe(
      "Scheduled nightly research run",
    );
  });

  it("classifies the nightly-research callback as system upkeep", () => {
    expect(classifyScheduleKind({ callback: "nightly-research" })).toBe("system");
  });

  it("resolves the nightly-research record id to its ledger job id (itself)", () => {
    expect(scheduleIdToLedgerJobId("nightly-research")).toBe("nightly-research");
    expect(scheduleIdToLedgerJobId("other-schedule")).toBe("other-schedule");
  });
});

describe("4241 management refuses the derived record with coded errors", () => {
  const alarms: any = {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "nightly-research" }),
  };

  it("pause / resume name the derived record instead of arming a foreign alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const paused = await pauseUnifiedSchedule({ store, alarms }, "nightly-research", NOW);
    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.status).toBe(400);
      expect(paused.error).toContain("nightly-research");
    }
    const resumed = await resumeUnifiedSchedule({ store, alarms }, "nightly-research", NOW);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.status).toBe(400);
      expect(resumed.error).toContain("nightly-research");
    }
  });

  it("trigger / update name the derived record (not the goal surface)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const triggered = await triggerUnifiedSchedule({ store, alarms }, "nightly-research", async () => {});
    expect(triggered.ok).toBe(false);
    if (!triggered.ok) {
      expect(triggered.status).toBe(400);
      expect(triggered.error).toContain("nightly-research");
      expect(triggered.error).not.toContain("Goal schedules");
    }
    const updated = await updateUnifiedSchedule({ store, alarms }, "nightly-research", { cron: "0 22 * * 1-5" }, Date.now());
    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.status).toBe(400);
      expect(updated.error).toContain("nightly-research");
      expect(updated.error).not.toContain("Goal schedules");
    }
  });

  it("delete refuses the derived record with a named error (#5891)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const deleted = await deleteUnifiedSchedule({ store, alarms }, "nightly-research");
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(400);
      expect(deleted.error).toContain("nightly-research");
      expect(deleted.error).toContain("derived record");
      expect(deleted.error).not.toContain("Goal schedules");
    }
  });
});

describe("4241 fired run writes one ledger row (jobId = record id)", () => {
  it("records the run with the record id as jobId and scheduleId", () => {
    const sql = new SqliteTestStorage();
    recordNightlyResearchLedgerRun(sql.sql as never, RUN_STARTED, RUN_FINISHED);
    const latest = new SqlJobRunRecordStore(sql.sql as never).latestByJob(
      NIGHTLY_RESEARCH_RECORD_ID,
    );
    expect(latest).not.toBeNull();
    expect(latest?.jobId).toBe("nightly-research");
    expect(latest?.scheduleId).toBe("nightly-research");
    expect(latest?.operation).toBe("nightly-research");
    expect(latest?.system).toBe("orchestrator-schedule");
    expect(latest?.outcome).toBe("success");
    expect(latest?.triggeredBy).toBe("scheduled");
    expect(latest?.started).toBe(RUN_STARTED);
    expect(latest?.finished).toBe(RUN_FINISHED);
  });

  it("is a no-op without a store and never throws on a broken store", () => {
    expect(() =>
      recordNightlyResearchLedgerRun(null, RUN_STARTED, RUN_FINISHED),
    ).not.toThrow();
    expect(() =>
      recordNightlyResearchLedgerRun(undefined, RUN_STARTED, RUN_FINISHED),
    ).not.toThrow();
    const broken = {
      exec: () => {
        throw new Error("sql down");
      },
    };
    expect(() =>
      recordNightlyResearchLedgerRun(broken as never, RUN_STARTED, RUN_FINISHED),
    ).not.toThrow();
  });
});

describe("4241 list route appends the nightly research row (best-effort)", () => {
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

  function seedNightlyResearchRun() {
    recordNightlyResearchLedgerRun(sql.sql as never, RUN_STARTED, RUN_FINISHED);
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

  it("appends the nightly research row with its last run when the ledger has a run", async () => {
    seedNightlyResearchRun();
    const body = await list();
    const row = body.schedules.find((s) => s.id === "nightly-research");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("internal");
    expect(row?.callback).toBe("nightly-research");
    expect(row?.cron).toBe("0 21 * * 1-5");
    expect(row?.state).toBe("active");
    expect(row?.lastRunAt).toBe(RUN_STARTED);
    expect(row?.lastRunOutcome).toBe("success");
  });

  it("appends the row with no last run when the duty has never fired", async () => {
    const body = await list();
    const row = body.schedules.find((s) => s.id === "nightly-research");
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
    expect(body.schedules.find((s) => s.id === "nightly-research")).toBeUndefined();
  });
});

describe("4241 runs routes join the nightly research record to its ledger rows", () => {
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
    recordNightlyResearchLedgerRun(sql.sql as never, RUN_STARTED, RUN_FINISHED);
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

  it("GET /schedules/nightly-research/runs returns the nightly research ledger rows", async () => {
    const res = await call("/schedules/nightly-research/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("nightly-research");
  });

  it("GET /schedules/runs?scheduleId=nightly-research returns the same rows", async () => {
    const res = await call("/schedules/runs", "https://agent.internal/schedules/runs?scheduleId=nightly-research");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("nightly-research");
  });
});

describe("4241 detail route answers the derived nightly research record", () => {
  it("GET /api/schedules/nightly-research returns the derived detail, not 404", async () => {
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
    const path = "/api/schedules/nightly-research";
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
    expect(detail.id).toBe("nightly-research");
    expect(detail.callback).toBe("nightly-research");
  });
});

describe("4241 Schedules home renders the nightly research row (source pins)", () => {
  it("the panel names the nightly research row and shows its last run", () => {
    const panel = source("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("Last research");
    expect(panel).toContain('s.id === "nightly-research"');
  });

  it("no new firing: the research run rides the stored schedule, not a tick rider (#6299)", () => {
    const riders = source("src/services/tickRiders.ts");
    // Issue #6299 — the rider is RETIRED. Before it, this pin asserted the
    // tick DID dispatch the research route; now the absence is the guarantee:
    // one scheduler (the stored schedule record), no second firing mechanism.
    // The URL still appears in the retirement comment, so the guarantee is
    // pinned on the CALL: no dispatch to the research route from this tick.
    expect(riders).not.toContain('new Request("https://agent.internal/research/scheduled-tick"');
    // The slice adds no Worker cron and no SDK alarm for the research run.
    const guard = source("src/services/researchScheduleGuard.ts");
    // #6030 — one declaration: the cron is derived from the config hour,
    // and no second fire-hour literal exists in the guard.
    expect(guard).toContain("export function nightlyResearchDispatchCron(");
    expect(guard).toContain("config.scheduleUtcHour");
    expect(guard).not.toContain("RESEARCH_SCHEDULED_FIRE_HOUR_UTC");
    expect(guard).not.toContain("NIGHTLY_RESEARCH_DISPATCH_CRON =");
    // The fired run is recorded in the ledger from the scheduled-tick
    // handler, after the durable marker write.
    const route = source("src/agents/routes/screenerResearch.ts");
    expect(route).toContain("recordNightlyResearchLedgerRun");
  });
});
