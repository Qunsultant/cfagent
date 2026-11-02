/**
 * Issue #2753 (Platform Phase 7, program #2468) — pilot gate.
 *
 * The limited pilot from #2468 §7 (testnet, named cohort) as an inert
 * gate. #2468 sequencing makes the pilot conditional on #2000
 * reliability + the #1819 headroom decision; this module does NOT
 * evaluate those preconditions (they are other lanes' issues) — it
 * evaluates only the pilot's own runnability, and its blockers list
 * names the pilot-level reasons. A caller that also needs the
 * preconditions must check #2000/#1819 separately; nothing here
 * implies they are met.
 *
 * A pilot is runnable ONLY when ALL of these hold:
 * - cohort is non-empty (blank-only entries do not count),
 * - cohortApproved is true (an owner/lane approval of the cohort),
 * - ownerGoAhead is true (an explicit owner go-ahead, not a default),
 * - testnetOnly is true (the pilot runs on testnet, never mainnet),
 * - all three observability hooks are true: revenue, usage, and the
 *   mas_events audit trail ship WITH the pilot, not after it.
 * No route, no trigger, no storage, no cohort provisioning exists in
 * this phase — the record is data, the gate is derivation, and the
 * combination is inert by construction. A pilot run requires a future
 * path that consults this gate AND the #2000/#1819 preconditions.
 * Pure derivation — zero reads, zero writes, zero activation.
 */

export interface PilotObservability {
  revenue: boolean;
  usage: boolean;
  audit: boolean;
}

export interface PilotRecord {
  cohort: string[];
  cohortApproved: boolean;
  ownerGoAhead: boolean;
  testnetOnly: boolean;
  observability: PilotObservability;
}

export interface PilotGateResult {
  runnable: boolean;
  blockers: string[];
}

/** Pilot runnability with the exact blocking reasons. */
export function isPilotRunnable(record: PilotRecord): PilotGateResult {
  const blockers: string[] = [];
  const cohort = Array.isArray(record.cohort)
    ? record.cohort.filter((c) => typeof c === "string" && c.trim().length > 0)
    : [];
  if (cohort.length === 0) blockers.push("cohort");
  if (!record.cohortApproved) blockers.push("cohortApproved");
  if (!record.ownerGoAhead) blockers.push("ownerGoAhead");
  if (!record.testnetOnly) blockers.push("testnetOnly");
  const obs = record.observability ?? { revenue: false, usage: false, audit: false };
  if (!obs.revenue) blockers.push("observability.revenue");
  if (!obs.usage) blockers.push("observability.usage");
  if (!obs.audit) blockers.push("observability.audit");
  return { runnable: blockers.length === 0, blockers };
}
