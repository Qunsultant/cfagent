/**
 * Issue #4772 — the workflow catalogue and the engine name the four
 * execution-mode axes the same way, with one spelling of the unsharded
 * value. The catalogue's old names (timing / volume / partitioning) and
 * the `monolithic` spelling are retired; the engine's names
 * (delivery / concurrency / pacing / shape) and `monolith` are canonical
 * (user ruling, 2026-11-17).
 *
 * The pin refuses a silent divergence in three ways: the catalog's axis
 * keys must be exactly the engine's, each axis's value set must be
 * exactly the engine's, and the retired spelling must appear nowhere
 * in the catalog's modes — neither in the runtime values nor as a key
 * or value in the catalog module's source. The prose uses of
 * "monolithic" elsewhere (the monolithic path / run / scan) are a
 * different sense of the word and are out of scope here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_EXECUTION_MODE } from "../src/data/jobPipelinePorts";
import { WORKFLOW_CATALOG } from "../src/workflows/workflowCatalog";

const ENGINE_AXES = ["concurrency", "delivery", "pacing", "shape"] as const;
type EngineAxis = (typeof ENGINE_AXES)[number];

const ENGINE_VALUES: Record<EngineAxis, readonly string[]> = {
  delivery: ["sync", "async"],
  concurrency: ["sequential", "parallel"],
  pacing: ["batch", "online"],
  shape: ["monolith", "sharded"],
};

describe("mode axes: one naming, catalogue and engine (#4772)", () => {
  it("every catalog stage declares exactly the engine's four axes", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) {
        expect(Object.keys(stage.modes).sort()).toEqual([...ENGINE_AXES].sort());
      }
    }
  });

  it("every catalog axis carries exactly the engine's values", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) {
        for (const axis of ENGINE_AXES) {
          expect([...stage.modes[axis]].sort()).toEqual([...ENGINE_VALUES[axis]].sort());
        }
      }
    }
  });

  it("the engine default uses the canonical names and spelling", () => {
    expect(Object.keys(DEFAULT_JOB_EXECUTION_MODE).sort()).toEqual([...ENGINE_AXES].sort());
    expect(DEFAULT_JOB_EXECUTION_MODE.shape).toBe("monolith");
    expect(DEFAULT_JOB_EXECUTION_MODE.delivery).toBe("async");
    expect(DEFAULT_JOB_EXECUTION_MODE.pacing).toBe("batch");
    expect(DEFAULT_JOB_EXECUTION_MODE.concurrency).toBe("sequential");
  });

  it("the retired spelling appears nowhere in the catalog's modes", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) {
        expect(JSON.stringify(stage.modes)).not.toContain("monolithic");
      }
    }
    const catalogSource = readFileSync("src/workflows/workflowCatalog.ts", "utf8");
    expect(catalogSource).not.toContain('"monolithic"');
    expect(catalogSource).not.toMatch(/^\s*(timing|volume|partitioning)\s*:/m);
  });
});
