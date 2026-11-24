import { describe, it, expect, vi, beforeEach } from "vitest";

// The orchestrator's routes graph reaches BrowserAgent/SlackAgent,
// which extend AIChatAgent from @cloudflare/ai-chat — whose real
// module graph pulls in `cloudflare:` protocol imports the node test
// loader cannot resolve. Mock it with a plain base class (same
// pattern as tests/audit-event-endpoint.test.ts). The orchestrator
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
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
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

/**
 * Issue #312 — POST /api/chat was advertised in WorkflowsHub.tsx and
 * restEndpointsData.ts ("Multi-Agent Conversation Stream", sample body
 * { messages: [{ role: "user", content: "..." }] }) but no route existed.
 *
 * The route is a thin adapter over the single-owner agentic chat turn
 * (runAgenticChatTurn) — the same judge-routed pipeline the WebSocket chat
 * runs. The HTTP response carries the completed turn as JSON (non-streaming);
 * streaming remains available over the agent WebSocket chat the UI uses.
 *
 * The agentic pipeline itself (judge + Workers AI) is stubbed here; these
 * tests pin the route contract: validation, delegation, shape, and error
 * mapping. They must not execute a second chat implementation.
 */
describe("POST /api/chat (#312) — orchestrator route", () => {
  const SESSION_KEY = "api-chat-route-test";

  const STUB_ROUTE = {
    agent: "search",
    confidence: 0.92,
    reason: "test route",
    needsConfirmation: false,
  };

  function makeAgent() {
    const sql = new MockSqlStorage();
    // Issue #1738: session state lives behind the actor session
    // store, which runs on the DO key-value API — the test ctx
    // carries a Map-backed implementation of it.
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
    const turnCalls: any[] = [];
    agent.runAgenticChatTurn = async (opts: any) => {
      turnCalls.push(opts);
      return {
        result: { text: Promise.resolve("stubbed agentic reply") },
        route: STUB_ROUTE,
      };
    };
    return { agent, sql, turnCalls };
  }

  function postChat(agent: any, body: unknown) {
    // In production the Worker strips /api before forwarding, so the DO sees
    // /chat; the handler also accepts the unstripped form.
    return agent.onRequest(
      new Request("https://agent.test/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "octocat" },
        body: JSON.stringify(body),
      })
    );
  }

  it("accepts the advertised sample payload from restEndpointsData.ts", async () => {
    const { agent, turnCalls } = makeAgent();
    const res = await postChat(agent, {
      messages: [{ role: "user", content: "Hello AI Assistant" }],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reply).toBe("stubbed agentic reply");
    expect(json.streaming).toBe(false);
    expect(json.route.agent).toBe("search");
    expect(typeof json.model).toBe("string");
    // The turn went through the single-owner pipeline, not a parallel one.
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].userText).toBe("Hello AI Assistant");
    expect(turnCalls[0].isAutoOptionsResearchRequest).toBe(false);
    expect(turnCalls[0].userLogin).toBe("octocat");
  });

  it("rejects missing/empty messages with 400", async () => {
    const { agent } = makeAgent();
    for (const bad of [{}, { messages: [] }, { messages: [{ role: "user", content: "   " }] }, { messages: [{ role: "assistant", content: "hi" }] }, null]) {
      const res = await postChat(agent, bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/messages/);
    }
  });

  it("does not duplicate a re-sent history tail", async () => {
    const { agent, turnCalls } = makeAgent();
    const body = { messages: [{ role: "user", content: "same question" }] };
    await postChat(agent, body);
    await postChat(agent, body);
    // Both posts run the pipeline; the session-level dedupe on a
    // re-send is the turn driver's contract since #686 (the adapter
    // no longer appends messages itself) and is pinned against the
    // real driver in tests/orchestrator-actor-cutover.test.ts.
    expect(turnCalls).toHaveLength(2);
  });

  it("maps pipeline errors to the degraded fallback JSON (same content the WS chat streams)", async () => {
    const { agent } = makeAgent();
    agent.runAgenticChatTurn = async () => {
      throw new Error("boom");
    };
    agent.buildChatErrorFallback = async () => "FALLBACK TEXT";
    const res = await postChat(agent, { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reply).toBe("FALLBACK TEXT");
    expect(json.fallback).toBe(true);
  });
});
