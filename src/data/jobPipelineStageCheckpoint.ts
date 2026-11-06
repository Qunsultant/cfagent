/**
 * Issue #3549 (Pipeline J1, absorbing #3069) — the pipeline's
 * StageCheckpointStore: the stage runner's checkpoint port
 * (src/workflows/stageRunnerPorts.ts) over the job instance
 * store. The async-jobs production adapter projects its
 * checkpoint from mas_async_jobs rows and refuses writes (one
 * unit store, ADR 0022 D-0); a pipeline run writes no such
 * rows — its unit store is the job instance record, so this
 * adapter persists the checkpoint there (the
 * stage_checkpoint_json column), bound to one job the way the
 * async-jobs adapter binds to one chain.
 *
 * Read discipline mirrors the projection adapter: a missing
 * instance, a missing checkpoint, or a checkpoint for another
 * run reads as null — the honest "nothing recorded" state a
 * driver treats as a fresh run. Writes are read-modify-write
 * through the instance store, so a checkpoint write never
 * clobbers the record's management fields.
 */
import type {
  StageCheckpointStore,
  StageRunnerCheckpoint,
} from "../workflows/stageRunnerPorts";
import type { JobInstanceStore } from "./jobPipelinePorts";

/** A StageCheckpointStore over one job's instance record. */
export function createJobPipelineStageCheckpointStore(
  instances: JobInstanceStore,
  jobId: string,
): StageCheckpointStore {
  return {
    read: async (runId: string): Promise<StageRunnerCheckpoint | null> => {
      const instance = await instances.getInstance(jobId);
      if (!instance?.stageCheckpoint) return null;
      return instance.stageCheckpoint.runId === runId ? instance.stageCheckpoint : null;
    },
    write: async (checkpoint: StageRunnerCheckpoint): Promise<void> => {
      const instance = await instances.getInstance(jobId);
      if (!instance) {
        throw new Error(
          `job pipeline stage checkpoint refused: no instance record for job "${jobId}" — a checkpoint write before the job's first dispatch has no unit store to land in.`,
        );
      }
      await instances.saveInstance({
        ...instance,
        stageCheckpoint: checkpoint,
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
