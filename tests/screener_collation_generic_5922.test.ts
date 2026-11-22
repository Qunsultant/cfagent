// @vitest-environment node
/**
 * Issue #5922 (#4437 slice 6e) — collation on the generic chain:
 * shardOutcomeFromStageOutputs + formatKey read the generic
 * output shape. The bespoke shape is pinned unchanged; the
 * generic shape (generate.apply output carried through the
 * deliver node) maps success to success.
 *
 * Generic deepest output (deliver.apply output = generate.apply
 * output + delivered): a delivery payload (totalScanned, run
 * timestamp, canonical report id), the canonical leg map, the
 * generated artifact id — and NO screenResult, NO expectedCount,
 * NO matchedCount (the analyzed artifact carries no matched
 * notion — #5825's document rule), NO servedReport, NO
 * pdfKey/xlsxKey/csvKey (the generic formats are inline bodies
 * in the generated artifact, not asset keys).
 */
import { describe, expect, it } from "vitest";
import { shardOutcomeFromStageOutputs } from "../src/workflows/screenerCollation";

const COMPLETED_LEDGER = [
  { stage: "feed", status: "completed" },
  { stage: "gather", status: "completed" },
  { stage: "analysis", status: "completed" },
  { stage: "analysis", status: "completed" },
  { stage: "deliver", status: "completed" },
] as const;

function genericDeepest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generateJobId: "yahoo-nasdaq100-quotes-enrich-analyze-generate",
    analyzeJobId: "yahoo-nasdaq100-quotes-enrich-analyze",
    sourceId: "yahoo",
    dataset: "quotes",
    generateRunId: "generate-run-1",
    artifactId: "generated-artifact-1",
    status: "completed",
    requested: 3,
    received: 3,
    failed: 0,
    inputArtifactId: "analyzed-artifact-1",
    inputRunId: "analyze-run-1",
    reportsGenerated: ["screener-report"],
    canonical: { "screener-report": "stored" },
    reportId: "canonical-1",
    payload: {
      trigger: "manual",
      success: true,
      timestamp: "2026-11-12T00:00:00.000Z",
      totalScanned: 2,
      universe: "Nasdaq-100",
      summary: "Analysis summary.",
      thesis: "Analysis thesis.",
      opportunities: [{ symbol: "AAPL" }],
      canonicalReportId: "canonical-1",
    },
    delivered: true,
    ...over,
  };
}

describe("generic-chain collation (#5922)", () => {
  it("maps a generic success to completed, with counts from the payload", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      genericDeepest(),
      [...COMPLETED_LEDGER] as any,
      2,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.totalScanned).toBe(2);
    expect(outcome.expectedCount).toBe(2);
    expect(outcome.timestamp).toBe("2026-11-12T00:00:00.000Z");
    expect(outcome.reportId).toBe("canonical-1");
    expect(outcome.stored).toBe(true);
    expect(outcome.delivered).toBe(true);
    expect(outcome.error).toBeUndefined();
    // No matched notion on the generic chain (#5825): the
    // field is omitted, never invented.
    expect(outcome.matchedCount).toBeUndefined();
    // No per-format asset keys: the generic formats are inline
    // bodies in the generated artifact, not blob keys — a
    // canonical id is a mas_reports row id, not a PDF key, so
    // formatKey must not fabricate one.
    expect(outcome.pdfKey).toBeUndefined();
    expect(outcome.xlsxKey).toBeUndefined();
    expect(outcome.csvKey).toBeUndefined();
  });

  it("a failed canonical leg records a store error, never a failed run", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      genericDeepest({ canonical: { "screener-report": "failed" }, reportId: undefined, payload: { ...(genericDeepest().payload as Record<string, unknown>), canonicalReportId: undefined } }),
      [...COMPLETED_LEDGER] as any,
      2,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.stored).toBe(false);
    expect(outcome.storeError).toMatch(/Canonical report leg failed/);
    expect(outcome.delivered).toBe(true);
  });

  it("an unwired canonical leg leaves the shard completed but unstored, with no error", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      genericDeepest({ canonical: { "screener-report": "not_wired" }, reportId: undefined, payload: { ...(genericDeepest().payload as Record<string, unknown>), canonicalReportId: undefined } }),
      [...COMPLETED_LEDGER] as any,
      2,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.stored).toBe(false);
    expect(outcome.storeError).toBeUndefined();
  });

  it("a deduped canonical leg counts as stored", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      genericDeepest({ canonical: { "screener-report": "deduped" } }),
      [...COMPLETED_LEDGER] as any,
      2,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.stored).toBe(true);
  });

  it("a non-numeric payload count fails the shard loudly, never with coerced zeros", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      genericDeepest({ payload: { ...(genericDeepest().payload as Record<string, unknown>), totalScanned: "two" } }),
      [...COMPLETED_LEDGER] as any,
      2,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/malformed/);
  });

  it("a generate output with no screener payload fails loudly, never as never-reached-analysis", () => {
    const { payload, ...noPayload } = genericDeepest();
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      noPayload,
      [...COMPLETED_LEDGER] as any,
      2,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/no screener delivery payload/);
  });

  it("expectedCount falls back to the composer's count only when the artifact lacks it", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      genericDeepest(),
      [...COMPLETED_LEDGER] as any,
      5,
    );
    expect(outcome.expectedCount).toBe(5);
  });

  it("a bespoke deepest output keeps its own expectedCount over the passed count", () => {
    const outcome = shardOutcomeFromStageOutputs(
      "s0",
      {
        timestamp: "2026-11-12T00:00:00.000Z",
        screenResult: { totalScanned: 4, matchedCount: 1 },
        expectedCount: 4,
        servedReport: { formats: [{ format: "pdf", key: "report:pdf:stock:abc" }] },
        stored: true,
        delivered: true,
      },
      [...COMPLETED_LEDGER] as any,
      99,
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.totalScanned).toBe(4);
    expect(outcome.matchedCount).toBe(1);
    expect(outcome.expectedCount).toBe(4);
    expect(outcome.pdfKey).toBe("report:pdf:stock:abc");
  });
});
