/**
 * Issue #5109 (follow-up to the #6297 model-id fix) — the agent tools
 * run the pipeline on the TENANT research:<login> instance, never on
 * the run-scoped facet that hosts the turn.
 *
 * Root cause: the SDK's runAgentTool addresses the child by runId, so
 * the turn runs on a throwaway facet whose storage the orchestrator's
 * getLatest() (on research:<login>) can never see — the run failed
 * with `research_agent_turn_incomplete: Research agent finished with
 * status completed` even though the turn completed. The tool executes
 * therefore delegate through the actor gateway to the tenant instance,
 * the one owner of config, history, track record and account bindings.
 *
 * Node-safe idiom (see tests/research-agent-think-turn.test.ts): mock
 * the Think-coupled adapter module only; everything else is real.
 * The actor gateway is mocked so no DO namespace is needed.
 */
import { describe, it, expect, vi } from "vitest";

const { fakeTenant, stubFn } = vi.hoisted(() => {
  const fakeTenant = {
    runResearch: vi.fn(async () => ({
      success: true,
      report: { runId: "research:test-1", ideas: [], summary: "ok" },
    })),
    runDiscovery: vi.fn(async () => ({
      success: true,
      proposals: [],
      persisted: 0,
      limitations: [],
    })),
  };
  const stubFn = vi.fn(() => fakeTenant);
  return { fakeTenant, stubFn };
});

vi.mock("../src/services/cloudflareActorGateway", () => ({
  actorGateway: { stub: stubFn },
  createActorGateway: () => ({ stub: stubFn }),
}));

vi.mock("../src/actors/thinkAdapter", () => ({
  PortThink: class MockPortThink {
    ctx: any;
    env: any;
    portHooks: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async schedule(_when: unknown, _callback: string, _payload?: unknown) {
      return { id: "mock-schedule" };
    }
    async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
      return { id: "mock-schedule" };
    }
  },
}));

import { ResearchAgent } from "../src/agents/research-agent";

const FAKE_NS = { __fakeResearchAgentNamespace: true };

function makeAgent(env: any = { RESEARCH_AGENT: FAKE_NS }): ResearchAgent {
  const ctx: any = {
    storage: {
      get: async () => null,
      put: async () => {},
      sql: { exec: () => [] as unknown[] },
    },
  };
  return new ResearchAgent(ctx, env);
}

describe("ResearchAgent tools run on the tenant instance (#5109)", () => {
  it("run_options_research delegates to research:<login>, not the local facet", async () => {
    const agent = makeAgent();
    const localRun = vi.spyOn(agent as any, "runResearch");
    const tools = agent.getTools() as any;
    const out = await tools.run_options_research.execute({
      trigger: "manual",
      userLogin: "OpenAIMP",
      brokerId: "alpaca",
      mode: "paper",
    });
    expect(stubFn).toHaveBeenCalledWith(FAKE_NS, "research:OpenAIMP");
    expect(fakeTenant.runResearch).toHaveBeenCalledWith({
      trigger: "manual",
      userLogin: "OpenAIMP",
      brokerId: "alpaca",
      mode: "paper",
    });
    expect(localRun).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({
      success: true,
      runId: "research:test-1",
    });
  });

  it("run_goal_discovery delegates to research:<login>, not the local facet", async () => {
    const agent = makeAgent();
    const localDiscovery = vi.spyOn(agent as any, "runDiscovery");
    const tools = agent.getTools() as any;
    const out = await tools.run_goal_discovery.execute({
      trigger: "manual",
      userLogin: "OpenAIMP",
    });
    expect(stubFn).toHaveBeenCalledWith(FAKE_NS, "research:OpenAIMP");
    expect(fakeTenant.runDiscovery).toHaveBeenCalledWith({
      trigger: "manual",
      userLogin: "OpenAIMP",
      symbols: undefined,
      ivRank: null,
    });
    expect(localDiscovery).not.toHaveBeenCalled();
    expect(JSON.parse(out)).toMatchObject({ success: true, persisted: 0 });
  });

  it("a tool call without an identity never reaches the gateway", async () => {
    const agent = makeAgent();
    stubFn.mockClear();
    fakeTenant.runResearch.mockClear();
    const tools = agent.getTools() as any;
    const out = await tools.run_options_research.execute({
      trigger: "manual",
    });
    expect(stubFn).not.toHaveBeenCalled();
    expect(fakeTenant.runResearch).not.toHaveBeenCalled();
    expect(JSON.parse(out).success).toBe(false);
  });

  it("a missing RESEARCH_AGENT binding fails closed with a named error", async () => {
    const agent = makeAgent({});
    const tools = agent.getTools() as any;
    const out = await tools.run_options_research.execute({
      trigger: "manual",
      userLogin: "OpenAIMP",
    });
    expect(JSON.parse(out)).toMatchObject({
      success: false,
      error: "ResearchAgent binding not configured.",
    });
  });
});
