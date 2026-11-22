// @vitest-environment node
/**
 * Issue #5886 (#4437 slice 6d) — the market definition refuses a
 * goalScreen param by name.
 *
 * A goal run executes on the goalScreen definition (its analyze node
 * is the goal dispatch, screener.goal); the market definition's
 * generic nodes are market-only. Before 6d the generic compute
 * steps silently IGNORED a goalScreen param riding their params, so
 * a goal run mis-routed onto the market chain would run the market
 * screen, then reach the sink's goal path, which reads
 * payload.result.goalKind from a goal envelope the generic chain
 * never builds — a silent mis-route. Now every market-only generic
 * step refuses the param at its entry, before any fetch or compute,
 * and the spec-route binder (which already refused undeclared
 * params) is pinned for goalScreen on the "screener" spec, whose
 * declared parameters are universe + deliver only.
 */
import { describe, expect, it } from "vitest";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { bindJobDefinitionParams } from "../src/services/jobDefinitionParamBinders";
import {
  createBuiltinStepRegistry,
  GOAL_SCREEN_ON_MARKET_CHAIN,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import {
  createFeedStepRegistry,
  FEED_PULL_STEP,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import {
  registerEnrichStep,
  ENRICH_SCREENER_STEP,
  type EnrichStepDeps,
} from "../src/services/enrichPipelineJobs";
import {
  registerScreenerAnalyzeStep,
  ANALYZE_SCREENER_STEP,
  type AnalyzeStepDeps,
} from "../src/services/analyzePipelineJobs";
import {
  registerGenerateStep,
  GENERATE_APPLY_STEP,
  type GenerateStepDeps,
} from "../src/services/generatePipelineJobs";

const GOAL_SCREEN = {
  scenario: { goalKind: "growth", direction: "long" },
  scenarioSource: "built",
  symbols: ["AAPL"],
} as never;

function stepCtx(kind: string, params: Record<string, unknown>): JobStepContext {
  return {
    jobId: "refusal-5886",
    runId: "run-refusal-5886",
    nodePath: "",
    kind,
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params,
    input: {},
    now: "2026-11-21T00:00:00.000Z",
    trigger: "manual",
    runKind: "original",
  };
}

describe("market refusal of a goalScreen param (#5886)", () => {
  it.each([
    ["feed.pull", () => createFeedStepRegistry({} as unknown as FeedStepDeps).resolve(FEED_PULL_STEP)],
    [
      "enrich.screener",
      () => {
        const registry = createBuiltinStepRegistry();
        registerEnrichStep(registry, {} as unknown as EnrichStepDeps);
        return registry.resolve(ENRICH_SCREENER_STEP);
      },
    ],
    [
      "analyze.screener",
      () => {
        const registry = createBuiltinStepRegistry();
        registerScreenerAnalyzeStep(registry, {} as unknown as AnalyzeStepDeps);
        return registry.resolve(ANALYZE_SCREENER_STEP);
      },
    ],
    [
      "generate.apply",
      () => {
        const registry = createBuiltinStepRegistry();
        registerGenerateStep(registry, {} as unknown as GenerateStepDeps);
        return registry.resolve(GENERATE_APPLY_STEP);
      },
    ],
  ])("%s refuses a goalScreen param by name, before any work", async (_name, resolveStep) => {
    const handler = resolveStep();
    await expect(
      handler(stepCtx("feed", { userLogin: "tenant-1", goalScreen: GOAL_SCREEN })),
    ).rejects.toThrow(GOAL_SCREEN_ON_MARKET_CHAIN);
  });

  it.each([
    ["feed.pull", () => createFeedStepRegistry({} as unknown as FeedStepDeps).resolve(FEED_PULL_STEP)],
    [
      "enrich.screener",
      () => {
        const registry = createBuiltinStepRegistry();
        registerEnrichStep(registry, {} as unknown as EnrichStepDeps);
        return registry.resolve(ENRICH_SCREENER_STEP);
      },
    ],
    [
      "analyze.screener",
      () => {
        const registry = createBuiltinStepRegistry();
        registerScreenerAnalyzeStep(registry, {} as unknown as AnalyzeStepDeps);
        return registry.resolve(ANALYZE_SCREENER_STEP);
      },
    ],
    [
      "generate.apply",
      () => {
        const registry = createBuiltinStepRegistry();
        registerGenerateStep(registry, {} as unknown as GenerateStepDeps);
        return registry.resolve(GENERATE_APPLY_STEP);
      },
    ],
  ])("%s without a goalScreen param does not raise the refusal (control)", async (_name, resolveStep) => {
    const handler = resolveStep();
    let message = "";
    try {
      await handler(stepCtx("feed", { userLogin: "tenant-1" }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain(GOAL_SCREEN_ON_MARKET_CHAIN);
  });

  it("the spec-route binder refuses goalScreen on the screener spec", () => {
    expect(() =>
      bindJobDefinitionParams(jobDefinitionSpec("screener"), { goalScreen: GOAL_SCREEN }, "owner"),
    ).toThrow(/does not declare the parameter "goalScreen"/);
  });
});
