/**
 * Issue #773 (b) — the ordering input: history reorders structures, visibly.
 *
 * The reorder existed since #773 (a), but it read `directionAccuracy` from a
 * slice that never carried it, so it never ran. (b) gives the slice the field
 * (from the recorded evaluations) and pulls the decision out of the pipeline
 * body into this pure function, so the rule is testable without a chain
 * fixture and the run can state exactly what it did.
 */
import type { TrackRecordSlice } from "./researchTrackRecord";
import type { ResearchRules } from "../config/researchRules";

export interface StructureOrdering {
  /** The structures in the order the run evaluates them. */
  names: string[];
  /** True only when history actually reordered something. */
  applied: boolean;
  /** The families that carried enough scored history to count. */
  considered: Array<{ key: string; directionAccuracy: number; evaluated: number }>;
}

/**
 * Order structure names by historical direction accuracy.
 *
 * - A family with fewer than `minEvaluated` evaluated ideas, or with no
 *   direction-scored evaluations, is neutral: it neither rises nor falls.
 * - Below `rules.trackRecordWeakBelow` the family sorts last; above
 *   `rules.trackRecordStrongAbove` it sorts first; in between it is neutral.
 * - Names with no slice at all are neutral (no data is not a verdict).
 */
export function orderStructuresByTrackRecord(
  names: readonly string[],
  slices: readonly TrackRecordSlice[],
  rules: ResearchRules,
  minEvaluated: number,
): StructureOrdering {
  const byKey = new Map<string, TrackRecordSlice>();
  for (const slice of slices) {
    if (
      slice.directionAccuracy != null &&
      Number.isFinite(slice.directionAccuracy) &&
      slice.evaluated >= minEvaluated
    ) {
      byKey.set(slice.key, slice);
    }
  }
  const considered = [...byKey.values()]
    .map((slice) => ({
      key: slice.key,
      directionAccuracy: slice.directionAccuracy as number,
      evaluated: slice.evaluated,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const rank = (name: string): number => {
    const slice = byKey.get(name);
    if (!slice) return 0; // no usable history → neutral
    const accuracy = slice.directionAccuracy as number;
    if (accuracy < rules.trackRecordWeakBelow) return -1;
    if (accuracy > rules.trackRecordStrongAbove) return 1;
    return 0;
  };
  const ordered = [...names].sort((a, b) => rank(b) - rank(a));
  const applied = ordered.some((name, index) => name !== names[index]);
  return { names: ordered, applied, considered };
}
