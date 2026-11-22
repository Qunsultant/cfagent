/**
 * Issue #1641 (parent #1638, doc §5) — one report pipeline serves
 * stock, options, AND research runs.
 *
 * Gap pinned here: the unified pipeline's input type was only
 * "screener" | "options", and generateReportStage mapped
 * anything-not-screener to the "options" asset — so a research input
 * would silently generate an OPTIONS pdf. Research publish also
 * bypassed the stage entirely (direct generatePdfAsset call: no
 * retry policy, no pdfStatus/pdfError contract).
 *
 * #1209 scope finding (recorded on #1641 before building): #1209 is
 * a DELIVERY tracker (A2A Slack drops, badge seams), not the report
 * generation tracker — this issue is the tracker, #1209 related only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  assetCalls: [] as Array<{ userLogin: string; type: string }>,
  assetQueue: [] as Array<{ key: string; fileName: string } | null>,
}));

vi.mock("../src/agents/report-asset-agent", () => ({
  generatePdfAsset: vi.fn(async (_env: any, userLogin: string, type: string, _data: unknown) => {
    hoisted.assetCalls.push({ userLogin, type });
    return hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift()! : null;
  }),
  generatePdfAssetOutcome: vi.fn(async (_env: any, userLogin: string, type: string, _data: unknown) => {
    hoisted.assetCalls.push({ userLogin, type });
    const asset = hoisted.assetQueue.length > 0 ? hoisted.assetQueue.shift()! : null;
    return asset
      ? { status: "generated", asset }
      : { status: "failed", error: "REPORT_ASSET_GENERATION_FAILED: mock returned no asset." };
  }),
}));

import { generateReportStage, runReportPipeline } from "../src/services/unifiedReportPipeline";

const INPUT = {
  type: "research",
  trigger: "manual",
  result: { title: "research run" },
  userLogin: "alice",
  title: "Options research",
  summary: "summary",
  timestamp: "2026-10-26T12:00:00.000Z",
} as const;

beforeEach(() => {
  hoisted.assetCalls.length = 0;
  hoisted.assetQueue.length = 0;
  hoisted.assetQueue.push({ key: "report:pdf:research:test1234", fileName: "research.pdf" });
});

describe("unified pipeline serves research runs (#1641 §5)", () => {
  it("generateReportStage routes a research input to the research asset, not options", async () => {
    const out = await generateReportStage({} as any, INPUT as any);
    expect(hoisted.assetCalls).toEqual([{ userLogin: "alice", type: "research" }]);
    expect(out.pdfStatus).toBe("generated");
    expect(out.pdfKey).toBe("report:pdf:research:test1234");
    expect(out.generationId).toBe("research:manual:2026-10-26T12:00:00.000Z");
  });

  it("runReportPipeline (fused entry) serves research identically", async () => {
    const out = await runReportPipeline(
      {} as any,
      { put: async () => {}, get: async () => undefined } as any,
      INPUT as any
    );
    expect(hoisted.assetCalls).toEqual([{ userLogin: "alice", type: "research" }]);
    expect(out.pdfStatus).toBe("generated");
    expect(out.pdfKey).toBe("report:pdf:research:test1234");
  });

  it("research generation failure is coded and never thrown", async () => {
    hoisted.assetQueue.length = 0;
    hoisted.assetQueue.push(null);
    const out = await generateReportStage({} as any, INPUT as any);
    expect(out.pdfStatus).toBe("failed");
    expect(out.pdfKey).toBe("");
    expect(out.pdfError ?? "").toMatch(/^\[FAILURE_REPORT_PDF_GENERATION\]/);
  });
});
