/**
 * Issue #2753 (Platform Phase 7, program #2468) — mainnet gate checklist.
 *
 * The gated mainnet enablement from #2468 §7 as an enforced checklist,
 * not an activation. The program requires, in writing: owner-approved
 * prices per family, refund/proration policy, subscription + credits
 * rules, CISO review, CPO entitlement review, CTO implementation
 * review, COO deploy plan, §15 report.
 *
 * The evaluator is a pure function over a MainnetGateEvidence record:
 * each requirement carries an evidence reference (an issue comment id,
 * a doc path, a review record — any non-empty string) or null. The
 * gate is BLOCKED unless every requirement is affirmatively present.
 * A missing, blank, or whitespace-only reference counts as missing.
 * Nothing defaults to satisfied.
 *
 * Two honesty limits, stated not hidden:
 * - The evaluator checks evidence PRESENCE, not authenticity. A GREEN
 *   result in production requires a human at the gate to verify the
 *   references are real operator/lane artifacts. This module is the
 *   checklist, not the approval.
 * - No production caller wires this evaluator yet, because no mainnet
 *   activation path exists to block. The evaluator becomes binding
 *   when such a path is proposed; until then its RED default is the
 *   protection, and the §15 states that plainly.
 * Pure derivation — zero reads, zero writes, zero activation.
 */

export interface MainnetGateRequirement {
  id: string;
  label: string;
  /** What counts as evidence for this requirement. */
  evidence: string;
}

export const MAINNET_GATE_REQUIREMENTS: MainnetGateRequirement[] = [
  {
    id: "pricesApproved",
    label: "Owner-approved prices per family",
    evidence: "Owner approval record naming the price per family.",
  },
  {
    id: "refundPolicy",
    label: "Refund/proration policy",
    evidence: "Owner-decided refund windows and proration per model, recorded.",
  },
  {
    id: "subscriptionCreditsRules",
    label: "Subscription + credits rules",
    evidence: "Owner-decided subscription and credit earn/vest/redeem rules, recorded.",
  },
  {
    id: "cisoReview",
    label: "CISO review",
    evidence: "CISO lane review record for the mainnet enablement.",
  },
  {
    id: "cpoReview",
    label: "CPO entitlement review",
    evidence: "CPO lane entitlement review record for the mainnet enablement.",
  },
  {
    id: "ctoReview",
    label: "CTO implementation review",
    evidence: "CTO lane implementation review record for the mainnet enablement.",
  },
  {
    id: "cooDeployPlan",
    label: "COO deploy plan",
    evidence: "COO deploy plan for the mainnet enablement.",
  },
  {
    id: "s15Report",
    label: "§15 report",
    evidence: "Phase 7 §15 completion report on the Phase 7 issue.",
  },
];

export type MainnetGateEvidence = {
  pricesApproved: string | null;
  refundPolicy: string | null;
  subscriptionCreditsRules: string | null;
  cisoReview: string | null;
  cpoReview: string | null;
  ctoReview: string | null;
  cooDeployPlan: string | null;
  s15Report: string | null;
};

export interface MainnetGateResult {
  /** True while mainnet must NOT proceed. */
  blocked: boolean;
  missing: string[];
  satisfied: string[];
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Evaluate the mainnet gate. Blocked unless every requirement carries
 * a non-empty evidence reference. An absent key counts as missing.
 */
export function evaluateMainnetGate(
  evidence: Partial<MainnetGateEvidence> | null | undefined,
): MainnetGateResult {
  const missing: string[] = [];
  const satisfied: string[] = [];
  for (const req of MAINNET_GATE_REQUIREMENTS) {
    const value = evidence?.[req.id as keyof MainnetGateEvidence];
    if (isPresent(value)) {
      satisfied.push(req.id);
    } else {
      missing.push(req.id);
    }
  }
  return { blocked: missing.length > 0, missing, satisfied };
}
