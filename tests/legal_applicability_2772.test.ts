import { describe, it, expect } from "vitest";
import {
  LEGAL_APPLICABILITY_REGISTER,
  createContractObligation,
  createLegalMatter,
  createVerifiedResearch,
  legalApplicabilityRegister,
  legalRequirementById,
  placePreservationHold,
  recordLegalApproval,
  releasePreservationHold,
  unresolvedLegalRequirements,
} from "../src/workflows/legalApplicability";

describe("FINRA/SEC applicability register #2772", () => {
  it("the register makes no compliance claim: no compliance field exists on any entry", () => {
    for (const entry of legalApplicabilityRegister()) {
      expect(entry).not.toHaveProperty("compliant");
      expect(entry).not.toHaveProperty("complianceClaim");
    }
  });

  it("applicability is a closed set and unresolved is the honest majority", () => {
    for (const entry of LEGAL_APPLICABILITY_REGISTER) {
      expect(["applies", "does-not-apply", "unresolved"]).toContain(entry.applicability);
    }
    const unresolved = unresolvedLegalRequirements();
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((e) => e.counselReview === "not-reviewed")).toBe(true);
  });

  it("every unresolved entry names evidence and a counsel-review status", () => {
    for (const entry of unresolvedLegalRequirements()) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.notes).toBeTruthy();
    }
  });

  it("unknown requirement ids resolve to undefined, never an invented requirement", () => {
    expect(legalRequirementById("no-such-requirement")).toBeUndefined();
  });

  it("matters, obligations, and verified research require non-blank identity", () => {
    expect(() => createLegalMatter("", "Title", "2026-11-02T00:00:00.000Z")).toThrow(/non-blank/);
    expect(() => createContractObligation("o1", "", "Title")).toThrow(/non-blank/);
    expect(() => createVerifiedResearch("r1", "", "2026-11-02T00:00:00.000Z", "alice", "s")).toThrow(
      /non-blank/,
    );
    const matter = createLegalMatter("m1", "Matter", "2026-11-02T00:00:00.000Z");
    expect(matter.status).toBe("open");
    const obligation = createContractObligation("o1", "m1", "Deliverable", "2026-12-01T00:00:00.000Z");
    expect(obligation.matterId).toBe("m1");
    expect(obligation.status).toBe("open");
  });

  it("approvals never auto-approve: blank approver or bad decision throws loudly", () => {
    expect(() => recordLegalApproval("a1", "m1", "", "approved", "2026-11-02T00:00:00.000Z")).toThrow(
      /non-blank/,
    );
    expect(() =>
      recordLegalApproval("a1", "m1", "alice", "maybe" as never, "2026-11-02T00:00:00.000Z"),
    ).toThrow(/approved or rejected/);
    const approval = recordLegalApproval("a1", "m1", "alice", "approved", "2026-11-02T00:00:00.000Z");
    expect(approval.approver).toBe("alice");
    expect(approval.decision).toBe("approved");
  });

  it("preservation holds release only by a named human, and the record is kept", () => {
    const hold = placePreservationHold("h1", "mas_reports 2026-10", "Matter m1", "2026-11-02T00:00:00.000Z");
    expect(() => releasePreservationHold(hold, "", "2026-11-03T00:00:00.000Z")).toThrow(/non-blank/);
    const released = releasePreservationHold(hold, "alice", "2026-11-03T00:00:00.000Z");
    expect(released.releasedBy).toBe("alice");
    expect(released.releasedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(released.scope).toBe("mas_reports 2026-10");
  });
});
