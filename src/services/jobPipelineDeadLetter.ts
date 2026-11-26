/**
 * Issue #3967 — the poison run's home in the DLQ.
 *
 * The platform already has ONE dead-letter store (#2000): queue drops land
 * there, an operator lists the un-replayed rows, and a replay re-sends the
 * envelope to its source queue. A poison RUN is a different kind of landing —
 * there is no envelope to re-send, and the remedy is the retry route, not a
 * queue — so this module is the one place that maps the engine's landing onto
 * that store's shape. Two consequences, both deliberate:
 *
 * - the record carries NO envelope, so queue replay refuses it (`no_envelope`)
 *   instead of pretending to re-drive a run into a queue;
 * - the source is `job-pipeline`, so an operator can filter the one list by
 *   where the drop came from.
 *
 * The engine never learns the store's schema: it hands over a
 * `JobPoisonLanding`, and this adapter owns the translation.
 */
import type { DeadLetterStoreInsert } from "../messaging/deadLetterStorePorts";
import type { DeadLetterStore } from "../messaging/deadLetterStorePorts";
import type { JobPoisonLanding, JobPoisonLandingSink } from "./jobPipelineEngine";

/** The DLQ source a poison run's row names (the store's `queue` column). */
export const JOB_PIPELINE_DLQ_SOURCE = "job-pipeline";

/**
 * Map one landing onto the store's insert shape. The detail line is the
 * operator's index: it names the job, the stage and the code in one string,
 * because the store's columns carry the run and unit but not the job.
 */
export function poisonLandingToDeadLetter(
  landing: JobPoisonLanding,
  createdAtMs: number,
): DeadLetterStoreInsert {
  return {
    queue: JOB_PIPELINE_DLQ_SOURCE,
    reason: "poison_run",
    runId: landing.runId,
    unitId: landing.unitId,
    detail: `job=${landing.jobId} stage=${landing.stageId} code=${landing.code}: ${landing.message}`,
    // A run is not a queue message: nothing here can be re-sent to a queue.
    envelope: null,
    createdAtMs,
  };
}

/** The engine-facing sink over the one dead-letter store. */
export function deadLetterRunSink(store: DeadLetterStore): JobPoisonLandingSink {
  return async (landing) => {
    await store.insert(poisonLandingToDeadLetter(landing, Date.now()));
  };
}
