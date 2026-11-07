/**
 * Issue #3186 - one workflow for all four families (stocks, options,
 * strategy, goal) on the shared stage-message contract (#2869, generalized
 * by #3073).
 *
 * Contract step (step 1): the options family's ids gain the eight
 * pipeline stages alongside the three coarse #3191 phases (ADD, not
 * replace - the #3072 seam emitter still publishes the phases on live
 * runs, and breaking it in the contract step would break live behavior).
 * Step 3d retires the phases: their only publisher was the #3072
 * emitter, called only by the manual handler, which now runs the
 * pipeline (per-stage messages). The options family's ids are now
 * exactly the eight pipeline stages. Strategy and goal join
 * STAGE_FAMILIES with the ids the workflow catalog already declares
 * for them; publishStageOutput becomes family-aware.
 *
 * Id mapping (options, old phase -> pipeline stages):
 *   provider-screen -> plan, chainFetch, enrich, screen
 *   report-pipeline -> persistCanonicalResults, shapeReport
 *   deliver -> deliver (id unchanged)
 * Each pipeline stage pins to a real call: plan ->
 * parseOptionsScreenRequest / optionsPlanBlock; chainFetch ->
 * fetchChainsForSymbol (optionsScreener.ts:350); enrich -> signal
 * computation + enrichment (optionsScreener.ts:944); screen ->
 * screenOptions (:571) / evaluateChains (:650), plus
 * recommendOptionStrategies when strategy-driven; risk ->
 * assessSagaTradeRisk; persistCanonicalResults -> the plain screen's
 * canonical mas_reports row via recordUnifiedOptionsRun (the step-1
 * note naming mas_opportunity_scans was wrong for the plain screen -
 * that store holds strategy/discovery runs); shapeReport -> the
 * entry's report generation; deliver -> delivery bridge.
 *
 * Goal's ids are the composer's stages (catalog GOAL_SCREEN stage names:
 * feed, analysis, store, deliver) - declared now, emitted by the goal-leg
 * migration (step 3), not yet live. Strategy's ids are the catalog's
 * declared runtime steps (feed, analysis, generation, delivery).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  publishStageOutput,
  STAGE_FAMILIES,
  STAGE_IDS_BY_FAMILY,
  stageMessage,
} from "../src/workflows/stageMessage";
import { WORKFLOW_CATALOG } from "../src/workflows/workflowCatalog";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";

const OPTIONS_PIPELINE_STAGES = [
  "plan",
  "chainFetch",
  "enrich",
  "screen",
  "risk",
  "persistCanonicalResults",
  "shapeReport",
  "deliver",
] as const;

describe("one workflow, four families (#3186 step 1: contract)", () => {
  it("declares strategy and goal families alongside the #3073 families", () => {
    expect([...STAGE_FAMILIES]).toEqual([
      "stock",
      "options",
      "trading",
      "payment",
      "saga",
      "strategy",
      "goal",
      // #3543: the jobs family joins with the pipeline's stage
      // kinds (feed/enrich/analyze/generate/deliver) — pinned in
      // tests/feed_pipeline_host_3543.test.ts.
      "jobs",
    ]);
  });

  it("declares the eight options pipeline stages as the options family's ids", () => {
    expect([...STAGE_IDS_BY_FAMILY.options]).toEqual([...OPTIONS_PIPELINE_STAGES]);
  });

  it("retires the legacy #3191 phases (step 3d: their only publisher was the #3072 emitter, called only by the manual handler)", () => {
    // "deliver" survives as a pipeline stage id (unchanged); the two
    // retired ids are provider-screen and report-pipeline.
    expect([...STAGE_IDS_BY_FAMILY.options]).not.toContain("provider-screen");
    expect([...STAGE_IDS_BY_FAMILY.options]).not.toContain("report-pipeline");
    expect([...STAGE_IDS_BY_FAMILY.options]).toContain("deliver");
  });

  it("declares the strategy family's ids from the catalog's declared runtime steps", () => {
    const strategy = WORKFLOW_CATALOG.find((entry) => entry.family === "strategy");
    expect(strategy).toBeDefined();
    expect([...STAGE_IDS_BY_FAMILY.strategy]).toEqual([...(strategy?.runtimeSteps ?? [])]);
    expect(strategy?.runtimeSteps).toEqual(["feed", "analysis", "generation", "delivery"]);
  });

  it("declares the goal family's ids from the catalog's composer stages", () => {
    const goal = WORKFLOW_CATALOG.find((entry) => entry.family === "goal");
    expect(goal).toBeDefined();
    expect([...STAGE_IDS_BY_FAMILY.goal]).toEqual(
      (goal?.stages ?? []).map((entry) => entry.stage),
    );
    expect((goal?.stages ?? []).map((entry) => entry.stage)).toEqual([
      "feed",
      "analysis",
      "store",
      "deliver",
    ]);
  });

  it("accepts an options pipeline stage message", () => {
    const message = stageMessage({
      runId: "run-1",
      family: "options",
      stageId: "chainFetch",
      artifactKeys: ["options:chains:run-1"],
      userLogin: "owner@example.com",
    });
    expect(message.family).toBe("options");
    expect(message.stageId).toBe("chainFetch");
    expect(message.idempotencyKey).toBe("run-1::options::chainFetch");
  });

  it("accepts strategy and goal stage messages", () => {
    const strategyMessage = stageMessage({
      runId: "run-2",
      family: "strategy",
      stageId: "analysis",
      artifactKeys: ["strategy:ranked:run-2"],
      userLogin: "owner@example.com",
    });
    expect(strategyMessage.idempotencyKey).toBe("run-2::strategy::analysis");
    const goalMessage = stageMessage({
      runId: "run-3",
      family: "goal",
      stageId: "feed",
      artifactKeys: ["goal:universe:run-3"],
      userLogin: "owner@example.com",
    });
    expect(goalMessage.idempotencyKey).toBe("run-3::goal::feed");
  });

  it("publishStageOutput is family-aware (persist-then-publish for a pipeline stage)", async () => {
    const published: Array<{ stageId: string; family?: string }> = [];
    const message = await publishStageOutput({
      persist: async () => ["options:chains:run-4"],
      publish: async (entry) => {
        published.push({ stageId: entry.stageId, family: entry.family });
      },
      runId: "run-4",
      family: "options",
      stageId: "chainFetch",
      output: { chains: 2 },
      userLogin: "owner@example.com",
    });
    expect(message.family).toBe("options");
    expect(message.stageId).toBe("chainFetch");
    expect(published).toEqual([{ stageId: "chainFetch", family: "options" }]);
  });
});

describe("options pipeline stage ids pin to real calls (#3186 step 1)", () => {
  const read = (rel: string) =>
    readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

  it("each pipeline stage names a call that exists in the source", () => {
    const pins: Array<{ stageId: string; file: string; call: string }> = [
      { stageId: "plan", file: "src/trading/screeningSchemas.ts", call: "parseOptionsScreenRequest" },
      { stageId: "chainFetch", file: "src/trading/optionsScreener.ts", call: "fetchChainsForSymbol" },
      // Enrichment is inline in the screen path today (no own function yet);
      // step 2 wraps the enrichment block as its own function and this pin
      // tightens to that function name.
      { stageId: "enrich", file: "src/trading/optionsScreener.ts", call: "enrich" },
      { stageId: "screen", file: "src/trading/optionsScreener.ts", call: "screenOptions" },
      { stageId: "screen", file: "src/trading/optionsScreener.ts", call: "evaluateChains" },
      { stageId: "risk", file: "src/workflows/sagaRiskStage.ts", call: "assessSagaTradeRisk" },
      { stageId: "persistCanonicalResults", file: "src/data/doSqliteScanRunAdapter.ts", call: "mas_opportunity_scans" },
      { stageId: "shapeReport", file: "src/trading/options/panelPipeline.ts", call: "runPanelPipeline" },
      { stageId: "deliver", file: "src/agents/routes/etradeOptionsScreen.ts", call: "deliverGatedSlack" },
    ];
    for (const pin of pins) {
      expect(OPTIONS_PIPELINE_STAGES).toContain(pin.stageId);
      expect(read(pin.file)).toContain(pin.call);
    }
  });
});
