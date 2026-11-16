import { describe, it, expect } from "vitest";
import {
  buildProvenanceTuple,
  hasUniformProvenanceTuple,
  readProvenanceTuple,
  withProvenanceTuple,
} from "../src/observability/provenanceTuple";
import { auditRowFromDraft } from "../src/data/auditReportProjection";

describe("Uniform provenance tuple (#4615)", () => {
  it("constructs and reads all 5 tuple legs without a join for run, delivery, denial, and fallback", () => {
    const kinds = ["run", "delivery", "denial", "fallback"] as const;
    for (const kind of kinds) {
      const payload = withProvenanceTuple(
        { action: `sample_${kind}` },
        kind,
        {
          tenantId: "tenant-acme",
          userId: "alice",
          providerId: "fmp",
          brokerId: "etrade",
          channel: "slack",
        },
      );
      expect(payload.provenanceRecordKind).toBe(kind);
      expect(hasUniformProvenanceTuple(payload)).toBe(true);
      expect(readProvenanceTuple(payload)).toEqual({
        tenantId: "tenant-acme",
        userId: "alice",
        providerId: "fmp",
        brokerId: "etrade",
        channel: "slack",
      });
    }
  });

  it("rejects incomplete tuples when any leg is missing or blank", () => {
    expect(readProvenanceTuple({ tenantId: "t1", userId: "u1" })).toBeNull();
    expect(
      readProvenanceTuple({
        provenanceTuple: {
          tenantId: "t1",
          userId: "u1",
          providerId: "fmp",
          brokerId: "",
          channel: "api",
        },
      }),
    ).toBeNull();
    expect(
      buildProvenanceTuple({ tenantId: "t1", userId: "u1" }),
    ).toEqual({
      tenantId: "t1",
      userId: "u1",
      providerId: "unspecified",
      brokerId: "unspecified",
      channel: "unspecified",
    });
  });

  it("ensures auditRowFromDraft attaches the 5-leg provenance tuple on delivery, denial, fallback, and run rows", () => {
    const cases = [
      { eventKind: "delivery.sent", expectedKind: "delivery" },
      { eventKind: "access.denied", expectedKind: "denial" },
      { eventKind: "storage.fallback", expectedKind: "fallback" },
      { eventKind: "screener.run", expectedKind: "run" },
    ] as const;

    for (const c of cases) {
      const row = auditRowFromDraft(
        {
          tenantId: "tenant-a",
          workspaceId: "ws-1",
          chainId: "chain-1",
          eventKind: c.eventKind,
          subjectType: "slack",
          subjectId: "subj-1",
          actor: "bob",
          detailJson: JSON.stringify({ providerId: "polygon", brokerId: "none", channel: "slack" }),
          occurredAtMs: 1_700_000_000_000,
          provenanceWriter: "audit-projection",
          provenanceSourceDo: "OrchestratorAgent",
          provenanceSourceVersion: "v1",
        },
        `evt-${c.expectedKind}`,
        1_700_000_000_001,
      );
      const detail = JSON.parse(row.detailJson!);
      expect(detail.provenanceRecordKind).toBe(c.expectedKind);
      expect(readProvenanceTuple(detail)).toEqual({
        tenantId: "tenant-a",
        userId: "bob",
        providerId: "polygon",
        brokerId: "none",
        channel: "slack",
      });
    }
  });
});
