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

function makeEnv() {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
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
});

describe("ScheduledAgent per-run records (#2964)", () => {
  it("a fired goal leaves one success record with the created job id", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const ctx = makeCtx([testGoal()]);
    const env = makeEnv();
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
    const ctx = makeCtx([
      testGoal({ id: "index-refresh-holdings", operation: "index.refresh_holdings", cron: "0 3 * * *" }),
    ]);
    const env = makeEnv();
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
    const ctx = makeCtx([testGoal()]);
    const env = makeEnv();
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
    const ctx = makeCtx([testGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    await agent.triggerGoal("test-goal");
    const latest = await agent.getLatestJobRun("test-goal");
    expect(latest?.triggeredBy).toBe("manual");
    expect(latest?.outcome).toBe("success");
  });

  it("a disabled, not-due goal leaves no record", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const ctx = makeCtx([testGoal({ enabled: false })]);
    const env = makeEnv();
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

describe("orchestrator runs routes (#2964)", () => {
  function baseCtx(overrides: Partial<SchedulesRouteContext> = {}): SchedulesRouteContext {
    const storage = new SqliteTestStorage();
    return {
      env: {},
      agentCtx: { storage: { sql: storage.sql as never } } as never,
      audit: vi.fn(),
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
      ...overrides,
    } as unknown as SchedulesRouteContext;
  }

  async function call(ctx: SchedulesRouteContext, path: string, method = "GET") {
    return handleSchedulesRoutes(
      new Request(`https://agent.internal${path}`, { method }),
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
    expect(runs[0].triggeredBy).toBe("manual");
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
    expect(runs[0].triggeredBy).toBe("manual");
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
      expect(runs[0].triggeredBy).toBe("manual");
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
