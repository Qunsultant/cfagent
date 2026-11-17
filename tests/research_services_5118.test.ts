import { describe, expect, it } from "vitest";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import {
  ANALYZE_OODA_STEP,
  EVALUATE_APPLY_STEP,
  RESEARCH_LEDGER_OWNERSHIP,
  RESEARCH_PIPELINE_CATALOG_ENTRY,
  RESEARCH_PIPELINE_STAGES,
  buildResearchJobDefinition,
} from "../src/services/researchPipelineJobs";
import { ANALYZE_APPLY_STEP } from "../src/services/analyzePipelineJobs";

describe("Issue #5118 (Sub-issue 2 of #5109) — Research Services", () => {
  it("registers analyze.ooda alongside analyze.apply and evaluate.apply in the composed step registry", async () => {
    const savedEvals: string[] = [];
    const registry = createPipelineStepRegistry(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runOodaAnalysis: async ({ runId, userLogin, trigger }) => ({
          runId,
          generationId: `options_research:${runId}`,
          trigger,
          userLogin,
          createdAt: "2026-11-17T21:00:00.000Z",
          rulesVersion: "1.0.0",
          summary: "OODA done",
          ideas: [],
          watchlist: [],
          rejected: [],
          stats: {
            universeCount: 5,
            scannedCount: 5,
            candidateCount: 1,
            ideaCount: 0,
            rejectedCount: 1,
            budgetExhausted: false,
            elapsedMs: 42,
          },
          oodaTrace: [],
        }),
        runEvaluateStage: async ({ runId }) => ({
          runId,
          evaluatedAt: "2026-11-17T22:00:00.000Z",
          rulesVersion: "1.0.0",
          ideas: [],
          aggregates: {
            evaluated: 1,
            invalidated: 0,
            avgPnlPerUnit: 12.5,
            dataQualityFailures: 0,
            directionAccuracy: 1,
          },
          note: "test evaluation",
        }),
        evaluationStore: {
          listRunReportJson: () => [],
          listEvaluationJson: () => savedEvals,
          getRunReportJson: () => null,
          saveEvaluation: (_runId, evalJson) => savedEvals.push(evalJson),
        },
      },
    );

    expect(registry.has(ANALYZE_APPLY_STEP)).toBe(true);
    expect(registry.has(ANALYZE_OODA_STEP)).toBe(true);
    expect(registry.has(EVALUATE_APPLY_STEP)).toBe(true);

    const oodaResult = await registry.resolve(ANALYZE_OODA_STEP)({
      jobId: "research:run-5118",
      runId: "run-5118",
      params: { userLogin: "trader@example.com", trigger: "scheduled" },
      inputs: [],
    } as any);
    expect(oodaResult.descriptor).toContain("research:run-5118:analyze");

    const evalResult = await registry.resolve(EVALUATE_APPLY_STEP)({
      jobId: "research:run-5118",
      runId: "run-5118",
      params: { userLogin: "trader@example.com" },
      inputs: [],
    } as any);
    expect(evalResult.descriptor).toContain("research:run-5118:evaluate");
    expect(savedEvals).toHaveLength(1);
  });

  it("defines the research:<runId> job, catalog entry, and single-recorder ledger ownership", () => {
    expect(RESEARCH_PIPELINE_STAGES).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
    expect(RESEARCH_PIPELINE_CATALOG_ENTRY.analyzeStep).toBe("analyze.ooda");
    expect(RESEARCH_PIPELINE_CATALOG_ENTRY.evaluateStep).toBe("evaluate.apply");
    expect(RESEARCH_LEDGER_OWNERSHIP.authoritativeRecorder).toBe("workflowRuns");

    const def = buildResearchJobDefinition("r-5118", {
      userLogin: "trader@example.com",
      trigger: "scheduled",
      cron: "0 21 * * 1-5",
    });
    expect(def.jobId).toBe("research:r-5118");
    expect(def.root.kind).toBe("research");
    expect(def.root.children.map((c) => c.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
  });
});
