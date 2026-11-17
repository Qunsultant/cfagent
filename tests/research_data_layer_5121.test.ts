import { describe, expect, it } from "vitest";
import { createTenantAwareCanonicalReportStore } from "../src/services/canonicalReportLeg";
import type { ResearchReport } from "../src/services/researchPipeline";
import type { ResearchTask } from "../src/services/researchTaskLedger";
import {
  RESEARCH_CANONICAL_LEG_REASONS,
  recordResearchRunThroughLeg,
  researchReportToStoreInput,
} from "../src/workflows/researchCanonicalLeg";
import {
  createResearchEvaluationStore,
  reconcileResearchTaskWithRunRecord,
  researchArtifactKey,
  researchEngineJobId,
  resolveResearchDatasets,
} from "../src/workflows/researchDataPorts";

function makeSampleReport(runId = "res-5121-1"): ResearchReport {
  return {
    runId,
    generationId: `options_research:${runId}`,
    trigger: "manual",
    userLogin: "trader@example.com",
    createdAt: "2026-11-17T21:00:00.000Z",
    rulesVersion: "1.0.0",
    summary: "Nightly OODA research summary",
    ideas: [],
    watchlist: [],
    rejected: [],
    stats: {
      universeCount: 10,
      scannedCount: 10,
      candidateCount: 2,
      ideaCount: 1,
      rejectedCount: 1,
      budgetExhausted: false,
      elapsedMs: 120,
    },
    oodaTrace: [],
  };
}

describe("Issue #5121 (Sub-issue 1 of #5109) — Research Data Layer", () => {
  it("stores reports through the tenant-aware canonical leg and fails closed on missing owner or refused write", async () => {
    const report = makeSampleReport("run-canonical-1");
    const storeInput = researchReportToStoreInput(
      report,
      { pdfStatus: "generated", pdfKey: "r2/res.pdf" },
      "trader@example.com",
    );
    expect(storeInput.source).toBe("options_research");
    expect(storeInput.generationId).toBe("options_research:run-canonical-1");

    const seam = createTenantAwareCanonicalReportStore({
      ownerLogin: "trader@example.com",
      record: async (input) => ({
        reportId: `rpt:${input.runId}`,
        created: true,
      }),
    });
    const ok = await recordResearchRunThroughLeg(seam, {
      report,
      artifacts: { pdfStatus: "generated", pdfKey: "r2/res.pdf" },
    });
    expect(ok).toEqual({
      reportId: "rpt:run-canonical-1",
      created: true,
      leg: { status: "wired" },
    });

    const missingOwner = await recordResearchRunThroughLeg(
      createTenantAwareCanonicalReportStore({ record: async () => ({ reportId: "x", created: true }) }),
      { report },
    );
    expect(missingOwner.leg).toEqual({
      status: "failed",
      reason: RESEARCH_CANONICAL_LEG_REASONS.missingOwner,
    });

    const refused = await recordResearchRunThroughLeg(
      createTenantAwareCanonicalReportStore({
        ownerLogin: "trader@example.com",
        record: async () => null,
      }),
      { report },
    );
    expect(refused.leg).toEqual({
      status: "failed",
      reason: RESEARCH_CANONICAL_LEG_REASONS.storeRefused,
    });
  });

  it("resolves persisted engine feed datasets, pinned evaluation store, and task-ledger reconciliation", async () => {
    expect(researchEngineJobId("r1")).toBe("research:r1");
    expect(researchArtifactKey("r1", "analyze")).toBe("research:r1:analyze");

    const missing = await resolveResearchDatasets({
      feedDatasetPort: { latestUsable: async () => null },
      source: "alpaca",
      index: "SP500",
    });
    expect(missing.available).toBe(false);
    expect(missing.dataset).toBeNull();

    const savedEvals: Array<{ runId: string; evalJson: string }> = [];
    const evalStore = createResearchEvaluationStore({
      listRunReportJson: () => [],
      listEvaluationJson: () => savedEvals.map((e) => e.evalJson),
      getRunReportJson: () => null,
      saveEvaluation: (runId, evalJson) => savedEvals.push({ runId, evalJson }),
    });
    evalStore.saveEvaluation("r1", {
      runId: "r1",
      evaluatedAt: "2026-11-17T22:00:00.000Z",
      rulesVersion: "1.0.0",
      stats: { evaluated: 0, invalidated: 0, winning: 0, directionCorrect: 0 },
      results: [],
    });
    expect(savedEvals).toHaveLength(1);
    expect(evalStore.loadTrackRecord().published).toBe(0);

    const task: ResearchTask = {
      id: "task-1",
      idempotencyKey: "k-1",
      trigger: "scheduled",
      userLogin: "trader@example.com",
      status: "completed",
      createdAt: "2026-11-17T21:00:00.000Z",
      updatedAt: "2026-11-17T21:05:00.000Z",
      heartbeatAt: "2026-11-17T21:05:00.000Z",
      path: "agent",
      reportRunId: "r1",
      evaluation: {
        verdict: "pass",
        evaluatedAt: "2026-11-17T21:05:00.000Z",
        checks: [],
      },
      history: [],
    };
    const reconciled = reconcileResearchTaskWithRunRecord(task, researchEngineJobId("r1"));
    expect(reconciled).toEqual({
      engineJobId: "research:r1",
      taskId: "task-1",
      userLogin: "trader@example.com",
      trigger: "scheduled",
      engineStatus: "completed",
      reportRunId: "r1",
      executionPath: "agent",
      evaluationVerdict: "pass",
      updatedAt: "2026-11-17T21:05:00.000Z",
    });
  });
});
