// @vitest-environment node
/**
 * Issue #5824 (#4437 slice 3a) — the screener's market analyze as a
 * generic analyze application: the "screen" + "factors" rule sets in
 * computeAnalysis, the parent-hand-off input mode (the gather output's
 * quotes mapped to enriched rows — peRatio lives in the quote fields,
 * not as a persisted enrich feature), and the "analyze.screener" step
 * registered alongside analyze.apply.
 *
 * The parity pin: the bespoke path (screenWithQuotes → buildAllStocks
 * → attachFactorGrades → selectStandouts) and the generic path (the
 * hand-off mapper → computeAnalysis with screen + factors) run over
 * the SAME quotes and must agree on every signal, every grade, and
 * the standout selection. The goal branch (3b) and the portfolio
 * modifier (3c) are NOT here — see #5873 / #5874.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYZE_JOB_CODES,
  AnalyzeJobRegistry,
  computeAnalysis,
  resolveAnalyzeThresholds,
  resolveScreenerHandOff,
  runAnalyzeJob,
  validateAnalyzeRuleSets,
  type AnalyzeJobDefinition,
} from "../src/services/analyzeJobs";
import {
  ANALYZE_SCREENER_STEP,
  registerScreenerAnalyzeStep,
} from "../src/services/analyzePipelineJobs";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import type { EnrichedDatasetArtifact } from "../src/data/enrichedDatasetPorts";
import { DynamicMarketScreener } from "../src/trading/screener";
import {
  attachFactorGrades,
  buildAllStocks,
  selectStandouts,
} from "../src/trading/screenerPipeline";
import type { DataProviderId, IndexId } from "../src/trading";
import type { ETradeQuote } from "../src/types";

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function makeQuote(overrides: Partial<ETradeQuote> = {}): ETradeQuote {
  return {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation",
    lastPrice: 130,
    price: 130,
    change: 0.26,
    changePercent: 0.2,
    bid: 0,
    ask: 0,
    volume: 80_000_000,
    averageVolume: 60_000_000,
    open: 128,
    high: 132,
    low: 127,
    week52High: 150,
    week52Low: 100,
    peRatio: null,
    rsi: 80,
    sector: "Technology",
    source: "test",
    quoteStatus: "AS_OF_UNKNOWN",
    ...overrides,
  } as ETradeQuote;
}

/** Six quotes spanning every screen signal; one carries no P/E. */
function universeQuotes(): ETradeQuote[] {
  return [
    makeQuote({
      symbol: "AAPL",
      companyName: "Apple Inc.",
      lastPrice: 180,
      price: 180,
      change: 5.24,
      changePercent: 3.0,
      open: 176,
      high: 182,
      low: 175,
      week52High: 200,
      week52Low: 150,
      peRatio: 25,
      rsi: 45,
      volume: 50_000_000,
      averageVolume: 40_000_000,
    }),
    makeQuote({
      symbol: "MSFT",
      companyName: "Microsoft Corporation",
      lastPrice: 400,
      price: 400,
      change: -16.67,
      changePercent: -4.0,
      open: 410,
      high: 412,
      low: 398,
      week52High: 450,
      week52Low: 350,
      peRatio: 30,
      rsi: 25,
      volume: 30_000_000,
      averageVolume: 25_000_000,
    }),
    makeQuote(),
    makeQuote({
      symbol: "AMZN",
      companyName: "Amazon.com, Inc.",
      lastPrice: 200,
      price: 200,
      change: 0.2,
      changePercent: 0.1,
      open: 199,
      high: 201,
      low: 198,
      week52High: 220,
      week52Low: 170,
      peRatio: 40,
      rsi: undefined,
      volume: 20_000_000,
      averageVolume: 22_000_000,
    }),
    makeQuote({
      symbol: "META",
      companyName: "Meta Platforms, Inc.",
      lastPrice: 500,
      price: 500,
      change: 28.3,
      changePercent: 6.0,
      open: 490,
      high: 505,
      low: 488,
      week52High: 550,
      week52Low: 400,
      peRatio: 20,
      rsi: 60,
      volume: 15_000_000,
      averageVolume: 12_000_000,
    }),
    makeQuote({
      symbol: "GOOGL",
      companyName: "Alphabet Inc.",
      lastPrice: 170,
      price: 170,
      change: -0.51,
      changePercent: -0.3,
      open: 171,
      high: 172,
      low: 168,
      week52High: 190,
      week52Low: 140,
      peRatio: 22,
      rsi: 50,
      volume: 25_000_000,
      averageVolume: 25_000_000,
    }),
  ];
}

function handOff(quotes: ETradeQuote[]) {
  return {
    timestamp: iso(T0),
    userLogin: "trader1",
    universe: "nasdaq100",
    sector: "all",
    provider: "yahoo",
    symbols: [],
    expectedCount: quotes.length,
    acquired: {
      quotes,
      discovery: {
        mode: "live_quotes",
        candidateCount: quotes.length,
        listingCount: quotes.length,
        message: "test",
      },
    },
    platformRunId: "plat-1",
    quoteTraceSummary: {},
    taskId: "task-1",
  };
}

const ENRICH_JOB = "yahoo-nasdaq100-quotes-enrich";
const JOB = `${ENRICH_JOB}-analyze`;

function def(overrides: Partial<AnalyzeJobDefinition> = {}): AnalyzeJobDefinition {
  return {
    id: JOB,
    enrichJobId: ENRICH_JOB,
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: { kind: "index", index: "nasdaq100" as IndexId, label: "Nasdaq-100" },
    ruleSets: ["screen", "factors"],
    cadenceMinutes: 60,
    staleAfterMinutes: 180,
    ...overrides,
  };
}

function stepCtx(overrides: {
  jobId: string;
  runId?: string;
  shardKey?: string | null;
  params?: Record<string, unknown>;
  input?: unknown;
}) {
  return {
    jobId: overrides.jobId,
    runId: overrides.runId ?? "engine-run-1",
    nodePath: "0",
    kind: "analyze",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: overrides.shardKey ?? null,
    params: overrides.params ?? {},
    input: overrides.input ?? null,
    now: iso(T0),
    trigger: "manual",
    runKind: "original",
  };
}

describe("screener analyze parity — bespoke vs generic (#5824 3a)", () => {
  it("the vocabulary admits the screener rule sets", () => {
    expect(validateAnalyzeRuleSets(["screen", "factors"])).toEqual([
      "screen",
      "factors",
    ]);
    const thresholds = resolveAnalyzeThresholds();
    expect(thresholds.standoutMaxItems).toBe(5);
    expect(thresholds.standoutMinMomentumScore).toBe(60);
  });

  it("same quotes → same screen signals, momentum scores, factor grades and standouts", () => {
    const quotes = universeQuotes();

    // Bespoke: screen → shape → grade → select.
    const screener = new DynamicMarketScreener();
    const screened = screener.screenWithQuotes(quotes, {}, false).stocks;
    const graded = attachFactorGrades(buildAllStocks(quotes, screened));
    const bespokeStandouts = selectStandouts(screened, 5);

    // Generic: hand-off → enriched rows → computeAnalysis.
    const handOffRows = resolveScreenerHandOff(handOff(quotes));
    const generic = computeAnalysis({
      inputArtifact: { rows: handOffRows.rows } as unknown as EnrichedDatasetArtifact,
      ruleSets: ["screen", "factors"],
      thresholds: resolveAnalyzeThresholds(),
    });

    expect(generic.rows).toHaveLength(quotes.length);
    const bySymbol = new Map(generic.rows.map((r) => [r.symbol, r]));
    const gradedBySymbol = new Map(graded.map((s) => [s.symbol, s]));
    for (const s of screened) {
      const row = bySymbol.get(s.symbol)!;
      expect(row.signals.screen).toBe(s.signal);
      expect(row.scores.screen).toBe(s.momentumScore);
      const g = gradedBySymbol.get(s.symbol)!;
      expect(row.signals.factors_value).toBe(g.factorGrades.value ?? undefined);
      expect(row.signals.factors_momentum).toBe(g.factorGrades.momentum ?? undefined);
      expect(row.signals.factors_quant).toBe(g.factorGrades.quantRating ?? undefined);
      expect(row.scores.factors_value).toBe(g.factorGrades.valueScore ?? undefined);
      expect(row.scores.factors_momentum).toBe(g.factorGrades.momentumScore ?? undefined);
      expect(row.scores.factors).toBe(g.factorGrades.compositeScore ?? undefined);
    }
    // NVDA carries no P/E — and the value signal still grades
    // it: rawValueSignal blends P/E AND 52-week range position,
    // so a missing P/E narrows the signal to the range part
    // instead of withholding the grade. The loop above pins
    // that both paths agree; this pins that the grade is
    // present, not withheld.
    expect(bySymbol.get("NVDA")!.signals.factors_value).toBeDefined();
    expect(bySymbol.get("NVDA")!.signals.factors_momentum).toBeDefined();

    expect(generic.summary.standouts.map((s) => s.symbol)).toEqual(
      bespokeStandouts.map((s) => s.symbol),
    );
    for (const standout of generic.summary.standouts) {
      const bespoke = bespokeStandouts.find((s) => s.symbol === standout.symbol)!;
      expect(standout.signal).toBe(bespoke.signal);
      expect(standout.momentumScore).toBe(bespoke.momentumScore);
    }
  });

  it("a malformed hand-off refuses by name", () => {
    expect(() => resolveScreenerHandOff({})).toThrowError(
      expect.objectContaining({ code: ANALYZE_JOB_CODES.handoffMalformed }),
    );
    expect(() => resolveScreenerHandOff({ acquired: { quotes: "nope" } })).toThrowError(
      expect.objectContaining({ code: ANALYZE_JOB_CODES.handoffMalformed }),
    );
  });

  it("the analyze.screener step runs the hand-off mode and persists the artifact", async () => {
    const quotes = universeQuotes();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const registry = new AnalyzeJobRegistry();
    registry.register(def());
    const steps = new JobStepRegistry();
    registerScreenerAnalyzeStep(steps, {
      registry,
      enrichedStore: null,
      analyzedStore,
    });
    expect(steps.has(ANALYZE_SCREENER_STEP)).toBe(true);
    expect(ANALYZE_SCREENER_STEP).toBe("analyze.screener");

    const result = await steps.resolve(ANALYZE_SCREENER_STEP)(
      stepCtx({
        jobId: JOB,
        params: { analyzeJobId: JOB, inputMode: "handOff", ruleSets: ["screen", "factors"] },
        input: handOff(quotes),
      }) as never,
    );
    expect(result.output).toMatchObject({
      analyzeJobId: JOB,
      status: "completed",
      requested: 6,
      received: 6,
      inputArtifactId: "plat-1",
      inputRunId: "task-1",
    });
    const artifact = await analyzedStore.latest(JOB);
    expect(artifact).not.toBeNull();
    expect(artifact!.summary.standouts.map((s) => s.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "META",
    ]);
    const aapl = artifact!.rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.signals.screen).toBe("BULLISH_MOMENTUM");
    expect(aapl.scores.screen).toBe(65);
  });

  it("the step refuses an unwired analyzed store and a malformed hand-off by name", async () => {
    const quotes = universeQuotes();
    const registry = new AnalyzeJobRegistry();
    registry.register(def());
    const steps = new JobStepRegistry();
    registerScreenerAnalyzeStep(steps, {
      registry,
      enrichedStore: null,
      analyzedStore: null,
    });
    await expect(
      steps.resolve(ANALYZE_SCREENER_STEP)(
        stepCtx({
          jobId: JOB,
          params: { analyzeJobId: JOB, inputMode: "handOff" },
          input: handOff(quotes),
        }) as never,
      ),
    ).rejects.toThrow("ANALYZE_JOB_NOT_CONFIGURED");

    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const steps2 = new JobStepRegistry();
    registerScreenerAnalyzeStep(steps2, {
      registry,
      enrichedStore: null,
      analyzedStore,
    });
    await expect(
      steps2.resolve(ANALYZE_SCREENER_STEP)(
        stepCtx({
          jobId: JOB,
          params: { analyzeJobId: JOB, inputMode: "handOff" },
          input: {},
        }) as never,
      ),
    ).rejects.toThrow("ANALYZE_HANDOFF_MALFORMED");
  });
});
