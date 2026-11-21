/**
 * Issue #5878 — bulk pause / resume / run-now, in bulk and per category.
 *
 * Service-level pins for the three bulk verbs
 * (`pauseSchedulesInScope` / `resumeSchedulesInScope` /
 * `triggerSchedulesInScope`): one service function per verb taking a
 * scope (`all` | kind), reusing the single-row
 * `pauseUnifiedSchedule` / `resumeUnifiedSchedule` /
 * `triggerUnifiedSchedule` per row, so the refusal and audit
 * behaviour is identical to the single-row path. A bulk verb reports
 * per-row outcomes (applied / already-in-state / refused-with-reason)
 * and never fails the whole batch on one refusal.
 */
import { describe, it, expect } from "vitest";
import {
  pauseSchedulesInScope,
  pauseUnifiedSchedule,
  resumeSchedulesInScope,
  triggerSchedulesInScope,
  isBulkScheduleScope,
  type BulkScheduleRow,
} from "../src/services/unifiedScheduleManagement";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";

const NOW = "2026-11-21T10:00:00.000Z";
const EARLIER = "2026-11-21T08:00:00.000Z";

function stockRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "sched-stocks",
    kind: "screen",
    state: "active",
    callback: "autonomousMarketScreen",
    definition: {
      type: "cron",
      callback: "autonomousMarketScreen",
      cron: "30 7 * * 1-5",
      payload: { universe: "NASDAQ100" },
    },
    alarmId: "alarm-stocks",
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function optionsRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "sched-options",
    kind: "screen",
    state: "active",
    callback: "autonomousOptionsAnalysis",
    definition: {
      type: "interval",
      callback: "autonomousOptionsAnalysis",
      intervalSeconds: 3600,
      payload: { symbols: ["AAPL"] },
    },
    alarmId: "alarm-options",
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function pausedRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "sched-paused",
    kind: "screen",
    state: "paused",
    callback: "autonomousMarketScreen",
    definition: {
      type: "cron",
      callback: "autonomousMarketScreen",
      cron: "0 14 * * 1-5",
      payload: { universe: "SP500" },
    },
    alarmId: "alarm-paused",
    pausedAt: EARLIER,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function goalRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "goal-1",
    kind: "goal",
    state: "active",
    operation: "test.op",
    definition: {
      id: "goal-1",
      name: "Test goal",
      cron: "0 6 * * *",
      operation: "test.op",
      budgetCents: 1,
      enabled: true,
    },
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

/** The rows the Schedules home list carries for the seeded records. */
function rows(): BulkScheduleRow[] {
  return [
    { id: "sched-stocks", callback: "autonomousMarketScreen", type: "cron", payload: { universe: "NASDAQ100" }, paused: false },
    { id: "sched-options", callback: "autonomousOptionsAnalysis", type: "interval", payload: { symbols: ["AAPL"] }, paused: false },
    { id: "sched-paused", callback: "autonomousMarketScreen", type: "cron", payload: { universe: "SP500" }, paused: true },
    { id: "goal-1", callback: "goalScreen", type: "cron", payload: {}, paused: false },
    { id: "token-renewal", callback: "autoRenewETradeTokens", type: "cron", paused: false },
    { id: "ticker-push", callback: "pushTicks", type: "interval", paused: false },
  ];
}

function makeAlarms() {
  let seq = 100;
  const live = new Map<string, any>([
    ["alarm-stocks", { id: "alarm-stocks", callback: "autonomousMarketScreen", type: "cron", cron: "30 7 * * 1-5", payload: { universe: "NASDAQ100" } }],
    ["alarm-options", { id: "alarm-options", callback: "autonomousOptionsAnalysis", type: "interval", intervalSeconds: 3600, payload: { symbols: ["AAPL"] } }],
  ]);
  return {
    live,
    list: async () => [...live.values()],
    get: async (id: string) => live.get(id),
    cancel: async (id: string) => live.delete(id),
    arm: async (timing: any, callback: string, payload: unknown) => {
      const alarm = { id: `alarm-new-${++seq}`, callback, ...timing, payload };
      live.set(alarm.id, alarm);
      return alarm;
    },
  };
}

async function seeded() {
  const store = new InMemoryUnifiedScheduleStore();
  await store.save(stockRecord());
  await store.save(optionsRecord());
  await store.save(pausedRecord());
  await store.save(goalRecord());
  const alarms = makeAlarms();
  return { store, alarms };
}

describe("isBulkScheduleScope (#5878)", () => {
  it("accepts all and every filter kind, rejects anything else", () => {
    expect(isBulkScheduleScope("all")).toBe(true);
    for (const kind of ["stocks", "options", "strategy", "goal", "payment", "trading", "system", "queued", "other"]) {
      expect(isBulkScheduleScope(kind)).toBe(true);
    }
    expect(isBulkScheduleScope("bogus")).toBe(false);
    expect(isBulkScheduleScope("")).toBe(false);
    expect(isBulkScheduleScope(undefined)).toBe(false);
    expect(isBulkScheduleScope(null)).toBe(false);
    expect(isBulkScheduleScope(42)).toBe(false);
  });
});

describe("pauseSchedulesInScope (#5878)", () => {
  it("pauses every in-scope row, reports already-paused and refusals per row, never fails the batch", async () => {
    const { store, alarms } = await seeded();
    const summary = await pauseSchedulesInScope({ store, alarms }, "all", rows(), NOW);
    expect(summary.verb).toBe("pause");
    expect(summary.scope).toBe("all");
    expect(summary.total).toBe(6);
    expect(summary.applied).toBe(2);
    expect(summary.already).toBe(1);
    expect(summary.refused).toBe(3);
    expect(summary.results.map((r) => [r.id, r.outcome])).toEqual([
      ["sched-stocks", "paused"],
      ["sched-options", "paused"],
      ["sched-paused", "already-paused"],
      ["goal-1", "refused"],
      ["token-renewal", "refused"],
      ["ticker-push", "refused"],
    ]);
    // The per-row kinds are the filter kinds the home classifies by.
    expect(summary.results.map((r) => [r.id, r.kind])).toEqual([
      ["sched-stocks", "stocks"],
      ["sched-options", "options"],
      ["sched-paused", "stocks"],
      ["goal-1", "goal"],
      ["token-renewal", "system"],
      ["ticker-push", "system"],
    ]);
    // Refusals carry the single-row reason, verbatim.
    const byId = Object.fromEntries(summary.results.map((r) => [r.id, r]));
    expect(byId["goal-1"].reason).toContain("goals surface");
    expect(byId["token-renewal"].reason).toContain("derived record");
    expect(byId["ticker-push"].reason).toContain("not found");
    // The applied rows really paused (alarms cancelled, records paused).
    expect((await store.get("sched-stocks"))?.state).toBe("paused");
    expect((await store.get("sched-options"))?.state).toBe("paused");
    expect(alarms.live.has("alarm-stocks")).toBe(false);
    expect(alarms.live.has("alarm-options")).toBe(false);
  });

  it("pauses only the named kind for a per-category scope", async () => {
    const { store, alarms } = await seeded();
    const summary = await pauseSchedulesInScope({ store, alarms }, "options", rows(), NOW);
    expect(summary.total).toBe(1);
    expect(summary.applied).toBe(1);
    expect(summary.results).toEqual([
      { id: "sched-options", kind: "options", outcome: "paused" },
    ]);
    expect((await store.get("sched-stocks"))?.state).toBe("active");
    expect(alarms.live.has("alarm-stocks")).toBe(true);
  });

  it("reports a goal scope as refused, never as paused", async () => {
    const { store, alarms } = await seeded();
    const summary = await pauseSchedulesInScope({ store, alarms }, "goal", rows(), NOW);
    expect(summary.total).toBe(1);
    expect(summary.applied).toBe(0);
    expect(summary.refused).toBe(1);
    expect(summary.results[0].outcome).toBe("refused");
    expect(summary.results[0].reason).toContain("goals surface");
  });

  it("reports the system scope's derived rows as refused, not as paused", async () => {
    const { store, alarms } = await seeded();
    const summary = await pauseSchedulesInScope({ store, alarms }, "system", rows(), NOW);
    expect(summary.total).toBe(2);
    expect(summary.applied).toBe(0);
    expect(summary.refused).toBe(2);
    expect(summary.results.map((r) => r.id)).toEqual(["token-renewal", "ticker-push"]);
    expect(summary.results[0].reason).toContain("derived record");
  });

  it("reports an empty scope as zero rows, not an error", async () => {
    const { store, alarms } = await seeded();
    const summary = await pauseSchedulesInScope({ store, alarms }, "payment", rows(), NOW);
    expect(summary).toEqual({
      verb: "pause",
      scope: "payment",
      total: 0,
      applied: 0,
      already: 0,
      refused: 0,
      results: [],
    });
  });

  it("isolates a per-row failure: one row's alarm error refuses only that row", async () => {
    const { store, alarms } = await seeded();
    const failingAlarms = {
      ...alarms,
      cancel: async (id: string) => {
        if (id === "alarm-options") throw new Error("cancel boom");
        return alarms.live.delete(id);
      },
    };
    const summary = await pauseSchedulesInScope({ store, alarms: failingAlarms }, "all", rows(), NOW);
    expect(summary.results.find((r) => r.id === "sched-stocks")?.outcome).toBe("paused");
    const options = summary.results.find((r) => r.id === "sched-options");
    expect(options?.outcome).toBe("refused");
    expect(options?.reason).toContain("cancel boom");
    expect(summary.applied).toBe(1);
  });

  it("hands the live-feed row to the executor, and maps its already flag", async () => {
    const { store, alarms } = await seeded();
    const handled: string[] = [];
    const summary = await pauseSchedulesInScope({ store, alarms }, "all", rows(), NOW, async (row) => {
      if (row.id !== "ticker-push") return undefined;
      handled.push(row.id);
      return { ok: true };
    });
    expect(handled).toEqual(["ticker-push"]);
    expect(summary.results.find((r) => r.id === "ticker-push")?.outcome).toBe("paused");
    expect(summary.applied).toBe(3);

    const already = await pauseSchedulesInScope({ store, alarms }, "system", rows(), NOW, async (row) => {
      if (row.id !== "ticker-push") return undefined;
      return { ok: true, already: true };
    });
    expect(already.results.find((r) => r.id === "ticker-push")?.outcome).toBe("already-paused");
    expect(already.already).toBe(1);
  });
});

describe("resumeSchedulesInScope (#5878)", () => {
  it("resumes paused rows, reports active rows as already-active, refuses derived and goal rows", async () => {
    const { store, alarms } = await seeded();
    // Pause one active row first so the batch has two paused rows.
    await pauseUnifiedSchedule({ store, alarms }, "sched-stocks", NOW);
    const summary = await resumeSchedulesInScope({ store, alarms }, "all", rows(), NOW);
    expect(summary.total).toBe(6);
    expect(summary.applied).toBe(2);
    expect(summary.already).toBe(1);
    expect(summary.refused).toBe(3);
    expect(summary.results.map((r) => [r.id, r.outcome])).toEqual([
      ["sched-stocks", "resumed"],
      ["sched-options", "already-active"],
      ["sched-paused", "resumed"],
      ["goal-1", "refused"],
      ["token-renewal", "refused"],
      ["ticker-push", "refused"],
    ]);
    expect((await store.get("sched-stocks"))?.state).toBe("active");
    expect((await store.get("sched-paused"))?.state).toBe("active");
    expect(summary.results.find((r) => r.id === "goal-1")?.reason).toContain("goals surface");
    expect(summary.results.find((r) => r.id === "token-renewal")?.reason).toContain("derived record");
  });
});

describe("triggerSchedulesInScope (#5878)", () => {
  it("triggers active rows, refuses paused / derived / goal rows with the single-row reasons", async () => {
    const { store, alarms } = await seeded();
    const runs: Array<{ callback: string; payload: unknown }> = [];
    const summary = await triggerSchedulesInScope({ store, alarms }, "all", rows(), async (callback, payload) => {
      runs.push({ callback, payload });
    });
    expect(summary.total).toBe(6);
    expect(summary.applied).toBe(2);
    expect(summary.refused).toBe(4);
    expect(summary.results.map((r) => [r.id, r.outcome])).toEqual([
      ["sched-stocks", "triggered"],
      ["sched-options", "triggered"],
      ["sched-paused", "refused"],
      ["goal-1", "refused"],
      ["token-renewal", "refused"],
      ["ticker-push", "refused"],
    ]);
    expect(runs.map((r) => r.callback).sort()).toEqual([
      "autonomousMarketScreen",
      "autonomousOptionsAnalysis",
    ]);
    expect(summary.results.find((r) => r.id === "sched-paused")?.reason).toContain("paused");
    expect(summary.results.find((r) => r.id === "goal-1")?.reason).toContain("goals surface");
    expect(summary.results.find((r) => r.id === "token-renewal")?.reason).toContain("derived record");
  });

  it("triggers only the named kind for a per-category scope", async () => {
    const { store, alarms } = await seeded();
    const runs: string[] = [];
    const summary = await triggerSchedulesInScope({ store, alarms }, "stocks", rows(), async (callback) => {
      runs.push(callback);
    });
    expect(summary.total).toBe(2);
    expect(summary.applied).toBe(1);
    expect(summary.refused).toBe(1);
    expect(runs).toEqual(["autonomousMarketScreen"]);
  });
});
