/**
 * Issue #2753 (Platform Phase 7, program #2468) — risk register.
 *
 * The risk register for the mainnet gate (program amendment: a
 * resource budget + risk register at the mainnet gate) as a record +
 * surfacing derivation. Each record carries its risk, its mitigation
 * (or null when unmitigated), its revert path (or null when none is
 * recorded), and a blocksGate flag.
 *
 * One honesty limit: blocksGate is register-owner judgment that the
 * module SURFACES, never decides. The module does not infer which
 * risks block the gate — it partitions exactly what the register
 * says. A risk with no mitigation is unmitigated regardless of its
 * blocksGate flag, and a register with no gate-blocking risks is
 * reported as such, not as "safe" — safety is a gate judgment that
 * also weighs the mainnet checklist, the pilot gate, and the #2000 /
 * #1819 preconditions, none of which this module evaluates.
 * Pure derivation — zero reads, zero writes, zero activation.
 */

export interface RiskRecord {
  id: string;
  risk: string;
  mitigation: string | null;
  revertPath: string | null;
  blocksGate: boolean;
}

export interface RiskRegisterResult {
  open: RiskRecord[];
  unmitigated: RiskRecord[];
  gateBlockers: RiskRecord[];
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Partition a risk register: everything open, the unmitigated subset
 * (no mitigation recorded), and the gate-blocking subset (flagged by
 * the register owner).
 */
export function evaluateRiskRegister(risks: RiskRecord[]): RiskRegisterResult {
  const open = [...risks];
  const unmitigated = risks.filter((r) => !hasText(r.mitigation));
  const gateBlockers = risks.filter((r) => r.blocksGate === true);
  return { open, unmitigated, gateBlockers };
}
