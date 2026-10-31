/**
 * Issue #2488 — Agentic mesh without NLQ: door-native chat screens
 * + NLQ flagged off in the turn.
 *
 * Owner direction (2026-10-30): "just build the entire solution
 * without NLQ. keep NLQ in the turn but don't use it... turn it
 * off with a flag. don't touch NLQ... put it behind a flag."
 * RCA: OpenAIMP/cfagent#2487 (no model-invoked turn tool reaches
 * the NLQ stock-screen port; S8/S18 acceptance drove the port
 * directly and missed it).
 *
 * Acceptance rule for THIS suite (the #2487 lesson): the screen
 * tests drive the path a model actually invokes — since #2496
 * that is the DISCOVERED turn tool (the Agents SDK MCP client's
 * tool_openaimp_run_stock_screen, discovered over the production
 * loopback carrier into the instance's real /mcp route) → the
 * openaimp handler's queue (capability mcp.tool, acting login +
 * traceparent stamped server-side) → the real executor entry
 * (executeMCPTool with the async-job executor's context shape) →
 * the run_stock_screen door command → the mesh screen door
 * service → ScreenerScreenWorkflow start. Before #2496 the first
 * leg was the McpAgentToolAdapter queue; the queue/executor/door
 * legs are unchanged. Fakes sit only at binding seams (the
 * WorkflowPort, the D1 job-history read, the instance SQL
 * storage, the paid-path seams) — the same seams the S8/S10/S18
 * harnesses fake, one level further out. No test calls the door
 * service as its primary drive.
 */
import { describe, expect, it, vi } from "vitest";
import { createTurnTools, type ChatTurnHelpersContext } from "../src/agents/orchestrator/chatTurnHelpers";
import {
  handleMcpChatNlqRoutes,
  type McpChatNlqRouteContext,
} from "../src/agents/routes/mcpChatNlq";
import {
  chatNlqTurnGate,
  OPENAIMP_MCP_TOOL_PREFIX,
} from "../src/agents/orchestrator/meshMcpClient";
import { makeDiscoveredPlatformTools } from "./mesh-mcp-testkit";
import { executeMCPTool } from "../src/mcps/openaimp";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_TOOL_SCOPES } from "../src/mcps/openaimp/mcpPermissionPorts";
import {
  CHAT_NLQ_MODE_SWITCH,
  resolveChatNlqMode,
} from "../src/config/chatNlqModes";
import { buildOrchestratorSystemPrompt } from "../src/agents/chatPrompt";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import type { MeshScreenDoorSeams } from "../src/agents/orchestrator/meshScreenDoor";
import {
  goldenTask,
  executeGoldenTasks,
  type GoldenTaskExecution,
} from "../src/services/meshGoldenTasks";
import { InMemoryMeshEvalStore } from "../src/data/inMemoryMeshEvalAdapter";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import { recordWorkflowTraceHop } from "../src/observability/meshTrace";
import { traceForMcp } from "../src/mcps/openaimp/agentDbReadCommands";
import { newTraceContext, formatTraceparent } from "../src/observability/observabilityPorts";
import type {
  ScreenerWorkflowDeps,
  ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import type {
  WorkflowJobCommand,
  WorkflowPort,
} from "../src/workflows/workflowPorts";
import type { AsyncJobSubmission, Env } from "../src/types";
import { MockSqlStorage } from "./mock-sql";

const LOGIN = "alice";

/* ------------------------------------------------------------------ */
/* Screen harness (S8/S18 binding-seam fakes)                          */
/* ------------------------------------------------------------------ */

function screenFullResult(universe: string) {
  return {
    timestamp: new Date().toISOString(),
    trigger: "manual",
    provider: "etrade",
    universe,
    sector: "Technology",
    success: true,
    totalScanned: 100,
    matchedCount: 2,
    opportunities: [
      { symbol: "NVDA", companyName: "NVIDIA", lastPrice: 190, changePercent: 2.1 },
      { symbol: "AMD", companyName: "AMD", lastPrice: 160, changePercent: 1.2 },
    ],
    allStocks: [
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, changePercent: 2.1, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, changePercent: 1.2, source: "etrade" },
    ],
    discoveryMessage: `Discovered listings for ${universe}`,
    filterSummary: "minPrice >= 10",
    rejections: [{ symbol: "XYZ", reason: "below min price" }],
    pdfKey: `screener/${universe}/report.pdf`,
    userLogin: LOGIN,
  };
}

interface ScreenHarness {
  sql: MockSqlStorage;
  shardStore: InMemoryShardJobAdapter;
  traceStore: InMemoryMeshTraceStore;
  startedCommands: WorkflowJobCommand[];
  traceId: string;
  traceparent: string;
  seams: MeshScreenDoorSeams;
  tenantRef: { tenantId: string };
}

function makeScreenHarness(opts: {
  workflowPort?: WorkflowPort | null;
} = {}): ScreenHarness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const traceStore = new InMemoryMeshTraceStore();
  const startedCommands: WorkflowJobCommand[] = [];
  const trace = newTraceContext();
  const traceparent = formatTraceparent(trace);
  const tenantRef = { tenantId: "" };

  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;

  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        const full = screenFullResult(req.universe ?? "TECH");
        const summary: ShardScreenResult = {
          success: full.success,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: full.totalScanned,
          expectedCount: full.totalScanned,
          matchedCount: full.matchedCount,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore,
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async () => {},
    nowMs: () => Date.now(),
    traceHop: (command, event) => recordWorkflowTraceHop(traceStore, command, event),
  };
  const adapter = new InMemoryWorkflowAdapter(deps);
  const recordingPort: WorkflowPort = {
    start: async (command) => {
      startedCommands.push(command);
      tenantRef.tenantId = command.tenantId ?? "";
      return adapter.start(command);
    },
    status: (workflowId) => adapter.status(workflowId),
  };

  const seams: MeshScreenDoorSeams = {
    ...(opts.workflowPort !== undefined
      ? { workflowPort: opts.workflowPort }
      : { workflowPort: recordingPort }),
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    traceStore,
  };
  return { sql, shardStore, traceStore, startedCommands, traceId: trace.traceId, traceparent, seams, tenantRef };
}

/* ------------------------------------------------------------------ */
/* The model-invoked path: turn tools → queue → executor → door        */
/* ------------------------------------------------------------------ */

interface TurnDrive {
  /** Think's merged composition: native getTools() set + the discovered set. */
  tools: Record<string, unknown>;
  submitted: AsyncJobSubmission[];
  audits: Array<{ type: string; agent: unknown; payload: Record<string, unknown> }>;
}

/**
 * Build the turn drive on the production composition (#2496): a
 * real SDK MCPClientManager discovers the catalog over the
 * production loopback carrier into the real /mcp route (whose
 * submitAsyncJob captures the queued jobs), and the turn's tool
 * set is Think's merge — the native createTurnTools set spread
 * with the manager's discovered set.
 */
async function makeTurnDrive(opts: {
  login?: string;
  traceparent?: string;
  env?: Record<string, unknown>;
  sql: MockSqlStorage;
}): Promise<TurnDrive> {
  const submitted: AsyncJobSubmission[] = [];
  const audits: TurnDrive["audits"] = [];
  const routeCtx: McpChatNlqRouteContext = {
    getOrm: () => ({}) as never,
    getStorageSql: () => opts.sql,
    getStorage: () => ({ sql: opts.sql }) as never,
    env: (opts.env ?? {}) as Env,
    audit: (type, agent, payload) => {
      audits.push({ type, agent, payload });
    },
    submitAsyncJob: async (job) => {
      submitted.push(job);
      return { jobId: "job-2488-1", status: "queued" as const, statusUrl: "/api/jobs/job-2488-1" };
    },
    getAsyncJob: () => undefined,
    listAsyncJobs: () => [],
    extractMessageText: () => "",
    getMessages: async () => [],
    recordMessage: () => {},
    runAgenticChatTurn: async () => {
      throw new Error("not used by the /mcp drive");
    },
    buildChatErrorFallback: async () => "",
    nlqSchedulingPort: () => ({}) as never,
  };
  const discovered = makeDiscoveredPlatformTools({
    dispatch: async (request) => {
      const url = new URL(request.url);
      const response = await handleMcpChatNlqRoutes(request, url, url.pathname, "session-2488", routeCtx);
      if (!response) throw new Error(`route did not handle ${url.pathname}`);
      return response;
    },
    resolveActingLogin: () => opts.login,
    resolveTraceparent: () => opts.traceparent,
    sql: opts.sql,
  });
  const ensured = await discovered.ensure();
  if (!ensured.ready) {
    throw new Error(`mesh discovery failed in the #2488 drive: ${ensured.error ?? "unknown"}`);
  }
  const ctx: ChatTurnHelpersContext = {
    env: (opts.env ?? {}) as Env,
    ensureTables: () => opts.sql as never,
    getOrm: () => ({}) as never,
    storage: { sql: opts.sql } as never,
    sessionKey: () => "session-2488",
    turnUserLogin: () => opts.login,
    turnTraceparent: () => opts.traceparent,
    audit: (type, agent, payload) => {
      audits.push({ type, agent, payload });
    },
    submitAsyncJob: async (job) => {
      submitted.push(job);
      return { jobId: "job-2488-1", status: "queued" as const, statusUrl: "/api/jobs/job-2488-1" };
    },
    getAsyncJob: () => undefined,
    listAsyncJobs: () => [],
    getMessages: async () => [],
    activeTurnMetadata: null,
  };
  const tools = {
    ...(createTurnTools(ctx, "req-2488") as Record<string, unknown>),
    ...discovered.aiTools(),
  };
  return { tools, submitted, audits };
}

/**
 * Queue one tool call through the turn's tool set — since #2496
 * the DISCOVERED tool under its tool_openaimp_<name> key — then
 * execute the queued job through the REAL executor entry with
 * the async-job executor's context shape (asyncJobs.ts mcp.tool
 * branch: system principal, acting identity + traceparent
 * re-supplied from the job payload, the instance's storage).
 */
async function driveTurnToolToExecution(
  drive: TurnDrive,
  toolName: string,
  args: Record<string, unknown>,
  exec: { sql: MockSqlStorage; seams?: MeshScreenDoorSeams; env?: Record<string, unknown> },
): Promise<unknown> {
  const key = `${OPENAIMP_MCP_TOOL_PREFIX}${toolName}`;
  const tool = (drive.tools as Record<string, { execute?: (input: never, opts: never) => Promise<unknown> }>)[key];
  expect(tool, `turn tool ${key}`).toBeDefined();
  await tool.execute!(args as never, { toolCallId: "call-2488", messages: [] } as never);
  expect(drive.submitted).toHaveLength(1);
  const job = drive.submitted[0];
  expect(job.capability).toBe("mcp.tool");
  const payload = job.payload as {
    toolName: string;
    arguments: Record<string, unknown>;
    actingLogin?: string;
    traceparent?: string;
  };
  expect(payload.toolName).toBe(toolName);
  const context = {
    env: (exec.env ?? {}) as Env,
    orm: {} as never,
    sessionId: "session-2488",
    audit: () => {},
    principal: { kind: "system", login: null },
    actingLogin: () =>
      typeof payload.actingLogin === "string" ? payload.actingLogin : undefined,
    traceparent: () =>
      typeof payload.traceparent === "string" ? payload.traceparent : undefined,
    storage: { sql: exec.sql } as never,
    ...(exec.seams ? { meshScreenDoorSeams: exec.seams } : {}),
  };
  return executeMCPTool(payload.toolName, payload.arguments, context as never);
}

/* ------------------------------------------------------------------ */
/* The flag: CHAT_NLQ_MODE gates the turn's NLQ tool                   */
/* ------------------------------------------------------------------ */

describe("issue #2488 — CHAT_NLQ_MODE switch resolution", () => {
  it("defaults OFF (built-in), resolves env/scoped levels in order, fails closed on invalid", () => {
    expect(resolveChatNlqMode({}).mode).toBe("off");
    expect(resolveChatNlqMode({ env: "on" }).mode).toBe("on");
    expect(resolveChatNlqMode({ env: " ON " }).mode).toBe("on");
    expect(resolveChatNlqMode({ env: "off", user: "on" }).mode).toBe("on");
    expect(resolveChatNlqMode({ env: "on", session: "off" }).mode).toBe("off");
    const invalid = resolveChatNlqMode({ env: "banana" });
    expect(invalid.mode).toBe("off");
    expect(invalid.invalid).toBe(true);
    expect(CHAT_NLQ_MODE_SWITCH).toBe("CHAT_NLQ_MODE");
  });

  // Since #2496 the flag's mechanism is the turn gate
  // (chatNlqTurnGate over Think's activeTools): the discovered
  // set always carries execute_nlq — the flag decides whether the
  // MODEL may call it. The native tool set never carries it.
  it("excludes execute_nlq from the turn's usable set by default (the #2496 gate) — the tool stays in the catalog", async () => {
    const drive = await makeTurnDrive({ login: LOGIN, sql: new MockSqlStorage() });
    // Discovered and wired — just not callable by the model.
    expect(drive.tools["tool_openaimp_execute_nlq"]).toBeDefined();
    expect(McpToolFactory.getTool("execute_nlq")).toBeDefined();
    const gate = chatNlqTurnGate({
      toolNames: Object.keys(drive.tools),
      context: { env: {} as Env },
      audit: () => {},
    });
    expect(gate.activeTools).toBeDefined();
    expect(gate.activeTools).not.toContain("tool_openaimp_execute_nlq");
    expect(gate.activeTools).toContain("tool_openaimp_run_stock_screen");
  });

  it("offers execute_nlq to the turn when the switch is on (env or scoped carrier)", () => {
    const toolNames = ["tool_openaimp_execute_nlq", "tool_openaimp_run_stock_screen"];
    const viaEnv = chatNlqTurnGate({
      toolNames,
      context: { env: { CHAT_NLQ_MODE: "on" } as Env },
      audit: () => {},
    });
    expect(viaEnv.activeTools).toBeUndefined();
    const viaCarrier = chatNlqTurnGate({
      toolNames,
      context: { env: {} as Env, scopedChatNlqModes: { user: "on" } },
      audit: () => {},
    });
    expect(viaCarrier.activeTools).toBeUndefined();
  });

  it("fails closed + audits chat_nlq.config_error on an invalid switch value", () => {
    const audits: Array<{ type: string }> = [];
    const gate = chatNlqTurnGate({
      toolNames: ["tool_openaimp_execute_nlq", "tool_openaimp_run_stock_screen"],
      context: { env: { CHAT_NLQ_MODE: "banana" } as Env },
      audit: (type: string) => {
        audits.push({ type });
      },
    });
    expect(gate.activeTools).not.toContain("tool_openaimp_execute_nlq");
    expect(audits.map((a) => a.type)).toContain("chat_nlq.config_error");
  });
});

/* ------------------------------------------------------------------ */
/* Catalog + scope pins                                                */
/* ------------------------------------------------------------------ */

describe("issue #2488 — run_stock_screen catalog registration", () => {
  it("is registered in the factory with the mcp:write scope", () => {
    expect(McpToolFactory.getTool("run_stock_screen")).toBeDefined();
    expect(MCP_TOOL_SCOPES.run_stock_screen).toBe("mcp:write");
    expect(McpToolFactory.getAllTools()).toHaveLength(82);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance: the model-invoked path, free screen                     */
/* ------------------------------------------------------------------ */

describe("issue #2488 — chat screen through the turn tool path (free path)", () => {
  it("queues as mcp.tool with server-stamped identity, executes through the executor, starts the workflow, returns the read-back", async () => {
    const h = makeScreenHarness();
    const drive = await makeTurnDrive({ login: LOGIN, traceparent: h.traceparent, sql: h.sql });
    const result = (await driveTurnToolToExecution(
      drive,
      "run_stock_screen",
      { universe: "NASDAQ100", filters: { minPrice: 10 } },
      { sql: h.sql, seams: h.seams },
    )) as {
      success: boolean;
      universe: string;
      matchedCount: number;
      allStocks: Array<{ symbol: string }>;
      pdfKey?: string;
    };

    // The queue stamp: identity + trace resolved server-side at
    // queue time, never from tool arguments.
    const payload = drive.submitted[0].payload as { actingLogin?: string; traceparent?: string };
    expect(payload.actingLogin).toBe(LOGIN);
    expect(payload.traceparent).toBe(h.traceparent);

    // Exactly one workflow start, carrying the door's command
    // shape (the S8 parity shape under the door's own source).
    expect(h.startedCommands).toHaveLength(1);
    const command = h.startedCommands[0];
    expect(command.type).toBe("run-screen");
    expect(command.role).toBe("parent");
    expect(command.source).toBe("mesh-door");
    expect(command.userLogin).toBe(LOGIN);
    expect(command.maxItems).toBe(10);
    expect(command.jobId.startsWith("screener:chat:NASDAQ100:")).toBe(true);
    expect(command.shards).toEqual([{ shardId: "NASDAQ100", universe: "NASDAQ100" }]);
    expect(command.filters).toMatchObject({ universe: "NASDAQ100", minPrice: 10 });
    expect(command.traceparent).toBe(h.traceparent);

    // The result is the workflow run's stored read-back.
    expect(result.success).toBe(true);
    expect(result.universe).toBe("NASDAQ100");
    expect(result.matchedCount).toBe(2);
    expect(result.allStocks.map((s) => s.symbol)).toEqual(["NVDA", "AMD"]);
    expect(result.pdfKey).toBe("screener/NASDAQ100/report.pdf");

    // The S17 start hop was recorded by the door service on the
    // turn's trace.
    const hops = await h.traceStore.hopsFor(h.traceId);
    const startHop = hops.find((hop) => hop.kind === "workflow-start");
    expect(startHop?.operation).toBe("screener.start");
    expect(startHop?.agent).toBe("ScreenerScreenWorkflow");
    expect(startHop?.caller).toBe(LOGIN);
  });

  it("defaults the universe to NASDAQ100 (the route default) when the model omits it", async () => {
    const h = makeScreenHarness();
    const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
    const result = (await driveTurnToolToExecution(drive, "run_stock_screen", {}, { sql: h.sql, seams: h.seams })) as {
      success: boolean;
      universe: string;
    };
    expect(result.success).toBe(true);
    expect(result.universe).toBe("NASDAQ100");
    expect(h.startedCommands[0].jobId.startsWith("screener:chat:NASDAQ100:")).toBe(true);
  });

  it("refuses with mesh_mcp_identity_required and zero starts when the turn carries no acting identity", async () => {
    const h = makeScreenHarness();
    const drive = await makeTurnDrive({ login: undefined, sql: h.sql });
    // #2496: the refusal moved one leg earlier — the SDK loopback
    // carrier refuses the call before anything queues (the
    // execution-layer identity_required refusal still stands
    // behind it, pinned in the #2496 suite and by the synthetic
    // identity test below).
    await expect(
      driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams }),
    ).rejects.toThrow(/mesh_mcp_identity_required/);
    expect(drive.submitted).toHaveLength(0);
    expect(h.startedCommands).toHaveLength(0);
  });

  it("refuses the retired synthetic identity exactly like a missing one", async () => {
    const h = makeScreenHarness();
    const drive = await makeTurnDrive({ login: "default", sql: h.sql });
    await expect(
      driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams }),
    ).rejects.toMatchObject({ code: "identity_required" });
    expect(h.startedCommands).toHaveLength(0);
  });

  it("fails with door_unavailable when the workflow port is unavailable — no direct-agent fallback exists", async () => {
    const h = makeScreenHarness({ workflowPort: null });
    const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
    await expect(
      driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams }),
    ).rejects.toMatchObject({ code: "door_unavailable" });
    expect(h.startedCommands).toHaveLength(0);
  });

  it("fails with door_unavailable when the workflow start throws — never a second, direct run", async () => {
    const throwingPort: WorkflowPort = {
      start: async () => {
        throw new Error("binding exploded");
      },
      status: async () => null,
    };
    const h = makeScreenHarness({ workflowPort: throwingPort });
    const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
    await expect(
      driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams }),
    ).rejects.toMatchObject({ code: "door_unavailable" });
  });

  it("fails with door_unavailable on the production context shape (no seams, unbound env)", async () => {
    const h = makeScreenHarness();
    const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
    await expect(
      driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql }),
    ).rejects.toMatchObject({ code: "door_unavailable" });
    expect(h.startedCommands).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Paid harness (S10/S18 shape: the real payment flow, binding-seam   */
/* fakes)                                                              */
/* ------------------------------------------------------------------ */

import {
  runPaymentWorkflowFlow,
  type PaymentWorkflowDeps,
  type PaymentWorkflowOutcome,
  type PaymentWorkflowStep,
} from "../src/workflows/paymentWorkflowFlow";
import type { PaymentWorkflowEventParams } from "../src/workflows/paymentWorkflow";
import { NativeMonetizationGate } from "../src/services/nativeMonetization";
import type { CheckoutPorts } from "../src/services/checkoutPorts";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { PaidScreenStorePorts } from "../src/services/paidScreenSubmission";
import { workflowTenantId } from "../src/workflows/screenerWorkflowRoutes";

const PAID_EMAIL = "alice@example.com";
const STOCK_PRICE_USD = 0.02;
const PAID_TENANT = workflowTenantId({} as Env);

interface PaidHarness {
  sql: MockSqlStorage;
  seams: MeshScreenDoorSeams;
  screenerStarts: WorkflowJobCommand[];
  budgetCalls: Array<{ operation: string; amountCents: number }>;
  paymentCreates: Array<{ id: string; params: PaymentWorkflowEventParams }>;
  coverageConsumed: Array<{ userId: string; paidVia: string; priceUSD: number }>;
}

function makePaidHarness(opts: { budgetVerdict?: { allowed: boolean; reason?: string } } = {}): PaidHarness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const screenerStarts: WorkflowJobCommand[] = [];
  const budgetCalls: PaidHarness["budgetCalls"] = [];
  const paymentCreates: PaidHarness["paymentCreates"] = [];
  const coverageConsumed: PaidHarness["coverageConsumed"] = [];

  const reportCtx = {
    env: {},
    ensureTables: () => sql,
  } as unknown as ReportDispatchContext;
  const deps: ScreenerWorkflowDeps = {
    screenRunner: {
      runScreen: async (req) => {
        const full = screenFullResult(req.universe ?? "TECH");
        const summary: ShardScreenResult = {
          success: full.success,
          timestamp: full.timestamp,
          universe: full.universe,
          totalScanned: full.totalScanned,
          expectedCount: full.totalScanned,
          matchedCount: full.matchedCount,
          pdfKey: full.pdfKey,
          trigger: "manual",
          full,
        };
        return summary;
      },
    },
    shardStore,
    storeReport: async (payload) => {
      await persistScreenerReportCanonical(
        reportCtx,
        payload as Parameters<typeof persistScreenerReportCanonical>[1],
      );
    },
    deliverOutcome: async () => {},
    nowMs: () => Date.now(),
  };
  const screenerAdapter = new InMemoryWorkflowAdapter(deps);
  const recordingScreenerPort: WorkflowPort = {
    start: async (command) => {
      screenerStarts.push(command);
      return screenerAdapter.start(command);
    },
    status: (workflowId) => screenerAdapter.status(workflowId),
  };

  const gateCheckoutPorts: CheckoutPorts | null = null;
  const instances = new Map<string, { status: string; output?: PaymentWorkflowOutcome }>();
  const runRealPaymentFlow = async (params: PaymentWorkflowEventParams): Promise<PaymentWorkflowOutcome> => {
    const gate = new NativeMonetizationGate({
      monetizationEnabled: true,
      priceCatalogue: {
        getPrice: async (family: string) => (family === "stock" ? STOCK_PRICE_USD : null),
      },
      checkout: gateCheckoutPorts,
    });
    const step: PaymentWorkflowStep = {
      do: async (_name, fn) => fn(),
      waitForEvent: async (name) => {
        if (name === "await-payment-approval") return { payload: { approved: true, approverId: LOGIN } };
        if (name === "await-payment-verified") return { payload: { sessionId: "cs_test_2488" } };
        throw new Error(`unexpected waitForEvent: ${name}`);
      },
    };
    const flowDeps: PaymentWorkflowDeps = {
      gate,
      account: params.account,
      startScreener: async () => {
        const handle = await recordingScreenerPort.start(params.screenerCommand);
        return { workflowId: handle.workflowId };
      },
      recordEvent: async () => {},
      issueFailureCredit: async () => {},
      consumeCoverage: async (use) => {
        coverageConsumed.push(use);
      },
    };
    const { account: _account, screenerCommand: _cmd, ...flowParams } = params;
    return runPaymentWorkflowFlow(flowParams, flowDeps, step);
  };

  const paymentBinding = {
    create: async ({ id, params }: { id: string; params: PaymentWorkflowEventParams }) => {
      paymentCreates.push({ id, params: { ...params, account: { ...params.account } } });
      const inst: { status: string; output?: PaymentWorkflowOutcome } = { status: "running" };
      instances.set(id, inst);
      void runRealPaymentFlow(params).then(
        (outcome) => {
          inst.output = outcome;
          inst.status = "complete";
        },
        () => {
          inst.status = "errored";
        },
      );
      return { id };
    },
    get: async (_id: string) => ({ sendEvent: async () => {} }),
  };

  const commercial = {
    getAccount: async (userId: string) => ({
      id: userId,
      tenantId: PAID_TENANT,
      tier: "Subscribed" as const,
      tierSource: "operator" as const,
      creditsUSD: 0,
      includedRuns: 1,
      updatedAtMs: Date.now(),
    }),
  } as unknown as CommercialStore;
  const subscriptions = {
    listSubscriptions: async () => [],
  } as unknown as SubscriptionStore;
  const stores: PaidScreenStorePorts = { commercial, subscriptions };

  const seams: MeshScreenDoorSeams = {
    workflowPort: recordingScreenerPort,
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    monetizationOn: async () => true,
    paidScreenPriceUSD: async () => STOCK_PRICE_USD,
    paidBudgetCheck: async (_actingLogin, input) => {
      budgetCalls.push(input);
      return opts.budgetVerdict ?? { allowed: true };
    },
    checkoutEmail: () => PAID_EMAIL,
    paidScreenStores: stores,
    paymentWorkflowBinding: paymentBinding as never,
    paymentWorkflowStatus: async (workflowId) => {
      const inst = instances.get(workflowId);
      if (!inst) return null;
      return {
        status: inst.status,
        ...(inst.output ? { output: inst.output } : {}),
      };
    },
  };
  return { sql, seams, screenerStarts, budgetCalls, paymentCreates, coverageConsumed };
}

describe("issue #2488 — chat paid screen through the turn tool path (monetization on)", () => {
  it("budget check first, one PaymentWorkflow start, screener started by the payment flow, read-back returned", async () => {
    const h = makePaidHarness();
    const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
    const result = (await driveTurnToolToExecution(
      drive,
      "run_stock_screen",
      { universe: "NASDAQ100" },
      { sql: h.sql, seams: h.seams },
    )) as { success: boolean; matchedCount: number };

    expect(h.budgetCalls).toEqual([{ operation: "nlq.execute", amountCents: 2 }]);
    expect(h.paymentCreates).toHaveLength(1);
    expect(h.screenerStarts).toHaveLength(1);
    expect(h.coverageConsumed).toHaveLength(1);
    // One charge per run-request: the payment run id IS the
    // screener job id.
    expect(h.paymentCreates[0].id).toContain(h.screenerStarts[0].jobId);
    expect(result.success).toBe(true);
    expect(result.matchedCount).toBe(2);
  });

  it("a budget denial refuses before any start — zero payment starts, zero screener starts, no free fallback", async () => {
    const h = makePaidHarness({ budgetVerdict: { allowed: false, reason: "daily cap exceeded" } });
    const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
    await expect(
      driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams }),
    ).rejects.toMatchObject({ code: "budget_denied" });
    expect(h.budgetCalls).toHaveLength(1);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.screenerStarts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Prompt steering pins                                                */
/* ------------------------------------------------------------------ */

describe("issue #2488 — prompt steering", () => {
  const prompt = buildOrchestratorSystemPrompt({
    route: { agent: "orchestrator", confidence: 1, reason: "test" },
    memoryContext: "",
    vectorContext: "",
    optionsResearchContext: "",
    isAutoOptionsResearchRequest: false,
  });

  it("steers universe screens to run_stock_screen and describes etrade_market_scan as the listings filter scan", () => {
    // #2496: steering names the DISCOVERED tool keys the model
    // actually sees (tool_openaimp_<catalog name>).
    expect(prompt).toContain("'tool_openaimp_run_stock_screen'");
    expect(prompt).not.toContain("'run_stock_screen'");
    expect(prompt).toContain("listings");
    // The pre-#2488 steering sentence is gone: screens are no
    // longer routed to the listings scan.
    expect(prompt).not.toContain("invoke 'etrade_market_scan' or 'etrade_get_quote'");
    expect(prompt).not.toContain("When user asks to scan, screen, quote, or trade stocks, invoke 'etrade_market_scan'");
  });
});

/* ------------------------------------------------------------------ */
/* Golden door tasks (S18 harness, door surface)                       */
/* ------------------------------------------------------------------ */

function refusalCodeOf(err: unknown): string {
  if (err instanceof MeshDoorError) return err.code;
  // #2496: an unidentified turn's discovered call is refused at
  // the SDK loopback carrier before it queues; the refusal token
  // rides the MCP error's message.
  if (err instanceof Error && err.message.includes("mesh_mcp_identity_required")) {
    return "mesh_mcp_identity_required";
  }
  return "unexpected_error";
}

describe("issue #2488 — golden tasks for the door surface", () => {
  it("all four door tasks pass through the real turn → queue → executor path and record", async () => {
    // The screen-run execution's trace assembly needs its
    // drive's harness, so that harness is built in scope here
    // (the S18 screenExecution pattern).
    const h = makeScreenHarness();
    const executions: GoldenTaskExecution[] = [
      {
        task: goldenTask("door-chat-screen-run")!,
        drive: async () => {
          const drive = await makeTurnDrive({ login: LOGIN, traceparent: h.traceparent, sql: h.sql });
          const result = (await driveTurnToolToExecution(
            drive,
            "run_stock_screen",
            { universe: "NASDAQ100", filters: { minPrice: 10 } },
            { sql: h.sql, seams: h.seams },
          )) as { success: boolean; matchedCount: number };
          return {
            outcome: result.success ? ("completed" as const) : ("error" as const),
            traceId: h.traceId,
            facts: {
              workflowStarts: h.startedCommands.length,
              matchedCount: result.matchedCount ?? -1,
            },
          };
        },
        assembleTrace: async (traceId) => {
          const assembled = await traceForMcp({}, traceId, {
            tenantId: h.tenantRef.tenantId,
            readHops: (id) => h.traceStore.hopsFor(id),
            readJobs: (tenantId, chainId) => h.shardStore.listJobsForChain(tenantId, chainId),
          });
          return {
            kinds: assembled.hops.map((hop) => hop.kind),
            complete: assembled.complete,
          };
        },
      },
    ];
    executions.push(
      {
        task: goldenTask("door-chat-screen-identity-refusal")!,
        drive: async () => {
          const h = makeScreenHarness();
          const drive = await makeTurnDrive({ login: undefined, sql: h.sql });
          try {
            await driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams });
            return { outcome: "error" as const, facts: {}, detail: "door did not refuse" };
          } catch (err) {
            return {
              outcome: "refused" as const,
              refusalCode: refusalCodeOf(err),
              facts: { workflowStarts: h.startedCommands.length },
            };
          }
        },
      },
      {
        task: goldenTask("door-chat-paid-screen")!,
        drive: async () => {
          const h = makePaidHarness();
          const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
          const result = (await driveTurnToolToExecution(
            drive,
            "run_stock_screen",
            { universe: "NASDAQ100" },
            { sql: h.sql, seams: h.seams },
          )) as { success: boolean };
          return {
            outcome: result.success ? ("completed" as const) : ("error" as const),
            facts: {
              budgetChecks: h.budgetCalls.length,
              paymentStarts: h.paymentCreates.length,
              screenerStarts: h.screenerStarts.length,
              coverageConsumed: h.coverageConsumed.length,
            },
          };
        },
      },
      {
        task: goldenTask("door-chat-paid-budget-refusal")!,
        drive: async () => {
          const h = makePaidHarness({ budgetVerdict: { allowed: false, reason: "daily cap exceeded" } });
          const drive = await makeTurnDrive({ login: LOGIN, sql: h.sql });
          try {
            await driveTurnToolToExecution(drive, "run_stock_screen", { universe: "NASDAQ100" }, { sql: h.sql, seams: h.seams });
            return { outcome: "error" as const, facts: {}, detail: "door did not refuse" };
          } catch (err) {
            return {
              outcome: "refused" as const,
              refusalCode: refusalCodeOf(err),
              facts: {
                budgetChecks: h.budgetCalls.length,
                paymentStarts: h.paymentCreates.length,
                screenerStarts: h.screenerStarts.length,
              },
            };
          }
        },
      },
    );

    const store = new InMemoryMeshEvalStore();
    const results = await executeGoldenTasks(executions, { store, runId: "mesh-eval:2488-test" });
    for (const result of results) {
      expect(result.failures, `${result.taskId}: ${result.failures.join("; ")}`).toEqual([]);
      expect(result.passed, result.taskId).toBe(true);
    }
    const recorded = await store.resultsForRun("mesh-eval:2488-test");
    expect(recorded.map((r) => r.taskId).sort()).toEqual([
      "door-chat-paid-budget-refusal",
      "door-chat-paid-screen",
      "door-chat-screen-identity-refusal",
      "door-chat-screen-run",
    ]);
  });
});
