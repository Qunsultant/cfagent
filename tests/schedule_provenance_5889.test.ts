/**
 * Issue #5889 — schedule provenance: every Schedules row shows its source.
 *
 * Pins the server-side source derivation (`resolveScheduleSource`, read
 * through the one list shape `unifiedRecordToListItem` and the merged
 * list `listUnifiedScheduleItems`): every row carries exactly one
 * source — kind + job identity + arming origin — reusing the record's
 * existing provenance field where present, and the #5880 job catalogue
 * as the home of job identity. The Source filter vocabulary and the
 * row vocabulary's Source column are pinned beside it.
 *
 * Display-only: no new store, no new list source, no new identity
 * scheme. Dedupe (#5890), Delete (#5891), wipe/reseed (#5893/#5894)
 * and the NaN cadence (#5896) are out of scope and unpinned here.
 */
import { describe, it, expect } from "vitest";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import {
  DECLARED_TASK_CALLBACK,
  ivHistoryCollectionToRecord,
  listUnifiedScheduleItems,
  nightlyResearchRecordToListItem,
  resolveScheduleSource,
  retentionRecordToListItem,
  scheduleWatchdogRecordToListItem,
  staleAsyncJobSweepRecordToListItem,
  staleLedgerSweepRecordToListItem,
  tickerPushRecordToListItem,
  tickerPushScheduleToRecord,
  tokenRenewalRecordToListItem,
  unifiedRecordToListItem,
  type ScheduleAlarmLike,
} from "../src/services/unifiedScheduleManagement";
import {
  SCHEDULE_SOURCE_FILTER_LABELS,
  SCHEDULE_SOURCE_KIND_IDS,
  isScheduleSourceKind,
  resolveScheduleSourceFilters,
  scheduleSourceAgents,
  scheduleSourceKindOf,
  scheduleSourceWorkflows,
  type ScheduleSourceFilter,
} from "../src/config/scheduleSourceModes";
import {
  SCHEDULE_ROW_COLUMN_LABELS,
  defaultScheduleRowColumns,
  resolveScheduleRowColumns,
} from "../src/config/scheduleRowModes";

const NOW_ISO = "2026-11-21T10:00:00.000Z";

function record(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "rec-1",
    kind: "screen",
    state: "active",
    callback: "autonomousMarketScreen",
    definition: {
      type: "cron",
      callback: "autonomousMarketScreen",
      payload: { universe: "SP500", userLogin: "venus" },
      cron: "5 * * * *",
    },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function userProvenance(createdBy = "venus") {
  return { origin: "user", createdBy, createdAt: NOW_ISO };
}

function agentProvenance(agentId: string, createdBy = "venus") {
  return { origin: "agent", createdBy, agentId, createdAt: NOW_ISO };
}

function systemProvenance(reason: string) {
  return { origin: "system", createdBy: "system", reason, createdAt: NOW_ISO };
}

/** An alarms port with the real contract: a cancelled alarm is gone. */
function alarmsPort(
  overrides: {
    list?: () => Promise<ScheduleAlarmLike[]>;
    get?: (id: string) => Promise<ScheduleAlarmLike | undefined>;
  } = {},
) {
  return {
    list: overrides.list ?? (async () => [] as ScheduleAlarmLike[]),
    get: async (id: string) => (overrides.get ? overrides.get(id) : undefined),
    cancel: async () => true,
    arm: async () => ({ id: "new-alarm-1" }),
  };
}

describe("5889 source derivation — stored system records (#4239–#4242, #6503)", () => {
  /** A stored system row, as the seed creates it (paused, monthly interval). */
  function storedSystemRecord(
    id: string,
    callback: string,
  ): UnifiedScheduleRecord {
    return {
      id,
      kind: "internal",
      state: "paused",
      callback,
      definition: {
        type: "interval",
        intervalSeconds: 2_592_000,
        callback,
      } as unknown as UnifiedScheduleRecord["definition"],
      ownerLogin: null,
      provenance: { origin: "system", createdBy: "system", reason: id, createdAt: NOW_ISO },
      alarmId: null,
      pausedAt: NOW_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
  }

  it("the token-renewal row is System, job token-renewal, system origin", () => {
    const item = tokenRenewalRecordToListItem(
      storedSystemRecord("token-renewal", "autoRenewETradeTokens"),
    );
    expect(item.source?.kind).toBe("system");
    expect(item.source?.job).toBe("token-renewal");
    expect(item.source?.origin).toMatch(/system/i);
    // The record's provenance rides the list item, not just the derivation.
    expect(item.provenance).toEqual(systemProvenance("token-renewal"));
  });

  it("the retention row is System, job retention", () => {
    const item = retentionRecordToListItem(
      storedSystemRecord("retention", "retention"),
    );
    expect(item.source?.kind).toBe("system");
    expect(item.source?.job).toBe("retention");
  });

  it("the nightly-research row is System, job nightly-research", () => {
    const item = nightlyResearchRecordToListItem(
      storedSystemRecord("nightly-research", "runResearchSchedule"),
    );
    expect(item.source?.kind).toBe("system");
    expect(item.source?.job).toBe("nightly-research");
  });

  it("the three sweep/watchdog rows are Sweep alarm by callback, not by record id", () => {
    // The sweep-alarm rule precedes provenance: a stored sweep
    // record resolves by its callback (the duty), with the
    // OrchestratorAgent interval guard as its origin.
    const ledger = staleLedgerSweepRecordToListItem(
      storedSystemRecord("sweep-stale-ledger-tasks", "sweepStaleLedgerTasks"),
    );
    expect(ledger.source).toMatchObject({
      kind: "sweep-alarm",
      job: "sweepStaleLedgerTasks",
      agent: "OrchestratorAgent",
    });
    const asyncJobs = staleAsyncJobSweepRecordToListItem(
      storedSystemRecord("sweep-stale-async-jobs", "sweepStaleAsyncJobs"),
    );
    expect(asyncJobs.source).toMatchObject({
      kind: "sweep-alarm",
      job: "sweepStaleAsyncJobs",
      agent: "OrchestratorAgent",
    });
    const watchdog = scheduleWatchdogRecordToListItem(
      storedSystemRecord("schedule-watchdog", "watchdogMissedSchedules"),
    );
    expect(watchdog.source).toMatchObject({
      kind: "sweep-alarm",
      job: "watchdogMissedSchedules",
      agent: "OrchestratorAgent",
    });
  });

  it("the IV collection row is System by its provenance reason, not its alarm id", () => {
    const built = ivHistoryCollectionToRecord(
      {
        id: "iv-1",
        callback: "collectIvHistory",
        type: "cron",
        cron: "15 22 * * 1-5",
        payload: { userLogin: "venus" },
      },
      { userLogin: "venus", cron: "15 22 * * 1-5" },
      NOW_ISO,
    );
    const item = unifiedRecordToListItem(built);
    expect(item.source?.kind).toBe("system");
    expect(item.source?.job).toBe("iv-history-collection");
  });
});

describe("5889 source derivation — alarms and records in the merged list", () => {
  it("a declared-task alarm is a Declared task, job is the task id, agent OrchestratorAgent", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const port = alarmsPort({
      list: async () => [
        {
          id: "alarm-declared-1",
          callback: DECLARED_TASK_CALLBACK,
          type: "scheduled",
          time: Date.parse("2026-11-21T11:00:00.000Z") / 1000,
          payload: {
            taskId: "options-strategy-scan-observe",
            scheduleHash: "1cc4bdea8e8b678cdc2258188071a26f",
            scheduledFor: "2026-11-21T11:00:00.000Z",
          },
        },
      ],
    });
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toMatchObject({
      kind: "declared-task",
      job: "options-strategy-scan-observe",
      agent: "OrchestratorAgent",
    });
    expect(items[0]?.source?.origin).toMatch(/OrchestratorAgent/);
  });

  it("a sweep interval alarm is a Sweep alarm — the same job as the stored row, a different row", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    const port = alarmsPort({
      list: async () => [
        {
          id: "alarm-sweep-1",
          callback: "sweepStaleLedgerTasks",
          type: "interval",
          intervalSeconds: 6 * 3600,
          payload: { userLogin: "venus" },
        },
      ],
    });
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(1);
    // The job names the duty (the callback), never the stored
    // record's id: this alarm is not the stored row.
    expect(items[0]?.source).toMatchObject({
      kind: "sweep-alarm",
      job: "sweepStaleLedgerTasks",
      agent: "OrchestratorAgent",
    });
  });

  it("a ticker-push row is Ticker push, agent TickerAgent", () => {
    const item = tickerPushRecordToListItem(
      tickerPushScheduleToRecord(
        { intervalSeconds: 3000, armed: true, lastPushAt: "2026-11-21T09:55:00.000Z" },
        NOW_ISO,
      ),
      Date.parse(NOW_ISO),
      2,
    );
    expect(item.source).toMatchObject({
      kind: "ticker-push",
      job: "ticker-push",
      agent: "TickerAgent",
    });
  });

  it("a workflow-stage row is Workflow, job and workflow are the job id", () => {
    const item = unifiedRecordToListItem(
      record({
        id: "alarm-1",
        kind: "workflow-stage",
        callback: "runWorkflowStage",
        definition: {
          type: "cron",
          callback: "runWorkflowStage",
          payload: { jobId: "two-child", nodePath: "0", stageId: "job:0" },
          cron: "0 21 * * *",
          jobId: "two-child",
          stageId: "job:0",
        },
      }),
    );
    expect(item.source).toMatchObject({
      kind: "workflow",
      job: "two-child",
      workflow: "two-child",
    });
  });

  it("a pipeline-job row is Pipeline job, job is the jobdef id", () => {
    const item = unifiedRecordToListItem(
      record({
        id: "pipe-1",
        callback: "runPipelineJobSchedule",
        definition: {
          type: "cron",
          callback: "runPipelineJobSchedule",
          payload: {
            jobId: "jobdef:screener:2026-11-14T06:37:24.660Z",
            provenance: userProvenance(),
          },
          cron: "0 6 * * *",
          jobId: "jobdef:screener:2026-11-14T06:37:24.660Z",
        },
      }),
    );
    expect(item.source).toMatchObject({
      kind: "pipeline-job",
      job: "jobdef:screener:2026-11-14T06:37:24.660Z",
    });
  });
});

describe("5889 source derivation — provenance and the fallbacks", () => {
  it("a user-stamped screen is User-created and names its creator", () => {
    const item = unifiedRecordToListItem(
      record({
        definition: {
          type: "cron",
          callback: "autonomousMarketScreen",
          payload: { universe: "SP500", provenance: userProvenance("venus") },
          cron: "5 * * * *",
        },
      }),
    );
    expect(item.source).toMatchObject({ kind: "user-created", job: "autonomousMarketScreen" });
    expect(item.source?.origin).toContain("venus");
    expect(item.provenance).toEqual(userProvenance("venus"));
  });

  it("an agent-stamped schedule is Agent-created and names the acting agent", () => {
    const item = unifiedRecordToListItem(
      record({
        definition: {
          type: "cron",
          callback: "autonomousMarketScreen",
          payload: { universe: "SP500", provenance: agentProvenance("nlq") },
          cron: "5 * * * *",
        },
      }),
    );
    expect(item.source).toMatchObject({ kind: "agent-created", agent: "nlq" });
    expect(item.source?.origin).toContain("nlq");
  });

  it("a system-stamped baseline is System and names its reason", () => {
    const item = unifiedRecordToListItem(
      record({
        callback: "autonomousOptionsAnalysis",
        provenance: systemProvenance("strategy-scan-baseline"),
        definition: {
          type: "cron",
          callback: "autonomousOptionsAnalysis",
          payload: { provenance: systemProvenance("strategy-scan-baseline") },
          cron: "35 * * * *",
        },
      }),
    );
    expect(item.source).toMatchObject({ kind: "system", job: "autonomousOptionsAnalysis" });
    expect(item.source?.origin).toContain("strategy-scan-baseline");
  });

  it("a seeded built-in goal is Seeded, agent ScheduledAgent", () => {
    const source = resolveScheduleSource({
      id: "daily-qa-sweep",
      kind: "goal",
      operation: "qa.run_sweep",
      definition: {},
    });
    expect(source).toMatchObject({
      kind: "seeded",
      job: "daily-qa-sweep",
      agent: "ScheduledAgent",
    });
  });

  it("a worker-duty row is Worker duty, origin names the disabled Worker cron", () => {
    const source = resolveScheduleSource({
      id: "worker-duty:0 3 * * *",
      kind: "worker-duty",
      callback: "renewTokens",
      definition: { cron: "0 3 * * *", entryPoint: "renewTokens" },
    });
    expect(source).toMatchObject({ kind: "worker-duty", job: "worker-duty:0 3 * * *" });
    expect(source.origin).toMatch(/disabled/i);
  });

  it("a legacy row with no provenance is Unknown — never a fabricated source", () => {
    const item = unifiedRecordToListItem(record());
    expect(item.source?.kind).toBe("unknown");
    expect(item.source?.job).toBe("autonomousMarketScreen");
    expect(item.source?.origin).toBe("not recorded");
    expect(item.provenance).toBeUndefined();
  });

  it("every row the merged list returns carries exactly one source", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    store.save(record({ id: "user-1" }));
    store.save(
      record({
        id: "agent-1",
        definition: {
          type: "interval",
          callback: "autonomousOptionsAnalysis",
          payload: { provenance: agentProvenance("nlq") },
          intervalSeconds: 3600,
        },
      }),
    );
    const port = alarmsPort({
      list: async () => [
        { id: "user-1", callback: "autonomousMarketScreen", type: "cron", cron: "5 * * * *", payload: {} },
        { id: "agent-1", callback: "autonomousOptionsAnalysis", type: "interval", intervalSeconds: 3600, payload: {} },
      ],
    });
    const items = await listUnifiedScheduleItems({ store, alarms: port });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(isScheduleSourceKind(item.source?.kind)).toBe(true);
      expect(typeof item.source?.job).toBe("string");
      expect(item.source?.job.length).toBeGreaterThan(0);
      expect(typeof item.source?.origin).toBe("string");
      expect(item.source?.origin.length).toBeGreaterThan(0);
    }
  });
});

describe("5889 source filter vocabulary (src/config/scheduleSourceModes.ts)", () => {
  it("the default filters are every source kind plus the Cron timing slice", () => {
    const filters = resolveScheduleSourceFilters();
    expect(filters[0]).toBe("all");
    for (const kind of SCHEDULE_SOURCE_KIND_IDS) expect(filters).toContain(kind);
    expect(filters).toContain("cron");
    expect(filters[filters.length - 1]).toBe("cron");
  });

  it("every kind and the Cron slice has a label", () => {
    for (const kind of SCHEDULE_SOURCE_KIND_IDS) {
      expect(SCHEDULE_SOURCE_FILTER_LABELS[kind]).toBeTruthy();
    }
    expect(SCHEDULE_SOURCE_FILTER_LABELS.cron).toBe("Cron");
  });

  it("the env seam narrows the buttons, never invents one", () => {
    expect(
      resolveScheduleSourceFilters({ SCHEDULE_SOURCE_FILTERS: "seeded,unknown" }),
    ).toEqual(["all", "seeded", "unknown"]);
    expect(resolveScheduleSourceFilters({ SCHEDULE_SOURCE_FILTERS: " , " })).toEqual(
      resolveScheduleSourceFilters(),
    );
  });

  it("a missing source reads as Unknown for matching and display", () => {
    expect(scheduleSourceKindOf({} as never)).toBe("unknown");
    // Issue #6503 step 14 — `derived` left the vocabulary: a legacy
    // row that still names it reads as Unknown, never as a filter
    // the home can no longer show.
    expect(scheduleSourceKindOf({ source: { kind: "derived", job: "x", origin: "y" } } as never)).toBe(
      "unknown",
    );
  });

  it("the per-agent and per-workflow values come from the rows that name them", () => {
    const rows = [
      { source: { kind: "declared-task", job: "t1", origin: "o", agent: "OrchestratorAgent" } },
      { source: { kind: "ticker-push", job: "ticker-push", origin: "o", agent: "TickerAgent" } },
      { source: { kind: "workflow", job: "w1", origin: "o", workflow: "w1" } },
      { source: { kind: "workflow", job: "w1", origin: "o", workflow: "w1" } },
      { source: { kind: "user-created", job: "s", origin: "o" } },
    ] as never[];
    expect(scheduleSourceAgents(rows)).toEqual(["OrchestratorAgent", "TickerAgent"]);
    expect(scheduleSourceWorkflows(rows)).toEqual(["w1"]);
  });
});

describe("5889 Source column in the row vocabulary (src/config/scheduleRowModes.ts)", () => {
  it("the list carries Source after the identity columns, before Status", () => {
    expect(SCHEDULE_ROW_COLUMN_LABELS.source).toBe("Source");
    expect(resolveScheduleRowColumns("list")).toEqual([
      "schedule",
      "id",
      "cadence",
      "source",
      "status",
      "scope",
      "actions",
    ]);
    expect(defaultScheduleRowColumns("list")).toEqual([
      "schedule",
      "id",
      "cadence",
      "source",
      "status",
      "scope",
      "actions",
    ]);
  });

  it("the goals and queue surfaces are untouched", () => {
    expect(resolveScheduleRowColumns("goals")).toEqual([
      "schedule",
      "id",
      "cadence",
      "operation",
      "budget",
      "lastRun",
      "provenance",
      "actions",
    ]);
    expect(resolveScheduleRowColumns("queue")).toEqual([
      "schedule",
      "id",
      "cadence",
      "scope",
      "status",
    ]);
  });
});

export type { ScheduleSourceFilter };
