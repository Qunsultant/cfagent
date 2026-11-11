/**
 * Issue #2601 (Options Screener programme slice 5) — the stage-runner
 * PORT: the one contract every screen invocation mode plans and
 * checkpoints against (sync inline, async job via alarms, batch via
 * workflow shard steps). CONTRACT ONLY: this module declares types,
 * constants, the canonical stage order, the legacy-name mapping, and
 * the validation/resolution rules. It binds no provider, opens no
 * store, and changes no execution — the three seams this contract is
 * for (shardJobs' hand-rolled chain planner, asyncJobs' DO-alarm
 * scheduler, the workflow poll loop) move onto it one PR at a time.
 *
 * Reuse, not a second vocabulary (the #2621 rule "extend existing
 * ports, never a second port layer"):
 *  - the stage names ARE `StageName` (messaging port vocabulary:
 *    feed → gather → analysis → store → serve → deliver);
 *  - the chain-row names ARE `PipelineStage` (the mas_async_jobs
 *    stage column), mapped by `runnerStageForPipelineStage` — the
 *    legacy "generate" row is the analysis stage in this split, and
 *    the #2621 canonical labels (generation / recording / delivery)
 *    are labels over these names, stated in `STAGE_CANONICAL_LABEL`,
 *    never a second enum;
 *  - retry budgets ARE `pipelinePolicy.retry` buckets, resolved once
 *    by `resolveStageRetryBudget` — no call-site constants;
 *  - checkpoint status vocabulary IS `StageStatus` (the stage-chain
 *    read model), plus `never-attempted` for a stage that has no row
 *    at all (absent is never "failed", and never "missing data").
 *
 * Deterministic default preserved: a plan carries `screenMode`
 * defaulting to "deterministic". This contract never turns on the
 * #2530 non-deterministic mode; a plan that names it is the caller's
 * explicit act and is refused downstream while the gate is off.
 */

import type { StageName } from "../messaging/messagingPorts";
import type { PipelinePolicy, RetryPolicy } from "../services/pipelinePolicy";
import type { StageStatus } from "../services/stageChain";
import type { PipelineStage } from "../types";
import {
  DEFAULT_MAX_PARALLEL_SHARDS,
  DEFAULT_SHARD_TIMEOUT_MS,
  type ScreenMode,
} from "./workflowPorts";

/** Canonical runner stage order (the StageName vocabulary, in pipeline order). */
export const RUNNER_STAGE_ORDER: readonly StageName[] = [
  "feed",
  "gather",
  "analysis",
  "store",
  "serve",
  "deliver",
];

/** A stage runs its units one at a time (sequential) or up to a cap (parallel). */
export type StageExecution = "sequential" | "parallel";

/** Pacing tier: provider-pressure demotion target for a unit (slow/crawl are queued, never retried tightly). */
export type StagePacingTier = "fast" | "slow" | "crawl";

export const DEFAULT_STAGE_PACING_TIER: StagePacingTier = "fast";

/** The pipelinePolicy retry bucket a stage's units retry under. */
export type StageRetryBucket = keyof PipelinePolicy["retry"];

/**
 * Default retry bucket per stage. Acquisition covers the provider-facing
 * stages (feed and the gather it feeds); report covers the screen's
 * compute and the artifacts built from it (analysis/generation, store);
 * delivery covers every channel send.
 *
 * analysis maps to "report" because the chain planner has always run the
 * generate row (the analysis stage) under the report budget
 * (SHARD_RETRY_BUCKET.generate); that table now derives from this one, so
 * the two cannot drift apart again.
 */
export const STAGE_RETRY_BUCKET: Record<StageName, StageRetryBucket> = {
  feed: "acquisition",
  gather: "acquisition",
  analysis: "report",
  store: "report",
  serve: "report",
  deliver: "delivery",
};

/**
 * The #2621 canonical labels over the StageName vocabulary. Labels are
 * for display and programme traceability; the enum stays StageName.
 * note: generation is the analysis stage, recording is the store stage,
 * and delivery is the serve+deliver group (serve = Docs availability,
 * deliver = per-channel bridge outcomes).
 */
export const STAGE_CANONICAL_LABEL: Record<StageName, string> = {
  feed: "feed",
  gather: "gather",
  analysis: "generation",
  store: "recording",
  serve: "delivery",
  deliver: "delivery",
};

/**
 * mas_async_jobs stage column → runner stage. "generate" is the chain
 * name for the analysis stage (workflowPorts' stage-split note); the
 * remaining names are shared verbatim. "gather" has no chain row: it
 * runs inside the analysis stage's unit and is recorded on the run's
 * stage transitions, not as its own row.
 */
export const RUNNER_STAGE_FOR_PIPELINE_STAGE: Record<PipelineStage, StageName> = {
  feed: "feed",
  generate: "analysis",
  store: "store",
  serve: "serve",
  deliver: "deliver",
};

/** Map a chain-row stage onto its runner stage (see the table above). */
export function runnerStageForPipelineStage(stage: PipelineStage): StageName {
  return RUNNER_STAGE_FOR_PIPELINE_STAGE[stage];
}

/**
 * Pipeline job stages (#3549, absorbing #3069 — one engine): a
 * configured job tree's nodes execute as stages of this same
 * contract. A job stage id names one node of one job definition:
 * `job:<nodePath>`, where the node path is the child-index path
 * ("" = the root, carried as `job:root`; "0/2" = `job:0/2`). Job
 * stage ids are configuration-dynamic — no static catalog can
 * declare them — so a plan is single-family: either vocabulary
 * stages (canonical order, below) or job stages (the definition's
 * declared order IS the plan's canonical order; the assertion
 * never reorders either family). The default retry bucket for a
 * job stage is "report" (the generic compute budget — analysis
 * and store already retry under it); a plan compiler whose job
 * stages are provider- or delivery-shaped declares the bucket
 * explicitly per stage.
 */
export type JobStageId = `job:${string}`;

/** The stage id of one node of a configured job tree ("" is the root node). */
export function jobStageId(nodePath: string): JobStageId {
  return nodePath === "" ? "job:root" : `job:${nodePath}`;
}

/** The node path a job stage id names (the inverse of jobStageId). */
export function jobStageNodePath(stage: JobStageId): string {
  return stage === "job:root" ? "" : stage.slice("job:".length);
}

/** True when a stage id belongs to the configured-job family. */
export function isJobStageId(stage: string): stage is JobStageId {
  return stage.startsWith("job:");
}

/** A stage identity: the messaging vocabulary, or one configured job node. */
export type StageRunnerStageId = StageName | JobStageId;

/** The default retry bucket for a job stage that declares none (see the note above). */
export const JOB_STAGE_DEFAULT_RETRY_BUCKET: StageRetryBucket = "report";

/** A unit of work inside a stage: a shard, a symbol, a strategy group, a channel. */
export interface StageRunnerUnit {
  unitId: string;
  /** Provider-pressure tier this unit is queued at (default: fast). */
  tier?: StagePacingTier;
}

/** One stage in a run plan. */
export interface StageRunnerStage {
  stage: StageRunnerStageId;
  execution: StageExecution;
  /**
   * Cap on concurrently started units for a parallel stage. Defaults to
   * the shared DEFAULT_MAX_PARALLEL_SHARDS; refused (never clamped) at 0
   * or below. Sequential stages ignore it.
   */
  maxParallel?: number;
  /** Per-unit deadline; a unit past it is timed_out, and the run proceeds as a qualified partial. */
  timeoutMs: number;
  /** Retry bucket; defaults to STAGE_RETRY_BUCKET[stage] (job stages: JOB_STAGE_DEFAULT_RETRY_BUCKET). */
  retryBucket?: StageRetryBucket;
  /** Pacing tier for the stage's units; defaults to DEFAULT_STAGE_PACING_TIER. */
  pacingTier?: StagePacingTier;
  /**
   * How a unit consumes its items (#3549: the contract's fourth
   * mode axis, declared on the stage so a plan carries it):
   * "batch" = the whole item list in one pass (the default);
   * "online" = item by item, each item's output chaining to the
   * same item of the next step.
   */
  pacing?: "batch" | "online";
}

/** How the runner was invoked. Same plan, same checkpoints; only the driver differs. */
export type StageRunnerInvocation = "sync" | "async-alarm" | "workflow-shard";

/** The input a caller plans from. */
export interface StageRunnerRunInput {
  /** Run id (the idempotency key for the whole plan). */
  runId: string;
  invocation: StageRunnerInvocation;
  stages: StageRunnerStage[];
  /** Shardable units; empty means the run has a single unit (no fan-out). */
  units: StageRunnerUnit[];
  /** Absent = deterministic (the programme default, preserved). */
  screenMode?: ScreenMode;
}

/** A planned run: stages in canonical order, units, and the mode it executes in. */
export interface StageRunnerPlan {
  runId: string;
  invocation: StageRunnerInvocation;
  stages: StageRunnerStage[];
  units: StageRunnerUnit[];
  screenMode: ScreenMode;
}

/**
 * A stage's unit state: the stage-chain vocabulary, plus "timed_out" (a unit
 * past its deadline — the shard-deadline outcome the workflow flow already
 * records) and "never-attempted" for a planned pair with no row at all.
 * Plus the uniform stage-control states (#3069, folded into #3549;
 * #3944 adds retire as the eighth uniform operation):
 * "stopped" — halted by a stop action, non-terminal and resumable,
 * never recorded as failed; "cancelled" — terminal by a cancel
 * action, surfaced as cancelled, never silently resumed past;
 * "retired" — terminal by a retire action on the stage's
 * definition: the stage never re-runs in any run, and a run
 * reaching it settles cancelled with the stage named, its
 * downstream never proceeding past it.
 */
export type StageUnitStatus = StageStatus | "timed_out" | "never-attempted" | "stopped" | "cancelled" | "retired";

/** One (stage, unit) checkpoint entry. */
export interface StageUnitCheckpoint {
  stage: StageRunnerStageId;
  unitId: string;
  status: StageUnitStatus;
  /** Rows recorded for this (stage, unit): the attempt count, never an invented retry count. */
  attempt: number;
  error?: string;
  /** When the newest row for this (stage, unit) was written; absent on never-attempted. */
  updatedAt?: string;
  /**
   * Intra-unit resume position, for units whose execution is
   * itself stepped (#3549): the step/item indices a resume
   * continues from. Absent = the unit is atomic from the
   * runner's view (the screen families' units). Written when a
   * unit is stopped mid-execution; cleared on completion.
   */
  progress?: { stepIndex: number; itemIndex: number };
}

/** A run's checkpoint: one entry per planned (stage, unit) pair. */
export interface StageRunnerCheckpoint {
  runId: string;
  units: StageUnitCheckpoint[];
}

/**
 * The checkpoint store the runner reads and writes. The production
 * adapter projects mas_async_jobs stage rows (one unit store, ADR D-0 /
 * #2621: no second unit table); the in-memory adapter is tests-only.
 * The pipeline's adapter (#3549, src/data/jobPipelineStageCheckpoint.ts)
 * persists the checkpoint on the job instance record — that substrate
 * has no mas_async_jobs rows; its instance record is its unit store,
 * so the store is writable there.
 */
export interface StageCheckpointStore {
  read(runId: string): Promise<StageRunnerCheckpoint | null>;
  write(checkpoint: StageRunnerCheckpoint): Promise<void>;
}

/** Resolve a stage's retry budget from the resolved pipeline policy (one resolution, no constants). */
export function resolveStageRetryBudget(
  policy: PipelinePolicy,
  stage: StageRunnerStage,
): RetryPolicy {
  return policy.retry[stageRetryBucket(stage)];
}

/** The bucket a stage retries under: its own declaration, else the per-stage default. */
export function stageRetryBucket(stage: StageRunnerStage): StageRetryBucket {
  if (stage.retryBucket) return stage.retryBucket;
  if (isJobStageId(stage.stage)) return JOB_STAGE_DEFAULT_RETRY_BUCKET;
  return STAGE_RETRY_BUCKET[stage.stage as StageName];
}

/** The pacing tier a stage's units are queued at. */
export function stagePacingTier(stage: StageRunnerStage): StagePacingTier {
  return stage.pacingTier ?? DEFAULT_STAGE_PACING_TIER;
}

/** The fan-out cap a stage executes under (1 for sequential). */
export function stageMaxParallel(stage: StageRunnerStage): number {
  if (stage.execution !== "parallel") return 1;
  return stage.maxParallel ?? DEFAULT_MAX_PARALLEL_SHARDS;
}

/** Default per-unit deadline, shared with the workflow shard budget. */
export const DEFAULT_STAGE_TIMEOUT_MS = DEFAULT_SHARD_TIMEOUT_MS;

/**
 * Assert a plan is dispatchable. Refuses loudly instead of repairing:
 * an empty stage list, a duplicate stage, a stage out of canonical
 * order (no silent reorder), a mixed-family plan, a malformed job
 * stage id, a non-positive cap or deadline, a duplicate unit, or a
 * missing run id. A plan that cannot be executed as declared is a
 * caller bug, not something the runner guesses around.
 */
export function assertStageRunnerPlan(plan: StageRunnerPlan): void {
  if (!plan || typeof plan.runId !== "string" || plan.runId.trim().length === 0) {
    throw new Error("Stage-runner plan refused: the plan carries no runId (the idempotency key).");
  }
  if (plan.screenMode !== "deterministic" && plan.screenMode !== "non-deterministic") {
    throw new Error(
      `Stage-runner plan refused: screenMode ${JSON.stringify(plan.screenMode)} is not "deterministic"/"non-deterministic".`,
    );
  }
  if (!Array.isArray(plan.stages) || plan.stages.length === 0) {
    throw new Error("Stage-runner plan refused: a plan needs at least one stage.");
  }
  const seen = new Set<StageRunnerStageId>();
  let lastIndex = -1;
  let family: "vocabulary" | "job" | null = null;
  for (const stage of plan.stages) {
    if (seen.has(stage.stage)) {
      throw new Error(
        `Stage-runner plan refused: duplicate stage ${stage.stage} in one plan (one stage entry per stage).`,
      );
    }
    seen.add(stage.stage);
    // One plan, one stage family (#3549): vocabulary stages keep
    // canonical order; job stages follow the definition's declared
    // order, which is their canonical order. Mixing families would
    // leave the order between them undefined — refused, never guessed.
    const stageFamily = isJobStageId(stage.stage) ? "job" : "vocabulary";
    if (family === null) family = stageFamily;
    if (stageFamily !== family) {
      throw new Error(
        `Stage-runner plan refused: stage ${stage.stage} mixes stage families in one plan (vocabulary stages and job stages never share a plan).`,
      );
    }
    if (stageFamily === "job") {
      const path = jobStageNodePath(stage.stage as JobStageId);
      if (path !== "" && !/^\d+(\/\d+)*$/.test(path)) {
        throw new Error(
          `Stage-runner plan refused: job stage ${JSON.stringify(stage.stage)} does not name a node path ("job:root" or "job:<child indices>", e.g. "job:0/2").`,
        );
      }
    } else {
      const index = RUNNER_STAGE_ORDER.indexOf(stage.stage as StageName);
      if (index < 0) {
        throw new Error(
          `Stage-runner plan refused: stage ${JSON.stringify(stage.stage)} is not a runner stage.`,
        );
      }
      if (index <= lastIndex) {
        throw new Error(
          `Stage-runner plan refused: stage ${stage.stage} is out of order — stages must follow ${RUNNER_STAGE_ORDER.join(" → ")} (the flow never reorders a declared plan).`,
        );
      }
      lastIndex = index;
    }
    if (stage.pacing !== undefined && stage.pacing !== "batch" && stage.pacing !== "online") {
      throw new Error(
        `Stage-runner plan refused: stage ${stage.stage} declares pacing ${JSON.stringify(stage.pacing)} — a stage paces "batch" or "online".`,
      );
    }
    if (!Number.isFinite(stage.timeoutMs) || stage.timeoutMs <= 0) {
      throw new Error(
        `Stage-runner plan refused: stage ${stage.stage} has no positive timeoutMs (a unit must have a deadline).`,
      );
    }
    if (
      stage.execution === "parallel" &&
      stage.maxParallel !== undefined &&
      (!Number.isInteger(stage.maxParallel) || stage.maxParallel < 1)
    ) {
      throw new Error(
        `Stage-runner plan refused: stage ${stage.stage} declares maxParallel ${stage.maxParallel} — a parallel stage needs an integer cap of at least 1 (never clamped silently).`,
      );
    }
  }
  const unitIds = new Set<string>();
  for (const unit of plan.units ?? []) {
    if (typeof unit.unitId !== "string" || unit.unitId.trim().length === 0) {
      throw new Error("Stage-runner plan refused: a unit carries no unitId.");
    }
    if (unitIds.has(unit.unitId)) {
      throw new Error(
        `Stage-runner plan refused: duplicate unit ${unit.unitId} (units are identified by unitId, one entry each).`,
      );
    }
    unitIds.add(unit.unitId);
  }
}
