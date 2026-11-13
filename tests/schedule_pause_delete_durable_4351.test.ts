/**
 * Issue #4351 (parent #4348, epic #4329) — pause and delete are durable.
 *
 * The incident: a schedule the owner paused came back active after a restart,
 * and a schedule they deleted reappeared. Both are code-declared Think tasks
 * (`_runDeclaredScheduledTask`, taskId `options-strategy-scan-observe`): the
 * declaration is re-evaluated on every boot, so an alarm id-keyed decision
 * never met it. The fix is one rule — the declaration reads the store, and the
 * store keys a declared task by its TASK id.
 *
 * Pins:
 *  - 4351-P01 the task id reader: an alarm and a stored record both resolve to
 *    the declared task id; a user-created schedule resolves to null.
 *  - 4351-P02 pausing a declared alarm stores the decision under the TASK id
 *    (the id the declaration uses), keeps the alarm id for the list join, and
 *    cancels the alarm.
 *  - 4351-P03 the declaration filter drops paused and deleted tasks, keeps
 *    everything else, and fails CLOSED when the store cannot be read.
 *  - 4351-P04 deleting a declared task writes a tombstone instead of forgetting
 *    it: the list hides it, its detail is not found, and the alarm is cancelled.
 *  - 4351-P05 resuming a declared task arms nothing itself: it flips the record
 *    to active and re-runs the declaration (the SDK's reconcile hook).
 *  - 4351-P06 both declarers (the Orchestrator observe task and the pipeline)
 *    go through the one filter — no second declaration path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DECLARED_TASK_CALLBACK,
  declaredTaskIdOf,
  deleteUnifiedSchedule,
  filterUndeclaredTasks,
  getUnifiedScheduleDetail,
  listUnifiedScheduleItems,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
  type ScheduleAlarmLike,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";

const here = dirname(fileURLToPath(import.meta.url));
const observe = readFileSync(
  join(here, "..", "src/agents/orchestrator/scheduledTasksObserve.ts"),
  "utf8",
);
const pipeline = readFileSync(
  join(here, "..", "src/agents/scheduledTasksPipeline.ts"),
  "utf8",
);

const NOW = "2026-11-13T12:00:00.000Z";
const TASK_ID = "options-strategy-scan-observe";
const ALARM_ID = `alarm-${TASK_ID}-1`;

/** One declared Think task's alarm: the SDK's payload carries the task id. */
function declaredAlarm(taskId = TASK_ID): ScheduleAlarmLike {
  return {
    id: `alarm-${taskId}-1`,
    callback: DECLARED_TASK_CALLBACK,
    type: "interval",
    intervalSeconds: 3600,
    payload: { taskId, scheduleHash: "hash-1", scheduledFor: 1_800_000_000_000 },
    nextRun: 1_800_003_600_000,
  };
}

/** An alarms port with the real contract: a cancelled alarm is gone. */
function alarmsPort(
  overrides: {
    list?: () => Promise<ScheduleAlarmLike[]>;
    get?: (id: string) => Promise<ScheduleAlarmLike | undefined>;
    arm?: (...args: unknown[]) => Promise<{ id: string }>;
  } = {},
) {
  const cancelled: string[] = [];
  const armed: unknown[] = [];
  const gone = new Set<string>();
  return {
    cancelled,
    armed,
    port: {
      list: overrides.list ?? (async () => [] as ScheduleAlarmLike[]),
      get: async (id: string) => {
        if (gone.has(id)) return undefined;
        return overrides.get ? overrides.get(id) : undefined;
      },
      cancel: async (id: string) => {
        cancelled.push(id);
        gone.add(id);
        return true;
      },
      arm: async (...args: unknown[]) => {
        armed.push(args);
        return { id: "new-alarm-1" };
      },
    },
  };
}

function record(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: TASK_ID,
    kind: "screen",
    state: "paused",
    callback: DECLARED_TASK_CALLBACK,
    definition: {
      type: "interval",
      intervalSeconds: 3600,
      callback: DECLARED_TASK_CALLBACK,
      payload: { taskId: TASK_ID },
    },
    alarmId: ALARM_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("4351-P01 the declared task id", () => {
  it("reads the task id from an alarm and from a stored record", () => {
    expect(declaredTaskIdOf(declaredAlarm())).toBe(TASK_ID);
    expect(declaredTaskIdOf(record())).toBe(TASK_ID);
  });

  it("is null for a schedule the user created", () => {
    expect(
      declaredTaskIdOf({ id: "s1", callback: "autonomousMarketScreen", payload: { universe: "sp500" } }),
    ).toBeNull();
    expect(declaredTaskIdOf({ callback: DECLARED_TASK_CALLBACK, payload: {} })).toBeNull();
    expect(declaredTaskIdOf(null)).toBeNull();
  });
});

describe("4351-P02 pause keys the decision by task id", () => {
  it("stores the paused record under the task id and cancels the alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled } = alarmsPort({ get: async () => declaredAlarm() });
    const result = await pauseUnifiedSchedule({ store, alarms: port }, ALARM_ID, NOW);
    expect(result.ok).toBe(true);
    // The decision is addressed by the id the declaration reads.
    const stored = await store.get(TASK_ID);
    expect(stored?.state).toBe("paused");
    // The alarm id still rides the record, so the list joins the row.
    expect(stored?.alarmId).toBe(ALARM_ID);
    expect(cancelled).toEqual([ALARM_ID]);
  });
});

describe("4351-P03 the declaration filter", () => {
  const tasks = { "task-a": { schedule: "every 1 hour" }, "task-b": { schedule: "every 1 hour" } };

  it("drops paused and deleted tasks and keeps everything else", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(record({ id: "task-a", state: "paused" }));
    await store.save(record({ id: "task-b", state: "deleted" }));
    expect(await filterUndeclaredTasks(store, tasks)).toEqual({});
  });

  it("declares a task with no record, and one that is active", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(record({ id: "task-b", state: "active" }));
    expect(Object.keys(await filterUndeclaredTasks(store, tasks)).sort()).toEqual([
      "task-a",
      "task-b",
    ]);
  });

  it("fails CLOSED: an unreadable store declares nothing", async () => {
    const store = {
      get: async () => {
        throw new Error("store down");
      },
    };
    expect(await filterUndeclaredTasks(store as never, tasks)).toEqual({});
  });

  it("no store declares as before (a host without DO SQLite)", async () => {
    expect(await filterUndeclaredTasks(null, tasks)).toEqual(tasks);
  });
});

describe("4351-P04 delete leaves a tombstone", () => {
  it("writes state deleted under the task id, hides it, and cancels the alarm", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const { port, cancelled } = alarmsPort({ get: async () => declaredAlarm() });
    const result = await deleteUnifiedSchedule({ store, alarms: port }, ALARM_ID);
    expect(result).toEqual({ ok: true, cancelled: true });
    expect(cancelled).toEqual([ALARM_ID]);
    const tombstone = await store.get(TASK_ID);
    expect(tombstone?.state).toBe("deleted");
    expect(tombstone?.alarmId).toBeNull();
    // The tombstone is not a row: the list never renders it, its detail is gone.
    expect(await listUnifiedScheduleItems({ store, alarms: port })).toEqual([]);
    expect((await getUnifiedScheduleDetail({ store, alarms: port }, TASK_ID)).ok).toBe(false);
  });

  it("still simply removes a schedule the user created", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(
      record({
        id: "user-1",
        callback: "autonomousMarketScreen",
        state: "active",
        definition: { type: "cron", cron: "0 6 * * *", callback: "autonomousMarketScreen" },
        alarmId: "alarm-user-1",
      }),
    );
    const { port } = alarmsPort();
    const result = await deleteUnifiedSchedule({ store, alarms: port }, "user-1");
    expect(result.ok).toBe(true);
    expect(await store.get("user-1")).toBeUndefined();
  });
});

describe("4351-P05 resume re-declares instead of arming", () => {
  it("flips the record to active and runs the declaration", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(record());
    const { port, armed } = alarmsPort();
    let reconciled = 0;
    const result = await resumeUnifiedSchedule(
      {
        store,
        alarms: port,
        reconcileDeclared: async () => {
          reconciled += 1;
        },
      },
      TASK_ID,
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(reconciled).toBe(1);
    // A declared task arms no alarm of its own: the declaration owns the cadence.
    expect(armed).toEqual([]);
    expect((await store.get(TASK_ID))?.state).toBe("active");
  });
});

describe("4351-P06 one declaration path", () => {
  it("both declarers go through the one filter", () => {
    expect(observe).toContain("filterUndeclaredTasks");
    expect(observe).toContain("createUnifiedSchedulePorts");
    expect(pipeline).toContain("filterUndeclaredTasks");
    expect(pipeline).toContain("createUnifiedSchedulePorts");
  });

  it("the schedules route re-reconciles on resume", () => {
    const route = readFileSync(join(here, "..", "src/agents/routes/schedules.ts"), "utf8");
    expect(route).toContain("reconcileDeclared: ctx.reconcileScheduledTasks");
  });
});
