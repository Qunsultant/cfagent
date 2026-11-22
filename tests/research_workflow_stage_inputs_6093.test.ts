import { describe, expect, it, vi } from "vitest";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { registerResearchSteps } from "../src/services/researchPipelineJobs";
import type { ResearchFeedStageOutput } from "../src/services/researchFeedHandoff";
import type { ResearchEnrichStageOutput } from "../src/services/researchEnrichHandoff";
import { createWorkflowResearchStepDeps } from "../src/workflows/researchWorkflowStageDeps";
import type { Env } from "../src/types";

function ctx(over: Record<string, unknown>) {
  return {
    jobId: "research:run-6093",
    runId: "run-6093",
    nodePath: "",
    kind: "enrich",
    stepIndex: 1,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: { runId: "run-6093", userLogin: "owner@example.com", trigger: "manual" },
    input: null,
    now: "2026-11-22T00:00:00.000Z",
    trigger: "manual",
    runKind: "original",
    ...over,
  } as never;
}

const feed: ResearchFeedStageOutput = {
  runId: "run-6093",
  asOf: "2026-11-22T00:00:00.000Z",
  regime: { regime: "bull", notes: [], asOf: Date.now() },
  universe: "NASDAQ100",
  universeError: null,
  symbols: ["AAA"],
  quotes: [{ symbol: "AAA", quote: { price: 100 } }],
  universeSize: 1,
  quotesRetrieved: 1,
};

const enrich: ResearchEnrichStageOutput = {
  runId: "run-6093",
  asOf: "2026-11-22T00:00:01.000Z",
  feed,
  bySymbol: { AAA: { technicals: null, catalysts: null } },
};

describe("issues #6092/#6093 — durable workflow stage inputs", () => {
  it("the enrich step hands its feed output forward", async () => {
    const registry = registerResearchSteps(createBuiltinStepRegistry(), {
      runOodaAnalysis: vi.fn(),
      runEnrichStage: async () => enrich,
    });
    const result = await registry.resolve("research.enrich")(ctx({ input: feed }));
    expect((result.output as ResearchEnrichStageOutput).feed).toBe(feed);
  });

  it("workflow mode refuses analyze without the persisted feed/enrich outputs", async () => {
    const runOodaAnalysis = vi.fn();
    const registry = registerResearchSteps(createBuiltinStepRegistry(), {
      requireStageInputs: true,
      runOodaAnalysis,
    });
    await expect(registry.resolve("analyze.ooda")(ctx({ input: null, kind: "analysis" }))).rejects.toThrow(
      "research_stage_input_missing",
    );
    expect(runOodaAnalysis).not.toHaveBeenCalled();
  });

  it("workflow mode passes the persisted feed and enrich outputs into the run", async () => {
    const runOodaAnalysis = vi.fn(async () => ({ runId: "run-6093", ideas: [] }));
    const registry = registerResearchSteps(createBuiltinStepRegistry(), {
      requireStageInputs: true,
      runOodaAnalysis,
    });
    await registry.resolve("analyze.ooda")(ctx({ input: enrich, kind: "analysis" }));
    expect(runOodaAnalysis.mock.calls[0][0]).toMatchObject({ feed, enrich });
  });

  it("the workflow deps builder composes every stage through the orchestrator door", async () => {
    const door = {
      runResearchStage: vi.fn(async () => feed),
      runResearchEvaluate: vi.fn(async () => null),
      runResearchAndPublish: vi.fn(async () => ({ success: true, report: { runId: "run-6093", ideas: [] } })),
    };
    const env = {
      ORCHESTRATOR_AGENT: {
        idFromName: () => "id",
        get: () => door,
      },
    } as unknown as Env;
    const deps = createWorkflowResearchStepDeps(env);
    expect(deps.requireStageInputs).toBe(true);
    const fed = await deps.runFeedStage!({
      runId: "run-6093",
      userLogin: "owner@example.com",
      trigger: "manual",
    });
    expect(fed).toBe(feed);
    expect(door.runResearchStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "feed", runId: "run-6093" }),
    );
    const enriched = await deps.runEnrichStage!({
      runId: "run-6093",
      userLogin: "owner@example.com",
      trigger: "manual",
      feed,
    });
    expect(enriched).toBe(feed);
    expect(door.runResearchStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "enrich", feed }),
    );
  });
});
