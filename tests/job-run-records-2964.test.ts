/**
 * Issue #2964 — unified Jobs UI + per-run result store.
 *
 * RED first: these tests fail until the record shape, the stores,
 * the ScheduledAgent run recording, and the orchestrator runs routes
 * land. Nothing here asserts on another issue's surface.
 *
 * Coverage:
 * - the pure record builder (validation: a failure without error text
 *   and a skip without a reason are rejected — a silent skip or a
 *   silent failure must be unrepresentable, not just discouraged);
 * - the per-job cap prune (newest-first, deterministic on ties);
 * - the in-memory store and the DO-SQLite store round-trips
 *   (node:sqlite double, same shape as the #2337 conformance file);
 * - ScheduledAgent: a fired goal, a skipped goal, and a failed goal
 *   each leave exactly one stored per-run record with the right
 *   outcome, and triggerGoal records triggeredBy "manual";
 * - orchestrator runs routes: list + per-schedule history + the
 *   creatable-callback catalog, matched before get-by-id.
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
  etradeIdentityFromLogin: vi.fn(async () => ({})),
}));

import { createJob } from "../src/orchestrate";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  buildJobRunRecord,
  pruneJobRuns,
  resolveScheduleRunJobId,
  resolveScheduleRunTrigger,
  SCHEDULED_AGENT_JOB_RUN_CAP,
  type JobRunRecord,
} from "../src/services/jobRunRecords";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";
import {
  JOB_RUN_RECORD_FIELDS,
  SCHEDULE_UNIFICATION_ANSWERS,
  SCHEDULE_UNIFICATION_CARRIED,
  UNIFIED_JOBS_UI,
} from "../src/services/scheduleSystems";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";

/** node:sqlite double for the SqlStorage seam (same shape as #2337). */
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

function makeCtx(initialGoals?: any[]) {
  const store = new Map<string, unknown>();
  if (initialGoals) store.set("goals", initialGoals);
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    _store: store,
  };
}

/**
 * Issue #6503 — the fixture goal is planted in the D1 schedule
 * store, not the DO KV "goals" key (which the agent no longer
 * reads). Planting exactly one goal keeps each tick isolated: an
 * empty store would re-seed all nine built-in goals. Same pattern
 * as tests/index_list_goals_scheduled_1980.test.ts.
 */
async function plantGoals(mockD1: MockD1Database, goals: Array<Record<string, unknown>>) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  for (const goal of goals) {
    await store.save(goalToRecord(goal as never));
  }
  // The D1 store seeds the nine built-in goal rows on first use, so
  // a planted fixture alone is not the whole store: a built-in due
  // at the test's clock fires too (daily-qa-sweep shares the 06:00
  // cron, so the fired-goal tick would create 2 jobs, not 1).
  // Remove the seeded rows, keeping only the fixture goal(s) —
  // same cleanup as tests/schedules_create_route.test.ts. The
  // store stays non-empty, so the empty-store re-seed does not fire.
  const keep = new Set(goals.map((goal) => String(goal.id)));
  for (const row of await store.listByKind("goal")) {
    if (!keep.has(row.id)) await store.remove(row.id);
  }
}

function makeEnv(mockD1?: MockD1Database) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
    ...(mockD1 ? { AGENT_DB: mockD1 } : {}),
  };
}

function testGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-goal",
    name: "Test goal",
    // Historical UTC isDue path: concrete minute/hour only ("*" maps
    // to NaN and is never due, by design). 06:00 UTC matches the
    // mocked clock in the tests below.
    cron: "0 6 * * *",
    operation: "test.op",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("job run record shape (#2964)", () => {
  it("builds a success record with descriptor and artifact refs", () => {
    const record = buildJobRunRecord({
      system: "scheduled-agent-goal",
      jobId: "test-goal",
      operation: "test.op",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      descriptor: "job:job_test_1",
      artifactRefs: ["pdf-key-1"],
    });
    expect(record.system).toBe("scheduled-agent-goal");
    expect(record.descriptor).toBe("job:job_test_1");
    expect(record.artifactRefs).toEqual(["pdf-key-1"]);
  });

  it("carries the bound-account tuple on the record when present (#5100)", () => {
    const record = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "s",
      operation: "autonomousMarketScreen",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
      accountType: "stock",
      accountId: "PA-900",
      bindingScope: "schedule",
      bindingSource: "binding",
    });
    expect(record.accountType).toBe("stock");
    expect(record.accountId).toBe("PA-900");
    expect(record.bindingScope).toBe("schedule");
    expect(record.bindingSource).toBe("binding");
  });

  it("omits the bound-account tuple when absent (#5100)", () => {
    const record = buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "s",
      operation: "runPipelineJobSchedule",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    });
    expect(record.accountType).toBeUndefined();
    expect(record.accountId).toBeUndefined();
    expect(record.bindingScope).toBeUndefined();
    expect(record.bindingSource).toBeUndefined();
  });

  it("rejects a failure without error text", () => {
    expect(() =>
      buildJobRunRecord({
        system: "scheduled-agent-goal",
        jobId: "g",
        operation: "test.op",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:01.000Z",
        outcome: "failure",
        triggeredBy: "scheduled",
      }),
    ).toThrow(/error/);
  });

  it("rejects a skip without a reason", () => {
    expect(() =>
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: "s",
        operation: "autonomousMarketScreen",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:01.000Z",
        outcome: "skipped",
        triggeredBy: "scheduled",
      }),
    ).toThrow(/detail/);
  });

  it("rejects a finished-before-started record", () => {
    expect(() =>
      buildJobRunRecord({
        system: "scheduled-agent-goal",
        jobId: "g",
        operation: "test.op",
        started: "2026-11-03T00:00:01.000Z",
        finished: "2026-11-03T00:00:00.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
      }),
    ).toThrow(/finished/);
  });

  it("prunes to the cap, newest first", () => {
    const records = [3, 2, 1].map(
      (n) =>
        buildJobRunRecord({
          system: "scheduled-agent-goal",
          jobId: "g",
          operation: "test.op",
          started: `2026-11-03T00:00:0${n}.000Z`,
          finished: `2026-11-03T00:00:0${n}.000Z`,
          outcome: "success",
          triggeredBy: "scheduled",
        }),
    );
    expect(pruneJobRuns(records, 2).map((r) => r.started)).toEqual([
      "2026-11-03T00:00:03.000Z",
      "2026-11-03T00:00:02.000Z",
    ]);
  });

  it("resolves the schedule run job id: schedule, then payload, then callback fallback", () => {
    expect(
      resolveScheduleRunJobId("autonomousMarketScreen", { scheduleId: "payload-id" }, { id: "sdk-id" }),
    ).toBe("sdk-id");
    expect(resolveScheduleRunJobId("autonomousMarketScreen", { scheduleId: "payload-id" }, undefined)).toBe(
      "payload-id",
    );
    expect(resolveScheduleRunJobId("autonomousMarketScreen", {}, undefined)).toBe(
      "callback:autonomousMarketScreen",
    );
  });

  it("resolves the trigger: manual only when the payload says so", () => {
    expect(resolveScheduleRunTrigger({ trigger: "manual" })).toBe("manual");
    expect(resolveScheduleRunTrigger({ trigger: "scheduled" })).toBe("scheduled");
    expect(resolveScheduleRunTrigger({})).toBe("scheduled");
    expect(resolveScheduleRunTrigger(undefined)).toBe("scheduled");
  });

  it("caps the ScheduledAgent record list", () => {
    expect(SCHEDULED_AGENT_JOB_RUN_CAP).toBeGreaterThan(0);
  });
});

describe("job run record stores (#2964)", () => {
  function sampleRecord(jobId: string, started: string): JobRunRecord {
    return buildJobRunRecord({
      system: "orchestrator-schedule",
      jobId,
      operation: "autonomousMarketScreen",
      started,
      finished: started,
      outcome: "success",
      triggeredBy: "scheduled",
      descriptor: "screen ok",
    });
  }

  it("in-memory store: newest-first per job, latest, recent across jobs", () => {
    const store = new InMemoryJobRunRecordStore();
    store.record(sampleRecord("s1", "2026-11-03T00:00:01.000Z"));
    store.record(sampleRecord("s1", "2026-11-03T00:00:02.000Z"));
    store.record(sampleRecord("s2", "2026-11-03T00:00:03.000Z"));
    expect(store.listByJob("s1").map((r) => r.started)).toEqual([
      "2026-11-03T00:00:02.000Z",
      "2026-11-03T00:00:01.000Z",
    ]);
    expect(store.latestByJob("s1")?.started).toBe("2026-11-03T00:00:02.000Z");
    expect(store.listRecent(2).map((r) => r.jobId)).toEqual(["s2", "s1"]);
    expect(store.latestByJob("missing")).toBeUndefined();
  });

  it("SQL store: round-trip, ordering, per-job cap, failure text", () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    store.record(sampleRecord("s1", "2026-11-03T00:00:01.000Z"));
    store.record(sampleRecord("s1", "2026-11-03T00:00:02.000Z"));
    store.record(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: "s1",
        operation: "autonomousMarketScreen",
        started: "2026-11-03T00:00:03.000Z",
        finished: "2026-11-03T00:00:03.000Z",
        outcome: "failure",
        triggeredBy: "manual",
        error: "screen blew up",
      }),
    );
    const runs = store.listByJob("s1");
    expect(runs.map((r) => r.started)).toEqual([
      "2026-11-03T00:00:03.000Z",
      "2026-11-03T00:00:02.000Z",
      "2026-11-03T00:00:01.000Z",
    ]);
    expect(runs[0].outcome).toBe("failure");
    expect(runs[0].error).toBe("screen blew up");
    expect(runs[0].triggeredBy).toBe("manual");
    expect(store.latestByJob("s1")?.started).toBe("2026-11-03T00:00:03.000Z");
  });

  it("a skipped callback run persists its detail code and its firing tuple (#5100)", async () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      { userLogin: "alice", brokerId: "etrade", mode: "paper", accountType: "stock", accountId: "ET-GONE" },
      { id: "sched-5100" },
      async () => ({ outcome: "skipped", detail: "FAILURE_ACCOUNT_UNKNOWN" }),
    );
    const runs = store.listByJob("sched-5100");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail).toBe("FAILURE_ACCOUNT_UNKNOWN");
    expect(runs[0].accountType).toBe("stock");
    expect(runs[0].accountId).toBe("ET-GONE");
  });
});

describe("ScheduledAgent per-run records (#2964)", () => {
  it("a fired goal leaves one success record with the created job id", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [testGoal()]);
    const ctx = makeCtx();
    const env = makeEnv(mockD1);
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsCreated).toBe(1);
    const runs = await agent.listJobRuns("test-goal");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");
    expect(runs[0].descriptor).toBe("job:job_test_1");
    expect(runs[0].triggeredBy).toBe("scheduled");
    expect(runs[0].system).toBe("scheduled-agent-goal");
    expect(runs[0].operation).toBe("test.op");
  });

  it("a skipped goal leaves one skipped record with its reason, never silent", async () => {
    vi.setSystemTime(new Date("2026-11-03T03:00:00Z"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [
      testGoal({ id: "index-refresh-holdings", operation: "index.refresh_holdings", cron: "0 3 * * *" }),
    ]);
    const ctx = makeCtx();
    const env = makeEnv(mockD1);
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsSkipped).toBe(1);
    const runs = await agent.listJobRuns("index-refresh-holdings");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("skipped");
    expect(runs[0].detail).toMatch(/holdings fetcher not bound/);
  });

  it("a failed goal leaves one failure record with the error text", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    vi.mocked(createJob).mockRejectedValueOnce(new Error("orchestrator down"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [testGoal()]);
    const ctx = makeCtx();
    const env = makeEnv(mockD1);
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsSkipped).toBe(1);
    const runs = await agent.listJobRuns("test-goal");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("failure");
    expect(runs[0].error).toMatch(/orchestrator down/);
  });

  it("triggerGoal records triggeredBy manual and latest resolves", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [testGoal()]);
    const ctx = makeCtx();
    const env = makeEnv(mockD1);
    const agent = new ScheduledAgent(ctx as never, env as never);
    await agent.triggerGoal("test-goal");
    const latest = await agent.getLatestJobRun("test-goal");
    expect(latest?.triggeredBy).toBe("manual");
    expect(latest?.outcome).toBe("success");
  });

  it("a disabled, not-due goal leaves no record", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const mockD1 = new MockD1Database();
    await plantGoals(mockD1, [testGoal({ enabled: false })]);
    const ctx = makeCtx();
    const env = makeEnv(mockD1);
    const agent = new ScheduledAgent(ctx as never, env as never);
    await agent.onCron(env as never, { halted: false } as never);
    expect(await agent.listJobRuns("test-goal")).toHaveLength(0);
  });
});

describe("unified jobs inventory (#2964)", () => {
  it("lists three sections with cron triggers read-only", () => {
    expect(UNIFIED_JOBS_UI.panel).toBe("JobsPanel");
    expect(UNIFIED_JOBS_UI.sections.map((s) => s.id)).toEqual([
      "scheduled-agent-goals",
      "orchestrator-schedules",
      "worker-cron-triggers",
    ]);
    const cronSection = UNIFIED_JOBS_UI.sections.find((s) => s.id === "worker-cron-triggers");
    expect(cronSection?.editable).toBe(false);
    expect(UNIFIED_JOBS_UI.sections.filter((s) => s.editable)).toHaveLength(2);
  });

  it("record fields cover the stored shape", () => {
    expect(JOB_RUN_RECORD_FIELDS).toContain("system");
    expect(JOB_RUN_RECORD_FIELDS).toContain("jobId");
    expect(JOB_RUN_RECORD_FIELDS).toContain("outcome");
    expect(JOB_RUN_RECORD_FIELDS).toContain("error");
    expect(JOB_RUN_RECORD_FIELDS).toContain("descriptor");
    expect(JOB_RUN_RECORD_FIELDS).toContain("artifactRefs");
  });

  it("answers name the unified surface and carried names the framework-sweep gap (#3788)", () => {
    const questions = SCHEDULE_UNIFICATION_ANSWERS.map((a) => a.question);
    expect(questions).toContain("What does the unified Jobs UI list?");
    expect(questions).toContain("What does a per-run job record contain?");
    expect(questions).toContain("Which firings leave a per-run record?");
    const carried = SCHEDULE_UNIFICATION_CARRIED.map((c) => c.question);
    // Issue #3788 resolved the internal-callback gap (the four now
    // record their own runs); the remaining named gap is the
    // framework sweep callbacks.
    expect(carried).toContain("Do SDK firings of framework sweep callbacks leave per-run records?");
  });
});

/**
 * Issue #6503 step 8 (G1) — the trigger route is a control op, so
 * the fixture calls it as a platform-admin. Alias KV +
 * membership store stubs, same shape as
 * tests/bulk_schedules_routes_5878.test.ts.
 */
const ADMIN_LOGIN = "venus-admin";
const ADMIN_USER_ID = "user-admin-1";

function stubKv(entries: Record<string, string>) {
  const store = new Map<string, string>();
  for (const [login, userId] of Object.entries(entries)) {
    store.set(`iaaa-alias:login:${login}`, JSON.stringify({ internalUserId: userId }));
  }
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

function stubMembershipStore(adminIds: string[]) {
  return {
    getMembershipsByUser: async (internalUserId: string) =>
      adminIds.includes(internalUserId)
        ? [
            {
              membershipId: "m-admin-1",
              internalUserId,
              tenantId: "platform",
              roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "test" }],
              createdBy: "test",
              createdAtMs: 1,
            },
          ]
        : [],
    put: async () => {},
    revokeMembership: async () => false,
  };
}

describe("orchestrator runs routes (#2964)", () => {
  function baseCtx(overrides: Partial<SchedulesRouteContext> = {}): SchedulesRouteContext {
    const storage = new SqliteTestStorage();
    return {
      // Issue #6503 — the unified store is D1 only (fail-closed):
      // the trigger route builds it for the gate and the dispatch,
      // so an unbound AGENT_DB 500s after the gate.
      env: { AGENT_DB: new MockD1Database() },
      agentCtx: { storage: { sql: storage.sql as never } } as never,
      audit: vi.fn(),
      // Issue #6503 step 9 (G2) — the trigger route audits
      // before it writes through this store; without it the
      // wired fallback (no SESSION_STORE in tests) blocks the
      // trigger with 503.
      auditStore: createMemoryAuditStore(),
      listSchedules: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => true),
      getScheduleById: vi.fn(async () => undefined),
      schedule: vi.fn(async () => ({ id: "sched-1" })),
      scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
      getScreenerExecutionContext: vi.fn(async () => undefined),
      getOrm: vi.fn(() => ({})),
      autonomousMarketScreen: vi.fn(async () => undefined),
      autoRenewETradeTokens: vi.fn(async () => undefined),
      creatableScheduleCallbacks: ["autonomousOptionsAnalysis", "autonomousMarketScreen"],
      accountScopedScheduleCallbacks: new Set(["autonomousOptionsAnalysis", "autonomousMarketScreen"]),
      runScheduleCallback: vi.fn(async () => undefined),
      flagAliasKv: stubKv({ [ADMIN_LOGIN]: ADMIN_USER_ID }),
      flagMembershipStore: stubMembershipStore([ADMIN_USER_ID]),
      ...overrides,
    } as unknown as SchedulesRouteContext;
  }

  async function call(ctx: SchedulesRouteContext, path: string, method = "GET") {
    return handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, {
        method,
        // Issue #6503 step 8 (G1) — the trigger route is a control
        // op: no identity answers 401, so the fixture calls as
        // the platform-admin (see above).
        headers: { "x-user-login": ADMIN_LOGIN },
      }),
      new URL(`https://agent.internal${path}`),
      path,
      "session-1",
      ctx,
    );
  }

  it("GET /schedules/runs lists recent runs across schedules", async () => {
    const ctx = baseCtx();
    const store = new SqlJobRunRecordStore(
      (ctx.agentCtx as any).storage.sql as never,
    );
    store.record(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: "sched-9",
        operation: "autonomousMarketScreen",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:00.000Z",
        outcome: "success",
        triggeredBy: "scheduled",
      }),
    );
    const res = await call(ctx, "/schedules/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].jobId).toBe("sched-9");
  });

  it("GET /schedules/:id/runs returns that schedule's history, not the get-by-id 404", async () => {
    const ctx = baseCtx();
    const store = new SqlJobRunRecordStore(
      (ctx.agentCtx as any).storage.sql as never,
    );
    store.record(
      buildJobRunRecord({
        system: "orchestrator-schedule",
        jobId: "sched-9",
        operation: "autonomousMarketScreen",
        started: "2026-11-03T00:00:00.000Z",
        finished: "2026-11-03T00:00:00.000Z",
        outcome: "failure",
        triggeredBy: "manual",
        error: "boom",
      }),
    );
    const res = await call(ctx, "/schedules/sched-9/runs");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].error).toBe("boom");
  });

  it("GET /schedules/callbacks returns the creatable allow-list", async () => {
    const ctx = baseCtx();
    const res = await call(ctx, "/schedules/callbacks");
    expect(res?.status).toBe(200);
    const data = (await res?.json()) as any;
    expect(data.callbacks).toEqual(["autonomousOptionsAnalysis", "autonomousMarketScreen"]);
  });

  it("triggering a non-creatable callback records an invocation-level run", async () => {
    const ctx = baseCtx({
      getScheduleById: vi.fn(async () => ({
        id: "sched-9",
        // A framework sweep callback: non-creatable, no recording
        // wrapper of its own, so the route records the invocation.
        // (Issue #3788: collectIvHistory is now self-recording, so it
        // no longer exercises this branch — see the next test.)
        callback: "sweepStaleAsyncJobs",
        payload: {},
        type: "cron",
      })),
    });
    const res = await call(ctx, "/schedules/sched-9/trigger", "POST");
    expect(res?.status).toBe(200);
    const store = new SqlJobRunRecordStore(
      (ctx.agentCtx as any).storage.sql as never,
    );
    const runs = store.listByJob("sched-9");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");
    // Issue #6503 — a Run-now click is a "triggered" dispatch
    // (#5028/#3214), not a manual one-off: the trigger route
    // stamps trigger "triggered" on the firing payload.
    expect(runs[0].triggeredBy).toBe("triggered");
  });

  it("triggering a self-recording internal callback records exactly once (#3788)", async () => {
    const ctx = baseCtx({
      getScheduleById: vi.fn(async () => ({
        id: "sched-9",
        callback: "collectIvHistory",
        payload: {},
        type: "cron",
      })),
    });
    // Simulate the real method wrapper: it records the run itself
    // through recordScheduleCallbackRun, so the route must not add
    // a second invocation-level record.
    ctx.runScheduleCallback = vi.fn(async (callback: string, payload: unknown) => {
      await recordScheduleCallbackRun(
        (ctx.agentCtx as any).storage.sql as never,
        callback,
        payload,
        { id: "sched-9" },
        async () => ({ outcome: "success", descriptor: "collect IV history" }),
      );
    });
    const res = await call(ctx, "/schedules/sched-9/trigger", "POST");
    expect(res?.status).toBe(200);
    const store = new SqlJobRunRecordStore(
      (ctx.agentCtx as any).storage.sql as never,
    );
    const runs = store.listByJob("sched-9");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");
    expect(runs[0].descriptor).toBe("collect IV history");
    // Issue #6503 — Run-now is a "triggered" dispatch, not manual
    // (see the non-creatable test above).
    expect(runs[0].triggeredBy).toBe("triggered");
  });

  it("3394-P04: triggering each other self-recording internal callback records exactly once", async () => {
    for (const [callback, descriptor] of [
      ["executeAsyncJob", "async job executed"],
      ["expireStaleOrderDraft", "stale order draft expired"],
      ["autoRenewETradeTokens", "E*TRADE tokens renewed"],
    ] as const) {
      const ctx = baseCtx({
        getScheduleById: vi.fn(async () => ({
          id: "sched-9",
          callback,
          payload: {},
          type: "cron",
        })),
      });
      // Simulate the real method wrapper: it records the run itself
      // through recordScheduleCallbackRun, so the route must not add
      // a second invocation-level record.
      ctx.runScheduleCallback = vi.fn(async (cb: string, payload: unknown) => {
        await recordScheduleCallbackRun(
          (ctx.agentCtx as any).storage.sql as never,
          cb,
          payload,
          { id: "sched-9" },
          async () => ({ outcome: "success", descriptor }),
        );
      });
      const res = await call(ctx, "/schedules/sched-9/trigger", "POST");
      expect(res?.status).toBe(200);
      const store = new SqlJobRunRecordStore(
        (ctx.agentCtx as any).storage.sql as never,
      );
      const runs = store.listByJob("sched-9");
      expect(runs).toHaveLength(1);
      expect(runs[0].outcome).toBe("success");
      expect(runs[0].descriptor).toBe(descriptor);
      // Issue #6503 — Run-now is a "triggered" dispatch, not manual
      // (see the non-creatable test above).
      expect(runs[0].triggeredBy).toBe("triggered");
    }
  });

  it("triggering a missing schedule 404s and records nothing", async () => {
    const ctx = baseCtx();
    const res = await call(ctx, "/schedules/nope/trigger", "POST");
    expect(res?.status).toBe(404);
    const store = new SqlJobRunRecordStore(
      (ctx.agentCtx as any).storage.sql as never,
    );
    expect(store.listByJob("nope")).toHaveLength(0);
  });
});
