/**
 * Issue #3121 Phase 2 — #3124 optimization: the single scan on the
 * unified store.
 *
 * RED first: these pins fail until the single evaluation pass and the
 * index coverage land. Pins assert accounting — exactly one store scan
 * per evaluation flow — not literal sizes (gitops §5, #3917).
 *
 * - 3124-P01 one scan per tick: a tick evaluates from one
 *   `listByKind("goal")` scan; the save step reuses the loaded
 *   snapshot instead of re-listing.
 * - 3124-P02 one scan per manual trigger: `triggerGoal` does one
 *   scan on the job path and one on the no-job restore path (the
 *   restore reuses the same snapshot); lastRun restore behavior
 *   unchanged.
 * - 3124-P03 one scan per mutation: add/remove/setEnabled/
 *   materialize each do one scan; removal still deletes the removed
 *   row; `createdAt` is still preserved on re-save; `saveGoals`
 *   with no snapshot still re-lists (fallback, never a break).
 * - 3124-P04 behavior parity: same firing times (due fires, not-due
 *   does not), same payloads (created job id), same tick result
 *   shape; the S1/S3 audit pins stay the guard for audit events.
 * - 3124-P05 one ledger read path (census): the three ledger-row
 *   panels read only through `listAllRuns`; no client fetches the
 *   direct `/api/schedule/runs` route; Autopilot and Workflow Runs
 *   read their own row types, never the ledger store.
 * - 3124-P06 index coverage (#2280 pattern): EXPLAIN QUERY PLAN on
 *   the exact `list()`, `listByKind`, `listRecent`, `listByJob`
 *   statements — index walks in query order, no temp b-tree.
 * - 3124-P07 §9 map: new §9.9 rows all complete (S6-P01 rule).
 * - 3124-P08 after-counts: a scripted sequence of one tick, one
 *   trigger, one add, one remove, one setEnabled costs exactly one
 *   scan per flow — five scans for five flows.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";
import type { JobRunRecord } from "../src/services/jobRunRecords";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { compileGoal } from "../src/orchestrate";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Repo root (the worktree), resolved from this test file's URL. */
const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Live (non-deprecated) source files under src/, repo-root-relative. */
function liveSrcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".deprecated.")) {
        out.push(p.slice(REPO_ROOT.length + 1));
      }
    }
  };
  walk(join(REPO_ROOT, "src"));
  return out;
}

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
 * Counting wrapper over the test storage: exact per-shape SELECT
 * counts on the two consolidated tables. A `listByKind("goal")` is
 * exactly one kind-scan exec; `list()` exactly one list-scan; the
 * ledger `listRecent` exactly one recent-scan. DDL, upserts, and
 * KV traffic never match these shapes.
 */
type ScanCounts = {
  kindScan: number;
  listScan: number;
  stateScan: number;
  recentScan: number;
  byJobScan: number;
};
class CountingStorage implements SqlStorage {
  counts: ScanCounts = { kindScan: 0, listScan: 0, stateScan: 0, recentScan: 0, byJobScan: 0 };
  constructor(private inner: SqliteTestStorage) {}
  get sqlite(): DatabaseSync {
    return this.inner.sqlite;
  }
  reset(): void {
    this.counts = { kindScan: 0, listScan: 0, stateScan: 0, recentScan: 0, byJobScan: 0 };
  }
  exec(query: string, ...params: unknown[]): unknown[] {
    const q = query.replace(/\s+/g, " ");
    if (/SELECT \* FROM unified_schedules WHERE kind/.test(q)) this.counts.kindScan++;
    else if (/SELECT \* FROM unified_schedules WHERE state/.test(q)) this.counts.stateScan++;
    else if (/SELECT \* FROM unified_schedules ORDER BY/.test(q)) this.counts.listScan++;
    else if (/SELECT \* FROM job_run_records ORDER BY started DESC/.test(q)) this.counts.recentScan++;
    else if (/SELECT \* FROM job_run_records WHERE job_id/.test(q)) this.counts.byJobScan++;
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

/** A SQL-backed agent whose store scans are counted. */
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

/** Cron due in the current UTC hour, so isDue passes regardless of when the test runs. */
function dueCron(): string {
  const now = new Date();
  return `0 ${now.getUTCHours()} * * *`;
}

function plan(db: DatabaseSync, sql: string, ...params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail).join(" | ");
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("3124-P01 one scan per tick", () => {
  it("a tick evaluates from one listByKind(goal) scan; not-due goals stay untouched", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const nowIso = new Date().toISOString();
    // Three goals, all not due (lastRun = now, so the 23h guard holds).
    for (let i = 0; i < 3; i++) {
      store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    // One screen row: the evaluation must not scan other kinds.
    store.save({
      id: "screen-1",
      kind: "screen",
      state: "active",
      callback: "autonomousMarketScreen",
      definition: { type: "cron", callback: "autonomousMarketScreen", cron: "0 6 * * *", payload: {} },
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    counting.reset();
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(3);
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors).toEqual([]);
    expect(counting.counts.kindScan).toBe(1);
    expect(counting.counts.listScan).toBe(0);
    const goals = await agent.listGoals();
    expect(goals.map((g: any) => g.lastRun)).toEqual([nowIso, nowIso, nowIso]);
  });

  it("a tick that fires a due goal still costs one scan", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ lastRun: null }) as any));
    counting.reset();
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(counting.counts.kindScan).toBe(1);
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBe("2026-11-03T06:00:00.000Z");
  });
});

describe("3124-P02 one scan per manual trigger", () => {
  it("triggering a goal that creates a job costs one scan and stamps lastRun", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ lastRun: null }) as any));
    counting.reset();
    const tick = await agent.triggerGoal("test-goal");
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(counting.counts.kindScan).toBe(1);
    const latest = await agent.getLatestJobRun("test-goal");
    expect(latest?.triggeredBy).toBe("manual");
    expect(latest?.asyncJobId).toBe("job_test_1");
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBe("2026-11-03T06:00:00.000Z");
  });

  // #4306 S2: the "triggering a deduped feed goal" test lived here.
  // Its dedup behavior was the feed branch's own 55-minute window
  // (removed with the branch), so the test goes with the goal. The
  // #3124 behavior it exercised — one scan per trigger, lastRun
  // restored — is still covered by the sibling triggerGoal test
  // above (test-goal, non-deduped path).
});

describe("3124-P03 one scan per mutation", () => {
  it("addGoal costs one scan and the goal persists", async () => {
    const { agent, counting, store } = makeCountedAgent();
    // Seed one goal first so the store is non-empty (an empty store
    // seeds DEFAULT_SCHEDULES on load — a load behavior, not a scan).
    store.save(goalToRecord(testGoal({ id: "seed-goal" }) as any));
    counting.reset();
    const created = await agent.addGoal(testGoal());
    expect(created.id).toBe("test-goal");
    expect(counting.counts.kindScan).toBe(1);
    expect((await agent.listGoals()).map((g: any) => g.id).sort()).toEqual([
      "seed-goal",
      "test-goal",
    ]);
  });

  it("removeGoal costs one scan and deletes only the removed row", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ id: "keep" }) as any));
    store.save(goalToRecord(testGoal({ id: "drop" }) as any));
    counting.reset();
    expect(await agent.removeGoal("drop")).toBe(true);
    expect(counting.counts.kindScan).toBe(1);
    expect((await agent.listGoals()).map((g: any) => g.id)).toEqual(["keep"]);
  });

  it("setGoalEnabled costs one scan and flips state to paused", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal() as any));
    counting.reset();
    expect(await agent.setGoalEnabled("test-goal", false)).toBe(true);
    expect(counting.counts.kindScan).toBe(1);
    const record = store.listByKind("goal")[0];
    expect(record.state).toBe("paused");
    expect((await agent.listGoals())[0].enabled).toBe(false);
  });

  it("materializeSynthesizedSchedule costs one scan", async () => {
    const { agent, counting } = makeCountedAgent();
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id: "synth-3124", cron: dueCron() });
    await agent.approveSynthesizedSchedule("synth-3124");
    counting.reset();
    const goal = await agent.materializeSynthesizedSchedule("synth-3124");
    expect(goal.id).toBe("synth-3124");
    expect(counting.counts.kindScan).toBe(1);
  });

  it("re-saving preserves createdAt (the snapshot carries the stored row)", async () => {
    const { agent, counting, store } = makeCountedAgent();
    const createdAt = "2026-11-01T06:00:00.000Z";
    store.save(goalToRecord(testGoal({ lastRun: createdAt }) as any));
    // Rewrite the stored createdAt to an older stamp than the save
    // would mint: the re-save must keep it, never reshuffle order.
    store.save({
      ...goalToRecord(testGoal({ lastRun: createdAt }) as any),
      createdAt,
      updatedAt: createdAt,
    });
    counting.reset();
    await agent.onCron();
    expect(counting.counts.kindScan).toBe(1);
    expect(store.listByKind("goal")[0].createdAt).toBe(createdAt);
  });

  it("saveGoals with no snapshot still re-lists (fallback, never a break)", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ id: "keep" }) as any));
    store.save(goalToRecord(testGoal({ id: "drop" }) as any));
    const goals = await agent.listGoals();
    const kept = goals.filter((g: any) => g.id === "keep");
    counting.reset();
    await (agent as any).saveGoals(kept);
    // No snapshot passed: the fallback re-list finds "drop" in the
    // store and deletes it — removal sync preserved.
    expect(counting.counts.kindScan).toBe(1);
    expect(store.listByKind("goal").map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("3124-P04 behavior parity", () => {
  it("same firing times: due fires, not-due does not, in one tick", async () => {
    const { agent, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ id: "due", lastRun: null }) as any));
    // Cron fires at 07:00, not yet — not due at the frozen 06:00,
    // with lastRun null so the assertion distinguishes stamped from
    // untouched without sharing a timestamp with the due goal.
    store.save(goalToRecord(testGoal({ id: "not-due", cron: "0 7 * * *", lastRun: null }) as any));
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(2);
    expect(tick.jobsCreated).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "due")?.lastRun).toBe("2026-11-03T06:00:00.000Z");
    expect(goals.find((g: any) => g.id === "not-due")?.lastRun).toBeNull();
  });

  it("same payloads: the fired goal's created job id rides the run record", async () => {
    const { agent, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ lastRun: null }) as any));
    await agent.onCron();
    const runs = await agent.listJobRuns("test-goal");
    expect(runs).toHaveLength(1);
    expect(runs[0].asyncJobId).toBe("job_test_1");
    expect(runs[0].scheduleId).toBe("test-goal");
  });
});

describe("3124-P05 one ledger read path (census)", () => {
  it("the three ledger-row panels read only through listAllRuns", () => {
    for (const panel of ["JobsPanel.tsx", "ScheduleRunLedgerPanel.tsx", "ScheduledGoalsPanel.tsx"]) {
      const body = source(`src/client/${panel}`);
      expect(body).toContain("listAllRuns");
      expect(body).not.toContain("/api/ledger/runs");
      expect(body).not.toContain("/api/schedule/runs");
      expect(body).not.toContain("/api/schedules/runs");
    }
  });

  it("no client fetches the direct /api/schedule/runs route", () => {
    const callers = liveSrcFiles()
      .filter((f) => f.startsWith("src/client/"))
      .filter((f) => f !== "src/client/iaaaEndpointCatalog.ts")
      .filter((f) => source(f).includes("/api/schedule/runs"));
    expect(callers).toEqual([]);
  });

  it("Autopilot and Workflow Runs read their own row types, never the ledger store", () => {
    const autopilot = source("src/agents/routes/autopilot.ts");
    expect(autopilot).toContain("listJobOutcomes");
    expect(autopilot).not.toContain("SqlJobRunRecordStore");
    const workflowRuns = source("src/agents/routes/workflowRuns.ts");
    expect(workflowRuns).toContain("readWorkflowRunJobs");
    expect(workflowRuns).toContain("listJobOutcomes");
    expect(workflowRuns).toContain("readWorkflowRunTransitions");
    expect(workflowRuns).not.toContain("SqlJobRunRecordStore");
  });

  it("the merged read still fans out to exactly its two halves", () => {
    const trading = source("src/server/routes/trading.ts");
    expect(trading).toContain("/api/ledger/runs");
    expect(trading).toContain("/schedules/runs?limit=");
    expect(trading).toContain("listJobRuns");
  });
});

describe("3124-P06 index coverage (#2280 pattern)", () => {
  function seedSchedules(db: DatabaseSync, n: number): void {
    const store = new SqlUnifiedScheduleStore(
      {
        exec: (query: string, ...params: unknown[]) => {
          const stmt = db.prepare(query);
          if (/^\s*(SELECT|PRAGMA)/i.test(query)) return stmt.all(...(params as never[])) as unknown[];
          stmt.run(...(params as never[]));
          return [];
        },
      } as never,
    );
    const nowIso = "2026-11-03T06:00:00.000Z";
    for (let i = 0; i < n; i++) {
      store.save({
        id: `goal-${i}`,
        kind: "goal",
        state: "active",
        operation: "test.op",
        definition: { id: `goal-${i}`, name: `Goal ${i}`, cron: "0 6 * * *", operation: "test.op", budgetCents: 1, enabled: true },
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  function seedLedger(db: DatabaseSync, n: number): void {
    const store = new SqlJobRunRecordStore(
      {
        exec: (query: string, ...params: unknown[]) => {
          const stmt = db.prepare(query);
          if (/^\s*(SELECT|PRAGMA)/i.test(query)) return stmt.all(...(params as never[])) as unknown[];
          stmt.run(...(params as never[]));
          return [];
        },
      } as never,
    );
    for (let i = 0; i < n; i++) {
      const started = new Date(Date.now() - i * 60_000).toISOString();
      store.record({
        system: "orchestrator-schedule",
        jobId: `job-${i % 10}`,
        operation: "autonomousMarketScreen",
        started,
        finished: started,
        outcome: "success",
        triggeredBy: "scheduled",
      } as JobRunRecord);
    }
  }

  it("list() walks the created-ordering index, not the table", () => {
    const db = new DatabaseSync(":memory:");
    seedSchedules(db, 50);
    const p = plan(db, "SELECT * FROM unified_schedules ORDER BY created_at ASC, id ASC");
    // An index walk in stored order: SQLite reports it as
    // "SCAN ... USING INDEX" (never a bare table scan) with no
    // temp b-tree for the ORDER BY. Before #3124 the same statement
    // planned "SCAN unified_schedules | USE TEMP B-TREE FOR ORDER BY".
    expect(p).toContain("USING INDEX unified_schedules_created_idx");
    expect(p).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("listByKind still walks kind_idx (regression guard)", () => {
    const db = new DatabaseSync(":memory:");
    seedSchedules(db, 50);
    const p = plan(
      db,
      "SELECT * FROM unified_schedules WHERE kind = ? ORDER BY created_at ASC, id ASC",
      "goal",
    );
    expect(p).toContain("USING INDEX unified_schedules_kind_idx");
    expect(p).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("listRecent walks the recent-read index, not the table", () => {
    const db = new DatabaseSync(":memory:");
    seedLedger(db, 50);
    const p = plan(db, "SELECT * FROM job_run_records ORDER BY started DESC, id DESC LIMIT ?", 50);
    // Same index-walk shape as list(): "SCAN ... USING INDEX" in
    // started order, LIMIT stops the walk at 50 rows, no temp
    // b-tree. Before #3124: "SCAN job_run_records | USE TEMP
    // B-TREE FOR ORDER BY" — the whole table, sorted, per call.
    expect(p).toContain("USING INDEX job_run_records_recent_idx");
    expect(p).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("listByJob still walks job_idx (regression guard)", () => {
    const db = new DatabaseSync(":memory:");
    seedLedger(db, 50);
    const p = plan(
      db,
      "SELECT * FROM job_run_records WHERE job_id = ? ORDER BY started DESC, id DESC LIMIT ?",
      "job-1",
      50,
    );
    expect(p).toContain("USING INDEX job_run_records_job_idx");
    expect(p).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("the new indexes exist by name in the schema modules", () => {
    expect(source("src/data/unifiedScheduleIndexSchema.ts")).toContain(
      "unified_schedules_created_idx",
    );
    expect(source("src/data/jobRunRecordIndexSchema.ts")).toContain("job_run_records_recent_idx");
  });
});

describe("3124-P07 §9 map", () => {
  it("the S0 inventory gains a §9.9 section with the #3124 rows, all complete", () => {
    const inventory = source("docs/architecture/scheduling/3121-s0-inventory.md");
    expect(inventory).toContain("### 9.9 Phase 2 #3124 optimization");
    expect(inventory).toContain("Single evaluation scan");
    expect(inventory).toContain("Single ledger read path");
    expect(inventory).toContain("Index coverage");
    expect(inventory).toContain("#3124 — landed");
  });
});

describe("3124-P08 after-counts", () => {
  it("five flows cost exactly five scans — one per flow", async () => {
    const { agent, counting, store } = makeCountedAgent();
    store.save(goalToRecord(testGoal({ id: "tick-goal", lastRun: new Date().toISOString() }) as any));
    store.save(goalToRecord(testGoal({ id: "trig-goal", lastRun: null }) as any));
    counting.reset();
    await agent.onCron();
    await agent.triggerGoal("trig-goal");
    await agent.addGoal(testGoal({ id: "added" }));
    await agent.removeGoal("added");
    await agent.setGoalEnabled("tick-goal", false);
    expect(counting.counts.kindScan).toBe(5);
    expect(counting.counts.listScan).toBe(0);
  });
});
