/**
 * Issue #1156: /api/schedule/* dashboard routes are session-gated.
 *
 * Pinned here (worker.fetch harness, same pattern as the social brief
 * routes): every /api/schedule/* route returns 401 unauthenticated,
 * and authenticated calls behave exactly as before (list, add, ticks,
 * enabled, trigger, delete). Any signed-in user may use the dashboard;
 * no admin gate is invented here, matching the brief/approval routes.
 */
import { describe, it, expect, vi } from "vitest";
import { makeFakeSessionStore } from "./fake-session-store";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";
import type { Env } from "../src/types";

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-31200000000a";

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: "octocat-schedule" });
  const goals: Record<string, unknown>[] = [
    { id: "g1", name: "Goal One", cron: "0 9 * * 1-5", operation: "social.publish", budgetCents: 1, enabled: true },
  ];
  const agent = {
    listGoals: async () => goals,
    getTickHistory: async (limit?: number) => [{ timestamp: "t0", limit: limit ?? 20 }],
    addGoal: async (goal: Record<string, unknown>) => {
      goals.push(goal);
      return goal;
    },
    removeGoal: async (id: string) => {
      const idx = goals.findIndex((g) => (g as { id: string }).id === id);
      if (idx < 0) return false;
      goals.splice(idx, 1);
      return true;
    },
    setGoalEnabled: async (id: string, enabled: boolean) => {
      const goal = goals.find((g) => (g as { id: string }).id === id) as
        | { enabled: boolean }
        | undefined;
      if (!goal) return false;
      goal.enabled = enabled;
      return true;
    },
    triggerGoal: async (id: string) => ({ goalId: id, fired: true }),
  };
  return {
    SESSION_STORE: sessionStoreNs,
    SCHEDULED_AGENT: {
      idFromName: (name: string) => name,
      get: () => agent,
    },
  } as unknown as Env;
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      // Q5 slice: cookie-authenticated test requests carry the CSRF token a real client sends.
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("schedule dashboard routes session gate (#1156)", () => {
  it("unauthenticated calls to every route → 401", async () => {
    const env = makeEnv();
    const cases: [string, string, unknown?][] = [
      ["GET", "/api/schedule/goals"],
      ["POST", "/api/schedule/goals", { id: "g2", name: "G2", cron: "0 9 * * *", operation: "social.publish", budgetCents: 1 }],
      ["GET", "/api/schedule/ticks"],
      ["POST", "/api/schedule/goals/g1/enabled", { enabled: false }],
      ["POST", "/api/schedule/goals/g1/trigger"],
      ["DELETE", "/api/schedule/goals/g1"],
    ];
    for (const [method, path, body] of cases) {
      const res = await worker.fetch(req(method, path, body), env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("authenticated GET goals lists goals, unchanged", async () => {
    const res = await worker.fetch(req("GET", "/api/schedule/goals", undefined, SESSION_ID), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; goals: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.goals).toHaveLength(1);
  });

  it("authenticated POST goals adds a goal, unchanged", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      req("POST", "/api/schedule/goals", { id: "g2", name: "G2", cron: "0 9 * * *", operation: "social.publish", budgetCents: 1 }, SESSION_ID),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; goal: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.goal.id).toBe("g2");
  });

  it("authenticated GET ticks returns history, unchanged", async () => {
    const res = await worker.fetch(req("GET", "/api/schedule/ticks", undefined, SESSION_ID), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ticks: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.ticks).toHaveLength(1);
  });

  it("authenticated enabled/trigger/delete behave unchanged", async () => {
    const env = makeEnv();
    const enabled = await worker.fetch(
      req("POST", "/api/schedule/goals/g1/enabled", { enabled: false }, SESSION_ID),
      env,
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toEqual({ ok: true });
    const triggered = await worker.fetch(
      req("POST", "/api/schedule/goals/g1/trigger", undefined, SESSION_ID),
      env,
    );
    expect(triggered.status).toBe(200);
    expect(await triggered.json()).toEqual({ ok: true, tick: { goalId: "g1", fired: true } });
    const deleted = await worker.fetch(
      req("DELETE", "/api/schedule/goals/g1", undefined, SESSION_ID),
      env,
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    const missing = await worker.fetch(
      req("POST", "/api/schedule/goals/nope/enabled", { enabled: true }, SESSION_ID),
      env,
    );
    expect(missing.status).toBe(404);
  });
});
