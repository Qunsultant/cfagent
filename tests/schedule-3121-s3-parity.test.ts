/**
 * Issue #3121 Slice S3 — goal schedules onto the shared scheduling
 * primitives (the tick-evaluated kind, inventory §3 Q(a)).
 *
 * Parity for the S3 slice of the scheduling consolidation program:
 * goal schedules migrate onto the S1 primitives — tick evaluation
 * through the S1 re-exported `isDue` / `isValidCron` /
 * `zonedDateParts`, ledger linkage through `buildLedgerLinkage`,
 * provenance on every goal-creation path (incl. synthesized
 * materialization), and the lifecycle audit through the DO-side sink
 * in the mutation methods (#3312). Tick semantics are preserved
 * VERBATIM: the 23h anti-double-fire guard, the "0 *\/6 * * *"
 * never-due quirk, the shared per-goal-per-firing budget check, the
 * in-flight firing claim, the governed-halt predicate, synthesized
 * materialization before firing, `pipeline:` goals in ONE firing,
 * one tick entry per onCron call.
 *
 * Coverage:
 * - S3-P01 tick semantics through the S1 re-exports (identity,
 *   quirk + 23h guard through onCron).
 * - S3-P02 O3 — per-tick budget accounting matches onCron exactly
 *   when a tick evaluates goals across tenants (#2457 owns the
 *   cross-tenant rules; the tick enforces the same gates).
 * - S3-P03 ledger linkage resolved through `buildLedgerLinkage`
 *   at the tick write site.
 * - S3-P04 materialized goals carry system provenance.
 * - S3-P05 #3312 — the DO-side audit sink: every entry path
 *   (route, A2A, mesh door) emits through the mutation methods.
 * - S3-P06 the goals view reads the one consolidated ledger.
 * - S3-P07 one of everything (owner mandate, #3121 comment
 *   6660031391): no second audit system, no second read path, no
 *   new Cloudflare surface in the core.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// The real OPERATION_CATALOG + compileGoal (S3 pins real operations:
// "qa.run_sweep", "search.query", "pipeline:social-daily"); only the
// job minter is stubbed, deterministically by goal id.
vi.mock("../src/orchestrate", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/orchestrate")>();
  return {
    ...actual,
    createJob: vi.fn(async (_env: any, req: any) => ({
      jobId: `job_${req.goalId}`,
      ...req,
      status: "pending",
    })),
  };
});

import { compileGoal } from "../src/orchestrate";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { AGENTIC_SPEND_AGENT_ID } from "../src/payments/ledger";
import {
  buildLedgerLinkage,
  GOAL_SCHEDULE_AUDIT_EVENTS,
  isDue as consolidatedIsDue,
  isValidCron as consolidatedIsValidCron,
  zonedDateParts as consolidatedZonedDateParts,
} from "../src/services/consolidatedScheduling";
import {
  isDue as scheduleIsDue,
  isValidCron as scheduleIsValidCron,
  zonedDateParts as scheduleZonedDateParts,
} from "../src/schedule";

function source(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function makeCtx(initialGoals?: any[]) {
  const store = new Map<string, unknown>();
  if (initialGoals) store.set("goals", initialGoals);
  return {
    store,
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
  };
}

interface AuditCapture {
  posted: { url: string; body: any }[];
  namespace: unknown;
}

function makeAuditCapture(
  opts: { status?: number; throws?: boolean } = {},
): AuditCapture {
  const posted: { url: string; body: any }[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => ({
      fetch: async (req: Request) => {
        if (opts.throws) throw new Error("audit down");
        // The ORCHESTRATOR_AGENT namespace carries TWO channels
        // (#3123): the audit sink AND the ledger post/read channel
        // (POST /schedules/runs/record, GET /schedules/runs). This
        // capture is the audit sink's — only the audit URL counts.
        if (req.url === "https://agent.internal/audit/event") {
          posted.push({
            url: req.url,
            body: await req.clone().json().catch(() => null),
          });
        }
        return { status: opts.status ?? 200 };
      },
    }),
  };
  return { posted, namespace };
}

function makeEnv(
  opts: {
    budgetAllowed?: boolean;
    budgetImpl?: (req: any) => Promise<{ allowed: boolean; reason?: string }>;
    audit?: AuditCapture | null;
  } = {},
) {
  const budgetCheck = vi.fn(
    opts.budgetImpl ??
      (async () => ({
        allowed: opts.budgetAllowed ?? true,
        reason:
          opts.budgetAllowed ?? true ? undefined : "over budget",
      })),
  );
  const env: any = {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck }),
    },
    SESSION_STORE: null,
  };
  if (opts.audit) env.ORCHESTRATOR_AGENT = opts.audit.namespace;
  return { env, budgetCheck };
}

function testGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-goal",
    name: "Test goal",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
    ...overrides,
  };
}

function threeDueGoals() {
  return [
    testGoal({ id: "g-a", operation: "qa.run_sweep", budgetCents: 500 }),
    testGoal({ id: "g-b", operation: "search.query", budgetCents: 100 }),
    testGoal({ id: "g-c", operation: "search.query", budgetCents: 250 }),
  ];
}

function makeHaltReader() {
  const tenants: string[] = [];
  return {
    tenants,
    reader: {
      isHalted: async (tenantId: string) => {
        tenants.push(tenantId);
        return false;
      },
      latestHalt: async () => null,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
  // The mocked createJob is module-level: clear its call history
  // per test (implementation survives — clear, never reset).
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("S3-P01 tick semantics through the S1 re-exports (#3121)", () => {
  it("the consolidated re-exports ARE the schedule module's functions (one implementation)", () => {
    expect(consolidatedIsDue).toBe(scheduleIsDue);
    expect(consolidatedIsValidCron).toBe(scheduleIsValidCron);
    expect(consolidatedZonedDateParts).toBe(scheduleZonedDateParts);
  });

  it("ScheduledAgent evaluates through consolidatedScheduling, never a second isDue", () => {
    const agent = source("src/agents/scheduled-agent.ts");
    const scheduleImports = [
      ...agent.matchAll(/import \{([^}]*)\} from "\.\.\/schedule"/gs),
    ].map((m) => m[1]);
    expect(scheduleImports.join("\n")).not.toContain("isDue");
    expect(scheduleImports.join("\n")).not.toContain("isValidCron");
    expect(scheduleImports.join("\n")).not.toContain("zonedDateParts");
    const consolidatedImports = [
      ...agent.matchAll(
        /import \{([^}]*)\} from "\.\.\/services\/consolidatedScheduling"/gs,
      ),
    ].map((m) => m[1]);
    expect(consolidatedImports.join("\n")).toContain("isDue");
    expect(consolidatedImports.join("\n")).toContain("isValidCron");
    expect(consolidatedImports.join("\n")).toContain("zonedDateParts");
  });

  it("the opportunity-hunt quirk survives the migration: '0 */6 * * *' never fires", async () => {
    const { env, budgetCheck } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([
        testGoal({ id: "opportunity-hunt", cron: "0 */6 * * *", operation: "search.query", budgetCents: 1000 }),
      ]) as never,
      env as never,
    );
    // 06:00 UTC is a */6 hour — a correct parser would fire; the
    // preserved quirk maps the hour through Number() to NaN.
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(0);
    expect(budgetCheck).not.toHaveBeenCalled();
    expect(await agent.listJobRuns("opportunity-hunt")).toHaveLength(0);
  });

  it("the 23h anti-double-fire guard survives: a goal run 1h ago is not due", async () => {
    const { env, budgetCheck } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([
        testGoal({ lastRun: "2026-11-03T05:00:00.000Z" }),
      ]) as never,
      env as never,
    );
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(0);
    expect(budgetCheck).not.toHaveBeenCalled();
    expect(await agent.listJobRuns("test-goal")).toHaveLength(0);
  });

  it("a due goal still fires exactly once through the consolidated tick", async () => {
    const { env, budgetCheck } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.jobsSkipped).toBe(0);
    expect(budgetCheck).toHaveBeenCalledTimes(1);
    const runs = await agent.listJobRuns("test-goal");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");
  });
});

describe("S3-P02 O3 — per-tick budget accounting matches onCron exactly (#3121, #2457)", () => {
  it("one tick over three due goals issues exactly three budget checks, one per goal", async () => {
    const { env, budgetCheck } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx(threeDueGoals()) as never,
      env as never,
    );
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsCreated).toBe(3);
    expect(budgetCheck).toHaveBeenCalledTimes(3);
    expect(budgetCheck.mock.calls.map((c) => c[0])).toEqual([
      { operation: "qa.run_sweep", amountCents: 500, agentId: AGENTIC_SPEND_AGENT_ID },
      { operation: "search.query", amountCents: 100, agentId: AGENTIC_SPEND_AGENT_ID },
      { operation: "search.query", amountCents: 250, agentId: AGENTIC_SPEND_AGENT_ID },
    ]);
    // No per-tick aggregate: the check count IS the due-goal count,
    // and the created-job count matches it.
    expect(tick.jobsSkipped).toBe(0);
  });

  it("a budget rejection skips only its own goal; the others still fire", async () => {
    const { env, budgetCheck } = makeEnv({
      budgetImpl: async (req: any) =>
        req.operation === "search.query"
          ? { allowed: false, reason: "over budget" }
          : { allowed: true },
    });
    const agent = new ScheduledAgent(
      makeCtx(threeDueGoals()) as never,
      env as never,
    );
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.jobsSkipped).toBe(2);
    expect(budgetCheck).toHaveBeenCalledTimes(3);
    const skipped = await agent.listJobRuns("g-b");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].outcome).toBe("skipped");
    expect(skipped[0].detail).toContain("budget check rejected");
    expect(skipped[0].asyncJobId).toBeNull();
  });

  it("tenant scopes the halt read, never the budget: two tenants' ticks check identically", async () => {
    const a = makeEnv();
    const b = makeEnv();
    const haltA = makeHaltReader();
    const haltB = makeHaltReader();
    const agentA = new ScheduledAgent(
      makeCtx(threeDueGoals()) as never,
      a.env as never,
    );
    const agentB = new ScheduledAgent(
      makeCtx(threeDueGoals()) as never,
      b.env as never,
    );
    await agentA.onCron(a.env as never, {
      tenantId: "tenant-a",
      haltReader: haltA.reader,
    } as never);
    await agentB.onCron(b.env as never, {
      tenantId: "tenant-b",
      haltReader: haltB.reader,
    } as never);
    expect(haltA.tenants).toEqual(["tenant-a"]);
    expect(haltB.tenants).toEqual(["tenant-b"]);
    expect(a.budgetCheck.mock.calls).toEqual(b.budgetCheck.mock.calls);
    expect(a.budgetCheck).toHaveBeenCalledTimes(3);
    // The budget bucket is the orchestrator bucket on both ticks —
    // never a tenant bucket, never a per-tenant check.
    for (const call of a.budgetCheck.mock.calls) {
      expect(call[0].agentId).toBe(AGENTIC_SPEND_AGENT_ID);
    }
  });

  it("a pipeline goal runs under exactly one budget check for the whole firing", async () => {
    const { env, budgetCheck } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([
        testGoal({ id: "pipe-1", operation: "pipeline:social-daily", budgetCents: 500 }),
      ]) as never,
      env as never,
    );
    // SESSION_STORE is unbound in this env, so the pipeline branch
    // records skipped — but the budget check above it ran exactly
    // once for the goal, never once per stage.
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(budgetCheck).toHaveBeenCalledTimes(1);
    expect(budgetCheck.mock.calls[0][0]).toEqual({
      operation: "pipeline:social-daily",
      amountCents: 500,
      agentId: AGENTIC_SPEND_AGENT_ID,
    });
    expect(tick.jobsSkipped).toBe(1);
    const runs = await agent.listJobRuns("pipe-1");
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("skipped");
  });

  it("disabled and not-due goals cost zero budget checks", async () => {
    const { env, budgetCheck } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([
        testGoal({ id: "off", enabled: false }),
        testGoal({ id: "later", cron: "0 7 * * *" }),
      ]) as never,
      env as never,
    );
    const tick = await agent.onCron(env as never, { halted: false } as never);
    // The disabled goal is skipped before evaluation; the not-due
    // goal IS evaluated (goalsEvaluated counts it) but never
    // reaches the budget check — evaluation is not a firing.
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(0);
    expect(budgetCheck).not.toHaveBeenCalled();
  });
});

describe("S3-P03 ledger linkage resolved through buildLedgerLinkage (#3121)", () => {
  it("a fired goal's stored linkage equals the resolver's output", async () => {
    const { env } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    await agent.onCron(env as never, { halted: false } as never);
    const [run] = await agent.listJobRuns("test-goal");
    expect({
      trigger: run.trigger,
      scheduleId: run.scheduleId,
      asyncJobId: run.asyncJobId,
      workflowId: run.workflowId,
    }).toEqual(
      buildLedgerLinkage({
        payload: { scheduleId: "test-goal", asyncJobId: "job_test-goal" },
        triggeredBy: "scheduled",
      }),
    );
  });

  it("a manual trigger's stored linkage equals the resolver's manual output", async () => {
    const { env } = makeEnv();
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    await agent.triggerGoal("test-goal");
    const [run] = await agent.listJobRuns("test-goal");
    expect(run.triggeredBy).toBe("manual");
    expect({
      trigger: run.trigger,
      scheduleId: run.scheduleId,
      asyncJobId: run.asyncJobId,
      workflowId: run.workflowId,
    }).toEqual(
      buildLedgerLinkage({
        payload: { scheduleId: "test-goal", asyncJobId: "job_test-goal" },
        triggeredBy: "manual",
      }),
    );
  });

  it("a skipped goal records explicit nulls for the job and workflow it never had", async () => {
    const { env } = makeEnv({ budgetAllowed: false });
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    await agent.onCron(env as never, { halted: false } as never);
    const [run] = await agent.listJobRuns("test-goal");
    expect(run.outcome).toBe("skipped");
    expect(run.trigger).toBe("scheduled");
    expect(run.scheduleId).toBe("test-goal");
    expect(run.asyncJobId).toBeNull();
    expect(run.workflowId).toBeNull();
  });
});

describe("S3-P04 materialized goals carry system provenance (#3121)", () => {
  async function materializedAgent(id = "synth-s3-mat") {
    const ctx = makeCtx();
    const { env } = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
      budgetCents: 5000,
      budgetCapCents: 10000,
    });
    if (!chain) throw new Error("test chain did not compile");
    await agent.synthesizeSchedule(chain, { id, cron: "0 6 * * *" });
    await agent.approveSynthesizedSchedule(id);
    const goal = await agent.materializeSynthesizedSchedule(id);
    return { agent, store: ctx.store, goal };
  }

  it("materialization stamps origin system / synthesized-materialization", async () => {
    const { goal } = await materializedAgent();
    expect(goal.operation).toBe("chain.execute");
    expect(goal.provenance).toEqual({
      origin: "system",
      createdBy: "system",
      reason: "synthesized-materialization",
      createdAt: "2026-11-03T06:00:00.000Z",
    });
  });

  it("re-materialization returns the stored goal without restamping", async () => {
    const { agent, goal } = await materializedAgent("synth-s3-mat-again");
    const again = await agent.materializeSynthesizedSchedule("synth-s3-mat-again");
    expect(again).toEqual(goal);
    expect(again.provenance).toEqual(goal.provenance);
    expect(
      (await agent.listGoals()).filter((g: any) => g.id === "synth-s3-mat-again"),
    ).toHaveLength(1);
  });

  it("a halted tick blocks the materialized chain goal; an unhalted tick fires it", async () => {
    const { agent, store, goal } = await materializedAgent("synth-s3-halt");
    store.set("goals", [goal]);
    const blocked = await agent.onCron({ halted: true } as never);
    expect(blocked.jobsCreated).toBe(0);
    expect(blocked.jobsSkipped).toBe(1);
    expect(blocked.errors.join(" ")).toContain("blocked");
    const [blockedRun] = await agent.listJobRuns("synth-s3-halt");
    expect(blockedRun.outcome).toBe("skipped");
    expect(blockedRun.detail).toContain("blocked");

    const { agent: agent2, store: store2, goal: goal2 } =
      await materializedAgent("synth-s3-fire");
    store2.set("goals", [goal2]);
    const fired = await agent2.onCron({ halted: false } as never);
    expect(fired.jobsCreated).toBe(1);
    expect(fired.jobsSkipped).toBe(0);
  });
});

describe("S3-P05 #3312 — the DO-side audit sink covers every entry path (#3121)", () => {
  it("DO-direct mutations emit the four events with the threaded actor", async () => {
    const audit = makeAuditCapture();
    const { env } = makeEnv({ audit });
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    await agent.addGoal({
      id: "g-new",
      name: "New goal",
      cron: "0 6 * * *",
      operation: "qa.run_sweep",
      budgetCents: 100,
      actor: "octocat-schedule",
    });
    await agent.setGoalEnabled("test-goal", false, "octocat-schedule");
    await agent.triggerGoal("test-goal", undefined, "octocat-schedule");
    await agent.removeGoal("g-new", "octocat-schedule");
    expect(audit.posted).toHaveLength(4);
    expect(audit.posted.map((p) => p.body.type)).toEqual([
      "schedule.goal.added",
      "schedule.goal.enabled",
      "schedule.goal.triggered",
      "schedule.goal.removed",
    ]);
    for (const p of audit.posted) {
      expect(p.url).toBe("https://agent.internal/audit/event");
      expect(p.body.agent).toBe("orchestrator");
      expect(p.body.payload.actor).toBe("octocat-schedule");
    }
    expect(audit.posted[0].body.payload).toEqual({
      goalId: "g-new",
      operation: "qa.run_sweep",
      actor: "octocat-schedule",
    });
    expect(audit.posted[1].body.payload).toEqual({
      goalId: "test-goal",
      enabled: false,
      actor: "octocat-schedule",
    });
    expect(audit.posted[2].body.payload.goalId).toBe("test-goal");
  });

  it("misses are state answers, not events: no audit for an unknown goal", async () => {
    const audit = makeAuditCapture();
    const { env } = makeEnv({ audit });
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    expect(await agent.removeGoal("nope", "octocat-schedule")).toBe(false);
    expect(await agent.setGoalEnabled("nope", true, "octocat-schedule")).toBe(false);
    const tick = await agent.triggerGoal("nope", undefined, "octocat-schedule");
    expect(tick.goalsEvaluated).toBe(0);
    expect(audit.posted).toHaveLength(0);
  });

  it("A2A mutations emit with the edge-authenticated caller as actor; reads emit nothing", async () => {
    const audit = makeAuditCapture();
    const { env } = makeEnv({ audit });
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    const attribution = { caller: "a2a-credential:scheduled" };
    await agent.handleA2A(
      { operation: "scheduled.list_goals" },
      "https://agent.test",
      attribution,
    );
    await agent.handleA2A(
      { operation: "scheduled.tick_history" },
      "https://agent.test",
      attribution,
    );
    expect(audit.posted).toHaveLength(0);
    const added = await agent.handleA2A(
      {
        operation: "scheduled.add_goal",
        id: "g-a2a",
        name: "A2A goal",
        cron: "0 6 * * *",
        op: "search.query",
        budgetCents: 250,
      },
      "https://agent.test",
      attribution,
    );
    expect(added.data.ok).toBe(true);
    await agent.handleA2A(
      { operation: "scheduled.set_goal_enabled", id: "g-a2a", enabled: false },
      "https://agent.test",
      attribution,
    );
    await agent.handleA2A(
      { operation: "scheduled.trigger_goal", id: "g-a2a" },
      "https://agent.test",
      attribution,
    );
    await agent.handleA2A(
      { operation: "scheduled.remove_goal", id: "g-a2a" },
      "https://agent.test",
      attribution,
    );
    expect(audit.posted.map((p) => p.body.type)).toEqual([
      "schedule.goal.added",
      "schedule.goal.enabled",
      "schedule.goal.triggered",
      "schedule.goal.removed",
    ]);
    for (const p of audit.posted) {
      expect(p.body.payload.actor).toBe("a2a-credential:scheduled");
    }
    expect(audit.posted[0].body.payload.goalId).toBe("g-a2a");
  });

  it("A2A misses emit nothing", async () => {
    const audit = makeAuditCapture();
    const { env } = makeEnv({ audit });
    const agent = new ScheduledAgent(
      makeCtx([testGoal()]) as never,
      env as never,
    );
    const attribution = { caller: "a2a-credential:scheduled" };
    await agent.handleA2A(
      { operation: "scheduled.remove_goal", id: "nope" },
      "https://agent.test",
      attribution,
    );
    await agent.handleA2A(
      { operation: "scheduled.set_goal_enabled", id: "nope", enabled: true },
      "https://agent.test",
      attribution,
    );
    await agent.handleA2A(
      { operation: "scheduled.trigger_goal", id: "nope" },
      "https://agent.test",
      attribution,
    );
    expect(audit.posted).toHaveLength(0);
  });

  it("an audit failure never fails the mutation it records", async () => {
    const refused = makeAuditCapture({ status: 403 });
    const { env: envRefused } = makeEnv({ audit: refused });
    const agentRefused = new ScheduledAgent(
      makeCtx() as never,
      envRefused as never,
    );
    const created = await agentRefused.addGoal({
      id: "g-refused",
      name: "Refused audit",
      cron: "0 6 * * *",
      operation: "qa.run_sweep",
      budgetCents: 100,
      actor: "octocat-schedule",
    });
    expect(created.id).toBe("g-refused");
    expect(refused.posted).toHaveLength(1);

    const throwing = makeAuditCapture({ throws: true });
    const { env: envThrowing } = makeEnv({ audit: throwing });
    const agentThrowing = new ScheduledAgent(
      makeCtx() as never,
      envThrowing as never,
    );
    const created2 = await agentThrowing.addGoal({
      id: "g-throwing",
      name: "Throwing audit",
      cron: "0 6 * * *",
      operation: "qa.run_sweep",
      budgetCents: 100,
      actor: "octocat-schedule",
    });
    expect(created2.id).toBe("g-throwing");

    // No ORCHESTRATOR_AGENT binding at all: the stub build throws inside
    // the sink and is swallowed — the mutation still lands.
    const { env: envBare } = makeEnv();
    const agentBare = new ScheduledAgent(makeCtx() as never, envBare as never);
    const created3 = await agentBare.addGoal({
      id: "g-bare",
      name: "Bare env",
      cron: "0 6 * * *",
      operation: "qa.run_sweep",
      budgetCents: 100,
      actor: "octocat-schedule",
    });
    expect(created3.id).toBe("g-bare");
  });

  it("the route threads the session actor and posts no audit itself", () => {
    const trading = source("src/server/routes/trading.ts");
    expect(trading).toContain("actor: session.githubLogin");
    expect(trading).toContain("setGoalEnabled(id, enabled, session.githubLogin)");
    expect(trading).toContain("triggerGoal(id, undefined, session.githubLogin)");
    expect(trading).toContain("removeGoal(deleteMatch[1], session.githubLogin)");
    expect(trading).not.toContain("postGoalScheduleAuditEvent");
    expect(trading).not.toContain("auditGoalLifecycle");
    // The funnel lives in exactly one place: the DO methods.
    const agent = source("src/agents/scheduled-agent.ts");
    expect(agent).toContain("private async auditGoalLifecycle");
    for (const event of GOAL_SCHEDULE_AUDIT_EVENTS) {
      expect(agent).toContain(`"${event}"`);
    }
  });
});

describe("S3-P06 the goals view reads the one consolidated ledger (#3121)", () => {
  it("the goals panel reads runs from listAllRuns, normalized, with the ledger's null rule", () => {
    const panel = source("src/client/ScheduledGoalsPanel.tsx");
    expect(panel).toContain("listAllRuns");
    expect(panel).not.toContain("listGoalRuns");
    expect(panel).toContain("normalizeJobRunRecord");
    expect(panel).toContain("ledgerLinkageCell");
    expect(panel).toContain("Recent goal runs");
    expect(panel).toContain("provenance not recorded");
    // The runs read is isolated: a ledger-read failure never fails
    // the goals list.
    expect(panel).toContain("refreshRuns");
    expect(panel).toContain("setRunsError");
  });

  it("the home no longer notes the goals view as 'until S3'", () => {
    expect(source("src/client/SchedulesHome.tsx")).not.toContain("until S3");
    expect(source("src/client/schedulesHomeView.ts")).not.toContain("until S3");
    expect(source("src/client/schedulesHomeView.ts")).toContain("S3: on the");
  });
});

describe("S3-P08 the coverage map is seeded and its homeless rows are filed (#3121)", () => {
  it("§9 maps every B-T3 capability to a home; #3393 and #3394 landed", () => {
    const doc = source("docs/architecture/scheduling/3121-s0-inventory.md");
    expect(doc).toContain("## 9. Capability-coverage map");
    expect(doc).toContain("LOSSLESS AND ADDITIVE");
    const map = doc.slice(doc.indexOf("## 9. Capability-coverage map"));
    for (const id of [
      "B-T3-01",
      "B-T3-02",
      "B-T3-03",
      "B-T3-04",
      "B-T3-05",
      "B-T3-06",
      "B-T3-07",
      "B-T3-08",
    ]) {
      expect(map).toContain(id);
    }
    // The S3 comb's two homeless capabilities were filed, not
    // dropped — and the map says so with their numbers. #3393
    // and #3394 both landed.
    expect(map).toContain("#3393");
    expect(map).toContain("#3394");
    expect(map).toContain("#3393 — landed");
    expect(map).toContain("#3394 — landed");
    // Issue #3313: the B-L-02 outcome-stamping row reads landed.
    expect(map).toContain("#3313 — landed");
    // Issue #3314: the B-L-03 scan-joinability row reads landed.
    expect(map).toContain("#3314 — landed");
  });
});

describe("S3-P07 one of everything — no second audit system, no second read path (#3121)", () => {
  it("the DO sink posts through the one mas_events funnel, not a second audit system", () => {
    const agent = source("src/agents/scheduled-agent.ts");
    // One poster call site, inside the one sink.
    expect(agent.match(/postGoalScheduleAuditEvent\(/g)?.length).toBe(1);
    expect(agent).toContain("SHARED_ORCHESTRATOR_INSTANCE");
    // The URL lives in the shared poster (S1-P08 pins it there);
    // the sink passes its fetch through, it does not re-derive the
    // funnel address.
    expect(source("src/services/consolidatedScheduling.ts")).toContain(
      "https://agent.internal/audit/event",
    );
    // Not the chain-audit D1 sink (a different table, a different
    // funnel): goal lifecycle events go to mas_events only.
    const sink = agent.slice(
      agent.indexOf("private async auditGoalLifecycle"),
      agent.indexOf("Add a new scheduled goal"),
    );
    expect(sink).not.toContain("recordAuditEventBestEffort");
  });

  it("the mesh door threads its identified user as the audit actor", () => {
    const doors = source("src/agents/orchestrator/meshDoors.ts");
    expect(doors).toContain("door.triggerGoal(goalId, undefined, actingLogin)");
  });
});
