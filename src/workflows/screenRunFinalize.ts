/**
 * Issue #2861 (Phase 2 Slice 3 under #2764) — one persist-then-deliver
 * finalizer for the two REST stock-screen routes.
 *
 * GRASP Controller / Pure Fabrication: this module owns the single
 * ordering decision "a finished run is persisted before it is
 * delivered", which the routes previously implemented inconsistently:
 *   - E*TRADE single run: persist, then deliver (already correct).
 *   - E*TRADE ALL sharded runs: deliver every shard, then persist
 *     every shard (deliver-then-persist) — a delivery could go out
 *     for a run whose canonical report was never stored.
 *   - Market-data single + sharded runs: persist only; there is no
 *     deliver step (Slice 1 spec: deliver false), so the deliver
 *     callback is simply absent here.
 *
 * This slice unifies all four paths on persist-then-deliver: for
 * each result, in order, await persist, then await deliver when a
 * deliver step is supplied. Nothing else changes: the persist seam
 * stays persistScreenerReportCanonical (the one recorder), the
 * deliver seam stays publishOrBridge (the one delivery bridge /
 * outcome projection), and no retry, circuit, or catalog decision
 * is added here — those belong to pipelinePolicy, breakerDecorator,
 * and outcomeCatalog, reused as-is by the callers.
 *
 * Former known exception, closed by #2912 (G5): the E*TRADE
 * runScreen-throw failure path used to publish a failure notification
 * without a canonical persist, because the thrown failure object is
 * not a persistable run result (it lacks the report fields
 * persistScreenerReportCanonical requires). The route now fabricates
 * the failed-run shape a returned failure carries and runs it through
 * this finalizer, so a thrown failure persists-then-delivers exactly
 * like a returned result (and the store dedupes on generationId, so
 * a retry never creates a second row).
 *
 * Ordering within a shard list is sequential and per-result, not
 * persist-all-then-deliver-all: a later shard is never delivered
 * before its own persist completes, and a persist failure for one
 * result propagates (the caller sees the same failure it would
 * have seen from its inline persist call) instead of delivering
 * the remaining results first.
 */

export type ScreenRunPersist<T> = (result: T) => Promise<void>;
export type ScreenRunDeliver<T> = (result: T) => Promise<void>;

/**
 * Persist each result, then deliver it, in list order. When no
 * deliver step is supplied (market-data), this is persist-only.
 */
export async function persistThenDeliverAll<T>(args: {
  results: readonly T[];
  persist: ScreenRunPersist<T>;
  /** Absent = no deliver step for this path (market-data). */
  deliver?: ScreenRunDeliver<T>;
}): Promise<void> {
  for (const result of args.results) {
    await args.persist(result);
    if (args.deliver) await args.deliver(result);
  }
}
