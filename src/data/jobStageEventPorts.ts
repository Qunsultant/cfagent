/**
 * Issue #4360 ([Stage visibility] started event + stage-store
 * persistence) — the durable per-stage event record.
 *
 * The engine already publishes every stage transition on the
 * `job-pipeline-events` queue; nothing consumed them. This port is the
 * store behind that consumer: one row per publication, addressed by the
 * #2869 claim key (`runId::stageId`) plus the action and the recorded
 * instant, so a re-delivery is ignored while a stage's `started` and its
 * terminal event both persist.
 *
 * Types and the port interface only (ADR 0002 R1/R2). Adapters:
 * `d1JobStageEventAdapter.ts` (production, D1 `job_stage_events` —
 * the #6101 step-7 writer; the DO adapter is deleted),
 * `inMemoryJobStageEventAdapter.ts` (tests).
 */

export const JOB_STAGE_EVENTS_TABLE = "job_stage_events";

/** One persisted stage publication. */
export interface JobStageEventRecord {
  /** The event's identity: claim key + action + unit + recorded instant. */
  eventKey: string;
  /** The #2869 stage claim key (`runId::stageId`) — the exactly-once scope. */
  claimKey: string;
  runId: string;
  jobId: string;
  stageId: string;
  unitId: string | null;
  /** The published action: started · completed · failed · timed_out · stopped · cancelled · retired · run · rerun · … */
  action: string;
  at: string;
  /** When the unit started, as the engine recorded it (null when it never started). */
  startedAt: string | null;
  /** When the unit reached a terminal state (null while it is still running or resumable). */
  endedAt: string | null;
  detail: string | null;
  /**
   * Issue #6028 — the stage-level terminal row's fields. A row with
   * `action: "terminal"` is the run-level summary of one stage and
   * carries them; the per-unit transition rows (`started` /
   * `completed` / `failed`) leave them absent, so the two vocabularies
   * never impersonate each other.
   */
  /** `completed` | `failed` | `stopped` | `running` — the engine's recorded status, never inferred. */
  stageStatus?: string;
  /** `endedAt − startedAt`; null when either stamp is missing — never 0, never estimated. */
  durationMs?: number | null;
  /** The units the stage planned. */
  unitCount?: number;
  /** The units that ended failed (failed or timed out). */
  failedUnitCount?: number;
  /** The step descriptors the stage's units returned, in unit order; null when none did. */
  resultRef?: string | null;
  /** The spec version the run executed; null for a definition with no version. */
  definitionVersion?: number | null;
}

export interface JobStageEventStore {
  /** Insert one publication. Returns false when this exact event was already recorded. */
  record(event: JobStageEventRecord): Promise<boolean>;
  /** A run's events, in the order they were recorded. */
  listByRun(runId: string): Promise<JobStageEventRecord[]>;
}
