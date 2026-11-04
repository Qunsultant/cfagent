/**
 * Issue #3166 - the anti-drift pin: the catalog's stock declaration must be a
 * PARTITION of the runtime's own stage ids. If the runtime adds, renames or
 * drops a stage id, this fails; if the catalog invents one, it fails too.
 *
 * That is the difference between a document and a contract: the first version
 * of this page declared six invented topic names and nothing noticed.
 */
import { describe, expect, it } from "vitest";
import { STOCK_STAGE_IDS } from "../src/workflows/stageMessage";
import {
  WORKFLOW_CATALOG,
  assertWorkflowCatalog,
  workflowById,
} from "../src/workflows/workflowCatalog";

const stock = () => workflowById("stock-screener")!;

describe("catalog <-> runtime stage parity (#3166)", () => {
  it("every runtime stock stage id is assigned to exactly one declared stage", () => {
    const declared = stock().stages.flatMap((stage) => stage.runtimeStageIds ?? []);
    expect([...declared].sort()).toEqual([...STOCK_STAGE_IDS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("every declared publish name is a real runtime stage id", () => {
    for (const stage of stock().stages) {
      expect(STOCK_STAGE_IDS).toContain(stage.publishes);
    }
  });

  it("the declaration covers the pipeline in order (no runtime id out of place)", () => {
    const declared = stock().stages.flatMap((stage) => stage.runtimeStageIds ?? []);
    // the runtime ids must appear in the same relative order as the runtime's
    // own list, so a reordering of the pipeline cannot pass silently
    const runtimeOrder = declared.map((id) => STOCK_STAGE_IDS.indexOf(id as never));
    expect([...runtimeOrder].sort((a, b) => a - b)).toEqual(runtimeOrder);
  });

  it("families that are not mapped say so instead of implying coverage", () => {
    const options = workflowById("options-screener")!;
    const trading = workflowById("trading-leg")!;
    expect(options.stages.every((s) => s.runtimeStageIds === undefined)).toBe(true);
    expect(trading.stages.every((s) => s.runtimeStageIds === undefined)).toBe(true);
  });

  it("refuses the same runtime id assigned to two stages", () => {
    const broken = stock().stages.map((stage, index) =>
      index === 1 ? { ...stage, runtimeStageIds: ["plan"] } : stage,
    );
    expect(() =>
      assertWorkflowCatalog([{ ...stock(), id: "broken", stages: broken as never }]),
    ).toThrow(/two stages/i);
  });

  it("keeps the catalog valid as declared", () => {
    expect(() => assertWorkflowCatalog(WORKFLOW_CATALOG)).not.toThrow();
  });
});
