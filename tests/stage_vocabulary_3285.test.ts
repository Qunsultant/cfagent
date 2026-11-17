// @vitest-environment node
/**
 * Issue #3285 ([#3186 follow-up]) — one stage vocabulary, and a gap that names
 * its owner and its reason.
 *
 * The issue was filed against two disagreeing vocabularies: the API's stage ids
 * vs the Docs dialog's, with `not_implemented` on one surface and `unknown` on
 * the other, and a "no path" stage that carried neither owner nor reason. Since
 * then the contract (#2869/#3186), the catalog (#3166/#3174) and the families'
 * addressable vocabularies (#4067/#4272) landed, so the pins below hold the
 * RESULT rather than re-litigating the migration:
 *
 *  - 3285-P01 the display vocabulary IS the contract vocabulary — no third list.
 *  - 3285-P02 the status disagreement cannot recur: the retired literals are
 *    absent from the stage surfaces, and the unit status set is the contract's.
 *  - 3285-P03 an unmapped family must name its gap, and the gap must carry an
 *    owner (#NNNN) and a reason; a mapped family must not declare a gap.
 *  - 3285-P04 today's catalog satisfies that rule — every unmapped family names
 *    who owns it and why.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertWorkflowCatalog,
  STAGE_LABELS,
  WORKFLOW_CATALOG,
  type WorkflowDeclaration,
} from "../src/workflows/workflowCatalog";
import { STAGE_NAMES } from "../src/messaging/messagingPorts";
import {
  OPTIONS_ADDRESSABLE_STAGES,
  OPTIONS_DISPLAY_STAGES,
  STRATEGY_ADDRESSABLE_STAGES,
} from "../src/workflows/stageRuntimeIds";

function baseWorkflow(over: Partial<WorkflowDeclaration> = {}): WorkflowDeclaration {
  return {
    id: "probe",
    family: "stock",
    labelKey: "workflow.probe",
    label: "Probe",
    stageSeam: false,
    runtimeSteps: [],
    runnable: false,
    runPath: null,
    stages: [
      {
        stage: "feed",
        label: "Feed",
        persists: "quotes",
        publishes: [],
        consumesStageMessage: null,
        consumes: null,
        modes: {
          delivery: ["immediate"],
          concurrency: ["sequential"],
          pacing: ["batch"],
          shape: ["none"],
        },
        retryBucket: "acquisition",
        checkpointed: true,
        requiresApproval: false,
      },
    ],
    ...over,
  };
}

describe("3285-P01 one vocabulary, not three", () => {
  it("the display stages are exactly the contract's stage names", () => {
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...STAGE_NAMES].sort());
  });

  it("the options display stages are a real partition of its addressable stages", () => {
    for (const display of OPTIONS_DISPLAY_STAGES) {
      expect(STAGE_NAMES as readonly string[]).toContain(display);
    }
    expect(OPTIONS_ADDRESSABLE_STAGES).not.toEqual(OPTIONS_DISPLAY_STAGES);
  });

  it("the strategy vocabulary is the options vocabulary, by design", () => {
    expect(STRATEGY_ADDRESSABLE_STAGES).toBe(OPTIONS_ADDRESSABLE_STAGES);
  });
});

describe("3285-P02 the status disagreement cannot recur", () => {
  const stageSurfaces = [
    "src/workflows/stageRunnerPorts.ts",
    "src/workflows/workflowCatalog.ts",
    "src/services/jobPipelineEngine.ts",
    "src/services/workflowRuns.ts",
  ].map((path) => readFileSync(path, "utf8"));

  it("no stage surface carries the retired not_implemented stage state", () => {
    for (const [index, source] of stageSurfaces.entries()) {
      expect(source, `surface ${index}`).not.toContain("not_implemented");
      // "unknown" is only legitimate as a TRIGGER fallback label
      // ("Not recorded"), never as a stage or unit status: the status union
      // below is closed, so a stage cannot be "unknown".
      const unitStatus = source.match(/export type StageUnitStatus =[^;]+;/)?.[0] ?? "";
      if (unitStatus) expect(unitStatus).not.toMatch(/"unknown"/);
    }
  });

  it("the unit status vocabulary is the contract's, extended only by terminal verbs", () => {
    const source = stageSurfaces[0];
    expect(source).toContain("export type StageUnitStatus");
    expect(source).toContain('"never-attempted"');
    expect(source).toContain('"timed_out"');
  });
});

describe("3285-P03 an unmapped family must name its owner and its reason", () => {
  it("refuses an unmapped family with no gap note", () => {
    expect(() => assertWorkflowCatalog([baseWorkflow()])).toThrow(
      /maps no runtime stage ids and names no runtimeMappingGap/,
    );
  });

  it("refuses a gap note that names no owning issue", () => {
    expect(() =>
      assertWorkflowCatalog([
        baseWorkflow({ runtimeMappingGap: "not mapped to the runtime yet, details later" }),
      ]),
    ).toThrow(/names no owning issue/);
  });

  it("refuses a gap note that states no reason beyond its issue number", () => {
    expect(() =>
      assertWorkflowCatalog([baseWorkflow({ runtimeMappingGap: "#3072" })]),
    ).toThrow(/states no reason/);
  });

  it("refuses a mapped family that also declares a gap", () => {
    const mapped = baseWorkflow();
    mapped.stages = [{ ...mapped.stages[0], runtimeStageIds: ["plan"] }];
    expect(() =>
      assertWorkflowCatalog([
        { ...mapped, runtimeMappingGap: "#3072 this family maps its ids, so a gap is wrong here." },
      ]),
    ).toThrow(/both maps runtime stage ids and declares a runtimeMappingGap/);
  });
});

describe("3285-P04 today's catalog names who owns each gap, and why", () => {
  it("passes its own validator", () => {
    expect(() => assertWorkflowCatalog(WORKFLOW_CATALOG)).not.toThrow();
  });

  it("every unmapped family carries an owner reference and a reason", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      const mapped = workflow.stages.some((stage) => (stage.runtimeStageIds ?? []).length > 0);
      if (mapped) continue;
      const gap = workflow.runtimeMappingGap ?? "";
      expect(gap, `${workflow.id} gap`).toMatch(/#\d+/);
      expect(gap.replace(/#\d+/g, "").trim().length, `${workflow.id} reason`).toBeGreaterThanOrEqual(20);
    }
  });
});
