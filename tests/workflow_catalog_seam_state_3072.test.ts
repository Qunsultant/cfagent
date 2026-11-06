/**
 * Issue #3072/#3073 - the catalog must describe the seam that now exists.
 *
 * The failure this guards against is the one that already happened twice in
 * this programme: a declaration that reads well and is not true. So the pins
 * here do not check that the page renders; they check that what it renders
 * matches the code:
 *
 *   - a seam-wired family publishes exactly the runtime steps it executes;
 *   - an unwired family publishes nothing and says why;
 *   - the families whose flows now emit boundaries are the ones flagged wired.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKFLOW_CATALOG, workflowById } from "../src/workflows/workflowCatalog";
import { STAGE_IDS_BY_FAMILY } from "../src/workflows/stageMessage";

const read = (path: string) => readFileSync(path, "utf8");

describe("declared seam state matches the code (#3072/#3073)", () => {
  it("the four newly wired families are flagged wired", () => {
    for (const id of ["options-screener", "trading-leg", "payment-run", "saga-run", "stock-screener"]) {
      expect(workflowById(id)!.stageSeam).toBe(true);
    }
  });

  it("the families that run on someone else's seam stay unwired and say so", () => {
    for (const id of ["goal-screen", "strategy-discovery"]) {
      const workflow = workflowById(id)!;
      expect(workflow.stageSeam).toBe(false);
      expect(workflow.stages.every((stage) => stage.publishes.length === 0)).toBe(true);
      expect((workflow.runtimeMappingGap ?? "").length).toBeGreaterThan(10);
    }
  });

  it("every wired stage publishes exactly the steps it executes", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      if (!workflow.stageSeam) continue;
      for (const stage of workflow.stages) {
        expect(stage.publishes).toEqual(stage.runtimeStageIds ?? []);
      }
    }
  });

  it("the catalog's per-family ids are the ones the seam validates against", () => {
    const familyOf: Record<string, keyof typeof STAGE_IDS_BY_FAMILY> = {
      "stock-screener": "stock",
      "options-screener": "options",
      "trading-leg": "trading",
      "payment-run": "payment",
      "saga-run": "saga",
    };
    for (const [workflowId, family] of Object.entries(familyOf)) {
      const declared = workflowById(workflowId)!.stages.flatMap((stage) => stage.runtimeStageIds ?? []);
      expect([...declared].sort()).toEqual([...STAGE_IDS_BY_FAMILY[family]].sort());
    }
  });

  it("every id the catalog publishes is one the emitter can actually send", () => {
    // The emitter validates through stageMessage, which knows STAGE_IDS_BY_FAMILY.
    const allKnown = new Set(Object.values(STAGE_IDS_BY_FAMILY).flat());
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) {
        for (const topic of stage.publishes) expect(allKnown.has(topic)).toBe(true);
      }
    }
  });
});

describe("the flows behind the declarations still emit (#3072/#3073)", () => {
  it("payment routes every step through the boundary wrapper", () => {
    const source = read("src/workflows/paymentWorkflowFlow.ts");
    expect(source).toMatch(/const doStep = async/);
    expect(source).not.toMatch(/await step\.do\(\s*"/);
  });

  it("saga routes its declared stages through the wrapper and not its wait", () => {
    const source = read("src/workflows/sagaWorkflowFlow.ts");
    expect(source).toMatch(/const doStage = async/);
    expect(source).toMatch(/step\.do\(`poll-/);
  });

  it("trading emits both of its steps", () => {
    const source = read("src/agents/trading-trade-workflow.ts");
    expect(source).toMatch(/emitBoundary\(env, params, "await-approval"\)/);
    expect(source).toMatch(/emitBoundary\(env, params, "settle-trade"\)/);
  });

  it("options publishes per stage, after persist, through the pipeline composer", () => {
    // Old pin asserted the manual handler published once, at the end,
    // through emitOptionsStageBoundaries; #3186 step 3d retired that
    // end-of-run emitter in favour of per-stage messages published by the
    // pipeline composer after each stage persists. This pin proves the
    // route runs the pipeline and the composer publishes after persist.
    const route = read("src/agents/routes/etradeOptionsScreen.ts");
    expect(route).toContain("runOptionsScreenWorkflow");
    const composer = read("src/workflows/optionsScreenWorkflow.ts");
    expect(composer).toContain("publishStageBoundaryMessage");
    expect(composer.indexOf("await port.persist(")).toBeGreaterThan(0);
    expect(composer.indexOf("publishStageBoundaryMessage({")).toBeGreaterThan(
      composer.indexOf("await port.persist("),
    );
  });
});
