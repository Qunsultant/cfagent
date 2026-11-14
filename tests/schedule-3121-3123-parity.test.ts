/**
 * Issue #3121 Phase 2 — #3123 reuse: one schedule store, one run
 * ledger, one management code path.
 *
 * RED first: these pins fail until the unified store, the unified
 * ledger, and the unified management service land. Pins assert
 * accounting — every member declared exactly once — not literal
 * sizes (gitops §5, #3917).
 *
 * - 3123-P01 one ScheduleStore port: kinds/states census.
 * - 3123-P02 store round-trip (in-memory + DO SQLite): kinds,
 *   states, clearPaused deletes paused rows only.
 * - 3123-P03 pause is record state: same record id across
 *   pause/resume; the SDK alarm id is a record field; zero live
 *   imports of the retired paused-store modules.
 * - 3123-P04 goals KV migrated: goal ↔ record round-trip; with a
 *   SQL-backed ScheduledAgent, goals persist in the store, not KV;
 *   without SQL the KV path still works (fallback, never a break).
 * - 3123-P05 one ledger write entry: recordLedgerRun is the only
 *   job_run_records write path; mergeLedgerRuns is newest-first
 *   with dedup; every buildJobRunRecord call site routes through it.
 * - 3123-P06 one merged read: listAllRuns hits /api/ledger/runs;
 *   the panels use it and nothing else for run history.
 * - 3123-P07 one management path: both route families delegate to
 *   the unified service; no direct schedule fetches in the panels.
 * - 3123-P08 scheduleApi retired: zero production imports; jobsApi
 *   exports the full moved wrapper set.
 * - 3123-P09 worker duties as records: one record per inventory
 *   cron (accounting), state disabled, crons stay OFF.
 * - 3123-P10 before/after counts: one unified table; zero live
 *   paused_schedules references; one ledger record route.
 * - 3123-P11 §9 map: B-T3-07 landed by #3123; new §9.8 rows all
 *   complete (S6-P01 rule).
 * - 3123-P12 scoping preserved: no mas_async_jobs / mas_job_outcomes
 *   writes from the unified path; D1 chain projection untouched.
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

vi.mock("../src/orchestrate", () => ({
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
}));

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

import {
  UNIFIED_SCHEDULES_TABLE,
  UNIFIED_SCHEDULE_KINDS,
  UNIFIED_SCHEDULE_STATES,
  type UnifiedScheduleKind,
  type UnifiedScheduleRecord,
} from "../src/data/unifiedSchedulePorts";
import { SqlUnifiedScheduleStore } from "../src/data/doSqliteUnifiedScheduleAdapter";
import { InMemoryUnifiedScheduleStore } from "../src/data/inMemoryUnifiedScheduleAdapter";
import {
  recordLedgerRun,
  mergeLedgerRuns,
} from "../src/services/unifiedLedger";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobRunRecord } from "../src/services/jobRunRecords";
import {
  goalToRecord,
  recordToGoal,
  workerDutiesFromInventory,
  pauseUnifiedSchedule,
  resumeUnifiedSchedule,
} from "../src/services/unifiedScheduleManagement";
import { WORKER_CRON_TRIGGERS_INVENTORY } from "../src/services/scheduleSystems";
import { resolveCronEntryPoint } from "../src/services/consolidatedCronEntries";
import {
  listAllRuns,
  listGoals,
  getTickHistory,
  addGoal,
  listOperations,
  listBuiltinGoals,
  addBuiltinGoals,
  addResourceGoals,
  RESOURCE_GOALS_PRESET,
  setGoalEnabled,
  triggerGoal,
  removeGoal,
} from "../src/client/jobsApi";
import { ScheduledAgent } from "../src/agents/scheduled-agent";

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

function liveSrcContaining(needle: string): string[] {
  return liveSrcFiles().filter((f) => {
    try {
      return readFileSync(join(REPO_ROOT, f), "utf8").includes(needle);
    } catch {
      return false;
    }
  });
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

function isoNow(): string {
  return new Date("2026-11-11T09:30:00Z").toISOString();
}

function screenRecord(overrides: Partial<UnifiedScheduleRecord> = {}): UnifiedScheduleRecord {
  return {
    id: "sched-1",
    kind: "screen",
    state: "active",
    callback: "autonomousMarketScreen",
    definition: {
      type: "cron",
      callback: "autonomousMarketScreen",
      cron: "30 7 * * 1-5",
      payload: { universe: "NASDAQ100" },
    },
    alarmId: "alarm-1",
    createdAt: isoNow(),
    updatedAt: isoNow(),
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
    createdAt: isoNow(),
    updatedAt: isoNow(),
    ...overrides,
  };
}

function runRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    system: "orchestrator-schedule",
    jobId: "job-1",
    operation: "autonomousMarketScreen",
    started: "2026-11-11T09:00:00.000Z",
    finished: "2026-11-11T09:00:01.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    ...overrides,
  };
}

describe("3123-P01 one ScheduleStore port (kinds/states census)", () => {
  it("declares exactly the six kinds and three states, each once", () => {
    expect([...UNIFIED_SCHEDULE_KINDS]).toEqual([
      "screen",
      "goal",
      "followup",
      "worker-duty",
      // Issue #3121 #3310 — the fifth kind: one workflow stage.
      "workflow-stage",
      // Issue #3121 #4237 — the sixth kind: the ticker-push live feed.
      "ticker-push",
    ]);
    // Issue #4351 — the fourth state: a deletion's tombstone. A declared task
    // the user deleted keeps its id here so the next declaration does not
    // re-create it (the list never renders it).
    expect([...UNIFIED_SCHEDULE_STATES]).toEqual([
      "active",
      "paused",
      "disabled",
      "deleted",
    ]);
    expect(UNIFIED_SCHEDULES_TABLE).toBe("unified_schedules");
    const port = source("src/data/unifiedSchedulePorts.ts");
    for (const kind of UNIFIED_SCHEDULE_KINDS as readonly string[]) {
      expect(port.split(`"${kind}"`).length - 1).toBe(1);
    }
    for (const state of UNIFIED_SCHEDULE_STATES as readonly string[]) {
      expect(port.split(`"${state}"`).length - 1).toBe(1);
    }
  });
});

describe("3123-P02 store round-trip (in-memory + DO SQLite)", () => {
  it("round-trips every kind through both adapters with kind/state reads", async () => {
    for (const makeStore of [
      () => new InMemoryUnifiedScheduleStore(),
      () => new InMemoryUnifiedScheduleStore(),
    ]) {
      const store = makeStore();
      await store.save(screenRecord());
      await store.save(goalRecord());
      await store.save({
        ...screenRecord({ id: "sched-2", state: "paused", pausedAt: isoNow() }),
      });
      expect((await store.get("sched-1"))?.state).toBe("active");
      expect((await store.listByKind("goal")).map((r) => r.id)).toEqual(["goal-1"]);
      expect((await store.listByState("paused")).map((r) => r.id)).toEqual(["sched-2"]);
      expect((await store.list()).map((r) => r.id).sort()).toEqual([
        "goal-1",
        "sched-1",
        "sched-2",
      ]);
      expect(await store.remove("sched-2")).toBe(true);
      expect(await store.remove("sched-2")).toBe(false);
    }
    const sql = new SqliteTestStorage();
    const store = new SqlUnifiedScheduleStore(sql as never);
    store.save(screenRecord());
    store.save(goalRecord());
    store.save(screenRecord({ id: "sched-2", state: "paused", pausedAt: isoNow() }));
    expect(store.get("sched-1")?.state).toBe("active");
    expect(store.listByKind("goal").map((r) => r.id)).toEqual(["goal-1"]);
    expect(store.listByState("paused").map((r) => r.id)).toEqual(["sched-2"]);
    expect(store.list().map((r) => r.id).sort()).toEqual(["goal-1", "sched-1", "sched-2"]);
  });

  it("clearPaused deletes paused rows only — live definitions survive", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(screenRecord());
    await store.save(screenRecord({ id: "sched-2", state: "paused", pausedAt: isoNow() }));
    await store.save(goalRecord());
    expect(await store.clearPaused()).toBe(1);
    expect((await store.list()).map((r) => r.id).sort()).toEqual(["goal-1", "sched-1"]);
    const sql = new SqliteTestStorage();
    const sqlStore = new SqlUnifiedScheduleStore(sql as never);
    sqlStore.save(screenRecord());
    sqlStore.save(screenRecord({ id: "sched-2", state: "paused", pausedAt: isoNow() }));
    expect(sqlStore.clearPaused()).toBe(1);
    expect(sqlStore.list().map((r) => r.id)).toEqual(["sched-1"]);
  });
});

describe("3123-P03 pause is record state", () => {
  it("pause/resume keep the record id; only the SDK alarm id changes", async () => {
    const store = new InMemoryUnifiedScheduleStore();
    await store.save(screenRecord());
    let alarmSeq = 1;
    const alarms = {
      list: async () => [{ id: "alarm-1", callback: "autonomousMarketScreen" }],
      get: async (id: string) =>
        id === "alarm-1" ? { id: "alarm-1", callback: "autonomousMarketScreen" } : undefined,
      cancel: async () => true,
      arm: async () => ({ id: `alarm-${++alarmSeq}`, callback: "autonomousMarketScreen" }),
    };
    const paused = await pauseUnifiedSchedule({ store, alarms }, "sched-1", isoNow());
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error("pause failed");
    expect(paused.record.id).toBe("sched-1");
    expect(paused.record.state).toBe("paused");
    expect(paused.record.pausedAt).toBe(isoNow());
    const resumed = await resumeUnifiedSchedule({ store, alarms }, "sched-1", isoNow());
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("resume failed");
    expect(resumed.record.id).toBe("sched-1");
    expect(resumed.record.state).toBe("active");
    expect(resumed.record.alarmId).toBe("alarm-2");
    expect(resumed.record.alarmId).not.toBe("alarm-1");
  });

  it("zero live imports of the retired paused-store modules", () => {
    for (const needle of [
      "pausedSchedulePorts",
      "doSqlitePausedScheduleAdapter",
      "inMemoryPausedScheduleAdapter",
      "SqlPausedScheduleStore",
      "PausedScheduleStore",
    ]) {
      expect(liveSrcContaining(needle)).toEqual([]);
    }
    // The declared exceptions are the retention registry
    // (src/privacy/privacyDsar.ts): it is keyed by table name, and
    // the legacy table still exists in deployed instances, so its
    // KEEP rule stays. That rule is a retention decision, not a
    // live read/write path — and, since #4282 P2b, the DO catalogue
    // (src/data/schemaComponent/doCatalogue.ts), which is the
    // statement's home: the deprecated adapter's CREATE now reads
    // its text from the catalogue entry, so the literal lives there
    // (the P2a precedent: the ORM catalogue is a declared literal
    // home for unified_schedules, see 3123-P10). No other live
    // file may name the table.
    expect(liveSrcContaining("paused_schedules")).toEqual([
      "src/data/schemaComponent/doCatalogue.ts",
      "src/privacy/privacyDsar.ts",
    ]);
  });
});

describe("3123-P04 goals KV migrated", () => {
  it("goal ↔ record round-trips; enabled maps to state", () => {
    const goal = {
      id: "goal-1",
      name: "Test goal",
      cron: "0 6 * * *",
      operation: "test.op",
      budgetCents: 1,
      enabled: true,
    };
    const record = goalToRecord(goal);
    expect(record.kind).toBe("goal");
    expect(record.state).toBe("active");
    expect(recordToGoal(record)).toEqual(goal);
    const disabled = goalToRecord({ ...goal, enabled: false });
    expect(disabled.state).toBe("paused");
    expect(recordToGoal(disabled)?.enabled).toBe(false);
  });

  it("with SQL storage, goals persist in the unified store, not KV", async () => {
    const kv = new Map<string, unknown>();
    const sql = new SqliteTestStorage();
    const ctx = {
      storage: {
        get: async (k: string) => (kv.has(k) ? kv.get(k) : undefined),
        put: async (k: string, v: unknown) => void kv.set(k, v),
        sql: sql as never,
      },
    };
    const agent = new ScheduledAgent(ctx as never, {} as never);
    await (agent as any).saveGoals([
      {
        id: "goal-1",
        name: "Test goal",
        cron: "0 6 * * *",
        operation: "test.op",
        budgetCents: 1,
        enabled: true,
      },
    ]);
    expect(kv.has("goals")).toBe(false);
    const goals = await (agent as any).listGoals();
    expect(goals.map((g: any) => g.id)).toEqual(["goal-1"]);
  });

  it("without SQL storage, the KV path still works (fallback, never a break)", async () => {
    const kv = new Map<string, unknown>();
    const ctx = {
      storage: {
        get: async (k: string) => (kv.has(k) ? kv.get(k) : undefined),
        put: async (k: string, v: unknown) => void kv.set(k, v),
      },
    };
    const agent = new ScheduledAgent(ctx as never, {} as never);
    const goal = {
      id: "goal-1",
      name: "Test goal",
      cron: "0 6 * * *",
      operation: "test.op",
      budgetCents: 1,
      enabled: true,
    };
    await (agent as any).saveGoals([goal]);
    expect(kv.get("goals")).toEqual([goal]);
    expect((await (agent as any).listGoals()).map((g: any) => g.id)).toEqual(["goal-1"]);
  });

  it("ScheduledAgent no longer writes the goals KV key when SQL storage exists", () => {
    const body = source("src/agents/scheduled-agent.ts");
    // Exactly two `put("goals"` writes, one per method, each inside
    // its no-SQL fallback branch: getGoals seeds the fallback key
    // only when empty, saveGoals persists the fallback key. The
    // store path never touches the KV key.
    const writes = body.split('put("goals"').length - 1;
    expect(writes).toBe(2);
    const getGoals = body.slice(
      body.indexOf("private async getGoals"),
      body.indexOf("private async saveGoals"),
    );
    const saveGoals = body.slice(body.indexOf("private async saveGoals"));
    for (const method of [getGoals, saveGoals]) {
      expect(method.split('put("goals"').length - 1).toBe(1);
      expect(method).toContain("if (!store)");
      // The put sits after the guard, inside the fallback branch.
      expect(method.indexOf('put("goals"')).toBeGreaterThan(
        method.indexOf("if (!store)"),
      );
    }
    expect(body).toContain("unified");
  });
});

describe("3123-P05 one ledger write entry", () => {
  it("recordLedgerRun builds, stores, and prunes through the one store", () => {
    const store = new InMemoryJobRunRecordStore();
    const built = recordLedgerRun(store, {
      system: "orchestrator-schedule",
      jobId: "job-1",
      operation: "autonomousMarketScreen",
      started: "2026-11-11T09:00:00.000Z",
      finished: "2026-11-11T09:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    expect(built.system).toBe("orchestrator-schedule");
    expect(store.listByJob("job-1")).toHaveLength(1);
  });

  it("mergeLedgerRuns is newest-first with dedup on jobId+started+operation", () => {
    const a = runRecord({ jobId: "job-1", started: "2026-11-11T09:00:00.000Z" });
    const b = runRecord({ jobId: "job-2", started: "2026-11-11T10:00:00.000Z" });
    const dup = runRecord({ jobId: "job-1", started: "2026-11-11T09:00:00.000Z" });
    const merged = mergeLedgerRuns([a], [b, dup]);
    expect(merged.map((r) => r.jobId)).toEqual(["job-2", "job-1"]);
  });

  it("every DO-SQLite ledger write site routes through recordLedgerRun (accounting)", () => {
    // The three DO-SQLite write sites (W-1/W-2 callback recorder,
    // W-5 orchestrator watchdog, W-6 pipeline recorder seam) call
    // the one entry; no `store.record(` on a JobRunRecordStore
    // survives outside unifiedLedger.ts itself.
    for (const file of [
      "src/agents/orchestrator/scheduleCallbackRunRecords.ts",
      "src/agents/orchestrator/scheduleWatchdog.ts",
      "src/services/jobPipelineEngine.ts",
    ]) {
      const body = source(file);
      expect(body).toContain("recordLedgerRun");
      expect(body).not.toContain("store.record(");
    }
    // The ScheduledAgent KV write is the fallback only (one site).
    const agentBody = source("src/agents/scheduled-agent.ts");
    expect(agentBody.split('put("jobRunRecords"').length - 1).toBe(1);
    // No second INSERT into job_run_records outside the DO adapter
    // and the D1 pipeline residency (filed #4124).
    const inserters = liveSrcContaining("INSERT INTO job_run_records").filter(
      (f) =>
        !f.endsWith("src/data/doSqliteJobRunRecordAdapter.ts") &&
        !f.includes("d1JobRunRecord"),
    );
    expect(inserters).toEqual([]);
  });
});

describe("3123-P06 one merged read", () => {
  it("listAllRuns hits the one merged endpoint", async () => {
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any) => {
      calls.push(String(input));
      return { ok: true, json: async () => ({ ok: true, runs: [] }) } as any;
    };
    try {
      await listAllRuns();
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(calls).toEqual(["/api/ledger/runs?limit=50"]);
  });

  it("the panels use the one merged read and nothing else for run history", () => {
    for (const panel of [
      "src/client/ScheduleRunLedgerPanel.tsx",
      "src/client/JobsPanel.tsx",
      "src/client/ScheduledGoalsPanel.tsx",
    ]) {
      const body = source(panel);
      expect(body).toContain("listAllRuns");
      expect(body).not.toContain("listGoalRuns(");
      expect(body).not.toContain("listScheduleRuns(");
    }
  });
});

describe("3123-P07 one management path", () => {
  it("both route families delegate to the unified service", () => {
    expect(source("src/agents/routes/schedules.ts")).toContain("unifiedScheduleManagement");
    expect(source("src/agents/routes/schedules.ts")).not.toContain("pausedStore()");
    expect(source("src/agents/routes/schedules.ts")).not.toContain("pausedRecordToListItem");
    expect(source("src/agents/scheduled-agent.ts")).toContain("unifiedScheduleManagement");
  });

  it("the panels make no direct schedule fetches", () => {
    for (const panel of [
      "src/client/SchedulesPanel.tsx",
      "src/client/ScheduledOptionsManager.tsx",
    ]) {
      const body = source(panel);
      expect(body).not.toMatch(/fetch\(`\/api\/schedules/);
      expect(body).not.toMatch(/fetch\("\/api\/schedules/);
      expect(body).not.toMatch(/fetch\(`\/api\/schedule\//);
      expect(body).not.toMatch(/fetch\("\/api\/schedule\//);
    }
  });
});

describe("3123-P08 scheduleApi retired", () => {
  it("zero production imports of scheduleApi; jobsApi exports the full set", () => {
    expect(liveSrcContaining('"./scheduleApi"')).toEqual([]);
    expect(liveSrcContaining('"../scheduleApi"')).toEqual([]);
    // The imports above prove the moved names exist on jobsApi.
    expect(typeof listGoals).toBe("function");
    expect(typeof getTickHistory).toBe("function");
    expect(typeof addGoal).toBe("function");
    expect(typeof listOperations).toBe("function");
    expect(typeof listBuiltinGoals).toBe("function");
    expect(typeof addBuiltinGoals).toBe("function");
    expect(typeof addResourceGoals).toBe("function");
    expect(Array.isArray(RESOURCE_GOALS_PRESET)).toBe(true);
    expect(typeof setGoalEnabled).toBe("function");
    expect(typeof triggerGoal).toBe("function");
    expect(typeof removeGoal).toBe("function");
    expect(typeof listAllRuns).toBe("function");
  });
});

describe("3123-P09 worker duties as records", () => {
  it("one record per inventory cron (accounting), kind worker-duty, state disabled", () => {
    const duties = workerDutiesFromInventory(isoNow());
    expect(duties).toHaveLength(WORKER_CRON_TRIGGERS_INVENTORY.length);
    const crons = duties.map((d) => (d.definition as { cron: string }).cron).sort();
    expect(crons).toEqual([...WORKER_CRON_TRIGGERS_INVENTORY].sort());
    for (const duty of duties) {
      expect(duty.kind).toBe("worker-duty");
      expect(duty.state).toBe("disabled");
    }
    for (const cron of WORKER_CRON_TRIGGERS_INVENTORY) {
      expect(resolveCronEntryPoint(cron)).toBeTruthy();
    }
  });

  it("Worker crons stay OFF: wrangler.jsonc has no uncommented triggers", () => {
    const wrangler = source("wrangler.jsonc");
    const uncommented = wrangler
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && line.includes('"crons"'));
    expect(uncommented).toEqual([]);
  });
});

describe("3123-P10 before/after counts", () => {
  it("one unified table; zero live paused_schedules references; one ledger record route", () => {
    // The table-name literal lives in exactly seven declared places:
    // the port const (the definition), the maintenance wipe surface
    // (route + client table list, keyed by table name), the
    // retention registry (keyed by table name), and — since #4282 P2a
    // — the ORM catalogue (src/data/schemaComponent/ormCatalogue.ts),
    // whose unified-schedules index entry names the table in its
    // `table` field, and — since #4282 P2b — the DO catalogue
    // (src/data/schemaComponent/doCatalogue.ts), whose
    // unified-schedules table + index entries name the table in
    // their `table` fields and codes. (The index-schema module the
    // ORM entry replaced referenced the table only via the
    // UNIFIED_SCHEDULES_TABLE const, so the literal did not live
    // there.) Adapters reference the const, never the literal.
    const literalHomes = liveSrcFiles()
      .filter((f) =>
        readFileSync(join(REPO_ROOT, f), "utf8").includes('"unified_schedules"'),
      )
      .sort();
    expect(literalHomes).toEqual([
      "src/agents/routes/maintenance.ts",
      "src/client/AdminQueueWipePanel.tsx",
      "src/client/adminQueueApi.ts",
      "src/data/schemaComponent/doCatalogue.ts",
      "src/data/schemaComponent/ormCatalogue.ts",
      "src/data/unifiedSchedulePorts.ts",
      "src/privacy/privacyDsar.ts",
    ]);
    expect(source("src/data/doSqliteUnifiedScheduleAdapter.ts")).toContain(
      "UNIFIED_SCHEDULES_TABLE",
    );
    // Zero live paused_schedules references outside the retention
    // registry (see 3123-P09) and the DO catalogue (see 3123-P03):
    // the registry is keyed by table name and the legacy table still
    // exists in deployed instances; the catalogue is the statement's
    // home since #4282 P2b.
    expect(liveSrcContaining("paused_schedules")).toEqual([
      "src/data/schemaComponent/doCatalogue.ts",
      "src/privacy/privacyDsar.ts",
    ]);
    expect(liveSrcContaining("/schedules/runs/record")).toEqual([
      "src/agents/routes/schedules.ts",
      "src/services/unifiedLedger.ts",
    ]);
  });
});

describe("3123-P11 §9 map", () => {
  function section9(): string {
    const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
    return doc.slice(doc.indexOf("## 9. Capability-coverage map"));
  }

  it("B-T3-07 is landed by #3123 and the §9.8 rows are all complete", () => {
    const s9 = section9();
    expect(s9).toContain("B-T3-07");
    const bT307 = s9
      .split("\n")
      .find((line) => line.includes("B-T3-07") && line.includes("Goal store"));
    expect(bT307).toContain("#3123 — landed");
    const s98 = s9.slice(s9.indexOf("### 9.8"));
    expect(s98.length).toBeGreaterThan(0);
    const rows = s98
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|").slice(1, -1).map((c) => c.trim()))
      .filter((c) => c.length >= 4 && c[0] !== "Capability" && !c[0].startsWith("---"));
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      expect(cells[3]).toMatch(/landed|Filed #\d+ \(open\)/);
    }
  });
});

describe("3123-P12 scoping preserved", () => {
  it("the unified path writes no mas_async_jobs / mas_job_outcomes rows", () => {
    // Intent, not literal absence: the scoping decision IS recorded
    // in these files' header comments (the tables stay the async-job
    // execution record / outcome sink), so the pin asserts no WRITE
    // statement names either table — no INSERT/UPDATE/DELETE/REPLACE.
    const writeVerbs = ["INSERT INTO", "UPDATE", "DELETE FROM", "REPLACE INTO"];
    for (const file of [
      "src/services/unifiedLedger.ts",
      "src/services/unifiedScheduleManagement.ts",
      "src/data/unifiedSchedulePorts.ts",
      "src/data/doSqliteUnifiedScheduleAdapter.ts",
    ]) {
      const body = source(file);
      for (const table of ["mas_async_jobs", "mas_job_outcomes"]) {
        for (const verb of writeVerbs) {
          expect(body).not.toContain(`${verb} ${table}`);
        }
      }
      // The scoping decision is documented where it is decided (the
      // ledger service and the port), not silently dropped.
      if (
        file === "src/services/unifiedLedger.ts" ||
        file === "src/data/unifiedSchedulePorts.ts"
      ) {
        expect(body).toContain("mas_async_jobs");
        expect(body).toContain("mas_job_outcomes");
      }
    }
  });

  it("the D1 chain projection is untouched (still the projection, not the store)", () => {
    const body = source("src/data/d1ChainScheduleAdapter.ts");
    expect(body).toContain("D1ChainScheduleAdapter");
    expect(liveSrcContaining("unified_schedules")).not.toContain(
      "src/data/d1ChainScheduleAdapter.ts",
    );
  });

  it("no new schedule kinds beyond the six", () => {
    expect(UNIFIED_SCHEDULE_KINDS).toHaveLength(6);
    const kinds = new Set<string>(UNIFIED_SCHEDULE_KINDS as unknown as string[]);
    expect(kinds.has("screen")).toBe(true);
    expect(kinds.has("goal")).toBe(true);
    expect(kinds.has("followup")).toBe(true);
    expect(kinds.has("worker-duty")).toBe(true);
    expect(kinds.has("workflow-stage")).toBe(true);
    expect(kinds.has("ticker-push")).toBe(true);
  });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T09:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
