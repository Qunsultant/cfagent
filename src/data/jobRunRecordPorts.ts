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

/** Which schedule system ran. Issue #3121 S5: Worker cron
 *  dispatches now record their own rows (system `"worker-cron"`),
 *  so the pre-S5 note — "Worker cron triggers never run as jobs,
 *  so they have no records and no value here" — no longer holds.
 *  A dispatch row's `jobId`/`scheduleId` is its cron expression.
 *  "job-pipeline" is the Pipeline J1 job system (issue #3534):
 *  pipeline jobs record their terminal runs through this same
 *  machinery — no second run store. */
export type JobRunSystem =
  | "scheduled-agent-goal"
  | "orchestrator-schedule"
  | "job-pipeline"
  | "worker-cron";

/** success | failure | skipped — see the header note on skipped. */
export type JobRunOutcome = "success" | "failure" | "skipped";

/** scheduled = the cadence fired it; manual = a Run-now / trigger. */
export type JobRunTrigger = "scheduled" | "manual";

/**
 * Issue #3121 S1 — the consolidated run-ledger trigger vocabulary
 * (inventory §4; O4 decision: sits ALONGSIDE `triggeredBy`, it does
 * not supersede it). The five-way distinction `triggeredBy` cannot
 * express: a cadence firing, a manual trigger, a Worker cron
 * dispatch, an async-chain step, or — legacy rows only — `unknown`
 * (the producing path predates trigger stamping). No NEW row is ever
 * `unknown` or null: the builder derives `trigger` from
 * `triggeredBy` when a write site does not stamp one explicitly.
 */
export type JobRunLedgerTrigger =
  | "scheduled"
  | "manual"
  | "worker-cron"
  | "async-chain"
  | "unknown";

/**
 * Issue #3121 S1 — the four §4 linkage fields, as one value. A
 * `null` is a recorded fact, never a missing column: `scheduleId`
 * null = no originating schedule exists; `asyncJobId` null = this
 * run neither is nor links to an async job; `workflowId` null = this
 * run did not execute through a workflow. Legacy rows read back as
 * `trigger: "unknown"` with all three ids null.
 */
export interface LedgerLinkage {
  trigger: JobRunLedgerTrigger;
  scheduleId: string | null;
  asyncJobId: string | null;
  workflowId: string | null;
}

/**
 * One run of one job. `operation` is the ScheduledAgent goal
 * operation (e.g. "index.refresh_wikipedia") or the orchestrator
 * callback name (e.g. "autonomousMarketScreen"). `error` is required
 * on failure, `detail` is required on skipped (the skip reason),
 * `descriptor`/`artifactRefs` carry the success summary and the
 * produced artifact references (report keys, job ids).
 *
 * Issue #3121 S1 — the §4 consolidated-ledger linkage: `trigger`,
 * `scheduleId`, `asyncJobId`, `workflowId` (extended, not a rewrite).
 * Optional on the interface so rows stored before S1 still parse;
 * the builder always fills them on new rows (see
 * `src/services/jobRunRecords.ts`), and the read normalizer fills
 * them as `unknown`/null on legacy rows (see
 * `src/services/consolidatedScheduling.ts`).
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
  /** Issue #3121 S1 — §4 ledger trigger (five-valued; see JobRunLedgerTrigger). */
  trigger?: JobRunLedgerTrigger;
  /** Issue #3121 S1 — originating schedule id (SDK schedule id, goal id, or Worker cron expression); null = no originating schedule. */
  scheduleId?: string | null;
  /** Issue #3121 S1 — mas_async_jobs.job_id this run is or links to; null = no async job. */
  asyncJobId?: string | null;
  /** Issue #3121 S1 — Cloudflare Workflow instance id; null = did not execute through a workflow. */
  workflowId?: string | null;
  /** Failure error text. Required when outcome is "failure". */
  error?: string;
  /** Skip reason. Required when outcome is "skipped". */
  detail?: string;
  /** Success summary (e.g. "job:job_123", "Scanned 400 symbols, 12 matched"). */
  descriptor?: string;
  /** Artifact references on success (report keys, chain ids). */
  artifactRefs?: string[];
  /**
   * Issue #3655: broker + data-provider + mode provenance for the run,
   * stamped from the firing schedule payload (recorded at creation).
   * Absent on rows recorded before provenance existed — never
   * backfilled from the currently selected broker. D1-backed rows do
   * not carry these fields yet (no migration adds the columns there);
   * the DO-SQLite ledger is the surface that stores them.
   */
  brokerId?: string | null;
  dataProviderId?: string | null;
  mode?: "live" | "paper" | null;
  /** Issue #3655 (effective mode): which resolver leg produced the mode — pin | selection | inference. */
  modeSource?: "pin" | "selection" | "inference" | null;
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
