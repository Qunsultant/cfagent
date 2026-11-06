/**
 * Issue #1391: ScheduledAgent RPC boundary safety and disabled-goal manual trigger.
 *
 * Verifies:
 * 1. ScheduledAgent.onCron() and ScheduledAgent.triggerGoal(id) work without passing
 *    the Worker Env across the Durable Object RPC boundary (reading this.env instead).
 * 2. Manual triggerGoal(id) evaluates a goal even when enabled: false (like daily-social-post
 *    in default schedules), and restores enabled: false in storage so the daily schedule
 *    remains disabled.
 * 3. Proves why passing the Worker Env across RPC threw DataCloneError in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    { agent: "search", binding: "ORCHESTRATOR_AGENT", operations: ["search.query"], blurb: "" },
    {
      agent: "social",
      binding: "SCHEDULED_AGENT",
      operations: ["social.publish", "pipeline:social-daily"],
      blurb: "",
    },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { PaymentsAgent } from "../src/agents/payments-agent";
import { createJob } from "../src/orchestrate";
import { zonedDateParts } from "../src/schedule";

function makeCtx(initialGoals?: unknown[]) {
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

function makeSessionStore() {
  const data = new Map<string, string>();
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
      const mapKey = `${body.ns}:${body.key}`;
      if (body.op === "get") {
        return Response.json({ value: data.has(mapKey) ? data.get(mapKey)! : null });
      }
      if (body.op === "put") {
        data.set(mapKey, body.value!);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    },
  };
  return {
    rawGet: (k: string) => data.get(`social:${k}`),
    rawSet: (k: string, v: string) => data.set(`social:${k}`, v),
    namespace: { idFromName: () => "kv", get: () => stub },
  };
}

function makeEnv(sessionNamespace?: any) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async () => ({ allowed: true }),
      }),
    },
    SESSION_STORE: sessionNamespace,
    SOCIAL_POSTING_ENABLED: "1",
    SOCIAL_AUTONOMOUS_CHANNELS: "threads",
    THREADS_ACCESS_TOKEN: "valid-threads-token",
  } as any;
}

describe("ScheduledAgent DO RPC boundary (#1391)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("proves Worker env is not serializable across structured clone", () => {
    const env = makeEnv();
    expect(() => structuredClone(env)).toThrow();
  });

  it("onCron executes with 0 arguments using this.env", async () => {
    const ctx = makeCtx([
      {
        id: "daily-qa-sweep",
        name: "Daily QA sweep",
        cron: "* * * * *",
        timeZone: "UTC",
        operation: "search.query",
        budgetCents: 500,
        enabled: true,
      },
    ]);
    const env = makeEnv();
    const agent = new (ScheduledAgent as any)(ctx, env);

    // Call onCron with NO arguments, exactly as the RPC caller does
    const tick = await (agent as any).onCron();

    expect(tick).toBeDefined();
    expect(tick.timestamp).toBeTruthy();
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(1);
    expect(createJob).toHaveBeenCalled();
  });

  it("triggerGoal executes with 1 argument (goal id) and evaluates disabled goal", async () => {
    const ss = makeSessionStore();
    const today = zonedDateParts(Date.now(), "America/New_York").date;
    ss.rawSet(`social-brief:${today}`, JSON.stringify({
      text: "Daily brief for threads.",
      date: today,
      updatedAtMs: Date.now(),
    }));

    const disabledSocialGoal = {
      id: "daily-social-post",
      name: "Daily social post",
      cron: "0 9 * * 1-5",
      timeZone: "America/New_York",
      operation: "social.publish",
      budgetCents: 1,
      enabled: false, // Disabled by default!
    };

    const ctx = makeCtx([disabledSocialGoal]);
    const env = makeEnv(ss.namespace);
    const agent = new (ScheduledAgent as any)(ctx, env);

    // Call triggerGoal with ONLY the goal id (no env argument!)
    const tick = await (agent as any).triggerGoal("daily-social-post");


    expect(tick).toBeDefined();
    expect(tick.goalsEvaluated).toBe(1);
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);

    // Verify the goal is STILL disabled in storage!
    const goals = await agent.listGoals();
    const stored = goals.find((g: any) => g.id === "daily-social-post");
    expect(stored).toBeDefined();
    expect(stored.enabled).toBe(false);
    expect(stored.lastRun).toBeTruthy();
  });

  it("interacts with real PaymentsAgent without budgetCheck rejection (#1391)", async () => {
    const ss = makeSessionStore();
    const today = zonedDateParts(Date.now(), "America/New_York").date;
    ss.rawSet(`social-brief:${today}`, JSON.stringify({
      text: "Daily brief for threads.",
      date: today,
      updatedAtMs: Date.now(),
    }));

    const disabledSocialGoal = {
      id: "daily-social-post",
      name: "Daily social post",
      cron: "0 9 * * 1-5",
      timeZone: "America/New_York",
      operation: "social.publish",
      budgetCents: 1,
      enabled: false,
    };

    const ctx = makeCtx([disabledSocialGoal]);
    const paymentsAgent = new (PaymentsAgent as any)(makeCtx(), {
      // Issue #1185: the ledger forward budgetCheck reads requires the
      // configured service identity; without it the check fails closed
      // and the goal never fires.
      SERVICE_USER_LOGIN: "test_service",
      ORCHESTRATOR_AGENT: {
        idFromName: () => "search",
        get: () => ({
          fetch: async () => Response.json({ state: { dailySpend: [], seenKeys: [] } }),
        }),
      },
    });

    const env = {
      PAYMENTS_AGENT: {
        idFromName: () => "default",
        get: () => paymentsAgent,
      },
      SESSION_STORE: ss.namespace,
      SOCIAL_POSTING_ENABLED: "1",
      SOCIAL_AUTONOMOUS_CHANNELS: "threads",
      THREADS_ACCESS_TOKEN: "valid-threads-token",
    } as any;

    const agent = new (ScheduledAgent as any)(ctx, env);
    const tick = await (agent as any).triggerGoal("daily-social-post");

    expect(tick.jobsCreated).toBe(1);
    expect(tick.jobsSkipped).toBe(0);
    expect(tick.errors).toEqual([]);
  });

  it("records budget check error in tick.errors if rejected (#1391)", async () => {
    const disabledGoal = {
      id: "custom-unallowed-goal",
      name: "Custom Goal",
      cron: "0 9 * * 1-5",
      operation: "disallowed.operation",
      budgetCents: 100,
      enabled: true,
    };

    const ctx = makeCtx([disabledGoal]);
    const paymentsAgent = new (PaymentsAgent as any)(makeCtx(), {
      ORCHESTRATOR_AGENT: {
        idFromName: () => "orchestrator",
        get: () => ({
          fetch: async () => Response.json({ state: { dailySpend: {}, seenKeys: [] } }),
        }),
      },
    });

    const env = {
      PAYMENTS_AGENT: {
        idFromName: () => "default",
        get: () => paymentsAgent,
      },
    } as any;

    const agent = new (ScheduledAgent as any)(ctx, env);
    const tick = await (agent as any).triggerGoal("custom-unallowed-goal");

    expect(tick.jobsCreated).toBe(0);
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.some((e: string) => e.includes("budget check rejected"))).toBe(true);
  });
});

