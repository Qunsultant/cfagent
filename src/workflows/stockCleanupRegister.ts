/**
 * Issue #2892 (under #2764) — cleanup-last retention register.
 *
 * Cleanup is last, and it deprecates only with a named
 * successor, after lossless checks, with no silent deletions
 * (Policy Gate, gitops §22: no file deletions; retire by
 * deprecating in place with a named successor).
 *
 * Audit finding: no qualifying deprecation exists in the
 * stock surface today, because the programme slices replaced
 * old paths IN PLACE rather than leaving parallel copies.
 * This register names every audited surface, its verdict,
 * and its successor or preservation reason — so a future
 * reader can tell the difference between "already replaced"
 * and "still to remove", instead of guessing.
 *
 * Verdicts:
 *   - "replaced-in-place": the old path is gone because a
 *     slice replaced its call sites; no parallel copy
 *     remains, so there is nothing left to delete.
 *   - "retained": deliberately kept. The fused runScreen
 *     path is #2869 follow-through (recorded degenerate
 *     case to migrate), not cleanup fodder — removing it
 *     here would break every sync screen.
 *   - "preserved-alias": deliberately kept for
 *     compatibility (bookmarks); the canonical form is
 *     named alongside.
 * Zero files are deleted by this slice, and
 * STOCK_CLEANUP_DEPRECATIONS is empty on purpose: issuing
 * a deprecation without a qualifying surface would be
 * invention. Any future removal needs a named successor
 * plus a lossless check in its own PR.
 */

export type CleanupVerdict = "replaced-in-place" | "retained" | "preserved-alias";

export interface StockCleanupEntry {
  surface: string;
  verdict: CleanupVerdict;
  /** Named successor, or the preservation reason when there is none. */
  successorOrReason: string;
}

/** Issued deprecations. Empty by audit finding, not by omission (see module header). */
export const STOCK_CLEANUP_DEPRECATIONS: readonly string[] = [];

export const STOCK_CLEANUP_RETENTIONS: readonly StockCleanupEntry[] = [
  {
    surface: "Hand-assembled run spec in the REST routes",
    verdict: "replaced-in-place",
    successorOrReason: "src/workflows/stockScreenRunSpec.ts (Slice 1 builder); no parallel copy remains.",
  },
  {
    surface: "Shard ternary copied across broker, NLQ port, and mesh door",
    verdict: "replaced-in-place",
    successorOrReason: "src/workflows/screenExecutionBroker.ts shardsForUniverse (Slice 7 policy); the three copies are gone.",
  },
  {
    surface: "Hand-derived scheduled planner values in ScheduledTasksService",
    verdict: "replaced-in-place",
    successorOrReason: "src/workflows/stockScreenPlanner.ts planScheduledScreen (Slices 5-6).",
  },
  {
    surface: "Deliver-then-persist ordering on E*TRADE ALL sharded runs",
    verdict: "replaced-in-place",
    successorOrReason: "src/workflows/screenRunFinalize.ts persistThenDeliverAll (Slice 3).",
  },
  {
    surface: "Fused single-call ScreenerAgent.runScreen path (stages in-process, no stage messages)",
    verdict: "retained",
    successorOrReason: "#2869 per-stage execution migration follow-through (recorded degenerate case); removing it here would break every sync screen.",
  },
  {
    surface: "Legacy hub tab aliases ?screenerTab= and ?tab=",
    verdict: "preserved-alias",
    successorOrReason: "Canonical ?view= (useUrlSyncedTabs); aliases preserved so existing bookmarks keep resolving.",
  },
];

export function stockCleanupRetentions(): readonly StockCleanupEntry[] {
  return STOCK_CLEANUP_RETENTIONS;
}

/** Unknown surfaces resolve to undefined, never an invented verdict. */
export function stockCleanupRetentionBySurface(
  surface: string,
): StockCleanupEntry | undefined {
  return STOCK_CLEANUP_RETENTIONS.find((entry) => entry.surface === surface);
}
