/**
 * Issue #3996 — built-in scheduled goals read endpoint:
 * GET /api/schedule/builtin-goals returns the canonical
 * DEFAULT_SCHEDULES definitions from the server (single source of
 * truth — the client must not carry a second copy of the values).
 *
 * Red first: the endpoint does not exist yet.
 *
 * Gate preserved from #1156/#1922: unauthenticated → 401, any
 * signed-in user may read, no admin gate invented.
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

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-31200000000c";

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: "octocat-builtin" });
  const agent = {
    listGoals: async () => [],
    getTickHistory: async () => [],
    addGoal: async (goal: Record<string, unknown>) => goal,
    removeGoal: async () => false,
    setGoalEnabled: async () => false,
    triggerGoal: async () => ({}),
  };
  return {
    env: {
      SESSION_STORE: sessionStoreNs,
      SCHEDULED_AGENT: {
        idFromName: (name: string) => name,
        get: () => agent,
      },
    } as unknown as Env,
  };
}

function req(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`https://agent.test${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: `session_id=${cookie}; csrf_token=csrf-test-token`, "X-CSRF-Token": "csrf-test-token" } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("built-in scheduled goals endpoint (#3996)", () => {
  it("unauthenticated GET /api/schedule/builtin-goals → 401", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("GET", "/api/schedule/builtin-goals"), env);
    expect(res.status).toBe(401);
  });

  it("authenticated GET lists all 8 built-ins with their canonical values", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("GET", "/api/schedule/builtin-goals", undefined, SESSION_ID), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      goals: {
        id: string;
        name: string;
        cron: string;
        operation: string;
        budgetCents: number;
        enabled: boolean;
        timeZone?: string;
      }[];
    };
    expect(body.ok).toBe(true);
    expect(body.goals).toHaveLength(9);
    const byId = new Map(body.goals.map((g) => [g.id, g]));
    expect(new Set(body.goals.map((g) => g.id)).size).toBe(9);
    expect(byId.get("daily-qa-sweep")).toMatchObject({
      name: "Daily QA sweep",
      cron: "0 6 * * *",
      operation: "qa.run_sweep",
      budgetCents: 500,
      enabled: true,
    });
    expect(byId.get("daily-qa-sweep")?.timeZone).toBeUndefined();
    expect(byId.get("opportunity-hunt")).toMatchObject({
      name: "Opportunity hunt",
      cron: "0 */6 * * *",
      operation: "search.opportunity_hunt",
      budgetCents: 1000,
      enabled: true,
    });
    expect(byId.get("opportunity-hunt")?.timeZone).toBeUndefined();
    expect(byId.get("daily-social-post")).toMatchObject({
      name: "Daily social post",
      cron: "0 9 * * 1-5",
      operation: "social.publish",
      budgetCents: 1,
      enabled: false,
      timeZone: "America/New_York",
    });
    expect(byId.get("resource-daily-rollup")).toMatchObject({
      cron: "30 1 * * *",
      operation: "resource.rollup_daily",
      budgetCents: 1,
      enabled: true,
      timeZone: "UTC",
    });
    expect(byId.get("resource-cap-alert")).toMatchObject({
      cron: "0 * * * *",
      operation: "resource.cap_alert",
      enabled: true,
      timeZone: "UTC",
    });
    expect(byId.get("resource-dashboard-comparison")).toMatchObject({
      cron: "0 2 * * *",
      operation: "resource.dashboard_comparison",
      enabled: true,
      timeZone: "UTC",
    });
    expect(byId.get("index-refresh-wikipedia")).toMatchObject({
      cron: "0 4 * * 0",
      operation: "index.refresh_wikipedia",
      enabled: true,
      timeZone: "UTC",
    });
    expect(byId.get("index-refresh-holdings")).toMatchObject({
      cron: "0 3 * * *",
      operation: "index.refresh_holdings",
      budgetCents: 1,
      enabled: false,
      timeZone: "UTC",
    });
    // Issue #4411: the monthly Autopilot evaluation.
    expect(byId.get("autopilot-monthly-evaluation")).toMatchObject({
      name: "Autopilot monthly evaluation",
      cron: "0 9 1 * *",
      operation: "autopilot.evaluate",
      budgetCents: 1,
      enabled: true,
      timeZone: "UTC",
    });
    // DEFAULT_SCHEDULES order is the seed order.
    expect(body.goals.map((g) => g.id)).toEqual([
      "daily-qa-sweep",
      "opportunity-hunt",
      "daily-social-post",
      "resource-daily-rollup",
      "resource-cap-alert",
      "resource-dashboard-comparison",
      "index-refresh-wikipedia",
      "index-refresh-holdings",
      "autopilot-monthly-evaluation",
    ]);
  });
});
