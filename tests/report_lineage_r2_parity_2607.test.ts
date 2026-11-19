import { describe, expect, it } from "vitest";
import { buildRunDetail } from "../src/services/runDetails";
import { CANONICAL_ARTIFACT_BACKFILL_FIELDS, planArtifactBackfill } from "../src/services/scheduledReports";
import type { RunSummary } from "../src/services/runSummaries";

describe("2607 / 2611 / 2540 report lineage & R2-pointer parity", () => {
  const baseSummary: RunSummary & { bodyR2Key?: string | null } = {
    kind: "options_scanner",
    id: "rep-2607",
    runId: "run-2607",
    title: "Options Screen",
    summary: "1 match",
    trigger: "scheduled",
    createdAt: "2026-11-19T12:00:00.000Z",
    status: "completed",
    resultCount: 1,
    retry: null,
    pdfStatus: "generated",
    reportUrl: "/api/reports/rep-2607/pdf",
    pdfKey: "reports/rep-2607.pdf",
    pdfError: null,
    xlsxStatus: null,
    xlsxUrl: null,
    xlsxKey: null,
    xlsxError: null,
    csvStatus: null,
    csvUrl: null,
    csvKey: null,
    csvError: null,
    reportId: "rep-2607",
    scanRunId: "scan-2607",
    source: "options_scanner",
    bodyR2Key: "reports/rep-2607/body.json",
  };

  it("exposes r2-pointer storageMode, origin, bidirectional artifactLinks, and names incomplete fields", () => {
    const detail = buildRunDetail({
      ...baseSummary,
      body: {
        inputHash: "sha256:abc",
        engineVersion: "2.0.0",
        captureIds: ["cap-1"],
        submittedVia: { channel: "cron" },
        interface: "scheduled",
        userLogin: "owner",
        provider: "etrade",
      },
    });
    expect(detail.lineage.storageMode).toBe("r2-pointer");
    expect(detail.lineage.bodyR2Key).toBe("reports/rep-2607/body.json");
    expect(detail.lineage.origin).toEqual({
      trigger: "scheduled",
      channel: "cron",
      interface: "scheduled",
      actor: "owner",
    });
    expect(detail.lineage.artifactLinks).toEqual([
      {
        format: "PDF",
        key: "reports/rep-2607.pdf",
        url: "/api/reports/rep-2607/pdf",
        status: "generated",
        reportId: "rep-2607",
        runId: "run-2607",
        captureIds: ["scan-2607", "cap-1"],
      },
    ]);
    expect(detail.lineage.incompleteFields).toContain("capture.connectorVersion");
    expect(detail.lineage.incompleteFields).not.toContain("inputHash");
    expect(detail.lineage.incompleteFields).not.toContain("captureIds");
  });

  it("names bodyR2Key:unresolved when an R2-pointer row has no resolved body", () => {
    const detail = buildRunDetail({ ...baseSummary, body: undefined });
    expect(detail.lineage.storageMode).toBe("r2-pointer");
    expect(detail.lineage.incompleteFields).toContain("bodyR2Key:unresolved");
    expect(detail.lineage.incompleteFields).toContain("inputHash");
    expect(detail.lineage.incompleteFields).toContain("engineVersion");
  });

  it("includes lineage fields in CANONICAL_ARTIFACT_BACKFILL_FIELDS with first-write-win parity", () => {
    expect(CANONICAL_ARTIFACT_BACKFILL_FIELDS).toContain("captureIds");
    expect(CANONICAL_ARTIFACT_BACKFILL_FIELDS).toContain("inputHash");
    expect(CANONICAL_ARTIFACT_BACKFILL_FIELDS).toContain("lineage");
    const outcome = planArtifactBackfill(
      JSON.stringify({ pdfKey: "existing.pdf" }),
      { pdfKey: "new.pdf", captureIds: ["cap-1"], inputHash: "sha256:xyz" },
      { owner: "owner", storedOwner: "owner" },
    );
    expect(outcome.status).toBe("merged");
    if (outcome.status === "merged") {
      const parsed = JSON.parse(outcome.bodyJson);
      expect(parsed.pdfKey).toBe("existing.pdf");
      expect(parsed.captureIds).toEqual(["cap-1"]);
      expect(parsed.inputHash).toBe("sha256:xyz");
    }
  });
});
