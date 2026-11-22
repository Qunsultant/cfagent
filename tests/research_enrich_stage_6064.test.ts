import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEnrichStage, runResearchPipeline, type PipelineDeps } from "../src/services/researchPipeline";
import type { ResearchConfig } from "../src/services/researchConfig";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import { clearResearchFeedHandoff, putResearchFeed, type ResearchFeedStageOutput } from "../src/services/researchFeedHandoff";
import { clearResearchEnrichHandoff, putResearchEnrich, type ResearchEnrichStageOutput } from "../src/services/researchEnrichHandoff";

const config: ResearchConfig = { ...RESEARCH_CONFIG_DEFAULTS, universe: "NASDAQ100" };
const technicals = { trend: "up" as const, rsi: 55, momentum: 1, notes: [], asOf: Date.now() };

function feed(): ResearchFeedStageOutput {
  return {
    runId: "run-enrich-1",
    asOf: "2026-11-22T00:00:00.000Z",
    regime: { regime: "bull", notes: [], asOf: Date.now() },
    universe: "NASDAQ100",
    universeError: null,
    symbols: ["AAA", "BBB"],
    quotes: [
      { symbol: "AAA", quote: { price: 100, isEtf: false, marketCap: 1e12 } },
      { symbol: "BBB", quote: null },
    ],
    universeSize: 2,
    quotesRetrieved: 1,
  };
}

function provider(over: Record<string, unknown> = {}) {
  return {
    getRegime: vi.fn(async () => ({ regime: "bull", notes: [], asOf: Date.now() })),
    getUniverseSymbols: vi.fn(async () => ["AAA", "BBB"]),
    getQuote: vi.fn(async () => ({ price: 100, isEtf: false, marketCap: 1e12 })),
    getTechnicals: vi.fn(async () => technicals),
    getCatalysts: vi.fn(async () => []),
    getChain: vi.fn(async () => {
      throw new Error("chain must not be fetched");
    }),
    ...over,
  } as unknown as PipelineDeps["provider"];
}

const baseOpts = { trigger: "manual" as const, userLogin: "owner@example.com", runId: "run-enrich-1" };

describe("issue #6064 — the enrich stage", () => {
  beforeEach(() => {
    clearResearchFeedHandoff();
    clearResearchEnrichHandoff();
  });

  it("fetches technicals and catalysts once per quoted symbol", async () => {
    const p = provider();
    const output = await runEnrichStage({ provider: p }, config, feed(), baseOpts);
    expect(p.getTechnicals).toHaveBeenCalledTimes(1);
    expect(p.getCatalysts).toHaveBeenCalledTimes(1);
    expect(Object.keys(output.bySymbol)).toEqual(["AAA"]);
    expect(output.bySymbol.AAA.technicals).toBe(technicals);
  });

  it("a supplied enrich output means analyze never re-fetches technicals or catalysts", async () => {
    const p = provider({
      getTechnicals: vi.fn(async () => {
        throw new Error("technicals must not be fetched");
      }),
      getCatalysts: vi.fn(async () => {
        throw new Error("catalysts must not be fetched");
      }),
    });
    const enrich: ResearchEnrichStageOutput = {
      runId: "run-enrich-1",
      asOf: "2026-11-22T00:00:01.000Z",
      bySymbol: { AAA: { technicals, catalysts: [] } },
    };
    const report = await runResearchPipeline({ provider: p }, config, {
      ...baseOpts,
      feed: feed(),
      enrich,
    });
    expect(p.getTechnicals).not.toHaveBeenCalled();
    expect(p.getCatalysts).not.toHaveBeenCalled();
    expect(report.stats.quotesRetrieved).toBe(1);
  });

  it("runs as the research.enrich engine step and hands the output to analyze", async () => {
    const { createBuiltinStepRegistry } = await import("../src/services/jobPipelineSteps");
    const { registerResearchSteps } = await import("../src/services/researchPipelineJobs");
    const runOodaAnalysis = vi.fn(async () => ({ runId: "run-enrich-1" }));
    const registry = registerResearchSteps(createBuiltinStepRegistry(), {
      runFeedStage: async () => feed(),
      runEnrichStage: async () => ({
        runId: "run-enrich-1",
        asOf: "2026-11-22T00:00:01.000Z",
        bySymbol: { AAA: { technicals, catalysts: [] } },
      }),
      runOodaAnalysis,
    });
    const feedStep = registry.resolve("research.feed");
    const feedResult = await feedStep({
      jobId: "research:run-enrich-1",
      runId: "run-enrich-1",
      nodePath: "",
      kind: "feed",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { runId: "run-enrich-1", userLogin: "owner@example.com", trigger: "manual" },
      input: null,
      now: "2026-11-22T00:00:00.000Z",
      trigger: "manual",
      runKind: "original",
    } as never);
    const enrichStep = registry.resolve("research.enrich");
    const enrichResult = await enrichStep({
      jobId: "research:run-enrich-1",
      runId: "run-enrich-1",
      nodePath: "",
      kind: "enrich",
      stepIndex: 1,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { runId: "run-enrich-1", userLogin: "owner@example.com", trigger: "manual" },
      input: feedResult.output,
      now: "2026-11-22T00:00:01.000Z",
      trigger: "manual",
      runKind: "original",
    } as never);
    const analyzeStep = registry.resolve("analyze.ooda");
    await analyzeStep({
      jobId: "research:run-enrich-1",
      runId: "run-enrich-1",
      nodePath: "",
      kind: "analyze",
      stepIndex: 2,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { runId: "run-enrich-1", userLogin: "owner@example.com", trigger: "manual" },
      input: enrichResult.output,
      now: "2026-11-22T00:00:02.000Z",
      trigger: "manual",
      runKind: "original",
    } as never);
    expect(runOodaAnalysis).toHaveBeenCalledTimes(1);
    expect(runOodaAnalysis.mock.calls[0][0]).toMatchObject({ enrich: enrichResult.output });
  });
});
