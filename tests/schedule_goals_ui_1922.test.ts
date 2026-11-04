/**
 * Issue #1922 — schedule-goals UI: catalog operations endpoint + timeZone
 * pass-through on the session-gated /api/schedule/* routes.
 *
 * Red first: GET /api/schedule/operations does not exist yet, and POST
 * /api/schedule/goals must forward timeZone to addGoal (the resource
 * goals require explicit "UTC"; absent timeZone falls back to
 * America/New_York firing in scheduled-agent.ts).
 *
 * Gate preserved from #1156: unauthenticated → 401, any signed-in
 * user may use the dashboard, no admin gate invented.
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

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-31200000000b";

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } = makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, { githubLogin: "octocat-goalsui" });
  const added: Record<string, unknown>[] = [];
  const agent = {
    listGoals: async () => [],
    getTickHistory: async () => [],
    addGoal: async (goal: Record<string, unknown>) => {
      // Mirror the real addGoal validation for timeZone only.
      if (goal.timeZone !== undefined && goal.timeZone !== "") {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: goal.timeZone as string });
        } catch {
          throw new Error(`Invalid timeZone: ${goal.timeZone}`);
        }
      }
      added.push(goal);
      return goal;
    },
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
    added,
  };
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

describe("schedule goals UI endpoints (#1922)", () => {
  it("unauthenticated GET /api/schedule/operations → 401", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("GET", "/api/schedule/operations"), env);
    expect(res.status).toBe(401);
  });

  it("authenticated GET /api/schedule/operations lists the server catalog, incl. resource.*", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(req("GET", "/api/schedule/operations", undefined, SESSION_ID), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      operations: { operation: string; agent: string; blurb: string }[];
    };
    expect(body.ok).toBe(true);
    const ops = body.operations.map((o) => o.operation);
    expect(ops).toContain("resource.rollup_daily");
    expect(ops).toContain("resource.cap_alert");
    expect(ops).toContain("resource.dashboard_comparison");
    const resource = body.operations.find((o) => o.operation === "resource.rollup_daily");
    expect(resource?.agent).toBe("resource");
    // No duplicates: one entry per catalog operation.
    expect(new Set(ops).size).toBe(ops.length);
  });

  it("authenticated POST /api/schedule/goals forwards timeZone to addGoal", async () => {
    const { env, added } = makeEnv();
    const res = await worker.fetch(
      req(
        "POST",
        "/api/schedule/goals",
        { id: "g-tz", name: "TZ Goal", cron: "30 1 * * *", operation: "resource.rollup_daily", budgetCents: 1, timeZone: "UTC" },
        SESSION_ID,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(added).toHaveLength(1);
    expect(added[0].timeZone).toBe("UTC");
  });

  it("authenticated POST /api/schedule/goals with an invalid timeZone → 400", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      req(
        "POST",
        "/api/schedule/goals",
        { id: "g-bad", name: "Bad TZ", cron: "30 1 * * *", operation: "resource.rollup_daily", budgetCents: 1, timeZone: "Not/AZone" },
        SESSION_ID,
      ),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid timeZone/);
  });
});
