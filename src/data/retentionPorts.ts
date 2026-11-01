/**
 * Issue #1701 ([AGENTIC] Slice 6, retention enforcement) —
 * port module (R1). Domain code depends ONLY on these
 * interfaces.
 *
 * This module is deliberately free of any store client, any
 * binding reference, and any query language: no adapter import,
 * no store-specific type. The composition root
 * (src/data/createRetentionPorts.ts) wires a store adapter to
 * these ports; domain code never sees the adapter.
 *
 * Allowlist (R8): the purge may touch exactly the AgentDB
 * tables declared BOUNDED in src/security/storageRetention.ts.
 * Today that is one table, agent_shard_jobs. KEEP tables
 * (chains, schedules, audit, reports, governance) are
 * unreachable from the purge path by construction — the
 * store interface below knows only shard-job keys — and a
 * test pins the allowlist against the contract. No row type
 * here carries auth material of any kind.
 *
 * Grain note: all versions of a shard job share createdAtMs
 * (first projection time, slice 2), so an age purge keyed on
 * createdAtMs removes a whole job at once; a live job keeps
 * every version. The cap phase is per tenant, mirroring the
 * rails async-jobs 500-row terminal cap per session.
 */

/** Declared window for shard-job rows, days (contract: 30d). */
export const RETENTION_SHARD_JOB_WINDOW_DAYS = 30;

/** Declared cap for shard-job rows per tenant (contract: 500). */
export const RETENTION_SHARD_JOB_CAP_ROWS = 500;

/** Rows fetched + deleted per batch (mirrors storageRetention). */
export const RETENTION_PURGE_DEFAULT_BATCH_SIZE = 500;

/** Safety cap: maximum rows deleted in a single run (mirrors storageRetention). */
export const RETENTION_PURGE_DEFAULT_MAX_PER_RUN = 5000;

/**
 * The ONLY AgentDB tables the purge may touch. Pinned by test:
 * every entry must be a declared-BOUNDED table, and KEEP tables
 * never appear here.
 */
export const RETENTION_PURGE_TABLES = ["agent_shard_jobs"] as const;

export type RetentionPurgeTable = (typeof RETENTION_PURGE_TABLES)[number];

/** Primary key of one shard-job projection row. */
export interface ShardJobKey {
  chainId: string;
  jobKey: string;
  version: number;
}

/**
 * Minimal store surface the purge needs. Every method is
 * tenant-scoped; there is no unscoped method anywhere in this
 * module. Implemented by the D1 shard-job adapter and the
 * in-memory adapter; both operate on agent_shard_jobs only.
 */
export interface RetentionPurgeStore {
  /** Up to `limit` keys with createdAtMs < cutoffMs, oldest first. */
  listAgedShardJobKeys(
    tenantId: string,
    cutoffMs: number,
    limit: number,
  ): Promise<ShardJobKey[]>;
  /** Up to `limit` keys, oldest first (for the cap phase). */
  listOldestShardJobKeys(
    tenantId: string,
    limit: number,
  ): Promise<ShardJobKey[]>;
  /** Current row count for one tenant. */
  countShardJobs(tenantId: string): Promise<number>;
  /** Delete exactly the given rows for one tenant. */
  deleteShardJobs(tenantId: string, keys: ShardJobKey[]): Promise<void>;
}

export interface RetentionPurgeOptions {
  /** Window in days; defaults to RETENTION_SHARD_JOB_WINDOW_DAYS. <= 0 disables the purge. */
  windowDays?: number;
  /** Batch size per delete round. Defaults to RETENTION_PURGE_DEFAULT_BATCH_SIZE. */
  batchSize?: number;
  /** Max rows deleted per run. Defaults to RETENTION_PURGE_DEFAULT_MAX_PER_RUN. */
  maxPerRun?: number;
  /** Injectable clock (tests). */
  nowMs?: number;
}

export interface RetentionPurgeReport {
  table: RetentionPurgeTable;
  tenantId: string;
  /** Epoch-ms cutoff used, or null when skipped. */
  cutoffMs: number | null;
  /** Rows deleted by the age phase. */
  agedPruned: number;
  /** Rows deleted by the cap phase. */
  capPruned: number;
  /** Total rows deleted. */
  pruned: number;
  /** True when the per-run cap stopped the purge early. */
  capped: boolean;
  /** True when the purge was disabled (window <= 0) — nothing touched. */
  skipped: boolean;
  /**
   * Issue #1766: whether the purge run was appended as a
   * retention.purge IAAA audit event. Absent when the caller
   * does not audit (pure runner reports); false means the
   * audit write failed and the run must NOT be reported as
   * audited. The server purge wiring always sets it.
   */
  auditOk?: boolean;
}
