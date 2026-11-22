/**
 * Issue #1278 (#1173 R5) part A: runReportPipeline retries PDF
 * generation under the R1 pipeline policy (retry.report). The
 * ReportAssetAgent helper `generatePdfAsset` never throws — null IS
 * its failure signal — so a null asset must count as a failed attempt.
 * The recorded pdfError carries the FAILURE_REPORT_PDF_GENERATION catalog code (R4).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  assetCalls: 0,
  assetQueue: [] as Array<unknown>,
}));

vi.mock("../src/agents/report-asset-agent", () => ({
  generatePdfAsset: vi.fn(async () => {
    hoisted.assetCalls++;
    return hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift() : null;
  }),
  generatePdfAssetOutcome: vi.fn(async () => {
    hoisted.assetCalls++;
    const asset = hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift() : null;
    return asset
      ? { status: "generated", asset }
      : { status: "failed", error: "REPORT_ASSET_GENERATION_FAILED: mock returned no asset." };
  }),
}));

import { runReportPipeline } from "../src/services/unifiedReportPipeline";

const INPUT = {
  type: "screener" as const,
  trigger: "manual" as const,
  result: { provider: "yahoo" },
  userLogin: "default_trader",
  title: "Market screen — NASDAQ100",
  summary: "Scanned 25 symbols, 25 matched.",
  timestamp: "2026-10-23T13:05:29.000Z",
};

const FAST = {
  PIPELINE_REPORT_RETRY_BASE_DELAY_MS: "1",
  PIPELINE_REPORT_RETRY_MAX_DELAY_MS: "2",
};

const storage = {
  put: async () => {},
  get: async () => undefined,
};

describe("runReportPipeline retry (#1278 R5-A)", () => {
  beforeEach(() => {
    hoisted.assetCalls = 0;
    hoisted.assetQueue = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("retries a null asset and succeeds within the policy attempts", async () => {
    hoisted.assetQueue = [null, null, { key: "screener:pdf:ok01", fileName: "m.pdf" }];
    const out = await runReportPipeline(
      { ...FAST, PIPELINE_REPORT_RETRY_ATTEMPTS: "3" } as any,
      storage as any,
      INPUT as any
    );
    expect(out.pdfStatus).toBe("generated");
    expect(out.pdfKey).toBe("screener:pdf:ok01");
    expect(hoisted.assetCalls).toBe(3);
  });

  it("gives up after the default report attempts (2) and records a FAILURE_REPORT_PDF_GENERATION-coded error", async () => {
    const out = await runReportPipeline({ ...FAST } as any, storage as any, INPUT as any);
    expect(out.pdfStatus).toBe("failed");
    expect(out.pdfKey).toBe("");
    expect(hoisted.assetCalls).toBe(2);
    expect(out.pdfError).toContain("[FAILURE_REPORT_PDF_GENERATION]");
  });

  it("honors PIPELINE_REPORT_RETRY_ATTEMPTS=1 (single attempt, no retry)", async () => {
    const out = await runReportPipeline(
      { ...FAST, PIPELINE_REPORT_RETRY_ATTEMPTS: "1" } as any,
      storage as any,
      INPUT as any
    );
    expect(out.pdfStatus).toBe("failed");
    expect(hoisted.assetCalls).toBe(1);
  });

  it("a first-attempt success performs exactly one generation call", async () => {
    hoisted.assetQueue = [{ key: "screener:pdf:first01", fileName: "m.pdf" }];
    const out = await runReportPipeline({ ...FAST } as any, storage as any, INPUT as any);
    expect(out.pdfStatus).toBe("generated");
    expect(hoisted.assetCalls).toBe(1);
  });
});
