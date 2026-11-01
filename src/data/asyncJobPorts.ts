/**
 * Issue #2358 (#1976 step 4a, ADR 0022 D-I step 4) — the
 * async-job queue family ports: THREE ports by role over the
 * single table mas_async_jobs (step-4 audit §4.5).
 *
 * ADR D-0 ruled this family DO-resident behind ports,
 * decisively (audit §3/§4.4): the record is one half of a
 * mechanism whose other half — the Agents SDK schedule/alarm
 * row in cf_agents_jobs — lives in the same instance, and the
 * claim transition relies on the instance's serialization over
 * its own storage (properties (b)(e)(f)). This module carries
 * the record types and the port interfaces ONLY (ADR 0002
 * R1/R2). Adapters: doSqliteAsyncJobAdapter.ts (production),
 * inMemoryAsyncJobAdapter.ts (test double). The legacy modules
 * (src/agents/orchestrator/asyncJobs.ts, src/services/
 * asyncJobGate.ts, src/services/shardJobs.ts' chain reader,
 * src/agents/routes/workflowRuns.ts, src/agents/routes/
 * maintenance.ts) serve through these ports; their pure domain
 * logic (display names, follow-up planning, chain planning,
 * payload classification) stays where it lives.
 *
 * THE CLAIM RULING (audit R-7, binding): the claim is NOT
 * wrapped in a transaction. Its atomicity is (b) serialization
 * plus the guarded UPDATE (AND status='queued') whose
 * rowsWritten is verified by the caller — claim() returns
 * exactly that verification: true iff the guarded update wrote
 * one row. A second claim of a claimed (or terminal) job
 * returns false — the honest not-claimed outcome — and writes
 * nothing. No new states, no changed retry semantics: the
 * status domain stays the closed set in src/types.ts
 * (queued | running | completed | failed).
 *
 * TRANSACTION SEAM (ADR D-C): deliberately none. Every queue
 * operation is a single statement (the claim's guard makes the
 * one multi-step transition safe), submit's retention prunes
 * are idempotent bounded maintenance applied sequentially
 * exactly as in the legacy module, and the stale-running reap
 * inside the read path is a single guarded UPDATE. No wrap is
 * claimed anywhere in this family.
 *
 * DDL OWNERSHIP: mas_async_jobs' DDL had THREE homes (the
 * orchestrator's ensureTables CREATE, asyncJobs' graph
 * migration, asyncJobGate's index). ensureSchema() on the
 * queue port is now the one home: base table + session index +
 * gate index + the probed graph migration, ensure-style
 * additive so existing instances upgrade in place.
 */
import type { SqlStorage } from "../orm";
import type { AsyncJobStatus } from "../types";

export type AsyncJobSqlExecutor = SqlStorage;

/** The full stored row, exactly as the table holds it. */
export interface AsyncJobStoredRow {
  job_id: string;
  session_id: string;
  capability: string;
  display_name: string;
  status: AsyncJobStatus;
  payload_json: string | null;
  result_json: string | null;
  response_status: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  parent_job_id: string | null;
  job_kind: string | null;
  channel: string | null;
  not_before: string | null;
  stage: string | null;
  chain_id: string | null;
  /** Issue #2567: the stuck-running alert claim — the ISO instant
   *  the (single) stuck alert was claimed for this row, or NULL
   *  while unclaimed. Probed additive column, same migration
   *  family as the graph columns above. */
  stuck_alerted_at: string | null;
}

/** The list projection: the legacy list SELECT never read
 *  response_status, so the list row does not carry it. */
export type AsyncJobListRow = Omit<AsyncJobStoredRow, "response_status">;

/** The workflow-runs full-row projection (payload included). */
export type AsyncJobWorkflowRow = AsyncJobStoredRow;

/** One chain's rows as the shard planner reads them (raw). */
export interface AsyncJobChainRow {
  job_id: string;
  stage: string | null;
  status: string;
  payload_json: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  parent_job_id: string | null;
}

export interface InsertQueuedJobInput {
  jobId: string;
  sessionId: string;
  capability: string;
  displayName: string;
  /** Serialized payload, already size-checked by the caller. */
  payloadJson: string;
  nowIso: string;
  parentJobId?: string | null;
  jobKind?: string | null;
  channel?: string | null;
  notBefore?: string | null;
  stage?: string | null;
  chainId?: string | null;
}

export interface InsertTerminalJobInput {
  jobId: string;
  sessionId: string;
  capability: string;
  displayName: string;
  status: "completed" | "failed";
  payloadJson: string;
  resultJson: string;
  error: string | null;
  nowIso: string;
  jobKind?: string | null;
  stage?: string | null;
  chainId?: string | null;
}

/**
 * The lifecycle core: submit-side inserts, the guarded claim,
 * the terminal transitions, and the submit-time retention
 * prunes. Owns the status machine and the closed-domain
 * invariant. All methods are synchronous, mirroring the legacy
 * modules' seam (the DO's per-instance serialization is the
 * concurrency mechanism).
 */
export interface AsyncJobQueuePort {
  /** The family's ONE DDL home: base table, session index,
   *  gate index, and the probed graph-column migration.
   *  Ensure-style additive; idempotent. */
  ensureSchema(): void;
  /** The already-running gate's seek index alone (the gate
   *  module's standalone ensure, as before). Idempotent. */
  ensureGateIndexes(): void;
  /** Retention at submit: terminal rows older than the cutoff. */
  pruneTerminalBefore(sessionId: string, cutoffIso: string): void;
  /** Retention at submit: keep only the newest `keep` terminal
   *  rows for the session. */
  pruneTerminalToCap(sessionId: string, keep: number): void;
  /** Insert a job at 'queued' (conflict policy: insert-or-throw
   *  on the job_id primary key, ADR D-E.1). */
  insertQueued(input: InsertQueuedJobInput): void;
  /** The arm-failure transition: queued -> failed, guarded on
   *  still-queued. Returns rows written. */
  failQueued(jobId: string, error: string, nowIso: string): number;
  /** Insert a row directly at a terminal status (the screener-
   *  run bridge: the run already finished elsewhere). */
  insertTerminal(input: InsertTerminalJobInput): void;
  /**
   * THE CLAIM (audit R-7): the guarded UPDATE queued -> running.
   * Returns true iff exactly one row was written — the caller
   * treats false as the honest not-claimed outcome and stops.
   * NOT transaction-wrapped, by ruling.
   */
  claim(jobId: string, sessionId: string, nowIso: string): boolean;
  /** The completion transition: running -> completed, guarded
   *  on still-running. Returns rows written. */
  complete(jobId: string, resultJson: string, responseStatus: number | null, nowIso: string): number;
  /** The failure transition: running -> failed, guarded on
   *  still-running. Returns rows written. */
  failRunning(jobId: string, error: string, nowIso: string): number;
  /** The stale-running reap (invoked from the read path):
   *  running -> failed with the unknown-outcome error, guarded
   *  on still-running. Returns rows written. */
  reapStaleRunning(jobId: string, error: string, nowIso: string): number;
  /** Issue #2567: the stuck-alert claim — stamps stuck_alerted_at,
   *  guarded on still-running AND not-yet-claimed, so exactly one
   *  caller ever wins the alert for a row. NOT a lifecycle
   *  transition (status and updated_at are untouched). Returns
   *  rows written: 1 = this caller claimed the alert. */
  markStuckAlerted(jobId: string, nowIso: string): number;
}

/**
 * The graph/read model: every read surface of the family —
 * the executor's own pre-reads, the jobs list/get, recovery,
 * retry's source scan, chain rows for the shard planner and
 * the chain-executor overlay, the workflow-runs full rows, and
 * the already-running gate's active-payload scan. None of
 * these readers holds the queue's write contract.
 */
export interface AsyncJobReadPort {
  /** The full row for (job, session), or undefined. */
  getRow(jobId: string, sessionId: string): AsyncJobStoredRow | undefined;
  /** Newest-first session rows (the list projection). */
  listRows(sessionId: string, limit: number): AsyncJobListRow[];
  /** Queued rows for recovery re-arming, oldest first. */
  listQueued(sessionId: string): Array<{ job_id: string; not_before: string | null }>;
  /** The executor's not-before pre-read. */
  getExecutionState(jobId: string, sessionId: string): { status: string; not_before: string | null } | undefined;
  /** The claimed row's execution projection. */
  getClaimed(jobId: string, sessionId: string): { capability: string; payload_json: string; stage: string | null; chain_id: string | null } | undefined;
  /** Retry's source row (identity + graph fields). */
  getRetrySource(jobId: string, sessionId: string): {
    job_id: string;
    capability: string;
    display_name: string;
    status: string;
    payload_json: string;
    parent_job_id: string | null;
    job_kind: string | null;
    channel: string | null;
    stage: string | null;
    chain_id: string | null;
  } | undefined;
  /** Every row of the session, for retry's duplicate scan. */
  listSessionPayloads(sessionId: string): Array<{ job_id: string; status: string; payload_json: string }>;
  /** A chain's rows in creation order (planner + overlay). */
  chainRows(chainId: string, sessionId: string): AsyncJobChainRow[];
  /** The workflow-runs surface's full rows, newest first. */
  workflowRunRows(sessionId: string, limit: number): AsyncJobWorkflowRow[];
  /** The already-running gate's scan: payloads of queued and
   *  running jobs (the closed-domain positive IN list). */
  activeJobPayloads(): Array<{ payload_json: string }>;
}

/**
 * The operator surface: preview counts + confirmed clears for
 * the maintenance route. Kept separate from the queue port so
 * no queue consumer holds a bulk-delete method (the audit's
 * D-E.4 degenerating-port warning). The route's fail-closed
 * allow-list stays the only holder of this port.
 *
 * Rules carried verbatim: rows with status 'running' are NEVER
 * deleted (counted as skipped by the caller from the same
 * breakdown); scope is always the caller's session. Missing-
 * table tolerance lives in the ROUTE, exactly as before — these
 * methods surface the store's own "no such table" error.
 */
export interface AsyncJobMaintenancePort {
  /** Per-status counts for the caller's session (preview). */
  countByStatus(sessionId: string): Array<{ status: string; n: number }>;
  /** Delete the session's rows in the given statuses. The
   *  caller never includes 'running' (the route filters it). */
  deleteByStatuses(sessionId: string, statuses: string[]): void;
  /** Delete every non-running row of the session. */
  deleteAllNonRunning(sessionId: string): void;
}

/** The gate's scan statement, kept as data so its query plan
 *  stays pinned by tests/asyncJobGate.test.ts (the positive IN
 *  list + the (status, created_at) index are what turn the scan
 *  into bounded seeks — issue #2280). The DO adapter executes
 *  exactly this statement for activeJobPayloads(). */
export const ACTIVE_JOB_PAYLOADS_SQL =
  "SELECT payload_json FROM mas_async_jobs WHERE status IN ('queued', 'running')";
