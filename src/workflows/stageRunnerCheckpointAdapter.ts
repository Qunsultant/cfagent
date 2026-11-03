/**
 * Issue #3027 (follower of #2601) — the production StageCheckpointStore
 * over mas_async_jobs.
 *
 * One unit store (ADR 0022 D-0, #2621): the rows are the checkpoint, so
 * `read` projects them and `write` is explicitly unsupported — a second
 * write path would be a second unit store, which the programme forbids.
 *
 * The chain's row shape is the shard planner's (`ShardRow` from
 * src/services/shardJobs.ts, itself a projection over the queue port
 * family's `chainRows`): the chain is one universe, so the chain IS the
 * unit and its stage rows are the legs. Reusing that projection means
 * this adapter cannot disagree with the planner about what a row means.
 */

import type { ShardRow } from "../services/shardJobs";
import { checkpointFromStageRows, type StageRowLike } from "./stageRunnerCheckpoint";
import type {
  StageCheckpointStore,
  StageRunnerCheckpoint,
  StageRunnerPlan,
} from "./stageRunnerPorts";

/** Named refusal for the one operation this adapter will not perform. */
export const STAGE_CHECKPOINT_WRITE_UNSUPPORTED =
  "stage-checkpoint-write-unsupported";

export interface AsyncJobStageCheckpointBind {
  /** The plan the run is executing (its stages and units are the projection's shape). */
  plan: StageRunnerPlan;
  /** The session the chain rows are scoped to (tenant isolation). */
  sessionId: string;
  /** The unit the chain represents (its universe), else the chain id. */
  unitId: string;
  /** The chain's rows, through the queue port family (never raw SQL here). */
  readChainRows: (chainId: string, sessionId: string) => ShardRow[];
}

/**
 * Project one chain's rows onto the plan. Pure over the rows it is
 * given, so a caller can test it without a store.
 *
 * Aggregation per (stage, unit) is the checkpoint projection's: any
 * failed leg fails the stage, a still-running leg keeps it running, and
 * a stage with no row at all is `never-attempted` — never "failed" and
 * never silently missing.
 */
export function checkpointFromChainRows(
  runId: string,
  rows: ShardRow[],
  plan: StageRunnerPlan,
  unitId: string,
): StageRunnerCheckpoint {
  const stageRows: StageRowLike[] = rows
    .filter((row) => row.stage !== undefined)
    .map((row) => ({
      unitId,
      stage: row.stage!,
      status: row.status as StageRowLike["status"],
      ...(row.error ? { error: row.error } : {}),
      ...(row.createdAt ? { updatedAt: row.createdAt } : {}),
    }));
  return checkpointFromStageRows(runId, stageRows, plan);
}

/**
 * The production checkpoint store for one bound run. `read` never
 * throws into a driver: an unavailable store returns null (the driver
 * then treats the run as having no checkpoint, which is the honest
 * "nothing recorded" state), and a store error is reported the same
 * way with a log line naming the run.
 */
export function createAsyncJobStageCheckpointStore(
  bind: AsyncJobStageCheckpointBind,
): StageCheckpointStore {
  return {
    read: async (runId) => {
      try {
        const rows = bind.readChainRows(runId, bind.sessionId);
        return checkpointFromChainRows(runId, rows, bind.plan, bind.unitId);
      } catch (err) {
        console.warn(
          `[stageCheckpoint] read failed for run ${runId}: ${err instanceof Error ? err.message : String(err)} — treating the run as having no recorded checkpoint.`,
        );
        return null;
      }
    },
    write: async () => {
      throw new Error(
        `${STAGE_CHECKPOINT_WRITE_UNSUPPORTED}: the stage checkpoint is projected from mas_async_jobs stage rows; writing it would create a second unit store (issue #3027, ADR 0022 D-0).`,
      );
    },
  };
}
