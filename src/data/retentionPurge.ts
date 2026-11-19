/**
 * Issue #1701 ([AGENTIC] Slice 6, retention enforcement) —
 * pure purge runner + governed job definition.
 *
 * No store client, no binding, no query language here: the
 * runner operates only on the RetentionPurgeStore port, so
 * the same code runs unchanged against the D1 adapter and
 * the in-memory adapter. The runner itself decides nothing
 * about any table except agent_shard_jobs — the port's
 * allowlist is the whole table surface.
 *
 * Phases, in order:
 *  1. Age: delete rows with createdAtMs strictly older than
 *     now - windowDays, oldest first, in bounded batches,
 *     until no aged row remains or the per-run cap stops it.
 *     A row exactly AT the cutoff survives (strict `<`,
 *     mirroring runStorageRetention).
 *  2. Cap: if the tenant still holds more than
 *     RETENTION_SHARD_JOB_CAP_ROWS rows, delete the oldest
 *     excess rows, oldest first, subject to the remaining
 *     per-run cap.
 * The runner is idempotent: a second run over the same
 * tenant prunes zero rows.
 *
 * Governed job: `runRetentionPurgeJob` is the job body an
 * operator activates (see RETENTION_PURGE_JOB). It skips
 * without purging when halted — the same fail-closed
 * direction as the tick — and a store failure is logged
 * and returned, never thrown into a firing path. The job
 * is single-tenant per invocation: the caller supplies the
 * tenant id (from IAAA resolution at activation time);
 * multi-tenant enumeration at activation is an operator
 * step, not something this module invents.
 */
import {
  RETENTION_PURGE_DEFAULT_BATCH_SIZE,
  RETENTION_PURGE_DEFAULT_MAX_PER_RUN,
  RETENTION_SHARD_JOB_CAP_ROWS,
  RETENTION_SHARD_JOB_WINDOW_DAYS,
  type RetentionPurgeOptions,
  type RetentionPurgeReport,
  type RetentionPurgeStore,
} from "./retentionPorts";

import { createStructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

const DAY_MS = 86_400_000;

/**
 * The retention-purge job definition (definition only —
 * activation is an operator step; no live scheduled job is
 * created by this slice). Cadence mirrors the mas retention
 * pass's nightly cron (storageRetention.ts).
 */
export const RETENTION_PURGE_JOB = {
  id: "agentdb-retention-purge",
  cron: "0 4 * * *",
  description:
    "Nightly AgentDB retention purge: expired agent_shard_jobs rows (30d) + 500-row tenant cap, tenant-scoped, idempotent, skipped while halted.",
} as const;

export async function runRetentionPurge(
  store: RetentionPurgeStore,
  tenantId: string,
  options: RetentionPurgeOptions = {},
): Promise<RetentionPurgeReport> {
  const windowDays = options.windowDays ?? RETENTION_SHARD_JOB_WINDOW_DAYS;
  const nowMs = options.nowMs ?? Date.now();
  if (!(windowDays > 0)) {
    return {
      table: "agent_shard_jobs",
      tenantId,
      cutoffMs: null,
      agedPruned: 0,
      capPruned: 0,
      pruned: 0,
      capped: false,
      skipped: true,
    };
  }
  const batchSize = Math.max(
    1,
    Math.floor(options.batchSize ?? RETENTION_PURGE_DEFAULT_BATCH_SIZE),
  );
  const maxPerRun = Math.max(
    1,
    Math.floor(options.maxPerRun ?? RETENTION_PURGE_DEFAULT_MAX_PER_RUN),
  );
  const cutoffMs = nowMs - windowDays * DAY_MS;

  let pruned = 0;
  let capped = false;

  // Phase 1 — age. Same loop shape as pruneAgedRows in
  // storageRetention.ts: select up to `limit` aged keys,
  // delete them, repeat until short or capped.
  let agedPruned = 0;
  for (;;) {
    const remaining = maxPerRun - pruned;
    if (remaining <= 0) {
      capped = true;
      break;
    }
    const limit = Math.min(batchSize, remaining);
    const keys = await store.listAgedShardJobKeys(tenantId, cutoffMs, limit);
    if (keys.length === 0) break;
    await store.deleteShardJobs(tenantId, keys);
    agedPruned += keys.length;
    pruned += keys.length;
    if (keys.length < limit) break;
  }

  // Phase 2 — cap. Only runs while per-run budget remains.
  let capPruned = 0;
  if (!capped) {
    const held = await store.countShardJobs(tenantId);
    let excess = held - RETENTION_SHARD_JOB_CAP_ROWS;
    while (excess > 0) {
      const remaining = maxPerRun - pruned;
      if (remaining <= 0) {
        capped = true;
        break;
      }
      const limit = Math.min(batchSize, remaining, excess);
      const keys = await store.listOldestShardJobKeys(tenantId, limit);
      if (keys.length === 0) break;
      await store.deleteShardJobs(tenantId, keys);
      capPruned += keys.length;
      pruned += keys.length;
      excess -= keys.length;
      if (keys.length < limit) break;
    }
  }

  return {
    table: "agent_shard_jobs",
    tenantId,
    cutoffMs,
    agedPruned,
    capPruned,
    pruned,
    capped,
    skipped: false,
  };
}

export interface RetentionPurgeJobInput {
  store: RetentionPurgeStore;
  tenantId: string;
  /** Halted (from the HaltRead the caller resolves, as the tick does). */
  halted?: boolean;
  options?: RetentionPurgeOptions;
  /**
   * #3515 S3 batch 7 — optional observability sink (d1QueryLogger
   * precedent): the composition root passes the env-constructed sink
   * when it holds env; without one the event goes to the structured
   * console fallback (never a `{}` sink, #5587).
   */
  sink?: ObservabilitySink;
}

export interface RetentionPurgeJobResult {
  skipped: boolean;
  /** "halted" when skipped for governance; absent otherwise. */
  reason?: string;
  report?: RetentionPurgeReport;
  /** Store failure message; the job never throws. */
  error?: string;
}

/**
 * Governed job body. Halted → skipped without touching the
 * store. Store failure → logged and returned, never thrown.
 */
export async function runRetentionPurgeJob(
  input: RetentionPurgeJobInput,
): Promise<RetentionPurgeJobResult> {
  // #3515 S3 batch 7 — logger over the injected sink (d1QueryLogger
  // precedent), else the structured console fallback (never a `{}` sink,
  // #5587). The job has no production caller yet (operator activation).
  const structuredLog = createStructuredLogger(
    input.sink ?? new ConsoleObservabilitySink(),
    { component: "data/retentionPurge" },
  );
  if (input.halted) {
    return { skipped: true, reason: "halted" };
  }
  try {
    const report = await runRetentionPurge(
      input.store,
      input.tenantId,
      input.options,
    );
    return { skipped: false, report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.error("retentionPurge.retention_purge_job_failed", {
      message:
        "[data-foundation] Retention purge job failed (tenant scoped, no rows assumed purged):",
      error: message,
      tenantId: input.tenantId,
    });
    return { skipped: false, error: message };
  }
}
