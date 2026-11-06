/**
 * Issue #2601 (Options Screener programme slice 5) — the stage-runner
 * PLAN functions: pure decisions over a plan and a checkpoint. No
 * provider, no storage, no clock — every function here is testable
 * without a runtime, which is what lets the three invocation drivers
 * (sync inline, async job via alarms, workflow shard steps) share one
 * set of decisions instead of re-implementing them per path.
 *
 * What it decides, and what it deliberately does not:
 *  - planRun: validate and freeze a declared plan (canonical stage
 *    order, deterministic default mode) — it never reorders silently.
 *  - planNext: the next stage with unfinished units, in plan order.
 *  - resumeUnits: the units a resume must re-run — only the ones that
 *    did not complete. A completed unit is never re-run by a resume.
 *  - planStageFanout / fanoutCapExceeded: cap fan-out at the stage's
 *    maxParallel and NAME the deferred tail (fanout_cap_exceeded) so a
 *    large universe queues a second chain instead of being truncated
 *    silently.
 *
 * It does NOT claim, deliver, retry, or time units: those are the
 * driver's job under the retry budget this contract resolves from
 * pipelinePolicy. Moving shardJobs' chain planner, asyncJobs' alarm
 * scheduler, and the workflow poll loop onto these decisions is the
 * follow-on seams of #2601 — one seam per PR — not part of this slice.
 */

import {
  assertStageRunnerPlan,
  stageMaxParallel,
  type StageRunnerCheckpoint,
  type StageRunnerPlan,
  type StageRunnerRunInput,
  type StageRunnerStage,
  type StageRunnerUnit,
  type StageUnitCheckpoint,
  type StageUnitStatus,
} from "./stageRunnerPorts";

/** Outcome code for a fan-out whose tail did not start in this round. */
export const FANOUT_CAP_EXCEEDED = "fanout_cap_exceeded";

/** Statuses that end a unit for planning purposes: never re-run, never waited on. */
const TERMINAL_STATUSES: readonly StageUnitStatus[] = ["completed", "skipped", "cancelled"];

/**
 * Statuses a resume must re-run: the unit did not complete.
 * "stopped" is the #3069 stop state (folded into #3549): a stopped
 * unit is exactly what a resume continues — from its checkpoint,
 * never re-executing a completed effect.
 */
const RESUME_STATUSES: readonly StageUnitStatus[] = ["failed", "timed_out", "queued", "stopped"];

function isTerminal(status: StageUnitStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The units one stage executes (a run without shardable units has the one implicit unit). */
function unitsOf(plan: StageRunnerPlan): StageRunnerUnit[] {
  return plan.units.length > 0 ? plan.units : [{ unitId: plan.runId }];
}

/** The checkpoint entry for one (stage, unit), when the checkpoint carries one. */
function entryFor(
  checkpoint: StageRunnerCheckpoint | null,
  stage: string,
  unitId: string,
): StageUnitCheckpoint | undefined {
  return checkpoint?.units.find((u) => u.stage === stage && u.unitId === unitId);
}

/**
 * Validate an input and freeze it as a plan. The mode defaults to
 * deterministic — the programme default is preserved here, not at each
 * call site — and every invariant is asserted, never repaired.
 */
export function planRun(input: StageRunnerRunInput): StageRunnerPlan {
  const plan: StageRunnerPlan = {
    runId: input.runId,
    invocation: input.invocation,
    stages: input.stages.map((stage) => ({ ...stage })),
    units: (input.units ?? []).map((unit) => ({ ...unit })),
    screenMode: input.screenMode ?? "deterministic",
  };
  assertStageRunnerPlan(plan);
  return plan;
}

/** The next stage to run: the first stage, in plan order, with a unit that is not terminal. */
export interface StageRunnerNext {
  stage: StageRunnerStage;
  units: StageRunnerUnit[];
}

/**
 * The next stage to execute, or null when every planned stage has every
 * unit terminal. Units returned are the outstanding ones only — a
 * completed unit is not handed to a driver again.
 */
export function planNext(
  plan: StageRunnerPlan,
  checkpoint: StageRunnerCheckpoint | null,
): StageRunnerNext | null {
  for (const stage of plan.stages) {
    const outstanding = unitsOf(plan).filter((unit) => {
      const entry = entryFor(checkpoint, stage.stage, unit.unitId);
      return !entry || !isTerminal(entry.status);
    });
    if (outstanding.length > 0) {
      return { stage, units: outstanding };
    }
  }
  return null;
}

/**
 * The units a resume re-runs: recorded (stage, unit) entries that did
 * not complete, in plan order. An entry with no checkpoint is not a
 * resume signal — a fresh run has none, and inventing work from absent
 * rows is how a resume restarts a whole job. A completed unit never
 * appears here.
 */
export function resumeUnits(
  plan: StageRunnerPlan,
  checkpoint: StageRunnerCheckpoint | null,
): Array<{ stage: StageRunnerStage; unit: StageRunnerUnit; checkpoint: StageUnitCheckpoint }> {
  if (!checkpoint) return [];
  const out: Array<{ stage: StageRunnerStage; unit: StageRunnerUnit; checkpoint: StageUnitCheckpoint }> = [];
  for (const stage of plan.stages) {
    for (const unit of unitsOf(plan)) {
      const entry = entryFor(checkpoint, stage.stage, unit.unitId);
      if (!entry) continue;
      if (!RESUME_STATUSES.includes(entry.status)) continue;
      out.push({ stage, unit, checkpoint: entry });
    }
  }
  return out;
}

/** One fan-out round: the units that start now, and the tail that waits. */
export interface StageFanout {
  stage: StageRunnerStage;
  maxParallel: number;
  started: StageRunnerUnit[];
  deferred: StageRunnerUnit[];
}

/**
 * Split a stage's outstanding units into one fan-out round at the
 * stage's cap. The tail is returned, never dropped: the driver queues
 * it as the next round (or a second chain) and reports the cap.
 */
export function planStageFanout(stage: StageRunnerStage, units: StageRunnerUnit[]): StageFanout {
  const maxParallel = stageMaxParallel(stage);
  return {
    stage,
    maxParallel,
    started: units.slice(0, maxParallel),
    deferred: units.slice(maxParallel),
  };
}

/**
 * The visible reason a fan-out round was capped, or null when the tail
 * is empty. Callers put this on the run record; it is never a silent
 * truncation of the universe.
 */
export function fanoutCapExceeded(fanout: StageFanout): string | null {
  if (fanout.deferred.length === 0) return null;
  const ids = fanout.deferred.map((u) => u.unitId).join(", ");
  return `${FANOUT_CAP_EXCEEDED}: ${fanout.deferred.length} unit(s) deferred on stage ${fanout.stage.stage} at maxParallel ${fanout.maxParallel} (${ids}) — queue the tail as a second round/chain; the universe is never truncated silently.`;
}
