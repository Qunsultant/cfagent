import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The agents SDK module graph pulls `cloudflare:` imports the node
// loader cannot resolve — mock it with a plain base class, the
// api_chat_route.test.ts idiom. The harness's own methods
// (getModel / getTools / maxSteps) run for real.
vi.mock("agents", () => ({
  Agent: class MockAgent {
    ctx: any;
    env: any;
    maxSteps = 0;
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
}));

import { ActorOrchestratorHarness, resolveMasMaxSteps, stubMcpContext } from "./actor-orchestrator-harness";
import { legacyRowToSessionMessage } from "../src/actors/actorPorts";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import { chatNlqTurnGate } from "../src/agents/orchestrator/meshMcpClient";
import { handlerDispatch, makeDiscoveredPlatformTools } from "./mesh-mcp-testkit";
import { MockSqlStorage } from "./mock-sql";
import { createMAS } from "../src/agents/mas";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { getWorkersAIModel, resolveAiModelName } from "../src/agents/model";
import { REST_APIS_CATALOG } from "../src/client/mcpEndpointsData";

/**
 * Issue #1738 — actor parity harness (successor to the #658 Think
 * parity harness, same R1–R5 pins re-pointed at the Agents SDK).
 *
 * R1 mapping (chat contract, per assertion): the POST /api/chat
 * contract ({reply, route{...}, model, streaming:false}) is produced
 * by the route adapter above the agent class and is pinned
 * behaviorally by api_chat_contract / api_chat_route against the live
 * class; it does not change with the base class. This suite pins the
 * catalog surface (below) plus everything the base-class swap DOES
 * touch: R2 tool surface, R4 model arm, R5 step bound, R3 session
 * format. Full DO-runtime behavior is pinned by the actor-cutover
 * suite (turns through the real runner with a stubbed provider).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function makeHarness(env: Record<string, unknown> = {}) {
  return new ActorOrchestratorHarness({ storage: { sql: { exec: () => [] } } }, env as never);
}

describe("#658 R1 — the preserved contract surface", () => {
  it("the api_chat catalog contract is the surface the migration must preserve", () => {
    const apiChat = REST_APIS_CATALOG.find((e) => e.id === "api_chat")!;
    expect(Object.keys(apiChat.sampleResponse || {}).sort()).toEqual([
      "model",
      "reply",
      "route",
      "streaming",
    ]);
    expect(apiChat.sampleResponse!.streaming).toBe(false);
  });
});

describe("#658 R2 — tool surface parity (native set + runtime discovery)", () => {
  const env = { AI: {} };
  const liveNames = Object.keys(createAgentMcpTools(stubMcpContext(env as never))).sort();

  it("the harness getTools() returns exactly the manual loop's tool names", () => {
    const harnessNames = Object.keys(makeHarness(env).getTools()).sort();
    expect(harnessNames).toEqual(liveNames);
  });

  it("every canonical McpToolFactory command is present by name", async () => {
    const canonical = McpToolFactory.getAllTools().map((c) => c.name);
    expect(canonical.length).toBeGreaterThan(0);
    // #2496: catalog commands reach the turn by runtime DISCOVERY
    // from the openaimp server, under tool_openaimp_<name> keys;
    // the native set (liveNames) adapts none of them.
    const discovered = makeDiscoveredPlatformTools({
      dispatch: handlerDispatch(),
      resolveActingLogin: () => "parity",
      sql: new MockSqlStorage(),
    });
    const ensured = await discovered.ensure();
    expect(ensured.ready).toBe(true);
    const discoveredNames = Object.keys(discovered.aiTools());
    for (const name of canonical) {
      expect(discoveredNames).toContain(`tool_openaimp_${name}`);
      expect(liveNames).not.toContain(name);
    }
    // #2488 exception, by owner direction: execute_nlq stays
    // registered in the catalog and IS discovered, but the
    // CHAT_NLQ_MODE gate (built-in default off) excludes it from
    // the model's usable set — the ONE canonical command the
    // default turn cannot call.
    const gate = chatNlqTurnGate({
      toolNames: [...liveNames, ...discoveredNames],
      context: { env: {} as never },
      audit: () => {},
    });
    expect(gate.activeTools).toBeDefined();
    expect(gate.activeTools).not.toContain("tool_openaimp_execute_nlq");
    expect(gate.activeTools).toContain("tool_openaimp_run_stock_screen");
  });

  it("the documented aliases and adapter-added tools are present", () => {
    // The adapter-added native tools remain in the live set.
    for (const name of [
      "createTaskDraft",
      "rememberFact",
      "recallFacts",
      "compare_stock_valuations",
      "compareValuations",
      "compareStocks",
    ]) {
      expect(liveNames).toContain(name);
    }
    // The catalog camelCase aliases were retired in #2496 with
    // the hand-wired turn layer; the discovered keys are the
    // only catalog surface now.
    for (const name of [
      "searchKnowledge",
      "queryPlatformKnowledge",
      "getPlatformCapabilities",
      "draftPayment",
      "confirmDraft",
    ]) {
      expect(liveNames).not.toContain(name);
    }
  });

  it("the MAS six (spike correction, quantified): createMAS's surface vs the live set after #2496", () => {
    const mas = createMAS({
      env: {} as never,
      sessionId: "parity",
      requestId: "parity",
      sql: { exec: () => [] as unknown[] },
      audit: () => {},
    });
    const masNames = Object.keys(mas).sort();
    // createMAS's own surface is unchanged.
    expect(masNames).toEqual([
      "confirmDraft",
      "createTaskDraft",
      "draftPayment",
      "recallFacts",
      "rememberFact",
      "searchKnowledge",
    ]);
    // Three of the six are the turn's native helpers and remain
    // in the live set; the other three were the retired catalog
    // aliases — createMAS keeps its own surface, but those names
    // no longer reach the chat turn (#2496).
    for (const name of ["createTaskDraft", "rememberFact", "recallFacts"]) {
      expect(liveNames).toContain(name);
    }
    for (const name of ["confirmDraft", "draftPayment", "searchKnowledge"]) {
      expect(liveNames).not.toContain(name);
    }
  });
});

describe("#658 R4 — model arm (constructed)", () => {
  it("the harness model resolves to the same model id as today's construction", () => {
    const env = { AI: {} } as never;
    const harnessModel = makeHarness(env as unknown as Record<string, unknown>).getModel() as unknown as { modelId: string };
    const todayModel = getWorkersAIModel(env) as unknown as { modelId: string };
    expect(harnessModel.modelId).toBe(todayModel.modelId);
    expect(harnessModel.modelId).toBe(resolveAiModelName(env));
  });

  it("an env AI_MODEL override flows through identically", () => {
    const env = { AI: {}, AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as never;
    const harnessModel = makeHarness(env as unknown as Record<string, unknown>).getModel() as unknown as { modelId: string };
    expect(harnessModel.modelId).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});

describe("#658 R5 — step bound parity", () => {
  it("resolves today's clamp for representative env values", () => {
    expect(resolveMasMaxSteps({})).toBe(6);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "3" } as never)).toBe(3);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "99" } as never)).toBe(10);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "0" } as never)).toBe(1);
  });

  it("documents today's NaN edge instead of fixing it (step-3 note)", () => {
    // Number("abc") is NaN; today's expression propagates it into
    // stepCountIs(NaN). Recorded as-is — behavior changes are out of
    // step-2 scope.
    expect(Number.isNaN(resolveMasMaxSteps({ MAS_MAX_STEPS: "abc" } as never))).toBe(true);
  });

  it("the harness carries the resolved bound on the actor's maxSteps", () => {
    expect(makeHarness({}).maxSteps).toBe(6);
    expect(makeHarness({ MAS_MAX_STEPS: "3" }).maxSteps).toBe(3);
    expect(makeHarness({ MAS_MAX_STEPS: "99" }).maxSteps).toBe(10);
  });

  it("the actor port carries the bound (the SDK Agent class does not)", () => {
    // Think exposed maxSteps as a first-class class property; the
    // Agents SDK Agent does not, so #1738 carries the bound on the
    // actor port's TurnConfig and on the orchestrator's own field.
    const ports = read("src/actors/actorPorts.ts");
    expect(ports).toMatch(/maxSteps\?:?\s*number/);
    expect(ports).toContain("TurnConfig");
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("maxSteps: number;");
  });
});

describe("#658 R3 — session format: legacy rows transform mechanically", () => {
  const userRow = {
    id: "row-1",
    message: JSON.stringify({
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "Show me NVDA calls" }],
    }),
    created_at: "2026-10-01T12:00:00.000Z",
  };
  const assistantRow = {
    id: "row-2",
    message: JSON.stringify({
      id: "msg-2",
      role: "assistant",
      parts: [
        { type: "text", text: "Running the query." },
        {
          type: "tool-execute_nlq",
          toolCallId: "tc-1",
          state: "output-available",
          input: { query: "SELECT * FROM mas_trades" },
          output: { rows: 3 },
        },
      ],
      metadata: { agent: "search" },
    }),
    created_at: "2026-10-01T12:00:05.000Z",
  };

  it("maps the envelope (id, role, createdAt from the row)", () => {
    const out = legacyRowToSessionMessage(userRow);
    expect(out.id).toBe("msg-1");
    expect(out.role).toBe("user");
    expect(out.createdAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("carries parts through unchanged, including tool parts", () => {
    const out = legacyRowToSessionMessage(assistantRow);
    expect(out.parts).toEqual(JSON.parse(assistantRow.message).parts);
    expect(out.metadata).toEqual({ agent: "search" });
  });

  it("the actor session store migrates legacy rows (production code, not a fixture)", () => {
    // The #658-era pin asserted the ai-chat base's own migration;
    // under #1738 the migration is production code on the actor
    // session store, and the orchestrator's liftLegacyChatMessages
    // drives it (pinned behaviorally by orchestrator-actor-cutover
    // R6).
    const ports = read("src/actors/actorPorts.ts");
    expect(ports).toContain("legacyRowToSessionMessage");
    const store = read("src/actors/actorSessionStore.ts");
    expect(store).toContain("migrateLegacyRows");
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("liftLegacyChatMessages");
  });

  it("the SDK SessionMessage is documented as UIMessage-compatible", () => {
    const dist = fs.readdirSync(path.join(ROOT, "node_modules/agents/dist"));
    const dts = dist
      .filter((f) => f.endsWith(".d.ts"))
      .map((f) => read(`node_modules/agents/dist/${f}`))
      .join("\n");
    expect(dts).toContain("interface SessionMessage");
    expect(dts).toMatch(/UIMessage[\s\S]{0,120}structurally compatible|structurally compatible[\s\S]{0,120}UIMessage/);
  });
});
