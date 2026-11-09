// @vitest-environment node
/**
 * Issue #3788 (parent incident #3781) — schedule watchdog, Orchestrator
 * sweep.
 *
 * On the 15-minute sweep tick (a sibling of #3784's stale-async-job
 * sweep, armed the same way in onStart), each durable schedule whose
 * callback has a ledger record is checked: when its last callback run
 * is older than its interval + grace, the miss emits all three signals
 * (audit event with a code, Slack alert through the notify hook, skipped
 * ledger record) exactly once per (schedule, expected tick). Schedules
 * whose callback leaves no ledger record are skipped, counted, and
 * named — never silently flagged, never silently watched.
 *
 * TDD Red: the sweep module does not exist yet.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  watchdogMissedSchedules,
  type MissedScheduleAlertInfo,
  type ScheduleWatchdogContext,
  type ScheduleWatchdogSchedule,
} from "../src/agents/orchestrator/scheduleWatchdog";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import { SCHEDULE_WATCHDOG_FIRST_SEEN_KEY } from "../src/services/scheduleWatchdog";

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

const NOW = Date.parse("2026-11-09T02:35:00.000Z");
const HOUR = 60 * 60 * 1000;
const RECORDED = ["autonomousMarketScreen", "executeAsyncJob"];

interface Harness {
  db: DatabaseSync;
  sql: ReturnType<typeof makeSql>;
  ctx: ScheduleWatchdogContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
  alerts: MissedScheduleAlertInfo[];
  firstSeen: Map<string, unknown>;
}

function makeHarness(schedules: ScheduleWatchdogSchedule[], env: Record<string, string> = {}): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: Harness["audits"] = [];
  const alerts: MissedScheduleAlertInfo[] = [];
  const firstSeen = new Map<string, unknown>();
  const ctx = {
    env,
    sql: sql as never,
    storage: {
      get: async (k: string) => firstSeen.get(k),
      put: async (k: string, v: unknown) => void firstSeen.set(k, v),
    },
    listSchedules: async () => schedules,
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    notifyMissedSchedule: async (info: MissedScheduleAlertInfo) => {
      alerts.push(info);
    },
  } as unknown as ScheduleWatchdogContext;
  return { db, sql, ctx, audits, alerts, firstSeen };
}

function seedRun(
  harness: Harness,
  jobId: string,
  startedIso: string,
  outcome: "success" | "failure" | "skipped" = "success",
): void {
  const store = new SqlJobRunRecordStore(harness.sql as never);
  store.record(
    buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId,
      operation: "autonomousMarketScreen",
      started: startedIso,
      finished: startedIso,
      outcome,
      triggeredBy: "scheduled",
      scheduleId: jobId,
      ...(outcome === "skipped" ? { detail: "skipped by callback" } : {}),
    }),
  );
}

function seedFirstSeen(harness: Harness, id: string): void {
  harness.firstSeen.set(SCHEDULE_WATCHDOG_FIRST_SEEN_KEY, {
    [id]: new Date(NOW - 2 * 24 * HOUR).toISOString(),
  });
}

describe("orchestrator schedule watchdog sweep (#3788)", () => {
  it("flags a cron schedule with no run since its expected tick (all three signals)", async () => {
    const schedules: ScheduleWatchdogSchedule[] = [
      { id: "sched-1", callback: "autonomousMarketScreen", type: "cron", cron: "0 6 * * *" },
    ];
    const h = makeHarness(schedules);
    seedFirstSeen(h, "sched-1");
    const result = await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });

    expect(result.examined).toBe(1);
    expect(result.missed).toBe(1);
    expect(result.alerted).toBe(1);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].scheduleId).toBe("sched-1");
    expect(h.alerts[0].callback).toBe("autonomousMarketScreen");
    expect(h.alerts[0].expectedTick).toBe("2026-11-08T06:00:00.000Z");
    expect(h.alerts[0].lastRun).toBeNull();
    const detection = h.audits.filter((a) => a.type === "schedule.missed_fire");
    expect(detection).toHaveLength(1);
    expect(detection[0].payload.code).toBe("missed_fire");
    expect(detection[0].payload.scheduleId).toBe("sched-1");
    const store = new SqlJobRunRecordStore(h.sql as never);
    const row = store.latestByJob("sched-1");
    expect(row?.outcome).toBe("skipped");
    expect(row?.detail).toMatch(/^missed-fire: expected 2026-11-08T06:00:00.000Z/);
    // Heartbeat: the sweep ran, with examined counts.
    const heartbeat = store.latestByJob("schedule-watchdog-heartbeat");
    expect(heartbeat?.outcome).toBe("success");
    expect(heartbeat?.detail).toContain("examined=1");
    expect(heartbeat?.detail).toContain("missed=1");
  });

  it("does not flag a schedule whose last run covers its expected tick", async () => {
    const schedules: ScheduleWatchdogSchedule[] = [
      { id: "sched-1", callback: "autonomousMarketScreen", type: "cron", cron: "0 6 * * *" },
    ];
    const h = makeHarness(schedules);
    seedFirstSeen(h, "sched-1");
    seedRun(h, "sched-1", "2026-11-08T06:05:00.000Z");
    const result = await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });
    expect(result.missed).toBe(0);
    expect(result.alerted).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.audits.filter((a) => a.type === "schedule.missed_fire")).toHaveLength(0);
  });

  it("alerts exactly once per (schedule, expected tick) across sweeps", async () => {
    const schedules: ScheduleWatchdogSchedule[] = [
      { id: "sched-1", callback: "autonomousMarketScreen", type: "cron", cron: "0 6 * * *" },
    ];
    const h = makeHarness(schedules);
    seedFirstSeen(h, "sched-1");
    await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });
    const second = await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });
    expect(second.missed).toBe(0);
    expect(second.alerted).toBe(0);
    expect(h.alerts).toHaveLength(1);
    expect(h.audits.filter((a) => a.type === "schedule.missed_fire")).toHaveLength(1);
  });

  it("skips schedules whose callback leaves no ledger record (counted, not flagged)", async () => {
    const schedules: ScheduleWatchdogSchedule[] = [
      { id: "sweep-1", callback: "sweepStaleAsyncJobs", type: "interval", time: NOW / 1000, intervalSeconds: 900 },
    ];
    const h = makeHarness(schedules);
    const result = await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });
    expect(result.examined).toBe(0);
    expect(result.skippedUnrecorded).toBe(1);
    expect(result.missed).toBe(0);
    expect(h.alerts).toHaveLength(0);
    expect(h.audits.filter((a) => a.type === "schedule.missed_fire")).toHaveLength(0);
  });

  it("flags an interval schedule from time - intervalSeconds", async () => {
    const schedules: ScheduleWatchdogSchedule[] = [
      {
        id: "sched-iv",
        callback: "autonomousMarketScreen",
        type: "interval",
        // Next execution 01:30, every 15 min → previous firing 01:15,
        // 80 minutes before the 02:35 now — past the 60-minute grace.
        time: Date.parse("2026-11-09T01:30:00.000Z") / 1000,
        intervalSeconds: 900,
      },
    ];
    const h = makeHarness(schedules);
    seedFirstSeen(h, "sched-iv");
    seedRun(h, "sched-iv", "2026-11-09T01:00:00.000Z");
    const result = await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });
    expect(result.missed).toBe(1);
    expect(h.alerts[0].expectedTick).toBe("2026-11-09T01:15:00.000Z");
  });

  it("does nothing when the grace is disabled (0)", async () => {
    const schedules: ScheduleWatchdogSchedule[] = [
      { id: "sched-1", callback: "autonomousMarketScreen", type: "cron", cron: "0 6 * * *" },
    ];
    const h = makeHarness(schedules, { MISSED_SCHEDULE_GRACE_MINUTES: "0" });
    seedFirstSeen(h, "sched-1");
    const result = await watchdogMissedSchedules(h.ctx, { recordedCallbacks: RECORDED, nowMs: NOW });
    expect(result).toEqual({ examined: 0, alerted: 0, missed: 0, skippedUnrecorded: 0 });
    const store = new SqlJobRunRecordStore(h.sql as never);
    expect(store.latestByJob("schedule-watchdog-heartbeat")).toBeUndefined();
  });
});
