/**
 * Issue #2439 (Agent Mesh S18, programme #2225 G13b) — the
 * golden-task eval harness: the proof surface for G12 (every
 * capability every door) and the evaluation leg of G13's RSI
 * loop.
 *
 * Shape:
 *  - MESH_GOLDEN_TASKS is the task catalog, declared as data:
 *    id, door, fleet class, the S15 census operation it proves,
 *    and an explicit falsifiable expectation (outcome, refusal
 *    code, exact-match facts, required S17 trace hop kinds).
 *    Every task's (class, door) cell is a cell of the S15 census
 *    (src/agents/registry.ts MESH_CAPABILITY_DOORS) — exposed
 *    cells are driven to their outcome, and a not-exposed cell
 *    may be named only by a gate task proving its recorded
 *    refusal — pinned in tests/mesh_golden_tasks_s18_2439.test.ts.
 *  - A GoldenTaskExecution pairs a task with a drive: a function
 *    that runs the REAL door path (fakes only at binding seams,
 *    the programme acceptance rule) and returns a scalar
 *    observation. Drivers live with the suites that own the
 *    seams; this module owns scoring and recording.
 *  - executeGoldenTasks runs executions in order, assembles each
 *    run's S17 trace where the drive produced a trace id,
 *    evaluates the expectation, and records every result in the
 *    eval result store (src/data/meshEvalPorts.ts) — the record
 *    S19's proposal pipeline reads. A task whose expectation is
 *    wrong records a FAILURE: the harness can fail, or it proves
 *    nothing.
 *
 * The claim this supports (recorded in the registry as
 * MESH_G12_PROOF): G12 is proven for the five doors, by the
 * golden tasks in this catalog, at the binding-seam fidelity the
 * programme's acceptance rule defines. Cells the catalog does
 * not exercise are not claimed here — the catalog is the claim's
 * scope, and it is enumerable.
 */
import { AGENTIC_SPEND_AGENT_ID } from "../payments/ledger";
import type { MeshCapabilityDoorEntry } from "../agents/registry";
import type {
  GoldenObservation,
  MeshEvalExpectation,
  MeshEvalResultStore,
  MeshEvalTaskResult,
} from "../data/meshEvalPorts";

export type { GoldenObservation, MeshEvalExpectation, MeshEvalTaskResult };

/** One golden task, declared as data. */
export interface MeshGoldenTask {
  id: string;
  title: string;
  door: MeshCapabilityDoorEntry["door"];
  className: string;
  /** The census operation this task proves (route shape for HTTP cells). */
  operation: string;
  /**
   * The census status of the task's cell (default "exposed").
   * A "not-exposed" task is a gate proof: its expectation must be
   * the refusal the census's recorded reason describes (the
   * census's honest negative is a deliverable — S18 proves it
   * behaviorally instead of leaving it as prose).
   */
  cellStatus?: "exposed" | "not-exposed";
  expectation: MeshEvalExpectation;
}

/** The assembled-trace summary a runner seam returns for one trace id. */
export interface GoldenTraceAssembly {
  kinds: string[];
  complete: boolean;
}

/** A task plus the drive that runs its real door path. */
export interface GoldenTaskExecution {
  task: MeshGoldenTask;
  drive: () => Promise<GoldenObservation>;
  /** Per-execution trace assembler (wins over the run-level one). */
  assembleTrace?: (traceId: string) => Promise<GoldenTraceAssembly>;
}

export interface GoldenRunOptions {
  store: MeshEvalResultStore;
  /** Absent → a generated `mesh-eval:<ISO>` id. */
  runId?: string;
  nowMs?: () => number;
  /** Run-level trace assembler (e.g. over the S17 read surface). */
  assembleTrace?: (traceId: string) => Promise<GoldenTraceAssembly>;
}

/* ------------------------------------------------------------------ */
/* The catalog                                                         */
/* ------------------------------------------------------------------ */

export const MESH_GOLDEN_TASKS: readonly MeshGoldenTask[] = [
  {
    id: "chat-screen-run",
    title: "NLQ-surface stock screen runs as a ScreenerScreenWorkflow run (S8 path, via the NLQ stock-screen port — the surface the async nlq.execute capability, A2A, and the error fallback bind; since #2488 the chat turn itself reaches the same workflow through the door tasks below)",
    door: "chat-turn",
    className: "ScreenerAgent",
    operation: "nlq.execute",
    expectation: {
      outcome: "completed",
      facts: { workflowStarts: 1, matchedCount: 2 },
      traceHopKinds: ["workflow-start", "workflow-step", "projection"],
    },
  },
  {
    id: "chat-screen-identity-refusal",
    title: "NLQ-surface screen refuses with no acting identity, before any workflow start (NLQ stock-screen port)",
    door: "chat-turn",
    className: "ScreenerAgent",
    operation: "nlq.execute",
    expectation: {
      outcome: "refused",
      refusalCode: "identity_required",
      facts: { workflowStarts: 0 },
    },
  },
  {
    id: "door-chat-screen-run",
    title: "Chat-turn stock screen through the mesh screen door runs as a ScreenerScreenWorkflow run (#2488 door path: turn tool → queue → executor → run_stock_screen → door service)",
    door: "chat-turn",
    className: "ScreenerAgent",
    operation: "run_stock_screen",
    expectation: {
      outcome: "completed",
      facts: { workflowStarts: 1, matchedCount: 2 },
      traceHopKinds: ["workflow-start", "workflow-step", "projection"],
    },
  },
  {
    id: "door-chat-screen-identity-refusal",
    title: "Chat-turn screen refuses with no acting identity, before any queue or workflow start — since #2496 the SDK loopback carrier refuses the discovered call (mesh_mcp_identity_required); the door's own identity_required refusal still guards the execution layer (#2488)",
    door: "chat-turn",
    className: "ScreenerAgent",
    operation: "run_stock_screen",
    expectation: {
      outcome: "refused",
      refusalCode: "mesh_mcp_identity_required",
      facts: { workflowStarts: 0 },
    },
  },
  {
    id: "chat-trade-approval",
    title: "Chat trade runs the approval door into TradingTradeWorkflow and executes exactly once on approval (S9 path)",
    door: "chat-turn",
    className: "TradingAgent",
    operation: "start_trade_approval",
    expectation: {
      outcome: "completed",
      facts: { workflowRuns: 1, brokerExecutions: 1 },
    },
  },
  {
    id: "chat-trade-identity-refusal",
    title: "Chat trade approval refuses with no acting identity, before the approval door",
    door: "chat-turn",
    className: "TradingAgent",
    operation: "start_trade_approval",
    expectation: {
      outcome: "refused",
      refusalCode: "identity_required",
      facts: { workflowRuns: 0, brokerExecutions: 0 },
    },
  },
  {
    id: "chat-paid-screen",
    title: "NLQ-surface paid request: budget door, one PaymentWorkflow start, screener started by the payment flow (S10 path, via the NLQ stock-screen port)",
    door: "chat-turn",
    className: "PaymentsAgent",
    operation: "check_payment_budget",
    expectation: {
      outcome: "completed",
      facts: { budgetChecks: 1, paymentStarts: 1, screenerStarts: 1, coverageConsumed: 1 },
    },
  },
  {
    id: "chat-paid-budget-refusal",
    title: "NLQ-surface paid request refuses on a budget denial: zero payment starts, zero screener runs, no free fallback (NLQ stock-screen port)",
    door: "chat-turn",
    className: "PaymentsAgent",
    operation: "check_payment_budget",
    expectation: {
      outcome: "refused",
      refusalCode: "budget_denied",
      facts: { budgetChecks: 1, paymentStarts: 0, screenerStarts: 0 },
    },
  },
  {
    id: "door-chat-paid-screen",
    title: "Chat paid request through the mesh screen door: budget door, one PaymentWorkflow start, screener started by the payment flow (#2488 door path)",
    door: "chat-turn",
    className: "ScreenerAgent",
    operation: "run_stock_screen",
    expectation: {
      outcome: "completed",
      facts: { budgetChecks: 1, paymentStarts: 1, screenerStarts: 1, coverageConsumed: 1 },
    },
  },
  {
    id: "door-chat-paid-budget-refusal",
    title: "Chat paid request through the mesh screen door refuses on a budget denial: zero payment starts, zero screener runs, no free fallback (#2488)",
    door: "chat-turn",
    className: "ScreenerAgent",
    operation: "run_stock_screen",
    expectation: {
      outcome: "refused",
      refusalCode: "budget_denied",
      facts: { budgetChecks: 1, paymentStarts: 0, screenerStarts: 0 },
    },
  },
  {
    id: "chat-budget-check",
    title: "Chat-turn budget check returns the guard's verdict under the orchestrator spend bucket",
    door: "chat-turn",
    className: "PaymentsAgent",
    operation: "check_payment_budget",
    expectation: {
      outcome: "completed",
      facts: { allowed: true, agentId: AGENTIC_SPEND_AGENT_ID },
    },
  },
  {
    id: "scheduled-goal-trigger",
    title: "Scheduled-goal door triggers a real tick through the chat-turn door",
    door: "chat-turn",
    className: "ScheduledAgent",
    operation: "trigger_scheduled_goal",
    expectation: {
      outcome: "completed",
      facts: { jobsCreated: 1 },
    },
  },
  {
    id: "mcp-ai-search",
    title: "MCP door: ai_search_agent_search reaches AiSearchAgent through the catalog's class-addressing command",
    door: "mcp",
    className: "AiSearchAgent",
    operation: "ai_search_agent_search",
    expectation: {
      outcome: "completed",
      facts: { ok: true, path: "namespace", resultCount: 2 },
    },
  },
  {
    id: "mcp-door-identity-refusal",
    title: "MCP door negative (census not-exposed): a mesh-door command refuses with no acting-login carrier, before any stub is resolved",
    door: "mcp",
    className: "ScheduledAgent",
    operation: "list_scheduled_goals",
    cellStatus: "not-exposed",
    expectation: {
      outcome: "refused",
      refusalCode: "identity_required",
      facts: { stubCalls: 0 },
    },
  },
  {
    id: "a2a-sandbox-status",
    title: "A2A sandbox surface answers through the real edge under its per-surface credential, degradation stated honestly",
    door: "a2a",
    className: "SandboxAgent",
    operation: "sandbox.status",
    expectation: {
      outcome: "completed",
      facts: { httpStatus: 200, outcomeOk: true, backendConfigured: false },
    },
  },
  {
    id: "a2a-credential-refusals",
    title: "A2A edge refuses a wrong credential (401 / -32002) and an unconfigured surface (503 / -32001), #1763 contract",
    door: "a2a",
    className: "SandboxAgent",
    operation: "sandbox.status",
    expectation: {
      outcome: "refused",
      refusalCode: "credential_refused",
      facts: {
        wrongTokenStatus: 401,
        wrongTokenCode: -32002,
        unconfiguredStatus: 503,
        unconfiguredCode: -32001,
      },
    },
  },
  {
    id: "agent-as-tool-research",
    title: "Agent-as-a-tool dispatch runs the ResearchAgent child turn and publishes its fresh report (no fallback)",
    door: "agent-as-a-tool",
    className: "ResearchAgent",
    operation: "runAgentTool",
    expectation: {
      outcome: "completed",
      facts: { facetCalls: 1, executionPath: "agent", fallbackRuns: 0 },
    },
  },
  {
    id: "http-schedule-goals",
    title: "HTTP door: /api/schedule/goals refuses anonymously (401) and serves the catalogue to a session",
    door: "http-routes",
    className: "ScheduledAgent",
    operation: "GET /api/schedule/goals",
    expectation: {
      outcome: "completed",
      facts: { unauthenticatedStatus: 401, authenticatedStatus: 200, goalCount: 2 },
    },
  },
];

const TASKS_BY_ID = new Map(MESH_GOLDEN_TASKS.map((t) => [t.id, t]));

/** Look up one catalog task by id. */
export function goldenTask(id: string): MeshGoldenTask | undefined {
  return TASKS_BY_ID.get(id);
}

/* ------------------------------------------------------------------ */
/* Evaluation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Score one observation against its task's expectation. Pure and
 * total: every mismatch is a named failure, and a driver error is
 * a failure, never a pass and never a throw.
 */
export function evaluateGoldenObservation(
  task: MeshGoldenTask,
  observation: GoldenObservation,
  trace?: GoldenTraceAssembly,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const expectation = task.expectation;

  if (observation.outcome === "error") {
    failures.push(
      `driver error: ${observation.detail ?? "the drive did not complete"}`,
    );
    return { passed: false, failures };
  }
  if (observation.outcome !== expectation.outcome) {
    failures.push(
      `outcome: expected ${expectation.outcome}, observed ${observation.outcome}`,
    );
  }
  if (expectation.outcome === "refused") {
    if (!observation.refusalCode) {
      failures.push("refusalCode: expected a refusal code, observed none");
    } else if (
      expectation.refusalCode &&
      observation.refusalCode !== expectation.refusalCode
    ) {
      failures.push(
        `refusalCode: expected ${expectation.refusalCode}, observed ${observation.refusalCode}`,
      );
    }
  }
  for (const [key, value] of Object.entries(expectation.facts ?? {})) {
    if (observation.facts[key] !== value) {
      failures.push(
        `fact ${key}: expected ${JSON.stringify(value)}, observed ${JSON.stringify(observation.facts[key])}`,
      );
    }
  }
  if (expectation.traceHopKinds && expectation.traceHopKinds.length > 0) {
    if (!observation.traceId) {
      failures.push(
        "trace: the expectation requires trace hop kinds but the run produced no trace id",
      );
    } else if (!trace) {
      failures.push("trace: no assembly was produced for the run's trace id");
    } else {
      for (const kind of expectation.traceHopKinds) {
        if (!trace.kinds.includes(kind)) {
          failures.push(
            `trace: required hop kind ${kind} missing from the assembled trace`,
          );
        }
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

/**
 * Run executions in order: drive, assemble the trace where the
 * drive produced a trace id, evaluate, record. Recording happens
 * for passes and failures alike — the store is the evidence, and
 * a run that hid its failures would prove nothing.
 */
export async function executeGoldenTasks(
  executions: readonly GoldenTaskExecution[],
  options: GoldenRunOptions,
): Promise<MeshEvalTaskResult[]> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const runId = options.runId ?? `mesh-eval:${new Date(nowMs()).toISOString()}`;
  const results: MeshEvalTaskResult[] = [];

  let seq = 0;
  for (const execution of executions) {
    const startedAtMs = nowMs();
    let observation: GoldenObservation;
    try {
      observation = await execution.drive();
    } catch (err) {
      observation = {
        outcome: "error",
        facts: {},
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    let trace: GoldenTraceAssembly | undefined;
    const assembler = execution.assembleTrace ?? options.assembleTrace;
    if (observation.traceId && assembler) {
      try {
        trace = await assembler(observation.traceId);
      } catch {
        trace = undefined;
      }
    }

    const verdict = evaluateGoldenObservation(execution.task, observation, trace);
    const result: MeshEvalTaskResult = {
      runId,
      taskId: execution.task.id,
      door: execution.task.door,
      className: execution.task.className,
      seq: seq++,
      passed: verdict.passed,
      outcome: observation.outcome,
      ...(observation.refusalCode ? { refusalCode: observation.refusalCode } : {}),
      failures: verdict.failures,
      ...(observation.traceId ? { traceId: observation.traceId } : {}),
      ...(trace
        ? { traceHopKinds: trace.kinds, traceComplete: trace.complete }
        : {}),
      facts: observation.facts,
      startedAtMs,
      durationMs: Math.max(0, nowMs() - startedAtMs),
    };
    await options.store.record(result);
    results.push(result);
  }
  return results;
}
