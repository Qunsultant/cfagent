/**
 * Issue #1737 — ScreenerScreenWorkflow: the adapter-side
 * workflow class for screener decoupling. Thin by design
 * (mirroring TradingTradeWorkflow): run() validates the
 * payload, builds the flow deps from the environment, and
 * delegates to runParentFlow / runShardFlow. Every decision
 * lives in screenerWorkflowFlow.ts, behind fakeable
 * interfaces — this module is the only place that names
 * bindings, stubs, and provider types.
 *
 * Data discipline (claim-check): workflow params and
 * outputs carry commands, summaries, and flags only. The
 * child's full agent result travels store→door directly
 * inside the child run, never through a parent output.
 *
 * Base class note: ThinkWorkflow, NOT WorkflowEntrypoint.
 * WorkflowEntrypoint is undefined outside workerd — proven
 * by 28 test files failing to collect on it (the
 * `cloudflare:workers` stub in vitest carries no such
 * value). ThinkWorkflow is the repo's real runtime base
 * (TradingTradeWorkflow proves it). The agent type is
 * intentionally `any`: no Think agent exists for screener
 * (ScreenerAgent is an Agents SDK Agent) and this class
 * never uses agent tracking — runs are tracked via D1
 * projection rows + instance status, which is the design.
 */
import { ThinkWorkflow } from "@cloudflare/think/workflows";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import { createShardJobAdapter } from "../data/createShardJobPorts";
import { meshTraceStoreForEnv } from "../data/createMeshTracePorts";
import { recordWorkflowTraceHop } from "../observability/meshTrace";
import { resolveScreenerAgentName } from "../agents/screenerAgentName";
import type {
  ScreenerAgent,
  ScreenerRunRequest,
  ScreenerRunResult,
} from "../agents/screener-agent";
import type { OrchestratorAgent } from "../agents/orchestrator";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import {
  resolveScreenerNdGateFromEnv,
  screenerNdConfigErrorEvent,
} from "../config/screenerModes";
import { createScreenIntentInterpreter } from "./screenIntentInterpreter";
import { screenerOutcomeFromRunResult } from "../services/screenerFollowups";
import {
  mapInstanceStatus,
  startWorkflowInstance,
} from "./cfWorkflowAdapter";
import {
  goalResultToShardResult,
  runParentFlow,
  runShardFlow,
  type ChildWorkflowOps,
  type ScreenerWorkflowDeps,
  type ScreenerWorkflowStep,
  type ScreenRunner,
  type ShardScreenRequest,
  type ShardScreenResult,
} from "./screenerWorkflowFlow";
import type { WorkflowGoalScreenEnvelope } from "../agents/orchestrator/goalScreenDispatch";
import {
  assertWorkflowJobCommand,
  type WorkflowJobCommand,
} from "./workflowPorts";

/** Map a flow screen request onto the agent's request (explicit fields, no cast). */
function toAgentRequest(req: ShardScreenRequest): ScreenerRunRequest {
  return {
    trigger: req.trigger,
    ...(req.universe ? { universe: req.universe as ScreenerRunRequest["universe"] } : {}),
    ...(req.symbols ? { symbols: req.symbols as ScreenerRunRequest["symbols"] } : {}),
    ...(req.provider ? { provider: req.provider as ScreenerRunRequest["provider"] } : {}),
    ...(req.filters ? { filters: req.filters as ScreenerRunRequest["filters"] } : {}),
    userLogin: req.userLogin,
    ...(req.environment ? { environment: req.environment } : {}),
    ...(req.portfolioContext !== undefined ? { portfolioContext: req.portfolioContext } : {}),
    ...(req.maxItems !== undefined ? { maxItems: req.maxItems } : {}),
    ...(req.maxSymbols !== undefined ? { maxSymbols: req.maxSymbols } : {}),
  };
}

/** Map an agent result onto the flow's summary + opaque full payload. */
function toShardResult(result: ScreenerRunResult): ShardScreenResult {
  return {
    success: result.success,
    timestamp: result.timestamp,
    ...(result.universe ? { universe: result.universe } : {}),
    totalScanned: result.totalScanned,
    // Absent means no selection shortfall was recorded.
    expectedCount: result.expectedCount ?? result.totalScanned,
    matchedCount: result.matchedCount,
    ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
    ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
    ...(result.csvKey ? { csvKey: result.csvKey } : {}),
    trigger: result.trigger,
    ...(result.error ? { error: result.error } : {}),
    full: result,
  };
}

/** The ScreenerAgent stub for one owner (same addressing the routes use). */
function screenerAgentRunner(env: Env, userLogin: string): ScreenRunner {
  const id = env.SCREENER_AGENT.idFromName(resolveScreenerAgentName(env, userLogin));
  const agent = env.SCREENER_AGENT.get(id) as unknown as ScreenerAgent;
  return {
    runScreen: async (req) => toShardResult(await agent.runScreen(toAgentRequest(req))),
    // Issue #1996 — goal-screen execution for workflow children.
    // A deduplicated run without a result has no outcome to
    // store: fail loudly (step retries, then the shard fails)
    // rather than recording a fake empty success.
    runGoalScreen: async (req) => {
      const out = await agent.runGoalScreen({
        scenario: req.scenario,
        trigger: req.trigger,
        idempotencyKey: req.idempotencyKey,
        userLogin: req.userLogin,
        ...(req.environment ? { environment: req.environment } : {}),
        ...(req.assetClasses ? { assetClasses: req.assetClasses } : {}),
        ...(req.symbols ? { symbols: req.symbols } : {}),
        ...(req.provider ? { provider: req.provider } : {}),
        ...(req.providerFallback ? { providerFallback: req.providerFallback } : {}),
      });
      if (!out.result) {
        throw new Error(
          `Goal-screen workflow run ${req.idempotencyKey} was deduplicated without a result; refusing to record an empty success (issue #1996).`,
        );
      }
      return goalResultToShardResult({
        taskId: out.task.id,
        scenarioSource: req.scenarioSource,
        trigger: req.trigger,
        result: out.result,
        idempotencyKey: req.idempotencyKey,
        ...(req.provider ? { provider: req.provider } : {}),
        ...(req.providerFallback ? { providerFallback: req.providerFallback } : {}),
      });
    },
  };
}

/** The shared OrchestratorAgent stub (same addressing server.ts uses). */
function orchestratorStub(env: Env): OrchestratorAgent {
  const id = env.SEARCH_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE);
  return env.SEARCH_AGENT.get(id) as unknown as OrchestratorAgent;
}

/** Child operations against this workflow's own binding (parent → child fan-out). */
function workflowChildOps(env: Env): ChildWorkflowOps {
  return {
    createChild: async (cmd) => {
      if (!env.SCREENER_WORKFLOW) {
        throw new Error("Screener workflow binding SCREENER_WORKFLOW is not configured; cannot fan out shards.");
      }
      const { workflowId } = await startWorkflowInstance(env.SCREENER_WORKFLOW, cmd);
      return { workflowId };
    },
    getChildStatus: async (workflowId) => {
      if (!env.SCREENER_WORKFLOW) return null;
      try {
        const instance = await env.SCREENER_WORKFLOW.get(workflowId);
        const s = await instance.status();
        return {
          status: mapInstanceStatus(s.status),
          ...(s.output !== undefined ? { output: s.output } : {}),
          ...(s.error ? { error: { message: s.error.message } } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}

/** Build the flow deps for one run (command in scope for the delivery id). */
function buildDeps(env: Env, command: WorkflowJobCommand): ScreenerWorkflowDeps {
  const orchestrator = orchestratorStub(env);
  return {
    screenRunner: screenerAgentRunner(env, command.userLogin),
    shardStore: createShardJobAdapter(env),
    // Issue #1996 — goal commands store a goal canonical
    // report (source "goal_screen") through the goal door,
    // not the market door: the shapes differ, and a goal
    // result stored as a market screen would be invisible
    // to the Runs read surface.
    storeReport: async (payload) => {
      if (command.goalScreen) {
        // Issue #1997: the goal door returns the canonical
        // report id so the flow can surface it on the shard
        // row for the panel's fetch; the market door returns
        // void (no id to surface).
        return orchestrator.recordWorkflowGoalScreenReport(
          payload as WorkflowGoalScreenEnvelope,
          command.userLogin,
        );
      } else {
        await orchestrator.recordWorkflowScreenReport(payload as ScreenerRunResult);
      }
    },
    // Issue #1996 — goal commands deliver through the goal
    // delivery seam (channels + emailTo ride the command);
    // the market outcome sink is not used for goal runs,
    // matching the direct path (no deliveryId convergence
    // there either — deliver retries share the direct path's
    // at-least-once property).
    deliverOutcome: async (payload) => {
      if (command.goalScreen) {
        await orchestrator.deliverWorkflowGoalScreenOutcome(
          payload as WorkflowGoalScreenEnvelope,
          command.userLogin,
          command.goalScreen.deliver ?? [],
          command.goalScreen.emailTo,
        );
      } else {
        const outcome = screenerOutcomeFromRunResult(
          "stock",
          payload as Record<string, unknown>,
          env.APP_BASE_URL,
        );
        // Deterministic per job: a retried deliver step
        // converges in the outcome sink instead of forking
        // a second tracked record for the same shard.
        await orchestrator.deliverWorkflowScreenOutcome(
          outcome,
          command.userLogin,
          `workflow:${command.jobId}`,
        );
      }
    },
    nowMs: () => Date.now(),
    // Issue #2530: the ND mode's three deps — the gate
    // resolved from this run's env (an invalid switch value
    // fails closed to off and is logged as the config error),
    // the gateway-backed interpreter (undefined without an
    // AI binding → ND commands fail closed in the flow), and
    // the mas_events audit sink on the shared orchestrator
    // (the #2530 workflow door, next to the report doors
    // above). All three are consulted only by ND commands;
    // deterministic runs are untouched.
    ndModeEnabled: (() => {
      const gate = resolveScreenerNdGateFromEnv(env);
      if (gate.invalid) {
        console.warn(
          `[screener-workflow] ${screenerNdConfigErrorEvent()}: SCREENER_ND_MODE value ${JSON.stringify(gate.raw)} is not "on"/"off" — failing closed to off.`,
        );
      }
      return gate.enabled;
    })(),
    intentInterpreter: createScreenIntentInterpreter(env),
    auditInterpretation: async (record) => {
      await orchestrator.recordWorkflowScreenInterpretationAudit(record);
    },
    // Issue #2428 (Agent Mesh S17): step hops for this run,
    // recorded from the command's traceparent into the
    // env-resolved hop store. A command without a traceparent
    // records nothing (recordWorkflowTraceHop's contract);
    // a store failure is swallowed here — tracing degrades,
    // the run does not.
    traceHop: async (cmd, event) => {
      try {
        await recordWorkflowTraceHop(meshTraceStoreForEnv(env), cmd, event);
      } catch {
        // Best-effort by design (the #1743 degradation rule).
      }
    },
  };
}

/**
 * Adapt the provider step to the flow's minimal step
 * surface. The cast is the boundary: the flow's values are
 * plain JSON by construction (commands, summaries, flags),
 * so the provider's Serializable constraint holds.
 */
function adaptStep(step: WorkflowStep): ScreenerWorkflowStep {
  const s = step as unknown as {
    do<T>(name: string, configOrCallback: unknown, callback?: unknown): Promise<T>;
    sleep(name: string, duration: string): Promise<void>;
  };
  return {
    // Provider retries require a delay; the flow only
    // carries a limit, so the adapter owns the 1s default.
    do: (name, fn, opts) =>
      opts?.retries
        ? s.do(name, { retries: { limit: opts.retries.limit, delay: "1 seconds" } }, fn)
        : s.do(name, fn),
    // Provider sleep takes whole-second strings (no ms
    // label); ceiling to seconds. Poll granularity only —
    // deadlines are enforced by the flow's clock checks.
    sleep: (name, ms) => s.sleep(name, `${Math.max(1, Math.ceil(ms / 1000))} seconds`),
  };
}

export class ScreenerScreenWorkflow extends ThinkWorkflow<
  any,
  WorkflowJobCommand,
  DefaultProgress,
  Env
> {
  async run(
    event: WorkflowEvent<WorkflowJobCommand>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const command = event.payload;
    // Issue #1185: the workflow acts under the run owner's
    // login, recorded in the payload at start — absent
    // means the run fails closed, never under a synthetic
    // identity.
    if (!command?.userLogin) {
      throw new Error("Screener workflow payload is missing the required userLogin (issue #1185: no default identity).");
    }
    assertWorkflowJobCommand(command);
    const deps = buildDeps(this.env, command);
    const adapted = adaptStep(step);
    if (command.role === "shard") {
      return runShardFlow(command, adapted, deps);
    }
    return runParentFlow(command, adapted, deps, workflowChildOps(this.env));
  }
}
