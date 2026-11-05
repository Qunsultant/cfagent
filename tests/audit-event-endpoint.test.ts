import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (the same pattern as
// tests/schedules_create_route.test.ts); the route only needs ctx.storage,
// ctx.id and env, all stubbed per-test.
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

// Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
// Agents SDK actors now — mock the SDK with a plain base class
// (the api_chat_route.test.ts idiom) so the real module graph's
// `cloudflare:` imports never reach the node loader.
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
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

/**
 * Issue #270 — the WorkflowsHub Observability card advertises
 * "GET /api/audit · POST /api/audit/event". GET /api/audit and
 * POST /api/audit existed; POST /api/audit/event 404'd (the advertised
 * endpoint had no implementation). The endpoint is implemented for real
 * on mas_events: strict body validation, tenant-scoped insert, and the
 * stored record echoed back (201) in the same shape GET returns.
 */
describe("POST /api/audit/event (#270)", () => {
  const SESSION_KEY = "audit-event-route-test";

  function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => SESSION_KEY },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    agent.env = { APP_ENV: "TEST" } as any;
    return { agent, sql };
  }

  function rowCount(sql: MockSqlStorage): number {
    return Array.from(
      sql.exec("SELECT id FROM mas_events WHERE session_id = ?", SESSION_KEY)
    ).length;
  }

  async function postEvent(agent: any, rawBody: string) {
    const res = await agent.onRequest(
      new Request("https://agent.test/api/audit/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  it("records a valid event and returns the stored record (201)", async () => {
    const { agent, sql } = makeAgent();
    const { status, body } = await postEvent(
      agent,
      JSON.stringify({ type: "ui.policy_check", agent: "nlq", payload: { detail: "ok" } })
    );
    expect(status).toBe(201);
    expect(typeof body.id).toBe("string");
    expect(body.type).toBe("ui.policy_check");
    expect(body.agent).toBe("nlq");
    expect(body.payload).toEqual({ detail: "ok" });
    expect(typeof body.created_at).toBe("string");
    // The write is tenant-scoped and the row is really there.
    expect(rowCount(sql)).toBe(1);
    const rows = Array.from(
      sql.exec("SELECT type, agent, session_id FROM mas_events")
    ) as Array<Record<string, string>>;
    expect(rows[0].type).toBe("ui.policy_check");
    expect(rows[0].session_id).toBe(SESSION_KEY);
  });

  it("round-trips: GET /api/audit returns the posted event", async () => {
    const { agent } = makeAgent();
    await postEvent(agent, JSON.stringify({ type: "ui.roundtrip", payload: { n: 7 } }));
    const res = await agent.onRequest(new Request("https://agent.test/api/audit?limit=10"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.events)).toBe(true);
    const found = body.events.find((e: any) => e.type === "ui.roundtrip");
    expect(found).toBeDefined();
    expect(found.payload).toEqual({ n: 7 });
  });

  it("rejects a missing type with 400 and writes nothing", async () => {
    const { agent, sql } = makeAgent();
    const { status, body } = await postEvent(agent, JSON.stringify({ agent: "nlq" }));
    expect(status).toBe(400);
    expect(body.error).toContain("type");
    expect(rowCount(sql)).toBe(0);
  });

  it("rejects a non-object body with 400", async () => {
    const { agent, sql } = makeAgent();
    const { status, body } = await postEvent(agent, "not-json{");
    expect(status).toBe(400);
    expect(rowCount(sql)).toBe(0);
  });

  it("rejects an over-long type with 400", async () => {
    const { agent, sql } = makeAgent();
    const { status } = await postEvent(agent, JSON.stringify({ type: "x".repeat(121) }));
    expect(status).toBe(400);
    expect(rowCount(sql)).toBe(0);
  });

  it("rejects an over-sized payload with 400", async () => {
    const { agent, sql } = makeAgent();
    const { status, body } = await postEvent(
      agent,
      JSON.stringify({ type: "ui.big", payload: { blob: "x".repeat(70000) } })
    );
    expect(status).toBe(400);
    expect(body.error).toContain("64 KB");
    expect(rowCount(sql)).toBe(0);
  });

  it("defaults the agent label when omitted", async () => {
    const { agent } = makeAgent();
    const { status, body } = await postEvent(agent, JSON.stringify({ type: "ui.noagent" }));
    expect(status).toBe(201);
    expect(body.agent).toBe("orchestrator");
  });

  it("pins the advertised contract: UI claim and server route match", () => {
    const hub = readFileSync("src/client/WorkflowsHub.tsx", "utf8");
    const advertised = [...hub.matchAll(/apiEndpoint:\s*"([^"]+)"/g)]
      .map((m) => m[1])
      .find((s) => s.includes("/api/audit"));
    expect(advertised).toBe("GET /api/audit · POST /api/audit/event");
    // Issue #359-04: the audit routes now live in src/agents/routes/audit.ts;
    // orchestrator.ts delegates to handleAuditRoutes at the same position.
    const moduleSrc = readFileSync("src/agents/routes/audit.ts", "utf8");
    expect(moduleSrc).toContain('path.endsWith("/audit/event") && request.method === "POST"');
    // #2942: the delegation moved with routeRequest into orchestrator/routeRequest.ts.
    const orch = readFileSync("src/agents/orchestrator/routeRequest.ts", "utf8");
    expect(orch).toContain("handleAuditRoutes(request, url, path, sessionId,");
  });
});
