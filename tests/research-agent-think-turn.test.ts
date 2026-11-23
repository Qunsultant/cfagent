/**
 * Issue #1953 (think-fleet, tracker #1951) — ResearchAgent behind
 * PortThink.
 *
 * Node-safe idiom (see tests/think-port-mapping.test.ts): the real
 * thinkAdapter graph needs workerd schemes the node vitest harness
 * cannot load, so this suite mocks the thinkAdapter module with a
 * plain base class (the research-delivery.test.ts mock idiom) and
 * proves the class-level migration contract:
 *  - ResearchAgent extends PortThink (not Agent, not raw Think);
 *  - its port hooks (getModel/getSystemPrompt/getTools) are
 *    preserved byte-for-byte in behavior and exposed as the
 *    portHooks object PortThink translates;
 *  - the portHooks turn hooks are the identity defaults for a
 *    non-chat actor: beforeTurn overrides nothing, onChatResponse
 *    has no side effect, and onChatError is SYNCHRONOUS (the #1935
 *    spike fact: Think fires onChatError fire-and-forget, so only
 *    a sync hook can control the error text);
 *  - the same portHooks drive a turn through the port: the
 *    in-memory turn runner (same hook order as the Think adapter:
 *    beforeTurn -> reply -> append -> onChatResponse) and the
 *    think port factory with an injected turn (the node-safe stand-in
 *    for createThinkActorTurn, whose real Think runTurn runs under
 *    workerd — see the spike proof in #1935).
 *
 * Direct domain methods (runResearch/runDiscovery/...) are unchanged
 * by this migration and stay covered by their existing suites; they
 * are NOT turns and take no lifecycle boot (the adapter owns boot
 * for turns only — thinkAdapter.ts header).
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock the Think-coupled module only; everything else is real.
// The agents mock mirrors research-delivery.test.ts: the real SDK
// graph pulls `cloudflare:` imports the node loader cannot resolve.
// Post-migration research-agent.ts no longer imports "agents", so
// this mock only shields transitive imports.
vi.mock("agents", () => ({
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
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
import { createActorPorts } from "../src/actors/createActorPorts";
import { createInMemoryActorSession } from "../src/actors/inMemoryActorAdapter";
import { createInMemoryActorTurn } from "../src/actors/inMemoryActorAdapter";
import type { ActorTurnHooks } from "../src/actors/actorPorts";

const ROOT = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "src/agents/research-agent.ts"), "utf8");

function makeAgent(): ResearchAgent {
  const ctx: any = {
    storage: {
      get: async () => null,
      put: async () => {},
      sql: { exec: () => [] as unknown[] },
    },
  };
  return new ResearchAgent(ctx, {} as any);
}

function stubStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => {
      map.delete(key);
    },
    sql: { exec: () => [] as unknown[] },
  };
}

const stubScheduler: any = {
  schedule: async () => ({ id: "s1" }),
  scheduleEvery: async () => ({ id: "s2" }),
  listSchedules: async () => [],
  cancelSchedule: async () => true,
};

describe("ResearchAgent PortThink migration (#1953)", () => {
  it("extends PortThink from the foundation adapter, not Agent or raw Think", () => {
    expect(src).toMatch(/import\s*\{\s*PortThink\s*\}\s*from\s*"\.\.\/actors\/thinkAdapter"/);
    expect(src).toMatch(/export\s+class\s+ResearchAgent\s+extends\s+PortThink\b/);
    expect(src).not.toMatch(/import\s*\{\s*Agent\s*\}\s*from\s*"agents"/);
    expect(src).not.toContain('from "@cloudflare/think"');
  });

  it("keeps the port identity facet: model, system prompt, tools", () => {
    const agent = makeAgent();
    // Issue #5109: getModel() must resolve to a valid Workers AI id,
    // not the bare task key. The old assertion pinned "researchAgent"
    // itself — the literal key resolveAiModelName returns when the
    // task model is unregistered — which the model resolver rejects,
    // so the OODA button failed deterministically with
    // `research_agent_turn_incomplete: Invalid model id
    // "researchAgent"` and the nightly schedule never produced a run.
    expect(agent.getModel()).toBe("@cf/zai-org/glm-4.7-flash");
    expect(agent.getSystemPrompt()).toContain("read-only options research agent");
    expect(agent.getSystemPrompt()).toContain("must never place, preview, or submit trades");
    const tools = agent.getTools();
    expect(Object.keys(tools).sort()).toEqual(["run_goal_discovery", "run_options_research"]);
  });

  it("exposes those same hooks as its portHooks object", () => {
    const agent = makeAgent();
    const hooks = (agent as unknown as { portHooks: ActorTurnHooks }).portHooks;
    expect(hooks).toBeDefined();
    expect(hooks.getModel()).toBe(agent.getModel());
    expect(hooks.getSystemPrompt()).toBe(agent.getSystemPrompt());
    expect(Object.keys(hooks.getTools()).sort()).toEqual(
      Object.keys(agent.getTools()).sort()
    );
  });

  it("portHooks.beforeTurn overrides nothing (non-chat actor: no turn config)", async () => {
    const agent = makeAgent();
    const hooks = (agent as unknown as { portHooks: ActorTurnHooks }).portHooks;
    await expect(
      hooks.beforeTurn({
        system: hooks.getSystemPrompt(),
        messages: [],
        tools: hooks.getTools(),
        model: hooks.getModel(),
        continuation: false,
        body: { turnId: "t1", trigger: "user_message" },
      })
    ).resolves.toBeUndefined();
  });

  it("portHooks.onChatError is synchronous (Think never awaits it)", () => {
    const agent = makeAgent();
    const hooks = (agent as unknown as { portHooks: ActorTurnHooks }).portHooks;
    expect(hooks.onChatError).toBeDefined();
    const out = hooks.onChatError!(new Error("provider down"));
    expect(out).toBe("provider down");
    // A Promise here would fire once but could not control Think's
    // error text (spike fact #1935); the hook must be a plain string.
    expect(out).not.toBeInstanceOf(Promise);
    expect(typeof (out as unknown as { then?: unknown }).then).toBe("undefined");
  });

  it("portHooks drive a turn through the in-memory port runner", async () => {
    const agent = makeAgent();
    const hooks = (agent as unknown as { portHooks: ActorTurnHooks }).portHooks;
    const session = createInMemoryActorSession();
    const turn = createInMemoryActorTurn(hooks, session);
    const result = await turn.runTurn("run a research pass");
    expect(result.status).toBe("completed");
    expect(result.message?.role).toBe("assistant");
    const msgs = await session.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("portHooks plug into the think port factory with an injected turn", async () => {
    const agent = makeAgent();
    const hooks = (agent as unknown as { portHooks: ActorTurnHooks }).portHooks;
    const injected = { runTurn: async () => ({ status: "completed" as const }) };
    let injectedSession: unknown;
    const port = createActorPorts("think", {
      hooks,
      storage: stubStorage(),
      scheduler: stubScheduler,
      thinkTurn: (session) => {
        injectedSession = session;
        return injected as never;
      },
    });
    expect(port.state).toBeDefined();
    expect(port.schedule).toBeDefined();
    expect(port.session).toBeDefined();
    expect(port.turn).toBe(injected);
    expect(injectedSession).toBe(port.session);
    await expect(port.turn.runTurn("hello")).resolves.toMatchObject({ status: "completed" });
  });
});
