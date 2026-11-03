/**
 * Issue #2601 (Options Screener programme slice 5) — the checkpoint
 * projection: mas_async_jobs stage rows → one checkpoint entry per
 * planned (stage, unit) pair. Pure, so the workflow parent, the async
 * alarm driver, and the sync path read the SAME progress from the same
 * rows instead of each keeping its own idea of where a run is.
 *
 * One unit store, by decision (ADR 0022 D-0, carried into #2621):
 * mas_async_jobs already stores the stage column, the chain id, and the
 * claim that depends on instance serialization. There is no second unit
 * table and no second claim story here — this module reads the existing
 * rows and never writes them.
 *
 * Absent is never-attempted, not "failed" and not "missing data": a
 * stage that recorded no row never ran, and the run record must say so
 * in those words (the #2621 rule that a stage which never ran renders
 * never-attempted).
 *
 * Stored statuses are the closed AsyncJobStatus set (queued / running /
 * completed / failed). held and skipped ride a COMPLETED row's result in
 * the stage-chain read model (src/services/stageChain.ts); this
 * projection does not re-derive them, so it cannot disagree with that
 * read model about the same row.
 */

import type { PipelineStage } from "../types";
import {
  runnerStageForPipelineStage,
  type StageCheckpointStore,
  type StageRunnerCheckpoint,
  type StageRunnerPlan,
  type StageUnitCheckpoint,
  type StageUnitStatus,
} from "./stageRunnerPorts";

/** The subset of an mas_async_jobs / AsyncJobRecord row this projection reads. */
export interface StageRowLike {
  /** Unit identity: the shard id, symbol, or other per-unit key the caller resolves. */
  unitId: string;
  /** The chain-stage column; absent on rows outside a chain (excluded). */
  stage?: PipelineStage;
  status: "queued" | "running" | "completed" | "failed";
  error?: string;
  updatedAt?: string;
}

/** The stored rows for one (stage, unit) pair, newest last. */
function rowsFor(
  rows: StageRowLike[],
  stage: string,
  unitId: string,
): StageRowLike[] {
  return rows.filter(
    (row) =>
      row.unitId === unitId &&
      row.stage !== undefined &&
      runnerStageForPipelineStage(row.stage) === stage,
  );
}

/** Derive one entry's status from its stored rows (stored statuses only — see the header). */
function statusFor(rows: StageRowLike[]): {
  status: StageUnitStatus;
  error?: string;
  updatedAt?: string;
} {
  if (rows.length === 0) return { status: "never-attempted" };
  const failed = rows.find((row) => row.status === "failed");
  const running = rows.find((row) => row.status === "running");
  const queued = rows.find((row) => row.status === "queued");
  const newest = rows[rows.length - 1]!;
  const base = { updatedAt: newest.updatedAt };
  if (failed) return { ...base, status: "failed", ...(failed.error ? { error: failed.error } : {}) };
  if (running) return { ...base, status: "running" };
  if (queued) return { ...base, status: "queued" };
  return { ...base, status: "completed" };
}

/**
 * Project stage rows onto the plan: one entry per planned (stage, unit)
 * pair, in plan order. Total by construction — a planned pair with no
 * row is present as never-attempted. Rows whose stage is not in the
 * plan are ignored (they belong to another run or an unplanned stage),
 * never fabricated into an entry.
 */
export function checkpointFromStageRows(
  runId: string,
  rows: StageRowLike[],
  plan: StageRunnerPlan,
): StageRunnerCheckpoint {
  const units = plan.units.length > 0 ? plan.units : [{ unitId: plan.runId }];
  const entries: StageUnitCheckpoint[] = [];
  for (const stage of plan.stages) {
    for (const unit of units) {
      const matched = rowsFor(rows, stage.stage, unit.unitId);
      const derived = statusFor(matched);
      entries.push({
        stage: stage.stage,
        unitId: unit.unitId,
        status: derived.status,
        attempt: matched.length,
        ...(derived.error ? { error: derived.error } : {}),
        ...(derived.updatedAt ? { updatedAt: derived.updatedAt } : {}),
      });
    }
  }
  return { runId, units: entries };
}

/**
 * The tests-only checkpoint store. Production reads and writes
 * mas_async_jobs through the queue port family (src/data/
 * asyncJobPorts.ts); this adapter exists so the contract's callers can
 * be exercised without a runtime, and it is never wired into a route.
 */
export function createInMemoryStageCheckpointStore(
  initial: StageRunnerCheckpoint[] = [],
): StageCheckpointStore {
  const store = new Map<string, StageRunnerCheckpoint>(initial.map((c) => [c.runId, c]));
  return {
    read: async (runId) => store.get(runId) ?? null,
    write: async (checkpoint) => {
      store.set(checkpoint.runId, checkpoint);
    },
  };
}
