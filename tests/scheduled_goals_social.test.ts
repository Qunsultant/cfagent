/**
 * #1077 Phase 5b slice 1: social posting as a ScheduledAgent goal.
 *
 * Pinned here:
 * - a due "social.publish" goal runs the executor (never createJob)
 *   against the durable SessionStore-backed stores;
 * - noBrief / error leave lastRun untouched, so the goal stays due;
 * - approval end-to-end across two invocations with durable stores;
 * - non-social goals still go through createJob unchanged;
 * - addGoal accepts ranges/lists + timeZone, rejects bad timeZones;
 * - a missing SESSION_STORE binding fails closed, goal left due.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    { agent: "social", binding: "SCHEDULED_AGENT", operations: ["social.publish"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { createJob } from "../src/orchestrate";
import { createSessionStoreSocialLedger, createSessionStorePendingApprovalStore } from "../src/agents/social/durableStores";
import { approveDraft } from "../src/agents/social/approvals";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";

// Monday 2026-10-26 09:00 EDT = 13:00Z; Saturday 2026-10-24 09:00 EDT.
const MON_0900 = "2026-10-26T13:00:00Z";
const SAT_0900 = "2026-10-24T13:00:00Z";

function socialGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "daily-social-post",
    name: "Daily social post",
    cron: "0 9 * * 1-5",
    timeZone: "America/New_York",
    operation: "social.publish",
    budgetCents: 1,
    enabled: true,
    ...overrides,
  };
}

function makeCtx(initialGoals?: unknown[]) {
  const store = new Map<string, unknown>();
  if (initialGoals) store.set("goals", initialGoals);
  return {
    storage: {
      get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
  };
}

function makePayments() {
  return { budgetCheck: async () => ({ allowed: true }) };
}

/** Fake SessionStore DO namespace with the real reply contract + raw access. */
function makeSessionStore() {
  const data = new Map<string, string>();
  const ops: string[] = [];
  const stub = {
    async fetch(req: Request): Promise<Response> {
      const body = (await req.json()) as { op: string; ns: string; key: string; value?: string };
      ops.push(body.op);
      const mapKey = `${body.ns}:${body.key}`;
      if (body.op === "list") {
        return Response.json({ error: "list is restricted to E*TRADE token entries" }, { status: 400 });
      }
      if (body.op === "get") {
        return Response.json({ value: data.has(mapKey) ? data.get(mapKey)! : null });
      }
      if (body.op === "put") {
        data.set(mapKey, body.value!);
        return Response.json({ ok: true });
      }
      if (body.op === "delete") {
        data.delete(mapKey);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unknown op" }, { status: 400 });
    },
  };
  return {
    namespace: { idFromName: () => "kv", get: () => stub },
    ops,
    rawGet: (key: string) => data.get(`social:${key}`),
    rawKeys: () => [...data.keys()],
  };
}

function makeEnv(sessionStore?: unknown, extra: Record<string, unknown> = {}) {
  return {
    PAYMENTS_AGENT: { idFromName: () => "payments-default", get: () => makePayments() },
    SESSION_STORE: sessionStore,
    SOCIAL_POSTING_ENABLED: "1",
    ...extra,
  } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MON_0900));
  vi.mocked(createJob).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("onCron social.publish goals", () => {
  it("fires a due social goal through the executor with durable stores, never createJob", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const sink = createMemoryDryRunSink();
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Morning brief.",
      socialDryRunSink: sink,
    });
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors).toEqual([]);
    expect(createJob).not.toHaveBeenCalled();
    const goals = await agent.listGoals();
    expect(goals[0].lastRun).toBe(new Date(MON_0900).toISOString());
    // Drafts landed in the durable store (never a list op).
    expect(session.ops).not.toContain("list");
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:x")!).status).toBe("dry-run-posted");
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:facebook")!).status).toBe("draft");
    expect(session.rawGet("social-pending:2026-10-26:facebook")).toBeDefined();
    expect(sink.records.map((r) => r.channel).sort()).toEqual(["threads", "x"]);
  });

  it("leaves lastRun untouched on noBrief, so the goal stays due and retries", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const first = await agent.onCron(makeEnv(session.namespace), { socialBriefProvider: () => null });
    expect(first.jobsCreated).toBe(0);
    expect(first.jobsSkipped).toBe(1);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    expect(session.rawKeys()).toEqual([]);
    // Still due on the next tick: retries instead of going silent.
    const second = await agent.onCron(makeEnv(session.namespace), { socialBriefProvider: () => null });
    expect(second.jobsSkipped).toBe(1);
  });

  it("records an executor error and leaves the goal due", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => {
        throw new Error("brief exploded");
      },
    });
    expect(tick.errors.some((e: string) => e.includes("daily-social-post") && e.includes("brief exploded"))).toBe(true);
    expect(tick.jobsSkipped).toBe(1);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
  });

  it("approval end-to-end across two invocations with durable stores", async () => {
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const sink = createMemoryDryRunSink();
    const opts = { socialBriefProvider: () => "Morning brief.", socialDryRunSink: sink };
    await agent.onCron(makeEnv(session.namespace), opts);
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:facebook")!).status).toBe("draft");
    // Approve through the durable stores, exactly as an operator action would.
    const ledger = createSessionStoreSocialLedger(session.namespace.get("kv") as never);
    const approvals = createSessionStorePendingApprovalStore(session.namespace.get("kv") as never);
    const approved = await approveDraft(ledger, approvals, "2026-10-26", "facebook", "owner", Date.parse(MON_0900));
    expect(approved.ok).toBe(true);
    // Second invocation: the goal is still due (lastRun was set by the
    // first run, so clear it to simulate the next day's window — the
    // draft itself is what must not republish).
    const goals = await agent.listGoals();
    goals[0].lastRun = undefined;
    const second = await agent.onCron(makeEnv(session.namespace), opts);
    expect(second.jobsCreated).toBe(1);
    expect(JSON.parse(session.rawGet("social-draft:2026-10-26:facebook")!).status).toBe("dry-run-posted");
    expect(sink.records.map((r) => r.channel)).toContain("facebook");
    expect(session.rawGet("social-pending:2026-10-26:facebook")).toBeUndefined();
  });

  it("does not fire a weekday goal on Saturday", async () => {
    vi.setSystemTime(new Date(SAT_0900));
    const session = makeSessionStore();
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(session.namespace));
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Morning brief.",
    });
    expect(tick.jobsCreated).toBe(0);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
    expect(session.rawKeys()).toEqual([]);
  });

  it("fails closed without a SESSION_STORE binding, goal left due", async () => {
    const agent = new (ScheduledAgent as any)(makeCtx([socialGoal()]), makeEnv(undefined));
    const envWithoutStore = makeEnv(undefined);
    delete envWithoutStore.SESSION_STORE;
    const tick = await agent.onCron(envWithoutStore, { socialBriefProvider: () => "Morning brief." });
    expect(tick.jobsSkipped).toBe(1);
    expect(tick.errors.some((e: string) => e.includes("SESSION_STORE"))).toBe(true);
    expect((await agent.listGoals())[0].lastRun).toBeUndefined();
  });

  it("non-social goals still go through createJob unchanged", async () => {
    const session = makeSessionStore();
    const searchGoal = {
      id: "midday-search",
      name: "Midday search",
      cron: "0 13 * * *",
      operation: "search.query",
      budgetCents: 100,
      enabled: true,
    };
    const agent = new (ScheduledAgent as any)(
      makeCtx([searchGoal, socialGoal({ enabled: false })]),
      makeEnv(session.namespace),
    );
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Morning brief.",
    });
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(createJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ goalId: "midday-search", operation: "search.query" }),
    );
    expect(tick.jobsCreated).toBe(1);
  });
});

describe("addGoal social schedules", () => {
  it("accepts ranges/lists and stores a valid timeZone", async () => {
    const agent = new (ScheduledAgent as any)(makeCtx(), makeEnv());
    const goal = await agent.addGoal({
      id: "social-weekdays",
      name: "Social weekdays",
      cron: "0 9 * * 1-5",
      timeZone: "America/New_York",
      operation: "social.publish",
      budgetCents: 1,
    });
    expect(goal.cron).toBe("0 9 * * 1-5");
    expect(goal.timeZone).toBe("America/New_York");
    const listed = await agent.addGoal({
      id: "social-mixed",
      name: "Social mixed",
      cron: "0,30 9 * * 1,3,5",
      operation: "social.publish",
      budgetCents: 1,
    });
    expect(listed.cron).toBe("0,30 9 * * 1,3,5");
    expect(listed.timeZone).toBeUndefined();
  });

  it("rejects an invalid timeZone and still rejects unknown operations", async () => {
    const agent = new (ScheduledAgent as any)(makeCtx(), makeEnv());
    await expect(
      agent.addGoal({
        id: "bad-zone",
        name: "Bad zone",
        cron: "0 9 * * 1-5",
        timeZone: "Mars/Olympus",
        operation: "social.publish",
        budgetCents: 1,
      }),
    ).rejects.toThrow(/Invalid timeZone/);
    await expect(
      agent.addGoal({
        id: "bad-op",
        name: "Bad op",
        cron: "0 9 * * 1-5",
        operation: "nope.nope",
        budgetCents: 1,
      }),
    ).rejects.toThrow(/Unknown operation/);
  });
});
