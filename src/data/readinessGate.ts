/**
 * Issue #2753 (Platform Phase 7, program #2468) — readiness gate.
 *
 * The per-phase readiness pattern from #2468 §7 (deploy verify +
 * revert plan + §15) as an explicit evaluator. Prior phases applied
 * this pattern as process; this module makes it testable derivation
 * so a future readiness surface can consult it instead of
 * re-implementing the check.
 *
 * The evaluator takes a caller-supplied record and returns readiness
 * plus the exact missing items. It does not verify the claims: a
 * caller asserting deployVerified must have actually verified the
 * deploy — the module checks the record, not reality. That limit is
 * stated, not hidden.
 * Pure derivation — zero reads, zero writes, zero activation.
 */

export interface ReadinessRecord {
  /** Phase identifier; blank counts as missing. */
  phase: string;
  deployVerified: boolean;
  revertPlan: boolean;
  s15Present: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  missing: string[];
}

/** A phase is ready only when deploy + revert plan + §15 are all present. */
export function evaluateReadiness(record: ReadinessRecord): ReadinessResult {
  const missing: string[] = [];
  if (typeof record.phase !== "string" || record.phase.trim().length === 0) {
    missing.push("phase");
  }
  if (!record.deployVerified) missing.push("deployVerified");
  if (!record.revertPlan) missing.push("revertPlan");
  if (!record.s15Present) missing.push("s15Present");
  return { ready: missing.length === 0, missing };
}
