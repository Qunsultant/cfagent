/**
 * Issue #6035 (b) — the OODA run dispatches through the workflow residency.
 *
 * The residency and its research stage deps already exist (#5237); this slice
 * adds the start seam and the dispatch branch. What this file pins without a
 * real D1 residency (the same seam is exercised end-to-end by the options-host
 * suites; the D1 adapter has its own):
 *
 *  R1  availability is a binding fact: no workflow binding or no AGENT_DB means
 *      "not dispatchable", and the start seam refuses BY NAME rather than
 *      silently falling back to a second scheduler;
 *  R2  a deployment without the residency keeps today's in-process sync run —
 *      `durableResidency` stays absent and the caller's execute is what runs;
 *  R3  the definition the durable path defines has exactly ONE node per stage,
 *      each with ONE step — so the workflow's node loop yields one durable step
 *      per stage, which is the point of the slice.
 */
import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import {
  dispatchResearchEngineRun,
  type DispatchResearchEngineInput,
} from "../src/workflows/researchScreenEngine";
import {
  researchWorkflowResidencyAvailable,
  startResearchJobWorkflow,
} from "../src/workflows/researchWorkflowHost";
import { buildResearchJobDefinition } from "../src/services/researchPipelineJobs";
import { RESEARCH_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";

const NOW = Date.now();

function baseInput(overrides: Partial<DispatchResearchEngineInput> = {}): DispatchResearchEngineInput {
  return {
    userLogin: "owner",
    trigger: "manual",
    runId: "run-6035b",
    env: {},
    execute: async () => ({ report: "in-process" }),
    ...overrides,
  };
}

describe("#6035 (b) — durable residency dispatch", () => {
  it("R1: availability is a binding fact, and an unbound start refuses by name", async () => {
    expect(researchWorkflowResidencyAvailable(undefined)).toBe(false);
    expect(researchWorkflowResidencyAvailable({} as Env)).toBe(false);
    expect(
      researchWorkflowResidencyAvailable({ JOB_PIPELINE_WORKFLOW: {} } as unknown as Env),
    ).toBe(false);
    expect(
      researchWorkflowResidencyAvailable({ AGENT_DB: {} } as unknown as Env),
    ).toBe(false);
    expect(
      researchWorkflowResidencyAvailable({
        JOB_PIPELINE_WORKFLOW: { create: () => Promise.resolve({ id: "x" }) },
        AGENT_DB: {},
      } as unknown as Env),
    ).toBe(true);

    await expect(
      startResearchJobWorkflow({
        env: {} as Env,
        definition: {},
        engineJobId: "research:run-6035b",
        trigger: "manual",
      }),
    ).rejects.toThrow(/job_pipeline_workflow_not_configured/);
  });

  it("R2: without the residency the run keeps the in-process sync path", async () => {
    let executed = 0;
    const result = await dispatchResearchEngineRun(
      baseInput({
        durableEnv: {} as Env, // unbound deployment
        execute: async () => {
          executed += 1;
          return { report: "in-process" };
        },
      }),
    );
    expect(executed).toBe(1);
    expect(result.cutoverMode).toBe("engine");
    expect(result.durableResidency).toBeUndefined();
    expect(result.outcome).toEqual({ report: "in-process" });
    // The stage mapping is the same on both paths.
    expect(result.stageVisibility.map((stage) => stage.stageId)).toEqual([
      ...RESEARCH_PIPELINE_STAGES,
    ]);
  });

  it("R3: the definition carries one node and one step per stage", () => {
    const definition = buildResearchJobDefinition("run-6035b", {
      userLogin: "owner",
      trigger: "manual",
    }) as unknown as {
      root: { children?: Array<{ kind?: string; steps?: unknown[]; children?: unknown[] }> };
    };
    const children = definition.root.children ?? [];
    expect(children.map((child) => child.kind)).toEqual([...RESEARCH_PIPELINE_STAGES]);
    for (const child of children) {
      // One step per stage node: the workflow's node loop is the durable
      // boundary, so a restart resumes at the last completed stage.
      expect(child.steps).toHaveLength(1);
      expect(child.children).toBeUndefined();
    }
  });
});
