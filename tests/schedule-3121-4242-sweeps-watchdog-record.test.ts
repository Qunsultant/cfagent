/**
 * Issue #3121 #4242 — sweeps and watchdog in the single schedule.
 *
 * The internal maintenance sweeps (sweepStaleLedgerTasks,
 * sweepStaleAsyncJobs) and the schedule watchdog
 * (watchdogMissedSchedules) are stored platform-level schedules
 * (#6503): one stored row per duty (id = the ledger job id, kind
 * internal, state paused, monthly interval), listed with their
 * last run joined from the ledger, so a sweep that finds stale
 * work — or a watchdog that finds missed schedules — shows its
 * counts. The old derived records (synthesized at read time,
 * management refused) are deleted: a row renders only when
 * stored, and the verbs operate on the stored row.
 *
 * Recording reuses the #3394 wrapper (recordScheduleCallbackRun,
 * the ONE recorder — no second recorder): the two sweep methods
 * wrap their bodies, mapping the sweep-result object to a
 * ScheduledCallbackOutcome (counts in `detail`); the watchdog
 * method is NOT wrapped — its heartbeat row already IS its run
 * row, and wrapping it would double-record every sweep. The
 * wrapper is called with the normalized schedule { id: RECORD_ID }
 * (never the SDK alarm id): the stored record is the ledger
 * identity, and the alarm id is a substrate id that changes on
 * re-arm. The watchdog keeps skipping the three by name
 * (RECORDED_SCHEDULE_CALLBACKS unchanged): its lookup is by alarm
 * id, and these rows are keyed by record id — it still cannot
 * observe them by schedule.id, so watching them would cry wolf.
 * Sweep behavior is unchanged; the duties fire from their stored
 * schedules, not SDK arms.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { UNIFIED_SCHEDULE_KINDS, type UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
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
  staleLedgerSweepRecordToListItem,
  staleAsyncJobSweepRecordToListItem,
  scheduleWatchdogRecordToListItem,
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
import { recordLedgerRunD1 } from "../src/data/createJobRunRecordPorts";
import { scheduleIdToLedgerJobId } from "../src/services/jobRunRecords";
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
const MONTHLY_SECONDS = 2_592_000;

const STORED_IDS = [
  "sweep-stale-ledger-tasks",
  "sweep-stale-async-jobs",
  "schedule-watchdog",
] as const;

const CALLBACKS: Record<string, string> = {
  "sweep-stale-ledger-tasks": "sweepStaleLedgerTasks",
  "sweep-stale-async-jobs": "sweepStaleAsyncJobs",
  "schedule-watchdog": "watchdogMissedSchedules",
};

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

/** Issue #6101 — the D1 run ledger over a fresh in-memory mock binding. */
function ledgerD1() {
  const d1 = new MockD1Database();
  const store = new D1JobRunRecordStore(
    createD1JobRunRecordDb(d1 as unknown as D1Database),
  );
  return { d1, store };
}

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

/** A stored sweep/watchdog row, as the seed creates it (state set by the test). */
function storedDutyRecord(
  id: (typeof STORED_IDS)[number],
  state: "active" | "paused",
  createdAt = NOW,
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
    } as unknown as UnifiedScheduleRecord["definition"],
    ownerLogin: null,
    provenance: { origin: "system", createdBy: "system", reason: id, createdAt },
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
    arm: async () => ({ id: "new-1", callback: "sweepStaleLedgerTasks" }),
    ...overrides,
  };
}

async function seedRun(d1: MockD1Database, jobId: string, detail: string): Promise<void> {
  // Issue #6101 — the seed lands in D1, not the DO.
  const store = new D1JobRunRecordStore(
    createD1JobRunRecordDb(d1 as unknown as D1Database),
  );
  await recordLedgerRunD1(store, {
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

describe("4242 stored sweep + watchdog records", () => {
  it("reconcile seeds the one stable record per duty (internal, paused, monthly)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const result = await reconcileSystemScheduleRecords(
      { store, alarms: alarmsStub() },
      NOW,
      { userLogin: "mars" },
    );
    for (const id of STORED_IDS) {
      expect(result.seeded).toContain(id);
      const record = await store.get(id);
      expect(record?.id).toBe(id);
      expect(record?.kind).toBe("internal");
      expect(record?.state).toBe("paused");
      expect(record?.callback).toBe(CALLBACKS[id]);
      expect(
        (record?.definition as unknown as Record<string, unknown>).intervalSeconds,
      ).toBe(MONTHLY_SECONDS);
      expect(
        (record?.definition as unknown as Record<string, unknown>).cron,
      ).toBeUndefined();
      expect(record?.provenance.origin).toBe("system");
      expect(record?.provenance.reason).toBe(id);
      expect(record?.alarmId).toBeNull();
      expect(record?.createdAt).toBe(NOW);
      expect(record?.updatedAt).toBe(NOW);
    }
    expect(STALE_LEDGER_SWEEP_RECORD_ID).toBe("sweep-stale-ledger-tasks");
    expect(STALE_ASYNC_JOB_SWEEP_RECORD_ID).toBe("sweep-stale-async-jobs");
    expect(SCHEDULE_WATCHDOG_RECORD_ID).toBe("schedule-watchdog");
    expect(STALE_LEDGER_SWEEP_ORIGIN).toBe("sweep-stale-ledger-tasks");
    expect(STALE_ASYNC_JOB_SWEEP_ORIGIN).toBe("sweep-stale-async-jobs");
    expect(SCHEDULE_WATCHDOG_ORIGIN).toBe("schedule-watchdog");
    // The ledger sweep seeds with its owner's login in the payload.
    const ledger = await store.get("sweep-stale-ledger-tasks");
    expect(
      (ledger?.definition as unknown as Record<string, unknown>).payload,
    ).toEqual({ userLogin: "mars" });
  });

  it("the stored rows run monthly; the old firing intervals are retired", () => {
    const orchestrator = source("src/agents/orchestrator.ts");
    expect(orchestrator).not.toContain("STALE_SWEEP_INTERVAL_SECONDS = 6 * 60 * 60");
    expect(orchestrator).not.toContain("STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS = 15 * 60");
    expect(orchestrator).not.toContain(
      "SCHEDULE_WATCHDOG_INTERVAL_SECONDS = STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS",
    );
    expect(orchestrator).not.toContain("scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS");
    expect(orchestrator).not.toContain("scheduleEvery(STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS");
    expect(orchestrator).not.toContain("scheduleEvery(SCHEDULE_WATCHDOG_INTERVAL_SECONDS");
    // The dispatch crons survive only as the retired firing rules'
    // values (ledger history), never re-literalized elsewhere.
    expect(STALE_LEDGER_SWEEP_DISPATCH_CRON).toBe("0 */6 * * *");
    expect(STALE_ASYNC_JOB_SWEEP_DISPATCH_CRON).toBe("*/15 * * * *");
    expect(SCHEDULE_WATCHDOG_DISPATCH_CRON).toBe("*/15 * * * *");
  });

  it("adds no new kind to the unified-store union", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(7);
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("sweep-stale-ledger-tasks");
    expect(UNIFIED_SCHEDULE_KINDS).not.toContain("schedule-watchdog");
  });

  it("an in-place update preserves createdAt (upsert, not recreate)", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedDutyRecord("sweep-stale-ledger-tasks", "active", "2026-11-18T07:00:00.000Z"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "sweep-stale-ledger-tasks", NOW);
    expect(paused.ok).toBe(true);
    const after = await store.get("sweep-stale-ledger-tasks");
    expect(after?.createdAt).toBe("2026-11-18T07:00:00.000Z");
    expect(after?.updatedAt).toBe(NOW);
    expect(after?.id).toBe("sweep-stale-ledger-tasks");
    await store.save(storedDutyRecord("schedule-watchdog", "active", "2026-11-18T07:00:00.000Z"));
    const wPaused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, "schedule-watchdog", NOW);
    expect(wPaused.ok).toBe(true);
    expect((await store.get("schedule-watchdog"))?.createdAt).toBe("2026-11-18T07:00:00.000Z");
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
    const item = staleLedgerSweepRecordToListItem(storedDutyRecord("sweep-stale-ledger-tasks", "active"), {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
      detail: "research swept=2 pruned=3; screener swept=1 pruned=0",
    });
    expect(item.id).toBe("sweep-stale-ledger-tasks");
    expect(item.kind).toBe("internal");
    expect(item.callback).toBe("sweepStaleLedgerTasks");
    // The stored row is a monthly interval, not the old 6h cron.
    expect(item.cron).toBeUndefined();
    expect(item.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunOutcome).toBe("success");
    expect(item.lastRunDetail).toBe("research swept=2 pruned=3; screener swept=1 pruned=0");
  });

  it("carries the async-job sweep's last run with its counts", () => {
    const item = staleAsyncJobSweepRecordToListItem(storedDutyRecord("sweep-stale-async-jobs", "active"), {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
      detail: "examined=10 alerted=1 reaped=2",
    });
    expect(item.id).toBe("sweep-stale-async-jobs");
    expect(item.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunDetail).toBe("examined=10 alerted=1 reaped=2");
  });

  it("carries the watchdog's last heartbeat with its counts", () => {
    const item = scheduleWatchdogRecordToListItem(storedDutyRecord("schedule-watchdog", "active"), {
      started: RUN_STARTED,
      finished: RUN_FINISHED,
      outcome: "success",
      detail: "examined=0 missed=0 skippedUnrecorded=3",
    });
    expect(item.id).toBe("schedule-watchdog");
    expect(item.callback).toBe("watchdogMissedSchedules");
    expect(item.cron).toBeUndefined();
    expect(item.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(item.lastRunAt).toBe(RUN_STARTED);
    expect(item.lastRunDetail).toBe("examined=0 missed=0 skippedUnrecorded=3");
  });

  it("carries no last run when a duty has never fired", () => {
    expect(
      staleLedgerSweepRecordToListItem(storedDutyRecord("sweep-stale-ledger-tasks", "paused")).lastRunAt,
    ).toBeUndefined();
    expect(
      staleAsyncJobSweepRecordToListItem(storedDutyRecord("sweep-stale-async-jobs", "paused")).lastRunAt,
    ).toBeUndefined();
    expect(
      scheduleWatchdogRecordToListItem(storedDutyRecord("schedule-watchdog", "paused")).lastRunAt,
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

describe("4242 management works on the stored sweep + watchdog records (no derived refusal)", () => {
  it.each(STORED_IDS)("pause pauses the stored %s row", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedDutyRecord(id, "active"));
    const paused = await pauseUnifiedSchedule({ store, alarms: alarmsStub() }, id, NOW);
    expect(paused.ok).toBe(true);
    if (paused.ok) expect(paused.record.state).toBe("paused");
    expect((await store.get(id))?.state).toBe("paused");
  });

  it.each(STORED_IDS)("resume re-arms the stored paused %s row from its own monthly timing", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedDutyRecord(id, "paused"));
    const arm = vi.fn(async () => ({ id: "alarm-9", callback: CALLBACKS[id] }));
    const resumed = await resumeUnifiedSchedule(
      { store, alarms: alarmsStub({ arm }) },
      id,
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

  it.each(STORED_IDS)("trigger runs the stored active %s row and stamps triggered", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save({ ...storedDutyRecord(id, "active"), alarmId: "alarm-1" });
    const seen: Array<{ callback: string; payload: unknown }> = [];
    const triggered = await triggerUnifiedSchedule(
      {
        store,
        alarms: alarmsStub({
          get: async () => ({ id: "alarm-1", callback: CALLBACKS[id], payload: {} }),
        }),
      },
      id,
      async (callback: string, payload: unknown) => {
        seen.push({ callback, payload });
      },
    );
    expect(triggered.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].callback).toBe(CALLBACKS[id]);
    expect((seen[0].payload as Record<string, unknown>).trigger).toBe("triggered");
  });

  it.each(STORED_IDS)("update re-times the stored paused %s row without an alarm", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedDutyRecord(id, "paused"));
    const updated = await updateUnifiedSchedule(
      { store, alarms: alarmsStub() },
      id,
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

  it.each(STORED_IDS)("delete removes the stored %s row and it stays gone", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(storedDutyRecord(id, "paused"));
    const deleted = await deleteUnifiedSchedule({ store, alarms: alarmsStub() }, id);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.cancelled).toBe(true);
    expect(await store.get(id)).toBeUndefined();
  });

  it.each(STORED_IDS)("a missing %s row 404s every verb, never a derived refusal", async (id) => {
    const store = new InMemoryUnifiedScheduleStore();
    // The strict alarms port: cancelling an unknown id is false
    // (nothing was there), like the real port's contract.
    const deps = { store, alarms: alarmsStub({ cancel: async () => false }) };
    const cases: Array<{ result: Awaited<ReturnType<typeof pauseUnifiedSchedule>>; message: string }> = [
      { result: await pauseUnifiedSchedule(deps, id, NOW), message: "not found" },
      { result: await resumeUnifiedSchedule(deps, id, NOW), message: "is not paused" },
      { result: await deleteUnifiedSchedule(deps, id), message: "not found" },
      { result: await triggerUnifiedSchedule(deps, id, async () => {}), message: "not found" },
      {
        result: await updateUnifiedSchedule(deps, id, { intervalSeconds: MONTHLY_SECONDS }, Date.parse(NOW)),
        message: "not found",
      },
    ];
    for (const { result, message } of cases) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.error).toContain(id);
        expect(result.error).toContain(message);
        expect(result.error).not.toContain("derived");
      }
    }
  });
});

describe("4242 the #3394 wrapper records a sweep run under the record id", () => {
  it("records one row per sweep run: jobId + scheduleId are the record id, counts in detail", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
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
      // Issue #6101 — the recorder resolves the D1 store from env.
      { audit: () => {}, env: { AGENT_DB: d1 } },
    );
    const rows = await store.listByJob(STALE_LEDGER_SWEEP_RECORD_ID);
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
    const { d1, store } = ledgerD1();
    await recordScheduleCallbackRun(
      sql.sql as never,
      "sweepStaleAsyncJobs",
      {},
      { id: STALE_ASYNC_JOB_SWEEP_RECORD_ID },
      async () => staleAsyncJobSweepOutcome({ examined: 10, alerted: 1, reaped: 2 }),
      // Issue #6101 — the recorder resolves the D1 store from env.
      { audit: () => {}, env: { AGENT_DB: d1 } },
    );
    const rows = await store.listByJob(STALE_ASYNC_JOB_SWEEP_RECORD_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toBe("examined=10 alerted=1 reaped=2");
  });
});

describe("4242 the watchdog heartbeat IS its run row (no second recorder)", () => {
  it("writes exactly one heartbeat row per sweep with examined/missed/skipped counts", async () => {
    const sql = new SqliteTestStorage();
    const { d1, store } = ledgerD1();
    const ctx: ScheduleWatchdogContext = {
      // Issue #6101 — the heartbeat lands in D1 via ctx.env.AGENT_DB.
      env: { AGENT_DB: d1 },
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
    const rows = await store.listByJob(SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID);
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

  it("the three duties fire from their stored schedules, not SDK arms", () => {
    const text = source("src/agents/orchestrator.ts");
    // The methods still exist and still record through the #3394
    // wrapper (pinned above); the onStart scheduleEvery arms are
    // retired — the stored schedule is the one arming mechanism.
    expect(text).toContain("async sweepStaleLedgerTasks(");
    expect(text).toContain("async sweepStaleAsyncJobs(");
    expect(text).toContain("async watchdogMissedSchedules(");
    expect(text).not.toContain("scheduleEvery(STALE_SWEEP_INTERVAL_SECONDS");
    expect(text).not.toContain("scheduleEvery(STALE_ASYNC_JOB_SWEEP_INTERVAL_SECONDS");
    expect(text).not.toContain("scheduleEvery(SCHEDULE_WATCHDOG_INTERVAL_SECONDS");
  });
});

describe("4242 list route reads the three stored rows (no synthesis)", () => {
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

  async function seedRuns() {
    await seedRun(d1, STALE_LEDGER_SWEEP_RECORD_ID, "research swept=2 pruned=3; screener swept=1 pruned=0");
    await seedRun(d1, STALE_ASYNC_JOB_SWEEP_RECORD_ID, "examined=10 alerted=1 reaped=2");
    await seedRun(d1, SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID, "examined=0 missed=0 skippedUnrecorded=3");
  }

  /** The three stored rows the list renders (D1 only, #6503 fail-closed). */
  async function seedStoredDutyRows() {
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    // Paused: the seed default — and the list renders a stored row
    // from the store only when paused (an active row renders
    // through its live alarm, which this fixture has none of).
    for (const id of STORED_IDS) await store.save(storedDutyRecord(id, "paused"));
  }

  beforeEach(async () => {
    sql = new SqliteTestStorage();
    d1 = new MockD1Database();
    ctx = baseCtx();
    await seedStoredDutyRows();
  });

  async function list() {
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", ctx);
    expect(res?.status).toBe(200);
    return (await res!.json()) as { schedules: Array<Record<string, unknown>> };
  }

  it("shows all three stored rows with their last runs when the ledger has runs", async () => {
    await seedRuns();
    const body = await list();
    const ledger = body.schedules.find((s) => s.id === "sweep-stale-ledger-tasks");
    expect(ledger).toBeDefined();
    expect(ledger?.kind).toBe("internal");
    expect(ledger?.callback).toBe("sweepStaleLedgerTasks");
    expect(ledger?.cron).toBeUndefined();
    expect(ledger?.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(ledger?.state).toBe("paused");
    expect(ledger?.lastRunAt).toBe(RUN_STARTED);
    expect(ledger?.lastRunOutcome).toBe("success");
    expect(ledger?.lastRunDetail).toBe("research swept=2 pruned=3; screener swept=1 pruned=0");
    const asyncJobs = body.schedules.find((s) => s.id === "sweep-stale-async-jobs");
    expect(asyncJobs).toBeDefined();
    expect(asyncJobs?.callback).toBe("sweepStaleAsyncJobs");
    expect(asyncJobs?.cron).toBeUndefined();
    expect(asyncJobs?.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(asyncJobs?.lastRunDetail).toBe("examined=10 alerted=1 reaped=2");
    const watchdog = body.schedules.find((s) => s.id === "schedule-watchdog");
    expect(watchdog).toBeDefined();
    expect(watchdog?.callback).toBe("watchdogMissedSchedules");
    expect(watchdog?.cron).toBeUndefined();
    expect(watchdog?.intervalSeconds).toBe(MONTHLY_SECONDS);
    expect(watchdog?.lastRunDetail).toBe("examined=0 missed=0 skippedUnrecorded=3");
  });

  it("shows the stored rows with no last run when the duties have never fired", async () => {
    const body = await list();
    for (const id of STORED_IDS) {
      const row = body.schedules.find((s) => s.id === id);
      expect(row).toBeDefined();
      expect(row?.lastRunAt).toBeUndefined();
    }
  });

  it("keeps the stored rows without a last run (list still 200) when the ledger read throws", async () => {
    // The ledger read fails but the unified-store list still works:
    // only job_run_records statements throw. The stored rows render
    // without their last runs — a ledger failure never drops a row.
    const throwing = baseCtx({
      env: { AGENT_DB: ledgerDownD1(d1) as never },
    });
    const req = new Request("https://example.test/api/schedules", { method: "GET" });
    const res = await handleSchedulesRoutes(req, new URL(req.url), "/api/schedules", "sess", throwing);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { schedules: Array<Record<string, unknown>> };
    for (const id of STORED_IDS) {
      const row = body.schedules.find((s) => s.id === id);
      expect(row).toBeDefined();
      expect(row?.lastRunAt).toBeUndefined();
    }
  });
});

describe("4242 runs routes join the three records to their ledger rows", () => {
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
    await seedRun(d1, STALE_LEDGER_SWEEP_RECORD_ID, "research swept=2 pruned=3; screener swept=1 pruned=0");
    await seedRun(d1, STALE_ASYNC_JOB_SWEEP_RECORD_ID, "examined=10 alerted=1 reaped=2");
    await seedRun(d1, SCHEDULE_WATCHDOG_HEARTBEAT_JOB_ID, "examined=0 missed=0 skippedUnrecorded=3");
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

describe("4242 detail route answers the three stored records", () => {
  it.each(STORED_IDS)("GET /api/schedules/%s returns the stored detail, not 404", async (id) => {
    const sql = new SqliteTestStorage();
    const d1 = new MockD1Database();
    const store = createD1UnifiedSchedulePorts({ d1: d1 as never }).unifiedSchedules;
    await store.save(storedDutyRecord(id, "active"));
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
