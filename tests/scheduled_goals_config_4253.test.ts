/**
 * Issue #4253 — built-in scheduled goals externalized to config,
 * removal durable.
 *
 * Rebuilt 2026-11-18 from the Nov-12 WIP red: the WIP pinned the
 * Nov-12 nine (with `feed-refresh`, without
 * `autopilot-monthly-evaluation`), but main has since removed
 * `feed-refresh` (#4350, "feat(4306): remove the hourly
 * feed-refresh goal") and added `autopilot-monthly-evaluation`
 * (#4411) — the current nine are pinned here instead. The daily
 * crons for opportunity-hunt (`0 7 * * *`, was `0 *\/6 * * *`) and
 * resource-cap-alert (`0 0 * * *`, was `0 * * * *`) are the
 * daily-defaults directive applied in the config; P08 pins that
 * every config cron is daily or less.
 *
 * Pinned behaviors (SQL-backed store — the branch where an empty
 * list re-seeds — plus the no-SQL KV fallback):
 * - 4253-P01 fresh store seeds all nine goals from config, in
 *   config order, with config values.
 * - 4253-P02 a removed built-in goal is NOT re-seeded when the
 *   list empties; the other eight are.
 * - 4253-P03 removing all nine leaves the list empty — no
 *   resurrection on re-seed or redeploy (same storage, re-read).
 * - 4253-P04 a config change takes effect without a code change
 *   (override seam: changed cron/budget seed on a fresh store).
 * - 4253-P05 the removal record is visible via
 *   listRemovedBuiltinGoalIds, and an explicit re-add clears it
 *   (so a later empty-store seed includes the goal again).
 * - 4253-P06 the no-SQL fallback seeds from config minus removed
 *   goals too.
 * - 4253-P07 the config port fails closed on an invalid goal
 *   definition (bad cron, non-positive budget, missing operation).
 * - 4253-P08 every config cron is daily or less (single minute +
 *   single hour fields — at most one firing per day).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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
  return { ...actual };
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
import { goalToRecord } from "../src/services/unifiedScheduleManagement";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import {
  getBuiltinScheduledGoals,
  setBuiltinScheduledGoals,
  isBuiltinScheduledGoalId,
} from "../src/config/builtinScheduledGoals";

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

function makeEnv() {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
  } as any;
}

/** A SQL-backed agent (ctx.storage.sql present → unified store). */
function makeSqlAgent() {
  const storage = new SqliteTestStorage();
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => (kv.has(k) ? kv.get(k) : undefined),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
      sql: storage as never,
    },
  };
  const agent = new (ScheduledAgent as any)(ctx, makeEnv());
  const store = new SqlUnifiedScheduleStore(storage as never as SqlStorage);
  return { agent, kv, store };
}

/** A no-SQL agent (no ctx.storage.sql → legacy "goals" KV key). */
function makeKvAgent() {
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (k: string) => (kv.has(k) ? kv.get(k) : undefined),
      put: async (k: string, v: unknown) => void kv.set(k, v),
      delete: async (k: string) => void kv.delete(k),
    },
  };
  const agent = new (ScheduledAgent as any)(ctx, makeEnv());
  return { agent, kv };
}

const BUILTIN_IDS = [
  "daily-qa-sweep",
  "opportunity-hunt",
  "daily-social-post",
  "resource-daily-rollup",
  "resource-cap-alert",
  "resource-dashboard-comparison",
  "index-refresh-wikipedia",
  "index-refresh-holdings",
  "autopilot-monthly-evaluation",
] as const;

afterEach(() => {
  // The override seam is module-global: always reset to the file.
  setBuiltinScheduledGoals(null);
});

describe("built-in goals from config (#4253)", () => {
  it("4253-P01 fresh SQL store seeds all nine goals from config, in config order", async () => {
    const config = getBuiltinScheduledGoals();
    expect(config.map((g) => g.id)).toEqual([...BUILTIN_IDS]);
    const { agent } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(seeded.map((g: any) => g.id)).toEqual(config.map((g) => g.id));
    const byId = new Map(seeded.map((g: any) => [g.id, g]));
    for (const goal of config) {
      expect(byId.get(goal.id)).toMatchObject({
        name: goal.name,
        cron: goal.cron,
        operation: goal.operation,
        budgetCents: goal.budgetCents,
        enabled: goal.enabled,
      });
      expect((byId.get(goal.id) as any).timeZone).toBe(goal.timeZone);
    }
    expect(isBuiltinScheduledGoalId("autopilot-monthly-evaluation")).toBe(true);
    // feed-refresh left the config with #4350: not a built-in anymore.
    expect(isBuiltinScheduledGoalId("feed-refresh")).toBe(false);
    expect(isBuiltinScheduledGoalId("not-a-builtin")).toBe(false);
  });

  it("4253-P02 a removed built-in is not re-seeded when the list empties", async () => {
    const { agent, store } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(seeded).toHaveLength(9);
    expect(await agent.removeGoal("autopilot-monthly-evaluation")).toBe(true);
    // Empty the list without recording removals for the rest
    // (direct store removal, not removeGoal): only
    // autopilot-monthly-evaluation was owner-removed, so only it
    // must stay gone.
    for (const goal of seeded) {
      if (goal.id === "autopilot-monthly-evaluation") continue;
      store.remove(goal.id);
    }
    const after = await agent.listGoals();
    expect(after.map((g: any) => g.id)).not.toContain("autopilot-monthly-evaluation");
    expect(after).toHaveLength(8);
    expect(after.map((g: any) => g.id)).toEqual([
      "daily-qa-sweep",
      "opportunity-hunt",
      "daily-social-post",
      "resource-daily-rollup",
      "resource-cap-alert",
      "resource-dashboard-comparison",
      "index-refresh-wikipedia",
      "index-refresh-holdings",
    ]);
  });

  it("4253-P03 removing all nine leaves the list empty on re-read (no resurrection)", async () => {
    const { agent } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(seeded).toHaveLength(9);
    for (const goal of seeded) {
      expect(await agent.removeGoal(goal.id)).toBe(true);
    }
    expect(await agent.listGoals()).toEqual([]);
    // A second read (redeploy shape: same storage, fresh load)
    // still serves empty — the removal record survives re-seed.
    expect(await agent.listGoals()).toEqual([]);
  });

  it("4253-P04 a config change takes effect without a code change", async () => {
    const changed = getBuiltinScheduledGoals().map((goal) =>
      goal.id === "daily-qa-sweep"
        ? { ...goal, cron: "0 7 * * *", budgetCents: 501 }
        : goal,
    );
    setBuiltinScheduledGoals(changed);
    const { agent } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(seeded.find((g: any) => g.id === "daily-qa-sweep")).toMatchObject({
      cron: "0 7 * * *",
      budgetCents: 501,
    });
    // The override is a seam for the config file: resetting it
    // restores the file values on a fresh store.
    setBuiltinScheduledGoals(null);
    const { agent: fresh } = makeSqlAgent();
    expect((await fresh.listGoals()).find((g: any) => g.id === "daily-qa-sweep")).toMatchObject({
      cron: "0 6 * * *",
      budgetCents: 500,
    });
  });

  it("4253-P05 the removal record is visible, and an explicit re-add clears it", async () => {
    const { agent, store } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(await agent.removeGoal("autopilot-monthly-evaluation")).toBe(true);
    expect(await agent.listRemovedBuiltinGoalIds()).toEqual(["autopilot-monthly-evaluation"]);
    // Explicit owner re-add (via the add-goal path) wins over the
    // removal record: the goal comes back and stays back.
    const definition = getBuiltinScheduledGoals().find(
      (g) => g.id === "autopilot-monthly-evaluation",
    )!;
    await agent.addGoal({ ...definition });
    expect(await agent.listRemovedBuiltinGoalIds()).toEqual([]);
    for (const goal of seeded) {
      if (goal.id === "autopilot-monthly-evaluation") continue;
      store.remove(goal.id);
    }
    store.remove("autopilot-monthly-evaluation");
    const after = await agent.listGoals();
    expect(after.map((g: any) => g.id)).toContain("autopilot-monthly-evaluation");
    expect(after).toHaveLength(9);
  });

  it("4253-P06 the no-SQL fallback seeds from config minus removed goals", async () => {
    const { agent, kv } = makeKvAgent();
    const seeded = await agent.listGoals();
    expect(seeded.map((g: any) => g.id)).toEqual(
      getBuiltinScheduledGoals().map((g) => g.id),
    );
    expect(await agent.removeGoal("autopilot-monthly-evaluation")).toBe(true);
    expect(await agent.listGoals()).toHaveLength(8);
    // Virgin-store shape: the "goals" key is gone entirely, so
    // the next load seeds — from config, minus the removed goal.
    kv.delete("goals");
    const reseeded = await agent.listGoals();
    expect(reseeded.map((g: any) => g.id)).not.toContain("autopilot-monthly-evaluation");
    expect(reseeded).toHaveLength(8);
  });

  it("4253-P07 the config port fails closed on an invalid goal definition", () => {
    const base = getBuiltinScheduledGoals();
    expect(() =>
      setBuiltinScheduledGoals([
        ...base,
        {
          id: "bad-cron",
          name: "Bad cron",
          cron: "not a cron",
          operation: "qa.run_sweep",
          budgetCents: 1,
          enabled: true,
        },
      ]),
    ).toThrow(/cron/i);
    expect(() =>
      setBuiltinScheduledGoals(
        base.map((goal) =>
          goal.id === "daily-qa-sweep" ? { ...goal, budgetCents: 0 } : goal,
        ),
      ),
    ).toThrow(/budget/i);
    expect(() =>
      setBuiltinScheduledGoals(
        base.map((goal) =>
          goal.id === "daily-qa-sweep" ? { ...goal, operation: "" } : goal,
        ),
      ),
    ).toThrow(/operation/i);
    // A rejected override leaves the file values in place.
    expect(getBuiltinScheduledGoals()).toEqual(base);
  });

  it("4253-P08 every config cron is daily or less (daily-defaults directive)", () => {
    const config = getBuiltinScheduledGoals();
    // The two sub-daily defaults were made daily in the config:
    // opportunity-hunt was every 6h, resource-cap-alert hourly.
    const byId = new Map(config.map((g) => [g.id, g]));
    expect(byId.get("opportunity-hunt")?.cron).toBe("0 7 * * *");
    expect(byId.get("resource-cap-alert")?.cron).toBe("0 0 * * *");
    // General pin: a single minute + a single hour field means at
    // most one firing per day, whatever the day fields say.
    for (const goal of config) {
      const [minute, hour] = goal.cron.trim().split(/\s+/);
      expect(minute, `${goal.id} minute`).toMatch(/^\d+$/);
      expect(hour, `${goal.id} hour`).toMatch(/^\d+$/);
    }
  });
});

describe("stale opportunity-hunt cron is reconciled once to the config value (#6293)", () => {
  const staleHunt = () => ({
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 */6 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  });

  it("6293-C01 SQL store: a stored stale cron is reset to daily 07:00 and the row is corrected in place", async () => {
    const { agent, store } = makeSqlAgent();
    const seeded = goalToRecord(staleHunt() as never);
    seeded.createdAt = "2026-11-01T00:00:00.000Z";
    seeded.updatedAt = seeded.createdAt;
    store.save(seeded);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "opportunity-hunt")?.cron).toBe("0 7 * * *");
    // The correction is durable: the stored row carries the config
    // cron, with its createdAt preserved.
    const row = store.get("opportunity-hunt");
    expect((row?.definition as any).cron).toBe("0 7 * * *");
    expect(row?.createdAt).toBe("2026-11-01T00:00:00.000Z");
    // A second read is a no-op: the value already equals config.
    expect(
      (await agent.listGoals()).find((g: any) => g.id === "opportunity-hunt")?.cron,
    ).toBe("0 7 * * *");
  });

  it("6293-C02 KV fallback: a stored stale cron is reset and the key re-written", async () => {
    const { agent, kv } = makeKvAgent();
    kv.set("goals", [staleHunt()]);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "opportunity-hunt")?.cron).toBe("0 7 * * *");
    const persisted = kv.get("goals") as any[];
    expect(persisted.find((g) => g.id === "opportunity-hunt")?.cron).toBe("0 7 * * *");
  });

  it("6293-C03 an owner-edited cron is left untouched (SQL store)", async () => {
    const { agent, store } = makeSqlAgent();
    store.save(goalToRecord({ ...staleHunt(), cron: "0 8 * * *" } as never));
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "opportunity-hunt")?.cron).toBe("0 8 * * *");
    expect((store.get("opportunity-hunt")?.definition as any).cron).toBe("0 8 * * *");
  });

  it("6293-C04 an owner-edited cron is left untouched (KV fallback)", async () => {
    const { agent, kv } = makeKvAgent();
    kv.set("goals", [{ ...staleHunt(), cron: "0 8 * * *" }]);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "opportunity-hunt")?.cron).toBe("0 8 * * *");
    expect((kv.get("goals") as any[]).find((g) => g.id === "opportunity-hunt")?.cron).toBe(
      "0 8 * * *",
    );
  });

  it("6293-C05 a goal with a different operation is left untouched by the reconciliation", async () => {
    // The id alone does not identify the shipped opportunity-hunt
    // goal: a stored goal that reuses the id with another operation
    // (a fixture running "search.query") keeps its step-hour cron.
    const { agent: sqlAgent, store } = makeSqlAgent();
    store.save(goalToRecord({ ...staleHunt(), operation: "search.query" } as never));
    const sqlGoals = await sqlAgent.listGoals();
    expect(sqlGoals.find((g: any) => g.id === "opportunity-hunt")?.cron).toBe("0 */6 * * *");
    expect((store.get("opportunity-hunt")?.definition as any).cron).toBe("0 */6 * * *");
    const { agent: kvAgent, kv } = makeKvAgent();
    kv.set("goals", [{ ...staleHunt(), operation: "search.query" }]);
    const kvGoals = await kvAgent.listGoals();
    expect(kvGoals.find((g: any) => g.id === "opportunity-hunt")?.cron).toBe("0 */6 * * *");
    expect((kv.get("goals") as any[]).find((g) => g.id === "opportunity-hunt")?.cron).toBe(
      "0 */6 * * *",
    );
  });
});
