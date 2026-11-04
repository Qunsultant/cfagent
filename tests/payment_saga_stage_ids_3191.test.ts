/**
 * Issue #3191 - the anti-drift pins for the two families whose step ids are
 * groundable today (payment, saga). Each pin does two things:
 *   1. the exported constant equals the `step.do("...")` ids actually present
 *      in that family's flow source, so a new/renamed step fails here;
 *   2. the catalog's declaration is an exact partition of that constant, so
 *      the page cannot drift from the code either.
 * Options and trading are asserted to be explicitly UNMAPPED rather than
 * quietly blank.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAYMENT_STEP_IDS, SAGA_STEP_IDS } from "../src/workflows/stageRuntimeIds";
import { WORKFLOW_CATALOG, workflowById } from "../src/workflows/workflowCatalog";

function stepIdsIn(sourcePath: string): string[] {
  const src = readFileSync(sourcePath, "utf8");
  const found = new Set<string>();
  // Issue #3073 routed payment steps through a `doStep` wrapper that emits a
  // boundary after each stage; saga calls it doStage. The scan follows the
  // code, so it accepts any of the three shapes and still requires every id
  // to be declared.
  for (const match of src.matchAll(/(?:step\.do|doStep|doStage)\(\s*"([a-z0-9-]+)"/g)) found.add(match[1]!);
  return [...found].sort();
}

const declaredIds = (id: string): string[] =>
  workflowById(id)!.stages.flatMap((stage) => stage.runtimeStageIds ?? []);

describe("payment stage ids (#3191)", () => {
  it("the exported constant matches the flow's real step.do ids", () => {
    expect([...PAYMENT_STEP_IDS].sort()).toEqual(stepIdsIn("src/workflows/paymentWorkflowFlow.ts"));
  });

  it("the catalog declares an exact partition of them", () => {
    const declared = declaredIds("payment-run");
    expect([...declared].sort()).toEqual([...PAYMENT_STEP_IDS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("saga stage ids (#3191)", () => {
  it("the exported constant matches the flow's real step.do ids", () => {
    expect([...SAGA_STEP_IDS].sort()).toEqual(stepIdsIn("src/workflows/sagaWorkflowFlow.ts"));
  });

  it("the catalog declares an exact partition of them", () => {
    const declared = declaredIds("saga-run");
    expect([...declared].sort()).toEqual([...SAGA_STEP_IDS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("every family is either mapped or names its gap (#3191)", () => {
  it("options and trading are mapped too now (#3191 second half)", () => {
    for (const id of ["options-screener", "trading-leg"]) {
      const workflow = workflowById(id)!;
      const ids = workflow.stages.flatMap((stage) => stage.runtimeStageIds ?? []);
      expect(ids.length).toBeGreaterThan(0);
      expect(workflow.runtimeMappingGap).toBeUndefined();
    }
  });

  it("a mapped family carries no gap note", () => {
    for (const id of ["stock-screener", "options-screener", "trading-leg", "payment-run", "saga-run"]) {
      const workflow = workflowById(id)!;
      expect(workflow.runtimeMappingGap).toBeUndefined();
    }
  });

  it("the catalog is otherwise valid", () => {
    expect(WORKFLOW_CATALOG.length).toBe(7);
  });
});
