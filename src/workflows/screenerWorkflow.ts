/**
 * Issue #1737 → #4192 — ScreenerScreenWorkflow: the adapter-side
 * workflow class for screener decoupling. Thin by design
 * (mirroring TradingTradeWorkflow): run() validates the
 * payload, builds the engine deps from the environment, and
 * dispatches via the engine (`defineJob` + `runJob`, workflow
 * step as journal), then reads back the collation artifact.
 * Every decision lives in screenerPipelineJobs.ts (the stage
 * registry) and screenerCollation.ts (the collation composer),
 * behind fakeable interfaces — this module is the only place
 * that names bindings, stubs, and provider types.
 *
 * Data discipline (claim-check): workflow params and
 * outputs carry commands, summaries, and flags only. The
 * stage outputs carry the full agent result inside the run,
 * never through a parent output.
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
import { resolveScheduleBranch } from "../services/workflowLifecycle";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { DefaultProgress } from "agents/workflows";
import type { Env } from "../types";
import { createShardJobAdapter } from "../data/createShardJobPorts";
import { meshTraceStoreForEnv } from "../data/createMeshTracePorts";
import { recordWorkflowTraceHop } from "../observability/meshTrace";
import type { OrchestratorAgent } from "../agents/orchestrator";
import { SHARED_ORCHESTRATOR_INSTANCE } from "../security/serviceIdentity";
import {
  resolveScreenerNdGateFromEnv,
  screenerNdConfigErrorEvent,
} from "../config/screenerModes";
import { createScreenIntentInterpreter } from "./screenIntentInterpreter";
import {
  validateScreenCriteriaArtifact,
  type ScreenIntentInterpreter,
  type ScreenInterpretationAuditRecord,
} from "./screenCriteriaArtifact";
import { JobPipelineControl } from "../services/jobPipelineEngine";
import type { JobPipelineStores } from "../data/jobPipelinePorts";
import type { ShardJobStore } from "../data/shardJobPorts";
import { createJobPipelineWorkflowDeps } from "./jobPipelineWorkflow";
import { ensureScreenerJob } from "../services/screenerPipelineJobs";
import {
  composeScreenerCollation,
  finalizeScreenerCollation,
  projectScreenerAnnounce,
  stageTransitionsForShard,
} from "./screenerCollation";
import {
  assertWorkflowJobCommand,
  type ParentScreenReportInput,
  type ParentScreenReportOutcome,
  type ScreenMode,
  type ShardOutcome,
  type WorkflowCollation,
  type WorkflowJobCommand,
} from "./workflowPorts";

/** The shared OrchestratorAgent stub (same addressing server.ts uses). */
function orchestratorStub(env: Env): OrchestratorAgent {
  const id = env.ORCHESTRATOR_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE);
  return env.ORCHESTRATOR_AGENT.get(id) as unknown as OrchestratorAgent;
}

/** Minimal step surface the engine dispatch needs (fakeable in tests). */
export interface ScreenerEngineStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Adapt the provider step to the dispatch's minimal step
 * surface. The cast is the boundary: the dispatch's values
 * are plain JSON by construction (commands, summaries,
 * flags), so the provider's Serializable constraint holds.
 */
function adaptStep(step: WorkflowStep): ScreenerEngineStep {
  const s = step as unknown as {
    do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  };
  return { do: (name, fn) => s.do(name, fn) };
}

/** Dependencies the engine dispatch receives (all injected; no bindings here). */
export interface ScreenerEngineDispatchDeps {
  control: JobPipelineControl;
  stores: JobPipelineStores;
  /** Projection store, or null when unbound (projection skipped, run continues). */
  shardStore: ShardJobStore | null;
  /**
   * Issue #2910 (G3): the parent canonical row — one
   * mas_reports row per parent run (generationId = jobId)
   * carrying the collation summary + child linkage.
   */
  storeParentReport?: (
    input: ParentScreenReportInput,
    userLogin: string,
  ) => Promise<ParentScreenReportOutcome>;
  /** Issue #2530: the ND mode's three deps (consulted only by ND commands). */
  ndModeEnabled?: boolean;
  intentInterpreter?: ScreenIntentInterpreter;
  auditInterpretation?: (record: ScreenInterpretationAuditRecord) => Promise<void>;
  /** Issue #2428 (Agent Mesh S17): step hops for this run (best-effort; tracing degrades, the run does not). */
  traceHop?: (
    command: WorkflowJobCommand,
    event: { kind: "workflow-step" | "projection"; operation: string },
  ) => Promise<void>;
  nowMs: () => number;
}

async function traceDispatchStep(
  deps: ScreenerEngineDispatchDeps,
  command: WorkflowJobCommand,
  operation: string,
): Promise<void> {
  try {
    await deps.traceHop?.(command, { kind: "workflow-step", operation });
  } catch {
    // Tracing degrades; the run does not (the #1743 rule).
  }
}

/**
 * Issue #2530 — the ND head: interpret → validate → audit.
 * All three are done before dispatch; a refused artifact
 * short-circuits dispatch entirely (the caller synthesizes
 * failed outcomes for every shard, so collation and
 * projection proceed through the one existing tail).
 * Deterministic runs never call this.
 */
export async function runScreenerNdHead(
  step: ScreenerEngineStep,
  deps: ScreenerEngineDispatchDeps,
  command: WorkflowJobCommand,
): Promise<
  | { ok: true; command: WorkflowJobCommand }
  | { ok: false; reasons: string[] }
> {
  const interpreter = deps.intentInterpreter!;
  const intent = command.screenIntent!;
  // Journaled: on replay the journaled artifact returns and
  // the model is not called again — replay stays
  // deterministic. A throw is infrastructure (step retries,
  // then the run errors); a returned value is the
  // validator's business.
  const artifact = await step.do("interpret-screen-intent", () =>
    interpreter.interpret({
      intent,
      ...(command.filters ? { baseFilters: command.filters } : {}),
      shardUniverses: command.shards.map((s) => s.universe ?? s.shardId),
    }),
  );
  await traceDispatchStep(deps, command, "interpret-screen-intent");
  // Deterministic validation: a pure function of the
  // journaled artifact, run in dispatch code — the same
  // verdict on every replay.
  const verdict = validateScreenCriteriaArtifact(artifact);
  const effectiveFilters = verdict.ok
    ? {
        ...(command.filters ?? {}),
        ...(verdict.filters as unknown as Record<string, unknown>),
      }
    : undefined;
  // Journaled audit: exactly-once, and the run does not
  // proceed without it (no audit, no execution). The record
  // carries prompt + raw artifact + verdict either way.
  await step.do("audit-screen-interpretation", async () => {
    await deps.auditInterpretation!({
      jobId: command.jobId,
      userLogin: command.userLogin,
      intent,
      artifact,
      validation: verdict.ok ? { ok: true } : { ok: false, reasons: verdict.reasons },
      ...(effectiveFilters ? { effectiveFilters } : {}),
    });
  });
  await traceDispatchStep(deps, command, "audit-screen-interpretation");
  if (verdict.ok) {
    // The artifact refines the command's filters per field;
    // shards, universe, provider, and deliver never change.
    return { ok: true, command: { ...command, filters: effectiveFilters } };
  }
  return { ok: false, reasons: verdict.reasons };
}

/**
 * Issue #4192 — dispatch a production screen through the
 * engine and return its collation.
 *
 * Q2 (answered by code check at the #4192 base): the
 * screener job's definition + instance live in the D1
 * (workflow-residency) stores, so host surfaces MUST use a
 * D1-backed control for a screener job — the host control
 * (DO SQLite stores) cannot see it and refuses
 * job_not_found. The control is therefore built by the
 * caller over the same stores the dispatch uses.
 *
 * Q4: the ND head is an adapter gate before dispatch.
 * Q3 (working default, not a ruling): per-run definitions
 * accumulate as the run-record shape (no deleteDefinition
 * exists), same order as today's per-run rows.
 */
export async function runScreenerScreenOnEngine(
  step: ScreenerEngineStep,
  deps: ScreenerEngineDispatchDeps,
  command: WorkflowJobCommand,
): Promise<WorkflowCollation> {
  // Shard-role commands no longer exist: nothing creates
  // child workflows anymore. A shard command reaching the
  // dispatch refuses by name instead of fanning out.
  if (command.role === "shard") {
    throw new Error(
      "SCREENER_SHARD_ROLE_RETIRED: shard-role screen commands are retired with the bespoke flow (issue #4192) — the engine dispatches the parent command's shards as job units, never as child workflows.",
    );
  }
  const screenMode: ScreenMode = command.screenMode ?? "deterministic";
  const startedAtMs = deps.nowMs();
  // Issue #2530: ND admission is checked HERE, at the
  // workflow boundary, before anything is announced or
  // started: gate closed, no interpreter, or no audit sink
  // each refuse the run — a direct workflow start cannot
  // bypass the flag, invent criteria, or run unaudited.
  if (screenMode === "non-deterministic") {
    if (deps.ndModeEnabled !== true) {
      throw new Error(
        "Non-deterministic screen run refused: the SCREENER_ND_MODE gate is closed in this environment (issue #2530: the mode ships flag-OFF; seams and direct starts alike are refused while it is off).",
      );
    }
    if (!deps.intentInterpreter) {
      throw new Error(
        "Non-deterministic screen run refused: no screen-intent interpreter is configured for this workflow (issue #2530: without a model seam the run fails closed — it never falls back to a deterministic execution the caller did not ask for).",
      );
    }
    if (!deps.auditInterpretation) {
      throw new Error(
        "Non-deterministic screen run refused: no interpretation audit sink is configured for this workflow (issue #2530: no audit, no execution).",
      );
    }
    if (typeof command.screenIntent !== "string" || command.screenIntent.trim().length === 0) {
      throw new Error(
        "Non-deterministic screen run refused: the command carries no screenIntent (issue #2530: assertWorkflowJobCommand normally guarantees one).",
      );
    }
  }

  // Announce: the parent row exists from the start, so
  // jobs/history shows progress while the run executes.
  await step.do("announce", () =>
    projectScreenerAnnounce(
      { shardStore: deps.shardStore, nowMs: deps.nowMs },
      command,
      screenMode,
    ),
  );
  await traceDispatchStep(deps, command, "announce");

  // Issue #2530 — the ND head: interpret → validate → audit.
  // A refused artifact starts ZERO shards. Every shard is
  // a failed outcome carrying the refusal reasons, so the
  // run's record is a Failed collation — a business refusal,
  // not an infra error.
  let runCommand = command;
  if (screenMode === "non-deterministic") {
    const head = await runScreenerNdHead(step, deps, command);
    if (!head.ok) {
      const outcomes: ShardOutcome[] = command.shards.map((shard) => ({
        shardId: shard.shardId,
        status: "failed",
        error: `Non-deterministic screen refused before execution: ${head.reasons.join("; ")}`,
      }));
      return finalizeScreenerCollation(
        {
          shardStore: deps.shardStore,
          storeParentReport: deps.storeParentReport,
          nowMs: deps.nowMs,
          ...(deps.traceHop ? { traceHop: deps.traceHop } : {}),
        },
        {
          command,
          outcomes,
          lifecycleTransitions: [
            { lifecycle: "Idle", atMs: startedAtMs },
            { lifecycle: "Running", atMs: startedAtMs },
          ],
          stageTransitions: outcomes.flatMap((o) => stageTransitionsForShard(o, startedAtMs)),
          screenMode,
          startedAtMs,
        },
      );
    }
    runCommand = head.command;
  }

  // Define the per-run job on the engine (skip re-define
  // when the raw config already matches) and dispatch it
  // to settlement — the workflow is the async boundary.
  await ensureScreenerJob(deps.control, deps.stores, runCommand);
  const dispatch = await deps.control.runJob(runCommand.jobId, {
    trigger: runCommand.trigger,
    // Issue #4357 — the join key: the engine job id IS the bridge
    // id for a chat stock screen, so the terminal D1 record carries
    // it and links to the bridge row that dispatched this run.
    asyncJobId: runCommand.jobId,
  });
  const outcome = dispatch.completion
    ? await dispatch.completion
    : {
        jobId: runCommand.jobId,
        runId: dispatch.runId,
        state: dispatch.state,
        artifactKeys: [],
      };
  return composeScreenerCollation(deps, runCommand, outcome.runId, outcome);
}

/** Build the dispatch deps for one run (shard store + parent door + ND deps + traceHop). */
function buildDeps(
  env: Env,
  command: WorkflowJobCommand,
): Omit<ScreenerEngineDispatchDeps, "control" | "stores"> {
  const orchestrator = orchestratorStub(env);
  return {
    shardStore: createShardJobAdapter(env),
    // Issue #2910 (G3): the parent canonical row — one
    // mas_reports row per parent run (generationId = jobId)
    // carrying the collation summary + child linkage,
    // through the orchestrator's parent door. Summary
    // only: the children already stored their full rows,
    // and the parent row never triggers delivery.
    storeParentReport: async (input) => {
      // The parent door returns its canonical report id, or
      // null when the row could not be written (owner
      // missing, store refused): the dispatch records that
      // outcome truthfully instead of claiming a store that
      // never landed — the run still continues. The owner
      // rides on the input (command.userLogin, stamped by
      // the dispatch), so the door takes no second login arg.
      const stored = await orchestrator.recordWorkflowParentScreenReport(input);
      return stored
        ? { stored: true, reportId: stored.reportId }
        : { stored: false, storeError: "Parent canonical row was not written (store refused or owner missing)." };
    },
    nowMs: () => Date.now(),
    // Issue #2530: the ND mode's three deps — the gate
    // resolved from this run's env (an invalid switch value
    // fails closed to off and is logged as the config error),
    // the gateway-backed interpreter (undefined without an
    // AI binding → ND commands fail closed in the dispatch),
    // and the mas_events audit sink on the shared orchestrator
    // (the #2530 workflow door, next to the report door
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
    // Issue #3021 (deliverable a): a binding-schedule firing carries
    // event.schedule and no command payload. It must be handled
    // BEFORE the userLogin gate — a schedule firing has no run owner
    // and must not fail closed as a missing identity, and must not
    // execute screens the tick still owns. At ship the branch
    // evaluates binding-owned schedules only (none migrated yet), so
    // a firing completes as an explicit cheap skip, logged, with no
    // ledger row and no duplicate execution. The first schedule
    // migration (evaluation + ownership + tick-skip) is a follow-up:
    // until it lands, the binding schedule's visible run is its
    // config row on the Workflow Runs page, and firings stay cheap.
    const scheduleBranch = resolveScheduleBranch(event);
    if (scheduleBranch.handled) {
      console.log(
        `[screener-workflow] binding-schedule firing (${scheduleBranch.cron}) — no binding-owned schedules due; skipping without executing (issue #3021).`,
      );
      return {
        scheduleFiring: true,
        cron: scheduleBranch.cron,
        scheduledTime: scheduleBranch.scheduledTime ?? null,
        bindingOwnedDue: 0,
        outcome: "no binding-owned schedules due",
      };
    }
    const command = event.payload;
    // Issue #1185: the workflow acts under the run owner's
    // login, recorded in the payload at start — absent
    // means the run fails closed, never under a synthetic
    // identity.
    if (!command?.userLogin) {
      throw new Error("Screener workflow payload is missing the required userLogin (issue #1185: no default identity).");
    }
    assertWorkflowJobCommand(command);
    // The engine deps for this residency (D1 stores, the
    // composed step registry incl. the screener steps), with
    // the workflow step as the journal — the journal makes
    // step invocations replay-safe.
    const engineDeps = createJobPipelineWorkflowDeps(this.env);
    const adapted = adaptStep(step);
    const control = new JobPipelineControl({
      ...engineDeps,
      journal: adapted,
    });
    return runScreenerScreenOnEngine(
      adapted,
      {
        control,
        stores: engineDeps.stores,
        ...buildDeps(this.env, command),
      },
      command,
    );
  }
}
