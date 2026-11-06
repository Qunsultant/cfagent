/**
 * Issue #1495 (#940-A): user-scoped screener preset storage + CRUD API.
 * Foundation for #940: presets persist per user in DO/SQLite
 * (mas_screener_presets — NOT KV, per #415), validated by the SAME
 * strict parsers the run path uses (parseStockScreenerFilter /
 * parseOptionScreenerFilter), so a stored preset can never hold criteria
 * a run would reject, and unknown fields are rejected, never silently
 * dropped.
 *
 * Scoping: presets are keyed by the caller's login (x-user-login header,
 * else the session id — the same identity runs use). A user lists only
 * their own rows; reading/deleting another user's id returns 404, the
 * same as missing — no existence oracle.
 *
 * Pins:
 *  - empty list, create + list round-trip, delete round-trip
 *  - validation: empty name, bad asset class, unknown criteria field,
 *    non-object criteria — all 400 with business messages
 *  - scoping: user B lists nothing of user A's, and deleting user A's
 *    id as user B 404s without touching the row
 *  - stored criteria are the parser-normalized value (round-trip)
 *
 * Harness follows tests/report_dispatch_hitl.test.ts: full
 * OrchestratorAgent.onRequest against MockSqlStorage, paths given
 * stripped (server.ts strips /api before the DO in production).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
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
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const makeEnv = (overrides: Record<string, unknown> = {}): Env =>
  ({
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    APP_ENV: "TEST",
    ...overrides,
  }) as Env;

const seedAgent = (env: Env) => {
  const sql = new MockSqlStorage();
  const ctx = {
    id: { toString: () => "system_presets_test" },
    storage: { sql },
    waitUntil: vi.fn(),
  };
  const agent = new OrchestratorAgent(ctx as any, env);
  return { agent, sql };
};

const req = (
  agent: OrchestratorAgent,
  method: string,
  path: string,
  userLogin: string,
  body?: unknown
) =>
  agent.onRequest(
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-user-login": userLogin,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

const listPresets = async (agent: OrchestratorAgent, userLogin: string) => {
  const res = await req(agent, "GET", "/screener/presets", userLogin);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
};

describe("Issue #1495 — screener presets", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("an empty list returns no presets", async () => {
    const { agent } = seedAgent(makeEnv());
    expect(await listPresets(agent, "alice")).toEqual({ presets: [] });
  });

  it("create + list round-trips a stocks preset with normalized criteria", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "RSI bounce",
      assetClass: "stocks",
      criteria: { minRsi: 30, maxRsi: 70, minVolume: 100000 },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as any;
    expect(created.preset.name).toBe("RSI bounce");
    expect(created.preset.assetClass).toBe("stocks");
    expect(created.preset.criteria).toEqual({ minRsi: 30, maxRsi: 70, minVolume: 100000 });
    expect(typeof created.preset.id).toBe("string");
    const listed = await listPresets(agent, "alice");
    expect(listed.presets).toHaveLength(1);
    expect(listed.presets[0].id).toBe(created.preset.id);
  });

  it("create + list round-trips an options preset", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "Near-dated calls",
      assetClass: "options",
      criteria: { contractType: "CALL", minDte: 7, maxDte: 45 },
    });
    expect(res.status).toBe(201);
    const listed = await listPresets(agent, "alice");
    expect(listed.presets[0].criteria).toEqual({ contractType: "CALL", minDte: 7, maxDte: 45 });
  });

  it("rejects an empty name with 400", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "   ",
      assetClass: "stocks",
      criteria: {},
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/name/i);
  });

  it("rejects an unknown asset class with 400", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "X",
      assetClass: "crypto",
      criteria: {},
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/stocks|options/i);
  });

  it("rejects an unknown criteria field with 400 (never silently dropped)", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "X",
      assetClass: "stocks",
      criteria: { minRsi: 30, bogusField: 1 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/bogusField/);
    expect(await listPresets(agent, "alice")).toEqual({ presets: [] });
  });

  it("rejects non-object criteria with 400", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await req(agent, "POST", "/screener/presets", "alice", {
      name: "X",
      assetClass: "stocks",
      criteria: "minRsi: 30",
    });
    expect(res.status).toBe(400);
  });

  it("presets are user-scoped: B lists none of A's, and deleting A's id as B 404s", async () => {
    const { agent } = seedAgent(makeEnv());
    const created = (await (
      await req(agent, "POST", "/screener/presets", "alice", {
        name: "A only",
        assetClass: "stocks",
        criteria: {},
      })
    ).json()) as any;
    expect(await listPresets(agent, "bob")).toEqual({ presets: [] });
    const del = await req(agent, "DELETE", `/screener/presets/${created.preset.id}`, "bob");
    expect(del.status).toBe(404);
    expect((await listPresets(agent, "alice")).presets).toHaveLength(1);
  });

  it("delete removes an own preset; deleting a missing id 404s", async () => {
    const { agent } = seedAgent(makeEnv());
    const created = (await (
      await req(agent, "POST", "/screener/presets", "alice", {
        name: "Doomed",
        assetClass: "stocks",
        criteria: {},
      })
    ).json()) as any;
    const del = await req(agent, "DELETE", `/screener/presets/${created.preset.id}`, "alice");
    expect(del.status).toBe(200);
    expect(await listPresets(agent, "alice")).toEqual({ presets: [] });
    const missing = await req(agent, "DELETE", "/screener/presets/nope", "alice");
    expect(missing.status).toBe(404);
  });
});
