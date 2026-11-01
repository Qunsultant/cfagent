/**
 * Issue #2581 — the mesh options-strategy door: chat options
 * strategy screening through a catalog door command, not NLQ.
 *
 * The gap (owner report 2026-10-31): "Screen the NASDAQ100 for
 * bull put credit spreads where my max loss is no more than $30
 * and my max profit is greater than $0" was deflected to the UI
 * ("Workflow 2: Options Strategy Discovery & Greeks") because the
 * only programmatic path to the options strategy engine was the
 * NLQ options_opportunities action, and NLQ is flagged off the
 * chat turn (CHAT_NLQ_MODE, #2488). This suite proves the door:
 * the turn's discovered catalog tool (tool_openaimp_run_options_
 * strategy_screen) → the real executor entry (executeMCPTool with
 * the async-job executor's context shape) → the door command →
 * the door service → the EXISTING engine seam the NLQ action uses
 * (runOptionsStrategyAction, src/agents/nlqOptionsStrategy.ts)
 * with structured filters the door assembles. NLQ is not routed
 * through and not touched; fakes sit only at binding seams (the
 * engine seam itself, the listings seam, the ETradeService
 * composition) — the programme's acceptance rule.
 */
import { describe, expect, it } from "vitest";
import { executeMCPTool } from "../src/mcps/openaimp";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  runOptionsStrategyScreenViaDoor,
  type MeshOptionsStrategyDoorSeams,
} from "../src/agents/orchestrator/meshOptionsStrategyDoor";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import {
  goldenTask,
  executeGoldenTasks,
  type GoldenTaskExecution,
} from "../src/services/meshGoldenTasks";
import { InMemoryMeshEvalStore } from "../src/data/inMemoryMeshEvalAdapter";
import type { Env } from "../src/types";

const LOGIN = "alice";

/* ------------------------------------------------------------------ */
/* Harness: the engine seam faked at its binding seam                  */
/* ------------------------------------------------------------------ */

interface EngineCall {
  facade: unknown;
  action: string;
  filters: Record<string, any>;
  deps: Record<string, any>;
}

interface Harness {
  calls: EngineCall[];
  serviceLogins: string[];
  resolvedUniverses: string[];
  seams: MeshOptionsStrategyDoorSeams;
}

function rankedResult() {
  return {
    count: 2,
    status: "ranked_opportunities",
    summary: "Opportunity scan over 3 listed symbols: 3 symbols scanned, 2 with a qualifying bullish trade (balanced ranking). Research only; verify live quotes and approve any order manually.",
    rows: [
      { rank: 1, symbol: "NVDA", strategy: "Put Credit Spread", maxLoss: "$25.00", maxProfit: "$25.00", score: 88.5 },
      { rank: 2, symbol: "AMD", strategy: "Put Credit Spread", maxLoss: "$28.00", maxProfit: "$12.00", score: 71.2 },
    ],
    mode: "per_name_best",
  };
}

function makeHarness(engineResult: () => Promise<Record<string, unknown>> = async () => rankedResult()): Harness {
  const calls: EngineCall[] = [];
  const serviceLogins: string[] = [];
  const resolvedUniverses: string[] = [];
  const seams: MeshOptionsStrategyDoorSeams = {
    createEtradeService: (login: string) => {
      serviceLogins.push(login);
      return { client: { marker: "etrade-client" } } as never;
    },
    resolveUniverseSymbols: async (universe: string) => {
      resolvedUniverses.push(universe);
      return ["NVDA", "AMD", "AAPL"];
    },
    runOptionsStrategy: (async (facade: unknown, action: string, filters: Record<string, any>, deps: Record<string, any>) => {
      calls.push({ facade, action, filters, deps });
      return engineResult();
    }) as never,
  };
  return { calls, serviceLogins, resolvedUniverses, seams };
}

/** The async-job executor's context shape (asyncJobs.ts mcp.tool branch). */
function executorContext(h: Harness, actingLogin: string | undefined) {
  return {
    env: {} as Env,
    orm: {} as never,
    sessionId: "session-2581",
    audit: () => {},
    principal: { kind: "system", login: null },
    actingLogin: () => actingLogin,
    traceparent: () => undefined,
    meshOptionsStrategyDoorSeams: h.seams,
  };
}

async function runDoorToolAs(h: Harness, args: Record<string, unknown>, actingLogin: string | undefined) {
  return executeMCPTool(
    "run_options_strategy_screen",
    args,
    executorContext(h, actingLogin) as never,
  );
}

async function runDoorTool(h: Harness, args: Record<string, unknown>) {
  return runDoorToolAs(h, args, LOGIN);
}

/* ------------------------------------------------------------------ */
/* Catalog registration                                                */
/* ------------------------------------------------------------------ */

describe("issue #2581 — run_options_strategy_screen catalog registration", () => {
  it("is registered in the factory with the mcp:write scope", () => {
    expect(McpToolFactory.getTool("run_options_strategy_screen")).toBeDefined();
    expect(MCP_TOOL_SCOPES.run_options_strategy_screen).toBe("mcp:write");
    expect(McpToolFactory.getAllTools()).toHaveLength(83);
  });

  it("the prompt steers options strategy screens at the discovered tool", () => {
    const prompt = buildOrchestratorSystemPrompt({
      route: { agent: "search", confidence: 0.9, rationale: "test" },
      memoryContext: "",
      vectorContext: "",
      optionsResearchContext: "",
      isAutoOptionsResearchRequest: false,
    } as never);
    expect(prompt).toContain("tool_openaimp_run_options_strategy_screen");
  });
});

/* ------------------------------------------------------------------ */
/* The door: identity, plumbing, validation, honesty                   */
/* ------------------------------------------------------------------ */

describe("issue #2581 — the options strategy door", () => {
  it("stamps identity from the acting login only: the engine service and deps carry it, never the arguments", async () => {
    const h = makeHarness();
    const result = await runDoorTool(h, {
      universe: "NASDAQ100",
      strategyType: "put_credit_spread",
      maxLoss: 30,
    });
    expect(result.status).toBe("ranked_opportunities");
    // The E*TRADE service was composed for the acting login (#1185
    // discipline — the service refuses a missing login), and the
    // engine deps carry the same login for scan-run ownership.
    expect(h.serviceLogins).toEqual([LOGIN]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].deps.userLogin).toBe(LOGIN);
  });

  it("refuses with identity_required and zero engine calls when no acting identity is resolvable", async () => {
    const h = makeHarness();
    await expect(
      runDoorToolAs(h, { universe: "NASDAQ100", strategyType: "put_credit_spread" }, undefined),
    ).rejects.toMatchObject({ name: "MeshDoorError", code: "identity_required" });
    expect(h.calls).toHaveLength(0);
    expect(h.serviceLogins).toHaveLength(0);
  });

  it("plumbs the reported constraints to the engine seam: universe scope, catalog strategy, max loss, min profit", async () => {
    const h = makeHarness();
    await runDoorTool(h, {
      universe: "NASDAQ100",
      strategyType: "Bull Put Credit Spread",
      maxLoss: 30,
      minProfit: 0.01,
    });
    expect(h.resolvedUniverses).toEqual(["NASDAQ100"]);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call.action).toBe("options_opportunities");
    // Universe scope: the registry universe resolved to its symbol
    // batch through the listings seam, handed to the engine as an
    // explicit symbol scope (the scan's own scope vocabulary).
    expect(call.filters.scope).toEqual({ kind: "symbols", symbols: ["NVDA", "AMD", "AAPL"] });
    // "Bull Put Credit Spread" is the catalog alias of
    // put_credit_spread — resolved against the engine's own
    // strategy catalog, carried on both engine selection fields.
    expect(call.filters.request.allowedStrategies).toEqual(["put_credit_spread"]);
    expect(call.filters.strategyFilter.strategyTypes).toEqual(["put_credit_spread"]);
    // The strategy's catalog thesis orients the scan (bullish).
    expect(call.filters.request.thesis).toBe("bullish");
    // The user's constraints, in the engine's own field names:
    // max loss -> the template's maxPlannedLoss cap; max profit
    // floor -> the screen filter's minMaxProfit.
    expect(call.filters.request.maxPlannedLoss).toBe(30);
    expect(call.filters.strategyFilter.minMaxProfit).toBe(0.01);
    expect(call.filters.mode).toBe("per_name_best");
  });

  it("refuses an unknown strategy type against the catalog, before any engine call", async () => {
    const h = makeHarness();
    await expect(
      runDoorTool(h, { universe: "NASDAQ100", strategyType: "not_a_real_strategy" }),
    ).rejects.toMatchObject({ name: "MeshDoorError", code: "invalid_strategy_type" });
    expect(h.calls).toHaveLength(0);
    expect(h.serviceLogins).toHaveLength(0);
  });

  it("refuses an unknown universe at the door service, before any engine call", async () => {
    const h = makeHarness();
    await expect(
      runOptionsStrategyScreenViaDoor(
        { env: {} as Env, orm: {} as never, ...h.seams },
        LOGIN,
        { universe: "DOW30", strategyType: "put_credit_spread" },
      ),
    ).rejects.toMatchObject({ name: "MeshDoorError", code: "door_unavailable" });
    expect(h.calls).toHaveLength(0);
  });

  it("returns candidates in the engine's own ranking order, with the constraint echo", async () => {
    const h = makeHarness();
    const result = await runDoorTool(h, {
      universe: "NASDAQ100",
      strategyType: "Bull Put Credit Spread",
      maxLoss: 30,
      minProfit: 0.01,
    });
    expect(result.count).toBe(2);
    // Engine order is the door's order — the door never re-ranks.
    expect(result.rows.map((r: { symbol: string }) => r.symbol)).toEqual(["NVDA", "AMD"]);
    expect(result.constraints).toEqual({
      universe: "NASDAQ100",
      strategyTypes: ["put_credit_spread"],
      maxLoss: 30,
      minProfit: 0.01,
    });
  });

  it("an empty engine result is an honest no-qualifying-spreads payload, never an error", async () => {
    const h = makeHarness(async () => ({
      count: 0,
      status: "no_opportunities",
      summary: "Opportunity scan over 3 listed symbols: 3 symbols scanned, 0 with a qualifying bullish trade (balanced ranking). Research only; verify live quotes and approve any order manually.",
      rows: [],
      mode: "per_name_best",
    }));
    const result = await runDoorTool(h, {
      universe: "NASDAQ100",
      strategyType: "Bull Put Credit Spread",
      maxLoss: 30,
      minProfit: 0.01,
    });
    expect(result.status).toBe("no_opportunities");
    expect(result.count).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.constraints.maxLoss).toBe(30);
  });

  it("defaults: NASDAQ100, all catalog strategies, the scan's standing caps", async () => {
    const h = makeHarness();
    await runDoorTool(h, {});
    const call = h.calls[0];
    expect(h.resolvedUniverses).toEqual(["NASDAQ100"]);
    expect(call.filters.request.allowedStrategies).toEqual(["all"]);
    expect(call.filters.request.maxPlannedLoss).toBe(500);
    expect(call.filters.request.minRewardRisk).toBe(1.5);
    expect(call.filters.request.minDte).toBe(14);
    expect(call.filters.request.maxDte).toBe(60);
  });
});

/* ------------------------------------------------------------------ */
/* The golden task: the reported request through the door              */
/* ------------------------------------------------------------------ */

describe("issue #2581 — golden task: the reported request through the door", () => {
  it("door-chat-options-strategy-screen passes through its real door path", async () => {
    const h = makeHarness();
    const executions: GoldenTaskExecution[] = [
      {
        task: goldenTask("door-chat-options-strategy-screen")!,
        drive: async () => {
          // The reported request, structured: NASDAQ100, bull put
          // credit spreads, max loss <= $30, max profit > $0
          // (a strictly positive profit floor, at cent granularity).
          const result = (await runDoorTool(h, {
            universe: "NASDAQ100",
            strategyType: "Bull Put Credit Spread",
            maxLoss: 30,
            minProfit: 0.01,
          })) as { status: string };
          const call = h.calls[0];
          return {
            outcome: result.status === "ranked_opportunities" || result.status === "no_opportunities" ? "completed" : "error",
            facts: {
              engineCalls: h.calls.length,
              maxPlannedLoss: call.filters.request.maxPlannedLoss,
              minMaxProfit: call.filters.strategyFilter.minMaxProfit,
              strategyTypes: (call.filters.request.allowedStrategies as string[]).join(","),
            },
          };
        },
      },
    ];
    const store = new InMemoryMeshEvalStore();
    const results = await executeGoldenTasks(executions, { store, runId: "mesh-eval:2581" });
    expect(results).toHaveLength(1);
    expect(results[0].passed, results[0].failures.join("; ")).toBe(true);
  });
});
