/**
 * Issue #2964 — per-run result record port: one record per job run,
 * for the unified Jobs UI. The record is one half of a single
 * mechanism whose other half — the Agents SDK schedule table, or the
 * ScheduledAgent goals key — lives in the same Durable Object's
 * storage, so the record stays DO-resident by the same ADR D-0
 * reasoning as the paused-schedule port (issue #2337): it is
 * execution machinery of the instance, not read cross-instance.
 *
 * This module carries the record types, the table name, the
 * per-job cap, and the store interface ONLY (ADR 0002 R1/R2).
 * Adapters: doSqliteJobRunRecordAdapter.ts (production, DO SQLite),
 * inMemoryJobRunRecordAdapter.ts (test double). The ScheduledAgent
 * side stores the same record shape under its own DO key-value key
 * ("jobRunRecords") — the stores are NOT merged (issue #2964
 * NEVER-EITHER/OR: the management surface unifies, the stores stay
 * separate, and scheduleSystems.ts carries the merge as a separate
 * slice, not smuggled in here).
 *
 * Outcome vocabulary is deliberately three-valued: success,
 * failure, and skipped. Goal executors and scheduled callbacks
 * genuinely skip (budget rejections, no-brief ticks, deduped slots,
 * unowned schedules, pre-first-rollup comparisons), and mapping a
 * skip to success or failure would mislabel the run. A skipped
 * record carries its reason in `detail`; a failure carries its
 * error text in `error` — never a silent skip, never a silent
 * failure.
 */

/** The DO-SQLite table for orchestrator-schedule run records. */
export const JOB_RUN_RECORDS_TABLE = "job_run_records";

/** Newest-first runs kept per orchestrator schedule. */
export const JOB_RUN_RECORDS_PER_JOB_CAP = 100;

/** Which schedule system ran. Worker cron triggers never run as jobs,
 *  so they have no records and no value here. */
export type JobRunSystem = "scheduled-agent-goal" | "orchestrator-schedule";

/** success | failure | skipped — see the header note on skipped. */
export type JobRunOutcome = "success" | "failure" | "skipped";

/** scheduled = the cadence fired it; manual = a Run-now / trigger. */
export type JobRunTrigger = "scheduled" | "manual";

/**
 * One run of one job. `operation` is the ScheduledAgent goal
 * operation (e.g. "index.refresh_wikipedia") or the orchestrator
 * callback name (e.g. "autonomousMarketScreen"). `error` is required
 * on failure, `detail` is required on skipped (the skip reason),
 * `descriptor`/`artifactRefs` carry the success summary and the
 * produced artifact references (report keys, job ids).
 */
export interface JobRunRecord {
  system: JobRunSystem;
  jobId: string;
  operation: string;
  /** ISO timestamps. */
  started: string;
  finished: string;
  outcome: JobRunOutcome;
  triggeredBy: JobRunTrigger;
  /** Failure error text. Required when outcome is "failure". */
  error?: string;
  /** Skip reason. Required when outcome is "skipped". */
  detail?: string;
  /** Success summary (e.g. "job:job_123", "Scanned 400 symbols, 12 matched"). */
  descriptor?: string;
  /** Artifact references on success (report keys, chain ids). */
  artifactRefs?: string[];
}

/** The per-run record store surface (synchronous: DO SQLite is sync). */
export interface JobRunRecordStore {
  /** Insert the record, then prune that job to the per-job cap. */
  record(record: JobRunRecord): void;
  /** That job's runs, newest first (started desc, insertion desc). */
  listByJob(jobId: string, limit?: number): JobRunRecord[];
  /** That job's newest run, or undefined when it never ran. */
  latestByJob(jobId: string): JobRunRecord | undefined;
  /** Recent runs across jobs, newest first. */
  listRecent(limit?: number): JobRunRecord[];
}
