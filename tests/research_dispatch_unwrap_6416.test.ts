// @vitest-environment node
/**
 * Issue #6416 ([5109] Ledger shows the feed stage for a research run) —
 * the folded unwrap defect, the requireStageInputs drift, and the
 * orchestrator-side stage read.
 *
 * Pins:
 *  - 6416-U01 the inline dispatch unwraps the publish envelope to the
 *    bare report for the analyze step, while the dispatch outcome stays
 *    the envelope (the route spreads it into POST /research/run, and
 *    the OODA page reads data.success / data.report from it).
 *  - 6416-U02 a publish-leg failure fails closed: analyze throws and the
 *    dispatch rejects instead of flowing a vacuous 0-idea report on.
 *  - 6416-U03 a stub dispatch receipt (mesh/MCP doors) passes through
 *    unchanged: the dispatch succeeds exactly as today.
 *  - 6416-U04 requireStageInputs is live on a dispatch that carries real
 *    feed+enrich deps: an analyze that receives no persisted feed/enrich
 *    fails closed instead of running from scratch.
 *  - 6416-U05 the orchestrator-side stage read adapts the six research
 *    stages to JobStageViews (descriptor, stepStatus, artifact) and
 *    answers nothing for a non-research id.
 *  - 6416-U06 the deliver leg returns the full delivery outcome (slack,
 *    webhook, held, confirmation id, per-channel reasons) instead of
 *    `emailed` alone, and names the HITL hold when delivery is held.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import {
  dispatchResearchEngineRun,
  readResearchStages,
} from "../src/workflows/researchScreenEngine";
import { readResearchRunStages } from "../src/agents/routes/workflowRuns";
import { runResearchAndPublish } from "../src/agents/orchestrator/researchPublish";

const USER = "alice@example.com";

function feedOutput(runId: string) {
  const symbols = Array.from({ length: 36 }, (_, i) => `SYM${String(i + 1).padStart(2, "0")}`);
  return {
    runId,
    asOf: "2026-11-24T00:00:00.000Z",
    regime: { label: "bullish" },
    universe: "nasdaq100",
    universeError: null,
    symbols,
    quotes: symbols.map((symbol) => ({ symbol, quote: { price: 100 } })),
    universeSize: 100,
    quotesRetrieved: 36,
  };
}

function enrichOutput(runId: string, feed: ReturnType<typeof feedOutput>) {
  return { runId, asOf: feed.asOf, feed, bySymbol: {} };
}

function cannedReport(runId: string) {
  return {
    runId,
    generationId: `gen-${runId}`,
    trigger: "manual",
    userLogin: USER,
    createdAt: "2026-11-24T00:00:00.000Z",
    rulesVersion: "1",
    rules: {},
    configSnapshot: {},
    evaluationFeedback: { applied: false },
    regime: { label: "bullish" },
    summary: "test report",
    ideas: [],
    watchlist: [],
    rejected: Array.from({ length: 14 }, (_, i) => ({
      symbol: `SYM${String(i + 1).padStart(2, "0")}`,
      outlook: "neutral",
      structure: "call",
      gate: i < 13 ? "quote_quality" : "thesis_coherence",
      reason: "rejected",
    })),
    stats: {
      universeSize: 100,
      quotesRetrieved: 36,
      candidatesEvaluated: 36,
      chainsFetched: 12,
      chainsCalibrated: 0,
      qualified: 0,
      watchlist: 0,
      rejected: 14,
      unverified: 0,
      oodaIterations: 1,
      durationMs: 1010,
    },
  };
}

describe("6416-U01 the dispatch unwraps the envelope for analyze, not for the outcome", () => {
  it("hands generate the bare report while the outcome stays the envelope", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const runId = "r-6416-unwrap";
    const rep = cannedReport(runId);
    const generateInputs: Array<unknown> = [];
    const deliverInputs: Array<unknown> = [];
    const dispatched = await dispatchResearchEngineRun({
      runId,
      userLogin: USER,
      trigger: "manual",
      stores,
      runRecorder,
      researchDeps: {
        runFeedStage: async () => feedOutput(runId),
        runEnrichStage: async (input) => enrichOutput(runId, input.feed),
        runGenerateStage: async (input) => {
          generateInputs.push(input.report);
          return {
            success: true,
            reportId: "rep-6416",
            created: true,
            artifacts: {
              pdfStatus: "generated",
              pdfKey: "pdf-6416",
              xlsxStatus: "generated",
              csvStatus: "generated",
            },
            report: input.report,
          };
        },
        runDeliverStage: async (input) => {
          deliverInputs.push(input);
          return {
            success: true,
            reportId: "rep-6416",
            emailed: false,
            slack: true,
            webhook: false,
            held: false,
            report: input.report,
          };
        },
      },
      execute: async () => ({
        success: true,
        reportId: null,
        created: false,
        emailed: false,
        report: rep,
        taskId: null,
      }),
    });

    // The dispatch outcome stays the envelope: the route spreads it into
    // POST /research/run and the OODA page reads data.success/report.
    expect(dispatched.outcome).toMatchObject({ success: true, report: rep });
    expect((dispatched.outcome as Record<string, unknown>).reportId).toBeNull();
    // Generate received the BARE report, not the envelope.
    expect(generateInputs).toHaveLength(1);
    const genReport = generateInputs[0] as Record<string, unknown>;
    expect(genReport).toMatchObject({ runId });
    expect(Array.isArray(genReport.ideas)).toBe(true);
    expect("success" in genReport).toBe(false);
    // Deliver received the report plus the generation publication.
    expect(deliverInputs).toHaveLength(1);
    const deliverInput = deliverInputs[0] as Record<string, unknown>;
    expect((deliverInput.report as Record<string, unknown>).runId).toBe(runId);
    expect(deliverInput.publication).toMatchObject({ reportId: "rep-6416" });
    // The analyze artifact IS the bare report.
    const stages = await readResearchStages({ runId, userLogin: USER, stores, runRecorder }, { includeStageOutputs: true });
    const analyze = stages.stages.find((s) => s.stageId === "analyze");
    expect(analyze?.status).toBe("completed");
    const artifact = analyze?.output as Record<string, unknown>;
    expect(Array.isArray(artifact.ideas)).toBe(true);
    expect("success" in artifact).toBe(false);
    expect(dispatched.stageVisibility.find((s) => s.stageId === "analyze")?.status).toBe(
      "completed",
    );
  });
});

describe("6416-U02 a publish-leg failure fails closed", () => {
  it("rejects the dispatch instead of flowing a vacuous report on", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const runId = "r-6416-fail";
    await expect(
      dispatchResearchEngineRun({
        runId,
        userLogin: USER,
        trigger: "manual",
        stores,
        runRecorder,
        researchDeps: {
          runFeedStage: async () => feedOutput(runId),
          runEnrichStage: async (input) => enrichOutput(runId, input.feed),
        },
        execute: async () => ({ success: false, error: "research boom" }),
      }),
    ).rejects.toThrow("research boom");
  });
});

describe("6416-U03 a stub dispatch receipt passes through unchanged", () => {
  it("succeeds exactly as today for the mesh/MCP stub executes", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const dispatched = await dispatchResearchEngineRun({
      runId: "r-6416-stub",
      userLogin: USER,
      trigger: "manual",
      stores,
      runRecorder,
      execute: async () => ({ dispatched: true, trigger: "manual", stages: ["feed", "analyze"] }),
    });
    expect(dispatched.outcome).toMatchObject({ dispatched: true });
    expect(dispatched.stageVisibility.find((s) => s.stageId === "analyze")?.status).toBe(
      "completed",
    );
  });

  it("passes a caller-supplied analysis double through unchanged", async () => {
    // The #5237 shape: a runOodaAnalysis override returning
    // {success: true, ...} with no report is a legitimate dep value,
    // not a publish leg — the unwrap must not fail it closed.
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const dispatched = await dispatchResearchEngineRun({
      runId: "r-6416-double",
      userLogin: USER,
      trigger: "manual",
      stores,
      runRecorder,
      researchDeps: {
        runOodaAnalysis: async (ctx) => ({
          success: true,
          runId: ctx.runId,
          userLogin: ctx.userLogin,
          trigger: ctx.trigger,
          recommendationsCount: 3,
        }),
      },
      execute: async () => ({ shouldNotBeCalledDirect: true }),
    });
    expect(dispatched.outcome).toMatchObject({ success: true, recommendationsCount: 3 });
    expect(dispatched.stageVisibility.find((s) => s.stageId === "analyze")?.status).toBe(
      "completed",
    );
  });
});

describe("6416-U04 requireStageInputs is live on a real-deps dispatch", () => {
  it("fails closed when analyze receives no persisted feed/enrich", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const runId = "r-6416-guard";
    await expect(
      dispatchResearchEngineRun({
        runId,
        userLogin: USER,
        trigger: "manual",
        stores,
        runRecorder,
        researchDeps: {
          runFeedStage: async () => feedOutput(runId),
          // An enrich output with no `feed` field: the enrich step
          // completes (its descriptor reads bySymbol), but analyze
          // receives no persisted feed input.
          runEnrichStage: async () =>
            ({ runId, asOf: "2026-11-24T00:00:00.000Z", bySymbol: {} }) as never,
        },
        execute: async () => ({ success: true, report: cannedReport(runId) }),
      }),
    ).rejects.toThrow("research_stage_input_missing");
  });
});

describe("6416-U05 the orchestrator-side stage read", () => {
  it("adapts the six research stages and answers nothing for other ids", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const runId = "r-6416-adapter";
    await dispatchResearchEngineRun({
      runId,
      userLogin: USER,
      trigger: "manual",
      stores,
      runRecorder,
      execute: async () => ({ dispatched: true, trigger: "manual", stages: [] }),
    });
    const reads = await readResearchRunStages(
      { userLogin: USER, stores, runRecorder },
      ["research:r-6416-adapter", "screen-1"],
    );
    expect([...reads.keys()]).toEqual(["research:r-6416-adapter"]);
    const read = reads.get("research:r-6416-adapter")!;
    expect(read.checkpointRunId).toBe("r-6416-adapter");
    expect(read.stages.map((s) => s.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
    expect(read.stages.every((s) => s.stageId.startsWith("job:"))).toBe(true);
    const feed = read.stages[0];
    expect(feed.stepStatus).toBe("not_configured");
    expect(feed.stageOutput).toMatchObject({ stage: "feed", status: "not_configured" });
    expect(feed.resultRef).toBe("research:r-6416-adapter:feed");
    const evaluate = read.stages[5];
    expect(evaluate.stageOutput).toBeNull();
    expect(evaluate.stepStatus).toBeNull();
    expect(evaluate.resultRef).toBe("research:r-6416-adapter:evaluate (0 evaluated)");
  });
});

describe("6416-U06 the deliver leg returns the full delivery outcome", () => {
  it("carries slack, webhook, held and the per-channel reasons, not emailed alone", async () => {
    const rep = cannedReport("r-6416-leg");
    const ctx = {
      env: {},
      agentCtx: {},
      ensureTables: () => ({ exec: () => [] }),
      getOrm: () => ({}),
      getResearchAgent: () => ({
        getResearchPdfByKey: async () => null,
        refreshIdeaQuotes: async () => [],
        getResearchConfig: async () => ({ autoEmail: false }),
      }),
      getReportDispatchHitl: () => false,
      createReportConfirmation: () => "rc_test",
      RESEARCH_TASK_HEARTBEAT_MS: 1000,
    } as never;
    const result = await runResearchAndPublish(ctx, "manual", USER, {
      stage: "deliver",
      report: rep as never,
      publication: {
        reportId: "rep-6416",
        created: true,
        artifacts: {
          pdfStatus: "generated",
          pdfKey: "pdf-6416",
          xlsxStatus: "generated",
          csvStatus: "generated",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.reportId).toBe("rep-6416");
    expect(result.emailed).toBe(false);
    expect(result.slack).toBe(false);
    expect(result.webhook).toBe(false);
    expect(result.held).toBe(false);
    expect(result.confirmationId).toBeUndefined();
    expect(result.pdfAttached).toBe(false);
    expect(result.reasons).toMatchObject({
      email: "email opt-in off",
      webhook: "not configured",
    });
    expect((result.report as Record<string, unknown>).runId).toBe("r-6416-leg");
  });

  it("names the hold and its confirmation id when HITL holds delivery", async () => {
    const rep = cannedReport("r-6416-hold");
    const ctx = {
      env: {},
      agentCtx: {},
      ensureTables: () => ({ exec: () => [] }),
      getOrm: () => ({}),
      getResearchAgent: () => ({
        getResearchPdfByKey: async () => null,
        refreshIdeaQuotes: async () => [],
        getResearchConfig: async () => ({ autoEmail: true, emailTo: "ops@example.com" }),
      }),
      getReportDispatchHitl: () => true,
      createReportConfirmation: () => "rc_hold1",
      RESEARCH_TASK_HEARTBEAT_MS: 1000,
    } as never;
    const result = await runResearchAndPublish(ctx, "manual", USER, {
      stage: "deliver",
      report: rep as never,
      publication: {
        reportId: "rep-6416",
        created: true,
        artifacts: {
          pdfStatus: "generated",
          pdfKey: "pdf-6416",
          xlsxStatus: "generated",
          csvStatus: "generated",
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.held).toBe(true);
    expect(result.confirmationId).toBe("rc_hold1");
    expect(result.emailed).toBe(false);
    expect(result.slack).toBe(false);
    expect(result.webhook).toBe(false);
  });
});
