/**
 * Issue #2869 (under #2764) — throttling, batching, and
 * checkpointing for large-volume jobs (large stock
 * universes/shards, and options chains as the volume
 * example — same rule for both).
 *
 * Rule: a large job is split into batches, run at most
 * maxInFlight at once (throttling — an unbounded
 * Promise.all over every shard/symbol is the failure this
 * replaces), checkpointed per batch, and completed fully
 * or failed loudly with a missing-batch manifest — never
 * silently truncated, never marked partial-complete.
 *
 * planBatches is pure (sizes + throttle cap only). The
 * checkpoint is an in-memory tracker the caller drives per
 * batch; the durable form is the same shape written to the
 * job's canonical record by the caller (mas_async_jobs /
 * workflow collation), not a second store owned here.
 * missingBatchManifest derives the same manifest from an
 * existing workflow collation (Slice 6): a shard that did
 * not complete is a missing batch, by construction.
 */

export interface BatchPlan {
  index: number;
  start: number;
  end: number;
  size: number;
}

export interface BatchPlanResult {
  batches: BatchPlan[];
  /** The throttle cap the executor must honour (max concurrent batches). */
  maxInFlight: number;
  totalItems: number;
}

/**
 * Split totalItems into batches of at most batchSize, to be
 * run at most maxInFlight at once. Refuses loudly on
 * nonsense inputs (batchSize/maxInFlight below 1, negative
 * totals) — a silently empty plan for a real job would be
 * a silent truncation.
 */
export function planBatches(
  totalItems: number,
  batchSize: number,
  maxInFlight: number,
): BatchPlanResult {
  if (!Number.isInteger(totalItems) || totalItems < 0) {
    throw new Error(`planBatches refused: totalItems must be a non-negative integer, got ${String(totalItems)}.`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`planBatches refused: batchSize must be an integer >= 1, got ${String(batchSize)}.`);
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new Error(`planBatches refused: maxInFlight must be an integer >= 1, got ${String(maxInFlight)}.`);
  }
  const batches: BatchPlan[] = [];
  for (let start = 0, index = 0; start < totalItems; start += batchSize, index += 1) {
    const end = Math.min(start + batchSize, totalItems);
    batches.push({ index, start, end, size: end - start });
  }
  return { batches, maxInFlight, totalItems };
}

export interface BatchCheckpoint {
  markComplete(batchId: string): void;
  markFailed(batchId: string, reason: string): void;
  manifest(): BatchManifest;
}

export interface BatchManifest {
  total: number;
  completed: string[];
  failed: Array<{ batchId: string; reason: string }>;
  /** Batches neither completed nor failed — the loud-failure list. */
  missing: string[];
  /** True only when nothing is missing and nothing failed. */
  complete: boolean;
}

/** A per-job batch checkpoint tracker over a fixed batch id set. */
export function createBatchCheckpoint(batchIds: readonly string[]): BatchCheckpoint {
  const completed = new Set<string>();
  const failed = new Map<string, string>();
  const known = new Set(batchIds);
  return {
    markComplete(batchId: string) {
      if (!known.has(batchId)) {
        throw new Error(`batch checkpoint refused: unknown batchId "${batchId}".`);
      }
      failed.delete(batchId);
      completed.add(batchId);
    },
    markFailed(batchId: string, reason: string) {
      if (!known.has(batchId)) {
        throw new Error(`batch checkpoint refused: unknown batchId "${batchId}".`);
      }
      completed.delete(batchId);
      failed.set(batchId, reason);
    },
    manifest(): BatchManifest {
      const missing = [...known].filter((id) => !completed.has(id) && !failed.has(id));
      return {
        total: known.size,
        completed: [...completed],
        failed: [...failed.entries()].map(([batchId, reason]) => ({ batchId, reason })),
        missing,
        complete: missing.length === 0 && failed.size === 0,
      };
    },
  };
}

/**
 * The missing-batch manifest for a workflow collation: every
 * shard that did not complete is a missing batch. Reuses
 * the Slice 6 collation (screenerCollation.collateShards) —
 * no second checkpoint store, no second manifest shape.
 */
export function missingBatchManifest(collation: {
  shards: Array<{ shardId: string; status: string }>;
}): { complete: boolean; missing: string[] } {
  const missing = collation.shards
    .filter((shard) => shard.status !== "completed")
    .map((shard) => shard.shardId);
  return { complete: missing.length === 0, missing };
}
