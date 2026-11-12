/**
 * DEPRECATED — frozen 2026-11-12 (#4192, #3550 S2 cutover).
 *
 * Production screens no longer dispatch through these flows:
 * `ScreenerScreenWorkflow.run()` dispatches through the one
 * workflow engine (`src/services/screenerPipelineJobs.ts` +
 * `src/agents/screener-agent.ts` stage methods) and reads the
 * collation back from `src/workflows/screenerCollation.ts`.
 * Nothing imports this file anymore; it is kept frozen as the
 * reference implementation of the retired child-workflow
 * fan-out, and per the no-deletion rule it is renamed, not
 * deleted. Superseded by `src/workflows/screenerWorkflow.ts`
 * (dispatch) + `src/workflows/screenerCollation.ts`
 * (collation) + `src/services/screenerPipelineJobs.ts`
 * (definition). Do not extend this file; do not re-enable it.
 *
 * Issue #1737 — the screener workflow flows: the unit-testable
 * execution behind the workflow class. The class itself is a
 * thin adapter (it builds these deps from the environment and
 * delegates); every decision lives here, behind fakeable
 * interfaces, so tests drive the whole lifecycle without a
 * provider runtime.
 *
 * Two flows, one class, two roles (see the port module):
 *  - runShardFlow: one shard's screen. Executes the screen
 *    through the injected runner, stores and delivers its
 *    own full result, projects its shard row, and returns
 *    the summary + store/deliver flags as the workflow
 *    output. A screen that returns success:false is a
 *    BUSINESS outcome (the child completes with a failed
 *    output — no step retry); a runner that THROWS is an
 *    infrastructure failure (the step retries up to
 *    WORKFLOW_STEP_MAX_RETRIES, then the child errors and
 *    the parent marks the shard failed). The child owns
 *    store/deliver because it holds the full result: the
 *    parent never sees bulk data (claim-check). Store is
 *    idempotent by key (screener:<timestamp>); deliver
 *    carries a deterministic deliveryId
 *    (workflow:<jobId>:<shardId>) so re-delivery converges
 *    in the outcome sink. A store/deliver error is recorded,
 *    never fatal: the screen outcome stands.
 *  - runParentFlow: fan-out, poll, collate, project, store
 *    parent. Shards run as child workflows in batches of
 *    maxParallelShards; the parent polls child statuses on
 *    a sleep loop and enforces a per-shard deadline. A shard
 *    past its deadline is timed_out and collation proceeds
 *    with a qualified partial — never a total failure.
 *    Timed-out children are NOT terminated: they may still
 *    complete and project their own row, and the parent's
 *    collation stands as the deadline-time truth. Issue
 *    #2910 (G3): after projection the parent stores ONE
 *    canonical mas_reports row for the parent run
 *    (generationId = jobId, collation + child linkage,
 *    summary only — no bulk data, no fabricated results).
 *    The parent still never DELIVERS: delivery stays with
 *    the children, whose flags the parent collates.
 *
 * Durability shape: every durable fact is a step output or a
 * projection row. The parent reads child SUMMARIES from
 * child instance outputs (status().output), never from rows
 * — rows are progress visibility (jobs/history), not the
 * result channel. The parent collates the children's
 * stored/delivered flags into the parent row's collation
 * summary and, since #2910 (G3), stores one parent
 * canonical row from that collation (summary + linkage
 * only); it never delivers. Projection and parent-store
 * failures never fail a run (R5): a failed project or
 * store is recorded in the result and the run continues.
 *
 * Stage honesty: a completed shard ran feed (quotes),
 * gather (technicals/enrichment), and analysis (screen)
 * inside the delegated screen, in that order — so the parent
 * records feed/gather/analysis completed for it. A failed or
 * timed-out shard records only analysis.failed: how far its
 * internal pipeline got is unobserved, so feed/gather are
 * left unrecorded rather than claimed.
 *
 * Issue #2530 — the non-deterministic mode (design option
 * (a)): a parent command with screenMode "non-deterministic"
 * runs THREE extra steps at its head, before fan-out, and
 * nothing else changes. (1) interpret-screen-intent: the
 * injected interpreter proposes screen criteria as a data
 * artifact — journaled, so replay returns the journaled
 * artifact and never re-calls the model. (2) Deterministic
 * validation (pure flow code over the journaled artifact).
 * (3) audit-screen-interpretation: prompt + artifact +
 * verdict recorded in mas_events — journaled, exactly-once,
 * and the run does not proceed without it. A refused
 * artifact ends the run as a Failed collation with zero
 * shards started; a validated artifact's filters refine the
 * command's per field and fan-out proceeds verbatim.
 * Deterministic commands run none of this.
 */

import {
  fanoutCapExceeded,
  planNext,
  planRun,
  planStageFanout,
} from "./stageRunnerPlan";
import {
  STAGE_RETRY_BUCKET,
  type StageRunnerCheckpoint,
  type StageRunnerPlan,
  type StageRunnerStage,
} from "./stageRunnerPorts";
import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  SHARD_DONE_EVENT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SHARD_TIMEOUT_MS,
  WORKFLOW_STEP_MAX_RETRIES,
  workflowIdForJob,
  type ParentScreenReportInput,
  type ParentScreenReportOutcome,
  type ScreenMode,
  type ShardOutcome,
  type StageTransition,
  type WorkflowCollation,
  type WorkflowInstanceStatus,
  type WorkflowJobCommand,
  type WorkflowRunLifecycle,
} from "./workflowPorts";
import {
  validateScreenCriteriaArtifact,
  type ScreenIntentInterpreter,
  type ScreenInterpretationAuditRecord,
} from "./screenCriteriaArtifact";
import {
  projectLegOutcomes,
  SHARD_JOB_RESULT_JSON_MAX,
} from "../data/shardJobProjection";
import type { LegOutcome, ShardJobStore } from "../data/shardJobPorts";
import type { GoalDrivenScreenResult } from "../services/goalDrivenScreen";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";
// The pure collation helpers moved to screenerCollation.ts in
// #4192; this frozen file imports them back (one home, no copy).
import {
  SCREENER_WORKFLOW_CAPABILITY,
  WORKFLOW_PROVENANCE_WRITER,
  WORKFLOW_WORKSPACE_ID,
  asShardScreenResult,
  collateShards,
  collationDetail,
  goalShardRequest,
  shardCommandFor,
  shardScreenRequest,
  shardSummaryFromResult,
  stageTransitionsForShard,
  type ScreenerWorkflowDeps,
  type ShardScreenResult,
} from "./screenerCollation";

/** Minimal step surface the flows need (fakeable in tests). */
export interface ScreenerWorkflowStep {
  do<T>(
    name: string,
    fn: () => Promise<T>,
    opts?: { retries?: { limit: number } },
  ): Promise<T>;
  sleep(name: string, durationMs: number): Promise<void>;
  /**
   * Issue #3025: durable wait on a shard-completion event, bounded by
   * the shard deadline. Optional so a test double (or an older
   * adapter) that cannot wait keeps the deadline-bounded sleep path
   * instead — the decisions are identical either way.
   */
  waitForEvent?<T>(
    name: string,
    opts: { type: string; timeoutMs: number },
  ): Promise<T>;
}

/** Child-workflow operations, as the parent flow sees them. */
export interface ChildWorkflowOps {
  createChild(
    command: WorkflowJobCommand,
  ): Promise<{ workflowId: string }>;
  getChildStatus(
    workflowId: string,
  ): Promise<{
    status: WorkflowInstanceStatus;
    output?: unknown;
    error?: { message: string };
  } | null>;
}


/**
 * The screen result one shard returns (structural subset of
 * the agent's result, plus the child's own store/deliver
 * flags). `full` is the OPAQUE full agent result: present
 * only inside the child run, where the child's store/deliver
 * steps consume it — it is STRIPPED from the child output
 * before return, so workflow outputs and the parent
 * collation never carry bulk data (claim-check: outputs
 * carry ids + summaries + flags only).
 */



/** Issue #2428: record one trace hop for a completed step, best-effort (never throws into the flow). */
async function traceStep(
  deps: ScreenerWorkflowDeps,
  command: WorkflowJobCommand,
  kind: "workflow-step" | "projection",
  operation: string,
): Promise<void> {
  try {
    await deps.traceHop?.(command, { kind, operation });
  } catch {
    // Tracing degrades; the run does not (the #1743 rule).
  }
}



/**
 * Pure collation: shard outcomes → the parent summary.
 * Lifecycle: Failed when no shard completed; ReportGenerated
 * when every completed shard was stored by its child;
 * Completed otherwise (qualified when any shard failed or
 * timed out). Stored/delivered sets and error maps come
 * from the child outputs' flags — collation itself stores
 * nothing; the parent canonical row is written by
 * runParentFlow's store-parent step from this collation
 * (issue #2910), and the parent never delivers.
 */
/** Cap a JSON summary the way the projector does (never over the row cap). */
function capSummaryJson(value: unknown): string {
  try {
    const json = JSON.stringify(value ?? null);
    return json.length <= SHARD_JOB_RESULT_JSON_MAX
      ? json
      : json.slice(0, SHARD_JOB_RESULT_JSON_MAX) + "[truncated]";
  } catch {
    return '"[unserializable]"';
  }
}

/** Issue #2129: a projection failure never fails the run, but it
 * must leave a worker-log trace naming the chain, the stage, and
 * the cause — the silent no-op is what made vanished runs
 * untraceable from the panel's empty history. */
function warnUnprojected(chainId: string, stage: string, result: { projected: boolean; error?: string }): void {
  if (!result.projected) {
    console.warn(`[screener-workflow] projection failed for chain ${chainId} stage ${stage}: ${result.error ?? "unknown"}`);
  }
}

/** Project legs best-effort (a projection failure never fails the run). */
async function projectBestEffort(
  deps: ScreenerWorkflowDeps,
  tenantId: string | undefined,
  chainId: string,
  legs: LegOutcome[],
  nowMs: number,
): Promise<{ projected: boolean; error?: string }> {
  // Issue #2129: name the no-op cause — a bare { projected: false }
  // left vanished runs traceless (empty history, no log line).
  if (!deps.shardStore) return { projected: false, error: "shard store unavailable" };
  if (!tenantId) return { projected: false, error: "tenantId missing" };
  try {
    const result = await projectLegOutcomes({
      store: deps.shardStore,
      tenantId,
      workspaceId: WORKFLOW_WORKSPACE_ID,
      chainId,
      legs,
      nowMs,
      writer: WORKFLOW_PROVENANCE_WRITER,
      provenanceSourceDo: "ScreenerWorkflow",
    });
    return { projected: result.projected, error: result.error };
  } catch (err) {
    return {
      projected: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}


/**
 * Run one shard: execute, store, deliver, project, return
 * the summary. The child OWNS store and deliver of its own
 * full result — it holds the full result in hand, so the
 * parent never needs bulk data (claim-check: the child
 * output carries the summary + store/deliver flags only,
 * `full` stripped). Store/deliver run for failed screens
 * too (a canonical record of the attempt, matching the
 * sync path, which persists and publishes failures). A
 * store/deliver error is recorded on the output, never
 * fatal: the screen outcome stands.
 */
export async function runShardFlow(
  command: WorkflowJobCommand,
  step: ScreenerWorkflowStep,
  deps: ScreenerWorkflowDeps,
): Promise<ShardScreenResult> {
  const shardId = command.shard?.shardId ?? "unknown";
  // Issue #1996 — goal commands execute the goal runner, never
  // the market runner: a goal run silently executed as a market
  // screen would be a wrong-semantics success. A runner without
  // goal support throws here (step retries, then the shard
  // fails loudly) — fail closed, never fall back.
  const result = command.goalScreen
    ? await step.do(
        "execute-goal-screen",
        () => {
          const runGoalScreen = deps.screenRunner.runGoalScreen;
          if (!runGoalScreen) {
            throw new Error(
              "Goal-screen workflow command reached a runner without runGoalScreen — refusing a market-screen fallback for a goal run (issue #1996).",
            );
          }
          return runGoalScreen(goalShardRequest(command));
        },
        { retries: { limit: WORKFLOW_STEP_MAX_RETRIES } },
      )
    : await step.do(
        "execute-screen",
        () => deps.screenRunner.runScreen(shardScreenRequest(command)),
        { retries: { limit: WORKFLOW_STEP_MAX_RETRIES } },
      );
  await traceStep(deps, command, "workflow-step", command.goalScreen ? "execute-goal-screen" : "execute-screen");
  // Issue #2080: the canonical body must carry the run's trigger and its
  // full artifact set. The child summary is the fallback payload, so the
  // trigger rides on it explicitly (a summary never carried one).
  const payload = {
    ...((result.full as Record<string, unknown> | undefined) ?? result),
    // Issue #2080: keys recorded on the shard summary win over a full
    // envelope that predates them, so the canonical body always carries
    // the artifacts this run actually produced.
    ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
    ...(result.csvKey ? { csvKey: result.csvKey } : {}),
    trigger: command.trigger,
  };
  // Issue #2409 (G6): the store/deliver outcomes are RETURNED
  // by their step callbacks, never set on closure variables.
  // Durable step replay returns the journaled result WITHOUT
  // re-executing the callback, so closure state set inside a
  // callback is lost on resume — the shard would report
  // stored/delivered false (and project that lie, degrading
  // the parent collation) for side effects that already
  // landed. Return values are what the journal replays.
  const storeOutcome = await step.do(
    "store-shard",
    async (): Promise<{ stored: boolean; reportId?: string; storeError?: string }> => {
      try {
        const storedId = await deps.storeReport(payload, command.userLogin);
        return {
          stored: true,
          ...(typeof storedId === "string" ? { reportId: storedId } : {}),
        };
      } catch (err) {
        return {
          stored: false,
          storeError: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
  await traceStep(deps, command, "workflow-step", "store-shard");
  const stored = storeOutcome.stored;
  const reportId = storeOutcome.reportId;
  const storeError = storeOutcome.storeError;
  let delivered = false;
  let deliverError: string | undefined;
  if (command.deliver) {
    const delivery = await step.do(
      "deliver-shard",
      async (): Promise<{ delivered: boolean; deliverError?: string }> => {
        try {
          await deps.deliverOutcome(payload, command.userLogin);
          return { delivered: true };
        } catch (err) {
          return {
            delivered: false,
            deliverError: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );
    delivered = delivery.delivered;
    deliverError = delivery.deliverError;
    await traceStep(deps, command, "workflow-step", "deliver-shard");
  }
  const summary = shardSummaryFromResult(shardId, result);
  const rowResult = {
    ...summary,
    stored,
    delivered,
    ...(reportId ? { reportId } : {}),
    ...(storeError ? { storeError } : {}),
    ...(deliverError ? { deliverError } : {}),
  };
  await step.do("project-shard", async () => {
    warnUnprojected(
      command.parentJobId ?? command.jobId,
      "analysis",
      await projectBestEffort(deps, command.tenantId, command.parentJobId ?? command.jobId, [
      {
        stepId: shardId,
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "analysis",
        status: result.success ? "completed" : "failed",
        detail: result.success
          ? `Shard ${shardId}: ${result.totalScanned}/${result.expectedCount} evaluated.`
          : `Shard ${shardId} failed: ${result.error ?? "screen failed"}`,
        result: { shardJobIds: [`shard:${shardId}`], result: rowResult },
      },
      ], deps.nowMs()),
    );
  });
  await traceStep(deps, command, "projection", "project-shard");
  // Strip `full`: the parent collects summaries + flags only.
  // Issue #2910 (G3): the child's canonical report id rides
  // the output (when the store door returned one) so the
  // parent can link its row to the child's.
  const { full: _dropped, ...output } = result;
  return {
    ...output,
    stored,
    delivered,
    ...(reportId ? { reportId } : {}),
    ...(storeError ? { storeError } : {}),
    ...(deliverError ? { deliverError } : {}),
  };
}

/**
 * Issue #2601 seam C - the shard fan-out as the runner contract sees
 * it: one parallel stage over the shard units, capped by the command
 * (default DEFAULT_MAX_PARALLEL_SHARDS), retrying under the analysis
 * bucket. The cap is the contract's decision; the batched loop below
 * consumes its started/deferred partition, so the tail is always
 * queued as the next round - never truncated.
 */
function shardFanoutStage(maxParallel: number, timeoutMs: number): StageRunnerStage {
  return {
    stage: "analysis",
    execution: "parallel",
    maxParallel,
    timeoutMs,
    retryBucket: STAGE_RETRY_BUCKET.analysis,
  };
}

/**
 * Issue #3028 — a resume whose checkpoint says every unit is already
 * terminal starts nothing. Its record is built from the checkpoint
 * instead of from fresh outcomes, so a completed resume reports its
 * stored result rather than the "no shard ran" failure a zero-outcome
 * collation would produce.
 */
function outcomesFromCheckpoint(
  plan: StageRunnerPlan,
  checkpoint: StageRunnerCheckpoint,
): ShardOutcome[] {
  return plan.units.map((unit) => {
    const entry = checkpoint.units.find((u) => u.unitId === unit.unitId);
    switch (entry?.status) {
      case "completed":
      case "skipped":
        return { shardId: unit.unitId, status: "completed" };
      case "timed_out":
        return { shardId: unit.unitId, status: "timed_out", timedOut: true };
      case "failed":
        return {
          shardId: unit.unitId,
          status: "failed",
          ...(entry.error ? { error: entry.error } : {}),
        };
      default:
        return {
          shardId: unit.unitId,
          status: "failed",
          error: "Shard never ran (checkpoint carries no terminal status).",
        };
    }
  });
}

interface PendingShard {
  shard: WorkflowJobCommand["shards"][number];
  workflowId: string;
  deadlineMs: number;
}

/**
 * Run a parent job: fan out, poll with deadlines, collate,
 * project. Returns the final collation (children own
 * store/deliver; their flags arrive in the child outputs).
 */
export async function runParentFlow(
  command: WorkflowJobCommand,
  step: ScreenerWorkflowStep,
  deps: ScreenerWorkflowDeps,
  childOps: ChildWorkflowOps,
  /**
   * Issue #3028: the run's checkpoint, when this is a RESUME rather
   * than a first execution (the production adapter is
   * createAsyncJobStageCheckpointStore, #3027). Absent = a first run,
   * whose units are all outstanding — today's behaviour exactly.
   */
  resumeFrom?: StageRunnerCheckpoint | null,
): Promise<WorkflowCollation> {
  const nowMs = deps.nowMs;
  const workflowId = workflowIdForJob(command.jobId);
  // Issue #2530: the run's mode (absent = deterministic).
  // ND admission is checked HERE, at the workflow boundary,
  // before anything is announced or started: gate closed,
  // no interpreter, or no audit sink each refuse the run —
  // a direct workflow start cannot bypass the flag, invent
  // criteria, or run unaudited.
  const screenMode: ScreenMode = command.screenMode ?? "deterministic";
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
  const maxParallel = command.maxParallelShards ?? DEFAULT_MAX_PARALLEL_SHARDS;
  const shardTimeoutMs = command.shardTimeoutMs ?? DEFAULT_SHARD_TIMEOUT_MS;
  const pollIntervalMs = command.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const lifecycleTransitions: Array<{ lifecycle: WorkflowRunLifecycle; atMs: number }> = [
    { lifecycle: "Idle", atMs: nowMs() },
    { lifecycle: "Running", atMs: nowMs() },
  ];
  const stageTransitions: StageTransition[] = [];

  // Announce: the parent row exists from the start, so
  // jobs/history shows progress while shards run. The
  // submitted leg keys on result.jobId (the projector's
  // submitted rule); the final leg keys on shardJobIds —
  // both resolve to the parent job id, so announce and
  // final are versions of ONE row, not two rows.
  await step.do("announce", async () => {
    warnUnprojected(
      command.jobId,
      "feed",
      await projectBestEffort(deps, command.tenantId, command.jobId, [
        {
          stepId: "parent",
          capabilityId: SCREENER_WORKFLOW_CAPABILITY,
          stage: "feed",
          status: "submitted",
          detail: `Workflow started: ${command.shards.length} shard(s), trigger ${command.trigger}, mode ${screenMode}.`,
          result: { jobId: command.jobId },
        },
      ], nowMs()),
    );
  });
  await traceStep(deps, command, "workflow-step", "announce");

  // Issue #2530 — the ND head: interpret → validate → audit.
  // All three are done before fan-out; a refused artifact
  // short-circuits fan-out entirely (the outcomes below are
  // synthesized as failed shards, so collation and projection
  // proceed through the one existing tail). Deterministic
  // runs skip this block untouched: runCommand IS command.
  let runCommand = command;
  let refusalReasons: string[] | null = null;
  if (screenMode === "non-deterministic") {
    const interpreter = deps.intentInterpreter!;
    const intent = command.screenIntent!;
    // Journaled: on replay the journaled artifact returns and
    // the model is not called again — replay stays
    // deterministic. A throw is infrastructure (step retries,
    // then the run errors); a returned value is the
    // validator's business.
    const artifact = await step.do(
      "interpret-screen-intent",
      () =>
        interpreter.interpret({
          intent,
          ...(command.filters ? { baseFilters: command.filters } : {}),
          shardUniverses: command.shards.map((s) => s.universe ?? s.shardId),
        }),
      { retries: { limit: WORKFLOW_STEP_MAX_RETRIES } },
    );
    await traceStep(deps, command, "workflow-step", "interpret-screen-intent");
    // Deterministic validation: a pure function of the
    // journaled artifact, run in flow code — the same verdict
    // on every replay.
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
    await traceStep(deps, command, "workflow-step", "audit-screen-interpretation");
    if (verdict.ok) {
      // The artifact refines the command's filters per field;
      // shards, universe, provider, and deliver never change.
      runCommand = { ...command, filters: effectiveFilters };
    } else {
      refusalReasons = verdict.reasons;
    }
  }

  // Fan out in batches of maxParallelShards.
  const pending: PendingShard[] = [];
  const outcomes = new Map<string, ShardOutcome>();
  const childResults = new Map<string, ShardScreenResult>();
  /** Issue #3028: the deferred-tail reasons this run recorded (normally none). */
  const fanoutCapReasons: string[] = [];
  /** Issue #3028: units a resume skipped as already complete. */
  const resumedSkipped: string[] = [];
  if (refusalReasons) {
    // Issue #2530: a refused interpretation starts ZERO
    // shards. Every shard is a failed outcome carrying the
    // refusal reasons, so the run's record is a Failed
    // collation — a business refusal, not an infra error.
    for (const shard of command.shards) {
      outcomes.set(shard.shardId, {
        shardId: shard.shardId,
        status: "failed",
        error: `Non-deterministic screen refused before execution: ${refusalReasons.join("; ")}`,
      });
    }
  } else {
    const fanoutStage = shardFanoutStage(maxParallel, shardTimeoutMs);
    const shardById = new Map(command.shards.map((shard) => [shard.shardId, shard]));
    const runPlan: StageRunnerPlan = planRun({
      runId: command.jobId,
      invocation: "workflow-shard",
      stages: [fanoutStage],
      units: command.shards.map((shard) => ({ unitId: shard.shardId })),
    });
    // Issue #3028: a resume asks the contract which units are still
    // outstanding; a first run starts them all. A completed unit is
    // never started again by a resume.
    const outstanding = resumeFrom ? planNext(runPlan, resumeFrom) : { units: runPlan.units };
    let queue = outstanding?.units ?? [];
    if (resumeFrom) {
      const resumedIds = new Set(queue.map((unit) => unit.unitId));
      const skipped = runPlan.units
        .filter((unit) => !resumedIds.has(unit.unitId))
        .map((unit) => unit.unitId);
      if (skipped.length > 0) {
        resumedSkipped.push(...skipped);
        // A skipped unit did not run in this invocation but it IS part of
        // the run's record: seed its outcome from the checkpoint so the
        // collation reports the stored result instead of "never started".
        for (const unitId of skipped) {
          outcomes.set(unitId, { shardId: unitId, status: "completed" });
        }
      }
    }
    if (resumeFrom && queue.length === 0) {
      // Nothing outstanding: record the checkpoint's result, start no child.
      const recorded = outcomesFromCheckpoint(runPlan, resumeFrom);
      for (const outcome of recorded) {
        stageTransitions.push(...stageTransitionsForShard(outcome, nowMs()));
      }
      return {
        ...collateShards(
          command.jobId,
          workflowId,
          recorded,
          lifecycleTransitions,
          stageTransitions,
        ),
        ...(resumedSkipped.length > 0 ? { resumedSkippedUnits: resumedSkipped } : {}),
      };
    }
    let batchIndex = 0;
    while (queue.length > 0) {
      const fanout = planStageFanout(fanoutStage, queue);
      // Issue #3028: a deferred tail is a pace signal on the record,
      // never a silent truncation — the loop below starts it next round.
      const capReason = fanoutCapExceeded(fanout);
      if (capReason) fanoutCapReasons.push(capReason);
      const batch = fanout.started.map((unit) => shardById.get(unit.unitId)!);
      const created = await step.do(`fan-out-batch-${batchIndex}`, async () => {
        const out: Array<{ shard: WorkflowJobCommand["shards"][number]; workflowId: string }> = [];
        for (const shard of batch) {
          // Issue #3025: the child signals this instance when its run
          // ends; the id is on the command, not in a shared registry.
          const child = await childOps.createChild({
            ...shardCommandFor(runCommand, shard),
            parentWorkflowId: workflowId,
          });
          out.push({ shard, workflowId: child.workflowId });
        }
        return out;
      });
      // Issue #2000 Phase 5 Slice 3: the fan-out step joins
      // the run's trace like every other parent step — until
      // this slice it was the one parent step that never
      // emitted, so the trace jumped from announce straight
      // to the shards' steps with the fan-out invisible.
      await traceStep(deps, runCommand, "workflow-step", `fan-out-batch-${batchIndex}`);
      for (const c of created) {
        pending.push({
          shard: c.shard,
          workflowId: c.workflowId,
          deadlineMs: nowMs() + shardTimeoutMs,
        });
      }
      // Poll this batch to terminal-or-timeout before the next
      // batch starts: this is what bounds concurrency.
      await pollBatch(pending, outcomes, childResults, runCommand, step, deps, childOps, pollIntervalMs, nowMs);
      // The contract partition consumes the tail as the next round:
      // a shard is deferred, never dropped, and the loop ends only
      // when every unit has started.
      queue = fanout.deferred;
      batchIndex += 1;
    }
  }

  // Any shard still pending after its batch loop is timed out
  // (the poll loop exits only on terminal-or-deadline, so this
  // is a safety net, not a second path).
  for (const p of pending) {
    if (!outcomes.has(p.shard.shardId)) {
      outcomes.set(p.shard.shardId, {
        shardId: p.shard.shardId,
        status: "timed_out",
        timedOut: true,
        error: `Shard exceeded its ${shardTimeoutMs}ms deadline.`,
        // Issue #2989: the pending entry's child instance id.
        workflowRunId: p.workflowId,
      });
    }
  }

  const outcomeList = command.shards.map(
    (s) =>
      outcomes.get(s.shardId) ?? {
        shardId: s.shardId,
        status: "failed" as const,
        error: "Shard never started.",
      },
  );
  for (const o of outcomeList) {
    stageTransitions.push(...stageTransitionsForShard(o, nowMs()));
  }
  if (outcomeList.some((o) => o.status !== "completed")) {
    lifecycleTransitions.push({ lifecycle: "BudgetConstrained", atMs: nowMs() });
  }
  const collation: WorkflowCollation = {
    ...collateShards(
      command.jobId,
      workflowId,
      outcomeList,
      lifecycleTransitions,
      stageTransitions,
    ),
    ...(fanoutCapReasons.length > 0 ? { fanoutCapReason: fanoutCapReasons[0] } : {}),
    ...(resumedSkipped.length > 0 ? { resumedSkippedUnits: resumedSkipped } : {}),
  };
  lifecycleTransitions.push({
    lifecycle: collation.lifecycle,
    atMs: nowMs(),
  });
  collation.lifecycleTransitions = [...lifecycleTransitions];
  // Issue #2530: the mode the run executed in, on the run's
  // collation record (always set by the parent flow).
  collation.screenMode = screenMode;
  // Issue #2910 (G3): parent/child linkage, set before
  // projection so the projected parent row carries it too.
  // Market shards link by canonical run id
  // (`screener:<timestamp>`); goal shards link by report
  // id (their rows key on `goal-screen:<taskId>`, not on a
  // timestamp, so no run id is derived for them).
  collation.childRunIds = command.goalScreen
    ? []
    : outcomeList
        .map((o) => (o.timestamp ? `screener:${o.timestamp}` : null))
        .filter((id): id is string => id !== null);
  collation.childReportIds = outcomeList
    .map((o) => o.reportId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // Project the final parent row + one row per shard. The
  // collation already carries the final lifecycle (computed
  // from the child outputs' stored flags) and the error maps,
  // so this single write closes the run — no second
  // project-close step, no journal: the parent collates
  // what the children did, and (since #2910) stores one
  // parent canonical row from that collation in the step
  // below. It never delivers.
  await step.do("project-final", async () => {
    const legs: LegOutcome[] = [
      {
        stepId: "parent",
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "deliver",
        status: collation.lifecycle === "Failed" ? "failed" : "completed",
        detail: collationDetail(collation),
        result: { shardJobIds: [command.jobId], result: collation },
      },
    ];
    // One row per shard. A shard the child already projected
    // replays as a no-op (same status); a shard with no row
    // (child projection failed, errored before projection,
    // or timed out) gains its record here. A timed-out shard
    // that later completes flips its row to completed
    // (version+1); the parent collation stands as the
    // deadline-time truth.
    for (const o of outcomeList) {
      if (o.status === "completed") {
        legs.push({
          stepId: o.shardId,
          capabilityId: SCREENER_WORKFLOW_CAPABILITY,
          stage: "analysis",
          status: "completed",
          detail: `Shard ${o.shardId} completed.`,
          // Issue #2989: the child instance id, for the row
          // (fills the child row's missing correlation at
          // version+1 when the child projected first).
          ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
          result: {
            shardJobIds: [`shard:${o.shardId}`],
            result: {
              shardId: o.shardId,
              status: "completed",
              totalScanned: o.totalScanned ?? 0,
              expectedCount: o.expectedCount ?? 0,
              matchedCount: o.matchedCount ?? 0,
              pdfKey: o.pdfKey,
              ...(o.xlsxKey ? { xlsxKey: o.xlsxKey } : {}),
              ...(o.csvKey ? { csvKey: o.csvKey } : {}),
              // The child's flags, so a shard whose own row
              // is missing still carries its store/deliver
              // state in the parent's record.
              stored: o.stored ?? false,
              delivered: o.delivered ?? false,
              ...(o.storeError ? { storeError: o.storeError } : {}),
              ...(o.deliverError ? { deliverError: o.deliverError } : {}),
            },
          },
        });
        continue;
      }
      legs.push({
        stepId: o.shardId,
        capabilityId: SCREENER_WORKFLOW_CAPABILITY,
        stage: "analysis",
        status: "failed",
        detail:
          o.status === "timed_out"
            ? `Shard ${o.shardId} timed out after ${shardTimeoutMs}ms.`
            : `Shard ${o.shardId} failed: ${o.error ?? "screen failed"}`,
        // Issue #2989: the child instance id, for the row.
        ...(o.workflowRunId ? { workflowRunId: o.workflowRunId } : {}),
        result: {
          shardJobIds: [`shard:${o.shardId}`],
          result: {
            shardId: o.shardId,
            status: o.status,
            ...(o.status === "timed_out" ? { timedOut: true } : {}),
            totalScanned: o.totalScanned ?? 0,
            expectedCount: o.expectedCount ?? 0,
            matchedCount: o.matchedCount ?? 0,
            error: o.error,
          },
        },
      });
    }
    warnUnprojected(command.jobId, "deliver", await projectBestEffort(deps, command.tenantId, command.jobId, legs, nowMs()));
  });
  await traceStep(deps, command, "projection", "project-final");

  // Issue #2910 (G3): one canonical mas_reports row for the
  // parent run (generationId = jobId), carrying the
  // collation summary, partial qualification, per-format
  // keys, and the child linkage above — summary only, no
  // bulk data, no fabricated results. Best-effort like a
  // child store: a store error is recorded on the
  // collation and the run continues; when no parent store
  // is configured the step is skipped and the collation
  // simply carries no parentReport outcome. The parent
  // store never delivers (children own delivery).
  if (deps.storeParentReport) {
    const parentOutcome = await step.do("store-parent", async (): Promise<ParentScreenReportOutcome> => {
      try {
        return await deps.storeParentReport!(
          {
            jobId: command.jobId,
            userLogin: command.userLogin,
            trigger: command.trigger,
            goalScreen: Boolean(command.goalScreen),
            collation,
            childRunIds: collation.childRunIds ?? [],
            childReportIds: collation.childReportIds ?? [],
            createdAt: new Date(nowMs()).toISOString(),
          },
          command.userLogin,
        );
      } catch (err) {
        return {
          stored: false,
          storeError: err instanceof Error ? err.message : String(err),
        };
      }
    });
    collation.parentReport = parentOutcome;
    await traceStep(deps, command, "workflow-step", "store-parent");
  }

  return collation;
}

/**
 * Poll one batch's pending shards to terminal-or-deadline.
 * Each round is a sleep step + a poll step (durable). A
 * terminal child's output is validated; garbage output
 * becomes a failed shard, never a collation crash.
 */
async function pollBatch(
  pending: PendingShard[],
  outcomes: Map<string, ShardOutcome>,
  childResults: Map<string, ShardScreenResult>,
  command: WorkflowJobCommand,
  step: ScreenerWorkflowStep,
  deps: ScreenerWorkflowDeps,
  childOps: ChildWorkflowOps,
  pollIntervalMs: number,
  nowMs: () => number,
): Promise<void> {
  const shardTimeoutMs = command.shardTimeoutMs ?? DEFAULT_SHARD_TIMEOUT_MS;
  let round = 0;
  for (;;) {
    // Mark overdue shards timed_out at their own deadline
    // (not at the batch's max deadline), then poll the rest.
    const outstanding = pending.filter((p) => !outcomes.has(p.shard.shardId));
    if (outstanding.length === 0) return;
    const now = nowMs();
    const remaining = outstanding.filter((p) => {
      if (now >= p.deadlineMs) {
        outcomes.set(p.shard.shardId, {
          shardId: p.shard.shardId,
          status: "timed_out",
          timedOut: true,
          error: `Shard exceeded its ${shardTimeoutMs}ms deadline.`,
          // Issue #2989: the pending entry's child instance id.
          workflowRunId: p.workflowId,
        });
        return false;
      }
      return true;
    });
    if (remaining.length === 0) return;
    if (step.waitForEvent) {
      // Issue #3025 — event-first: wait for any shard-completion signal,
      // bounded by the nearest shard deadline. A timeout (or a refused
      // wait) is not an error: the single reconciliation sweep below
      // reads the children once and the deadline rules still apply.
      const untilDeadline = Math.min(...remaining.map((p) => p.deadlineMs)) - now;
      try {
        await step.waitForEvent(`shard-done-${round}`, {
          type: SHARD_DONE_EVENT,
          timeoutMs: Math.max(1, untilDeadline),
        });
      } catch {
        // Deadline reached or wait refused — reconcile once, below.
      }
    } else {
      // No wait surface (test doubles / older adapters): the same
      // deadline-bounded sleep as before. Production always waits.
      await step.sleep(`poll-wait-${round}`, pollIntervalMs);
    }
    const snapshot = await step.do(`poll-${round}`, async () => {
      const out: Array<{
        shardId: string;
        workflowId: string;
        status: WorkflowInstanceStatus;
        output?: unknown;
        error?: { message: string };
      }> = [];
      for (const p of remaining) {
        const s = await childOps.getChildStatus(p.workflowId);
        out.push({
          shardId: p.shard.shardId,
          // Issue #2989: the pending entry's child instance id
          // rides the snapshot so the outcome — and then the
          // projected row — carries the seam-returned run id.
          workflowId: p.workflowId,
          status: s?.status ?? "unknown",
          ...(s?.output !== undefined ? { output: s.output } : {}),
          ...(s?.error ? { error: s.error } : {}),
        });
      }
      return out;
    });
    for (const s of snapshot) {
      if (s.status === "complete") {
        const result = asShardScreenResult(s.output);
        if (result) {
          childResults.set(s.shardId, result);
          outcomes.set(s.shardId, {
            shardId: s.shardId,
            status: result.success ? "completed" : "failed",
            totalScanned: result.totalScanned,
            expectedCount: result.expectedCount,
            matchedCount: result.matchedCount,
            ...(result.pdfKey ? { pdfKey: result.pdfKey } : {}),
            ...(result.xlsxKey ? { xlsxKey: result.xlsxKey } : {}),
            ...(result.csvKey ? { csvKey: result.csvKey } : {}),
            ...(result.error ? { error: result.error } : {}),
            // The child's own store/deliver flags (the parent
            // collates them; since #2910 it stores one parent
            // row, but it still never delivers).
            ...(result.stored !== undefined ? { stored: result.stored } : {}),
            ...(result.delivered !== undefined ? { delivered: result.delivered } : {}),
            ...(result.storeError ? { storeError: result.storeError } : {}),
            ...(result.deliverError ? { deliverError: result.deliverError } : {}),
            // Issue #2910 (G3): timestamp + report id are the
            // parent/child linkage (canonical run id for
            // market shards, report id for goal shards).
            timestamp: result.timestamp,
            ...(result.reportId ? { reportId: result.reportId } : {}),
            // Issue #2989: the child instance id, for the row.
            ...(s.workflowId ? { workflowRunId: s.workflowId } : {}),
          });
        } else {
          outcomes.set(s.shardId, {
            shardId: s.shardId,
            status: "failed",
            error: "Child workflow output malformed — cannot be a screen result.",
            ...(s.workflowId ? { workflowRunId: s.workflowId } : {}),
          });
        }
      } else if (s.status === "errored" || s.status === "terminated") {
        outcomes.set(s.shardId, {
          shardId: s.shardId,
          status: "failed",
          error: s.error?.message ?? `Child workflow ${s.status}.`,
          ...(s.workflowId ? { workflowRunId: s.workflowId } : {}),
        });
      }
      // queued/running/waiting/paused/unknown: still outstanding.
    }
    round += 1;
  }
}
