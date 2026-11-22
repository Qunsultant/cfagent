import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runFeedStage,
  runResearchPipeline,
  type PipelineDeps,
} from "../src/services/researchPipeline";
import {
  clearResearchFeedHandoff,
  putResearchFeed,
  type ResearchFeedStageOutput,
} from "../src/services/researchFeedHandoff";
import type { ResearchConfig } from "../src/services/researchConfig";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";

const config: ResearchConfig = { ...RESEARCH_CONFIG_DEFAULTS, universe: "NASDAQ100" };

function quote(symbol: string) {
  return {
    symbol,
    price: 100,
    isEtf: false,
    marketCap: 1_000_000_000_000,
    timestamp: "2026-11-22T00:00:00.000Z",
    quoteStatus: "live",
    source: "test",
  };
}

function provider(over: Record<string, unknown> = {}) {
  return {
    getRegime: vi.fn(async () => ({ regime: "bull", notes: [], asOf: Date.now() })),
    getUniverseSymbols: vi.fn(async () => ["AAA", "BBB"]),
    getQuote: vi.fn(async (symbol: string) => (symbol === "AAA" ? quote(symbol) : null)),
    getTechnicals: vi.fn(async () => null),
    getCatalysts: vi.fn(async () => null),
    getChain: vi.fn(async () => {
      throw new Error("chain must not be fetched");
    }),
    ...over,
  } as unknown as PipelineDeps["provider"];
}

function deps(p: PipelineDeps["provider"]): PipelineDeps {
  return { provider: p };
}

function feed(over: Partial<ResearchFeedStageOutput> = {}): ResearchFeedStageOutput {
  return {
    runId: "run-feed-1",
    asOf: "2026-11-22T00:00:00.000Z",
    regime: { regime: "bull", notes: [], asOf: Date.now() },
    universe: "NASDAQ100",
    universeError: null,
    symbols: ["AAA", "BBB"],
    quotes: [
      { symbol: "AAA", quote: quote("AAA") },
      { symbol: "BBB", quote: null },
    ],
    universeSize: 2,
    quotesRetrieved: 1,
    ...over,
  };
}

const baseOpts = { trigger: "manual" as const, userLogin: "owner@example.com", runId: "run-feed-1" };

describe("issue #6063 — the feed stage", () => {
  beforeEach(() => clearResearchFeedHandoff());

  it("fetches regime, universe and quotes once and reports the real counts", async () => {
    const p = provider();
    const output = await runFeedStage(deps(p), config, baseOpts);
    expect(p.getRegime).toHaveBeenCalledTimes(1);
    expect(p.getUniverseSymbols).toHaveBeenCalledTimes(1);
    expect(p.getQuote).toHaveBeenCalledTimes(2);
    expect(output.universeSize).toBe(2);
    expect(output.quotesRetrieved).toBe(1);
    expect(output.quotes.map((entry) => entry.symbol)).toEqual(["AAA", "BBB"]);
    expect(output.quotes[1].quote).toBeNull();
  });

  it("a supplied feed output means analyze never re-fetches regime, universe or quotes", async () => {
    const p = provider({
      getRegime: vi.fn(async () => {
        throw new Error("regime must not be fetched");
      }),
      getUniverseSymbols: vi.fn(async () => {
        throw new Error("universe must not be fetched");
      }),
      getQuote: vi.fn(async () => {
        throw new Error("quote must not be fetched");
      }),
    });
    const report = await runResearchPipeline(deps(p), config, {
      ...baseOpts,
      feed: feed({ quotes: [], quotesRetrieved: 0 }),
    });
    expect(p.getRegime).not.toHaveBeenCalled();
    expect(p.getUniverseSymbols).not.toHaveBeenCalled();
    expect(p.getQuote).not.toHaveBeenCalled();
    expect(report.stats.universeSize).toBe(2);
    expect(report.stats.quotesRetrieved).toBe(0);
  });

  it("consumes the run-scoped hand-off when the caller did not pass feed", async () => {
    putResearchFeed(feed());
    const p = provider({
      getQuote: vi.fn(async () => {
        throw new Error("quote must not be fetched");
      }),
    });
    const report = await runResearchPipeline(deps(p), config, baseOpts);
    expect(p.getQuote).not.toHaveBeenCalled();
    expect(report.stats.quotesRetrieved).toBe(1);
  });

  it("preserves the universe-failure report from the feed error", async () => {
    const report = await runResearchPipeline(deps(provider()), config, {
      ...baseOpts,
      feed: feed({
        universeError: "listings unavailable",
        symbols: [],
        quotes: [],
        universeSize: 0,
        quotesRetrieved: 0,
      }),
    });
    expect(report.summary).toBe("Universe retrieval failed; no candidates evaluated.");
    expect(report.rejected[0]?.reason).toContain("listings unavailable");
  });

  it("runs as the research.feed engine step and hands the output to analyze", async () => {
    const { createBuiltinStepRegistry } = await import("../src/services/jobPipelineSteps");
    const { registerResearchSteps } = await import("../src/services/researchPipelineJobs");
    const runOodaAnalysis = vi.fn(async () => ({ runId: "run-feed-1", ideas: [], watchlist: [], rejected: [] }));
    const registry = registerResearchSteps(createBuiltinStepRegistry(), {
      runFeedStage: async () => feed(),
      runOodaAnalysis,
    });
    const feedStep = registry.resolve("research.feed");
    const feedResult = await feedStep({
      jobId: "research:run-feed-1",
      runId: "run-feed-1",
      nodePath: "",
      kind: "feed",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { runId: "run-feed-1", userLogin: "owner@example.com", trigger: "manual" },
      input: null,
      now: "2026-11-22T00:00:00.000Z",
      trigger: "manual",
      runKind: "original",
    } as never);
    const output = feedResult.output as ResearchFeedStageOutput;
    expect(output.universeSize).toBe(2);
    expect(output.quotesRetrieved).toBe(1);

    const analyzeStep = registry.resolve("analyze.ooda");
    await analyzeStep({
      jobId: "research:run-feed-1",
      runId: "run-feed-1",
      nodePath: "",
      kind: "analyze",
      stepIndex: 1,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { runId: "run-feed-1", userLogin: "owner@example.com", trigger: "manual" },
      input: output,
      now: "2026-11-22T00:00:01.000Z",
      trigger: "manual",
      runKind: "original",
    } as never);
    expect(runOodaAnalysis).toHaveBeenCalledTimes(1);
    expect(runOodaAnalysis.mock.calls[0][0]).toMatchObject({ feed: output });
  });
});