/**
 * Issue #2421 (Agent Mesh S15, programme #2225 G12) — every
 * capability, every door, with gate parity.
 *
 * What this suite pins:
 *  1. The capability × door census in src/agents/registry.ts
 *     (MESH_CAPABILITY_DOORS): complete (every fleet class × the
 *     five doors), and every entry honest — an exposed entry names
 *     its gate; a not-exposed entry names its reason.
 *  2. The census A2A column against the door's own sources of
 *     truth: the cards (AGENT_CARDS), the resolutions
 *     (A2A_RESOLUTIONS), the dispatch operation constants, and —
 *     the pin whose absence let #2178 silently unwire the
 *     orchestrator — the presence of `async handleA2A` on every
 *     class the census claims is A2A-exposed (and its absence on
 *     the classes it claims are not).
 *  3. The SandboxAgent A2A surface (#2253's recorded follow-up):
 *     dispatch behavior against a fake executor (the service's
 *     degraded posture carried verbatim), card/resolution/registry
 *     parity, and edge gate parity through the real dispatcher
 *     (unconfigured → 503, missing/wrong token → 401, valid token
 *     reaches the stub).
 *  4. The restored OrchestratorAgent.handleA2A: exercised on a
 *     REAL class instance over mock storage — refusal shapes for
 *     missing/unknown operations, a MAS operation end-to-end, and
 *     the JSON-RPC envelope form.
 *  5. report_asset.list on the A2A door (parity with the chat
 *     door's list since #2349), card == dispatch constant.
 *  6. The census chat column against the mesh-door command
 *     registry (the union over the six door classes equals the
 *     mesh-door family's commands, each under exactly one class),
 *     plus the gate-parity negatives: no settle/execute operation
 *     on the TradingAgent chat door, no raw paid request on the
 *     PaymentsAgent chat door.
 *  7. The agent-as-a-tool column against the only runAgentTool
 *     facet call site in src/ (ResearchAgent, researchPublish.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MESH_AGENTS,
  MESH_DOORS,
  MESH_CAPABILITY_DOORS,
  MESH_SURFACES,
  getSurface,
  capabilityDoor,
  capabilityDoorsForClass,
  classesExposedOn,
  getToolFamily,
} from "../src/agents/registry";
import { AGENT_CARDS, getAgentCard } from "../src/a2a/agent-cards";
import { resolveA2AAgent, resolveA2AInstanceName } from "../src/a2a/resolution";
import { handleA2A } from "../src/a2a/index";
import { ORCHESTRATOR_A2A_OPERATIONS } from "../src/agents/orchestrator/a2aDispatch";
import {
  SANDBOX_A2A_OPERATIONS,
  dispatchSandboxA2A,
  sandboxA2AOutcome,
  type SandboxA2AExecutor,
} from "../src/agents/sandboxA2aDispatch";
import {
  REPORT_ASSET_A2A_OPERATIONS,
  dispatchReportAssetA2A,
  type ReportAssetA2AExecutor,
} from "../src/agents/reportAssetA2aDispatch";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const DOOR_IDS = MESH_DOORS.map((d) => d.id);

// ---------------------------------------------------------------------------
// 1. Census completeness and honesty of shape.
// ---------------------------------------------------------------------------

describe("capability × door census (#2421)", () => {
  it("records exactly one entry for every fleet class × every door", () => {
    expect(MESH_CAPABILITY_DOORS.length).toBe(MESH_AGENTS.length * MESH_DOORS.length);
    for (const agent of MESH_AGENTS) {
      const entries = capabilityDoorsForClass(agent.className);
      expect(entries.map((e) => e.door).sort()).toEqual([...DOOR_IDS].sort());
    }
    const keys = MESH_CAPABILITY_DOORS.map((e) => `${e.className}:${e.door}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every exposed entry names its gate; every not-exposed entry names its reason", () => {
    for (const entry of MESH_CAPABILITY_DOORS) {
      if (entry.status === "exposed") {
        expect(entry.gate, `${entry.className} on ${entry.door}`).toBeTruthy();
        expect(entry.gate!.length).toBeGreaterThan(10);
      } else {
        expect(entry.reason, `${entry.className} on ${entry.door}`).toBeTruthy();
        expect(entry.reason!.length).toBeGreaterThan(20);
      }
    }
  });

  it("accessors answer the S20/S16 questions: doors for a class, classes on a door", () => {
    expect(capabilityDoor("SandboxAgent", "a2a")?.status).toBe("exposed");
    expect(capabilityDoor("TickerAgent", "a2a")?.status).toBe("not-exposed");
    expect(classesExposedOn("agent-as-a-tool")).toEqual(["ResearchAgent"]);
    expect(classesExposedOn("a2a")).not.toContain("SessionStore");
  });
});

// ---------------------------------------------------------------------------
// 2. The A2A column against the door's sources of truth.
// ---------------------------------------------------------------------------

describe("census A2A column vs cards, resolutions, dispatch constants, class sources", () => {
  it("exposed ⟺ the class owns a dispatch surface in the registry", () => {
    for (const agent of MESH_AGENTS) {
      const entry = capabilityDoor(agent.className, "a2a")!;
      const ownsSurface = MESH_SURFACES.some(
        (s) => s.ownerClass === agent.className && s.dispatch,
      );
      expect(entry.status === "exposed", agent.className).toBe(ownsSurface);
    }
  });

  it("every dispatch surface resolves at the edge and (except dispatch-only nlq) has a card", () => {
    for (const surface of MESH_SURFACES.filter((s) => s.dispatch)) {
      expect(resolveA2AAgent(surface.name), surface.name).toBeDefined();
      if (surface.card) {
        expect(getAgentCard(surface.name), surface.name).toBeDefined();
      }
    }
  });

  it("census A2A operations equal the published card operations (orchestrator family: the dispatch constant)", () => {
    for (const agent of MESH_AGENTS) {
      const entry = capabilityDoor(agent.className, "a2a")!;
      if (entry.status !== "exposed") {
        expect(entry.operations).toEqual([]);
        continue;
      }
      if (agent.className === "OrchestratorAgent") {
        // Five surfaces, one dispatch: the orchestrator card carries
        // the full set and the other cards are subsets; nlq has no
        // card. The dispatch constant is the union.
        expect(entry.operations).toEqual([...ORCHESTRATOR_A2A_OPERATIONS]);
        expect(getAgentCard("orchestrator")!.operations).toEqual([
          ...ORCHESTRATOR_A2A_OPERATIONS,
        ]);
        continue;
      }
      const surfaces = MESH_SURFACES.filter(
        (s) => s.ownerClass === agent.className && s.dispatch && s.card,
      );
      expect(surfaces.length, agent.className).toBe(1);
      expect(entry.operations, agent.className).toEqual(
        getAgentCard(surfaces[0].name)!.operations,
      );
    }
  });

  it("every A2A-exposed class implements handleA2A; every not-exposed class does not (the #2178 pin)", () => {
    for (const agent of MESH_AGENTS) {
      const entry = capabilityDoor(agent.className, "a2a")!;
      const src = read(agent.sourceFile);
      if (entry.status === "exposed") {
        expect(src, `${agent.className} must wire handleA2A`).toContain(
          "async handleA2A",
        );
      } else {
        expect(src, `${agent.className} must not grow an unwired door`).not.toContain(
          "async handleA2A",
        );
      }
    }
  });

  it("the orchestrator wiring delegates to the surviving dispatch module (restoration, not a parallel implementation)", () => {
    const src = read("src/agents/orchestrator.ts");
    expect(src).toContain("dispatchOrchestratorA2A");
    expect(src).toContain("orchestratorA2AOutcome");
    expect(src).toContain("nlqExecute");
  });
});

// ---------------------------------------------------------------------------
// 3. SandboxAgent A2A dispatch (fake executor at the seam).
// ---------------------------------------------------------------------------

const DEGRADED_STATUS = {
  agent: "SandboxAgent" as const,
  backendConfigured: false,
  degraded: true,
  detail: "Degraded: no container backend is bound.",
};

function fakeSandboxExecutor(): SandboxA2AExecutor & {
  runCalls: Array<{ command: string; timeoutMs?: number }>;
} {
  const runCalls: Array<{ command: string; timeoutMs?: number }> = [];
  return {
    runCalls,
    sandboxStatus: () => DEGRADED_STATUS,
    runCommand: async (request) => {
      runCalls.push(request);
      return {
        executed: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        error: "NOT_EXECUTED: no container backend is bound.",
      };
    },
  };
}

describe("sandbox A2A dispatch (#2421)", () => {
  it("sandbox.status returns the class's status verbatim, degraded posture in the text", async () => {
    const data = await dispatchSandboxA2A({} as Env, { operation: "sandbox.status" }, {
      executor: fakeSandboxExecutor(),
    });
    expect(data.ok).toBe(true);
    expect(data.result).toEqual(DEGRADED_STATUS);
    const outcome = sandboxA2AOutcome(data);
    expect(outcome.text).toContain("NOT configured");
    expect(outcome.text).toContain("executed:false");
  });

  it("sandbox.run_command passes command + timeoutMs through and returns the honest non-execution verbatim", async () => {
    const executor = fakeSandboxExecutor();
    const data = await dispatchSandboxA2A(
      {} as Env,
      { operation: "sandbox.run_command", command: "echo hi", timeoutMs: 5000 },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(executor.runCalls).toEqual([{ command: "echo hi", timeoutMs: 5000 }]);
    const result = data.result as { executed: boolean; exitCode: number | null };
    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(sandboxA2AOutcome(data).text).toContain("NOT executed");
  });

  it("refuses a missing or blank command as invalid_input, before any execution", async () => {
    const executor = fakeSandboxExecutor();
    for (const body of [
      { operation: "sandbox.run_command" },
      { operation: "sandbox.run_command", command: "   " },
      { operation: "sandbox.run_command", command: 42 },
      { operation: "sandbox.run_command", command: "ls", timeoutMs: -1 },
    ]) {
      const data = await dispatchSandboxA2A({} as Env, body, { executor });
      expect(data.ok).toBe(false);
      expect(data.code).toBe("invalid_input");
    }
    expect(executor.runCalls).toEqual([]);
  });

  it("refuses missing and unknown operations with the stable tokens", async () => {
    const executor = fakeSandboxExecutor();
    const missing = await dispatchSandboxA2A({} as Env, {}, { executor });
    expect(missing.code).toBe("missing_operation");
    const unknown = await dispatchSandboxA2A(
      {} as Env,
      { operation: "sandbox.rm_rf" },
      { executor },
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe("unknown_operation");
  });

  it("extracts the operation from the JSON-RPC envelope data part", async () => {
    const data = await dispatchSandboxA2A(
      {} as Env,
      {
        jsonrpc: "2.0",
        id: 7,
        params: {
          message: {
            parts: [{ kind: "data", data: { operation: "sandbox.status" } }],
          },
        },
      },
      { executor: fakeSandboxExecutor() },
    );
    expect(data.ok).toBe(true);
    expect(data.operation).toBe("sandbox.status");
  });

  it("fails honestly (never fabricates) when no executor is configured", async () => {
    const data = await dispatchSandboxA2A({} as Env, { operation: "sandbox.status" }, {});
    expect(data.ok).toBe(false);
    expect(data.code).toBe("internal_error");
    expect(data.error).toContain("not configured");
  });

  it("card, resolution, and registry surface agree with the dispatch constant", () => {
    expect(getAgentCard("sandbox")!.operations).toEqual([...SANDBOX_A2A_OPERATIONS]);
    const resolution = resolveA2AAgent("sandbox")!;
    expect(resolution.binding).toBe("SANDBOX_AGENT");
    // Stateless/env-driven like browser: the URL name is the instance.
    expect(resolveA2AInstanceName(resolution, "sandbox", {} as Env)).toBe("sandbox");
    expect(getSurface("sandbox")).toEqual({
      name: "sandbox",
      ownerClass: "SandboxAgent",
      card: true,
      dispatch: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Edge gate parity for the new surface, through the real dispatcher.
// ---------------------------------------------------------------------------

describe("A2A edge gate parity — /a2a/sandbox (#2421)", () => {
  function makeSandboxEnv(withToken = true) {
    const stubCalls: unknown[] = [];
    const env: Record<string, unknown> = {
      SANDBOX_AGENT: {
        idFromName: (name: string) => ({ name }),
        get: (_id: { name: string }) => ({
          handleA2A: async (body: unknown, origin: string) => {
            stubCalls.push({ body, origin });
            return { text: "ok", data: { ok: true } };
          },
        }),
      },
    };
    if (withToken) env.A2A_API_TOKEN = "test-token";
    return { env, stubCalls };
  }

  const post = (path: string, token?: string) =>
    new Request(`https://agent.example${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ operation: "sandbox.status" }),
    });

  it("fails closed 503 when the A2A token is unconfigured — before resolution", async () => {
    const { env, stubCalls } = makeSandboxEnv(false);
    const res = await handleA2A(post("/a2a/sandbox", "anything"), env as Env);
    expect(res.status).toBe(503);
    expect(stubCalls).toEqual([]);
  });

  it("refuses missing and wrong tokens with 401, before the stub is touched", async () => {
    const { env, stubCalls } = makeSandboxEnv();
    expect((await handleA2A(post("/a2a/sandbox"), env as Env)).status).toBe(401);
    expect((await handleA2A(post("/a2a/sandbox", "wr0ng"), env as Env)).status).toBe(401);
    expect(stubCalls).toEqual([]);
  });

  it("a valid token reaches the sandbox stub and returns its outcome", async () => {
    const { env, stubCalls } = makeSandboxEnv();
    const res = await handleA2A(post("/a2a/sandbox", "test-token"), env as Env);
    expect(res.status).toBe(200);
    expect(stubCalls.length).toBe(1);
    const payload = (await res.json()) as { result?: { artifacts?: unknown[] } };
    expect(payload.result?.artifacts).toBeDefined();
  });

  it("discovery serves the sandbox card publicly (cards are not the gated surface)", async () => {
    const { env } = makeSandboxEnv(false);
    const res = await handleA2A(
      new Request("https://agent.example/a2a/sandbox/agent-card.json"),
      env as Env,
    );
    expect(res.status).toBe(200);
    const card = (await res.json()) as { name: string; operations: string[] };
    expect(card.name).toBe("sandbox");
    expect(card.operations).toEqual([...SANDBOX_A2A_OPERATIONS]);
  });
});

// ---------------------------------------------------------------------------
// 5. OrchestratorAgent.handleA2A — the restored wiring, on a real
// class instance over mock storage (the #2178 regression, pinned).
// ---------------------------------------------------------------------------

describe("OrchestratorAgent.handleA2A restored wiring (#2421)", () => {
  function seedAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      id: { toString: () => "mesh_s15_orchestrator" },
      storage: { sql },
      waitUntil: vi.fn(),
    };
    const env = {
      AI: {},
      APP_ENV: "TEST",
      SEARCH_AGENT: {},
    } as unknown as Env;
    return new OrchestratorAgent(ctx as never, env);
  }

  it("the class exposes handleA2A as a function (the edge dispatcher's stub check)", () => {
    const agent = seedAgent();
    expect(typeof (agent as { handleA2A?: unknown }).handleA2A).toBe("function");
  });

  it("a body with no operation is refused as missing_operation by the real dispatch", async () => {
    const agent = seedAgent();
    const outcome = await agent.handleA2A({}, "https://agent.example");
    expect(outcome.data.ok).toBe(false);
    expect(outcome.data.code).toBe("missing_operation");
    expect(outcome.text).toContain("failed");
  });

  it("an unknown operation is refused as unknown_operation", async () => {
    const agent = seedAgent();
    const outcome = await agent.handleA2A(
      { operation: "bogus.op" },
      "https://agent.example",
    );
    expect(outcome.data.ok).toBe(false);
    expect(outcome.data.code).toBe("unknown_operation");
  });

  it("tasks.create runs end-to-end through the real MAS construction", async () => {
    const agent = seedAgent();
    const outcome = await agent.handleA2A(
      { operation: "tasks.create", title: "Review Q3 report" },
      "https://agent.example",
    );
    expect(outcome.data.ok).toBe(true);
    expect(outcome.text).toContain("UNPERSISTED");
  });

  it("memory.remember then memory.recall round-trips through the class's own storage", async () => {
    const agent = seedAgent();
    const remembered = await agent.handleA2A(
      { operation: "memory.remember", key: "tone", value: "concise" },
      "https://agent.example",
    );
    expect(remembered.data.ok).toBe(true);
    const recalled = await agent.handleA2A(
      { operation: "memory.recall", filter: "tone" },
      "https://agent.example",
    );
    expect(recalled.data.ok).toBe(true);
    expect(recalled.text).toContain("1 fact(s)");
  });

  it("the JSON-RPC envelope form reaches the same dispatch", async () => {
    const agent = seedAgent();
    const outcome = await agent.handleA2A(
      {
        jsonrpc: "2.0",
        id: 3,
        params: {
          message: {
            parts: [
              { kind: "data", data: { operation: "tasks.create", title: "Env task" } },
            ],
          },
        },
      },
      "https://agent.example",
    );
    expect(outcome.data.ok).toBe(true);
    expect(outcome.data.operation).toBe("tasks.create");
  });

  it("nlq.execute without a query is an input refusal, not a fabricated plan", async () => {
    const agent = seedAgent();
    const outcome = await agent.handleA2A(
      { operation: "nlq.execute" },
      "https://agent.example",
    );
    expect(outcome.data.ok).toBe(false);
    expect(outcome.data.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// 6. report_asset.list on the A2A door (chat-door parity, #2421).
// ---------------------------------------------------------------------------

describe("report_asset.list A2A operation (#2421)", () => {
  const METAS = [
    { key: "reports/a.pdf", fileName: "a.pdf", storedAt: "2026-10-01T00:00:00.000Z" },
    { key: "reports/b.pdf", fileName: "b.pdf", storedAt: "2026-10-02T00:00:00.000Z" },
  ];

  function fakeExecutor(): ReportAssetA2AExecutor & { listLimits: Array<number | undefined> } {
    const listLimits: Array<number | undefined> = [];
    return {
      listLimits,
      generateAsset: async () => null,
      getAsset: async () => null,
      listAssets: async (limit?: number) => {
        listLimits.push(limit);
        return limit !== undefined ? METAS.slice(0, limit) : METAS;
      },
    };
  }

  it("is in the dispatch constant and the card, in parity", () => {
    expect(REPORT_ASSET_A2A_OPERATIONS).toContain("report_asset.list");
    expect(getAgentCard("report-asset")!.operations).toEqual([
      ...REPORT_ASSET_A2A_OPERATIONS,
    ]);
  });

  it("lists the service instance's asset metadata (no bytes ride a listing)", async () => {
    const executor = fakeExecutor();
    const data = await dispatchReportAssetA2A(
      {} as Env,
      { operation: "report_asset.list" },
      { executor },
    );
    expect(data.ok).toBe(true);
    expect(data.result).toEqual(METAS);
    expect(executor.listLimits).toEqual([undefined]);
  });

  it("threads an explicit limit and refuses a non-positive one", async () => {
    const executor = fakeExecutor();
    const limited = await dispatchReportAssetA2A(
      {} as Env,
      { operation: "report_asset.list", limit: 1 },
      { executor },
    );
    expect(limited.ok).toBe(true);
    expect(limited.result).toEqual([METAS[0]]);
    const refused = await dispatchReportAssetA2A(
      {} as Env,
      { operation: "report_asset.list", limit: 0 },
      { executor },
    );
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// 7. The census chat column vs the mesh-door command registry,
// plus the gate-parity negatives.
// ---------------------------------------------------------------------------

describe("census chat column vs the mesh-door command registry (#2421)", () => {
  const EXPECTED_CHAT_OPS: Record<string, string[]> = {
    ScheduledAgent: ["list_scheduled_goals", "trigger_scheduled_goal"],
    PaymentsAgent: ["check_payment_budget", "get_payments_overview"],
    TradingAgent: [
      "propose_stock_trade",
      "propose_options_trade",
      "get_trading_accounts",
      "get_trading_positions",
      "get_trading_quote",
      "start_trade_approval",
      "decide_trade_approval",
      "get_trade_approval_status",
    ],
    ReportAssetAgent: ["list_report_assets", "get_report_asset"],
    BrowserAgent: [
      "browser_snap_transaction",
      "browser_capture_page",
      "browser_scrape_tables",
    ],
    SlackAgent: ["slack_send_pre_trade_approval", "slack_dispatch_transaction_snap"],
  };

  it("each door class's census chat operations are exactly its mesh-door commands", () => {
    for (const [className, ops] of Object.entries(EXPECTED_CHAT_OPS)) {
      expect(capabilityDoor(className, "chat-turn")!.operations, className).toEqual(ops);
    }
  });

  it("the union over the door classes equals the registry's mesh-door family, each command under exactly one class", () => {
    const family = getToolFamily("mesh-door-mcp-commands")!;
    const union = Object.keys(EXPECTED_CHAT_OPS).flatMap(
      (className) => capabilityDoor(className, "chat-turn")!.operations,
    );
    // #2488: ScreenerAgent joined the door classes (run_stock_screen,
    // in the family) — it is asserted separately below because its
    // chat cell also records the NLQ surface's nlq.execute
    // capability, which is not a mesh-door command. #2581 added
    // run_options_strategy_screen to the same cell and family.
    expect([...union, "run_stock_screen", "run_options_strategy_screen"].sort()).toEqual([...family.commands].sort());
    expect(new Set(union).size).toBe(union.length);
    // AiSearchAgent's chat reach is a catalog command, not a mesh-door
    // command — recorded on its own census entry, outside this family.
    expect(capabilityDoor("AiSearchAgent", "chat-turn")!.operations).toEqual([
      "ai_search_agent_search",
    ]);
    // ScreenerAgent's chat cell (#2488): its mesh-door commands plus
    // the NLQ async capability the NLQ surfaces bind — the door
    // commands are in the family above; nlq.execute belongs to the
    // core-mcp family and is recorded here so the cell states both
    // reaches exactly. #2581 added the options-strategy door
    // command to the same cell.
    expect(capabilityDoor("ScreenerAgent", "chat-turn")!.operations).toEqual([
      "run_stock_screen",
      "run_options_strategy_screen",
      "nlq.execute",
    ]);
  });

  it("gate parity negatives: no settle/execute on the trading chat door; no raw paid request on the payments chat door", () => {
    const tradingOps = capabilityDoor("TradingAgent", "chat-turn")!.operations;
    expect(tradingOps.some((op) => /execute|settle/.test(op))).toBe(false);
    const paymentsOps = capabilityDoor("PaymentsAgent", "chat-turn")!.operations;
    expect(paymentsOps.some((op) => /process|paid_request/.test(op))).toBe(false);
    // And on the A2A door, the payment capability keeps its own gates:
    // the census records the budget guard as part of the exposure.
    const paymentsA2a = capabilityDoor("PaymentsAgent", "a2a")!;
    expect(paymentsA2a.operations).toContain("payments.process");
    expect(paymentsA2a.notes).toContain("budget guard");
  });

  it("gate parity: the browser and slack doors record the no-caller-supplied-webhookUrl rule on both chat and A2A", () => {
    for (const className of ["BrowserAgent", "SlackAgent"]) {
      for (const door of ["chat-turn", "a2a"] as const) {
        const entry = capabilityDoor(className, door)!;
        const text = `${entry.gate ?? ""} ${entry.notes ?? ""}`;
        expect(text, `${className} ${door}`).toContain("webhookUrl");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 8. The agent-as-a-tool column vs the runAgentTool call sites.
// ---------------------------------------------------------------------------

describe("census agent-as-a-tool column vs runAgentTool call sites (#2421)", () => {
  it("exactly one class is exposed: ResearchAgent, through the one facet call site in src/", () => {
    const srcFiles = readdirSync(resolve(root, "src/agents"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    const callSites: string[] = [];
    for (const rel of srcFiles) {
      const src = read(`src/agents/${rel}`);
      for (const match of src.matchAll(/runAgentTool\(\s*([A-Z]\w*)/g)) {
        callSites.push(`${rel}:${match[1]}`);
      }
    }
    expect(callSites).toEqual(["orchestrator/researchPublish.ts:ResearchAgent"]);
    const entry = capabilityDoor("ResearchAgent", "agent-as-a-tool")!;
    expect(entry.status).toBe("exposed");
    expect(entry.operations).toEqual(["runAgentTool"]);
  });
});

// ---------------------------------------------------------------------------
// 9. Deliberate negatives, spot-checked for the reasons that matter.
// ---------------------------------------------------------------------------

describe("deliberate non-exposures carry their real reasons (#2421)", () => {
  it("TickerAgent on A2A: the public streaming tape cannot be carried by an authenticated request/response door", () => {
    const entry = capabilityDoor("TickerAgent", "a2a")!;
    expect(entry.status).toBe("not-exposed");
    expect(entry.reason).toContain("WebSocket");
    expect(entry.reason).toContain("public");
    // Its one exposed door is the WS route, with its no-auth posture
    // recorded rather than silently inherited.
    const http = capabilityDoor("TickerAgent", "http-routes")!;
    expect(http.status).toBe("exposed");
    expect(http.gate).toContain("public");
  });

  it("SessionStore is not exposed on any door — the credential boundary", () => {
    for (const door of DOOR_IDS) {
      expect(capabilityDoor("SessionStore", door)!.status, door).toBe("not-exposed");
    }
    expect(capabilityDoor("SessionStore", "a2a")!.reason).toContain("credential");
  });

  it("SandboxAgent's chat/MCP entries record the class-wiring gap honestly (capability reachable, class not wired)", () => {
    for (const door of ["chat-turn", "mcp"] as const) {
      const entry = capabilityDoor("SandboxAgent", door)!;
      expect(entry.status).toBe("not-exposed");
      expect(entry.reason).toContain("run_sandbox_command");
      expect(entry.reason).toContain("#2253");
    }
  });

  it("OptionsScannerMCP: only its own MCP surface is exposed; the programme-scope exclusion is recorded", () => {
    expect(capabilityDoor("OptionsScannerMCP", "mcp")!.status).toBe("exposed");
    for (const door of ["chat-turn", "http-routes", "a2a", "agent-as-a-tool"] as const) {
      const entry = capabilityDoor("OptionsScannerMCP", door)!;
      expect(entry.status, door).toBe("not-exposed");
      expect(entry.reason).toContain("OUT of mesh scope");
    }
  });
});
