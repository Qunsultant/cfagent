/**
 * @deprecated Issue #4253 — RED PROBE, retired by rename 2026-11-18.
 * It proved the durable-removal bug on pre-#4253 code (a removed
 * built-in goal was re-seeded when the goals list emptied) and its
 * red was observed before the fix landed. Frozen: do not update.
 * Its pins live on, rebuilt for current main's nine goals, in
 * tests/scheduled_goals_config_4253.test.ts (4253-P02, 4253-P03).
 * See docs/architecture/transition/deprecations.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { DEFAULT_SCHEDULES } from "../src/schedule";

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
  const env = {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
  } as any;
  const agent = new (ScheduledAgent as any)(ctx, env);
  const store = new SqlUnifiedScheduleStore(storage as never as SqlStorage);
  return { agent, kv, store };
}

describe("4253 RED PROBE — removed goals resurrect today", () => {
  it("removing one built-in, then emptying the list, does NOT bring it back", async () => {
    const { agent, store } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(seeded.map((g: any) => g.id)).toEqual(DEFAULT_SCHEDULES.map((g) => g.id));
    expect(await agent.removeGoal("feed-refresh")).toBe(true);
    for (const goal of seeded) {
      if (goal.id === "feed-refresh") continue;
      store.remove(goal.id);
    }
    const after = await agent.listGoals();
    expect(after.map((g: any) => g.id)).not.toContain("feed-refresh");
    expect(after).toHaveLength(8);
  });

  it("removing all nine built-ins leaves the list empty", async () => {
    const { agent } = makeSqlAgent();
    const seeded = await agent.listGoals();
    expect(seeded).toHaveLength(9);
    for (const goal of seeded) {
      expect(await agent.removeGoal(goal.id)).toBe(true);
    }
    expect(await agent.listGoals()).toEqual([]);
  });
});
