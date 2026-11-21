import { describe, expect, it } from "vitest";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";
import { researchReportToStoreInput } from "../src/workflows/researchCanonicalLeg";
import { mergeRunSummaries, runSummaryFromJobRunRecord, runSummaryFromReport } from "../src/services/runSummaries";
import { buildRunDetail } from "../src/services/runDetails";
import type { ResearchReport } from "../src/services/researchPipeline";

describe("581 / 5175 research stage linkage & unified run id", () => {
  const sampleReport: ResearchReport = {
    runId: "778ad3bf-7044-4ef9-9be9-38744ac8aa86",
    generationId: "gen-581",
    createdAt: "2026-11-19T14:52:08.235Z",
    trigger: "manual",
    userLogin: "owner",
    regime: { regime: "bull", notes: [], asOf: 0 },
    ideas: [],
    watchlist: [],
    rejected: [],
    unverified: 0,
    stats: {
      universeSize: 10,
      quotesRetrieved: 10,
      candidatesEvaluated: 5,
      chainsFetched: 5,
      chainsCalibrated: 0,
      qualified: 0,
      watchlist: 1,
      rejected: 4,
      unverified: 0,
      oodaIterations: 2,
      durationMs: 7300,
    },
    costs: { feePerContract: 0.65, slippagePerContract: 0.05, contracts: 1 },
    oodaTrace: [],
    stageTrace: [],
    limitations: [],
    summary: "1 watchlist candidate",
  };

  it("wires real steps into all 6 stages of buildResearchJobDefinition", () => {
    const def = buildResearchJobDefinition("run-581", {
      userLogin: "owner",
      trigger: "manual",
    });
    const steps = def.root.children.map((c: any) => ({ kind: c.kind, step: c.steps?.[0]?.step }));
    expect(steps).toEqual([
      { kind: "feed", step: "research.feed" },
      { kind: "enrich", step: "research.enrich" },
      { kind: "analyze", step: "analyze.ooda" },
      { kind: "generate", step: "research.generate" },
      { kind: "deliver", step: "research.deliver" },
      { kind: "evaluate", step: "evaluate.apply" },
    ]);
  });

  it("stamps canonical run linkage without fabricating J-stack stage outcomes", () => {
    const boundReport = { ...sampleReport, brokerId: "alpaca", mode: "paper", accountType: "options", accountId: "••••3456" };
    const storedInput = researchReportToStoreInput(
      boundReport,
      {
        pdfKey: "report:pdf:research:7c0c36a1",
        pdfStatus: "generated",
        xlsxKey: "report:xlsx:research:d64f7dd0",
        xlsxStatus: "generated",
        csvKey: "report:csv:research:d64f7dd0",
        csvStatus: "generated",
      },
      "owner",
    );
    const body = storedInput.body as Record<string, unknown>;
    expect(body.jobRunId).toBe("research:778ad3bf-7044-4ef9-9be9-38744ac8aa86");
    expect(body.engineVersion).toBe("rules-1.0.0");
    expect(body.captureIds).toEqual(["778ad3bf-7044-4ef9-9be9-38744ac8aa86"]);
    expect(body.brokerId).toBe("alpaca");
    expect(body.mode).toBe("paper");
    expect(body.accountType).toBe("options");
    expect(body.accountId).toBe("••••3456");
    expect(body.stages).toBeUndefined();

    const canonicalSummary = runSummaryFromReport({
      id: "rep-581",
      runId: sampleReport.runId,
      title: storedInput.title,
      source: "options_research",
      summary: sampleReport.summary,
      body: JSON.stringify(body),
      bodyR2Key: null,
      createdAt: sampleReport.createdAt,
      generationId: sampleReport.generationId,
      fanoutOutcome: null,
      userLogin: "owner",
    });
    const d1Summary = runSummaryFromJobRunRecord({
      jobId: "research:778ad3bf-7044-4ef9-9be9-38744ac8aa86",
      operation: "research",
      trigger: "manual",
      outcome: "success",
      started: "2026-11-19T14:52:08.235Z",
      ended: "2026-11-19T14:52:15.511Z",
      durationMs: 7276,
    } as any);
    const merged = mergeRunSummaries([[canonicalSummary], [d1Summary]], 50);
    expect(merged).toHaveLength(1);
    expect(merged[0].reportId).toBe("rep-581");
    expect(merged[0].workflowId).toBe("research:778ad3bf-7044-4ef9-9be9-38744ac8aa86");

    const detail = buildRunDetail({ ...merged[0], body });
    expect(detail.stages.filter((s) => s.stage !== "recording").every((s) => s.status === "unknown")).toBe(true);
    expect(detail.lineage.engineVersion).toBe("rules-1.0.0");
    expect(detail.lineage.captureIds).toEqual(["778ad3bf-7044-4ef9-9be9-38744ac8aa86"]);
    expect(detail.provenance).toMatchObject({
      brokerId: "alpaca",
      tradingMode: "paper",
      accountType: "options",
      accountId: "••••3456",
    });
  });
});
