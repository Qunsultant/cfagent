/**
 * Issue #3121 Slice S1 — shared primitives + consolidated run ledger.
 *
 * Parity for the S1 slice of the scheduling consolidation program:
 * the shared timing / lifecycle / audit / provenance primitives and
 * the §4 consolidated run ledger (trigger, scheduleId, asyncJobId,
 * workflowId stamped at write time, explicit nulls, no silent
 * backfill). Same firing times, same payloads, same audit events,
 * same pause/resume/trigger semantics as the pre-S1 paths — S1 adds
 * stamping and shared helpers, it changes no behavior.
 *
 * Coverage:
 * - S1-P01 O4 vocabulary: `trigger` sits ALONGSIDE `triggeredBy`
 *   (five-valued ledger vocabulary vs the two-valued origin); the
 *   builder derives it, accepts explicit worker-cron / async-chain,
 *   and never stamps `unknown` on a new row.
 * - S1-P02 ledger shape: the four fields on JOB_RUN_RECORD_FIELDS
 *   and on every built record, present even when null.
 * - S1-P03 legacy normalization: pre-S1 rows read back as
 *   trigger `unknown` + null ids, with the stored row untouched.
 * - S1-P04 linkage resolvers: payload wins, the SDK schedule id is
 *   the fallback, and the `callback:<name>` job-id fallback is
 *   never laundered into a schedule id.
 * - S1-P05 SDK / manual write sites (recordScheduleCallbackRun).
 * - S1-P06 tick write site (ScheduledAgent onCron / triggerGoal).
 * - S1-P07 O1: the hung-timeout mechanism is located (Agents SDK
 *   default 30s), not dropped.
 * - S1-P08 O2: the four goal lifecycle audit events + the
 *   best-effort poster, wired at the server.ts goal funnel in S1
 *   (S3 moves the funnel into the DO mutation methods, #3312;
 *   the S1-P08 pin below tracks the move).
 * - S1-P09 provenance: creation record travels in the payload,
 *   updates carry it forward, recovery re-arms are system/recovery.
 * - S1-P10 shared timing classifier (four forms, identical to the
 *   create route's if-chain).
 * - S1-P11 lifecycle action → audit event map + route classifier.
 * - S1-P12 Worker cron outcome linkage (tick default, explicit
 *   wins, legacy parse normalizes).
 * - S1-P13 follow-up linkage (async-chain, parent main job id).
 * - S1-P14 SQL adapter round-trip incl. a legacy NULL row.
 * - S1-P15 joinability (owner correlation-ID decision, #3121
 *   comment 6659352046): a run row joins to its schedule / workflow
 *   / async job where one exists; where none exists the null is
 *   explicit, never absent.
 * - S1-P16 null-handling: the builder rejects explicit `unknown`
 *   and non-string ids; normalization is read-only.
 * - S1-P17 one of everything (owner mandate, #3121 comment 6660031391):
 *   the shared core imports app-relative modules only (no Cloudflare,
 *   no Agents SDK), the tick semantics are the schedule module's own
 *   functions re-exported (one implementation, not two), and the doc
 *   records the reconciliation onto the §3 answers with no open owner
 *   decision.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

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
  normalizeJobRunRecord,
  resolveScheduleRunJobId,
  type JobRunRecord,
} from "../src/services/jobRunRecords";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { JOB_RUN_RECORD_FIELDS } from "../src/services/scheduleSystems";
import {
  LEDGER_TRIGGERS,
  resolveLedgerTrigger,
  buildLedgerLinkage,
  normalizeLedgerLinkage,
  WORKER_CRONS,
  WORKER_TICK_CRON,
  WORKER_TICK_LINKAGE,
  cronDispatchLinkage,
  isDue as consolidatedIsDue,
  isValidCron as consolidatedIsValidCron,
  zonedDateParts as consolidatedZonedDateParts,
  resolveTimingForm,
  SCHEDULE_LIFECYCLE_AUDIT_EVENTS,
  resolveLifecycleAction,
  GOAL_SCHEDULE_AUDIT_EVENTS,
  buildGoalScheduleAuditEvent,
  postGoalScheduleAuditEvent,
  SDK_HUNG_TIMEOUT_DEFAULT_SECONDS,
  buildScheduleProvenance,
  systemProvenance,
  recoveryProvenance,
  stampScheduleProvenance,
  carryScheduleProvenance,
  provenanceFromPayload,
} from "../src/services/consolidatedScheduling";
import { recordScheduleCallbackRun } from "../src/agents/orchestrator/scheduleCallbackRunRecords";
import {
  isDue as scheduleIsDue,
  isValidCron as scheduleIsValidCron,
  zonedDateParts as scheduleZonedDateParts,
} from "../src/schedule";
import {
  buildScheduledJobOutcomePayload,
  parseScheduledJobOutcomeRow,
} from "../src/observability/scheduledJobOutcomes";
import {
  followupLedgerLinkage,
  planInitialFollowups,
  planDeliveryFollowups,
  type ScreenerRunOutcome,
  type ScreenerFollowupConfig,
} from "../src/services/screenerFollowups";

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
    cron: "0 6 * * *",
    operation: "test.op",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

function baseRecord(overrides: Record<string, unknown> = {}): any {
  return {
    system: "scheduled-agent-goal",
    jobId: "g",
    operation: "test.op",
    started: "2026-11-03T00:00:00.000Z",
    finished: "2026-11-03T00:00:01.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    ...overrides,
  };
}

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S1-P01 O4 vocabulary — trigger alongside triggeredBy (#3121)", () => {
  it("pins the five-valued ledger vocabulary", () => {
    expect([...LEDGER_TRIGGERS]).toEqual([
      "scheduled",
      "manual",
      "worker-cron",
      "async-chain",
      "unknown",
    ]);
  });

  it("derives trigger from triggeredBy and keeps triggeredBy two-valued", () => {
    const scheduled = buildJobRunRecord(baseRecord({ triggeredBy: "scheduled" }));
    expect(scheduled.trigger).toBe("scheduled");
    expect(scheduled.triggeredBy).toBe("scheduled");
    const manual = buildJobRunRecord(baseRecord({ triggeredBy: "manual" }));
    expect(manual.trigger).toBe("manual");
    expect(manual.triggeredBy).toBe("manual");
  });

  it("accepts explicit worker-cron and async-chain triggers", () => {
    expect(
      buildJobRunRecord(baseRecord({ trigger: "worker-cron" })).trigger,
    ).toBe("worker-cron");
    expect(
      buildJobRunRecord(baseRecord({ trigger: "async-chain" })).trigger,
    ).toBe("async-chain");
  });

  it("rejects an explicit unknown trigger on a new row", () => {
    expect(() =>
      buildJobRunRecord(baseRecord({ trigger: "unknown" })),
    ).toThrow(/unknown/);
  });

  it("still rejects worker-cron as a triggeredBy value", () => {
    expect(() =>
      buildJobRunRecord(baseRecord({ triggeredBy: "worker-cron" })),
    ).toThrow(/Unknown job run trigger/);
  });
});

describe("S1-P02 ledger shape — four fields, always present (#3121)", () => {
  it("lists the four fields after triggeredBy", () => {
    for (const field of ["trigger", "scheduleId", "asyncJobId", "workflowId"]) {
      expect(JOB_RUN_RECORD_FIELDS).toContain(field);
    }
    expect(JOB_RUN_RECORD_FIELDS.indexOf("trigger")).toBeGreaterThan(
      JOB_RUN_RECORD_FIELDS.indexOf("triggeredBy"),
    );
  });

  it("fills explicit nulls on a record with no originating schedule/job/workflow", () => {
    const record = buildJobRunRecord(baseRecord());
    expect(record.trigger).toBe("scheduled");
    expect(record.scheduleId).toBeNull();
    expect(record.asyncJobId).toBeNull();
    expect(record.workflowId).toBeNull();
    // Explicit, never absent: the keys exist even when null.
    expect("trigger" in record).toBe(true);
    expect("scheduleId" in record).toBe(true);
    expect("asyncJobId" in record).toBe(true);
    expect("workflowId" in record).toBe(true);
  });

  it("keeps stamped ids on a built record", () => {
    const record = buildJobRunRecord(
      baseRecord({
        trigger: "async-chain",
        scheduleId: "sched-1",
        asyncJobId: "job-1",
        workflowId: "wf-1",
      }),
    );
    expect(record.trigger).toBe("async-chain");
    expect(record.scheduleId).toBe("sched-1");
    expect(record.asyncJobId).toBe("job-1");
    expect(record.workflowId).toBe("wf-1");
  });
});

describe("S1-P03 legacy normalization — unknown is read-only (#3121)", () => {
  it("maps a pre-S1 record (no four fields) to unknown + nulls", () => {
    const legacy = {
      system: "scheduled-agent-goal",
      jobId: "g",
      operation: "test.op",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    } as JobRunRecord;
    const normalized = normalizeJobRunRecord(legacy);
    expect(normalized.trigger).toBe("unknown");
    expect(normalized.scheduleId).toBeNull();
    expect(normalized.asyncJobId).toBeNull();
    expect(normalized.workflowId).toBeNull();
    // No silent backfill: the input object is untouched.
    expect("trigger" in legacy).toBe(false);
  });

  it("normalizes partial linkage at the linkage level", () => {
    expect(normalizeLedgerLinkage(undefined)).toEqual({
      trigger: "unknown",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
    });
    expect(
      normalizeLedgerLinkage({ trigger: "scheduled", scheduleId: "s-1" }),
    ).toEqual({
      trigger: "scheduled",
      scheduleId: "s-1",
      asyncJobId: null,
      workflowId: null,
    });
    expect(normalizeLedgerLinkage({ trigger: "bogus" as never }).trigger).toBe(
      "unknown",
    );
  });
});

describe("S1-P04 linkage resolvers (#3121)", () => {
  it("resolveLedgerTrigger: explicit valid trigger wins, unknown/invalid fall back", () => {
    expect(resolveLedgerTrigger({ trigger: "manual" }, "scheduled")).toBe("manual");
    expect(resolveLedgerTrigger({ trigger: "worker-cron" }, "scheduled")).toBe(
      "worker-cron",
    );
    expect(resolveLedgerTrigger({ trigger: "async-chain" }, "scheduled")).toBe(
      "async-chain",
    );
    expect(resolveLedgerTrigger({ trigger: "unknown" }, "manual")).toBe("manual");
    expect(resolveLedgerTrigger({ trigger: "bogus" }, "scheduled")).toBe("scheduled");
    expect(resolveLedgerTrigger({}, "manual")).toBe("manual");
    expect(resolveLedgerTrigger({}, undefined)).toBe("scheduled");
    expect(resolveLedgerTrigger(null, undefined)).toBe("scheduled");
  });

  it("buildLedgerLinkage: payload scheduleId wins over the schedule object id", () => {
    const linkage = buildLedgerLinkage({
      payload: { scheduleId: "stamped-1", asyncJobId: "job-1", workflowId: "wf-1" },
      schedule: { id: "sdk-1" },
      triggeredBy: "scheduled",
    });
    expect(linkage).toEqual({
      trigger: "scheduled",
      scheduleId: "stamped-1",
      asyncJobId: "job-1",
      workflowId: "wf-1",
    });
  });

  it("buildLedgerLinkage: schedule object id is the fallback", () => {
    expect(
      buildLedgerLinkage({ payload: {}, schedule: { id: "sdk-9" }, triggeredBy: "scheduled" }),
    ).toEqual({
      trigger: "scheduled",
      scheduleId: "sdk-9",
      asyncJobId: null,
      workflowId: null,
    });
  });

  it("buildLedgerLinkage: the callback:<name> job-id fallback never becomes a schedule id", () => {
    // The job id falls back to callback:<name>; the linkage records an
    // explicit null schedule id for the same firing.
    expect(resolveScheduleRunJobId("collectIvHistory", {}, undefined)).toBe(
      "callback:collectIvHistory",
    );
    expect(
      buildLedgerLinkage({ payload: {}, schedule: undefined, triggeredBy: "scheduled" }),
    ).toEqual({
      trigger: "scheduled",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
    });
  });

  it("buildLedgerLinkage: non-string ids read as null", () => {
    expect(
      buildLedgerLinkage({
        payload: { scheduleId: 42, asyncJobId: ["x"], workflowId: {} },
        triggeredBy: "manual",
      }),
    ).toEqual({
      trigger: "manual",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
    });
  });
});

describe("S1-P05 write site — SDK firings and manual triggers (#3121)", () => {
  it("stamps the SDK schedule id on a scheduled firing", async () => {
    const storage = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      {},
      { id: "sdk-9" },
      async () => ({ outcome: "success" }),
    );
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const runs = store.listByJob("sdk-9");
    expect(runs).toHaveLength(1);
    expect(runs[0].triggeredBy).toBe("scheduled");
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].scheduleId).toBe("sdk-9");
    expect(runs[0].asyncJobId).toBeNull();
    expect(runs[0].workflowId).toBeNull();
  });

  it("stamps the payload trigger + schedule id on a manual trigger", async () => {
    const storage = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      { trigger: "manual", scheduleId: "manual-4" },
      { id: "sched-9" },
      async () => ({ outcome: "success" }),
    );
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const runs = store.listByJob("sched-9");
    expect(runs).toHaveLength(1);
    expect(runs[0].triggeredBy).toBe("manual");
    expect(runs[0].trigger).toBe("manual");
    expect(runs[0].scheduleId).toBe("manual-4");
  });

  it("records explicit nulls when a firing has no schedule", async () => {
    const storage = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "collectIvHistory",
      {},
      undefined,
      async () => ({ outcome: "success" }),
    );
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const runs = store.listByJob("callback:collectIvHistory");
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].scheduleId).toBeNull();
    expect(runs[0].asyncJobId).toBeNull();
    expect(runs[0].workflowId).toBeNull();
    expect("scheduleId" in runs[0]).toBe(true);
  });

  it("stamps linkage on a failed firing too", async () => {
    const storage = new SqliteTestStorage();
    await expect(
      recordScheduleCallbackRun(
        storage.sql as never,
        "autonomousMarketScreen",
        { trigger: "manual", scheduleId: "manual-4" },
        { id: "sched-9" },
        async () => {
          throw new Error("callback down");
        },
      ),
    ).rejects.toThrow(/callback down/);
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const runs = store.listByJob("sched-9");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("failure");
    expect(runs[0].trigger).toBe("manual");
    expect(runs[0].scheduleId).toBe("manual-4");
  });
});

describe("S1-P06 write site — tick evaluations (#3121)", () => {
  it("a fired goal records scheduleId = goal id, trigger scheduled, asyncJobId = created job", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const ctx = makeCtx([testGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    await agent.onCron(env as never, { halted: false } as never);
    const runs = await agent.listJobRuns("test-goal");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");
    expect(runs[0].triggeredBy).toBe("scheduled");
    expect(runs[0].trigger).toBe("scheduled");
    expect(runs[0].scheduleId).toBe("test-goal");
    // The mocked createJob mints job_test_1; the tick stamps it.
    expect(runs[0].asyncJobId).toBe("job_test_1");
    expect(runs[0].workflowId).toBeNull();
  });

  it("triggerGoal records trigger manual with the goal id and the created job", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const ctx = makeCtx([testGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    await agent.triggerGoal("test-goal");
    const latest = await agent.getLatestJobRun("test-goal");
    expect(latest?.triggeredBy).toBe("manual");
    expect(latest?.trigger).toBe("manual");
    expect(latest?.scheduleId).toBe("test-goal");
    expect(latest?.asyncJobId).toBe("job_test_1");
    expect(latest?.workflowId).toBeNull();
  });
});

describe("S1-P07 O1 — hung-timeout mechanism located (#3121, #2366)", () => {
  it("pins the Agents SDK 30s default the cfagent schedules ride", () => {
    expect(SDK_HUNG_TIMEOUT_DEFAULT_SECONDS).toBe(30);
  });

  it("the framework queue index covers the hung-timeout column", () => {
    expect(source("src/data/frameworkQueueIndexSchema.ts")).toContain(
      "hung_timeout_seconds",
    );
  });

  it("cfagent sets no hung timeout of its own under src/", () => {
    // S0 D6: no hungTimeout exists under src/ on the S0 baseline; S1
    // locates the mechanism instead of dropping it — the SDK default
    // (30s) is the behavior, pinned above. The shared module's O1
    // comment legitimately NAMES the SDK options; what must never
    // appear is a setting (an option assignment or call argument).
    for (const rel of [
      "src/agents/scheduled-agent.ts",
      "src/services/consolidatedScheduling.ts",
    ]) {
      expect(source(rel)).not.toMatch(/hungTimeoutSeconds\s*[:=]/);
      expect(source(rel)).not.toMatch(/hungScheduleTimeoutSeconds\s*[:=]/);
    }
  });
});

describe("S1-P08 O2 — goal lifecycle audit events (#3121)", () => {
  it("enumerates exactly the five goal lifecycle events", () => {
    expect([...GOAL_SCHEDULE_AUDIT_EVENTS]).toEqual([
      "schedule.goal.added",
      "schedule.goal.enabled",
      "schedule.goal.triggered",
      "schedule.goal.removed",
      // Issue #3788: the watchdog's missed-fire finding.
      "schedule.goal.missed_fire",
    ]);
  });

  it("builds the mas_events-funnel event shape", () => {
    expect(
      buildGoalScheduleAuditEvent({
        event: "schedule.goal.added",
        goalId: "g-1",
        operation: "test.op",
      }),
    ).toEqual({
      type: "schedule.goal.added",
      agent: "orchestrator",
      payload: { goalId: "g-1", operation: "test.op" },
    });
    expect(
      buildGoalScheduleAuditEvent({
        event: "schedule.goal.enabled",
        goalId: "g-1",
        enabled: false,
        actor: "user-1",
      }).payload,
    ).toEqual({ goalId: "g-1", enabled: false, actor: "user-1" });
  });

  it("the best-effort poster returns true on 2xx, false on failure, never throws", async () => {
    const event = buildGoalScheduleAuditEvent({
      event: "schedule.goal.triggered",
      goalId: "g-1",
    });
    const okFetch = vi.fn(async () => ({ status: 201 }));
    expect(await postGoalScheduleAuditEvent(okFetch as never, event)).toBe(true);
    expect(okFetch).toHaveBeenCalledTimes(1);
    const posted = JSON.parse(
      await (okFetch.mock.calls[0][0] as Request).text(),
    );
    expect(posted.type).toBe("schedule.goal.triggered");

    const refusedFetch = vi.fn(async () => ({ status: 403 }));
    expect(await postGoalScheduleAuditEvent(refusedFetch as never, event)).toBe(false);
    const throwingFetch = vi.fn(async () => {
      throw new Error("audit down");
    });
    expect(await postGoalScheduleAuditEvent(throwingFetch as never, event)).toBe(false);
  });

  it("the DO mutation methods + watchdog wire all five events through the poster (S3, #3312; #3788)", () => {
    // Slice S3 moves the funnel into the ScheduledAgent mutation
    // methods: the route funnel S1 pinned here posted the same
    // events, but the A2A path bypassed it (filed as #3312). The
    // route now threads the session actor into the methods; the
    // methods emit. The behavioral proof is S3-P05 (both paths emit
    // through the DO sink); this pin keeps the wiring visible.
    const agent = source("src/agents/scheduled-agent.ts");
    for (const event of GOAL_SCHEDULE_AUDIT_EVENTS) {
      expect(agent).toContain(`"${event}"`);
    }
    expect(agent).toContain("postGoalScheduleAuditEvent");
    expect(agent).toContain("private async auditGoalLifecycle");
    const trading = source("src/server/routes/trading.ts");
    expect(trading).toContain("actor: session.githubLogin");
    expect(trading).not.toContain("postGoalScheduleAuditEvent");
    expect(trading).not.toContain("auditGoalLifecycle");
  });
});

describe("S1-P09 provenance — origin travels in the payload (#3121, #2366)", () => {
  it("builds a user creation record and a system record", () => {
    const user = buildScheduleProvenance({
      origin: "user",
      createdBy: "user-1",
      reason: "created via T2 create route",
      createdAt: "2026-11-05T00:00:00.000Z",
    });
    expect(user).toEqual({
      origin: "user",
      createdBy: "user-1",
      reason: "created via T2 create route",
      createdAt: "2026-11-05T00:00:00.000Z",
    });
    const system = systemProvenance("async-job-arm", new Date("2026-11-05T00:00:00.000Z"));
    expect(system.origin).toBe("system");
    // Framework-internal creator identity is the literal "system".
    expect(system.createdBy).toBe("system");
    expect(system.reason).toBe("async-job-arm");
  });

  it("recovery re-arms carry origin system / recovery", () => {
    const recovery = recoveryProvenance(new Date("2026-11-05T00:00:00.000Z"));
    expect(recovery.origin).toBe("system");
    expect(recovery.reason).toBe("recovery");
    expect(recovery.createdBy).toBe("system");
  });

  it("stamping is creation-only: an existing provenance is never rewritten", () => {
    const original = buildScheduleProvenance({
      origin: "user",
      createdBy: "user-1",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const payload = { provenance: original };
    const stamped = stampScheduleProvenance(
      payload,
      buildScheduleProvenance({ origin: "user", createdBy: "user-2" }),
    ) as { provenance: unknown };
    expect(stamped.provenance).toEqual(original);
    expect((stamped.provenance as { createdBy: string }).createdBy).toBe("user-1");
    // An unstamped payload gains the stamp.
    const fresh = stampScheduleProvenance(
      { cron: "0 6 * * *" },
      original,
    ) as { provenance: unknown };
    expect(fresh.provenance).toEqual(original);
  });

  it("carryScheduleProvenance keeps the original creation record on update", () => {
    const original = buildScheduleProvenance({
      origin: "user",
      createdBy: "user-1",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const carried = carryScheduleProvenance(
      { provenance: original },
      { cron: "0 7 * * *" },
    ) as { provenance: unknown; cron: string };
    expect(carried.provenance).toEqual(original);
    expect(carried.cron).toBe("0 7 * * *");
    // A payload with no prior provenance is returned untouched.
    expect(carryScheduleProvenance({}, { cron: "0 7 * * *" })).toEqual({
      cron: "0 7 * * *",
    });
  });

  it("provenanceFromPayload validates and never throws", () => {
    // Reads the provenance OFF a payload (payload.provenance).
    expect(
      provenanceFromPayload({
        provenance: {
          origin: "user",
          createdBy: "user-1",
          createdAt: "2026-11-01T00:00:00.000Z",
        },
      }),
    ).toEqual({
      origin: "user",
      createdBy: "user-1",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    expect(
      provenanceFromPayload({ provenance: { origin: "bogus" } }),
    ).toBeUndefined();
    expect(provenanceFromPayload({ provenance: { origin: "user" } })).toBeUndefined();
    expect(provenanceFromPayload(null)).toBeUndefined();
    expect(provenanceFromPayload("nope")).toBeUndefined();
  });

  it("stamping is wired at the create route, the re-arms, and addGoal", () => {
    expect(source("src/agents/routes/schedules.ts")).toContain(
      "stampScheduleProvenance",
    );
    expect(source("src/agents/orchestrator/asyncJobs.ts")).toContain(
      "recoveryProvenance",
    );
    expect(source("src/agents/scheduled-agent.ts")).toContain(
      "provenanceFromPayload",
    );
  });
});

describe("S1-P10 shared timing classifier (#3121)", () => {
  it("resolves the four timing forms identically to the create route", () => {
    expect(
      resolveTimingForm({ scheduleType: "interval", intervalSeconds: 900 }),
    ).toEqual({
      ok: true,
      timing: { type: "interval", intervalSeconds: 900 },
    });
    expect(
      resolveTimingForm({ scheduleType: "cron", cron: "0 6 * * *" }),
    ).toEqual({ ok: true, timing: { type: "cron", cron: "0 6 * * *" } });
    expect(
      resolveTimingForm({ scheduleType: "scheduled", date: "2026-11-06T06:00:00.000Z" }),
    ).toEqual({
      ok: true,
      timing: { type: "scheduled", time: 1793944800 },
    });
    expect(
      resolveTimingForm({ delayInSeconds: 60 }, 1_791_000_000_000),
    ).toEqual({
      ok: true,
      timing: { type: "delayed", time: 1_791_000_060 },
    });
  });

  it("rejects invalid timing the same way the route does", () => {
    expect(resolveTimingForm({ scheduleType: "interval", intervalSeconds: 0 }).ok).toBe(
      false,
    );
    expect(resolveTimingForm({ scheduleType: "interval", intervalSeconds: 1.5 }).ok).toBe(
      false,
    );
    expect(resolveTimingForm({}).ok).toBe(false);
    expect(resolveTimingForm({ delayInSeconds: -1 }).ok).toBe(false);
  });
});

describe("S1-P11 lifecycle primitives (#3121)", () => {
  it("maps every lifecycle action to its B-T2-06 audit event", () => {
    expect(SCHEDULE_LIFECYCLE_AUDIT_EVENTS).toEqual({
      create: "schedule.created",
      cancel: "schedule.cancelled",
      pause: "schedule.paused",
      resume: "schedule.resumed",
      trigger: "schedule.triggered",
      update: "schedule.updated",
    });
  });

  it("classifies schedule routes from path + method", () => {
    expect(resolveLifecycleAction("/schedules/abc/pause", "POST")).toBe("pause");
    expect(resolveLifecycleAction("/schedules/abc/resume", "POST")).toBe("resume");
    expect(resolveLifecycleAction("/schedules/abc/trigger", "POST")).toBe("trigger");
    expect(resolveLifecycleAction("/schedules/abc", "DELETE")).toBe("cancel");
    expect(resolveLifecycleAction("/schedules/create", "POST")).toBe("create");
    expect(resolveLifecycleAction("/schedules/cancel", "POST")).toBe("cancel");
    expect(resolveLifecycleAction("/schedules/abc", "PUT")).toBe("update");
    expect(resolveLifecycleAction("/schedules/abc/runs", "GET")).toBeUndefined();
    expect(resolveLifecycleAction("/schedules", "POST")).toBeUndefined();
  });
});

describe("S1-P12 Worker cron outcome linkage (#3121)", () => {
  it("defaults a dispatch to the worker-cron tick linkage", () => {
    const payload = buildScheduledJobOutcomePayload({
      job: "research",
      outcome: "completed",
    });
    expect(payload.linkage).toEqual({
      trigger: "worker-cron",
      scheduleId: WORKER_TICK_CRON,
      asyncJobId: null,
      workflowId: null,
    });
    expect(WORKER_TICK_LINKAGE).toEqual({
      trigger: "worker-cron",
      scheduleId: "*/30 * * * *",
      asyncJobId: null,
      workflowId: null,
    });
  });

  it("an explicit linkage wins; an explicit unknown falls back to worker-cron", () => {
    const explicit = buildScheduledJobOutcomePayload({
      job: "research",
      outcome: "completed",
      linkage: {
        trigger: "worker-cron",
        scheduleId: "0 6 * * *",
        asyncJobId: null,
        workflowId: null,
      },
    });
    expect(explicit.linkage.scheduleId).toBe("0 6 * * *");
    const unknown = buildScheduledJobOutcomePayload({
      job: "research",
      outcome: "completed",
      linkage: {
        trigger: "unknown",
        scheduleId: "0 6 * * *",
        asyncJobId: null,
        workflowId: null,
      },
    });
    expect(unknown.linkage.trigger).toBe("worker-cron");
    expect(cronDispatchLinkage("0 6 * * *")).toEqual({
      trigger: "worker-cron",
      scheduleId: "0 6 * * *",
      asyncJobId: null,
      workflowId: null,
    });
  });

  it("a legacy outcome row parses to unknown + nulls, never to a missing linkage", () => {
    const parsed = parseScheduledJobOutcomeRow({
      payload: JSON.stringify({ job: "research", outcome: "completed" }),
      created_at: "2026-11-05T00:00:00.000Z",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.linkage).toEqual({
      trigger: "unknown",
      scheduleId: null,
      asyncJobId: null,
      workflowId: null,
    });
    expect(parseScheduledJobOutcomeRow({ payload: "not-json" })).toBeNull();
  });
});

describe("S1-P13 follow-up linkage — async-chain (#3121)", () => {
  const outcome = {
    kind: "stock",
    trigger: "scheduled",
    success: true,
    pdfKeys: [],
    scheduleId: "sched-1",
    workflowId: "wf-1",
  } as unknown as ScreenerRunOutcome;
  const config = {
    enabled: true,
    reportEnabled: true,
    channels: {
      slack: { configured: true },
      email: { configured: false },
      webhook: { configured: false },
    },
    emailAllowlist: [],
    emailAllowlistExplicit: false,
  } as unknown as ScreenerFollowupConfig;

  it("followupLedgerLinkage carries async-chain + the run ids + the parent main job", () => {
    expect(followupLedgerLinkage(outcome, "main-job-1")).toEqual({
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: "main-job-1",
      workflowId: "wf-1",
    });
    const noRunIds = { kind: "stock", trigger: "manual", success: true, pdfKeys: [] } as unknown as ScreenerRunOutcome;
    expect(followupLedgerLinkage(noRunIds, "main-job-2")).toEqual({
      trigger: "async-chain",
      scheduleId: null,
      asyncJobId: "main-job-2",
      workflowId: null,
    });
  });

  it("the report planner stamps the linkage on its payload", () => {
    const specs = planInitialFollowups(outcome, config, "main-job-1", "user-1");
    expect(specs).toHaveLength(1);
    expect(specs[0].payload.ledgerLinkage).toEqual({
      trigger: "async-chain",
      scheduleId: "sched-1",
      asyncJobId: "main-job-1",
      workflowId: "wf-1",
    });
    expect(specs[0].parentJobId).toBe("main-job-1");
  });

  it("the delivery planner stamps the same linkage on its payloads", () => {
    const specs = planDeliveryFollowups(
      outcome,
      config,
      { status: "ready", artifacts: [{ key: "pdf-1", fileName: "report.pdf", kind: "pdf" }] },
      "main-job-1",
      "user-1",
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.payload.ledgerLinkage).toEqual({
        trigger: "async-chain",
        scheduleId: "sched-1",
        asyncJobId: "main-job-1",
        workflowId: "wf-1",
      });
    }
  });
});

describe("S1-P14 SQL adapter round-trip incl. legacy NULL row (#3121)", () => {
  it("persists the four columns and reads them back", () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    store.record(
      buildJobRunRecord(
        baseRecord({
          trigger: "async-chain",
          scheduleId: "sched-1",
          asyncJobId: "job-1",
          workflowId: "wf-1",
        }),
      ),
    );
    const runs = store.listByJob("g");
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("async-chain");
    expect(runs[0].scheduleId).toBe("sched-1");
    expect(runs[0].asyncJobId).toBe("job-1");
    expect(runs[0].workflowId).toBe("wf-1");
  });

  it("a row stored with NULL linkage columns reads back as unknown + nulls", () => {
    const storage = new SqliteTestStorage();
    const store = new SqlJobRunRecordStore(storage.sql as never);
    // Force table creation, then insert a pre-S1-shaped row directly:
    // all four linkage columns NULL, as the probed ADD COLUMN leaves
    // them on a table created before S1.
    store.record(buildJobRunRecord(baseRecord({ jobId: "seed" })));
    storage.sqlite
      .prepare(
        "INSERT INTO job_run_records (system, job_id, operation, started, finished, outcome, triggered_by, trigger_text, schedule_id, async_job_id, workflow_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
      )
      .run(
        "orchestrator-schedule",
        "legacy-1",
        "autonomousMarketScreen",
        "2026-11-03T00:00:00.000Z",
        "2026-11-03T00:00:01.000Z",
        "success",
        "scheduled",
      );
    const runs = store.listByJob("legacy-1");
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("unknown");
    expect(runs[0].scheduleId).toBeNull();
    expect(runs[0].asyncJobId).toBeNull();
    expect(runs[0].workflowId).toBeNull();
    // The stored row is untouched: still NULL in the table.
    const raw = storage.sqlite
      .prepare("SELECT trigger_text FROM job_run_records WHERE job_id = ?")
      .get("legacy-1") as { trigger_text: unknown };
    expect(raw.trigger_text).toBeNull();
  });
});

describe("S1-P15 joinability — correlation ID (#3121, owner decision 6659352046)", () => {
  it("an SDK firing joins to its schedule by scheduleId", async () => {
    const storage = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      {},
      { id: "sdk-9" },
      async () => ({ outcome: "success" }),
    );
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const [run] = store.listByJob("sdk-9");
    // The join key: run.scheduleId === the schedule's id.
    expect(run.scheduleId).toBe("sdk-9");
    expect(run.trigger).toBe("scheduled");
  });

  it("a manual trigger joins to its schedule by the stamped scheduleId", async () => {
    const storage = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "autonomousMarketScreen",
      { trigger: "manual", scheduleId: "manual-4" },
      { id: "sched-9" },
      async () => ({ outcome: "success" }),
    );
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const [run] = store.listByJob("sched-9");
    expect(run.scheduleId).toBe("manual-4");
    expect(run.trigger).toBe("manual");
  });

  it("a goal firing joins to its goal, its async job, and (by null) no workflow", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    const ctx = makeCtx([testGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    await agent.onCron(env as never, { halted: false } as never);
    const [run] = await agent.listJobRuns("test-goal");
    expect(run.scheduleId).toBe("test-goal");
    expect(run.asyncJobId).toBe("job_test_1");
    expect(run.workflowId).toBeNull();
    expect("workflowId" in run).toBe(true);
  });

  it("a follow-up payload joins to its parent main job by asyncJobId", () => {
    const outcome = {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: [],
      scheduleId: "sched-1",
      workflowId: "wf-1",
    } as unknown as ScreenerRunOutcome;
    const linkage = followupLedgerLinkage(outcome, "main-job-1");
    expect(linkage.asyncJobId).toBe("main-job-1");
    expect(linkage.trigger).toBe("async-chain");
    expect(linkage.scheduleId).toBe("sched-1");
    expect(linkage.workflowId).toBe("wf-1");
  });

  it("a cron dispatch joins to its cron expression as its schedule", () => {
    const payload = buildScheduledJobOutcomePayload({
      job: "research",
      outcome: "completed",
    });
    expect(payload.linkage.scheduleId).toBe(WORKER_TICK_CRON);
    expect(payload.linkage.trigger).toBe("worker-cron");
  });

  it("a firing with no schedule/workflow/job records all three nulls explicitly", async () => {
    const storage = new SqliteTestStorage();
    await recordScheduleCallbackRun(
      storage.sql as never,
      "collectIvHistory",
      {},
      undefined,
      async () => ({ outcome: "success" }),
    );
    const store = new SqlJobRunRecordStore(storage.sql as never);
    const [run] = store.listByJob("callback:collectIvHistory");
    expect(run.scheduleId).toBeNull();
    expect(run.asyncJobId).toBeNull();
    expect(run.workflowId).toBeNull();
    expect("scheduleId" in run).toBe(true);
    expect("asyncJobId" in run).toBe(true);
    expect("workflowId" in run).toBe(true);
  });

  it("a legacy row is explicitly unjoinable (unknown + nulls), never silently joinable", () => {
    const legacy = normalizeJobRunRecord({
      system: "orchestrator-schedule",
      jobId: "legacy-1",
      operation: "autonomousMarketScreen",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    } as JobRunRecord);
    expect(legacy.trigger).toBe("unknown");
    expect(legacy.scheduleId).toBeNull();
    expect(legacy.asyncJobId).toBeNull();
    expect(legacy.workflowId).toBeNull();
  });
});

describe("S1-P16 null-handling — no new row is ever unknown or null (#3121)", () => {
  it("the builder rejects an explicit unknown trigger and non-string ids", () => {
    expect(() =>
      buildJobRunRecord(baseRecord({ trigger: "unknown" })),
    ).toThrow(/unknown/);
    expect(() => buildJobRunRecord(baseRecord({ scheduleId: 42 }))).toThrow();
    expect(() => buildJobRunRecord(baseRecord({ asyncJobId: ["x"] }))).toThrow();
    expect(() => buildJobRunRecord(baseRecord({ workflowId: {} }))).toThrow();
  });

  it("explicit nulls survive the builder unchanged", () => {
    const record = buildJobRunRecord(
      baseRecord({ scheduleId: null, asyncJobId: null, workflowId: null }),
    );
    expect(record.scheduleId).toBeNull();
    expect(record.asyncJobId).toBeNull();
    expect(record.workflowId).toBeNull();
  });

  it("normalization never writes: it returns a new object", () => {
    const legacy = {
      system: "scheduled-agent-goal",
      jobId: "g",
      operation: "test.op",
      started: "2026-11-03T00:00:00.000Z",
      finished: "2026-11-03T00:00:01.000Z",
      outcome: "success",
      triggeredBy: "scheduled",
    } as JobRunRecord;
    const normalized = normalizeJobRunRecord(legacy);
    expect(normalized).not.toBe(legacy);
    expect("trigger" in legacy).toBe(false);
  });
});

describe("S1-P17 one of everything — hexagonal core + one firing contract (#3121, mandate 6660031391)", () => {
  it("the shared core imports app-relative modules only — no Cloudflare, no Agents SDK", () => {
    const src = source("src/services/consolidatedScheduling.ts");
    const specs = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.startsWith(".")).toBe(true);
    }
    expect(src).not.toMatch(/from "(agents|@cloudflare\/|cloudflare|workers)"/);
    expect(src).not.toContain("SqlStorage");
  });

  it("the tick semantics are the schedule module's, re-exported — one implementation, not two", () => {
    expect(consolidatedIsDue).toBe(scheduleIsDue);
    expect(consolidatedIsValidCron).toBe(scheduleIsValidCron);
    expect(consolidatedZonedDateParts).toBe(scheduleZonedDateParts);
  });

  it("the tick cron is the inventoried Worker tick, not a second expression", () => {
    expect(WORKER_TICK_CRON).toBe("*/30 * * * *");
    expect(WORKER_CRONS).toContain(WORKER_TICK_CRON);
  });

  it("the doc records the reconciliation onto the §3 answers with no open owner decision", () => {
    const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
    expect(doc).toContain("S1 reconciliation — one of everything");
    expect(doc).toContain("6660031391");
    expect(doc).toContain("No genuine conflict exists");
    expect(doc).toContain("no open owner decision is recorded");
  });
});
