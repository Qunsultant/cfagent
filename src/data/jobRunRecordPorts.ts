/**
 * Issue #2964 — per-run result record port: one record per job run,
 * for the unified Jobs UI.
 *
 * Issue #6101 overturns the #2964 NEVER-EITHER/OR decision with
 * evidence: the record IS read cross-instance — the unified Jobs
 * UI reads the D1 ledger, the reports routes read D1 run records,
 * and the trading routes merge orchestrator + goal runs from the
 * one ledger — so the record lives in D1, not DO-resident. The
 * DO `job_run_records` table is frozen pre-cutover history (DROP
 * in #6627); the ScheduledAgent KV `"jobRunRecords"` key is
 * retired (step 9) — the ScheduledAgent posts its rows to the
 * shared ledger through the ledger post instead. The old
 * DO-resident reasoning (ADR D-0, same-DO execution machinery)
 * no longer holds for this record: it is the cross-instance
 * ledger, and D1 is its home.
 *
 * This module carries the record types, the table name, the
 * per-job cap, and the store interface ONLY (ADR 0002 R1/R2).
 * Adapters: d1JobRunRecordAdapter.ts (production, D1),
 * inMemoryJobRunRecordAdapter.ts (test double).
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

/** The D1 table for run records (D1 since #6101; the DO table of the same name is frozen pre-cutover history). */
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
 *  machinery — no second run store. "job-outcome" is the #6006
 *  outcome-fold system: a D1 row created from a mas_job_outcomes
 *  row that has no engine D1 job_run_records twin (the twin-less
 *  kinds — corpus, reports, trading — and any outcome whose run
 *  left no job record). Its jobId IS the outcome id, so the row
 *  stays addressable by the run it records; started == finished ==
 *  the outcome's createdAt (a recorded outcome carries one
 *  timestamp, never an invented interval). */
export type JobRunSystem =
  | "scheduled-agent-goal"
  | "orchestrator-schedule"
  | "job-pipeline"
  | "worker-cron"
  | "job-outcome";

/** success | failure | skipped — see the header note on skipped. */
export type JobRunOutcome = "success" | "failure" | "skipped";

/** scheduled = the cadence fired it; manual = a Run-now / trigger;
 * triggered = a scheduler Run-now button; copilot = the copilot
 * dispatched it; autopilot = the autonomous loop dispatched it.
 * Venus ruling 2026-11-17 (#5028, #3214): the five dispatch modes.
 * One tuple is the source of truth: the type derives from it and
 * the zod schemas build from it, so a sixth mode lands in one place. */
export const JOB_RUN_TRIGGERS = [
  "scheduled",
  "manual",
  "triggered",
  "copilot",
  "autopilot",
] as const;

export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

/**
 * Issue #5052 — normalize an untrusted dispatch trigger onto the
 * five modes: a known mode passes through, anything else (unknown
 * string, missing value) reads as "manual" — never invented. This is
 * NOT resolveScheduleRunTrigger (jobRunRecords.ts): that derives a
 * schedule run's trigger and defaults to "scheduled"; this one is
 * the dispatch-site pass-through with the manual default.
 */
export function normalizeJobRunTrigger(value: unknown): JobRunTrigger {
  return (JOB_RUN_TRIGGERS as readonly string[]).includes(value as string)
    ? (value as JobRunTrigger)
    : "manual";
}

/**
 * Issue #6503 — attended vs unattended dispatch. The money gate
 * (native + cfpay) may mint a checkout ONLY for a run a user
 * initiated at submission: "manual" (UX one-off) and "triggered"
 * (a scheduler Run-now click — the user is present and authorizing
 * right now). "scheduled" (timer-fired), "copilot" and "autopilot"
 * are unattended: coverage-only, never an unattended card charge.
 * BUILD DECISION for Mars to confirm at the #6503 debrief: triggered
 * rides the manual side, copilot/autopilot ride the scheduled side.
 * One helper here, on the one definition — every gate and every
 * submission branch asks this, never a local two-way comparison.
 */
export function isAttendedTrigger(trigger: JobRunTrigger): boolean {
  return trigger === "manual" || trigger === "triggered";
}

/**
 * Issue #4767 — the run-kind vocabulary (user ruling 2026-11-18):
 * kind and trigger are TWO dimensions. The trigger says what
 * dispatched THIS execution; the kind says what this execution IS
 * relative to the original: `original` = a first dispatch,
 * `re-run` = a retry, a NEW run from the start (fresh run id, a
 * pointer back to the run it retried); `resume` = a paused run
 * continued under the SAME run id; `replay` = a still-running run
 * re-entered under the SAME run id after an eviction. A re-run can
 * be manual, scheduled, triggered, copilot, or autopilot — the kind
 * never constrains the trigger, and the trigger never implies the
 * kind. One tuple is the source of truth, as for the triggers.
 * NOT runLedgerKinds.ts (the ledger-family classifier) — a
 * different "kind" entirely.
 */
export const JOB_RUN_KINDS = ["original", "re-run", "resume", "replay"] as const;

export type JobRunKind = (typeof JOB_RUN_KINDS)[number];

/**
 * Issue #4767 — normalize an untrusted run kind onto the four
 * values: a known kind passes through, anything else (unknown
 * string, missing value) reads as "original" — fail-closed: a run
 * whose kind cannot be proven is read as a first dispatch. It
 * never claims to be a re-run of a run it cannot name.
 */
export function normalizeJobRunKind(value: unknown): JobRunKind {
  return (JOB_RUN_KINDS as readonly string[]).includes(value as string)
    ? (value as JobRunKind)
    : "original";
}

/**
 * Issue #3121 S1 — the consolidated run-ledger trigger vocabulary
 * (inventory §4; O4 decision: sits ALONGSIDE `triggeredBy`, it does
 * not supersede it). The eight-valued distinction `triggeredBy`
 * cannot express on its own: a cadence firing, a manual trigger, a
 * scheduler Run-now (`triggered`), a copilot dispatch (`copilot`),
 * an autonomous-loop dispatch (`autopilot`), a Worker cron
 * dispatch, an async-chain step, or — legacy rows only — `unknown`
 * (the producing path predates trigger stamping). No NEW row is ever
 * `unknown` or null: the builder derives `trigger` from
 * `triggeredBy` when a write site does not stamp one explicitly.
 * The three mode values come from Venus's five-dispatch-mode ruling
 * 2026-11-17 (#5028, #3214), which supersedes the O4 "triggeredBy
 * stays two-valued" half: the modes live in `triggeredBy` and are
 * carried into `trigger` by the derivation. worker-cron and
 * async-chain stay mechanism values, never dispatch modes.
 */
export type JobRunLedgerTrigger =
  | "scheduled"
  | "manual"
  | "triggered"
  | "copilot"
  | "autopilot"
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
  /** Issue #3121 S1 — §4 ledger trigger (eight-valued; see JobRunLedgerTrigger). */
  trigger?: JobRunLedgerTrigger;
  /** Issue #3121 S1 — originating schedule id (SDK schedule id, goal id, or Worker cron expression); null = no originating schedule. */
  scheduleId?: string | null;
  /** Issue #3121 S1 — mas_async_jobs.job_id this run is or links to; null = no async job. */
  asyncJobId?: string | null;
  /** Issue #3121 S1 — Cloudflare Workflow instance id; null = did not execute through a workflow. */
  workflowId?: string | null;
  /**
   * Issue #4767 — the run kind (what this execution IS relative
   * to the original: original / re-run / resume / replay) and the
   * origin run id. Optional on the interface so rows stored before
   * #4767 still parse; the builder always fills them on new rows
   * (see `src/services/jobRunRecords.ts`), and the read normalizer
   * fills them as `original`/null on legacy rows. `originRunId` is
   * the run this execution retried (re-run) or the run itself
   * (resume/replay, same run id) — never an invented link.
   */
  kind?: JobRunKind;
  originRunId?: string | null;
  /**
   * Issue #5887 — the definition version this run executed, stamped at
   * dispatch. Null (or absent) means the row predates the stamp: a
   * replay must refuse it by name, never guess the closest version.
   */
  definitionVersion?: number | null;
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
   * backfilled from the currently selected broker. D1-backed rows
   * carry these fields too (issue #6557); the DO table carried them
   * first, and is frozen now.
   */
  brokerId?: string | null;
  dataProviderId?: string | null;
  mode?: "live" | "paper" | null;
  /** Issue #3655 (effective mode): which resolver leg produced the mode — pin | selection | inference. */
  modeSource?: "pin" | "selection" | "inference" | null;
  /**
   * Issue #5100 (F3 of #5094): the binding tuple the run executed
   * against, stamped from the firing schedule payload (recorded at
   * creation). Absent on rows recorded before the tuple existed —
   * never backfilled. Issue #5102 (F5 of #5094): D1-backed rows
   * carry these fields too, via migration 0084 (the DO-SQLite
   * ledger was the first surface to store them, in F3).
   */
  accountType?: string | null;
  accountId?: string | null;
  bindingScope?: string | null;
  bindingSource?: string | null;
  /**
   * Issue #6101 — the identity columns (D1 migration 0093): the
   * FK-spine columns for platform/user/session plus the plain
   * correlation/trace columns. Optional so rows recorded before
   * the cutover still parse; absent reads as null, never
   * backfilled. No master tables exist yet (#6427), so the
   * REFERENCES constraints wait on the masters — the columns are
   * the spine, and the ER relationships are declared in
   * docs/architecture/data/data-model.md §2.2.
   */
  tenantId?: string | null;
  platformId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  traceId?: string | null;
  /**
   * Issue #6006 — the outcome facts a folded mas_job_outcomes row
   * carries on the one run source (D1 migration 0086). Optional so
   * rows recorded before the fold still parse; absent reads as null,
   * never invented. `codedError` is the coded error, distinct from
   * the free-text `error`; `origin` is the outcome's origin label
   * (e.g. "job-tree", "corpus-sync"), distinct from `originRunId`
   * (the #4767 retry lineage). `scanned`/`matched` are the run's
   * scan counts; `deliveryStates` the per-channel delivery states;
   * the four key fields the run's typed artifact links.
   */
  codedError?: string | null;
  origin?: string | null;
  scanned?: number | null;
  matched?: number | null;
  deliveryStates?: Record<string, string> | null;
  pdfKey?: string | null;
  xlsxKey?: string | null;
  csvKey?: string | null;
  reportUrl?: string | null;
}

/** The per-run record store surface (synchronous: the in-memory store and the retired DO adapter; the D1 writer is async — see createJobRunRecordPorts.ts). */
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
