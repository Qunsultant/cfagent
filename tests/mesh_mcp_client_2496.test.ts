/**
 * Issue #2496 — Mesh improvement S1 REWORKED to the SDK-provided
 * MCP client path (programme OpenAIMP/cfagent#2494): the chat turn
 * consumes the platform's own openaimp MCP server the way Think /
 * the Agents SDK provides — the instance registers the server on
 * its SDK MCP client manager, and Think auto-merges the discovered
 * set into the turn under the SDK's namespaced keys
 * (tool_openaimp_<name>). An earlier build of this slice merged
 * getAITools() by hand under canonical names with
 * includeMcpTools=false; the owner rejected that exoskeleton and
 * this suite pins the provided path instead.
 *
 * Acceptance rule (programme rule 2, the #2487 lesson): these tests
 * exercise the REAL surface end to end —
 *
 *   turn tool composition (Think's merge shape: getTools() native
 *     set spread with the manager's discovered set)
 *     <- the SDK MCPClientManager's discovered set (getAITools)
 *     <- the SDK StreamableHTTP transport over the production
 *        loopback identity carrier (createOpenaimpMcpFetch)
 *     -> the instance's real /mcp route (handleMcpChatNlqRoutes)
 *     -> the real SDK MCP handler (src/mcps/openaimp/handler),
 *        which queues the call with server-side identity stamps
 *     -> the real executor entry (executeMCPTool, async-job shape)
 *     -> the run_stock_screen door command -> ScreenerScreenWorkflow.
 *
 * Fakes sit only at binding seams: the manager's DO storage (the
 * Lifecycle services' storage binding), the workflow binding /
 * screen runner, the D1 job-history read, the instance SQL storage —
 * the same seams the #2488 harness fakes. No test builds the turn's
 * catalog tool set by hand: every catalog tool in the turn arrives
 * through protocol discovery.
 */
import { describe, expect, it } from "vitest";
import { MCPClientManager } from "agents/mcp/client";
import { MockSqlStorage } from "./mock-sql";
import {
  createOpenaimpMcpFetch,
  ensureOpenaimpMcpConnection,
  chatNlqTurnGate,
  OPENAIMP_MCP_SERVER_ID,
  OPENAIMP_MCP_TOOL_PREFIX,
} from "../src/agents/orchestrator/meshMcpClient";
import {
  handleMcpChatNlqRoutes,
  type McpChatNlqRouteContext,
} from "../src/agents/routes/mcpChatNlq";
import {
  createTurnTools,
  type ChatTurnHelpersContext,
} from "../src/agents/orchestrator/chatTurnHelpers";
import { executeMCPTool, MCP_TOOLS } from "../src/mcps/openaimp";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { meshTraceStoreForEnv } from "../src/data/createMeshTracePorts";
import {
  persistScreenerReportCanonical,
  type ReportDispatchContext,
} from "../src/agents/orchestrator/reportDispatch";
import { InMemoryWorkflowAdapter } from "../src/workflows/inMemoryWorkflowAdapter";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { InMemoryMeshTraceStore } from "../src/data/inMemoryMeshTraceAdapter";
import { recordWorkflowTraceHop } from "../src/observability/meshTrace";
import { newTraceContext, formatTraceparent } from "../src/observability/observabilityPorts";
import type { MeshScreenDoorSeams } from "../src/agents/orchestrator/meshScreenDoor";
import type {
  ScreenerWorkflowDeps,
  ShardScreenResult,
} from "../src/workflows/screenerWorkflowFlow";
import type {
  WorkflowJobCommand,
  WorkflowPort,
} from "../src/workflows/workflowPorts";
import type { AsyncJobRecord, AsyncJobSubmission, Env } from "../src/types";

const LOGIN = "alice";

/* ------------------------------------------------------------------ */
/* Screen harness (binding-seam fakes, the #2488 seam shape)          */
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
      { symbol: "NVDA", companyName: "NVIDIA", sector: "Technology", lastPrice: 190, source: "etrade" },
      { symbol: "AMD", companyName: "AMD", sector: "Technology", lastPrice: 160, source: "etrade" },
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
  traceStore: InMemoryMeshTraceStore;
  startedCommands: WorkflowJobCommand[];
  traceparent: string;
  traceId: string;
  seams: MeshScreenDoorSeams;
}

function makeScreenHarness(): ScreenHarness {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const traceStore = new InMemoryMeshTraceStore();
  const startedCommands: WorkflowJobCommand[] = [];
  const trace = newTraceContext();
  const traceparent = formatTraceparent(trace);

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
      return adapter.start(command);
    },
    status: (workflowId) => adapter.status(workflowId),
  };
  const seams: MeshScreenDoorSeams = {
    workflowPort: recordingPort,
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    traceStore,
  };
  return { sql, traceStore, startedCommands, traceparent, traceId: trace.traceId, seams };
}

/* ------------------------------------------------------------------ */
/* The discovered-turn drive                                           */
/* ------------------------------------------------------------------ */

interface MeshDrive {
  manager: MCPClientManager;
  routeCtx: McpChatNlqRouteContext;
  /** The route/handler env object (its in-memory trace store is assertable). */
  routeEnv: Record<string, unknown>;
  /** Jobs captured at the /mcp route's queue point (post-stamp). */
  submitted: AsyncJobSubmission[];
  audits: Array<{ type: string; agent: unknown; payload: Record<string, unknown> }>;
  /** JSON-RPC methods that actually reached the route (carrier log). */
  dispatchedMethods: string[];
  /** Mutable turn stash — mirrors OrchestratorAgent.pendingTurn. */
  turn: { login?: string; traceparent?: string };
  jobStore: Map<string, AsyncJobRecord>;
  ensure: () => Promise<{ ready: boolean; toolCount: number; reused: boolean }>;
  /** The turn's native tool set (Think's getTools() contribution). */
  nativeTools: (env?: Record<string, unknown>) => ReturnType<typeof createTurnTools>;
  /**
   * The turn's merged tool set in Think's own composition order
   * (@cloudflare/think _prepareInferenceInvocation: baseTools from
   * getTools() spread first, then this.mcp.getAITools()).
   */
  mergedTools: (env?: Record<string, unknown>) => Record<string, unknown>;
  /** The CHAT_NLQ_MODE gate over a merged tool-name list (portBeforeTurn's call). */
  nlqGate: (toolNames: readonly string[], env?: Record<string, unknown>) => { activeTools?: string[] };
}

/**
 * Build the production composition with binding-seam fakes:
 * a real MCPClientManager whose Lifecycle storage binding is the
 * in-memory DO storage seam, the production loopback carrier
 * dispatching into the real /mcp route handler, and Think's merge
 * composition fed by the manager's discovered set.
 */
function makeMeshDrive(opts: { sql?: MockSqlStorage } = {}): MeshDrive {
  const sql = opts.sql ?? new MockSqlStorage();
  const submitted: AsyncJobSubmission[] = [];
  const audits: MeshDrive["audits"] = [];
  const dispatchedMethods: string[] = [];
  const jobStore = new Map<string, AsyncJobRecord>();
  const turn: MeshDrive["turn"] = {};
  const routeEnv: Record<string, unknown> = {};

  const kv = new Map<string, unknown>();
  const manager = new MCPClientManager("OrchestratorAgent", "0.0.1", {
    env: {} as Env,
  });
  // Binding seam: the Lifecycle services object the Agent installs
  // via Lifecycle.use() in production. The manager reads only
  // `lifecycle.storage` (sql + kv) — supplied here from the
  // in-memory DO storage fakes.
  Object.defineProperty(manager, "lifecycle", {
    value: {
      storage: {
        sql,
        get: async (key: string) => kv.get(key),
        put: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => kv.delete(key),
        list: async () => new Map(kv),
      },
    },
  });

  const routeCtx: McpChatNlqRouteContext = {
    getOrm: () => ({}) as never,
    getStorageSql: () => sql,
    getStorage: () => ({ sql }) as never,
    env: routeEnv as Env,
    audit: (type, agent, payload) => {
      audits.push({ type, agent, payload });
    },
    submitAsyncJob: async (job) => {
      submitted.push(job);
      return { jobId: "job-2496-1", status: "queued" as const, statusUrl: "/api/jobs/job-2496-1" };
    },
    getAsyncJob: (jobId) => jobStore.get(jobId),
    listAsyncJobs: () => [...jobStore.values()],
    extractMessageText: () => "",
    getMessages: async () => [],
    recordMessage: () => {},
    runAgenticChatTurn: async () => {
      throw new Error("not used by the /mcp drive");
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
      /* notifications / empty bodies carry no method to log */
    }
    const response = await handleMcpChatNlqRoutes(
      request,
      url,
      url.pathname,
      "session-2496",
      routeCtx,
    );
    if (!response) throw new Error(`route did not handle ${url.pathname}`);
    return response;
  };

  const loopbackFetch = createOpenaimpMcpFetch({
    dispatch,
    resolveActingLogin: () => turn.login,
    resolveTraceparent: () => turn.traceparent,
  });

  const ensure = () =>
    ensureOpenaimpMcpConnection({
      mcp: manager,
      fetch: loopbackFetch,
      audit: (type, payload) => {
        audits.push({ type, agent: "orchestrator", payload });
      },
    });

  const nativeTools = (env: Record<string, unknown> = {}) => {
    const helpersCtx: ChatTurnHelpersContext = {
      env: env as Env,
      ensureTables: () => sql as never,
      getOrm: () => ({}) as never,
      storage: { sql } as never,
      sessionKey: () => "session-2496",
      turnUserLogin: () => turn.login,
      turnTraceparent: () => turn.traceparent,
      audit: (type, agent, payload) => {
        audits.push({ type, agent, payload });
      },
      submitAsyncJob: async () => {
        throw new Error("native turn tools do not queue in this drive");
      },
      getAsyncJob: () => undefined,
      listAsyncJobs: () => [],
      getMessages: async () => [],
      activeTurnMetadata: null,
    };
    return createTurnTools(helpersCtx, "req-2496");
  };

  const mergedTools = (env: Record<string, unknown> = {}) => ({
    ...(nativeTools(env) as Record<string, unknown>),
    ...(manager.getAITools() as Record<string, unknown>),
  });

  const nlqGate = (toolNames: readonly string[], env: Record<string, unknown> = {}) =>
    chatNlqTurnGate({
      toolNames,
      context: { env },
      audit: (type, payload) => {
        audits.push({ type, agent: "orchestrator", payload });
      },
    });

  return {
    manager,
    routeCtx,
    routeEnv,
    submitted,
    audits,
    dispatchedMethods,
    turn,
    jobStore,
    ensure,
    nativeTools,
    mergedTools,
    nlqGate,
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

/**
 * Execute the captured queued job through the REAL executor entry
 * with the async-job executor's context shape (asyncJobs.ts
 * mcp.tool branch: system principal, acting identity + traceparent
 * re-supplied from the job payload, the instance's storage) — the
 * same drive the #2488 harness performs, one surface further out.
 */
async function executeCapturedJob(
  drive: MeshDrive,
  exec: { sql: MockSqlStorage; seams?: MeshScreenDoorSeams },
): Promise<unknown> {
  expect(drive.submitted).toHaveLength(1);
  const job = drive.submitted[0];
  expect(job.capability).toBe("mcp.tool");
  const payload = job.payload as {
    toolName: string;
    arguments: Record<string, unknown>;
    actingLogin?: string;
    traceparent?: string;
  };
  const context = {
    env: {} as Env,
    orm: {} as never,
    sessionId: "session-2496",
    audit: () => {},
    principal: { kind: "system", login: null },
    actingLogin: () =>
      typeof payload.actingLogin === "string" ? payload.actingLogin : undefined,
    traceparent: () =>
      typeof payload.traceparent === "string" ? payload.traceparent : undefined,
    storage: { sql: exec.sql } as never,
    ...(exec.seams ? { meshScreenDoorSeams: exec.seams } : {}),
  };
  const result = await executeMCPTool(payload.toolName, payload.arguments, context as never);
  drive.jobStore.set("job-2496-1", {
    jobId: "job-2496-1",
    sessionId: "session-2496",
    capability: "mcp.tool",
    label: payload.toolName,
    status: "completed",
    jobKind: "main",
    result,
  } as AsyncJobRecord);
  return result;
}

/* ------------------------------------------------------------------ */
/* Discovery: the turn's catalog arrives over the protocol             */
/* ------------------------------------------------------------------ */

describe("issue #2496 — SDK MCP client discovery feeds the turn", () => {
  it("discovers the full openaimp catalog from the live server (tools/list over the protocol)", async () => {
    const drive = makeMeshDrive();
    const ensured = await drive.ensure();
    expect(ensured.ready).toBe(true);
    expect(ensured.toolCount).toBe(MCP_TOOLS.length);

    const listed = drive.manager.listTools({ serverId: OPENAIMP_MCP_SERVER_ID });
    const listedNames = (listed as unknown as Array<{ name: string }>).map((t) => t.name).sort();
    expect(listedNames).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    expect(drive.dispatchedMethods).toContain("initialize");
    expect(drive.dispatchedMethods).toContain("tools/list");
  });

  it("the merged turn set is the discovered catalog under tool_openaimp_* keys, plus the native tools", async () => {
    const drive = makeMeshDrive();
    await drive.ensure();

    // The native set (getTools) carries NO catalog tools anymore:
    // catalog consumption is the discovered set's job alone.
    const native = drive.nativeTools() as Record<string, unknown>;
    for (const nativeName of [
      "createTaskDraft",
      "rememberFact",
      "recallFacts",
      "compare_stock_valuations",
      "compareValuations",
      "compareStocks",
    ]) {
      expect(native[nativeName], `native turn tool ${nativeName}`).toBeDefined();
    }
    for (const command of McpToolFactory.getAllTools()) {
      expect(native[command.name], `native set must not adapt ${command.name}`).toBeUndefined();
      expect(
        native[`${OPENAIMP_MCP_TOOL_PREFIX}${command.name}`],
        "native set carries no discovered keys",
      ).toBeUndefined();
    }

    // Think's merge: every catalog command is in the turn under
    // its SDK-namespaced discovered key — execute_nlq included
    // (the CHAT_NLQ_MODE gate restricts it separately, below).
    const merged = drive.mergedTools();
    for (const command of McpToolFactory.getAllTools()) {
      expect(
        merged[`${OPENAIMP_MCP_TOOL_PREFIX}${command.name}`],
        `merged turn tool ${OPENAIMP_MCP_TOOL_PREFIX}${command.name}`,
      ).toBeDefined();
    }
    for (const nativeName of ["createTaskDraft", "rememberFact", "recallFacts", "compare_stock_valuations"]) {
      expect(merged[nativeName], `merged native tool ${nativeName}`).toBeDefined();
    }

    // The retired adapter's canonical names + camelCase aliases do
    // not exist in the turn anymore.
    for (const retired of [
      "run_stock_screen",
      "knowledge_search",
      "searchKnowledge",
      "queryPlatformKnowledge",
      "getPlatformCapabilities",
      "draftPayment",
      "confirmDraft",
    ]) {
      expect(merged[retired], `retired turn name ${retired}`).toBeUndefined();
    }
  });

  it("a second ensure on a live connection reuses it (no re-registration)", async () => {
    const drive = makeMeshDrive();
    const first = await drive.ensure();
    expect(first).toMatchObject({ ready: true, reused: false });
    const second = await drive.ensure();
    expect(second).toMatchObject({ ready: true, reused: true });
    expect(second.toolCount).toBe(first.toolCount);
  });

  it("a fresh wake over the same storage re-registers the loopback transport and discovers again", async () => {
    const sql = new MockSqlStorage();
    const first = makeMeshDrive({ sql });
    await first.ensure();

    // New manager, same DO storage: the persisted registration's
    // transport options carry no loopback fetch (function values
    // are not persisted by the SDK), so the fresh instance has no
    // live connection until ensure re-registers it.
    const second = makeMeshDrive({ sql });
    expect(Object.keys(second.manager.getAITools())).toHaveLength(0);
    const ensured = await second.ensure();
    expect(ensured.ready).toBe(true);
    expect(ensured.toolCount).toBe(MCP_TOOLS.length);
    expect(
      second.audits.some((a) => a.type === "mesh_mcp.discovery_ready"),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance: the screen through the discovered path                  */
/* ------------------------------------------------------------------ */

describe("issue #2496 — chat screen through the discovered path (acceptance)", () => {
  it("turn -> discovery -> server -> queue (stamped) -> executor -> door -> workflow start -> read-back", async () => {
    const h = makeScreenHarness();
    const drive = makeMeshDrive();
    await drive.ensure();
    drive.turn.login = LOGIN;
    drive.turn.traceparent = h.traceparent;

    const tools = drive.mergedTools() as Record<
      string,
      { execute: (input: never, opts: never) => Promise<unknown> }
    >;
    const screenTool = tools[`${OPENAIMP_MCP_TOOL_PREFIX}run_stock_screen`];
    expect(screenTool).toBeDefined();

    // The model invokes the DISCOVERED tool. The call crosses the
    // protocol into the instance's own /mcp route, whose handler
    // queues it as a durable async job.
    const callResult = await screenTool.execute(
      { universe: "NASDAQ100", filters: { minPrice: 10 } } as never,
      { toolCallId: "call-2496-1", messages: [] } as never,
    );
    const receipt = receiptOf(callResult);
    expect(receipt).toMatchObject({ jobId: "job-2496-1", status: "queued" });
    expect(drive.dispatchedMethods).toContain("tools/call");

    // The queue carriage: identity + trace stamped server-side at
    // the handler's queue point, never from tool arguments.
    expect(drive.submitted).toHaveLength(1);
    const payload = drive.submitted[0].payload as Record<string, unknown>;
    expect(payload.toolName).toBe("run_stock_screen");
    expect(payload.actingLogin).toBe(LOGIN);
    expect(payload.traceparent).toBe(h.traceparent);

    // The queue-time trace hop was recorded at the surface that
    // queues (the route env's in-memory trace store).
    const hops = await meshTraceStoreForEnv(drive.routeEnv).hopsFor(h.traceId);
    expect(
      hops.some((hop) => hop.kind === "job-queue" && hop.operation === "run_stock_screen"),
    ).toBe(true);

    // The job executes through the real executor entry; the door
    // starts the ScreenerScreenWorkflow as the acting user.
    const result = (await executeCapturedJob(drive, { sql: h.sql, seams: h.seams })) as {
      success: boolean;
      universe: string;
      matchedCount: number;
    };
    expect(result.success).toBe(true);
    expect(result.universe).toBe("NASDAQ100");
    expect(h.startedCommands).toHaveLength(1);

    // The read-back surface survives discovery: the model polls
    // get_async_job — also a discovered tool — for the result.
    const readBack = await tools[`${OPENAIMP_MCP_TOOL_PREFIX}get_async_job`].execute(
      { jobId: "job-2496-1" } as never,
      { toolCallId: "call-2496-2", messages: [] } as never,
    );
    const record = receiptOf(readBack) as {
      status: string;
      result?: { success: boolean; universe: string };
    };
    expect(record.status).toBe("completed");
    expect(record.result?.success).toBe(true);
    expect(record.result?.universe).toBe("NASDAQ100");
  });
});

/* ------------------------------------------------------------------ */
/* Identity: fail closed at the carrier, at the route, at the door     */
/* ------------------------------------------------------------------ */

describe("issue #2496 — identity carriage is fail-closed", () => {
  it("a tools/call with no resolvable turn login is refused at the carrier and never dispatched", async () => {
    const drive = makeMeshDrive();
    await drive.ensure();
    // No turn stash: no acting login resolvable (e.g. a turn that
    // arrived without an identified user).
    drive.turn.login = undefined;
    const tools = drive.mergedTools() as Record<
      string,
      { execute: (input: never, opts: never) => Promise<unknown> }
    >;
    await expect(
      tools[`${OPENAIMP_MCP_TOOL_PREFIX}run_stock_screen`].execute(
        { universe: "NASDAQ100" } as never,
        { toolCallId: "call-2496-3", messages: [] } as never,
      ),
    ).rejects.toThrow(/mesh_mcp_identity_required/);
    expect(drive.dispatchedMethods).not.toContain("tools/call");
    expect(drive.submitted).toHaveLength(0);
  });

  it("a door command executed without an actingLogin still refuses identity_required (execution layer unchanged)", async () => {
    await expect(
      executeMCPTool("run_stock_screen", { universe: "NASDAQ100" }, {
        env: {} as Env,
        orm: {} as never,
        sessionId: "session-2496",
        audit: () => {},
        principal: { kind: "system", login: null },
      } as never),
    ).rejects.toMatchObject({ code: "identity_required" });
  });

  it("an external /mcp caller is served the door AS THEMSELVES: the verified header login is stamped at queue time", async () => {
    const drive = makeMeshDrive();
    const request = new Request("https://agent.internal/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-user-login": LOGIN,
        "x-principal-kind": "session",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "run_stock_screen", arguments: { universe: "SP500" } },
      }),
    });
    const url = new URL(request.url);
    const response = await handleMcpChatNlqRoutes(request, url, url.pathname, "session-2496", drive.routeCtx);
    expect(response).not.toBeNull();
    const body = (await response!.json()) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    const receipt = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    expect(receipt).toMatchObject({ jobId: "job-2496-1", status: "queued" });
    expect(drive.submitted).toHaveLength(1);
    const payload = drive.submitted[0].payload as Record<string, unknown>;
    expect(payload.actingLogin).toBe(LOGIN);
  });

  it("an anonymous /mcp caller (no verified login header) is refused by the permission gate and nothing queues", async () => {
    const drive = makeMeshDrive();
    const request = new Request("https://agent.internal/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "run_stock_screen", arguments: { universe: "SP500" } },
      }),
    });
    const url = new URL(request.url);
    const response = await handleMcpChatNlqRoutes(request, url, url.pathname, "session-2496", drive.routeCtx);
    const body = (await response!.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    expect(body.result).toBeUndefined();
    expect(body.error?.message).toContain("FAILURE_MCP_PERMISSION_DENIED");
    expect(drive.submitted).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The flag under the provided path: CHAT_NLQ_MODE via activeTools     */
/* ------------------------------------------------------------------ */

describe("issue #2496 — CHAT_NLQ_MODE under the provided path", () => {
  it("execute_nlq is discovered, and the gate's activeTools excludes exactly it while off", async () => {
    const drive = makeMeshDrive();
    await drive.ensure();
    // The catalog itself carries execute_nlq (the server lists it)…
    const namespaced = Object.keys(drive.manager.getAITools());
    expect(namespaced).toContain(`${OPENAIMP_MCP_TOOL_PREFIX}execute_nlq`);
    // …and the gate restricts the merged set to everything else.
    const mergedNames = Object.keys(drive.mergedTools());
    const gate = drive.nlqGate(mergedNames);
    expect(gate.activeTools).toBeDefined();
    expect(gate.activeTools).not.toContain(`${OPENAIMP_MCP_TOOL_PREFIX}execute_nlq`);
    expect(gate.activeTools).toContain(`${OPENAIMP_MCP_TOOL_PREFIX}run_stock_screen`);
    expect(gate.activeTools).toContain("createTaskDraft");
    expect(gate.activeTools).toHaveLength(mergedNames.length - 1);
  });

  it("no restriction when the switch is on", async () => {
    const drive = makeMeshDrive();
    await drive.ensure();
    const mergedNames = Object.keys(drive.mergedTools());
    const gate = drive.nlqGate(mergedNames, { CHAT_NLQ_MODE: "on" });
    expect(gate.activeTools).toBeUndefined();
  });

  it("an invalid switch value fails closed to off and audits chat_nlq.config_error", async () => {
    const drive = makeMeshDrive();
    await drive.ensure();
    const mergedNames = Object.keys(drive.mergedTools());
    const gate = drive.nlqGate(mergedNames, { CHAT_NLQ_MODE: "banana" });
    expect(gate.activeTools).toBeDefined();
    expect(gate.activeTools).not.toContain(`${OPENAIMP_MCP_TOOL_PREFIX}execute_nlq`);
    expect(drive.audits.some((a) => a.type === "chat_nlq.config_error")).toBe(true);
  });

  it("no restriction when the merged set has no discovered NLQ tool to exclude", () => {
    const drive = makeMeshDrive();
    const gate = drive.nlqGate(["createTaskDraft", "rememberFact"]);
    expect(gate.activeTools).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* The carrier: header discipline at the loopback                      */
/* ------------------------------------------------------------------ */

describe("issue #2496 — the loopback identity carrier", () => {
  it("stamps identity headers on tools/call only; discovery traffic carries none", async () => {
    const seen: Array<{ method: string; login: string | null; kind: string | null }> = [];
    const dispatch = async (request: Request): Promise<Response> => {
      const body = (await request.clone().json().catch(() => ({}))) as { method?: string };
      seen.push({
        method: body.method ?? "",
        login: request.headers.get("x-user-login"),
        kind: request.headers.get("x-principal-kind"),
      });
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    };
    const fetch = createOpenaimpMcpFetch({
      dispatch,
      resolveActingLogin: () => LOGIN,
      resolveTraceparent: () => undefined,
    });
    await fetch("https://agent.internal/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    await fetch("https://agent.internal/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "run_stock_screen", arguments: {} },
      }),
    });
    expect(seen).toEqual([
      { method: "tools/list", login: null, kind: null },
      { method: "tools/call", login: LOGIN, kind: "session" },
    ]);
  });
});
