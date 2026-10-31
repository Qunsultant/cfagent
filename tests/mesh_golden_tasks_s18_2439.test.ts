/**
 * Issue #2439 (Agent Mesh S18, programme #2225 G13b) — the
 * golden-task eval harness and the golden set that makes G12
 * claimable as proven.
 *
 * The harness (src/services/meshGoldenTasks.ts): tasks declared
 * as data (id, door, class, census operation, explicit falsifiable
 * expectation), executed through the REAL door paths with fakes
 * only at binding seams (the programme acceptance rule), each
 * producing a scored result recorded in the eval result store
 * (src/data/meshEvalPorts.ts — port + D1/in-memory adapters,
 * migration 0024) that S19's RSI loop will read.
 *
 * The drivers below are the landed acceptance suites' seams,
 * re-driven under golden expectations:
 *   - chat screen: the S8/S17 NLQ port harness (real workflow
 *     flows behind the InMemoryWorkflowAdapter; the S17 trace
 *     store + the agentdb.trace.get read surface supply the
 *     trace evidence);
 *   - chat trade: the S9 harness (real TradingAgent, real
 *     approval flow, fake platform at the registry seam);
 *   - chat paid: the S10 harness (real PaymentWorkflow flow +
 *     real NativeMonetizationGate behind the binding seam);
 *   - mesh doors: the S5 fake DO namespaces behind the real
 *     command classes;
 *   - A2A: the real edge (src/a2a/index.ts) with the S16
 *     per-surface credential posture, resolving to a real
 *     SandboxAgent instance's handleA2A;
 *   - agent-as-a-tool: the real runResearchAndPublish dispatch
 *     with the SDK facet (runAgentTool) faked at its seam.
 * The HTTP-routes golden task lives in
 * tests/mesh_golden_http_s18_2439.test.ts (it needs the worker
 * module graph, which takes a different mock set).
 *
 * handleQAFailure: this suite also pins the S18 disposition —
 * deprecated in place in src/qa/self-healing.ts naming its
 * successors, with a no-production-caller pin (evidence in the
 * issue body: the live QA loop in scripts/qa-smoke.mjs +
 * POST /api/qa/investigate replaced the design; the function's
 * supervise half calls a method that does not exist).
 */
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Issue #1738: TradingAgent is an Agents SDK actor — mock the SDK
// with a plain base class (the mesh_g4 suite's idiom) so the real
// module graph's workerd-only imports never reach the node loader.
vi.mock("agents", () => {
  return {
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
    routeAgentRequest: async () => null,
  };
});

// The research publish path's PDF leg is the unified report
// pipeline (a provider seam); the golden run controls it exactly
// as tests/research_publish_artifacts.test.ts does.
vi.mock("../src/services/unifiedReportPipeline", () => ({
  generateReportStage: vi.fn(async () => ({
    pdfKey: "report:pdf:research:s18",
    pdfStatus: "generated",
    generationId: "research:manual:s18",
  })),
}));

import {
  MESH_GOLDEN_TASKS,
  evaluateGoldenObservation,
  executeGoldenTasks,
  goldenTask,
  type GoldenObservation,
  type GoldenTaskExecution,
  type MeshGoldenTask,
} from "../src/services/meshGoldenTasks";
import { InMemoryMeshEvalStore } from "../src/data/inMemoryMeshEvalAdapter";
import { D1MeshEvalAdapter } from "../src/data/d1MeshEvalAdapter";
import { meshEvalStoreForEnv } from "../src/data/createMeshEvalPorts";
import { agentMeshEvalResults } from "../src/data/drizzleSchema";
import { ALL_MIGRATIONS, MIGRATION_0024_AGENT_MESH_EVAL_RESULTS } from "../src/data/migrationRunner";
import { getTableName } from "drizzle-orm";
import {
  MESH_CAPABILITY_DOORS,
  MESH_G12_PROOF,
  capabilityDoor,
} from "../src/agents/registry";
import { AGENTIC_SPEND_AGENT_ID } from "../src/payments/ledger";

const LOGIN = "alice";
const RUN_ID = "mesh-eval:s18:golden-set";

/* ------------------------------------------------------------------ */
/* Harness self-tests: the evaluator is falsifiable                    */
/* ------------------------------------------------------------------ */

const SYNTH_TASK: MeshGoldenTask = {
  id: "synthetic",
  title: "synthetic task",
  door: "chat-turn",
  className: "ScreenerAgent",
  operation: "nlq.execute",
  expectation: { outcome: "completed", facts: { workflowStarts: 1 } },
};

describe("golden harness: evaluator (#2439)", () => {
  it("passes a matching completed observation", () => {
    const verdict = evaluateGoldenObservation(SYNTH_TASK, {
      outcome: "completed",
      facts: { workflowStarts: 1, extra: "ignored" },
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("fails on an outcome mismatch, a fact mismatch, and a missing refusal code", () => {
    const wrongOutcome = evaluateGoldenObservation(SYNTH_TASK, {
      outcome: "refused",
      refusalCode: "identity_required",
      facts: { workflowStarts: 0 },
    });
    expect(wrongOutcome.passed).toBe(false);
    expect(wrongOutcome.failures.join(" ")).toMatch(/outcome/);

    const wrongFact = evaluateGoldenObservation(SYNTH_TASK, {
      outcome: "completed",
      facts: { workflowStarts: 2 },
    });
    expect(wrongFact.passed).toBe(false);
    expect(wrongFact.failures.join(" ")).toMatch(/workflowStarts/);

    const refusalTask: MeshGoldenTask = {
      ...SYNTH_TASK,
      expectation: { outcome: "refused", refusalCode: "identity_required" },
    };
    const noCode = evaluateGoldenObservation(refusalTask, {
      outcome: "refused",
      facts: {},
    });
    expect(noCode.passed).toBe(false);
    expect(noCode.failures.join(" ")).toMatch(/refusalCode/);

    const wrongCode = evaluateGoldenObservation(refusalTask, {
      outcome: "refused",
      refusalCode: "door_unavailable",
      facts: {},
    });
    expect(wrongCode.passed).toBe(false);
  });

  it("fails a driver error and a missing trace, and scores trace hop kinds by subset", () => {
    const errored = evaluateGoldenObservation(SYNTH_TASK, {
      outcome: "error",
      facts: {},
      detail: "driver blew up",
    });
    expect(errored.passed).toBe(false);
    expect(errored.failures.join(" ")).toMatch(/error/);

    const tracedTask: MeshGoldenTask = {
      ...SYNTH_TASK,
      expectation: {
        outcome: "completed",
        traceHopKinds: ["workflow-start", "workflow-step"],
      },
    };
    const noTrace = evaluateGoldenObservation(tracedTask, {
      outcome: "completed",
      facts: { workflowStarts: 1 },
    });
    expect(noTrace.passed).toBe(false);
    expect(noTrace.failures.join(" ")).toMatch(/trace/);

    const partial = evaluateGoldenObservation(
      tracedTask,
      { outcome: "completed", facts: { workflowStarts: 1 }, traceId: "a".repeat(32) },
      { kinds: ["workflow-start"], complete: false },
    );
    expect(partial.passed).toBe(false);
    expect(partial.failures.join(" ")).toMatch(/workflow-step/);

    const full = evaluateGoldenObservation(
      tracedTask,
      { outcome: "completed", facts: { workflowStarts: 1 }, traceId: "a".repeat(32) },
      { kinds: ["workflow-start", "workflow-step", "projection"], complete: true },
    );
    expect(full.passed).toBe(true);
  });
});

describe("golden harness: runner + store (#2439)", () => {
  it("records scored results readably; a deliberately wrong expectation is recorded FAILED", async () => {
    const store = new InMemoryMeshEvalStore();
    const executions: GoldenTaskExecution[] = [
      {
        task: SYNTH_TASK,
        drive: async () => ({ outcome: "completed", facts: { workflowStarts: 1 } }),
      },
      {
        // The falsifiability pin: this expectation is WRONG on
        // purpose — the driver completes, the task demands a
        // refusal. The harness must record a failure, never a pass.
        task: {
          ...SYNTH_TASK,
          id: "synthetic-wrong-expectation",
          expectation: { outcome: "refused", refusalCode: "identity_required" },
        },
        drive: async () => ({ outcome: "completed", facts: { workflowStarts: 1 } }),
      },
      {
        task: { ...SYNTH_TASK, id: "synthetic-driver-throws" },
        drive: async () => {
          throw new Error("seam exploded");
        },
      },
    ];
    const results = await executeGoldenTasks(executions, { store, runId: "run-selftest" });
    expect(results.map((r) => [r.taskId, r.passed])).toEqual([
      ["synthetic", true],
      ["synthetic-wrong-expectation", false],
      ["synthetic-driver-throws", false],
    ]);
    expect(results[2].failures.join(" ")).toMatch(/seam exploded/);

    // The store is the record: S19 reads outcomes through the port.
    const forRun = await store.resultsForRun("run-selftest");
    expect(forRun.map((r) => r.taskId)).toEqual([
      "synthetic",
      "synthetic-wrong-expectation",
      "synthetic-driver-throws",
    ]);
    const latest = await store.latestForTask("synthetic");
    expect(latest?.passed).toBe(true);
    expect(await store.latestForTask("no-such-task")).toBeNull();
  });

  it("store: duplicate record of one (run, task) is a no-op — the first record wins", async () => {
    const store = new InMemoryMeshEvalStore();
    const base = {
      runId: "r1",
      taskId: "t1",
      door: "mcp",
      className: "ScheduledAgent",
      seq: 0,
      outcome: "completed" as const,
      failures: [] as string[],
      facts: {},
      startedAtMs: 100,
      durationMs: 5,
    };
    await store.record({ ...base, passed: true });
    await store.record({ ...base, passed: false, startedAtMs: 200 });
    const rows = await store.resultsForRun("r1");
    expect(rows).toHaveLength(1);
    expect(rows[0].passed).toBe(true);
  });

  it("composition root: unbound env → in-memory store; AGENT_DB bound → D1 adapter; never throws", () => {
    expect(meshEvalStoreForEnv({})).toBeInstanceOf(InMemoryMeshEvalStore);
    expect(meshEvalStoreForEnv({ AGENT_DB: {} })).toBeInstanceOf(D1MeshEvalAdapter);
  });

  it("migration 0024 + drizzle schema carry the eval results table", () => {
    expect(MIGRATION_0024_AGENT_MESH_EVAL_RESULTS.version).toBe(24);
    expect(MIGRATION_0024_AGENT_MESH_EVAL_RESULTS.sql).toContain("agent_mesh_eval_results");
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0024_AGENT_MESH_EVAL_RESULTS);
    // S19 (#2460) appended migration 0025 (agent_mesh_proposals) after 0024.
    // #2481 appended migration 0026 (tenant auto-refresh) after 0025.
    expect(Math.max(...ALL_MIGRATIONS.map((m) => m.version))).toBe(26);
    expect(getTableName(agentMeshEvalResults)).toBe("agent_mesh_eval_results");
  });
});

/* ------------------------------------------------------------------ */
/* Catalog pins: the golden set IS the G12 proof surface               */
/* ------------------------------------------------------------------ */

describe("golden catalog vs the S15 census (#2439)", () => {
  it("task ids are unique and every task names a census cell it proves", () => {
    const ids = MESH_GOLDEN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of MESH_GOLDEN_TASKS) {
      const cell = capabilityDoor(task.className, task.door);
      expect(cell, `${task.id}: census cell ${task.className} × ${task.door}`).toBeDefined();
      const cellStatus = task.cellStatus ?? "exposed";
      expect(cell!.status, `${task.id}: cell status must match the catalog's claim`).toBe(cellStatus);
      if (cellStatus === "exposed" && cell!.operations.length > 0) {
        expect(
          cell!.operations,
          `${task.id}: operation ${task.operation} must be one of the cell's operations`,
        ).toContain(task.operation);
      }
      if (cellStatus === "not-exposed") {
        // A gate task: the only honest proof of a not-exposed
        // cell is its recorded refusal, behaviorally reproduced.
        expect(
          task.expectation.outcome,
          `${task.id}: a not-exposed cell's task must expect the refusal`,
        ).toBe("refused");
      }
      if (task.expectation.outcome === "refused") {
        expect(task.expectation.refusalCode, `${task.id}: refusal tasks name their code`).toBeTruthy();
      }
    }
  });

  it("covers every door — the brief's families and the full five-door set", () => {
    const doors = new Set(MESH_GOLDEN_TASKS.map((t) => t.door));
    for (const door of ["chat-turn", "http-routes", "mcp", "a2a", "agent-as-a-tool"]) {
      expect(doors.has(door as MeshGoldenTask["door"]), `door ${door} covered`).toBe(true);
    }
    // The brief's named families, individually present:
    for (const id of [
      "chat-screen-run",
      "chat-trade-approval",
      "chat-paid-screen",
      "a2a-sandbox-status",
      "mcp-ai-search",
      "agent-as-tool-research",
      "scheduled-goal-trigger",
    ]) {
      expect(goldenTask(id), `golden task ${id}`).toBeDefined();
    }
    // Every census class with an exposed cell is a candidate; the
    // catalog's classes are all real census classes.
    const censusClasses = new Set(MESH_CAPABILITY_DOORS.map((c) => c.className));
    for (const task of MESH_GOLDEN_TASKS) {
      expect(censusClasses.has(task.className)).toBe(true);
    }
  });

  it("the registry's G12 proof record names this harness, its store, and all five doors", () => {
    expect(MESH_G12_PROOF.status).toBe("proven");
    expect(MESH_G12_PROOF.issue).toBe(2439);
    expect(MESH_G12_PROOF.store).toBe("agent_mesh_eval_results");
    expect([...MESH_G12_PROOF.doors].sort()).toEqual(
      ["a2a", "agent-as-a-tool", "chat-turn", "http-routes", "mcp"].sort(),
    );
    const catalogDoors = new Set(MESH_GOLDEN_TASKS.map((t) => t.door));
    for (const door of catalogDoors) {
      expect(MESH_G12_PROOF.doors).toContain(door);
    }
  });
});

/* ------------------------------------------------------------------ */
/* handleQAFailure disposition pin (#2439)                             */
/* ------------------------------------------------------------------ */

describe("handleQAFailure disposition (#2439)", () => {
  const root = path.resolve(__dirname, "..");

  it("self-healing.ts is deprecated in place, naming both successors", () => {
    const src = fs.readFileSync(path.join(root, "src/qa/self-healing.ts"), "utf8");
    expect(src).toContain("DEPRECATED");
    expect(src).toMatch(/superseded by/);
    expect(src).toContain("scripts/qa-smoke.mjs");
    expect(src).toContain("src/qa/investigate.ts");
  });

  it("no production caller exists — any future wiring must update the disposition deliberately", () => {
    const hits: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          scan(full);
        } else if (/\.(ts|mjs)$/.test(entry.name)) {
          if (full.endsWith(path.join("src", "qa", "self-healing.ts"))) continue;
          const text = fs.readFileSync(full, "utf8");
          if (/from\s+["'][^"']*self-healing["']/.test(text) || /handleQAFailure\s*\(/.test(text)) {
            hits.push(path.relative(root, full));
          }
        }
      }
    };
    scan(path.join(root, "src"));
    scan(path.join(root, "scripts"));
    expect(hits).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Golden drivers — chat screen (S8/S17 harness)                       */
/* ------------------------------------------------------------------ */

import {
  nlqStockScreenPort,
  type NlqPortsContext,
} from "../src/agents/orchestrator/nlqPorts";
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
import type { WorkflowJobCommand, WorkflowPort } from "../src/workflows/workflowPorts";
import { MockSqlStorage } from "./mock-sql";

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

function makeScreenHarness() {
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

  const tenantRef = { tenantId: "" };
  const ctx: NlqPortsContext = {
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
    cancelSchedule: async () => true,
    listSchedules: async () => [],
    getScreenerAgent: () => {
      throw new Error("direct ScreenerAgent path must not be used when the workflow port is available");
    },
    getSocialBriefStore: () => null,
    env: {} as NlqPortsContext["env"],
    ensureTables: () => sql as never,
    workflowPort: recordingPort,
    readWorkflowJobHistory: (tenantId, chainId) =>
      shardStore.listJobsForChain(tenantId, chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 60_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    traceparent: () => traceparent,
    traceStore,
  };
  return { ctx, shardStore, traceStore, startedCommands, traceId: trace.traceId, tenantRef };
}

function identityRefusalCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof MeshDoorError) return err.code;
  if (/identity|login/i.test(message)) return "identity_required";
  return "unexpected_error";
}

/* ------------------------------------------------------------------ */
/* Golden drivers — chat trade (S9 harness)                            */
/* ------------------------------------------------------------------ */

import { TradingAgent } from "../src/agents/trading-agent";
import { runTradeApprovalFlow } from "../src/agents/trading-trade-workflow";
import { TradingPlatformRegistry } from "../src/trading";
import { getUserDid } from "../src/agents/did";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  ProposeStockTradeCommand,
  StartTradeApprovalCommand,
  DecideTradeApprovalCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import type { McpToolContext } from "../src/patterns/interfaces";
import type { Env } from "../src/types";

interface FakeDraft {
  orderId: string;
  status: string;
}
const tradeLedger = new Map<string, FakeDraft>();
const tradeExecutions: Array<{ orderId: string; authorizerDid: string; decision: string }> = [];
/** Evidence captured inside the approval drive (harness state is reset by later drives). */
const approvalEvidence: Array<{ executions: number; authorizerDid?: string }> = [];
let tradeDraftSeq = 0;

TradingPlatformRegistry.register("fakeg18" as never, () => {
  return {
    platformId: "fakeg18",
    name: "Fake S18 Broker",
    getStatus: async () => ({}),
    getQuote: async () => ({}),
    getAccounts: async () => [],
    getPositions: async () => ({ account: {}, positions: [] }),
    previewOrder: async (params: { symbol: string; action: string; quantity: number }) => {
      const orderId = `ord-s18-${++tradeDraftSeq}`;
      tradeLedger.set(orderId, { orderId, status: "previewed" });
      return {
        orderId,
        symbol: params.symbol,
        action: params.action,
        orderAction: params.action,
        orderType: "MARKET",
        quantity: params.quantity,
        estimatedPrice: 100,
        estimatedTotal: 100 * params.quantity,
        estimatedCommission: 0,
        term: "GOOD_FOR_DAY",
        status: "previewed",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "",
        proofSignature: "sig",
        previewMessage: "Preview generated",
      };
    },
    executeOrder: (orderId: string, authorizerDid: string, decision: string) => {
      const rec = tradeLedger.get(orderId);
      if (!rec) throw new Error(`Order draft '${orderId}' not found.`);
      if (rec.status !== "previewed") {
        throw new Error(`Order draft '${orderId}' cannot be executed. Current status is '${rec.status}'.`);
      }
      if (decision === "approved") {
        tradeExecutions.push({ orderId, authorizerDid, decision });
        rec.status = "executed";
        return { success: true, status: "executed", orderId, executionId: `exec-${orderId}`, authorizerDid };
      }
      rec.status = "rejected";
      return { success: false, status: "rejected", orderId, executionId: "", authorizerDid };
    },
  } as never;
});

interface TradeRuntimeRun {
  params: { orderId: string; userLogin: string };
  state: "awaiting" | "complete" | "errored";
  done: Promise<unknown>;
}

function makeTradeHarness() {
  tradeLedger.clear();
  tradeExecutions.length = 0;
  tradeDraftSeq = 0;

  const sql = new MockSqlStorage();
  const runs = new Map<string, TradeRuntimeRun>();
  let wfSeq = 0;
  const env: Record<string, unknown> = {
    SERVICE_USER_LOGIN: "svc-background",
    TRADING_AGENT_PROVIDERS: "fakeg18",
    TRADING_AGENT_DEFAULT_PROVIDER: "fakeg18",
  };

  const agent: any = Object.create(TradingAgent.prototype);
  agent.env = env as Env;
  agent.name = `trading:${LOGIN}`;
  agent.ctx = {
    id: { toString: () => `trading:${LOGIN}` },
    storage: { sql, get: async () => undefined, put: async () => {}, delete: async () => {} },
  };

  const runWorkflowCalls: Array<{ binding: string; params: unknown }> = [];
  agent.runWorkflow = async (binding: string, params: TradeRuntimeRun["params"]) => {
    runWorkflowCalls.push({ binding, params });
    const workflowId = `wf-s18-${++wfSeq}`;
    let deliver: (payload: unknown) => void = () => {};
    const eventPromise = new Promise<unknown>((resolve) => {
      deliver = resolve;
    });
    const step = {
      waitForEvent: async () => ({ payload: await eventPromise }),
      do: async (_name: string, fn: () => Promise<unknown>) => fn(),
    };
    const run: TradeRuntimeRun = { params, state: "awaiting", done: Promise.resolve() };
    run.done = runTradeApprovalFlow(env as Env, params, step as never).then(
      (outcome) => {
        run.state = "complete";
        return outcome;
      },
      (err) => {
        run.state = "errored";
        throw err;
      },
    );
    run.done.catch(() => {});
    (run as { deliver?: unknown }).deliver = deliver;
    runs.set(workflowId, run);
    return workflowId;
  };
  agent.sendWorkflowEvent = async (_binding: string, workflowId: string, event: { payload: unknown }) => {
    const run = runs.get(workflowId) as (TradeRuntimeRun & { deliver?: (p: unknown) => void }) | undefined;
    if (!run?.deliver) throw new Error(`workflow ${workflowId} not found`);
    run.deliver(event.payload);
  };

  env.TRADING_AGENT = {
    idFromName: (name: string) => name,
    get: (_id: unknown) => agent,
  };
  env.TRADE_WORKFLOW = {
    get: (id: string) => ({
      status: async () => {
        const run = runs.get(id);
        if (!run) throw new Error(`workflow instance ${id} not found`);
        return run.state === "complete" ? { status: "complete" } : { status: "running" };
      },
    }),
  };
  return { env: env as Env, runs, runWorkflowCalls };
}

function makeCommandContext(env: Env, actingLogin?: () => string | undefined): McpToolContext {
  return {
    env,
    orm: {} as never,
    sessionId: "session-s18",
    audit: vi.fn(),
    ...(actingLogin ? { actingLogin } : {}),
  } as McpToolContext;
}

/* ------------------------------------------------------------------ */
/* Golden drivers — chat paid (S10 harness, condensed)                 */
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

function makePaidHarness(opts: { budgetVerdict?: { allowed: boolean; reason?: string } } = {}) {
  const sql = new MockSqlStorage();
  const shardStore = new InMemoryShardJobAdapter();
  const screenerStarts: WorkflowJobCommand[] = [];
  const budgetCalls: Array<{ operation: string; amountCents: number }> = [];
  const paymentCreates: Array<{ id: string; params: PaymentWorkflowEventParams }> = [];
  const coverageConsumed: Array<{ userId: string; paidVia: string; priceUSD: number }> = [];

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

  // The covered-account path (the G5 acceptance shape): no
  // checkout ports — the gate consumes the subscription's
  // included run as coverage.
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
        if (name === "await-payment-verified") return { payload: { sessionId: "cs_test_s18" } };
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

  const ctx: NlqPortsContext = {
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
    cancelSchedule: async () => true,
    listSchedules: async () => [],
    getScreenerAgent: () => {
      return {
        runScreen: async () => {
          throw new Error("direct ScreenerAgent fallback must not run on the paid path");
        },
      } as never;
    },
    getSocialBriefStore: () => null,
    env: {} as NlqPortsContext["env"],
    ensureTables: () => sql as never,
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
  return { ctx, screenerStarts, budgetCalls, paymentCreates, coverageConsumed };
}

/* ------------------------------------------------------------------ */
/* Golden drivers — mesh doors (S5 binding-seam fakes)                 */
/* ------------------------------------------------------------------ */

import {
  ListScheduledGoalsCommand,
  TriggerScheduledGoalCommand,
  CheckPaymentBudgetCommand,
} from "../src/mcps/openaimp/meshDoorCommands";
import type { ScheduledGoal, ScheduleTick } from "../src/schedule";
import type { PaymentRecord } from "../src/payments/ledger";

const DOOR_GOALS: ScheduledGoal[] = [
  {
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 */6 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  },
  {
    id: "daily-qa-sweep",
    name: "Daily QA sweep",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
    lastRun: "2026-10-29T06:00:00.000Z",
  },
];

const OK_TICK: ScheduleTick = {
  timestamp: "2026-10-30T12:00:00.000Z",
  goalsEvaluated: 1,
  jobsCreated: 1,
  jobsSkipped: 0,
  errors: [],
};

function makeDoorEnv() {
  const scheduled = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async listGoals(): Promise<ScheduledGoal[]> {
      this.calls.push({ method: "listGoals", args: [] });
      return DOOR_GOALS.map((g) => ({ ...g }));
    },
    async triggerGoal(id: string): Promise<ScheduleTick> {
      this.calls.push({ method: "triggerGoal", args: [id] });
      return OK_TICK;
    },
  };
  const record: PaymentRecord = {
    id: "pay-s18",
    agentId: AGENTIC_SPEND_AGENT_ID,
    operation: "search.query",
    amountCents: 250,
    timestamp: "2026-10-30T11:00:00.000Z",
    idempotencyKey: "key-s18",
    status: "verified",
  };
  const payments = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    async budgetCheck(req: { operation: string; amountCents: number; agentId: string }) {
      this.calls.push({ method: "budgetCheck", args: [req] });
      return { allowed: true };
    },
    async todaySpent(): Promise<number> {
      this.calls.push({ method: "todaySpent", args: [] });
      return 4321;
    },
    async listPayments(limit = 50): Promise<PaymentRecord[]> {
      this.calls.push({ method: "listPayments", args: [limit] });
      return [record];
    },
  };
  const fakeNamespace = <T,>(stub: T) => ({
    idFromName: (name: string) => name,
    get: (_id: unknown) => stub,
  });
  const env = {
    SCHEDULED_AGENT: fakeNamespace(scheduled),
    PAYMENTS_AGENT: fakeNamespace(payments),
  } as unknown as Env;
  return { env, scheduled, payments };
}

/* ------------------------------------------------------------------ */
/* Golden drivers — A2A edge (S15/S16 posture)                         */
/* ------------------------------------------------------------------ */

import { handleA2A } from "../src/a2a/index";
import { SandboxAgent } from "../src/agents/sandbox-agent";

function makeA2aEnv(posture: "per-surface" | "none") {
  const agent: { env?: unknown } = Object.create(SandboxAgent.prototype);
  const env: Record<string, unknown> = {
    SANDBOX_AGENT: {
      idFromName: (name: string) => ({ name }),
      get: (_id: { name: string }) => agent,
    },
  };
  if (posture === "per-surface") env.A2A_TOKEN_SANDBOX = "s18-surface-token";
  agent.env = env as Env;
  return env as Env;
}

const a2aPost = (token?: string) =>
  new Request("https://agent.example/a2a/sandbox", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ operation: "sandbox.status" }),
  });

async function a2aErrorCode(res: Response): Promise<number | undefined> {
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: number };
  } | null;
  return body?.error?.code;
}

/* ------------------------------------------------------------------ */
/* Golden drivers — agent-as-a-tool (research publish dispatch)        */
/* ------------------------------------------------------------------ */

import { runResearchAndPublish } from "../src/agents/orchestrator/researchPublish";

function makeResearchDriver() {
  const sql = new MockSqlStorage();
  const facetCalls: Array<{ cls: unknown; input: { trigger: string; userLogin: string } }> = [];
  const reportFixture = (runId: string) =>
    ({
      runId,
      generationId: `research:manual:${runId}`,
      trigger: "manual",
      userLogin: LOGIN,
      createdAt: "2026-10-30T12:00:00.000Z",
      rulesVersion: "v1",
      configSnapshot: {},
      regime: { regime: "risk_on", notes: [] },
      summary: "1 qualified idea.",
      ideas: [],
      watchlist: [],
      rejected: [],
      stats: { universeSize: 1, qualified: 0 },
      oodaTrace: [],
      stageTrace: [],
    }) as never;
  const agentFacade = {
    latest: reportFixture("run-s18-previous") as unknown,
    runResearchCalls: 0,
    async getLatest() {
      return this.latest;
    },
    async createResearchTask() {
      return { task: { id: "task-s18", status: "queued" } };
    },
    async beginResearchTask() {},
    async heartbeatResearchTask() {},
    async completeResearchTask() {},
    async failResearchTask() {},
    async runResearch() {
      this.runResearchCalls++;
      return { success: false, error: "fallback must not run on the agent path" };
    },
    async generateAndStoreResearchArtifacts() {
      return {
        xlsxKey: "report:xlsx:research:s18",
        xlsxStatus: "generated" as const,
        csvKey: "report:csv:research:s18",
        csvStatus: "generated" as const,
      };
    },
  };
  const ctx = {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => sql,
    getOrm: () => ({}),
    getResearchAgent: (_userLogin?: string) => agentFacade,
    runAgentTool: async (cls: unknown, options: { input: { trigger: "manual" | "scheduled"; userLogin: string } }) => {
      facetCalls.push({ cls, input: options.input });
      // The child turn's own work: it persists its typed report
      // before returning (the #1738 contract the dispatch checks).
      agentFacade.latest = reportFixture("run-s18-fresh");
      return { status: "completed" };
    },
    getReportDispatchHitl: () => false,
    createReportConfirmation: () => "conf-s18",
    RESEARCH_TASK_HEARTBEAT_MS: 60_000,
  } as never;
  return { ctx, facetCalls, agentFacade };
}

/* ------------------------------------------------------------------ */
/* The golden set: every task driven through its real door path        */
/* ------------------------------------------------------------------ */

const FILTERS = { universe: "NASDAQ100", minPrice: 10 } as never;

// The screen execution's harness is shared between its drive and
// its trace assembly, so it is built separately from the list
// below.
function screenExecution(): GoldenTaskExecution {
  const h = makeScreenHarness();
  return {
    task: goldenTask("chat-screen-run")!,
    drive: async () => {
      const port = nlqStockScreenPort(h.ctx);
      const result = await port.runScreen({ filters: FILTERS, userLogin: LOGIN });
      h.tenantRef.tenantId = h.startedCommands[0]?.tenantId ?? "";
      return {
        outcome: result.success ? "completed" : "error",
        traceId: h.traceId,
        facts: {
          workflowStarts: h.startedCommands.length,
          matchedCount: result.matchedCount ?? -1,
        },
      } satisfies GoldenObservation;
    },
    assembleTrace: async (traceId) => {
      // The S17 read surface itself (agentdb.trace.get's core),
      // with its reader seams injected from this harness.
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
  };
}

function remainingExecutions(): GoldenTaskExecution[] {
  return [
    {
      task: goldenTask("chat-screen-identity-refusal")!,
      drive: async () => {
        const h = makeScreenHarness();
        const port = nlqStockScreenPort(h.ctx);
        try {
          await port.runScreen({ filters: FILTERS, userLogin: "" });
          return { outcome: "error", facts: {}, detail: "port did not refuse" } satisfies GoldenObservation;
        } catch (err) {
          return {
            outcome: "refused",
            refusalCode: identityRefusalCode(err),
            facts: { workflowStarts: h.startedCommands.length },
          } satisfies GoldenObservation;
        }
      },
    },
    {
      task: goldenTask("chat-trade-approval")!,
      drive: async () => {
        const h = makeTradeHarness();
        const ctx = makeCommandContext(h.env, () => LOGIN);
        const proposed: { proposal: { orderId: string } } = await new ProposeStockTradeCommand().execute(
          { symbol: "AAPL", action: "BUY", quantity: 10 },
          ctx,
        );
        const orderId = proposed.proposal.orderId;
        const started: { workflowId: string } = await new StartTradeApprovalCommand().execute(
          { orderId },
          ctx,
        );
        await new DecideTradeApprovalCommand().execute(
          { workflowId: started.workflowId, decision: "approved" },
          ctx,
        );
        const outcome = (await h.runs.get(started.workflowId)!.done) as { status: string };
        approvalEvidence.push({
          executions: tradeExecutions.length,
          authorizerDid: tradeExecutions[0]?.authorizerDid,
        });
        return {
          outcome: outcome.status === "settled" ? "completed" : "error",
          facts: {
            workflowRuns: h.runWorkflowCalls.length,
            brokerExecutions: tradeExecutions.length,
          },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("chat-trade-identity-refusal")!,
      drive: async () => {
        const h = makeTradeHarness();
        const idCtx = makeCommandContext(h.env, () => LOGIN);
        const proposed: { proposal: { orderId: string } } = await new ProposeStockTradeCommand().execute(
          { symbol: "AAPL", action: "BUY", quantity: 10 },
          idCtx,
        );
        try {
          await new StartTradeApprovalCommand().execute(
            { orderId: proposed.proposal.orderId },
            makeCommandContext(h.env),
          );
          return { outcome: "error", facts: {}, detail: "door did not refuse" } satisfies GoldenObservation;
        } catch (err) {
          return {
            outcome: "refused",
            refusalCode: identityRefusalCode(err),
            facts: {
              workflowRuns: h.runWorkflowCalls.length,
              brokerExecutions: tradeExecutions.length,
            },
          } satisfies GoldenObservation;
        }
      },
    },
    {
      task: goldenTask("chat-paid-screen")!,
      drive: async () => {
        const h = makePaidHarness();
        const port = nlqStockScreenPort(h.ctx);
        const result = await port.runScreen({ filters: FILTERS, userLogin: LOGIN });
        return {
          outcome: result.success ? "completed" : "error",
          facts: {
            budgetChecks: h.budgetCalls.length,
            paymentStarts: h.paymentCreates.length,
            screenerStarts: h.screenerStarts.length,
            coverageConsumed: h.coverageConsumed.length,
          },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("chat-paid-budget-refusal")!,
      drive: async () => {
        const h = makePaidHarness({
          budgetVerdict: { allowed: false, reason: "daily spend cap reached for this operation" },
        });
        const port = nlqStockScreenPort(h.ctx);
        try {
          await port.runScreen({ filters: FILTERS, userLogin: LOGIN });
          return { outcome: "error", facts: {}, detail: "port did not refuse" } satisfies GoldenObservation;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            outcome: "refused",
            refusalCode: /budget/i.test(message) ? "budget_denied" : "unexpected_error",
            facts: {
              budgetChecks: h.budgetCalls.length,
              paymentStarts: h.paymentCreates.length,
              screenerStarts: h.screenerStarts.length,
            },
          } satisfies GoldenObservation;
        }
      },
    },
    {
      task: goldenTask("chat-budget-check")!,
      drive: async () => {
        const { env } = makeDoorEnv();
        const ctx = makeCommandContext(env, () => LOGIN);
        const result: { allowed: boolean; agentId: string } = await new CheckPaymentBudgetCommand().execute(
          { operation: "search.query", amountCents: 250 },
          ctx,
        );
        return {
          outcome: "completed",
          facts: { allowed: result.allowed, agentId: result.agentId },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("scheduled-goal-trigger")!,
      drive: async () => {
        const { env } = makeDoorEnv();
        const ctx = makeCommandContext(env, () => LOGIN);
        const result: { tick: { jobsCreated: number } } = await new TriggerScheduledGoalCommand().execute(
          { goalId: "opportunity-hunt" },
          ctx,
        );
        return {
          outcome: "completed",
          facts: { jobsCreated: result.tick.jobsCreated },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("mcp-ai-search")!,
      drive: async () => {
        // The AI_SEARCH_AGENT DO namespace is the binding seam
        // (the #2250 suite's idiom); the command, its shaping,
        // and its audit are production code.
        const { AISearchAgentSearchCommand } = await import(
          "../src/mcps/openaimp/cloudflareAgentCommands"
        );
        const stub = {
          search: async (_query: string, _opts?: { callerLogin?: string; limit?: number }) => ({
            ok: true,
            path: "namespace" as const,
            correlationId: "corr-s18",
            results: [
              { id: "doc-1", title: "NVDA data center revenue", score: 0.9 },
              { id: "doc-2", title: "PDT margin rules", score: 0.8 },
            ],
          }),
        };
        const namespace = {
          idFromName: (name: string) => `id:${name}`,
          get: (_id: unknown) => stub,
        };
        const ctx = {
          env: { AI_SEARCH_AGENT: namespace },
          orm: undefined,
          sessionId: LOGIN,
          audit: vi.fn(),
        } as unknown as McpToolContext;
        const answer = await new AISearchAgentSearchCommand().execute(
          { query: "NVDA data center revenue" },
          ctx,
        );
        return {
          outcome: answer.data.ok ? "completed" : "error",
          facts: {
            ok: answer.data.ok,
            path: answer.data.path ?? "none",
            resultCount: answer.data.results.length,
          },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("mcp-door-identity-refusal")!,
      drive: async () => {
        const { env, scheduled } = makeDoorEnv();
        try {
          await new ListScheduledGoalsCommand().execute({}, makeCommandContext(env));
          return { outcome: "error", facts: {}, detail: "command did not refuse" } satisfies GoldenObservation;
        } catch (err) {
          return {
            outcome: "refused",
            refusalCode: identityRefusalCode(err),
            facts: { stubCalls: scheduled.calls.length },
          } satisfies GoldenObservation;
        }
      },
    },
    {
      task: goldenTask("a2a-sandbox-status")!,
      drive: async () => {
        const env = makeA2aEnv("per-surface");
        const res = await handleA2A(a2aPost("s18-surface-token"), env);
        const payload = (await res.json().catch(() => null)) as {
          result?: {
            artifacts?: Array<{
              parts?: Array<{
                kind: string;
                data?: { ok?: boolean; result?: { backendConfigured?: boolean } };
              }>;
            }>;
          };
        } | null;
        const dataPart = payload?.result?.artifacts?.[0]?.parts?.find(
          (p) => p.kind === "data",
        )?.data;
        return {
          outcome: res.status === 200 ? "completed" : "error",
          facts: {
            httpStatus: res.status,
            outcomeOk: dataPart?.ok ?? false,
            backendConfigured: dataPart?.result?.backendConfigured ?? true,
          },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("a2a-credential-refusals")!,
      drive: async () => {
        const wrongRes = await handleA2A(a2aPost("wr0ng-token"), makeA2aEnv("per-surface"));
        const wrongCode = await a2aErrorCode(wrongRes);
        const unconfRes = await handleA2A(a2aPost("anything"), makeA2aEnv("none"));
        const unconfCode = await a2aErrorCode(unconfRes);
        return {
          outcome: "refused",
          refusalCode: "credential_refused",
          facts: {
            wrongTokenStatus: wrongRes.status,
            wrongTokenCode: wrongCode ?? 0,
            unconfiguredStatus: unconfRes.status,
            unconfiguredCode: unconfCode ?? 0,
          },
        } satisfies GoldenObservation;
      },
    },
    {
      task: goldenTask("agent-as-tool-research")!,
      drive: async () => {
        const { ctx, facetCalls, agentFacade } = makeResearchDriver();
        const out = await runResearchAndPublish(ctx, "manual", LOGIN);
        return {
          outcome: out.success ? "completed" : "error",
          facts: {
            facetCalls: facetCalls.length,
            executionPath: out.executionPath ?? "none",
            fallbackRuns: agentFacade.runResearchCalls,
          },
        } satisfies GoldenObservation;
      },
    },
  ];
}

describe("golden set: G12 proof run (#2439)", () => {
  it("every golden task passes through its real door path, and the results are in the store", async () => {
    const executions = [screenExecution(), ...remainingExecutions()];
    // The executions cover the whole catalog except the HTTP task,
    // which runs in mesh_golden_http_s18_2439.test.ts, and the
    // mesh-screen-door tasks, whose drivers live with the suites
    // that own their seams: the four #2488 tasks in
    // tests/mesh_screen_door_2488.test.ts (turn/queue/executor),
    // and the #2530 dual-mode pair in
    // tests/screener_dual_mode_2530.test.ts (door → real flows).
    const DOOR_TASK_IDS = [
      "door-chat-screen-run",
      "door-chat-screen-identity-refusal",
      "door-chat-paid-screen",
      "door-chat-paid-budget-refusal",
      "door-chat-screen-run-deterministic",
      "door-chat-screen-run-non-deterministic",
    ];
    expect(executions.map((e) => e.task.id)).toEqual(
      MESH_GOLDEN_TASKS.filter(
        (t) => t.door !== "http-routes" && !DOOR_TASK_IDS.includes(t.id),
      ).map((t) => t.id),
    );

    const store = new InMemoryMeshEvalStore();
    const results = await executeGoldenTasks(executions, { store, runId: RUN_ID });
    for (const result of results) {
      expect(result.passed, `${result.taskId}: ${result.failures.join("; ")}`).toBe(true);
    }

    // Read back through the port — the record S19 consumes.
    const recorded = await store.resultsForRun(RUN_ID);
    expect(recorded.map((r) => r.taskId)).toEqual(executions.map((e) => e.task.id));
    expect(recorded.every((r) => r.passed)).toBe(true);

    // Trace evidence on the screen task: the S17 assembly joined
    // the run under one trace id, complete.
    const screen = recorded.find((r) => r.taskId === "chat-screen-run");
    expect(screen?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(screen?.traceComplete).toBe(true);
    expect(screen?.traceHopKinds).toEqual(
      expect.arrayContaining(["workflow-start", "workflow-step", "projection"]),
    );

    // The trade task's single execution carried the server-derived
    // authorizer DID (the decision command has no identity field).
    expect(approvalEvidence).toEqual([
      { executions: 1, authorizerDid: getUserDid(LOGIN) },
    ]);
  });
});
