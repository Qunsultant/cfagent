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
 * #6503 — the store is D1 now (the DO SqlUnifiedScheduleStore is
 * retired as a live store): one `store.save` is a single Drizzle
 * upsert (INSERT ... ON CONFLICT DO UPDATE), not the old DO
 * DELETE + INSERT pair, so a changed goal costs 1 write exec and
 * 0 deletes; a removal still costs 1 delete. The counting wrapper
 * counts D1 statements by shape (kind scan / upsert / delete) and
 * the pins below are re-pinned to that shape — the dirty-check
 * behavior (only changed goals are written) is unchanged.
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

import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import {
  goalToRecord,
  isUnchangedGoalRecord,
} from "../src/services/unifiedScheduleManagement";
import { ScheduledAgent } from "../src/agents/scheduled-agent";

/**
 * Counting wrapper over MockD1: kind scans plus the write execs a
 * save costs, counted by D1 statement shape (verified against the
 * adapter's Drizzle SQL: listByKind is `select ... from
 * "unified_schedules" where "kind" = ?`; save is a single `insert
 * into "unified_schedules" ... on conflict ... do update`; remove
 * is `delete from "unified_schedules" where "id" = ?`). One
 * `store.save` is ONE upsert (1 write exec, 0 deletes); a
 * removal-sync delete is 1 delete with no insert. Migration
 * statements (CREATE / _migrations markers / the 0092 seed INSERT
 * OR IGNORE with a bare table name) match none of these shapes.
 */
class CountingD1 {
  kindScan = 0;
  deletes = 0;
  inserts = 0;
  constructor(private inner: MockD1Database) {}
  get writeExecs(): number {
    return this.deletes + this.inserts;
  }
  reset(): void {
    this.kindScan = 0;
    this.deletes = 0;
    this.inserts = 0;
  }
  prepare(sql: string) {
    const stmt = this.inner.prepare(sql);
    const norm = sql.replace(/\s+/g, " ");
    const count = () => {
      if (/^select .* from "unified_schedules" where "unified_schedules"\."kind" = \?/i.test(norm)) {
        this.kindScan++;
      } else if (/^insert into "unified_schedules"/i.test(norm)) {
        this.inserts++;
      } else if (/^delete from "unified_schedules" where/i.test(norm)) {
        this.deletes++;
      }
    };
    return {
      bind: (...params: unknown[]) => {
        const bound = stmt.bind(...params);
        return {
          run: async () => {
            count();
            return bound.run();
          },
          all: async () => {
            count();
            return bound.all();
          },
          first: async () => {
            count();
            return bound.first();
          },
          raw: async () => {
            count();
            return bound.raw();
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    return this.inner.batch(statements);
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

/** A D1-backed agent whose store scans and writes are counted. */
async function makeCountedAgent() {
  const counting = new CountingD1(new MockD1Database());
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => (kv.has(k) ? kv.get(k) : undefined),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
  };
  const agent = new (ScheduledAgent as any)(ctx, { ...makeEnv(), AGENT_DB: counting as never });
  const store = createD1UnifiedSchedulePorts({ d1: counting as never }).unifiedSchedules;
  // #6503 — the first store op lazily ensures the schema and
  // migration 0092's seeds land (5 system rows + 9 goals); clear
  // them so the fixtures below are the only rows (same pattern as
  // the #6503 G3 goals-tick file). The clear runs before any
  // counting reset, so the ensure's statements never enter the pins.
  await store.clear();
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
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
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
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    const createdAt = "2026-11-01T06:00:00.000Z";
    // Due goal with an older stored createdAt: the re-save must keep
    // it, never reshuffle order — and must stamp lastRun.
    await store.save({
      ...goalToRecord(testGoal({ id: "due", lastRun: null }) as any),
      createdAt,
      updatedAt: createdAt,
    });
    for (let i = 0; i < 2; i++) {
      await store.save(goalToRecord(testGoal({ id: `quiet-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(3);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(counting.kindScan).toBe(1);
    // Exactly one save: the fired goal's single D1 upsert (#6503 —
    // the DO DELETE + INSERT pair is retired with the DO store).
    expect(counting.writeExecs).toBe(1);
    expect(counting.deletes).toBe(0);
    expect(counting.inserts).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "due")?.lastRun).toBe("2026-11-03T06:00:00.000Z");
    expect(goals.find((g: any) => g.id === "quiet-0")?.lastRun).toBe(nowIso);
    expect(goals.find((g: any) => g.id === "quiet-1")?.lastRun).toBe(nowIso);
    expect((await store.listByKind("goal")).find((r) => r.id === "due")?.createdAt).toBe(createdAt);
  });
});

describe("4205-P03 mutations write only their goal", () => {
  it("setGoalEnabled persists the toggle and writes only that goal", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const ok = await agent.setGoalEnabled("goal-1", false);
    expect(ok).toBe(true);
    expect(counting.kindScan).toBe(1);
    // #6503 — one D1 upsert, not the old DO DELETE + INSERT pair.
    expect(counting.writeExecs).toBe(1);
    expect(counting.deletes).toBe(0);
    expect(counting.inserts).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "goal-1")?.enabled).toBe(false);
    expect(goals.find((g: any) => g.id === "goal-0")?.enabled).toBe(true);
  });

  it("addGoal writes only the new goal", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    await store.save(goalToRecord(testGoal({ id: "seed-goal", lastRun: nowIso }) as any));
    counting.reset();
    const created = await agent.addGoal(testGoal({ id: "added" }));
    expect(created.id).toBe("added");
    expect(counting.kindScan).toBe(1);
    // #6503 — one D1 upsert, not the old DO DELETE + INSERT pair.
    expect(counting.writeExecs).toBe(1);
    expect(counting.deletes).toBe(0);
    expect(counting.inserts).toBe(1);
  });

  it("removeGoal deletes the removed row and writes nothing else", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const ok = await agent.removeGoal("goal-1");
    expect(ok).toBe(true);
    expect(counting.kindScan).toBe(1);
    // Removal sync only: one DELETE, no INSERT for the kept goals.
    expect(counting.deletes).toBe(1);
    expect(counting.inserts).toBe(0);
    expect((await store.listByKind("goal")).map((r) => r.id).sort()).toEqual(["goal-0", "goal-2"]);
  });
});

describe("4205-P04 no-snapshot fallback still re-lists, still skips unchanged goals", () => {
  it("saveGoals with no snapshot re-lists, removes the dropped row, and does not re-save the kept goal", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ id: "keep" }) as any));
    await store.save(goalToRecord(testGoal({ id: "drop" }) as any));
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
    expect((await store.listByKind("goal")).map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("4205-P05 trigger saves only the triggered goal", () => {
  it("triggering a goal that fires costs one scan and one save of that goal", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    await store.save(goalToRecord(testGoal({ id: "trig-goal", lastRun: null }) as any));
    for (let i = 0; i < 2; i++) {
      await store.save(goalToRecord(testGoal({ id: `quiet-${i}`, lastRun: nowIso }) as any));
    }
    counting.reset();
    const tick = await agent.triggerGoal("trig-goal");
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(counting.kindScan).toBe(1);
    // The firing trigger stamps the goal (1 upsert); quiet goals are
    // never saved. (The restore save runs only on the no-job path —
    // jobsCreated === 0 — so a firing trigger has exactly one save.)
    // #6503 — one D1 upsert, not the old DO DELETE + INSERT pair.
    expect(counting.writeExecs).toBe(1);
    expect(counting.deletes).toBe(0);
    expect(counting.inserts).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "trig-goal")?.lastRun).toBe("2026-11-03T06:00:00.000Z");
  });

  it("a second save with the same snapshot still writes after a stamp-then-reset (the trigger restore shape)", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ id: "trig-goal", lastRun: null }) as any));
    const { goals, records } = await (agent as any).loadGoalRecords();
    const goal = goals.find((g: any) => g.id === "trig-goal");
    counting.reset();
    // First save stamps the firing (the onCron save inside a trigger).
    goal.lastRun = "2026-11-03T06:00:00.000Z";
    await (agent as any).saveGoals(goals, records);
    expect(counting.writeExecs).toBe(1);
    expect((await store.listByKind("goal")).find((r) => r.id === "trig-goal")?.definition).toMatchObject({
      lastRun: "2026-11-03T06:00:00.000Z",
    });
    // Restore save resets lastRun: the snapshot the first save
    // refreshed still holds the stamp, so the reset is a real change
    // and must write — against the stale pre-stamp snapshot it
    // would compare equal and the store would keep the stamp.
    goal.lastRun = null;
    await (agent as any).saveGoals(goals, records);
    // #6503 — two D1 upserts total, zero deletes (no DO pair).
    expect(counting.writeExecs).toBe(2);
    expect(counting.deletes).toBe(0);
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
