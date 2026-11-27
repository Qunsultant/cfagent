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
 *   snapshot instead of re-listing. (#6503: the scan is counted on
 *   the D1 unified store — the DO SqlStorage seam is retired.)
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

import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import {
  createD1JobRunRecordDb,
  D1JobRunRecordStore,
} from "../src/data/d1JobRunRecordAdapter";
import type { UnifiedScheduleRecord } from "../src/data/unifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";
import type { JobRunRecord } from "../src/services/jobRunRecords";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { compileGoal } from "../src/orchestrate";
import { MockD1Database } from "./mock-d1";
import { makeLedgerStub } from "./ledger-stub";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";

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

/** The D1 statement shapes the adapter actually emits (verified
 * against src/data/d1UnifiedScheduleAdapter.ts): `listByKind` is
 * one `select ... where "kind" = ?`; `list()` one bare `select ...
 * order by`; `save` one upsert `insert ... on conflict ... do
 * update`; `remove` one `delete ... where "id" = ?`. Migration
 * statements — CREATE / `_migrations` markers / the 0092 seed
 * `INSERT OR IGNORE` with a bare table name — match none of them.
 * (#6503: the DO SqlStorage counting seam is retired with the DO
 * store; counts move to the D1 statements, same shapes as
 * schedule-3121-4205-dirty-check.test.ts.) */
type ScanCounts = {
  kindScan: number;
  listScan: number;
  stateScan: number;
  recentScan: number;
  byJobScan: number;
};
class CountingD1 {
  counts: ScanCounts = { kindScan: 0, listScan: 0, stateScan: 0, recentScan: 0, byJobScan: 0 };
  constructor(private inner: MockD1Database) {}
  reset(): void {
    this.counts = { kindScan: 0, listScan: 0, stateScan: 0, recentScan: 0, byJobScan: 0 };
  }
  prepare(sql: string) {
    const stmt = this.inner.prepare(sql);
    const norm = sql.replace(/\s+/g, " ");
    const count = () => {
      if (/^select .* from "unified_schedules" where "unified_schedules"\."kind" = \?/i.test(norm)) {
        this.counts.kindScan++;
      } else if (/^select .* from "unified_schedules" where "unified_schedules"\."state" = \?/i.test(norm)) {
        this.counts.stateScan++;
      } else if (/^select .* from "unified_schedules" order by/i.test(norm)) {
        this.counts.listScan++;
      }
      // No counting for recentScan/byJobScan: the ledger reads go
      // through the same D1 binding (#6101), not the unified
      // store, so those counters stay 0 by construction.
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

/** A D1-backed agent whose store scans are counted. */
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
  // #6503 — the unified store lives in D1 only (fail-closed without
  // AGENT_DB); the counting D1 is the store. Issue #6101 — the run
  // ledger lives in the same D1 binding (the goal runs record
  // through it), never the ctx.storage KV key. Issue #6101 step 9 —
  // the KV "jobRunRecords" key is retired: fired goals post their
  // runs to the shared ledger through ORCHESTRATOR_AGENT, so bind a
  // fresh in-memory ledger stub — listJobRuns/getLatestJobRun read
  // the posted runs back.
  const agent = new (ScheduledAgent as any)(ctx, {
    ...makeEnv(),
    AGENT_DB: counting as never,
    ORCHESTRATOR_AGENT: makeLedgerStub().namespace,
  });
  const store = createD1UnifiedSchedulePorts({ d1: counting as never }).unifiedSchedules;
  // The first store op lazily ensures the schema and migration
  // 0092's seeds land (5 system rows + 9 goals); clear them so the
  // fixtures below are the only rows (same pattern as the #6503 G3
  // goals-tick file). The clear runs before any counting reset, so
  // the ensure's statements never enter the pins.
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
    const { agent, counting, store } = await makeCountedAgent();
    const nowIso = new Date().toISOString();
    // Three goals, all not due (lastRun = now, so the 23h guard holds).
    for (let i = 0; i < 3; i++) {
      await store.save(goalToRecord(testGoal({ id: `goal-${i}`, lastRun: nowIso }) as any));
    }
    // One screen row: the evaluation must not scan other kinds.
    await store.save({
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
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ lastRun: null }) as any));
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
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ lastRun: null }) as any));
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
    const { agent, counting, store } = await makeCountedAgent();
    // Seed one goal first so the store is non-empty (an empty store
    // seeds DEFAULT_SCHEDULES on load — a load behavior, not a scan).
    await store.save(goalToRecord(testGoal({ id: "seed-goal" }) as any));
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
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ id: "keep" }) as any));
    await store.save(goalToRecord(testGoal({ id: "drop" }) as any));
    counting.reset();
    expect(await agent.removeGoal("drop")).toBe(true);
    expect(counting.counts.kindScan).toBe(1);
    expect((await agent.listGoals()).map((g: any) => g.id)).toEqual(["keep"]);
  });

  it("setGoalEnabled costs one scan and flips state to paused", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal() as any));
    counting.reset();
    expect(await agent.setGoalEnabled("test-goal", false)).toBe(true);
    expect(counting.counts.kindScan).toBe(1);
    const record = (await store.listByKind("goal"))[0];
    expect(record.state).toBe("paused");
    expect((await agent.listGoals())[0].enabled).toBe(false);
  });

  it("materializeSynthesizedSchedule costs one scan", async () => {
    const { agent, counting } = await makeCountedAgent();
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
    const { agent, counting, store } = await makeCountedAgent();
    const createdAt = "2026-11-01T06:00:00.000Z";
    await store.save(goalToRecord(testGoal({ lastRun: createdAt }) as any));
    // Rewrite the stored createdAt to an older stamp than the save
    // would mint: the re-save must keep it, never reshuffle order.
    await store.save({
      ...goalToRecord(testGoal({ lastRun: createdAt }) as any),
      createdAt,
      updatedAt: createdAt,
    });
    counting.reset();
    await agent.onCron();
    expect(counting.counts.kindScan).toBe(1);
    expect((await store.listByKind("goal"))[0].createdAt).toBe(createdAt);
  });

  it("saveGoals with no snapshot still re-lists (fallback, never a break)", async () => {
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ id: "keep" }) as any));
    await store.save(goalToRecord(testGoal({ id: "drop" }) as any));
    const goals = await agent.listGoals();
    const kept = goals.filter((g: any) => g.id === "keep");
    counting.reset();
    await (agent as any).saveGoals(kept);
    // No snapshot passed: the fallback re-list finds "drop" in the
    // store and deletes it — removal sync preserved.
    expect(counting.counts.kindScan).toBe(1);
    expect((await store.listByKind("goal")).map((r) => r.id)).toEqual(["keep"]);
  });
});

describe("3124-P04 behavior parity", () => {
  it("same firing times: due fires, not-due does not, in one tick", async () => {
    const { agent, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ id: "due", lastRun: null }) as any));
    // Cron fires at 07:00, not yet — not due at the frozen 06:00,
    // with lastRun null so the assertion distinguishes stamped from
    // untouched without sharing a timestamp with the due goal.
    await store.save(goalToRecord(testGoal({ id: "not-due", cron: "0 7 * * *", lastRun: null }) as any));
    const tick = await agent.onCron();
    expect(tick.goalsEvaluated).toBe(2);
    expect(tick.jobsCreated).toBe(1);
    const goals = await agent.listGoals();
    expect(goals.find((g: any) => g.id === "due")?.lastRun).toBe("2026-11-03T06:00:00.000Z");
    expect(goals.find((g: any) => g.id === "not-due")?.lastRun).toBeNull();
  });

  it("same payloads: the fired goal's created job id rides the run record", async () => {
    const { agent, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ lastRun: null }) as any));
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
    // Issue #6101 — Autopilot reads its job feed from D1 now
    // (listD1JobOutcomes); the DO listJobOutcomes reader is gone.
    expect(autopilot).toContain("listD1JobOutcomes");
    expect(autopilot).not.toContain("SqlJobRunRecordStore");
    const workflowRuns = source("src/agents/routes/workflowRuns.ts");
    expect(workflowRuns).toContain("readWorkflowRunJobs");
    // Issue #6103 — Workflow Runs reads outcomes from D1 via the
    // run-ledger seam (listD1JobOutcomes), never the DO list.
    expect(workflowRuns).toContain("listD1JobOutcomes");
    expect(workflowRuns).not.toContain("listJobOutcomes");
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

  async function seedLedger(d1: MockD1Database, n: number): Promise<void> {
    // Issue #6101 — the ledger seed lands in D1; the EXPLAIN QUERY
    // PLAN pins below run against the mock binding's own SQLite.
    const store = new D1JobRunRecordStore(
      createD1JobRunRecordDb(d1 as unknown as D1Database),
    );
    for (let i = 0; i < n; i++) {
      const started = new Date(Date.now() - i * 60_000).toISOString();
      await store.record({
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

  it("listRecent walks the recent-read index, not the table", async () => {
    const d1 = new MockD1Database();
    await seedLedger(d1, 50);
    const p = plan(d1.sqlite, "SELECT * FROM job_run_records ORDER BY started DESC, id DESC LIMIT ?", 50);
    // Same index-walk shape as list(): "SCAN ... USING INDEX" in
    // started order, LIMIT stops the walk at 50 rows, no temp
    // b-tree. Before #3124: "SCAN job_run_records | USE TEMP
    // B-TREE FOR ORDER BY" — the whole table, sorted, per call.
    expect(p).toContain("USING INDEX job_run_records_recent_idx");
    expect(p).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("listByJob still walks job_idx (regression guard)", async () => {
    const d1 = new MockD1Database();
    await seedLedger(d1, 50);
    const p = plan(
      d1.sqlite,
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
    const { agent, counting, store } = await makeCountedAgent();
    await store.save(goalToRecord(testGoal({ id: "tick-goal", lastRun: new Date().toISOString() }) as any));
    await store.save(goalToRecord(testGoal({ id: "trig-goal", lastRun: null }) as any));
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
