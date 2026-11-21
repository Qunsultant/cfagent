/**
 * Issue #4782 S3 — the pipeline-policy settings route
 * (GET/POST /api/trading/settings/pipeline-policy).
 *
 * The `pipeline.*` globals are per-tenant settings in mas_settings
 * (the same store the resolver reads through `readSettingRaw`), so
 * an operator's tuning takes effect on pipeline runs without a
 * deploy. The route is the UX's write path; the panel reads it.
 *
 * Contract (S2 pattern): writes are validated by name — an unknown
 * key or an out-of-range value is refused with 400 naming the key,
 * never clamped, and a batch with one bad entry writes nothing.
 * Harness copied from tests/report_dispatch_hitl.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

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
  return {
    routeAgentRequest: async () => null,
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
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const src = (rel: string) => readFileSync(`src/${rel}`, "utf8");

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
    id: { toString: () => "system_pipeline_policy_4782" },
    storage: { sql },
    waitUntil: vi.fn(),
  };
  const agent = new OrchestratorAgent(ctx as any, env);
  return { agent, sql };
};

const post = (agent: OrchestratorAgent, path: string, body: unknown) =>
  agent.onRequest(
    new Request(`https://agent.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

const get = (agent: OrchestratorAgent, path: string) =>
  agent.onRequest(new Request(`https://agent.internal${path}`, { method: "GET" }));

const ROUTE = "/trading/settings/pipeline-policy";

const getPolicy = async (agent: OrchestratorAgent) => {
  const res = await get(agent, ROUTE);
  expect(res.status).toBe(200);
  return (await res.json()) as any;
};

describe("Issue #4782 S3 — pipeline-policy settings route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GET defaults: nothing stored, defaults carry the resolver's values", async () => {
    const { agent } = seedAgent(makeEnv());
    const json = await getPolicy(agent);
    expect(json.settings).toEqual({});
    expect(json.defaults["pipeline.retry.report.attempts"]).toBe("2");
    expect(json.defaults["pipeline.retry.acquisition.attempts"]).toBe("3");
    expect(json.defaults["pipeline.retry.report.jitterRatio"]).toBe("0.25");
    expect(json.defaults["pipeline.notifications.enabled"]).toBe("1");
    expect(json.defaults["pipeline.notify.events"]).toContain("started");
    expect(json.defaults["pipeline.fetchTimeoutMs"]).toBe("15000");
    // The shared keys carry no default of their own — they only
    // override per-bucket values when set, so they are absent here.
    expect(json.defaults["pipeline.retry.attempts"]).toBeUndefined();
    expect(json.defaults["pipeline.retry.jitterRatio"]).toBeUndefined();
  });

  it("POST stores one key and GET reflects it", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, {
      settings: { "pipeline.retry.report.attempts": "1" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).settings["pipeline.retry.report.attempts"]).toBe("1");
    const json = await getPolicy(agent);
    expect(json.settings["pipeline.retry.report.attempts"]).toBe("1");
  });

  it("POST round-trips several keys at once, including a jitterRatio", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, {
      settings: {
        "pipeline.retry.report.jitterRatio": "0.5",
        "pipeline.notify.slack": "0",
        "pipeline.retry.jitterRatio": "0.1",
      },
    });
    expect(res.status).toBe(200);
    const json = await getPolicy(agent);
    expect(json.settings).toMatchObject({
      "pipeline.retry.report.jitterRatio": "0.5",
      "pipeline.notify.slack": "0",
      "pipeline.retry.jitterRatio": "0.1",
    });
  });

  it("POST refuses an unknown key with 400 naming the key, and writes nothing", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, {
      settings: {
        "pipeline.retry.report.attempts": "1",
        "pipeline.retry.nope": "1",
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({ error: expect.stringContaining("pipeline.retry.nope") });
    const json = await getPolicy(agent);
    expect(json.settings).toEqual({});
  });

  it("POST refuses out-of-range attempts with 400 naming the key", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, { settings: { "pipeline.retry.report.attempts": "11" } });
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("pipeline.retry.report.attempts"),
    });
    expect((await getPolicy(agent)).settings).toEqual({});
  });

  it("POST refuses a non-numeric jitterRatio with 400 naming the key", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, { settings: { "pipeline.retry.report.jitterRatio": "abc" } });
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("pipeline.retry.report.jitterRatio"),
    });
  });

  it("POST refuses an out-of-range jitterRatio (never clamped on write)", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, { settings: { "pipeline.retry.report.jitterRatio": "1.5" } });
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("pipeline.retry.report.jitterRatio"),
    });
    expect((await getPolicy(agent)).settings).toEqual({});
  });

  it("POST refuses an unknown notify event with 400 naming the key", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, { settings: { "pipeline.notify.events": "started,bogus" } });
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      error: expect.stringContaining("pipeline.notify.events"),
    });
  });

  it("POST rejects a non-object settings body with 400", async () => {
    const { agent } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, { settings: "pipeline.retry.report.attempts=1" });
    expect(res.status).toBe(400);
  });

  it("POST writes an audit row naming the changed keys", async () => {
    const { agent, sql } = seedAgent(makeEnv());
    const res = await post(agent, ROUTE, {
      settings: { "pipeline.retry.report.attempts": "1" },
    });
    expect(res.status).toBe(200);
    const audits = Array.from(
      sql.exec("SELECT * FROM mas_events WHERE type = ?", "pipeline_policy.changed")
    ) as any[];
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].payload).settings).toEqual({
      "pipeline.retry.report.attempts": "1",
    });
  });
});

describe("Issue #4782 S3 — pipeline-policy route source pins", () => {
  it("the route lives in the reports module, wired through routeRequest", () => {
    expect(src("agents/routes/reports.ts")).toContain("/trading/settings/pipeline-policy");
    expect(src("agents/routes/reports.ts")).toContain("getPipelinePolicySettings");
    expect(src("agents/routes/reports.ts")).toContain("setPipelinePolicySettings");
    expect(src("agents/orchestrator/routeRequest.ts")).toContain("getPipelinePolicySettings");
    expect(src("agents/orchestrator/routeRequest.ts")).toContain("setPipelinePolicySettings");
  });

  it("the settings live in mas_settings through the settings port, never localStorage", () => {
    expect(src("agents/orchestrator/pipelinePolicySettings.ts")).toContain("readSettingRaw");
    expect(src("agents/orchestrator/pipelinePolicySettings.ts")).toContain("PIPELINE_POLICY_SETTING_KEYS");
    // The URL lives in the API module (the panel's only read/write
    // path); the panel imports that module, never the URL itself.
    expect(src("client/pipelinePolicyApi.ts")).toContain("/api/trading/settings/pipeline-policy");
    const panel = src("client/PipelinePolicyPanel.tsx");
    expect(panel).toContain("pipelinePolicyApi");
    // No localStorage use (the doc comment names it only to say
    // the panel never touches it — check the call forms).
    for (const file of [panel, src("client/pipelinePolicyApi.ts")]) {
      expect(file).not.toContain("localStorage.getItem");
      expect(file).not.toContain("localStorage.setItem");
      expect(file).not.toContain("localStorage.removeItem");
    }
    expect(src("client/BrokerDynamicMenu.tsx")).toContain("PipelinePolicyPanel");
  });
});
