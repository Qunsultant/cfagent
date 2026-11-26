/**
 * Issue #5890 (one-schedule programme, slice 5 of 19) — one row per job.
 *
 * The same job appears as several rows in the Schedules home — same
 * taskId, same scheduleHash, same name, different ids and different
 * cadences. The owner's rule (verbatim acceptance): each job must
 * appear only once with its schedule. No duplicate rows for the same
 * job under any source. The list must collapse by job identity;
 * superseded alarms must be cancelled, not left listed; stale paused
 * records must not each render as a row.
 *
 * Pins (5890-P01…P10):
 *  - P01 the job key: a declared task keys by taskId (never the
 *    scheduleHash — both declared tasks share one hash); a sweep /
 *    watchdog / stored system duty keys by its stored-record id
 *    (live alarm and stored row share it); anything else keys by its
 *    own row id, so distinct user schedules never collapse.
 *  - P02 the list collapses duplicate live alarms for one declared
 *    task (same occurrence armed twice, and two occurrences) to one
 *    row — the soonest firing wins.
 *  - P03 a canonical paused record (id == taskId) plus live alarms
 *    for the same task collapses to the one paused row.
 *  - P04 stale per-alarm paused records with no canonical record
 *    collapse to one row (most recently paused wins); a live alarm
 *    beside them wins, because the job is firing.
 *  - P05 the owner's paste shape: per-alarm paused records plus the
 *    canonical record collapse to one row per task.
 *  - P06 the stored sweep row and its live alarm are the same row,
 *    not two (stored record wins; one cadence sentence).
 *  - P07 pause merges into the canonical record: pausing a declared
 *    task cancels EVERY live alarm for that task and stores under the
 *    taskId; a legacy per-alarm paused record is removed, not kept.
 *  - P08 pause of a stale row (alarm gone) still merges by the
 *    record's own task id — the alarm is not the only reader.
 *  - P09 resume of a per-alarm paused record moves it under the
 *    taskId.
 *  - P10 arm-time hygiene: the declared-task prune keeps one alarm
 *    per (taskId, scheduledFor); the ensure-guard plan arms only
 *    when no match exists and cancels surplus matches.
 *
 * Out of scope here: provenance display (#5889, done), the delete
 * path (#5891), the NaN rendering (#5896).
 */
import { describe, it, expect } from "vitest";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import {
  DECLARED_TASK_CALLBACK,
  collapseScheduleListItems,
  listUnifiedScheduleItems,
  pauseUnifiedSchedule,
  planGuardAlarm,
  resumeUnifiedSchedule,
  scheduleJobKeyOf,
  staleLedgerSweepRecordToListItem,
  supersededDeclaredTaskAlarmIds,
  type ScheduleAlarmLike,
} from "../src/services/unifiedScheduleManagement";

const NOW_ISO = "2026-11-21T10:00:00.000Z";
const TASK_A = "options-strategy-scan-observe";
const TASK_B = "stock-copilot-paper-cycle";
const SHARED_HASH = "1cc4bdea8e8b678cdc2258188071a26f";
const SF_1 = 1_794_564_308_914;
const SF_2 = 1_794_566_257_332;

/** One declared Think task's occurrence alarm. */
function declaredAlarm(
  id: string,
  taskId: string,
  scheduledFor: number,
  nextRun = scheduledFor,
): ScheduleAlarmLike {
  return {
    id,
    callback: DECLARED_TASK_CALLBACK,
    type: "scheduled",
    time: Math.floor(scheduledFor / 1000),
    payload: { taskId, scheduleHash: SHARED_HASH, scheduledFor },
    nextRun,
  };
}

/** A sweep/watchdog interval alarm. */
function sweepAlarm(id: string, callback: string, userLogin?: string): ScheduleAlarmLike {
  return {
    id,
    callback,
    type: "interval",
    intervalSeconds: callback === "sweepStaleLedgerTasks" ? 6 * 60 * 60 : 15 * 60,
    ...(userLogin !== undefined ? { payload: { userLogin } } : { payload: {} }),
    nextRun: 1_800_000_000_000,
  };
}

/** A user-created screen schedule's alarm. */
function userAlarm(id: string, payload: Record<string, unknown>): ScheduleAlarmLike {
  return {
    id,
    callback: "autonomousMarketScreen",
    type: "cron",
    cron: "5 * * * *",
    payload,
    nextRun: 1_800_000_000_000,
  };
}

/** A paused record for one declared-task occurrence, as the legacy (pre-#4351) pause stored it. */
function perAlarmPausedRecord(
  id: string,
  taskId: string,
  scheduledFor: number,
  pausedAt: string,
): UnifiedScheduleRecord {
  return {
    id,
    kind: "screen",
    state: "paused",
    callback: DECLARED_TASK_CALLBACK,
    definition: {
      type: "scheduled",
      callback: DECLARED_TASK_CALLBACK,
      payload: { taskId, scheduleHash: SHARED_HASH, scheduledFor },
      time: Math.floor(scheduledFor / 1000),
    },
    alarmId: id,
    pausedAt,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

/** The canonical paused record: id IS the task id. */
function canonicalPausedRecord(taskId: string, pausedAt = NOW_ISO): UnifiedScheduleRecord {
  return {
    id: taskId,
    kind: "screen",
    state: "paused",
    callback: DECLARED_TASK_CALLBACK,
    definition: {
      type: "scheduled",
      callback: DECLARED_TASK_CALLBACK,
      payload: { taskId, scheduleHash: SHARED_HASH, scheduledFor: SF_1 },
      time: Math.floor(SF_1 / 1000),
    },
    alarmId: `alarm-${taskId}-1`,
    pausedAt,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

/** An alarms port with the real contract: a cancelled alarm is gone from list/get. */
function alarmsPort(initial: ScheduleAlarmLike[] = []) {
  const live = new Map(initial.map((a) => [a.id, a]));
  const cancelled: string[] = [];
  return {
    cancelled,
    live,
    port: {
      list: async () => [...live.values()],
      get: async (id: string) => live.get(id),
      cancel: async (id: string) => {
        cancelled.push(id);
        return live.delete(id);
      },
      arm: async () => ({ id: "new-alarm-1" }),
    },
  };
}

describe("5890-P01 the job key", () => {
  it("a declared task keys by taskId, never the shared scheduleHash", () => {
    const a = declaredAlarm("vuJuq5Iqt", TASK_A, SF_1);
    const b = declaredAlarm("txvdqmpNB", TASK_A, SF_1);
    expect(scheduleJobKeyOf(a)).toBe(`declared:${TASK_A}`);
    expect(scheduleJobKeyOf(a)).toBe(scheduleJobKeyOf(b));
    // The second task shares the hash but is a different job.
    expect(scheduleJobKeyOf(declaredAlarm("other-1", TASK_B, SF_1))).toBe(
      `declared:${TASK_B}`,
    );
    expect(scheduleJobKeyOf(a)).not.toBe(scheduleJobKeyOf(declaredAlarm("other-1", TASK_B, SF_1)));
  });

  it("a sweep alarm and its stored record share one key", () => {
    const alarmKey = scheduleJobKeyOf(sweepAlarm("sdk-1", "sweepStaleLedgerTasks", "venus"));
    const stored: UnifiedScheduleRecord = {
      id: "sweep-stale-ledger-tasks",
      kind: "internal",
      state: "paused",
      callback: "sweepStaleLedgerTasks",
      definition: {
        type: "interval",
        intervalSeconds: 2_592_000,
        callback: "sweepStaleLedgerTasks",
      } as unknown as UnifiedScheduleRecord["definition"],
      ownerLogin: null,
      provenance: { origin: "system", createdBy: "system", reason: "sweep-stale-ledger-tasks", createdAt: NOW_ISO },
      alarmId: null,
      pausedAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    const recordKey = scheduleJobKeyOf(staleLedgerSweepRecordToListItem(stored));
    expect(alarmKey).toBe("job:sweep-stale-ledger-tasks");
    expect(recordKey).toBe(alarmKey);
  });

  it("distinct user schedules never share a key, even under one callback", () => {
    const a = userAlarm("user-a", { universe: "SP500", userLogin: "venus" });
    const b = userAlarm("user-b", { universe: "NASDAQ100", userLogin: "venus" });
    expect(scheduleJobKeyOf(a)).toBe("row:user-a");
    expect(scheduleJobKeyOf(b)).toBe("row:user-b");
    expect(scheduleJobKeyOf(a)).not.toBe(scheduleJobKeyOf(b));
  });

  it("a cron '0 13 * * *' declared-task row keys by its taskId, like every other row for that task", () => {
    // The three mystery rows (XDfHeUgo8, lsaMkZIKo, 8vJaR7z3K): type cron,
    // "Daily at 1:00 PM UTC" — no code arms that cron, but whatever armed
    // them, their payload names the task, so they collapse with it.
    const mystery = perAlarmPausedRecord("XDfHeUgo8", TASK_A, SF_1, NOW_ISO);
    mystery.definition = {
      type: "cron",
      callback: DECLARED_TASK_CALLBACK,
      payload: { taskId: TASK_A, scheduleHash: SHARED_HASH, scheduledFor: SF_1 },
      cron: "0 13 * * *",
    };
    expect(scheduleJobKeyOf(mystery)).toBe(`declared:${TASK_A}`);
  });
});

describe("5890-P02/P03/P04/P05 the list collapses by job identity", () => {
  it("P02: two live alarms for one task, same occurrence armed twice, render once", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort([
      declaredAlarm("vuJuq5Iqt", TASK_A, SF_1),
      declaredAlarm("txvdqmpNB", TASK_A, SF_1),
    ]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    expect(items[0]?.callback).toBe(DECLARED_TASK_CALLBACK);
  });

  it("P02: two occurrences of one task render once, soonest firing wins", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort([
      declaredAlarm("later-1", TASK_A, SF_2, SF_2),
      declaredAlarm("sooner-1", TASK_A, SF_1, SF_1),
    ]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("sooner-1");
  });

  it("P03: canonical paused record plus live alarms render as the one paused row", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(canonicalPausedRecord(TASK_A));
    const { port } = alarmsPort([
      declaredAlarm("alarm-a-1", TASK_A, SF_1),
      declaredAlarm("alarm-a-2", TASK_A, SF_2),
    ]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(TASK_A);
    expect(items[0]?.paused).toBe(true);
  });

  it("P04: stale per-alarm paused records with no canonical record render once", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(perAlarmPausedRecord("old-1", TASK_A, SF_1, "2026-11-13T10:00:00.000Z"));
    await store.save(perAlarmPausedRecord("old-2", TASK_A, SF_2, "2026-11-20T10:00:00.000Z"));
    const { port } = alarmsPort([]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    // Most recently paused wins.
    expect(items[0]?.id).toBe("old-2");
    expect(items[0]?.paused).toBe(true);
  });

  it("P04: a live alarm beside stale paused records wins — the job is firing", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(perAlarmPausedRecord("old-1", TASK_A, SF_1, "2026-11-13T10:00:00.000Z"));
    const { port } = alarmsPort([declaredAlarm("live-1", TASK_A, SF_2)]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("live-1");
    expect(items[0]?.paused).toBe(false);
  });

  it("P05: the owner's paste shape — 12 rows for two tasks collapse to two rows", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    // Task A: three per-alarm paused records + the canonical record.
    await store.save(perAlarmPausedRecord("a-1", TASK_A, SF_1, "2026-11-13T10:00:00.000Z"));
    await store.save(perAlarmPausedRecord("a-2", TASK_A, SF_2, "2026-11-15T10:00:00.000Z"));
    await store.save(perAlarmPausedRecord("a-3", TASK_A, SF_1, "2026-11-18T10:00:00.000Z"));
    await store.save(canonicalPausedRecord(TASK_A, "2026-11-20T10:00:00.000Z"));
    // Task B: two per-alarm paused records + one live alarm.
    await store.save(perAlarmPausedRecord("b-1", TASK_B, SF_1, "2026-11-14T10:00:00.000Z"));
    await store.save(perAlarmPausedRecord("b-2", TASK_B, SF_2, "2026-11-19T10:00:00.000Z"));
    const { port } = alarmsPort([declaredAlarm("b-live", TASK_B, SF_2)]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual([TASK_A, "b-live"].sort());
  });

  it("distinct user schedules and distinct sweeps still render as separate rows", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port } = alarmsPort([
      userAlarm("user-a", { universe: "SP500" }),
      userAlarm("user-b", { universe: "NASDAQ100" }),
      sweepAlarm("sweep-1", "sweepStaleLedgerTasks", "venus"),
      sweepAlarm("sweep-2", "sweepStaleAsyncJobs"),
    ]);
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(4);
  });
});

describe("5890-P06 the stored row and its live alarm are one row", () => {
  it("collapses the stored sweep record and the live sweep alarm to the stored row", () => {
    const stored: UnifiedScheduleRecord = {
      id: "sweep-stale-ledger-tasks",
      kind: "internal",
      state: "paused",
      callback: "sweepStaleLedgerTasks",
      definition: {
        type: "interval",
        intervalSeconds: 2_592_000,
        callback: "sweepStaleLedgerTasks",
      } as unknown as UnifiedScheduleRecord["definition"],
      ownerLogin: null,
      provenance: { origin: "system", createdBy: "system", reason: "sweep-stale-ledger-tasks", createdAt: NOW_ISO },
      alarmId: null,
      pausedAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    const storedItem = staleLedgerSweepRecordToListItem(stored);
    const live = {
      id: "sdk-sweep-1",
      kind: "screen",
      state: "active",
      callback: "sweepStaleLedgerTasks",
      payload: { userLogin: "venus" },
      type: "interval",
      intervalSeconds: 6 * 60 * 60,
      paused: false,
      nextRun: 1_800_000_000_000,
      source: {
        kind: "sweep-alarm",
        job: "sweepStaleLedgerTasks",
        origin: "OrchestratorAgent interval guard",
        agent: "OrchestratorAgent",
      },
    } as unknown as ReturnType<typeof staleLedgerSweepRecordToListItem>;
    const collapsed = collapseScheduleListItems([live, storedItem]);
    expect(collapsed).toHaveLength(1);
    // The stored record wins: one row, one cadence sentence.
    expect(collapsed[0]?.id).toBe("sweep-stale-ledger-tasks");
    expect(collapsed[0]?.type).toBe("interval");
    expect(collapsed[0]?.intervalSeconds).toBe(2_592_000);
    expect(collapsed[0]?.cron).toBeUndefined();
  });
});

describe("5890-P07/P08 pause merges into the canonical record", () => {
  it("P07: pausing a declared task cancels EVERY live alarm for that task", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled, live } = alarmsPort([
      declaredAlarm("alarm-a-1", TASK_A, SF_1),
      declaredAlarm("alarm-a-2", TASK_A, SF_2),
      declaredAlarm("alarm-b-1", TASK_B, SF_1),
    ]);
    const result = await pauseUnifiedSchedule({ store, alarms: port }, "alarm-a-1", NOW_ISO);
    expect(result.ok).toBe(true);
    expect((await store.get(TASK_A))?.state).toBe("paused");
    // Both occurrences of task A are cancelled; task B is untouched.
    expect(cancelled.sort()).toEqual(["alarm-a-1", "alarm-a-2"].sort());
    expect(live.has("alarm-b-1")).toBe(true);
    expect(await listUnifiedScheduleItems({ store, alarms: port })).toHaveLength(2);
  });

  it("P08: pausing a stale per-alarm row (alarm gone) merges by the record's task id", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(perAlarmPausedRecord("stale-1", TASK_A, SF_1, "2026-11-13T10:00:00.000Z"));
    const { port } = alarmsPort([]);
    const result = await pauseUnifiedSchedule({ store, alarms: port }, "stale-1", NOW_ISO);
    expect(result.ok).toBe(true);
    expect((await store.get(TASK_A))?.state).toBe("paused");
    expect(await store.get("stale-1")).toBeUndefined();
    expect(await listUnifiedScheduleItems({ store, alarms: port })).toHaveLength(1);
  });

  it("P07: pausing a live alarm removes a legacy per-alarm record for the same task", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(perAlarmPausedRecord("legacy-1", TASK_A, SF_1, "2026-11-13T10:00:00.000Z"));
    const { port } = alarmsPort([declaredAlarm("alarm-a-1", TASK_A, SF_2)]);
    const result = await pauseUnifiedSchedule({ store, alarms: port }, "alarm-a-1", NOW_ISO);
    expect(result.ok).toBe(true);
    expect((await store.get(TASK_A))?.state).toBe("paused");
    expect(await store.get("legacy-1")).toBeUndefined();
  });
});

describe("5890-P09 resume moves a per-alarm record under the task id", () => {
  it("resuming a stale per-alarm record re-keys it to the task id", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(perAlarmPausedRecord("stale-1", TASK_A, SF_1, "2026-11-13T10:00:00.000Z"));
    const { port } = alarmsPort([]);
    let reconciled = 0;
    const result = await resumeUnifiedSchedule(
      {
        store,
        alarms: port,
        reconcileDeclared: async () => {
          reconciled += 1;
        },
      },
      "stale-1",
      NOW_ISO,
    );
    expect(result.ok).toBe(true);
    expect(reconciled).toBe(1);
    expect((await store.get(TASK_A))?.state).toBe("active");
    expect(await store.get("stale-1")).toBeUndefined();
  });
});

describe("5890-P10 arm-time hygiene", () => {
  it("the declared-task prune keeps one alarm per (taskId, scheduledFor)", () => {
    const dupes = supersededDeclaredTaskAlarmIds([
      declaredAlarm("a-old", TASK_A, SF_1),
      declaredAlarm("a-new", TASK_A, SF_1),
      declaredAlarm("keep-2", TASK_A, SF_2),
      declaredAlarm("keep-3", TASK_B, SF_1),
    ]);
    // Keeps the most recently armed (last in list order — the one
    // Think's last reconcile most likely tracked); cancels the older twin.
    expect(dupes).toEqual(["a-old"]);
  });

  it("the declared-task prune ignores non-declared callbacks and distinct occurrences", () => {
    expect(
      supersededDeclaredTaskAlarmIds([
        sweepAlarm("s-1", "sweepStaleLedgerTasks", "venus"),
        sweepAlarm("s-2", "sweepStaleLedgerTasks", "venus"),
        declaredAlarm("a-1", TASK_A, SF_1),
        declaredAlarm("a-2", TASK_A, SF_2),
      ]),
    ).toEqual([]);
  });

  it("the guard plan arms only when no match exists, and cancels surplus matches", () => {
    const none = planGuardAlarm([], "sweepStaleLedgerTasks", (p) =>
      (p as { userLogin?: unknown } | null)?.userLogin === "venus",
    );
    expect(none).toEqual({ arm: true, cancelIds: [] });

    const one = planGuardAlarm(
      [sweepAlarm("g-1", "sweepStaleLedgerTasks", "venus")],
      "sweepStaleLedgerTasks",
      (p) => (p as { userLogin?: unknown } | null)?.userLogin === "venus",
    );
    expect(one).toEqual({ arm: false, cancelIds: [] });

    const two = planGuardAlarm(
      [
        sweepAlarm("g-1", "sweepStaleLedgerTasks", "venus"),
        sweepAlarm("g-2", "sweepStaleLedgerTasks", "venus"),
        sweepAlarm("g-3", "sweepStaleLedgerTasks", "other"),
      ],
      "sweepStaleLedgerTasks",
      (p) => (p as { userLogin?: unknown } | null)?.userLogin === "venus",
    );
    // The other user's arm is a different job, not a surplus.
    expect(two).toEqual({ arm: false, cancelIds: ["g-2"] });
  });
});
