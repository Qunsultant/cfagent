import { describe, expect, it, vi } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import {
  ANALYZE_OODA_STEP,
  EVALUATE_APPLY_STEP,
  createDefaultResearchStepDeps,
} from "../src/services/researchPipelineJobs";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import {
  dispatchResearchEngineRun,
  executeResearchStageControl,
} from "../src/workflows/researchScreenEngine";
import { resolveResearchJobConfig } from "../src/config/researchJobConfig";

describe("Issue #5237 — Nightly OODA J-stack engine cutover & view=ooda UX route", () => {
  it("executes analyze.ooda and evaluate.apply via JobPipelineControl.runJob and records observed stageVisibility", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const runRecorder = jobRunRecorderFromStore(runStore);

    const oodaSpy = vi.fn(async (ctx: { runId: string; userLogin: string; trigger: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        success: true,
        runId: ctx.runId,
        userLogin: ctx.userLogin,
        trigger: ctx.trigger,
        recommendationsCount: 3,
      };
    });
    const evalSpy = vi.fn(async (ctx: { runId: string; userLogin: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        runId: ctx.runId,
        evaluatedAt: new Date().toISOString(),
        aggregates: { evaluated: 3, wins: 2, losses: 1 },
      };
    });

    const result = await dispatchResearchEngineRun({
      runId: "cutover-run-1",
      userLogin: "alice",
      trigger: "manual",
      stores,
      runRecorder,
      // Issue #5915 — no emergency rollback declared: the engine path is the default.
      flags: { isEnabled: async () => false },
      researchDeps: {
        runOodaAnalysis: oodaSpy,
        runEvaluateStage: evalSpy,
      },
      execute: async () => ({ shouldNotBeCalledDirect: true }),
    });

    expect(result.cutoverMode).toBe("engine");
    expect(result.engineJobId).toBe("research:cutover-run-1");
    expect(oodaSpy).toHaveBeenCalledTimes(1);
    expect(oodaSpy).toHaveBeenCalledWith({
      runId: "cutover-run-1",
      userLogin: "alice",
      trigger: "manual",
      datasetAsOf: null,
    });
    expect(evalSpy).toHaveBeenCalledTimes(1);
    expect(result.outcome).toMatchObject({
      success: true,
      runId: "cutover-run-1",
      recommendationsCount: 3,
    });

    // Verify engine persisted the job definition, instance, and run record
    const def = await stores.definitions.getDefinition("research:cutover-run-1");
    expect(def).not.toBeNull();
    const inst = await stores.instances.getInstance("research:cutover-run-1");
    expect(inst?.state).toBe("completed");
    const runs = runStore.listByJob("research:cutover-run-1", 10);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe("success");

    // Verify observed stageVisibility comes from the engine (analyze & evaluate recorded)
    const analyzeVis = result.stageVisibility.find((s) => s.stageId === "analyze");
    const evaluateVis = result.stageVisibility.find((s) => s.stageId === "evaluate");
    expect(analyzeVis?.status).toBe("completed");
    expect(evaluateVis?.status).toBe("completed");
    expect(analyzeVis!.durationMs).toBeGreaterThanOrEqual(10);
    expect(evaluateVis!.durationMs).toBeGreaterThanOrEqual(5);
  });

  it("rolls back to direct execution only behind the explicit emergency flag (#5915)", async () => {
    const directSpy = vi.fn(async () => ({ success: true, mode: "direct" }));
    const result = await dispatchResearchEngineRun({
      runId: "rollback-run-1",
      userLogin: "alice",
      trigger: "scheduled",
      flags: { isEnabled: async (flag) => flag === "research_engine_direct_rollback" },
      execute: directSpy,
    });

    expect(result.cutoverMode).toBe("direct_rollback");
    expect(directSpy).toHaveBeenCalledTimes(1);
    expect(result.outcome).toEqual({ success: true, mode: "direct" });
  });

  it("executes real stage control operations (status, run, rerun) against JobPipelineControl", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const runRecorder = jobRunRecorderFromStore(runStore);

    const oodaSpy = vi.fn(async () => ({ ok: true, pass: "initial" }));
    await dispatchResearchEngineRun({
      runId: "stage-ctrl-1",
      userLogin: "alice",
      trigger: "manual",
      stores,
      runRecorder,
      researchDeps: { runOodaAnalysis: oodaSpy },
      execute: async () => ({ ok: true }),
    });

    const statusRes = await executeResearchStageControl({
      runId: "stage-ctrl-1",
      stageId: "analyze",
      op: "status",
      userLogin: "alice",
      stores,
      runRecorder,
    });
    expect(statusRes.ok).toBe(true);
    expect(statusRes.jobState).toBe("completed");
    expect(statusRes.stage?.kind).toBe("analyze");

    const rerunRes = await executeResearchStageControl({
      runId: "stage-ctrl-1",
      stageId: "analyze",
      op: "rerun",
      userLogin: "alice",
      stores,
      runRecorder,
      researchDeps: { runOodaAnalysis: oodaSpy },
    });
    expect(rerunRes.ok).toBe(true);
    expect(oodaSpy).toHaveBeenCalledTimes(2);
    expect(rerunRes.jobState).toBe("completed");
  });

  it("wires research steps into createPipelineStepRegistry via createDefaultResearchStepDeps", () => {
    const registry = createPipelineStepRegistry(
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
    expect(registry.has(ANALYZE_OODA_STEP)).toBe(true);
    expect(registry.has(EVALUATE_APPLY_STEP)).toBe(true);
  });

  it("defaults storageMode to durable and honors RESEARCH_STORAGE_MODE=in-memory (#5273)", async () => {
    expect(resolveResearchJobConfig().storageMode).toBe("durable");
    expect(resolveResearchJobConfig({ RESEARCH_STORAGE_MODE: "in-memory" }).storageMode).toBe(
      "in-memory",
    );

    const res = await dispatchResearchEngineRun({
      runId: "storage-mode-1",
      userLogin: "alice",
      trigger: "manual",
      sql: {} as never,
      env: { RESEARCH_STORAGE_MODE: "in-memory" },
      execute: async () => ({ success: true }),
    });
    expect(res.storageMode).toBe("in-memory");
    expect(res.outcome).toEqual({ success: true });
  });
});
