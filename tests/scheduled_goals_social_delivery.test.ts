/**
 * #1077 Phase 5b slice 3: onCron delivery pass for social goals.
 *
 * Pinned here (same ScheduledAgent harness as the slice-1 goal tests):
 * - after a social goal fires, pending approvals for the firing date
 *   are delivered as Slack cards through the injected poster;
 * - delivery failures are recorded in tick.errors but never unfire
 *   the goal and never fail the tick;
 * - a second firing (next day, no brief today) does NOT re-deliver an
 *   already-delivered pending record, even though the delivery pass
 *   runs again over the lookback dates;
 * - posting disabled skips delivery entirely.
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
    { agent: "social", binding: "SCHEDULED_AGENT", operations: ["social.publish"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_1", ...req, status: "pending" })),
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { MockD1Database } from "./mock-d1";
import { createD1UnifiedSchedulePorts } from "../src/data/createUnifiedSchedulePorts";
import { goalToRecord } from "../src/services/unifiedScheduleManagement";
import type { SlackPostFn } from "../src/agents/social/delivery";

const MON_0900 = "2026-10-26T13:00:00Z";
const TUE_0900 = "2026-10-27T13:00:00Z";

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

// #6503 — the "goals" KV key is dead: goals live in the D1 unified
// store only (fail-closed without AGENT_DB). Fixtures plant via D1.
function makeCtx() {
  const store = new Map<string, unknown>();
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
      if (body.op === "delete") {
        data.delete(mapKey);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unknown op" }, { status: 400 });
    },
  };
  return {
    namespace: { idFromName: () => "kv", get: () => stub },
    rawGet: (key: string) => data.get(`social:${key}`),
  };
}

function makeEnv(sessionStore?: unknown, extra: Record<string, unknown> = {}) {
  return {
    // #6503 — goals live in the D1 unified store only (fail-closed
    // without AGENT_DB); the agent never reads the "goals" KV key.
    AGENT_DB: new MockD1Database(),
    PAYMENTS_AGENT: { idFromName: () => "payments-default", get: () => makePayments() },
    SESSION_STORE: sessionStore,
    SOCIAL_POSTING_ENABLED: "1",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_CHANNEL: "C-test",
    ...extra,
  } as any;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(MON_0900));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Plant the enabled social goal into `mockD1`, sweeping the seeds. */
async function plantSocialGoal(mockD1: MockD1Database) {
  const store = createD1UnifiedSchedulePorts({ d1: mockD1 as never }).unifiedSchedules;
  await store.save(goalToRecord(socialGoal()));
  // The first store op lazily ensures the schema, and migration
  // 0092's goals seed lands the 9 built-ins — with daily-social-post
  // PAUSED (config enabled: false). The fixture enables it; the other
  // eight are swept so the tick sees ONLY the enabled social goal
  // (same pattern as the #6503 G3 goals-tick file).
  for (const row of await store.listByKind("goal")) {
    if (row.id !== "daily-social-post") await store.remove(row.id);
  }
}

/** One agent over a fresh D1 with the enabled social goal planted. */
async function socialAgent(sessionStore: unknown, extra: Record<string, unknown> = {}) {
  const env = makeEnv(sessionStore, extra);
  await plantSocialGoal(env.AGENT_DB as MockD1Database);
  const agent = new (ScheduledAgent as any)(makeCtx(), env);
  return { agent, env };
}

describe("onCron social delivery pass", () => {
  it("delivers pending approval cards after the goal fires", async () => {
    const session = makeSessionStore();
    const agent = (await socialAgent(session.namespace)).agent;
    const posted: { url: string; body: string }[] = [];
    const poster: SlackPostFn = async (url, headers, body) => {
      posted.push({ url, body });
      return { status: 200, body: JSON.stringify({ ok: true }) };
    };
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Morning brief.",
      socialSlackPost: poster,
    });
    expect(tick.jobsCreated).toBe(1);
    // facebook/instagram/linkedin are approval channels by default.
    expect(posted.length).toBeGreaterThanOrEqual(3);
    for (const p of posted) {
      expect(p.url).toBe("https://slack.com/api/chat.postMessage");
      const body = JSON.parse(p.body);
      expect(body.blocks.some((b: any) => b.type === "actions")).toBe(true);
    }
    // Pending records now carry deliveredDraftId.
    const pending = JSON.parse(session.rawGet("social-pending:2026-10-26:facebook")!);
    expect(pending.deliveredDraftId).toBe(pending.draftId);
  });

  it("does not re-deliver on the next day's firing when the brief is missing", async () => {
    const session = makeSessionStore();
    const { agent } = await socialAgent(session.namespace);
    const posted: string[] = [];
    const poster: SlackPostFn = async (_url, _headers, body) => {
      posted.push(body);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    };
    await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Morning brief.",
      socialSlackPost: poster,
    });
    const firstCount = posted.length;
    expect(firstCount).toBeGreaterThan(0);
    // Next day, no brief: the goal stays due, but the delivery pass
    // must skip the already-delivered pending records.
    vi.setSystemTime(new Date(TUE_0900));
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => null,
      socialSlackPost: poster,
    });
    expect(tick.jobsSkipped).toBeGreaterThanOrEqual(1);
    expect(posted.length).toBe(firstCount);
  });

  it("delivery failure is a tick error, never a goal failure", async () => {
    const session = makeSessionStore();
    const agent = (await socialAgent(session.namespace)).agent;
    const poster: SlackPostFn = async () => ({ status: 500, body: "" });
    const tick = await agent.onCron(makeEnv(session.namespace), {
      socialBriefProvider: () => "Morning brief.",
      socialSlackPost: poster,
    });
    expect(tick.jobsCreated).toBe(1);
    expect(tick.errors.some((e: string) => e.includes("slack delivery"))).toBe(true);
  });

  it("posting disabled skips delivery entirely", async () => {
    const session = makeSessionStore();
    const { agent } = await socialAgent(session.namespace, { SOCIAL_POSTING_ENABLED: "0" });
    const posted: string[] = [];
    const poster: SlackPostFn = async (_url, _headers, body) => {
      posted.push(body);
      return { status: 200, body: JSON.stringify({ ok: true }) };
    };
    await agent.onCron(makeEnv(session.namespace, { SOCIAL_POSTING_ENABLED: "0" }), {
      socialBriefProvider: () => "Morning brief.",
      socialSlackPost: poster,
    });
    expect(posted).toHaveLength(0);
  });
});
