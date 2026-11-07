/**
 * Issue #3721 (Capability S4, epic #3488) — activate the EXISTING
 * mesh MCP client (#2496) for the Stock Copilot.
 *
 * The client itself is not built here: #2496 wired the Agents SDK
 * MCP client on OrchestratorAgent, and Think auto-merges the
 * discovered openaimp catalog (tool_openaimp_*) into every turn of
 * the class. What this suite pins is the ACTIVATION the slice adds:
 *
 *  1. Declaration — the stock registration declares mcpClient in
 *     the #3489 manifest vocabulary (copilotRegistry), the class
 *     manifest resolves mcpClient enabled, and the activation
 *     resolver (meshMcpClient) ties the two together: a turn is
 *     "mcp-client active" exactly when it is a stock-copilot turn
 *     (sourceTab carrier, the chatTurnHelpers idiom) AND the class
 *     manifest's mcpClient entry resolves enabled.
 *  2. A stock turn's usable set — the discovered catalog composed
 *     with the CHAT_NLQ_MODE gate the way portBeforeTurn composes
 *     it — carries the copilot's own commands
 *     (tool_openaimp_stock_copilot_*), and one of them executes
 *     end to end over the production loopback carrier into the
 *     real /mcp route, attributed to the turn's acting login.
 *  3. General/options turns gain nothing from the activation:
 *     the resolver is inactive for their sourceTabs and their
 *     prompt carries no stock steering (byte-identical builder
 *     output without the activation flag).
 *  4. Removing the declaration removes the activation: the
 *     manifest machinery's own externalized override
 *     (AGENT_CAPABILITIES_DISABLED=OrchestratorAgent:mcpClient)
 *     resolves the entry disabled-by-config and the activation —
 *     and with it the stock steering — is gone.
 *  5. Identity discipline is the client's existing one: a
 *     tools/call with no resolvable acting login is refused at
 *     the carrier with mesh_mcp_identity_required and never
 *     dispatched.
 *
 * Harness: the shared mesh testkit (tests/mesh-mcp-testkit.ts) —
 * a real SDK MCPClientManager wired through the production
 * loopback carrier and ensure step; the dispatch target is the
 * real /mcp route handler (the #2496 drive's idiom). Fakes sit
 * only at binding seams: the manager's DO storage (testkit) and
 * the door's SQL (the #3624/#3635 mock shape).
 */
import { describe, expect, it, vi } from "vitest";
import { makeDiscoveredPlatformTools } from "./mesh-mcp-testkit";
import {
  handleMcpChatNlqRoutes,
  type McpChatNlqRouteContext,
} from "../src/agents/routes/mcpChatNlq";
import {
  chatNlqTurnGate,
  resolveStockCopilotMcpActivation,
  STOCK_COPILOT_SOURCE_TAB,
  OPENAIMP_MCP_TOOL_PREFIX,
} from "../src/agents/orchestrator/meshMcpClient";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import { resolveAgentCapabilityManifest } from "../src/actors/capabilityManifest";
import { findCopilot } from "../src/client/chat/copilotRegistry";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import type { Env } from "../src/types";

const LOGIN = "alice";

const STOCK_COPILOT_COMMANDS = [
  "stock_copilot_status",
  "stock_copilot_control",
  "stock_copilot_introspect",
  "stock_copilot_learnings",
  "stock_copilot_evaluate",
] as const;

const STOCK_KEYS = STOCK_COPILOT_COMMANDS.map(
  (name) => `${OPENAIMP_MCP_TOOL_PREFIX}${name}`,
);

/* ------------------------------------------------------------------ */
/* Drive: testkit discovery over the real /mcp route                   */
/* ------------------------------------------------------------------ */

function mockDoorSql() {
  return {
    exec: vi.fn((query: string) => {
      const q = query.trim().toUpperCase();
      if (q.startsWith("SELECT") && q.includes("COPILOT_POSITIONS")) return [];
      if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_ACTIVITY")) return [];
      if (q.startsWith("SELECT") && q.includes("STOCK_COPILOT_CONTROL")) return [];
      return [];
    }),
  };
}

interface ActivationDrive {
  ensure: () => Promise<{ ready: boolean; toolCount: number; reused: boolean }>;
  aiTools: () => Record<string, unknown>;
  turn: { login?: string };
  audits: Array<{ type: string; agent: unknown; payload: Record<string, unknown> }>;
  dispatchedMethods: string[];
  submittedJobs: unknown[];
}

function makeActivationDrive(): ActivationDrive {
  const turn: ActivationDrive["turn"] = {};
  const audits: ActivationDrive["audits"] = [];
  const dispatchedMethods: string[] = [];
  const submittedJobs: unknown[] = [];
  const doorSql = mockDoorSql();

  const routeCtx: McpChatNlqRouteContext = {
    getOrm: () => ({}) as never,
    getStorageSql: () => doorSql as never,
    getStorage: () => ({ sql: doorSql }) as never,
    env: { STOCK_COPILOT_PAPER_ENABLED: "1" } as unknown as Env,
    audit: (type, agent, payload) => {
      audits.push({ type, agent, payload });
    },
    submitAsyncJob: async (job) => {
      submittedJobs.push(job);
      return { jobId: "job-3721-1", status: "queued" as const, statusUrl: "/api/jobs/job-3721-1" };
    },
    getAsyncJob: () => undefined,
    listAsyncJobs: () => [],
    extractMessageText: () => "",
    getMessages: async () => [],
    recordMessage: () => {},
    runAgenticChatTurn: async () => {
      throw new Error("not used by the activation drive");
    },
    buildChatErrorFallback: async () => "",
    nlqSchedulingPort: () => ({}) as never,
  };

  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const cloned = request.clone();
    try {
      const body = (await cloned.json()) as { method?: string };
      if (body?.method) dispatchedMethods.push(body.method);
    } catch {
      /* notifications carry no method to log */
    }
    const response = await handleMcpChatNlqRoutes(
      request,
      url,
      url.pathname,
      "session-3721",
      routeCtx,
    );
    if (!response) throw new Error(`route did not handle ${url.pathname}`);
    return response;
  };

  const kit = makeDiscoveredPlatformTools({
    dispatch,
    resolveActingLogin: () => turn.login,
  });

  return {
    ensure: kit.ensure,
    aiTools: kit.aiTools,
    turn,
    audits,
    dispatchedMethods,
    submittedJobs,
  };
}

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

function receiptOf(result: unknown): Record<string, unknown> {
  const r = result as ToolResult;
  expect(r.isError, "tool result must not be an error").toBeFalsy();
  const text = r.content?.find((c) => c.type === "text")?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text as string) as Record<string, unknown>;
}

const PROMPT_BASE = {
  route: { agent: "trading", confidence: 0.9, reason: "activation suite" },
  memoryContext: "",
  vectorContext: "",
  optionsResearchContext: "",
  isAutoOptionsResearchRequest: false,
};

/* ------------------------------------------------------------------ */
/* 1. Declaration                                                      */
/* ------------------------------------------------------------------ */

describe("issue #3721 — the Stock Copilot's mcp-client declaration", () => {
  it("the stock registration declares mcpClient in the manifest vocabulary; general/options declare nothing", () => {
    expect(findCopilot("stock")?.capabilities).toContain("mcpClient");
    expect(findCopilot("general")?.capabilities ?? []).not.toContain("mcpClient");
    expect(findCopilot("options")?.capabilities ?? []).not.toContain("mcpClient");
  });

  it("the registration's sourceTab is the turn carrier the activation reads", () => {
    expect(findCopilot("stock")?.sourceTab).toBe(STOCK_COPILOT_SOURCE_TAB);
  });

  it("the class manifest resolves mcpClient enabled (the declaration the activation reads)", () => {
    const m = resolveAgentCapabilityManifest("OrchestratorAgent");
    expect(m.capabilities.mcpClient.state).toBe("enabled");
  });

  it("the five copilot commands are catalog commands (discovery is derived, never a turn-side list)", () => {
    const catalog = McpToolFactory.getAllTools().map((t) => t.name);
    for (const name of STOCK_COPILOT_COMMANDS) {
      expect(catalog, `catalog carries ${name}`).toContain(name);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Activation resolution                                            */
/* ------------------------------------------------------------------ */

describe("issue #3721 — activation resolution (manifest-driven, stock turns only)", () => {
  it("a stock-copilot turn with the declaration in place is active", () => {
    const a = resolveStockCopilotMcpActivation({
      sourceTab: STOCK_COPILOT_SOURCE_TAB,
      env: {},
    });
    expect(a).toEqual({ active: true, state: "enabled" });
  });

  it("general and options turns are not activated by this slice", () => {
    for (const sourceTab of ["Chat & Agents", "Broker · Auto Options Research", undefined]) {
      const a = resolveStockCopilotMcpActivation({ sourceTab, env: {} });
      expect(a.active, `sourceTab ${String(sourceTab)}`).toBe(false);
    }
  });

  it("withdrawing the declaration through the machinery's own override withdraws the activation", () => {
    const a = resolveStockCopilotMcpActivation({
      sourceTab: STOCK_COPILOT_SOURCE_TAB,
      env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:mcpClient" },
    });
    expect(a).toEqual({ active: false, state: "disabled-by-config" });
  });
});

/* ------------------------------------------------------------------ */
/* 3. The stock turn: discovered, usable, invocable                    */
/* ------------------------------------------------------------------ */

describe("issue #3721 — a stock turn discovers and invokes the copilot's MCP commands", () => {
  it("the discovered set carries all five copilot commands under their SDK keys", async () => {
    const drive = makeActivationDrive();
    const ensured = await drive.ensure();
    expect(ensured.ready).toBe(true);
    const tools = drive.aiTools();
    for (const key of STOCK_KEYS) {
      expect(tools[key], `discovered ${key}`).toBeDefined();
    }
    expect(drive.dispatchedMethods).toContain("tools/list");
  });

  it("the stock turn's usable set (merged set under the NLQ gate, portBeforeTurn's composition) keeps the copilot commands", async () => {
    const drive = makeActivationDrive();
    await drive.ensure();
    const names = Object.keys(drive.aiTools());
    const gate = chatNlqTurnGate({
      toolNames: names,
      context: { env: {} },
      audit: () => {},
    });
    const usable = gate.activeTools ?? names;
    for (const key of STOCK_KEYS) {
      expect(usable, `usable ${key}`).toContain(key);
    }
    expect(usable).not.toContain(`${OPENAIMP_MCP_TOOL_PREFIX}execute_nlq`);
  });

  it("stock_copilot_status executes end to end over the loopback carrier, attributed to the turn's login", async () => {
    const drive = makeActivationDrive();
    await drive.ensure();
    drive.turn.login = LOGIN;

    const tools = drive.aiTools() as Record<
      string,
      { execute: (input: never, opts: never) => Promise<unknown> }
    >;
    const statusTool = tools[`${OPENAIMP_MCP_TOOL_PREFIX}stock_copilot_status`];
    expect(statusTool).toBeDefined();

    const result = await statusTool.execute(
      {} as never,
      { toolCallId: "call-3721-1", messages: [] } as never,
    );
    const receipt = receiptOf(result);
    expect(receipt.status).toBeDefined();
    expect(receipt.executionMode).toBeDefined();
    expect(drive.dispatchedMethods).toContain("tools/call");
    // Synchronous tool (#3624): the call never became an async job.
    expect(drive.submittedJobs).toHaveLength(0);
    // Attribution: the command's audit names the turn's acting login.
    const auditRow = drive.audits.find((a) => a.type === "stock_copilot_status");
    expect(auditRow?.payload.actingLogin).toBe(LOGIN);
  });

  it("a tools/call with no resolvable login is refused at the carrier (mesh_mcp_identity_required) and never dispatched", async () => {
    const drive = makeActivationDrive();
    await drive.ensure();
    drive.turn.login = undefined;
    const tools = drive.aiTools() as Record<
      string,
      { execute: (input: never, opts: never) => Promise<unknown> }
    >;
    await expect(
      tools[`${OPENAIMP_MCP_TOOL_PREFIX}stock_copilot_status`].execute(
        {} as never,
        { toolCallId: "call-3721-2", messages: [] } as never,
      ),
    ).rejects.toThrow(/mesh_mcp_identity_required/);
    expect(drive.dispatchedMethods).not.toContain("tools/call");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Steering: the activation is what the stock turn is told about    */
/* ------------------------------------------------------------------ */

describe("issue #3721 — stock steering rides the activation, and only the activation", () => {
  it("an activated stock turn's prompt names the copilot's discovered commands verbatim", () => {
    const prompt = buildOrchestratorSystemPrompt({
      ...PROMPT_BASE,
      stockCopilotMcpActive: true,
    });
    for (const key of STOCK_KEYS) {
      expect(prompt, `prompt names ${key}`).toContain(key);
    }
  });

  it("without the activation the prompt is byte-identical to today's (general/options turns unchanged)", () => {
    const base = buildOrchestratorSystemPrompt(PROMPT_BASE);
    const flaggedOff = buildOrchestratorSystemPrompt({
      ...PROMPT_BASE,
      stockCopilotMcpActive: false,
    });
    expect(flaggedOff).toBe(base);
    expect(base).not.toContain("tool_openaimp_stock_copilot_status");
  });

  it("the full loop: resolver state drives the steering a stock turn gets", () => {
    const on = resolveStockCopilotMcpActivation({
      sourceTab: STOCK_COPILOT_SOURCE_TAB,
      env: {},
    });
    const off = resolveStockCopilotMcpActivation({
      sourceTab: STOCK_COPILOT_SOURCE_TAB,
      env: { AGENT_CAPABILITIES_DISABLED: "OrchestratorAgent:mcpClient" },
    });
    const onPrompt = buildOrchestratorSystemPrompt({
      ...PROMPT_BASE,
      stockCopilotMcpActive: on.active,
    });
    const offPrompt = buildOrchestratorSystemPrompt({
      ...PROMPT_BASE,
      stockCopilotMcpActive: off.active,
    });
    expect(onPrompt).toContain("tool_openaimp_stock_copilot_control");
    expect(offPrompt).not.toContain("tool_openaimp_stock_copilot_control");
  });
});
