/**
 * Issue #3191 - the options + trading half of the runtime-id mapping pins.
 *
 * Trading: exactly two durable steps exist (`await-approval`, `settle-trade`);
 * the constant must equal what the flow source actually contains, and the
 * catalog must be an exact partition of it.
 *
 * Options: there is no durable workflow - the request handler IS the runtime -
 * so each declared phase must still correspond to a real call in that file.
 * A phase whose call disappears fails here rather than lingering in the page.
 * (Retired by #3186 step 3d: the manual handler now runs the one options
 * pipeline, so the phases' calls moved to the pipeline modules and the
 * phases retired from the options family - the pin below records that.)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPTIONS_PIPELINE_STAGES, TRADE_APPROVAL_STEP_IDS } from "../src/workflows/stageRuntimeIds";
import { STAGE_IDS_BY_FAMILY } from "../src/workflows/stageMessage";
import { workflowById } from "../src/workflows/workflowCatalog";

const read = (path: string) => readFileSync(path, "utf8");

describe("trading leg runtime ids (#3191)", () => {
  const source = read("src/agents/trading-trade-workflow.ts");

  it("declares exactly the durable steps the flow contains", () => {
    const waits = [...source.matchAll(/step\.waitForEvent\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    const dos = [...source.matchAll(/step\.do\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect([...waits, ...dos].sort()).toEqual([...TRADE_APPROVAL_STEP_IDS].sort());
  });

  it("invents no fill or reconcile step", () => {
    expect(source).not.toMatch(/step\.do\(\s*"(fill|reconcile)/);
    expect([...TRADE_APPROVAL_STEP_IDS]).not.toContain("fill");
    expect([...TRADE_APPROVAL_STEP_IDS]).not.toContain("reconcile");
  });

  it("the catalog declares an exact partition of them", () => {
    const declared = workflowById("trading-leg")!.stages.flatMap((s) => s.runtimeStageIds ?? []);
    expect([...declared].sort()).toEqual([...TRADE_APPROVAL_STEP_IDS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("keeps the approval gate on the stage that waits for it", () => {
    const workflow = workflowById("trading-leg")!;
    const waiting = workflow.stages.find((s) => (s.runtimeStageIds ?? []).includes("await-approval"));
    expect(waiting?.requiresApproval).toBe(true);
  });
});

describe("options screen phases (#3191, retired by #3186 step 3d)", () => {
  const handler = read("src/agents/routes/etradeOptionsScreen.ts");
  const ports = read("src/workflows/optionsScreenPorts.ts");
  const manual = read("src/workflows/manualOptionsScreen.ts");

  it("the manual handler is no longer the runtime - the pipeline is", () => {
    // executeUnifiedOptions (the unmigrated second handler in the same
    // file) still generates its own report, so scope the assertion to
    // the executeOptionsScreen section.
    const manualSection = handler.slice(0, handler.indexOf("executeUnifiedOptions"));
    expect(manualSection).not.toMatch(/provider\.screen\(/);
    expect(manualSection).not.toMatch(/runReportPipeline\(/);
    // The calls moved, they did not disappear: the screen stage
    // evaluates chains in the ports module, the manual shapeReport
    // stage generates the report.
    expect(ports).toMatch(/aggregateScreenResult\(/);
    expect(manual).toMatch(/runReportPipeline\(/);
  });

  it("the legacy phases are retired from the options family", () => {
    expect([...STAGE_IDS_BY_FAMILY.options]).toEqual([...OPTIONS_PIPELINE_STAGES]);
    expect([...STAGE_IDS_BY_FAMILY.options]).not.toContain("provider-screen");
    expect([...STAGE_IDS_BY_FAMILY.options]).not.toContain("report-pipeline");
  });

  it("declares no step ids, because the pipeline is not a step.do workflow", () => {
    expect(handler).not.toMatch(/step\.do\(/);
    expect(workflowById("options-screener")!.runtimeMappingGap).toBeUndefined();
  });

  it("the catalog declares an exact partition of the pipeline stages", () => {
    const declared = workflowById("options-screener")!.stages.flatMap((s) => s.runtimeStageIds ?? []);
    expect([...declared].sort()).toEqual([...OPTIONS_PIPELINE_STAGES].sort());
  });
});

describe("the catalog stays importable from the browser (#3191)", () => {
  it("its ids come from a dependency-free module, never from a server flow", () => {
    const catalog = readFileSync("src/workflows/workflowCatalog.ts", "utf8");
    // A server import here pulls the agents SDK (`cloudflare:workers`) into the
    // client bundle and breaks the frontend build - it did, once.
    expect(catalog).not.toMatch(/from "\.\.\/agents\//);
    expect(catalog).not.toMatch(/from "\.\/(paymentWorkflowFlow|sagaWorkflowFlow)"/);
    const shared = readFileSync("src/workflows/stageRuntimeIds.ts", "utf8");
    expect(shared).not.toMatch(/^import /m);
  });
});

describe("no family is left without either ids or a named gap (#3191)", () => {
  it("every family is mapped or says why not", () => {
    for (const id of ["stock-screener", "options-screener", "trading-leg", "payment-run", "saga-run"]) {
      const workflow = workflowById(id)!;
      const ids = workflow.stages.flatMap((s) => s.runtimeStageIds ?? []);
      expect(ids.length).toBeGreaterThan(0);
      expect(workflow.runtimeMappingGap).toBeUndefined();
    }
    for (const id of ["goal-screen", "strategy-discovery"]) {
      expect((workflowById(id)!.runtimeMappingGap ?? "").trim().length).toBeGreaterThan(10);
    }
  });
});
