/**
 * Issue #2772 (under #2764) — FINRA/SEC applicability register
 * FIRST, plus legal platform registers.
 *
 * Standing boundaries (RSI-CLO role, not licensed counsel):
 * this module makes NO compliance claim, gives NO legal
 * advice, and authorizes NOTHING. It does not sign
 * agreements, submit filings, settle matters, or
 * communicate external legal positions — those require a
 * human with legal authority, recorded through the
 * approval register below. Nothing here is a legal
 * conclusion about any specific rule: requirement entries
 * are AREA-level, their applicability is "unresolved"
 * until counsel reviews them, and the register type has
 * NO compliance field at all — compliance cannot be
 * expressed through it, only counsel review status can.
 *
 * Applicability statuses:
 *   - "applies": counsel has determined the area applies
 *     (counselReview must be "reviewed"; the entry names
 *     the evidence counsel relied on).
 *   - "does-not-apply": a factual boundary of the agent's
 *     own behavior (e.g. the agent sends no external legal
 *     positions), not a legal conclusion about a rule.
 *   - "unresolved": the default. Counsel has not reviewed
 *     it. Unresolved entries are the honest majority of
 *     this register and must never be read as "compliant".
 *
 * Platform registers are pure record shapes + validation:
 * matters, contract/obligations, verified research,
 * approvals, preservation holds. They are NOT persisted
 * by this slice — landing them in a store is follow-up
 * work, stated here so no persistence is claimed. The
 * approval register never auto-approves: recordApproval
 * throws without an explicit human approver and decision.
 */

export type ApplicabilityStatus = "applies" | "does-not-apply" | "unresolved";
export type CounselReviewStatus = "not-reviewed" | "pending" | "reviewed";

export interface LegalRequirement {
  id: string;
  title: string;
  /** Requirement area (FINRA, SEC, or other) — area-level, never a specific rule citation claimed as applying. */
  area: "FINRA" | "SEC" | "other";
  applicability: ApplicabilityStatus;
  /** System facts counsel may rely on — never a legal conclusion by itself. */
  evidence: string[];
  counselReview: CounselReviewStatus;
  notes: string;
}

export const LEGAL_APPLICABILITY_REGISTER: readonly LegalRequirement[] = [
  {
    id: "trade-execution-oversight",
    title: "Oversight of trade/order execution surfaces",
    area: "FINRA",
    applicability: "unresolved",
    evidence: [
      "Order execution paths exist (E*TRADE/Alpaca) but are never invoked without explicit human confirmation (agent boundary).",
      "No order has been placed by this programme's slices.",
    ],
    counselReview: "not-reviewed",
    notes: "Counsel must determine which oversight duties, if any, attach to these surfaces. Unresolved is not compliant.",
  },
  {
    id: "record-retention",
    title: "Retention of screening runs, reports, and audit records",
    area: "SEC",
    applicability: "unresolved",
    evidence: [
      "Canonical reports persist in mas_reports with R2 bodies; run results persist in the agent run store; delivery and replay actions audit.",
      "No retention schedule has been set by counsel.",
    ],
    counselReview: "not-reviewed",
    notes: "Counsel must determine the applicable retention duties and schedule. The existence of records is not a retention claim.",
  },
  {
    id: "external-legal-positions",
    title: "External legal positions communicated by the agent",
    area: "other",
    applicability: "does-not-apply",
    evidence: [
      "The agent sends no external legal positions: the RSI-CLO boundary forbids signing, filings, settlements, and external positions without required human authorization.",
      "No such communication exists in this programme's slices.",
    ],
    counselReview: "not-reviewed",
    notes: "Factual boundary of the agent's own behavior, not a legal conclusion about any rule. If the boundary ever changes, this entry must be re-reviewed.",
  },
  {
    id: "paid-run-charging",
    title: "Charging for paid runs (no double charge)",
    area: "other",
    applicability: "unresolved",
    evidence: [
      "Paid runs are charged once by the existing monetization path; replay is explicitly never charged (charged: false).",
      "No counsel review of charging disclosures has occurred.",
    ],
    counselReview: "not-reviewed",
    notes: "Counsel must determine whether charging disclosures or duties apply. The no-double-charge pin is an engineering fact, not a legal conclusion.",
  },
];

export function legalApplicabilityRegister(): readonly LegalRequirement[] {
  return LEGAL_APPLICABILITY_REGISTER;
}

/** Unknown ids resolve to undefined, never an invented requirement. */
export function legalRequirementById(id: string): LegalRequirement | undefined {
  return LEGAL_APPLICABILITY_REGISTER.find((entry) => entry.id === id);
}

/** Entries still awaiting counsel — the register's honest remainder. */
export function unresolvedLegalRequirements(): LegalRequirement[] {
  return LEGAL_APPLICABILITY_REGISTER.filter((entry) => entry.applicability === "unresolved");
}

/* ------------------------------------------------------------------ */
/* Legal platform registers (record shapes + validation, no store)    */
/* ------------------------------------------------------------------ */

export interface LegalMatter {
  id: string;
  title: string;
  status: "open" | "closed";
  createdAt: string;
}

export interface ContractObligation {
  id: string;
  matterId: string;
  title: string;
  status: "open" | "satisfied" | "breached";
  dueAt?: string;
}

export interface VerifiedResearch {
  id: string;
  source: string;
  verifiedAt: string;
  verifier: string;
  summary: string;
}

export interface LegalApproval {
  id: string;
  matterId: string;
  /** Human approver login — never an agent, never empty. */
  approver: string;
  decision: "approved" | "rejected";
  decidedAt: string;
}

export interface PreservationHold {
  id: string;
  scope: string;
  reason: string;
  createdAt: string;
  releasedAt?: string;
  releasedBy?: string;
}

function requireNonBlank(value: string, field: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`Legal register requires a non-blank ${field}.`);
  }
  return value;
}

export function createLegalMatter(id: string, title: string, createdAt: string): LegalMatter {
  return { id: requireNonBlank(id, "matter id"), title: requireNonBlank(title, "matter title"), status: "open", createdAt };
}

export function createContractObligation(
  id: string,
  matterId: string,
  title: string,
  dueAt?: string,
): ContractObligation {
  return {
    id: requireNonBlank(id, "obligation id"),
    matterId: requireNonBlank(matterId, "matter id"),
    title: requireNonBlank(title, "obligation title"),
    status: "open",
    ...(dueAt ? { dueAt } : {}),
  };
}

export function createVerifiedResearch(
  id: string,
  source: string,
  verifiedAt: string,
  verifier: string,
  summary: string,
): VerifiedResearch {
  return {
    id: requireNonBlank(id, "research id"),
    source: requireNonBlank(source, "research source"),
    verifiedAt,
    verifier: requireNonBlank(verifier, "verifier"),
    summary: requireNonBlank(summary, "research summary"),
  };
}

/**
 * Record a human approval. There is deliberately NO
 * auto-approval path: a blank approver or a decision other
 * than approved/rejected throws loudly.
 */
export function recordLegalApproval(
  id: string,
  matterId: string,
  approver: string,
  decision: "approved" | "rejected",
  decidedAt: string,
): LegalApproval {
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("Legal approval decision must be approved or rejected.");
  }
  return {
    id: requireNonBlank(id, "approval id"),
    matterId: requireNonBlank(matterId, "matter id"),
    approver: requireNonBlank(approver, "human approver"),
    decision,
    decidedAt,
  };
}

export function placePreservationHold(
  id: string,
  scope: string,
  reason: string,
  createdAt: string,
): PreservationHold {
  return {
    id: requireNonBlank(id, "hold id"),
    scope: requireNonBlank(scope, "hold scope"),
    reason: requireNonBlank(reason, "hold reason"),
    createdAt,
  };
}

/** Releasing a hold requires a named human releaser; a released hold keeps its record (never erased). */
export function releasePreservationHold(
  hold: PreservationHold,
  releasedBy: string,
  releasedAt: string,
): PreservationHold {
  return { ...hold, releasedBy: requireNonBlank(releasedBy, "human releaser"), releasedAt };
}
