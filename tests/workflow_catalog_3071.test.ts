/**
 * Issue #3071 (#3069 S1) — pins for the workflow catalog: what can be run,
 * what each stage is, and what the declaration refuses to be.
 */
import { describe, expect, it } from "vitest";
import { STAGE_NAMES } from "../src/messaging/messagingPorts";
import {
  WORKFLOW_CATALOG,
  assertWorkflowCatalog,
  listWorkflows,
  workflowById,
  type WorkflowDeclaration,
} from "../src/workflows/workflowCatalog";

const stock = () => workflowById("stock-screener")!;

describe("the catalog declares what can be run (#3071)", () => {
  it("is valid and lists every workflow by id", () => {
    expect(() => assertWorkflowCatalog()).not.toThrow();
    expect(listWorkflows().map((w) => w.id)).toEqual(
      [...WORKFLOW_CATALOG].map((w) => w.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

  it("the stock screener declares its six stages in canonical order", () => {
    expect(stock().stages.map((s) => s.stage)).toEqual([
      "feed",
      "gather",
      "analysis",
      "store",
      "serve",
      "deliver",
    ]);
    expect(stock().runnable).toBe(true);
  });

  it("every stage declares all four mode axes (#3069 R3)", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) {
        expect(stage.modes.timing.length).toBeGreaterThan(0);
        expect(stage.modes.concurrency.length).toBeGreaterThan(0);
        expect(stage.modes.volume.length).toBeGreaterThan(0);
        expect(stage.modes.partitioning.length).toBeGreaterThan(0);
      }
    }
  });

  it("every stage checkpoints and names what it persists and publishes (#3069 R1/R4)", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) {
        expect(stage.checkpointed).toBe(true);
        expect(stage.persists.trim().length).toBeGreaterThan(0);
        // Issue #3174/#3072/#3073: topics exist only where the seam is wired,
        // and a wired stage publishes exactly the steps it executes.
        if (workflow.stageSeam) {
          expect(stage.publishes.length).toBeGreaterThan(0);
          expect(stage.publishes).toEqual(stage.runtimeStageIds ?? []);
        } else {
          expect(stage.publishes).toEqual([]);
        }
      }
    }
  });

  it("the pipeline is a producer→consumer chain: each stage consumes the previous one's output", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      expect(workflow.stages[0]!.consumes).toBeNull();
      for (let i = 1; i < workflow.stages.length; i += 1) {
        expect(workflow.stages[i]!.consumes).toBe(workflow.stages[i - 1]!.persists);
      }
    }
  });

  it("carries the approval gate on the consequential leg (#3073 preview)", () => {
    const trading = workflowById("trading-leg")!;
    const store = trading.stages.find((s) => s.stage === "store")!;
    expect(store.requiresApproval).toBe(true);
    expect(trading.runnable).toBe(false);
  });
});

describe("the catalog refuses a half-declared workflow (#3071)", () => {
  const bad = (over: Partial<WorkflowDeclaration>): WorkflowDeclaration =>
    ({ ...stock(), id: "bad", ...over }) as WorkflowDeclaration;

  it("refuses a duplicate id", () => {
    expect(() => assertWorkflowCatalog([stock(), stock()])).toThrow(/duplicate/i);
  });

  it("refuses an empty stage list", () => {
    expect(() => assertWorkflowCatalog([bad({ stages: [] })])).toThrow(/no stages/i);
  });

  it("refuses stages out of canonical order", () => {
    const reversed = [...stock().stages].reverse();
    expect(() => assertWorkflowCatalog([bad({ stages: reversed })])).toThrow(/order/i);
  });

  it("refuses a stage missing a mode axis", () => {
    const broken = stock().stages.map((s, i) =>
      i === 0 ? { ...s, modes: { ...s.modes, volume: [] as never[] } } : s,
    );
    expect(() => assertWorkflowCatalog([bad({ stages: broken as never })])).toThrow(/volume/i);
  });

  it("refuses an undeclared stage name", () => {
    const broken = stock().stages.map((s, i) => (i === 0 ? { ...s, stage: "nope" as never } : s));
    expect(() => assertWorkflowCatalog([bad({ stages: broken as never })])).toThrow(/unknown stage/i);
  });

  it("keeps every declared stage id inside the shared StageName vocabulary", () => {
    for (const workflow of WORKFLOW_CATALOG) {
      for (const stage of workflow.stages) expect(STAGE_NAMES).toContain(stage.stage);
    }
  });
});
