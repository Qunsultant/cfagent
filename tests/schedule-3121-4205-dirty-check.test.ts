/**
 * Issue #4205 — tick dirty-check saves: `saveGoals` re-saves EVERY
 * goal on EVERY tick (one DELETE + INSERT pair per goal). This slice
 * saves only goals whose persisted fields changed since load.
 *
 * RED first: the write-count pins fail until the dirty check lands.
 * Pins assert accounting — write execs, not literal sizes (gitops
 * §5, #3917) — and the behavior pins from #3124 that the check must
 * not break (lastRun stamping, createdAt preservation, removal sync,
 * one scan per flow).
 *
 * - 4205-P01 tick writes nothing when nothing changed: a tick over
 *   not-due goals costs one scan and zero write execs.
 * - 4205-P02 tick writes only the changed goal: a due goal fires and
 *   its stamp persists; untouched goals are not re-written.
 * - 4205-P03 mutations write only their goal: add / setEnabled write
 *   one goal; remove deletes the removed row and writes nothing else.
 * - 4205-P04 no-snapshot fallback still re-lists, and still skips
 *   unchanged goals; removal sync unchanged.
 * - 4205-P05 trigger saves only the triggered goal: a firing
 *   trigger costs one scan and one save of that goal; and a second
 *   save with the same snapshot (the triggerGoal restore shape —
 *   stamp, then reset lastRun) still writes, because the first save
 *   refreshes the snapshot it compares against.
 * - 4205-P06 comparator: equal except updatedAt is unchanged; any
 *   persisted-field change (lastRun, cron, enabled/state, operation)
 *   is a change.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/orchestrate", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    OPERATION_CATALOG: [
      {
        agent: "test",
        binding: "SCHEDULED_AGENT",
        operations: ["test.op", "index.refresh_holdings"],
        blurb: "",
      },
    ],
    createJob: vi.fn(async (_env: any, req: any) => ({
      jobId: "job_test_1",
      ...req,
      status: "pending",
    })),
  };
});

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: vi.fn(),
}));
vi.mock("../src/security/storageRetention", () => ({
  runStorageRetention: vi.fn(),
}));
vi.mock("../src/security/etradeOAuth", () => ({
  getStoredTokens: vi.fn(),
  isTokenExpiredEt: vi.fn(() => false),
}));

import type { SqlStorage } from "../src/orm";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import {
  goalToRecord,
  isUnchangedGoalRecord,
} from "../src/services/unifiedScheduleManagement";
import { ScheduledAgent } from "../src/agents/scheduled-agent";

/** node:sqlite double for the SqlStorage seam (same shape as #2964). */
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

/**
 * Counting wrapper: kind scans plus the write execs a save costs.
 * One `store.save` is a DELETE + INSERT pair (2 write execs); a
 * removal-sync delete is 1 delete with no insert.
 */
class CountingStorage implements SqlStorage {
  kindScan = 0;
  deletes = 0;
  inserts = 0;
  constructor(private inner: SqliteTestStorage) {}
  get sqlite(): DatabaseSync {
    return this.inner.sqlite;
  }
  get writeExecs(): number {
    return this.deletes + this.inserts;
  }
  reset(): void {
    this.kindScan = 0;
    this.deletes = 0;
    this.inserts = 0;
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const q = query.replace(/\s+/g, " ");
    if (/SELECT \* FROM unified_schedules WHERE kind/.test(q)) this.kindScan++;
    else if (/^DELETE FROM unified_schedules WHERE id = \?$/.test(q)) this.deletes++;
    else if (/^INSERT INTO unified_schedules/.test(q)) this.inserts++;
    return this.inner.exec(query, ...params);
  }
}

function makeEnv() {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
  } as any;
}

/** A SQL-backed agent whose store scans and writes are counted. */
function makeCountedAgent() {
  const counting = new CountingStorage(new SqliteTestStorage());
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => (kv.has(k) ? kv.get(k) : undefined),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      sql: counting as never,
    },
  };
  const agent = new (ScheduledAgent as any)(ctx, makeEnv());
  const store = new SqlUnifiedScheduleStore(counting as never);
  return { agent, kv, counting, store };
}

function testGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-goal",
    name: "Test goal",
    cron: "0 6 * * *",
    operation: "test.op",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("4205-P01 tick writes nothing when nothing changed", () => {
  it("a tick over not-due goals costs one scan and zero write execs", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(3);
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors).toEqual([]);
    expect(counting.kindScan).toBe(1);
    expect(counting.writeExecs).toBe(0);
    expect(counting.deletes).toBe(0);
    expect(counting.inserts).toBe(0);
    const goals = await agent.listGoals();
    expect(goals.map((g: any) => g.lastRun)).toEqual([nowIso, nowIso, nowIso]);
  });
});

describe("4205-P02 tick writes only the changed goal", () => {
  it("a due goal fires and persists its stamp; untouched goals are not re-written", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    const createdAt = "2026-11-01T06:00:00.000Z";
    // Due goal with an older stored createdAt: the re-save must keep
    // it, never reshuffle order — and must stamp lastRun.
    store.save({
      ...goalToRecord(testGoal({ id: "due", lastRun: null }) as any),
      createdAt,
      updatedAt: createdAt,
    });
    for (let i = 0; i < 2; i++) {
      store.save(goalToRecord(testGoal({ id: `quiet-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(3);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(counting.kindScan).toBe(1);
    // Exactly one save: the fired goal's DELETE + INSERT pair.
    expect(counting.writeExecs).toBe(2);
    expect(counting.deletes).toBe(1);
    expect(counting.inserts).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "due")?.lastRun).toBe("2026-11-03T06:00:00.000Z");
    expect(goals.find((g: any) => g.id === "quiet-0")?.lastRun).toBe(nowIso);
    expect(goals.find((g: any) => g.id === "quiet-1")?.lastRun).toBe(nowIso);
    expect(store.listByKind("goal").find((r) => r.id === "due")?.createdAt).toBe(createdAt);
  });
});

describe("4205-P03 mutations write only their goal", () => {
  it("setGoalEnabled persists the toggle and writes only that goal", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const ok = await agent.setGoalEnabled("goal-1", false);
    expect(ok).toBe(true);
    expect(counting.kindScan).toBe(1);
    expect(counting.writeExecs).toBe(2);
    expect(counting.deletes).toBe(1);
    expect(counting.inserts).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "goal-1")?.enabled).toBe(false);
    expect(goals.find((g: any) => g.id === "goal-0")?.enabled).toBe(true);
  });

  it("addGoal writes only the new goal", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    store.save(goalToRecord(testGoal({ id: "seed-goal", lastRun: nowIso }) as any));
    counting.reset();
    const created = await agent.addGoal(testGoal({ id: "added" }));
    expect(created.id).toBe("added");
    expect(counting.kindScan).toBe(1);
    expect(counting.writeExecs).toBe(2);
    expect(counting.deletes).toBe(1);
    expect(counting.inserts).toBe(1);
  });

  it("removeGoal deletes the removed row and writes nothing else", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const ok = await agent.removeGoal("goal-1");
    expect(ok).toBe(true);
    expect(counting.kindScan).toBe(1);
    // Removal sync only: one DELETE, no INSERT for the kept goals.
    expect(counting.deletes).toBe(1);
    expect(counting.inserts).toBe(0);
    expect(store.listByKind("goal").map((r) => r.id).sort()).toEqual(["goal-0", "goal-2"]);
  });
});

describe("4205-P04 no-snapshot fallback still re-lists, still skips unchanged goals", () => {
  it("saveGoals with no snapshot re-lists, removes the dropped row, and does not re-save the kept goal", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ id: "keep" }) as any));
    store.save(goalToRecord(testGoal({ id: "drop" }) as any));
    const goals = await agent.listGoals();
    const kept = goals.filter((g: any) => g.id === "keep");
    counting.reset();
    await (agent as any).saveGoals(kept);
    // No snapshot passed: the fallback re-list finds "drop" in the
    // store and deletes it — removal sync preserved.
    expect(counting.kindScan).toBe(1);
    expect(counting.deletes).toBe(1);
    // The kept goal is unchanged: no re-save pair.
    expect(counting.inserts).toBe(0);
    expect(store.listByKind("goal").map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("4205-P05 trigger saves only the triggered goal", () => {
  it("triggering a goal that fires costs one scan and one save of that goal", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    store.save(goalToRecord(testGoal({ id: "trig-goal", lastRun: null }) as any));
    for (let i = 0; i < 2; i++) {
      store.save(goalToRecord(testGoal({ id: `quiet-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const tick = await agent.triggerGoal("trig-goal");
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(counting.kindScan).toBe(1);
    // The firing trigger stamps the goal (1 pair); quiet goals are
    // never saved. (The restore save runs only on the no-job path —
    // jobsCreated === 0 — so a firing trigger has exactly one save.)
    expect(counting.writeExecs).toBe(2);
    expect(counting.deletes).toBe(1);
    expect(counting.inserts).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "trig-goal")?.lastRun).toBe("2026-11-03T06:00:00.000Z");
  });

  it("a second save with the same snapshot still writes after a stamp-then-reset (the trigger restore shape)", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ id: "trig-goal", lastRun: null }) as any));
    const { goals, records } = await (agent as any).loadGoalRecords();
    const goal = goals.find((g: any) => g.id === "trig-goal");
    counting.reset();
    // First save stamps the firing (the onCron save inside a trigger).
    goal.lastRun = "2026-11-03T06:00:00.000Z";
    await (agent as any).saveGoals(goals, records);
    expect(counting.writeExecs).toBe(2);
    expect(store.listByKind("goal").find((r) => r.id === "trig-goal")?.definition).toMatchObject({
      lastRun: "2026-11-03T06:00:00.000Z",
    });
    // Restore save resets lastRun: the snapshot the first save
    // refreshed still holds the stamp, so the reset is a real change
    // and must write — against the stale pre-stamp snapshot it
    // would compare equal and the store would keep the stamp.
    goal.lastRun = null;
    await (agent as any).saveGoals(goals, records);
    expect(counting.writeExecs).toBe(4);
    expect(counting.deletes).toBe(2);
    expect(counting.inserts).toBe(2);
    const goalsAfter = await agent.listGoals();
    expect(goalsAfter.find((g: any) => g.id === "trig-goal")?.lastRun).toBeNull();
  });
});

describe("4205-P06 comparator", () => {
  it("equal except updatedAt is unchanged; any persisted-field change is a change", () => {
    const base = goalToRecord(testGoal({ lastRun: "2026-11-03T06:00:00.000Z" }) as any);
    const sameExceptStamp = { ...base, updatedAt: "2026-11-04T06:00:00.000Z" };
    expect(isUnchangedGoalRecord(base, sameExceptStamp)).toBe(true);
    expect(isUnchangedGoalRecord(base, { ...base })).toBe(true);
    const lastRunChanged = goalToRecord(
      testGoal({ lastRun: "2026-11-02T06:00:00.000Z" }) as any,
    );
    expect(isUnchangedGoalRecord(base, lastRunChanged)).toBe(false);
    const cronChanged = goalToRecord(testGoal({ cron: "0 7 * * *", lastRun: "2026-11-03T06:00:00.000Z" }) as any);
    expect(isUnchangedGoalRecord(base, cronChanged)).toBe(false);
    const disabled = { ...base, state: "paused" as const };
    expect(isUnchangedGoalRecord(base, disabled)).toBe(false);
    const operationChanged = goalToRecord(
      testGoal({ operation: "index.refresh_holdings", lastRun: "2026-11-03T06:00:00.000Z" }) as any,
    );
    expect(isUnchangedGoalRecord(base, operationChanged)).toBe(false);
  });
});
