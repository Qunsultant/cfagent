/**
 * Issue #4067 — the options stage vocabulary, pinned: the 8 execution
 * stages are the vocabulary the control plane addresses; the 4 display
 * stages are presentation only, never control addresses - except
 * "deliver", the one id shared with execution stage 8. The catalog's
 * options entry partitions the 8 under the 4; a display-only stage id
 * (feed/store/serve) is refused by stageMessage() for the options
 * family, exactly as the retired #3191 phases are. The stale stage
 * mappings (#3186's comment block) are gone from the workflow files.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OPTIONS_ADDRESSABLE_STAGES,
  OPTIONS_DISPLAY_STAGES,
  OPTIONS_PIPELINE_STAGES,
} from "../src/workflows/stageRuntimeIds";
import { WORKFLOW_CATALOG } from "../src/workflows/workflowCatalog";
import { stageMessage } from "../src/workflows/stageMessage";

const EIGHT = [
  "plan",
  "chainFetch",
  "enrich",
  "screen",
  "risk",
  "persistCanonicalResults",
  "shapeReport",
  "deliver",
] as const;
const FOUR = ["feed", "store", "serve", "deliver"] as const;

describe("options stage vocabulary (#4067)", () => {
  it("pins the 8 execution stages, in pipeline order", () => {
    expect([...OPTIONS_PIPELINE_STAGES]).toEqual([...EIGHT]);
  });

  it("the addressable vocabulary is the 8 execution stages", () => {
    expect([...OPTIONS_ADDRESSABLE_STAGES]).toEqual([...OPTIONS_PIPELINE_STAGES]);
  });

  it("the display stages are exactly the 4", () => {
    expect([...OPTIONS_DISPLAY_STAGES]).toEqual([...FOUR]);
  });

  it("feed, store and serve are display-only; deliver is the one shared id", () => {
    // "deliver" is both the display stage and execution stage 8, so
    // it IS addressable as the execution stage. The other three
    // display ids have no execution-stage counterpart.
    const displayOnly = OPTIONS_DISPLAY_STAGES.filter(
      (display) => !(OPTIONS_PIPELINE_STAGES as readonly string[]).includes(display),
    );
    expect([...displayOnly]).toEqual(["feed", "store", "serve"]);
    for (const display of displayOnly) {
      expect(OPTIONS_ADDRESSABLE_STAGES).not.toContain(display);
    }
    expect(OPTIONS_ADDRESSABLE_STAGES).toContain("deliver");
  });

  it("the catalog's options entry partitions the 8 under the 4 display stages", () => {
    const entry = WORKFLOW_CATALOG.find((e) => e.id === "options-screener");
    expect(entry).toBeDefined();
    expect([...(entry?.runtimeSteps ?? [])]).toEqual([...EIGHT]);
    expect((entry?.stages ?? []).map((s) => s.stage)).toEqual([...FOUR]);
    const partitioned = (entry?.stages ?? []).flatMap((s) => [...(s.runtimeStageIds ?? [])]);
    expect(partitioned).toEqual([...EIGHT]);
    // Each execution stage under exactly one display stage.
    expect(new Set(partitioned).size).toBe(partitioned.length);
  });

  it("stageMessage accepts every execution stage for the options family", () => {
    for (const stageId of OPTIONS_PIPELINE_STAGES) {
      const message = stageMessage({
        runId: "run-4067",
        family: "options",
        stageId,
        artifactKeys: [`options:artifact:run-4067:${stageId}`],
        userLogin: "owner@example.com",
      });
      expect(message.stageId).toBe(stageId);
    }
  });

  it("stageMessage refuses the display-only stages for the options family", () => {
    for (const display of ["feed", "store", "serve"]) {
      expect(() =>
        stageMessage({
          runId: "run-4067",
          family: "options",
          stageId: display,
          artifactKeys: ["options:artifact:run-4067"],
          userLogin: "owner@example.com",
        }),
      ).toThrow(/not a declared options stage id/);
    }
    // "deliver" is accepted - as execution stage 8, not as a display id.
    const message = stageMessage({
      runId: "run-4067",
      family: "options",
      stageId: "deliver",
      artifactKeys: ["options:artifact:run-4067:deliver"],
      userLogin: "owner@example.com",
    });
    expect(message.stageId).toBe("deliver");
  });

  it("no stale stage mapping remains in stageRuntimeIds.ts", () => {
    const source = readFileSync(
      new URL("../src/workflows/stageRuntimeIds.ts", import.meta.url),
      "utf8",
    );
    // The #3186 mappings are gone: persistCanonicalResults never
    // wrote mas_opportunity_scans, shapeReport never called
    // runPanelPipeline, deliver never called deliverScreenerToSlackA2A.
    // (The corrected comment still names mas_opportunity_scans once,
    // to say it belongs to the scanner/strategy leg - so the pin
    // asserts the mapping phrase, not the bare store name.)
    expect(source).not.toContain("mas_opportunity_scans write");
    expect(source).not.toContain("shapeReport -> runPanelPipeline");
    expect(source).not.toContain("deliver -> deliverScreenerToSlackA2A");
    expect(source).not.toContain("runPanelPipeline");
    expect(source).not.toContain("deliverScreenerToSlackA2A");
    // The corrected mapping names the true persist call and store.
    expect(source).toContain("recordUnifiedOptionsRun");
    expect(source).toContain("mas_reports");
  });
});
