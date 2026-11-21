/**
 * Issue #3121 #4242 — sweeps and watchdog in the single schedule.
 *
 * The internal maintenance sweeps (sweepStaleLedgerTasks,
 * sweepStaleAsyncJobs) and the schedule watchdog
 * (watchdogMissedSchedules) are code-armed SDK alarms
 * (OrchestratorAgent.onStart + scheduleEvery). Before this slice
 * they had no unified-store records and no home visibility, and —
 * verified first, per the resume note — only the watchdog wrote a
 * ledger row for its runs (its per-sweep heartbeat,
 * jobId schedule-watchdog-heartbeat); the two sweeps wrote none
 * (audit events + logs only). This slice derives ONE stable record
 * per duty (id = the ledger job id, kind internal, state active)
 * and appends all three to the home list with their last run joined
 * from the ledger, so a sweep that finds stale work — or a
 * watchdog that finds missed schedules — shows its counts.
 *
 * Recording reuses the #3394 wrapper (recordScheduleCallbackRun,
 * the ONE recorder — no second recorder): the two sweep methods
 * wrap their bodies, mapping the sweep-result object to a
 * ScheduledCallbackOutcome (counts in `detail`); the watchdog
 * method is NOT wrapped — its heartbeat row already IS its run
 * row, and wrapping it would double-record every sweep. The
 * wrapper is called with the normalized schedule { id: RECORD_ID }
 * (never the SDK alarm id): the derived record is the ledger
 * identity, and the alarm id is a substrate id that changes on
 * re-arm. The watchdog keeps skipping the three by name
 * (RECORDED_SCHEDULE_CALLBACKS unchanged): its lookup is by alarm
 * id, and these rows are keyed by record id — it still cannot
 * observe them by schedule.id, so watching them would cry wolf.
 * Management ops refuse with a coded error naming the derived
 * record (pause / resume / trigger / update / delete — #5891
 * retired the delete no-op).
 * Sweep behavior is unchanged; no new firing is added.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { UNIFIED_SCHEDULE_KINDS } from "../src/data/unifiedSchedulePorts";
import {
  STALE_LEDGER_SWEEP_RECORD_ID,
  STALE_LEDGER_SWEEP_DISPATCH_CRON,
  STALE_ASYNC_JOB_SWEEP_RECORD_ID,
  STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON,
  SCHEDULE_WATCHDOG_RECORD_ID,
  SCHEDULE_WATCHDOG_DISPATCH_CRON,
  staleLedgerSweepOutcome,
  staleAsyncJobSweepOutcome,
} from "../src/services/sweepWatchdogSchedule";
import { SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID } from "../src/services/scheduleWatchdog";
import {
  STALE_LEDGER_SWEEP_ORIGIN,
  STALE_ASYNC_JOB_SWEEP_ORIGIN,
  SCHEDULE_WATCHDOG_ORIGIN,
  staleLedgerSweepToRecord,
  staleAsyncJobSweepToRecord,
  scheduleWatchdogToRecord,
  staleLedgerSweepRecordToListItem,
  staleAsyncJobSweepRecordToListItem,
  scheduleWatchdogRecordToListItem,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  deleteUnifiedSchedule,
  triggerUnifiedSchedule,
  updateUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { scheduleIdToLedgerJobId } from "../src/services/jobRunRecords";
import { recordLedgerRun } from "../src/services/unifiedLedger";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { scheduleTitle } from "../src/client/scheduledOptionsManager/scheduleDetail";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import {
  watchdogMissedSchedules,
  type ScheduleWatchdogContext,
} from "../src/agents/orchestrator/scheduleWatchdog";
import { RECORDED_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator/scheduleCallbacks";
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
const RUN_STARTED = "2026-11-19T06:00:00.000Z";
const RUN_FINISHED = "2026-11-19T06:00:05.000Z";

const DERIVED_IDS = [
  "sweep-stale-ledger-tasks",
  "sweep-stale-async-jobs",
  "schedule-watchdog",
] as const;

function seedRun(sql: SqliteTestStorage, jobId: string, detail: string): void {
  recordLedgerRun(new SqlJobRunRecordStore(sql.sql as never), {
    system: "orchestrator-schedule",
    jobId,
    operation: jobId,
    started: RUN_STARTED,
    finished: RUN_FINISHED,
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: jobId,
    asyncJobId: null,
    workflowId: null,
    detail,
  });
}

describe("4242 derived sweep + watchdog records", () => {
  it("builds the one stable stale-ledger-sweep record (internal, active)", () => {
    const record = staleLedgerSweepToRecord(NOW);
    expect(record.id).toBe("sweep-stale-ledger-tasks");
    expect(STALE_LEDGER_SWEEP_RECORD_ID).toBe("sweep-stale-ledger-tasks");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("sweepStaleLedgerTasks");
    expect(record.definition.cron).toBe(STALE_LEDGER_SWEEP_DISPATCH_CRON);
    expect(record.definition.cron).toBe("0 */6 * * *");
    expect(record.definition.entryPoint).toBe("sweep-stale-ledger-tasks");
    expect(record.provenance.origin).toBe("system");
    expect(record.provenance.reason).toBe("sweep-stale-ledger-tasks");
    expect(STALE_LEDGER_SWEEP_ORIGIN).toBe("sweep-stale-ledger-tasks");
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
  });

  it("builds the one stable stale-async-job-sweep record (internal, active)", () => {
    const record = staleAsyncJobSweepToRecord(NOW);
    expect(record.id).toBe("sweep-stale-async-jobs");
    expect(STALE_ASYNC_JOB_SWEEP_RECORD_ID).toBe("sweep-stale-async-jobs");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("sweepStaleAsyncJobs");
    expect(record.definition.cron).toBe(STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON);
    expect(record.definition.cron).toBe("*/15 * * * *");
    expect(record.definition.entryPoint).toBe("sweep-stale-async-jobs");
    expect(record.provenance.origin).toBe("system");
    expect(record.provenance.reason).toBe("sweep-stale-async-jobs");
    expect(STALE_ASYNC_JOB_SWEEP_ORIGIN).toBe("sweep-stale-async-jobs");
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
  });

  it("builds the one stable schedule-watchdog record (internal, active)", () => {
    const record = scheduleWatchdogToRecord(NOW);
    expect(record.id).toBe("schedule-watchdog");
    expect(SCHEDULE_WATCHDOG_RECORD_ID).toBe("schedule-watchdog");
    expect(record.kind).toBe("internal");
    expect(record.state).toBe("active");
    expect(record.callback).toBe("watchdogMissedSchedules");
    expect(record.definition.cron).toBe(SCHEDULE_WATCHDOG_DISPATCH_CRON);
    expect(record.definition.cron).toBe("*/15 * * * *");
    expect(record.definition.entryPoint).toBe("schedule-watchdog");
    expect(record.provenance.origin).toBe("system");
    expect(record.provenance.reason).toBe("schedule-watchdog");
    expect(SCHEDULE_WATCHDOG_ORIGIN).toBe("schedule-watchdog");
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
  });

  it("reads each cadence from the firing interval, never re-literalized", () => {
    const orchestrator = source("src/agents/orchestrator.ts");
    expect(orchestrator).toContain("STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60");
    expect(orchestrator).toContain("STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS = 15 * 60");
    expect(orchestrator).toContain(
      "SCHEDULE_WATCHDOG_INTERVAL_SECONDS = STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS",
    );
    expect(STALE_LEDGER_SWEEP_DISPATCH_CRON).toBe("0 */6 * * *");
    expect(STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON).toBe("*/15 * * * *");
    expect(SCHEDULE_WATCHDOG_DISPATCH_CRON).toBe("*/15 * * * *");
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("sweep-stale-ledger-tasks");
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("schedule-watchdog");
  });

  it("preserves createdAt across in-place updates (upsert, not recreate)", () => {
    const first = staleLedgerSweepToRecord("2026-11-18T07:00:00.000Z");
    const second = staleLedgerSweepToRecord(NOW, first);
    expect(second.createdAt).toBe("2026-11-18T07:00:00.000Z");
    expect(second.updatedAt).toBe(NOW);
    expect(second.id).toBe(first.id);
    const wFirst = scheduleWatchdogToRecord("2026-11-18T07:00:00.000Z");
    const wSecond = scheduleWatchdogToRecord(NOW, wFirst);
    expect(wSecond.createdAt).toBe("2026-11-18T07:00:00.000Z");
    expect(wSecond.id).toBe(wFirst.id);
  });
});

describe("4242 sweep outcome mapping (the #3394 wrapper's delegate truth)", () => {
  it("maps a stale-ledger-sweep result to success with swept/pruned counts in detail", () => {
    const outcome = staleLedgerSweepOutcome({
      userLogin: "owner",
      researchSwept: 2,
      screenerSwept: 1,
      researchPruned: 3,
      screenerPruned: 0,
    });
    expect(outcome.outcome).toBe("success");
    expect(outcome.descriptor).toBe("stale ledger sweep complete");
    expect(outcome.detail).toBe("research swept=2 pruned=3; screener swept=1 pruned=0");
  });

  it("maps a no-owner stale-ledger sweep to skipped, never a zero success", () => {
    const outcome = staleLedgerSweepOutcome({
      userLogin: null,
      researchSwept: 0,
      screenerSwept: 0,
      researchPruned: 0,
      screenerPruned: 0,
    });
    expect(outcome.outcome).toBe("skipped");
    expect(outcome.detail).toBe("no authenticated account owner");
  });

  it("maps a stale-async-job-sweep result to success with examined/alerted/reaped counts", () => {
    const outcome = staleAsyncJobSweepOutcome({ examined: 10, alerted: 1, reaped: 2 });
    expect(outcome.outcome).toBe("success");
    expect(outcome.descriptor).toBe("stale async-job sweep complete");
    expect(outcome.detail).toBe("examined=10 alerted=1 reaped=2");
  });

  it("maps an empty stale-async-job sweep to a zero-count success (the run ran)", () => {
    const outcome = staleAsyncJobSweepOutcome({ examined: 0, alerted: 0, reaped: 0 });
    expect(outcome.outcome).toBe("success");
    expect(outcome.detail).toBe("examined=0 alerted=0 reaped=0");
  });
});

describe("4242 sweep + watchdog list items (Schedules home rows)", () => {
  it("carries the last run joined from the ledger, counts in detail", () => {
    const item = staleLedgerSweepRecordToListItem(staleLedgerSweepToRecord(NOW), {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
      detail: "research swept=2 pruned=3; screener swept=1 pruned=0",
    });
    expect(item.id).toBe("sweep-stale-ledger-tasks");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("sweepStaleLedgerTasks");
    expect(item.cron).toBe("0 */6 * * *");
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunOutcome).toBe("success");
    expect(item.lastRunDetail).toBe("research swept=2 pruned=3; screener swept=1 pruned=0");
  });

  it("carries the async-job sweep's last run with its counts", () => {
    const item = staleAsyncJobSweepRecordToListItem(staleAsyncJobSweepToRecord(NOW), {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
      detail: "examined=10 alerted=1 reaped=2",
    });
    expect(item.id).toBe("sweep-stale-async-jobs");
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunDetail).toBe("examined=10 alerted=1 reaped=2");
  });

  it("carries the watchdog's last heartbeat with its counts", () => {
    const item = scheduleWatchdogRecordToListItem(scheduleWatchdogToRecord(NOW), {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
      detail: "examined=0 missed=0 skippedUnrecorded=3",
    });
    expect(item.id).toBe("schedule-watchdog");
    expect(item.callback).toBe("watchdogMissedSchedules");
    expect(item.cron).toBe("*/15 * * * *");
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunDetail).toBe("examined=0 missed=0 skippedUnrecorded=3");
  });

  it("carries no last run when a duty has never fired", () => {
    expect(
      staleLedgerSweepRecordToListItem(staleLedgerSweepToRecord(NOW)).lastRunAt,
    ).toBeUndefined();
    expect(
      staleAsyncJobSweepRecordToListItem(staleAsyncJobSweepToRecord(NOW)).lastRunAt,
    ).toBeUndefined();
    expect(
      scheduleWatchdogRecordToListItem(scheduleWatchdogToRecord(NOW)).lastRunAt,
    ).toBeUndefined();
  });
});

describe("4242 home naming + classifier + ledger join", () => {
  it("names the three callbacks for the home", () => {
    expect(scheduleTitle({ callback: "sweepStaleLedgerTasks" } as never)).toBe(
      "Scheduled stale-task sweep",
    );
    expect(scheduleTitle({ callback: "sweepStaleAsyncJobs" } as never)).toBe(
      "Scheduled stale async-job sweep",
    );
    expect(scheduleTitle({ callback: "watchdogMissedSchedules" } as never)).toBe(
      "Scheduled missed-schedule watchdog",
    );
  });

  it("classifies all three callbacks as system upkeep", () => {
    expect(classifyScheduleKind({ callback: "sweepStaleLedgerTasks" })).toBe("system");
    expect(classifyScheduleKind({ callback: "sweepStaleAsyncJobs" })).toBe("system");
    expect(classifyScheduleKind({ callback: "watchdogMissedSchedules" })).toBe("system");
  });

  it("resolves each record id to its ledger job id", () => {
    expect(scheduleIdToLedgerJobId("sweep-stale-ledger-tasks")).toBe(
      "sweep-stale-ledger-tasks",
    );
    expect(scheduleIdToLedgerJobId("sweep-stale-async-jobs")).toBe(
      "sweep-stale-async-jobs",
    );
    // The watchdog's rows predate the record: the heartbeat job id.
    expect(SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID).toBe("schedule-watchdog-heartbeat");
    expect(scheduleIdToLedgerJobId("schedule-watchdog")).toBe(
      "schedule-watchdog-heartbeat",
    );
    expect(scheduleIdToLedgerJobId("other-schedule")).toBe("other-schedule");
  });
});

describe("4242 management refuses the derived records with coded errors", () => {
  const alarms: any = {
    list: async () => [],
    get: async () => undefined,
    cancel: async () => true,
    arm: async () => ({ id: "new-1", callback: "sweepStaleLedgerTasks" }),
  };

  it.each(DERIVED_IDS)("pause / resume name the derived record %s", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    const paused = await pauseUnifiedSchedule({ store, alarms }, id, NOW);
    expect(paused.ok).toBe(false);
    if (!paused.ok) {
      expect(paused.status).toBe(400);
      expect(paused.error).toContain(id);
    }
    const resumed = await resumeUnifiedSchedule({ store, alarms }, id, NOW);
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) {
      expect(resumed.status).toBe(400);
      expect(resumed.error).toContain(id);
    }
  });

  it.each(DERIVED_IDS)("trigger / update name the derived record %s", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    const triggered = await triggerUnifiedSchedule({ store, alarms }, id, async () => {});
    expect(triggered.ok).toBe(false);
    if (!triggered.ok) {
      expect(triggered.status).toBe(400);
      expect(triggered.error).toContain(id);
      expect(triggered.error).not.toContain("Goal schedules");
    }
    const updated = await updateUnifiedSchedule(
      { store, alarms },
      id,
      { cron: "0 5 * * *" },
      Date.now(),
    );
    expect(updated.ok).toBe(false);
    if (!updated.ok) {
      expect(updated.status).toBe(400);
      expect(updated.error).toContain(id);
      expect(updated.error).not.toContain("Goal schedules");
    }
  });

  it.each(DERIVED_IDS)("delete refuses the derived record %s with a named error (#5891)", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    const deleted = await deleteUnifiedSchedule({ store, alarms }, id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.status).toBe(400);
      expect(deleted.error).toContain(id);
      expect(deleted.error).toContain("derived record");
      expect(deleted.error).not.toContain("Goal schedules");
    }
  });
});

describe("4242 the #3394 wrapper records a sweep run under the record id", () => {
  it("records one row per sweep run: jobId + scheduleId are the record id, counts in detail", async () => {
    const sql = new SqliteTestStorage();
    const result = {
      userLogin: "owner",
      researchSwept: 2,
      screenerSwept: 1,
      researchPruned: 3,
      screenerPruned: 0,
    };
    await recordScheduleCallbackRun(
      sql.sql as never,
      "sweepStaleLedgerTasks",
      {},
      { id: STALE_LEDGER_SWEEP_RECORD_ID },
      async () => staleLedgerSweepOutcome(result),
      { audit: () => {} },
    );
    const rows = new SqlJobRunRecordStore(sql.sql as never).listByJob(
      STALE_LEDGER_SWEEP_RECORD_ID,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe("sweep-stale-ledger-tasks");
    expect(rows[0]?.scheduleId).toBe("sweep-stale-ledger-tasks");
    expect(rows[0]?.operation).toBe("sweepStaleLedgerTasks");
    expect(rows[0]?.system).toBe("orchestrator-schedule");
    expect(rows[0]?.outcome).toBe("success");
    expect(rows[0]?.triggeredBy).toBe("scheduled");
    expect(rows[0]?.detail).toBe("research swept=2 pruned=3; screener swept=1 pruned=0");
    expect(rows[0]?.descriptor).toBe("stale ledger sweep complete");
  });

  it("records the async-job sweep run the same way", async () => {
    const sql = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      sql.sql as never,
      "sweepStaleAsyncJobs",
      {},
      { id: STALE_ASYNC_JOB_SWEEP_RECORD_ID },
      async () => staleAsyncJobSweepOutcome({ examined: 10, alerted: 1, reaped: 2 }),
      { audit: () => {} },
    );
    const rows = new SqlJobRunRecordStore(sql.sql as never).listByJob(
      STALE_ASYNC_JOB_SWEEP_RECORD_ID,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe("examined=10 alerted=1 reaped=2");
  });
});

describe("4242 the watchdog heartbeat IS its run row (no second recorder)", () => {
  it("writes exactly one heartbeat row per sweep with examined/missed/skipped counts", async () => {
    const sql = new SqliteTestStorage();
    const ctx: ScheduleWatchdogContext = {
      env: {},
      sql: sql.sql as never,
      storage: {
        get: async () => undefined,
        put: async () => {},
      },
      listSchedules: async () => [],
      audit: () => {},
    };
    const result = await watchdogMissedSchedules(ctx, {
      recordedCallbacks: RECORDED_SCHEDULE_CALLBACKS,
    });
    expect(result).toEqual({ examined: 0, alerted: 0, missed: 0, skippedUnrecorded: 0 });
    const rows = new SqlJobRunRecordStore(sql.sql as never).listByJob(
      SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobId).toBe("schedule-watchdog-heartbeat");
    expect(rows[0]?.operation).toBe("schedule.watchdog_sweep");
    expect(rows[0]?.outcome).toBe("success");
    expect(rows[0]?.detail).toBe("examined=0 missed=0 skippedUnrecorded=0");
  });

  it("the watchdog still skips the three framework sweeps by name", () => {
    // Their rows are keyed by record id, not alarm id, so the
    // watchdog's alarm-id lookup cannot observe them — watching
    // them would cry wolf. RECORDED_SCHEDULE_CALLBACKS is unchanged.
    expect(RECORDED_SCHEDULE_CALLBACKS).not.toContain("sweepStaleLedgerTasks");
    expect(RECORDED_SCHEDULE_CALLBACKS).not.toContain("sweepStaleAsyncJobs");
    expect(RECORDED_SCHEDULE_CALLBACKS).not.toContain("watchdogMissedSchedules");
  });
});

describe("4242 orchestrator methods record through the #3394 wrapper (source pins)", () => {
  function region(from: string, to = "\n  async "): string {
    const text = source("src/agents/orchestrator.ts");
    const start = text.indexOf(from);
    expect(start, `expected to find: ${from}`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(to, start + from.length);
    return text.slice(start, end === -1 ? undefined : end);
  }

  it("sweepStaleLedgerTasks wraps its body in recordScheduleCallbackRun under the record id", () => {
    const cb = region("async sweepStaleLedgerTasks(");
    expect(cb).toContain("recordScheduleCallbackRun(");
    expect(cb).toContain("STALE_LEDGER_SWEEP_RECORD_ID");
    expect(cb).toContain("staleLedgerSweepOutcome(");
    // The wrapper's schedule is the normalized record id, never the
    // SDK alarm id (a substrate id that changes on re-arm).
    expect(cb).toContain("{ id: STALE_LEDGER_SWEEP_RECORD_ID }");
  });

  it("sweepStaleAsyncJobs wraps its delegation the same way", () => {
    const cb = region("async sweepStaleAsyncJobs(");
    expect(cb).toContain("recordScheduleCallbackRun(");
    expect(cb).toContain("STALE_ASYNC_JOB_SWEEP_RECORD_ID");
    expect(cb).toContain("staleAsyncJobSweepOutcome(");
    expect(cb).toContain("{ id: STALE_ASYNC_JOB_SWEEP_RECORD_ID }");
    expect(cb).toContain("sweepStaleAsyncJobs(this.asyncJobsContext())");
  });

  it("watchdogMissedSchedules is NOT wrapped — its heartbeat is its run row", () => {
    const cb = region("async watchdogMissedSchedules(");
    expect(cb).not.toContain("recordScheduleCallbackRun(");
    expect(cb).toContain("watchdogMissedSchedules(await this.scheduleWatchdogContext()");
  });

  it("the slice adds no new firing: the three duties keep their existing arming", () => {
    const text = source("src/agents/orchestrator.ts");
    expect(text).toContain("scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS");
    expect(text).toContain("scheduleEvery(STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS");
    expect(text).toContain("scheduleEvery(SCHEDULE_WATCHDOG_INTERVAL_SECONDS");
  });
});

describe("4242 list route appends the three rows (best-effort)", () => {
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

  function seedRuns() {
    seedRun(sql, STALE_LEDGER_SWEEP_RECORD_ID, "research swept=2 pruned=3; screener swept=1 pruned=0");
    seedRun(sql, STALE_ASYNC_JOB_SWEEP_RECORD_ID, "examined=10 alerted=1 reaped=2");
    seedRun(sql, SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID, "examined=0 missed=0 skippedUnrecorded=3");
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

  it("appends all three rows with their last runs when the ledger has runs", async () => {
    seedRuns();
    const body = await list();
    const ledger = body.schedules.find((s) => s.id === "sweep-stale-ledger-tasks");
    expect(ledger).toBeDefined();
    expect(ledger?.kind).toBe("internal");
    expect(ledger?.callback).toBe("sweepStaleLedgerTasks");
    expect(ledger?.cron).toBe("0 */6 * * *");
    expect(ledger?.state).toBe("active");
    expect(ledger?.lastRunAt).toBe(RUN_STARTED);
    expect(ledger?.lastRunOutcome).toBe("success");
    expect(ledger?.lastRunDetail).toBe("research swept=2 pruned=3; screener swept=1 pruned=0");
    const asyncJobs = body.schedules.find((s) => s.id === "sweep-stale-async-jobs");
    expect(asyncJobs).toBeDefined();
    expect(asyncJobs?.callback).toBe("sweepStaleAsyncJobs");
    expect(asyncJobs?.cron).toBe("*/15 * * * *");
    expect(asyncJobs?.lastRunDetail).toBe("examined=10 alerted=1 reaped=2");
    const watchdog = body.schedules.find((s) => s.id === "schedule-watchdog");
    expect(watchdog).toBeDefined();
    expect(watchdog?.callback).toBe("watchdogMissedSchedules");
    expect(watchdog?.cron).toBe("*/15 * * * *");
    expect(watchdog?.lastRunDetail).toBe("examined=0 missed=0 skippedUnrecorded=3");
  });

  it("appends the rows with no last run when the duties have never fired", async () => {
    const body = await list();
    for (const id of DERIVED_IDS) {
      const row = body.schedules.find((s) => s.id === id);
      expect(row).toBeDefined();
      expect(row?.lastRunAt).toBeUndefined();
    }
  });

  it("omits the rows (list still 200) when the ledger read throws", async () => {
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
    for (const id of DERIVED_IDS) {
      expect(body.schedules.find((s) => s.id === id)).toBeUndefined();
    }
  });
});

describe("4242 runs routes join the three records to their ledger rows", () => {
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
    seedRun(sql, STALE_LEDGER_SWEEP_RECORD_ID, "research swept=2 pruned=3; screener swept=1 pruned=0");
    seedRun(sql, STALE_ASYNC_JOB_SWEEP_RECORD_ID, "examined=10 alerted=1 reaped=2");
    seedRun(sql, SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID, "examined=0 missed=0 skippedUnrecorded=3");
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

  it("GET /schedules/sweep-stale-ledger-tasks/runs returns the sweep ledger rows", async () => {
    const res = await call("/schedules/sweep-stale-ledger-tasks/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("sweep-stale-ledger-tasks");
  });

  it("GET /schedules/schedule-watchdog/runs returns the heartbeat rows", async () => {
    const res = await call("/schedules/schedule-watchdog/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("schedule-watchdog-heartbeat");
  });

  it("GET /schedules/runs?scheduleId=sweep-stale-async-jobs returns the same rows", async () => {
    const res = await call(
      "/schedules/runs",
      "https://agent.internal/schedules/runs?scheduleId=sweep-stale-async-jobs",
    );
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("sweep-stale-async-jobs");
  });
});

describe("4242 detail route answers the three derived records", () => {
  it.each(DERIVED_IDS)("GET /api/schedules/%s returns the derived detail, not 404", async (id) => {
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
    const path = `/api/schedules/${id}`;
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
    expect(detail.id).toBe(id);
  });
});

describe("4242 Schedules home renders the three rows (source pins)", () => {
  it("the panel names each row and shows its last run with counts", () => {
    const panel = source("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("Last task sweep");
    expect(panel).toContain('s.id === "sweep-stale-ledger-tasks"');
    expect(panel).toContain("Last job sweep");
    expect(panel).toContain('s.id === "sweep-stale-async-jobs"');
    expect(panel).toContain("Last watchdog");
    expect(panel).toContain('s.id === "schedule-watchdog"');
  });
});
