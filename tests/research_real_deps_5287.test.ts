import { describe, expect, it, vi } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import {
  ANALYZE_OODA_STEP,
  createDefaultResearchStepDeps,
} from "../src/services/researchPipelineJobs";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import { executeAgentComposedResearchViaDoor } from "../src/agents/orchestrator/meshResearchDoor.deprecated";
import {
  dispatchResearchEngineRun,
  executeResearchStageControl,
} from "../src/workflows/researchScreenEngine";
import { handleScreenerResearchRoutes } from "../src/agents/routes/screenerResearch";

describe("Issue #5287 — Real researchDeps wiring & stub-unreachable pins", () => {
  it("refuses createDefaultResearchStepDeps stub execution unless allowTestStub or real runOodaAnalysis is provided", async () => {
    const prodRegistry = createPipelineStepRegistry(
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createDefaultResearchStepDeps(),
    );
    await expect(
      prodRegistry.resolve(ANALYZE_OODA_STEP)({
        jobId: "research:prod-guard-1",
        runId: "r-1",
        nodePath: "2",
        kind: "analyze",
        stepIndex: 0,
        item: null,
        itemIndex: null,
        items: [],
        shardKey: null,
        params: { runId: "prod-guard-1", userLogin: "alice", trigger: "manual" },
        input: null,
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow("FAILURE_RESEARCH_DEPS_MISSING");
  });

  it("refuses executeResearchStageControl execution ops without researchDeps when allowTestStub is false", async () => {
    await expect(
      executeResearchStageControl({
        runId: "no-deps-1",
        stageId: "analyze",
        op: "rerun",
        userLogin: "alice",
        allowTestStub: false,
      }),
    ).rejects.toThrow("FAILURE_RESEARCH_DEPS_MISSING");
  });

  it("wires real researchDeps through POST /research/runs/:runId/stages/:stageId and executeAgentComposedResearchViaDoor", async () => {
    const runResearchAndPublish = vi.fn(async () => ({ success: true, reportId: "rep-5287" }));
    const ctx = {
      getScreenerAgent: vi.fn(),
      getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
      getResearchAgent: vi.fn(() => null),
      runResearchAndPublish,
      getOrm: vi.fn(() => undefined),
      env: {},
      readSettingRaw: vi.fn(() => null),
      writeSetting: vi.fn(),
    } as any;

    const res = await handleScreenerResearchRoutes(
      new Request("https://agent.internal/research/runs/r-5287/stages/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-login": "alice" },
        body: JSON.stringify({ op: "run" }),
      }),
      new URL("https://agent.internal/research/runs/r-5287/stages/analyze"),
      "/research/runs/r-5287/stages/analyze",
      "alice",
      ctx,
    );
    expect((res as Response).status).toBe(200);
    // Issue #5911 — the stage's run id is the publish entry's run id.
    expect(runResearchAndPublish).toHaveBeenCalledWith("manual", "alice", { runId: "r-5287" });

    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const oodaSpy = vi.fn(async () => ({ success: true, doorRealDeps: true }));
    const composed = await executeAgentComposedResearchViaDoor({
      actingLogin: "alice",
      runId: "door-comp-5287",
      stages: ["analyze"],
      stores,
      runRecorder,
      researchDeps: { runOodaAnalysis: oodaSpy },
    });
    expect(composed.mode).toBe("agent_composed");
    expect(oodaSpy).toHaveBeenCalledTimes(1);
  });
});
