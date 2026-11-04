/**
 * Issue #1676 ([AGENTIC] Slice 2, shard jobs projection) —
 * port module (R1). Domain code depends ONLY on these interfaces.
 *
 * This module is deliberately free of any store client, any
 * binding reference, and any query language: no adapter import,
 * no store-specific type. The composition root
 * (src/data/createShardJobPorts.ts) wires a store adapter to
 * these ports; domain code never sees the adapter.
 *
 * Grain: one row per (chain, job). A completed inline leg
 * reports its shard ids; a submitted leg reports its rails job
 * id; a failed leg reports its step. Legs that did not run —
 * skipped, blocked, unimplemented — project nothing, because
 * there is no job to record.
 *
 * Read contract: latestJob / listJobsForChain /
 * listJobsByStatus answer from the highest-version row per job
 * for the tenant. A projection read may lag one transition
 * (R5); any consumer that cannot tolerate lag reads the
 * durable object directly and says so.
 *
 * Write contract (R5): one row per (tenant, chain, job,
 * version). Replaying the same status is a no-op, so
 * at-least-once delivery is safe. A status change writes a
 * HIGHER version row, never an overwrite, so a job's lifecycle
 * stays auditable.
 *
 * Tenancy (R7): every method takes a tenant id resolved
 * server-side. There is no unscoped read method anywhere in
 * this module; adapters inject the tenant predicate into every
 * query.
 *
 * Scope note: this slice covers shard job rows only. Audit and
 * report ports land in later slices; nothing here may grow a
 * second store's rows. No row type here carries auth material
 * of any kind — a writer accepting such a row is a defect,
 * pinned by test. Submission specs are never stored: a
 * submitted row keeps only the job id and detail, never the
 * spec payload.
 */

/** Terminal-or-queued states a projected job can hold. */
export type ShardJobStatus = "completed" | "submitted" | "failed";

/** Outcomes a chain leg can report (mirrors runChain's leg statuses). */
export type LegOutcomeStatus =
  | "completed"
  | "submitted"
  | "failed"
  | "skipped"
  | "blocked"
  | "unimplemented";

/** One versioned row of a shard job's projection. */
export interface ShardJobRow {
  tenantId: string;
  workspaceId: string;
  /** The chain this job ran (or was submitted) for. */
  chainId: string;
  /**
   * Job identity: an inline shard id (`chain-exec:*`), a rails
   * job id, or `leg:<stepId>` for a failed leg with no job id.
   */
  jobKey: string;
  /** Projection version: one higher per projected transition. */
  version: number;
  status: ShardJobStatus;
  /** Pipeline stage of the leg (feed, generate, store, serve, deliver). */
  stage: string;
  /** Registry capability id of the leg. */
  capabilityId: string;
  /** Human-readable outcome detail. */
  detail: string;
  /** Capped JSON summary of the outcome (never a spec payload). */
  resultJson: string;
  /** Epoch milliseconds the job was first projected. */
  createdAtMs: number;
  /** Epoch milliseconds this projection row was written. */
  updatedAtMs: number;
  /** Writer provenance: which component wrote the row. */
  provenanceWriter: string;
  /** Source durable object that owns the authoritative state. */
  provenanceSourceDo: string;
  /** Row-shape version of the mapping (1 in slice 2). */
  provenanceSourceVersion: string;
  /**
   * Issue #2989: the Cloudflare workflow run-id for this job —
   * the ACTUAL instance id used at start (derived or fallback),
   * as returned by the ONE seam (workflowInstanceSeam). It IS
   * the Cloudflare workflow id: create() returns only instance.id
   * and status() returns only status/output/error, so there is
   * no second identifier to store. Absent on rows projected
   * before #2989 and on rows whose starter never knew its own
   * instance id (a parent flow cannot know its own id from
   * inside); those rows keep correlating via the derived id.
   */
  workflowRunId?: string;
}

/** One leg outcome handed to the projector by a run. */
export interface LegOutcome {
  stepId: string;
  capabilityId: string;
  stage: string;
  status: LegOutcomeStatus;
  detail: string;
  /**
   * Raw leg result, when the runner produced one: a completed
   * leg's execution result (with shardJobIds) or a submitted
   * leg's submission record (with jobId). The projector reads
   * only job ids and outcome summaries out of it — never a
   * spec payload.
   */
  result?: unknown;
  /**
   * Issue #2989: the Cloudflare workflow run-id of the child
   * instance that produced this outcome, when the projecting
   * flow knows it (the screener parent's pending map). Carried
   * onto the projected row; absent where the flow never started
   * a child (refusals, parent legs).
   */
  workflowRunId?: string;
}

/** Tenant-scoped reads over the shard job projection. */
export interface ShardJobReader {
  latestJob(
    tenantId: string,
    chainId: string,
    jobKey: string,
  ): Promise<ShardJobRow | null>;
  /** Latest row per job for one chain, newest first. */
  listJobsForChain(
    tenantId: string,
    chainId: string,
  ): Promise<ShardJobRow[]>;
  /** Latest rows holding one status, newest first. */
  listJobsByStatus(
    tenantId: string,
    status: ShardJobStatus,
  ): Promise<ShardJobRow[]>;
}

/** Idempotent versioned writes over the projection. */
export interface ShardJobProjectionWriter {
  recordJob(row: ShardJobRow): Promise<void>;
}

/** The slice-2 store surface: one reader plus one writer. */
export interface ShardJobStore
  extends ShardJobReader,
    ShardJobProjectionWriter {}
