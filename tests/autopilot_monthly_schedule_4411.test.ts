/**
 * Issue #4411 — monthly Autopilot evaluation schedule (sub-issue of #3121).
 *
 * Measured finding (verified on main 534e890, re-verified on 94427e5):
 * no Autopilot schedule exists anywhere in code, so this slice ADDS one
 * stored definition — the monthly evaluation — wired through the single
 * scheduling mechanism (ScheduledAgent goals). The run calls the
 * existing POST /api/autopilot/evaluate path with the same
 * representative dry-run intent the manual Run Policy Check button sends
 * when no universe symbol is configured (first universe symbol, SPY
 * fallback, BUY 10 MARKET, dryRun) — see
 * AutopilotControlCenter.tsx:696. The evaluation never places orders.
 *
 * Pins (Red on main, Green with the slice):
 * - DEFAULT_SCHEDULES carries the monthly goal with its canonical values.
 * - OPERATION_CATALOG lists autopilot.evaluate (addGoal accepts it) and
 *   createJob accepts the operation.
 * - GUARD_ALLOWLIST lists autopilot.evaluate: the budget check runs for
 *   every due goal before dispatch, and an unlisted operation is skipped
 *   with "operation not allowlisted" — the qa.run_sweep precedent.
 * - AGENT_SCHEDULABLE_GOAL_OPERATIONS lists it (#3122-P01 accounting:
 *   every catalog operation must be in exactly one of schedulable or
 *   excluded).
 * - The monthly cron fires 09:00 UTC on the 1st, not on the 2nd; the
 *   watchdog's previousCronTickMs has no attributable tick for a monthly
 *   cron, so it never flags the schedule as missed.
 * - A forced tick with an injected executor stamps lastRun and names the
 *   verdict; a failing executor leaves the goal due; a throwing executor
 *   records a failure and leaves the goal due.
 * - With no executor, the production path fails visibly and leaves the
 *   goal due when no service identity is configured, or when the
 *   OrchestratorAgent binding is absent (never a silent no-op, never a
 *   substituted identity).
 * - The production evaluator posts the representative dry-run intent to
 *   the OrchestratorAgent evaluate endpoint and parses the verdict.
 * - The Autopilot page's Policy decisions source line names the monthly
 *   schedule as a verdict writer (#4407 provenance rule).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
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

import { DEFAULT_SCHEDULES, isDue, previousCronTickMs } from "../src/schedule";
import { OPERATION_CATALOG, createJob } from "../src/orchestrate";
import { AGENT_SCHEDULABLE_GOAL_OPERATIONS } from "../src/services/agentScheduleCapability";
import { BudgetGuard } from "../src/payments/budget-guard";
import { GUARD_ALLOWLIST } from "../src/agents/payments-agent";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import {
  runAutopilotMonthlyEvaluation,
  AUTOPILOT_MONTHLY_EVALUATION_REQUESTED_BY,
  type AutopilotMonthlyEvaluationResult,
} from "../src/services/autopilotMonthlyEvaluation";

const MONTHLY_GOAL_ID = "autopilot-monthly-evaluation";

function monthlyGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: MONTHLY_GOAL_ID,
    name: "Autopilot monthly evaluation",
    cron: "0 9 1 * *",
    timeZone: "UTC",
    operation: "autopilot.evaluate",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
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

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "default",
      get: () => ({ budgetCheck: async () => ({ allowed: true }) }),
    },
    SESSION_STORE: null,
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

describe("monthly Autopilot evaluation schedule (#4411)", () => {
  it("DEFAULT_SCHEDULES carries the monthly goal with its canonical values", () => {
    const goal = DEFAULT_SCHEDULES.find((g) => g.id === MONTHLY_GOAL_ID);
    expect(goal).toBeDefined();
    expect(goal).toMatchObject({
      name: "Autopilot monthly evaluation",
      cron: "0 9 1 * *",
      timeZone: "UTC",
      operation: "autopilot.evaluate",
      budgetCents: 1,
      enabled: true,
    });
  });

  it("OPERATION_CATALOG lists autopilot.evaluate under agent autopilot", () => {
    const autopilot = OPERATION_CATALOG.find((e) => e.agent === "autopilot");
    expect(autopilot).toBeDefined();
    expect(autopilot!.binding).toBe("SCHEDULED_AGENT");
    expect(autopilot!.operations).toContain("autopilot.evaluate");
  });

  it("createJob accepts autopilot.evaluate and returns a pending descriptor", async () => {
    const job = await createJob(makeEnv() as never, {
      goalId: MONTHLY_GOAL_ID,
      goalName: "Autopilot monthly evaluation",
      operation: "autopilot.evaluate",
      budgetCents: 1,
    });
    expect(job.operation).toBe("autopilot.evaluate");
    expect(job.status).toBe("pending");
  });

  it("GUARD_ALLOWLIST lists autopilot.evaluate so the budget check passes it", () => {
    expect(GUARD_ALLOWLIST).toContain("autopilot.evaluate");
    const guard = BudgetGuard.restore({ allowlist: GUARD_ALLOWLIST }, null);
    expect(
      guard.check({
        agentId: "orchestrator",
        operation: "autopilot.evaluate",
        amountCents: 1,
        idempotencyKey: "4411-test",
      }).allowed,
    ).toBe(true);
  });

  it("AGENT_SCHEDULABLE_GOAL_OPERATIONS lists autopilot.evaluate", () => {
    expect(AGENT_SCHEDULABLE_GOAL_OPERATIONS).toContain("autopilot.evaluate");
  });

  it("the monthly cron fires 09:00 UTC on the 1st and not on the 2nd", () => {
    expect(
      isDue("0 9 1 * *", undefined, new Date("2026-11-01T09:00:00Z"), "UTC"),
    ).toBe(true);
    expect(
      isDue("0 9 1 * *", undefined, new Date("2026-11-02T09:00:00Z"), "UTC"),
    ).toBe(false);
    expect(
      isDue("0 9 1 * *", undefined, new Date("2026-11-01T09:30:00Z"), "UTC"),
    ).toBe(true);
  });

  it("previousCronTickMs has no attributable tick for a monthly cron", () => {
    // #3788 watchdog: a monthly cron scans back only 8 days, so it never
    // flags the schedule as missed.
    expect(
      previousCronTickMs("0 9 1 * *", new Date("2026-11-15T12:00:00Z"), "UTC"),
    ).toBeUndefined();
  });

  it("a forced tick with a passing executor stamps lastRun and names the verdict", async () => {
    // 2026-11-01 is a Sunday and the 1st of the month.
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const ctx = makeCtx([monthlyGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(
      async (): Promise<AutopilotMonthlyEvaluationResult> => ({
        ok: true,
        verdictId: "v-monthly-1",
        passed: true,
        bindingRule: null,
        descriptor: "monthly policy check: verdict v-monthly-1 — passed",
      }),
    );
    const tick = await agent.onCron(env as never, {
      halted: false,
      autopilotEvaluateExecutor: executor,
    } as never);
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: MONTHLY_GOAL_ID }));
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBe("2026-11-01T09:00:00.000Z");
  });

  it("a forced tick with a failing executor leaves the goal due", async () => {
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const ctx = makeCtx([monthlyGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(
      async (): Promise<AutopilotMonthlyEvaluationResult> => ({
        ok: false,
        error: "evaluate endpoint refused: HTTP 500",
      }),
    );
    const tick = await agent.onCron(env as never, {
      halted: false,
      autopilotEvaluateExecutor: executor,
    } as never);
    expect(tick.errors.join(" ")).toMatch(/HTTP 500/);
    expect(tick.jobsSkipped).toBe(1);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });

  it("a forced tick with a throwing executor records a failure and leaves the goal due", async () => {
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const ctx = makeCtx([monthlyGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const executor = vi.fn(async (): Promise<AutopilotMonthlyEvaluationResult> => {
      throw new Error("orchestrator unreachable");
    });
    const tick = await agent.onCron(env as never, {
      halted: false,
      autopilotEvaluateExecutor: executor,
    } as never);
    expect(tick.errors.join(" ")).toMatch(/orchestrator unreachable/);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });

  it("with no executor and no service identity the goal is skipped visibly, not silently", async () => {
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const ctx = makeCtx([monthlyGoal()]);
    const env = makeEnv();
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.errors.join(" ")).toMatch(/SERVICE_USER_LOGIN/);
    expect(tick.jobsSkipped).toBe(1);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });

  it("with a service identity but no OrchestratorAgent binding the goal is skipped visibly", async () => {
    vi.setSystemTime(new Date("2026-11-01T09:00:00Z"));
    const ctx = makeCtx([monthlyGoal()]);
    const env = makeEnv({ SERVICE_USER_LOGIN: "service-user" });
    const agent = new ScheduledAgent(ctx as never, env as never);
    const tick = await agent.onCron(env as never, { halted: false } as never);
    expect(tick.errors.join(" ")).toMatch(/ORCHESTRATOR_AGENT/);
    expect(tick.jobsSkipped).toBe(1);
    const goals = ctx._store.get("goals") as any[];
    expect(goals[0].lastRun).toBeUndefined();
  });
});

describe("runAutopilotMonthlyEvaluation (#4411)", () => {
  function fakeFetch(
    response: Response,
    capture: { request?: Request },
  ): (req: Request) => Promise<Response> {
    return async (req: Request) => {
      capture.request = req;
      return response;
    };
  }

  function verdictResponse(verdict: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ verdict, attestation: {}, requestedBy: "autopilot-monthly-schedule" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("posts the representative dry-run intent to the evaluate endpoint", async () => {
    const capture: { request?: Request } = {};
    const result = await runAutopilotMonthlyEvaluation({
      serviceLogin: "service-user",
      evaluateFetch: fakeFetch(
        verdictResponse({ id: "v-1", passed: true, bindingRule: null }),
        capture,
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.verdictId).toBe("v-1");
    expect(result.passed).toBe(true);
    const req = capture.request!;
    expect(req.url).toBe("https://agent.internal/api/autopilot/evaluate");
    expect(req.method).toBe("POST");
    expect(req.headers.get("x-user-login")).toBe("service-user");
    const body = (await req.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      symbol: "SPY",
      action: "BUY",
      quantity: 10,
      orderType: "MARKET",
      dryRun: true,
      requestedBy: AUTOPILOT_MONTHLY_EVALUATION_REQUESTED_BY,
    });
  });

  it("reports a blocked verdict with its binding rule", async () => {
    const result = await runAutopilotMonthlyEvaluation({
      serviceLogin: "service-user",
      evaluateFetch: fakeFetch(
        verdictResponse({ id: "v-2", passed: false, bindingRule: "max-position" }),
        {},
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.bindingRule).toBe("max-position");
    expect(result.descriptor).toMatch(/blocked/);
    expect(result.descriptor).toMatch(/max-position/);
  });

  it("fails visibly on a non-2xx evaluate response", async () => {
    const result = await runAutopilotMonthlyEvaluation({
      serviceLogin: "service-user",
      evaluateFetch: fakeFetch(
        new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
        {},
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it("fails visibly when the evaluate response carries no verdict", async () => {
    const result = await runAutopilotMonthlyEvaluation({
      serviceLogin: "service-user",
      evaluateFetch: fakeFetch(
        new Response(JSON.stringify({}), { status: 200 }),
        {},
      ),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no verdict/);
  });

  it("fails visibly with no service identity configured", async () => {
    const result = await runAutopilotMonthlyEvaluation({
      serviceLogin: null,
      evaluateFetch: fakeFetch(verdictResponse({ id: "v-1", passed: true, bindingRule: null }), {}),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SERVICE_USER_LOGIN/);
  });

  it("fails visibly with no OrchestratorAgent fetch available", async () => {
    const result = await runAutopilotMonthlyEvaluation({
      serviceLogin: "service-user",
      evaluateFetch: null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ORCHESTRATOR_AGENT/);
  });
});

describe("Autopilot page names the monthly schedule as a verdict writer (#4411)", () => {
  it("the Policy decisions source line names the monthly Autopilot evaluation schedule", () => {
    const source = readFileSync(
      join(__dirname, "../src/client/components/AutopilotControlCenter.tsx"),
      "utf8",
    );
    const policyDecisions = source.slice(source.indexOf('title="Policy decisions"'));
    const sourceLine = policyDecisions.slice(
      policyDecisions.indexOf("Source:"),
      policyDecisions.indexOf("</span>", policyDecisions.indexOf("Source:")),
    );
    expect(sourceLine).toContain("monthly Autopilot evaluation schedule");
    expect(sourceLine).toContain("Schedules home");
  });
});
