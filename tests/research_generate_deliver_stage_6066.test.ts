import { describe, expect, it, vi } from "vitest";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { registerResearchSteps } from "../src/services/researchPipelineJobs";
import type { ResearchEnrichStageOutput } from "../src/services/researchEnrichHandoff";

function ctx(over: Record<string, unknown>) {
  return {
    jobId: "research:run-gen-1",
    runId: "run-gen-1",
    nodePath: "",
    kind: "analysis",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: { runId: "run-gen-1", userLogin: "owner@example.com", trigger: "manual" },
    input: null,
    now: "2026-11-22T00:00:00.000Z",
    trigger: "manual",
    runKind: "original",
    ...over,
  } as never;
}

const report = {
  runId: "run-gen-1",
  ideas: [],
  watchlist: [],
  rejected: [],
  summary: "ok",
};

describe("issues #6065/#6066 — generate and deliver as real stages", () => {
  it("analyze defers publication when the upstream stages ran", async () => {
    const runOodaAnalysis = vi.fn(async () => report);
    const registry = registerResearchSteps(createBuiltinStepRegistry(), { runOodaAnalysis });
    const enrich: ResearchEnrichStageOutput = {
      runId: "run-gen-1",
      asOf: "2026-11-22T00:00:00.000Z",
      bySymbol: { AAA: { technicals: null, catalysts: null } },
    };
    await registry.resolve("analyze.ooda")(ctx({ input: enrich }));
    expect(runOodaAnalysis.mock.calls[0][0]).toMatchObject({ deferPublication: true });
  });

  it("generate runs the document leg and hands report + publication to deliver", async () => {
    const runGenerateStage = vi.fn(async () => ({
      reportId: "rep-1",
      created: true,
      artifacts: { pdfKey: "pdf-1", pdfStatus: "generated" },
    }));
    const runDeliverStage = vi.fn(async () => ({ emailed: true }));
    const registry = registerResearchSteps(createBuiltinStepRegistry(), {
      runOodaAnalysis: vi.fn(),
      runGenerateStage,
      runDeliverStage,
    });
    const generated = await registry.resolve("research.generate")(ctx({ input: report }));
    expect(runGenerateStage).toHaveBeenCalledTimes(1);
    expect(runGenerateStage.mock.calls[0][0]).toMatchObject({ report });
    expect((generated.output as { report: unknown }).report).toBe(report);

    await registry.resolve("research.deliver")(ctx({ input: generated.output }));
    expect(runDeliverStage).toHaveBeenCalledTimes(1);
    expect(runDeliverStage.mock.calls[0][0]).toMatchObject({
      report,
      publication: (generated.output as { publication: unknown }).publication,
    });
  });

  it("records not_configured when a host has no generate/deliver runtime", async () => {
    const registry = registerResearchSteps(createBuiltinStepRegistry(), { runOodaAnalysis: vi.fn() });
    const generated = await registry.resolve("research.generate")(ctx({ input: report }));
    expect(generated.output).toMatchObject({ status: "not_configured" });
  });
});
