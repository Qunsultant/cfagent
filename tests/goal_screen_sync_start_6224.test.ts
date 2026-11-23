/**
 * Issue #6224 — manual goal-screen start dies stillborn in the
 * async-job replay: serve the workflow start synchronously.
 *
 * The DO entry (OrchestratorAgent.onRequest) queues POST
 * /screening/goal-screen as an `http.request` async job because
 * "screening" is not an immediate prefix, and the executor dies
 * stillborn before the replay ever starts the workflow. The route
 * handler itself already completes `binding.create` and returns
 * the 202 workflow acceptance — the fix is the entry decision:
 * the manual goal-screen POST must reach routeRequest directly,
 * like the #2457/#2489/#2501/#2681 early branches.
 *
 * These tests pin the entry decision through onRequest with a
 * stubbed routeRequest (the handler's own acceptance is pinned
 * in goal_screen_workflow_routes_1996.test.ts): the goal-screen
 * POST answers the workflow acceptance with no async job minted,
 * while a non-workflow-start POST under a non-immediate prefix
 * still queues and reads still never queue.
 * TDD: written before the implementation.
 */
import { describe, it, expect, vi } from "vitest";

// The orchestrator's routes graph reaches BrowserAgent/SlackAgent,
// which extend AIChatAgent from @cloudflare/ai-chat — whose real
// module graph pulls in `cloudflare:` protocol imports the node test
// loader cannot resolve. Mock it with a plain base class (same
// pattern as tests/api_chat_route.test.ts). The orchestrator
// itself extends Agent since #1738; the agents SDK graph pulls the
// same `cloudflare:` imports, so it gets the same plain-base mock.
vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      messages: any[];
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.messages = [];
      }
    },
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

const SESSION_KEY = "goal-screen-sync-start-6224";

const CANNED_ACCEPTANCE = {
  jobId: "goal-screen:manual:alice:income:2026-11-23T09:00:00.000Z",
  workflowId: "wf-test-goal-screen-manual",
  status: "queued",
  statusUrl: "/api/jobs/history?chainId=goal-screen%3Amanual%3Aalice%3Aincome",
};

function makeAgent() {
  const sql = new MockSqlStorage();
  const kv = new Map<string, unknown>();
  const ctx = {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
    id: { toString: () => SESSION_KEY },
  } as any;
  const agent: any = Object.create(OrchestratorAgent.prototype);
  agent.ctx = ctx;
  agent.env = { APP_ENV: "TEST" } as any;
  const routeRequestCalls: Request[] = [];
  agent.routeRequest = async (request: Request) => {
    routeRequestCalls.push(request);
    return Response.json(CANNED_ACCEPTANCE, { status: 202 });
  };
  const submitAsyncJobCalls: unknown[] = [];
  agent.submitAsyncJob = async (job: unknown) => {
    submitAsyncJobCalls.push(job);
    return {
      jobId: "job:test-queued",
      status: "queued" as const,
      statusUrl: "/api/jobs/job:test-queued",
    };
  };
  return { agent, sql, routeRequestCalls, submitAsyncJobCalls };
}

function postGoalScreen(agent: any, extraHeaders: Record<string, string> = {}) {
  // In production the Worker strips /api before forwarding, so the
  // DO sees /screening/goal-screen; the forwarder marks the
  // non-immediate path x-async-eligible (src/server/routes/core.ts),
  // which is what makes the DO queue it today.
  return agent.onRequest(
    new Request("https://agent.test/screening/goal-screen", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-user-login": "alice",
        "x-async-eligible": "1",
        ...extraHeaders,
      },
      body: JSON.stringify({ goalKind: "income", async: true }),
    }),
  );
}

describe("manual goal-screen start served synchronously (#6224)", () => {
  it("POST /screening/goal-screen answers the workflow acceptance with no async job minted", async () => {
    const { agent, routeRequestCalls, submitAsyncJobCalls } = makeAgent();
    const res = await postGoalScreen(agent);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workflowId).toBe(CANNED_ACCEPTANCE.workflowId);
    expect(body.jobId).toBe(CANNED_ACCEPTANCE.jobId);
    expect(body.statusUrl).toBe(CANNED_ACCEPTANCE.statusUrl);
    expect(routeRequestCalls).toHaveLength(1);
    expect(routeRequestCalls[0].url).toContain("/screening/goal-screen");
    expect(submitAsyncJobCalls).toHaveLength(0);
  });

  it("a non-workflow-start POST under a non-immediate prefix still queues", async () => {
    const { agent, routeRequestCalls, submitAsyncJobCalls } = makeAgent();
    const res = await agent.onRequest(
      new Request("https://agent.test/screening/backtest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-login": "alice",
          "x-async-eligible": "1",
        },
        body: JSON.stringify({ symbols: ["AAPL"] }),
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("queued");
    expect(body.statusUrl).toBe("/api/jobs/job:test-queued");
    expect(submitAsyncJobCalls).toHaveLength(1);
    expect((submitAsyncJobCalls[0] as { capability: string }).capability).toBe("http.request");
    expect(routeRequestCalls).toHaveLength(0);
  });

  it("reads on the goal-screen paths still never queue", async () => {
    const { agent, routeRequestCalls, submitAsyncJobCalls } = makeAgent();
    const res = await agent.onRequest(
      new Request("https://agent.test/screening/goal-screen/report.pdf?key=k1", {
        method: "GET",
        headers: { "x-user-login": "alice", "x-async-eligible": "1" },
      }),
    );
    expect(res.status).toBe(202);
    expect(routeRequestCalls).toHaveLength(1);
    expect(submitAsyncJobCalls).toHaveLength(0);
  });
});
