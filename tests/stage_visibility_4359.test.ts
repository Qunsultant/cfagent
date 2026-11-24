// @vitest-environment node
/**
 * Issue #4359 ([Stage visibility] FIRST FIX) — checkpoint → Workflow Runs:
 * six engine stages with start/end/duration.
 *
 * Pins:
 *  - 4359-P01 the engine stamps per-unit start and end at checkpoint-write
 *    time; a stage's duration is the recorded difference, never inferred.
 *  - 4359-P02 the status view carries those stamps: every stage and every
 *    unit, with a stage duration computed from them.
 *  - 4359-P03 one projection: JobStageView[] → WorkflowRunStage[] — six
 *    stages in definition order, marked as engine-recorded.
 *  - 4359-P04 a grouped run uses the engine's stages when the reader has
 *    them, and falls back to the job rows when it does not (no regression).
 *  - 4359-P05 a standalone D1 record renders the engine's stages and counts
 *    them; without stages it stays an honest empty list.
 *  - 4359-P06 the /workflow-runs read asks the job-status surface for the
 *    run's engine job, and a missing checkpoint is an empty list, never a
 *    500 and never a dropped row.
 *  - 4359-P07 a checkpoint that belongs to another run is never projected
 *    under this run's id.
 *  - 4359-P09 (#6416) a research row's stages join from the
 *    orchestrator-side stage read, and the ScheduledAgent door is never
 *    asked for a research id.
 *  - 4359-P10 (#6416) a research row's stage detail says what the stage
 *    did (artifact synthesis, descriptor summary, named no-op cause),
 *    while other families keep the node path.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobStageView,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { buildJobRunRecord } from "../src/services/jobRunRecords";
import {
  buildWorkflowRunsPage,
  runFromJobRunRecord,
  runFromJobs,
  stagesFromEngineViews,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";
import { handleWorkflowRunsRoutes } from "../src/agents/routes/workflowRuns";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");

/** A clock that advances one second per reading: start and end can never be equal. */
function tickingClock(startMs: number) {
  let current = startMs;
  return () => {
    const at = new Date(current);
    current += 1000;
    return at;
  };
}

function noopRegistry(): JobStepRegistry {
  const registry = new JobStepRegistry();
  registry.register("noop", async (ctx) => ({ output: ctx.input }));
  return registry;
}

const SIX_STAGES = ["feed", "enrich", "analyze", "store", "serve", "deliver"] as const;

/** The incident's shape: one screener job with six chained stage nodes. */
function sixStageConfig(jobId: string) {
  let node: Record<string, unknown> | undefined;
  for (let i = SIX_STAGES.length - 1; i >= 0; i -= 1) {
    const next: Record<string, unknown> = {
      kind: SIX_STAGES[i],
      steps: [{ step: "noop" }],
      processing: { shards: ["shard-1"] },
      ...(node ? { children: [node] } : {}),
    };
    node = next;
  }
  return { jobId, name: `Screen ${jobId}`, root: node };
}

async function makeHarness() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps: noopRegistry(),
    now: tickingClock(T0),
  });
  return { stores, runStore, control };
}

async function runSixStageJob(jobId = "screen-4359") {
  const harness = await makeHarness();
  await harness.control.defineJob(sixStageConfig(jobId));
  const dispatch = await harness.control.runJob(jobId, { trigger: "manual" });
  const outcome = dispatch.completion ? await dispatch.completion : null;
  const view = await harness.control.getJob(jobId);
  return { ...harness, outcome, view };
}

function jobRow(over: Partial<WorkflowRunJobRow> = {}): WorkflowRunJobRow {
  return {
    job_id: "screen-4359",
    capability: "screening",
    display_name: "Chat stock screen",
    status: "completed",
    created_at: new Date(T0).toISOString(),
    ...over,
  };
}

describe("4359-P01 the engine records per-unit start and end", () => {
  it("stamps startedAt and endedAt on every unit of a six-stage run", async () => {
    const h = await runSixStageJob();
    expect(h.outcome?.state).toBe("completed");
    const instance = await h.stores.instances.getInstance("screen-4359");
    const units = instance?.stageCheckpoint?.units ?? [];
    expect(units).toHaveLength(6);
    for (const unit of units) {
      expect(unit.startedAt, `${unit.stage} started`).toBeTruthy();
      expect(unit.endedAt, `${unit.stage} ended`).toBeTruthy();
      expect(Date.parse(unit.endedAt!)).toBeGreaterThan(Date.parse(unit.startedAt!));
    }
  });
});

describe("4359-P02 the status view carries the recorded stamps", () => {
  it("shows start, end and a duration computed from them on every stage", async () => {
    const h = await runSixStageJob();
    expect(h.view.stages).toHaveLength(6);
    for (const stage of h.view.stages) {
      expect(stage.startedAt, `${stage.kind} start`).toBeTruthy();
      expect(stage.endedAt, `${stage.kind} end`).toBeTruthy();
      expect(stage.durationMs).toBe(Date.parse(stage.endedAt!) - Date.parse(stage.startedAt!));
      expect(stage.units).toHaveLength(1);
      expect(stage.units[0].startedAt).toBeTruthy();
      expect(stage.units[0].endedAt).toBeTruthy();
    }
  });
});

describe("4359-P03 one projection into the Workflow Runs stage shape", () => {
  it("maps six views to six engine-recorded stages in definition order", async () => {
    const h = await runSixStageJob();
    const stages = stagesFromEngineViews(h.view.stages);
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.stage)).toEqual([...SIX_STAGES]);
    expect(stages.every((s) => s.recordedBy === "engine-checkpoint")).toBe(true);
    expect(stages.every((s) => s.status === "completed")).toBe(true);
    expect(stages[0].startedAt).toBe(h.view.stages[0].startedAt);
    expect(stages[0].finishedAt).toBe(h.view.stages[0].endedAt);
    expect(stages[0].durationMs).toBe(h.view.stages[0].durationMs);
  });

  it("orders the rows and numbers them from one", async () => {
    const h = await runSixStageJob();
    const stages = stagesFromEngineViews(h.view.stages);
    expect(stages.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("4359-P04 a grouped run prefers the engine's stages", () => {
  it("counts six stages instead of the one job row", async () => {
    const h = await runSixStageJob();
    const withEngine = runFromJobs([jobRow()], [], undefined, T0, h.view.stages);
    expect(withEngine.stageCount).toBe(6);
    expect(withEngine.completedStages).toBe(6);
    expect(withEngine.stages.map((s) => s.recordedBy)).toEqual(Array(6).fill("engine-checkpoint"));
  });

  it("keeps today's job-row projection when the engine has no stages", async () => {
    const withoutEngine = runFromJobs([jobRow()], [], undefined, T0);
    expect(withoutEngine.stageCount).toBe(1);
    expect(withoutEngine.stages[0].recordedBy).toBe("job");
  });

  it("reads the stages by any job id in the group", async () => {
    const h = await runSixStageJob();
    const engineStages = new Map<string, JobStageView[]>([["screen-4359", h.view.stages]]);
    const page = buildWorkflowRunsPage({
      jobs: [jobRow({ parent_job_id: "wrapper-1" }), jobRow({ job_id: "wrapper-1", job_kind: "main" })],
      outcomes: [],
      transitions: [],
      limit: 10,
      offset: 0,
      includeTraces: false,
      nowMs: T0,
      extraRuns: [],
      engineStages,
    } as never);
    const run = page.runs.find((r) => r.stages.some((s) => s.recordedBy === "engine-checkpoint"));
    expect(run).toBeTruthy();
    expect(run!.stageCount).toBe(6);
  });
});

describe("4359-P05 a standalone D1 record renders the engine's stages", () => {
  const record = buildJobRunRecord({
    system: "job-pipeline",
    jobId: "screen-4359",
    operation: "feed",
    started: new Date(T0).toISOString(),
    finished: new Date(T0 + 60_000).toISOString(),
    outcome: "success",
    triggeredBy: "manual",
    workflowId: "run-1",
    asyncJobId: "screen-4359",
  });

  it("counts and carries them", async () => {
    const h = await runSixStageJob();
    const run = runFromJobRunRecord(record, h.view.stages);
    expect(run.stageCount).toBe(6);
    expect(run.completedStages).toBe(6);
    expect(run.stages[0].recordedBy).toBe("engine-checkpoint");
  });

  it("stays an honest empty list without stages", () => {
    const run = runFromJobRunRecord(record);
    expect(run.stageCount).toBe(0);
    expect(run.stages).toEqual([]);
  });
});

describe("4359-P06 the runs read asks the job-status surface", () => {
  function sqlDouble() {
    return {
      exec: () => [],
    } as never;
  }

  const record = buildJobRunRecord({
    system: "job-pipeline",
    jobId: "screen-4359",
    operation: "feed",
    started: new Date(T0).toISOString(),
    finished: new Date(T0 + 60_000).toISOString(),
    outcome: "success",
    triggeredBy: "manual",
    workflowId: "run-1",
    asyncJobId: "screen-4359",
  });

  it("projects the six stages onto the run", async () => {
    const h = await runSixStageJob();
    const asked: string[][] = [];
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async (jobIds: string[]) => {
          asked.push(jobIds);
          return new Map([["screen-4359", { stages: h.view.stages, checkpointRunId: "run-1" }]]);
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    expect(asked.flat()).toContain("screen-4359");
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.workflow === "Other" || r.id);
    expect(run).toBeTruthy();
    expect(run.stageCount).toBe(6);
  });

  it("renders the row with an empty stage list when no checkpoint is returned", async () => {
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async () => new Map(),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.runs.length).toBeGreaterThan(0);
    expect(data.runs.every((r: any) => Array.isArray(r.stages))).toBe(true);
  });

  it("names a failing stage read in storeErrors and still renders", async () => {
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async () => {
          throw new Error("stage read unavailable");
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.jobStages).toContain("stage read unavailable");
  });
});

describe("4359-P08 the run verb follows the engine's stage verbs", () => {
  const view = (
    status: JobStageView["units"][number]["status"],
  ): JobStageView => ({
    stageId: "job:root",
    nodePath: "",
    kind: "feed",
    startedAt: null,
    endedAt: null,
    durationMs: null,
    units: [{ unitId: "unit-1", status, attempt: 0 }],
  });

  it("reads queued before a stage starts, awaiting when stopped, skipped when cancelled", () => {
    expect(runFromJobs([jobRow()], [], undefined, T0, [view("never-attempted")]).status).toBe(
      "queued",
    );
    expect(runFromJobs([jobRow()], [], undefined, T0, [view("stopped")]).status).toBe("awaiting");
    expect(runFromJobs([jobRow()], [], undefined, T0, [view("cancelled")]).status).toBe("skipped");
  });
});

describe("4359-P07 another run's checkpoint is never projected", () => {
  it("drops stages whose checkpoint belongs to a different run", async () => {
    const h = await runSixStageJob();
    const record = buildJobRunRecord({
      system: "job-pipeline",
      jobId: "screen-4359",
      operation: "feed",
      started: new Date(T0).toISOString(),
      finished: new Date(T0 + 60_000).toISOString(),
      outcome: "success",
      triggeredBy: "manual",
      workflowId: "run-1",
      asyncJobId: "screen-4359",
    });
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => ({ exec: () => [] }) as never,
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        jobStageReader: async () =>
          new Map([["screen-4359", { stages: h.view.stages, checkpointRunId: "run-OTHER" }]]),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.runs.every((r: any) => r.stageCount === 0)).toBe(true);
  });
});

/** Issue #6416 — a research JobStageView, as readResearchRunStages builds it. */
function researchView(
  kind: string,
  nodePath: string,
  over: Partial<JobStageView> = {},
): JobStageView {
  return {
    stageId: `job:${nodePath}`,
    nodePath,
    kind,
    executionMode: null,
    startedAt: "2026-11-23T21:14:59.000Z",
    endedAt: "2026-11-23T21:15:03.000Z",
    durationMs: 3720,
    resultRef: null,
    units: [{ unitId: kind, status: "completed", attempt: 0 }],
    ...over,
  };
}

function researchReport6416() {
  return {
    runId: "r-6416",
    generationId: "gen-r-6416",
    trigger: "manual",
    userLogin: "analyst",
    createdAt: "2026-11-23T21:14:59.000Z",
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

function researchFeedArtifact6416() {
  const symbols = Array.from({ length: 36 }, (_, i) => `SYM${String(i + 1).padStart(2, "0")}`);
  return {
    runId: "r-6416",
    asOf: "2026-11-23T21:14:59.000Z",
    regime: { label: "bullish" },
    universe: "nasdaq100",
    universeError: null,
    symbols,
    quotes: symbols.map((symbol, i) => ({ symbol, quote: i < 34 ? { price: 100 } : null })),
    universeSize: 100,
    quotesRetrieved: 36,
  };
}

describe("4359-P09 a research row joins from the orchestrator-side stage read", () => {
  function sqlDouble() {
    return {
      exec: () => [],
    } as never;
  }

  const record = buildJobRunRecord({
    system: "job-pipeline",
    jobId: "research:r-6416",
    operation: "feed",
    started: new Date(T0).toISOString(),
    finished: new Date(T0 + 60_000).toISOString(),
    outcome: "success",
    triggeredBy: "manual",
    workflowId: "r-6416",
    asyncJobId: "research:r-6416",
  });

  const researchStages = (): JobStageView[] => [
    researchView("feed", "0", {
      resultRef: "research:r-6416:feed (36/100)",
      stageOutput: researchFeedArtifact6416(),
    }),
    researchView("enrich", "1", { resultRef: "research:r-6416:enrich (36 symbols)" }),
    researchView("analyze", "2", {
      resultRef: "research:r-6416:analyze (0 ideas)",
      stageOutput: researchReport6416(),
    }),
    researchView("generate", "3", {
      resultRef: "research:r-6416:generate (rep-6416)",
      stageOutput: {
        report: researchReport6416(),
        publication: {
          success: true,
          reportId: "rep-6416",
          created: true,
          artifacts: {
            pdfStatus: "generated",
            pdfKey: "pdf-6416",
            xlsxStatus: "generated",
            csvStatus: "generated",
          },
          report: researchReport6416(),
        },
      },
    }),
    researchView("deliver", "4", {
      resultRef: "research:r-6416:deliver",
      stageOutput: {
        success: true,
        reportId: "rep-6416",
        emailed: false,
        slack: true,
        webhook: false,
        held: false,
        pdfAttached: true,
        reasons: { webhook: "not configured" },
        report: researchReport6416(),
      },
    }),
    researchView("evaluate", "5", { resultRef: "research:r-6416:evaluate (0 evaluated)" }),
  ];

  it("projects the six stages onto the run and never asks the door for the research id", async () => {
    const askedResearch: string[][] = [];
    const askedDoor: string[][] = [];
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        researchStageReader: async (jobIds: string[]) => {
          askedResearch.push(jobIds);
          return new Map([
            ["research:r-6416", { stages: researchStages(), checkpointRunId: "r-6416", checkpointKind: null }],
          ]);
        },
        jobStageReader: async (jobIds: string[]) => {
          askedDoor.push(jobIds);
          return new Map();
        },
      } as never,
    );
    expect(res!.status).toBe(200);
    expect(askedResearch.flat()).toContain("research:r-6416");
    expect(askedDoor.flat()).not.toContain("research:r-6416");
    const data = (await res!.json()) as any;
    const run = data.runs.find((r: any) => r.stageCount === 6);
    expect(run).toBeTruthy();
    expect(run.stages.map((s: any) => s.stage)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
    expect(run.stages[0].detail).toContain("36/100 quotes retrieved");
    expect(run.stages[2].detail).toContain("14 rejected");
    expect(run.stages[3].detail).toContain("stored rep-6416");
    expect(run.stages[4].detail).toContain("Slack posted");
  });

  it("names a failing research read in storeErrors and still renders", async () => {
    const res = await handleWorkflowRunsRoutes(
      new Request("https://agent.internal/workflow-runs", { method: "GET" }),
      new URL("https://agent.internal/workflow-runs"),
      "/workflow-runs",
      "session-1",
      {
        ensureTables: () => sqlDouble(),
        userLogin: "analyst",
        env: {},
        jobRunRecordReader: async () => [record],
        researchStageReader: async () => {
          throw new Error("research read unavailable");
        },
        jobStageReader: async () => new Map(),
      } as never,
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as any;
    expect(data.storeErrors.jobStages).toContain("research stages: research read unavailable");
  });
});

describe("4359-P10 a research row's stage detail says what the stage did", () => {
  it("synthesizes feed counts from the artifact, not the descriptor", () => {
    const stages = stagesFromEngineViews(
      [researchView("feed", "0", { stageOutput: researchFeedArtifact6416() })],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe(
      "feed: 36/100 quotes retrieved; 64 never attempted; 2 quote failures",
    );
  });

  it("falls back to the descriptor's counts when the artifact is absent", () => {
    const stages = stagesFromEngineViews(
      [researchView("feed", "0", { resultRef: "research:r-6416:feed (36/100)" })],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe("feed: 36/100 quotes");
  });

  it("falls back to the run report when the engine holds no feed record", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("feed", "0", {
          reportEvidence: { stats: { universeSize: 100, quotesRetrieved: 36 } },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toContain("36/100 quotes retrieved (from the run report");
  });

  it("names the cause of a feed no-op, never a bare not_configured", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("feed", "0", {
          stepStatus: "not_configured",
          stageOutput: { stage: "feed", runId: "r-6416", status: "not_configured" },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe(
      "feed did not run (not_configured — no feed runtime was wired for this dispatch)",
    );
  });

  it("reads analyze counts from the bare report, not the vacuous descriptor", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("analyze", "2", {
          resultRef: "research:r-6416:analyze (0 ideas)",
          stageOutput: researchReport6416(),
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe(
      "analyze: 0 qualified, 0 watchlist, 14 rejected (quote_quality 13, thesis_coherence 1); 36 candidates evaluated, 12 chains fetched",
    );
  });

  it("reads analyze counts from the envelope-embedded report too", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("analyze", "2", {
          resultRef: "research:r-6416:analyze (0 ideas)",
          stageOutput: { success: true, reportId: null, report: researchReport6416() },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toContain("14 rejected (quote_quality 13, thesis_coherence 1)");
  });

  it("names the canonical store outcome and the per-format statuses for generate", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("generate", "3", {
          stageOutput: {
            report: researchReport6416(),
            publication: {
              success: true,
              reportId: "rep-6416",
              created: true,
              artifacts: {
                pdfStatus: "generated",
                pdfKey: "pdf-6416",
                xlsxStatus: "generated",
                csvStatus: "generated",
              },
              report: researchReport6416(),
            },
          },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe(
      "generate: report stored rep-6416; PDF generated (pdf-6416); XLSX generated; CSV generated",
    );
  });

  it("names a store refusal and a PDF failure code for generate", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("generate", "3", {
          stageOutput: {
            report: researchReport6416(),
            publication: {
              success: true,
              reportId: null,
              created: false,
              artifacts: {
                pdfStatus: "failed",
                pdfError: "FAILURE_REPORT_PDF_GENERATION",
                xlsxStatus: "failed",
                csvStatus: "failed",
              },
              report: researchReport6416(),
            },
          },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toContain("canonical_store_refused");
    expect(stages[0].detail).toContain("PDF failed (FAILURE_REPORT_PDF_GENERATION)");
  });

  it("names a deduped generate row", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("generate", "3", {
          stageOutput: {
            report: researchReport6416(),
            publication: {
              success: true,
              reportId: "rep-6416",
              created: false,
              artifacts: {
                pdfStatus: "generated",
                pdfKey: "pdf-6416",
                xlsxStatus: "generated",
                csvStatus: "generated",
              },
              report: researchReport6416(),
            },
          },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toContain("deduped (existing rep-6416)");
  });

  it("derives a generate no-op's cause from the analyze envelope", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("analyze", "2", {
          stageOutput: { success: true, reportId: null, report: researchReport6416() },
        }),
        researchView("generate", "3", {
          stepStatus: "not_configured",
          stageOutput: { stage: "generate", runId: "r-6416", status: "not_configured" },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[1].detail).toContain("predates the unwrap fix");
  });

  it("names deliver channel by channel, plus held and confirmation id", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("deliver", "4", {
          stageOutput: {
            success: true,
            reportId: "rep-6416",
            emailed: true,
            slack: true,
            webhook: false,
            held: false,
            emailTo: "ops@example.com",
            pdfAttached: true,
            reasons: { webhook: "not configured" },
            report: researchReport6416(),
          },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe(
      "deliver: Slack posted; email sent to ops@example.com; webhook not sent (not configured); PDF attached",
    );
  });

  it("names a held deliver run first, not three silent not-sents", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("deliver", "4", {
          stageOutput: {
            success: true,
            reportId: "rep-6416",
            emailed: false,
            slack: false,
            webhook: false,
            held: true,
            confirmationId: "rc_hold1",
            pdfAttached: false,
            report: researchReport6416(),
          },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe(
      "deliver held for approval (confirmation rc_hold1); nothing sent",
    );
  });

  it("derives a deliver no-op's cause from the generate no-op", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("generate", "3", {
          stepStatus: "not_configured",
          stageOutput: { stage: "generate", runId: "r-6416", status: "not_configured" },
        }),
        researchView("deliver", "4", {
          stepStatus: "not_configured",
          stageOutput: { stage: "deliver", runId: "r-6416", status: "not_configured" },
        }),
      ],
      "research:r-6416",
    );
    expect(stages[1].detail).toContain("generate produced no publication");
  });

  it("reads enrich from the descriptor summary through the default branch", () => {
    const stages = stagesFromEngineViews(
      [researchView("enrich", "1", { resultRef: "research:r-6416:enrich (36 symbols)" })],
      "research:r-6416",
    );
    expect(stages[0].detail).toBe("36 symbols");
  });

  it("keeps the node path for other families", () => {
    const stages = stagesFromEngineViews(
      [
        researchView("feed", "0", {
          resultRef: "screen-4359:feed (36/100)",
          stageOutput: researchFeedArtifact6416(),
        }),
      ],
      "screen-4359",
    );
    expect(stages[0].detail).toBe("0");
  });
});
