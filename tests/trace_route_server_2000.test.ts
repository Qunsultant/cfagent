/**
 * Phase 5 Slice 3 (issue #2000) — server wiring for the trace
 * surfacing route. Proves the /api/traces block in server.ts
 * actually dispatches (a fallthrough would answer differently):
 * unauthenticated → 401, authenticated + AGENT_DB unbound →
 * 503, authenticated + malformed traceId → 400. The 200 path
 * (AGENT_DB bound) is covered by the pure handler + reader
 * tests in trace_route_2000.test.ts.
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

const SESSION_ID = "0d9a3120-1c2b-4e3f-8a5b-312000000003";
const TRACE_ID = "a".repeat(32);

function makeEnv() {
  const { namespace: sessionStoreNs, seed: seedSession } =
    makeFakeSessionStore();
  seedSession("sessions", SESSION_ID, {
    githubLogin: "octocat-trace",
    githubName: "Octocat",
  });
  return { SESSION_STORE: sessionStoreNs } as unknown as Env;
}

const req = (traceId: string | null, cookie?: string) =>
  new Request(
    `https://agent.test/api/traces${traceId === null ? "" : `?traceId=${traceId}`}`,
    { headers: cookie ? { Cookie: `session_id=${cookie}` } : {} },
  );

describe("GET /api/traces server wiring (slice 3)", () => {
  it("unauthenticated → 401", async () => {
    const res = await worker.fetch(req(TRACE_ID), makeEnv());
    expect(res.status).toBe(401);
  });

  it("authenticated + AGENT_DB unbound → 503", async () => {
    const res = await worker.fetch(req(TRACE_ID, SESSION_ID), makeEnv());
    expect(res.status).toBe(503);
  });

  it("authenticated + malformed traceId → 400", async () => {
    const res = await worker.fetch(req("not-a-trace-id", SESSION_ID), makeEnv());
    expect(res.status).toBe(400);
  });

  it("authenticated + missing traceId → 400", async () => {
    const res = await worker.fetch(req(null, SESSION_ID), makeEnv());
    expect(res.status).toBe(400);
  });
});
