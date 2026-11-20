// @vitest-environment node
/**
 * Issue #5825 (#4437 slice 4) — generic generate produces the
 * screener-report kind: the screener's report shape, rendered
 * from the persisted analyzed artifact and stored through the
 * canonical leg (#3940) where a host wired it.
 *
 * Parity is pinned on the fields the analyzed artifact carries:
 * the same symbols in the same order, the same last price, the
 * same composite (the bespoke Score), the same scanned count,
 * the same opportunities (top by composite), and the same
 * title/summary shape as the bespoke screener report — against
 * the bespoke CSV generator for the same symbol table.
 *
 * Explicitly NOT parity, by construction (the analyzed artifact
 * carries no such fields, and this slice invents none): the
 * bespoke 16-column values that need the screener's per-symbol
 * fields — RSI-14, MACD histogram, P/E, company name, sector,
 * sentiment, factor grades, change%, gap%, and the single-label
 * Technical Signal (derived in screenerPipeline.ts, not in the
 * analyzed artifact). Closing that gap needs the analyzed row
 * to carry the screener's per-symbol fields — analyze/enrich
 * schema work, outside this slice. No "matched" count is stated
 * either: the analyzed artifact carries no matched notion, and
 * the kind fabricates none.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATE_JOB_CODES,
  GENERATE_REPORT_KINDS,
  GenerateJobRegistry,
  buildGenerateJobRegistry,
  buildReportDocument,
  renderReportFormat,
  runGenerateJob,
  validateGenerateReportKinds,
  type CanonicalReportStoreSeam,
  type GenerateJobDefinition,
} from "../src/services/generateJobs";
import { GENERATE_APPLY_STEP, registerGenerateStep } from "../src/services/generatePipelineJobs";
import { JobStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import type { AnalyzedDatasetStoreInput } from "../src/data/analyzedDatasetPorts";
import type { CanonicalStoreResult, ScheduledReportInput } from "../src/services/scheduledReports";
import type { DataProviderId, IndexId } from "../src/trading";
import { generateScreenerCsv, parseScreenerCsv } from "../src/trading";
import type { ScreenerRunResult } from "../src/agents/screener-agent";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ANALYZE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze";
const JOB = `${ANALYZE_JOB}-generate`;

function def(overrides: Partial<GenerateJobDefinition> = {}): GenerateJobDefinition {
  return {
    id: JOB,
    analyzeJobId: ANALYZE_JOB,
    enrichJobId: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: { kind: "index", index: "nasdaq100" as IndexId, label: "Nasdaq-100" },
    reports: ["screener-report"],
    formats: ["json", "markdown", "csv", "pdf"],
    cadenceMinutes: 60,
    staleAfterMinutes: 180,
    ...overrides,
  };
}

/** The shared symbol table: the analyzed rows and the bespoke
 *  screener rows describe the same screen. The bespoke Score
 *  (indicators.screenScore) equals the analyzed composite by
 *  fixture design — the parity the kind must preserve. */
function analyzedInput(
  runId: string,
  atMs: number,
  overrides: Partial<AnalyzedDatasetStoreInput> = {},
): AnalyzedDatasetStoreInput {
  return {
    jobId: ANALYZE_JOB,
    enrichJobId: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo" as DataProviderId,
    dataset: "quotes",
    universe: {
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 3,
    },
    inputArtifactId: `enriched-${runId}`,
    inputRunId: `enrich-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    ruleSets: ["momentum", "range"],
    gaps: [{ ruleSet: "value", reason: "element_unavailable_in_input", symbols: ["MSFT"] }],
    ruleCoverage: {
      momentum: { evaluated: 3, unavailable: 0 },
      range: { evaluated: 3, unavailable: 0 },
    },
    summary: {
      symbols: 3,
      advancers: 2,
      decliners: 1,
      flat: 0,
      meanMomentum: 1.4,
      meanCompositeScore: 8.5,
      topByComposite: [{ symbol: "AAPL", score: 40 }],
      bottomByComposite: [{ symbol: "MSFT", score: -20 }],
    },
    rows: [
      {
        symbol: "AAPL",
        lastPrice: 110,
        signals: { momentum: "strong_up", range: "near_high" },
        scores: { momentum: 50, range: 30 },
        compositeScore: 40,
        unavailable: [],
      },
      {
        symbol: "MSFT",
        lastPrice: 210,
        signals: { momentum: "down" },
        scores: { momentum: -20 },
        compositeScore: -20,
        unavailable: ["range"],
      },
      {
        symbol: "NVDA",
        lastPrice: 300,
        signals: { momentum: "up", range: "mid_range" },
        scores: { momentum: 10, range: 0 },
        compositeScore: 5,
        unavailable: [],
      },
    ],
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 3,
      received: 3,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
    ...overrides,
  };
}

/** The bespoke side of the same screen: the run result the
 *  bespoke generators render. Only the fields the CSV reads
 *  (and the parity assertions read) are populated. */
function bespokeResult(): ScreenerRunResult {
  const stock = (
    symbol: string,
    lastPrice: number,
    screenScore: number,
    signal: string,
  ) => ({
    symbol,
    companyName: symbol,
    sector: "Technology",
    lastPrice,
    changePercent: 1.5,
    rsi14: 62.4,
    source: "yahoo",
    indicators: { screenScore, sentiment: "positive" },
    factorGrades: { quantRating: "A", value: "B", momentum: "A" },
    technicals: { rsi14: 62.4, macdHistogram: 0.12, gapPercent: 0.5 },
    peRatio: 28.5,
    signal,
  });
  return {
    timestamp: iso(T0),
    trigger: "manual",
    provider: "yahoo",
    universe: "nasdaq100",
    sector: "Technology",
    success: true,
    totalScanned: 3,
    matchedCount: 1,
    opportunities: [stock("AAPL", 110, 40, "BULLISH_MOMENTUM")],
    allStocks: [
      stock("AAPL", 110, 40, "BULLISH_MOMENTUM"),
      stock("MSFT", 210, -20, "BEARISH_MOMENTUM"),
      stock("NVDA", 300, 5, "NEUTRAL"),
    ],
    filterSummary: "momentum + range",
  } as unknown as ScreenerRunResult;
}

function registryWith(d: GenerateJobDefinition): GenerateJobRegistry {
  const registry = new GenerateJobRegistry();
  registry.register(d);
  return registry;
}

async function seededStores() {
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  await analyzedStore.store(analyzedInput("analyze-1", T0));
  return { analyzedStore, generatedStore };
}

describe("the screener-report kind (#5825)", () => {
  it("the vocabulary admits screener-report and still refuses unknown kinds by name", () => {
    expect(GENERATE_REPORT_KINDS).toContain("screener-report");
    expect(validateGenerateReportKinds(["screener-report"])).toEqual(["screener-report"]);
    expect(validateGenerateReportKinds(["analysis", "screener-report"])).toEqual([
      "analysis",
      "screener-report",
    ]);
    expect(() => validateGenerateReportKinds(["screener-report", "teaser"])).toThrowError(
      expect.objectContaining({ code: GENERATE_JOB_CODES.reportUnknown }),
    );
  });

  it("the built-in registry still defaults to analysis — the kind is opt-in, never a silent second report", () => {
    expect(buildGenerateJobRegistry({}).get(JOB)).toMatchObject({ reports: ["analysis"] });
    expect(
      buildGenerateJobRegistry({
        GENERATE_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_REPORTS:
          "screener-report",
      }).get(JOB),
    ).toMatchObject({ reports: ["screener-report"] });
  });

  it("builds the screener's report shape from the analyzed artifact", async () => {
    const { analyzedStore } = await seededStores();
    const input = (await analyzedStore.latestUsable(ANALYZE_JOB))!;
    const document = buildReportDocument({
      kind: "screener-report",
      def: def(),
      inputArtifact: input,
      rows: input.rows,
      partitioned: false,
    });
    expect(document.kind).toBe("screener-report");
    expect(document.title).toBe("Market screen — yahoo quotes (Nasdaq-100)");
    expect(document.summary).toMatch(/^Market screen of Nasdaq-100 quotes from yahoo: 3 symbols scanned/);
    expect(document.symbolsRendered).toBe(3);
    expect(document.rows.map((r) => r.symbol)).toEqual(["AAPL", "MSFT", "NVDA"]);
    // Lineage + gaps ride verbatim, as with analysis.
    expect(document.inputArtifactId).toBe(input.id);
    expect(document.inputRunId).toBe("analyze-1");
    expect(document.gaps).toEqual(input.gaps);
    expect(document.ruleSets).toEqual(["momentum", "range"]);
    // The opportunities are the summary's top by composite.
    expect(document.inputSummary.topByComposite).toEqual([{ symbol: "AAPL", score: 40 }]);
  });

  it("renders the kind in all four formats, with an Opportunities section in markdown", async () => {
    const { analyzedStore } = await seededStores();
    const input = (await analyzedStore.latestUsable(ANALYZE_JOB))!;
    const document = buildReportDocument({
      kind: "screener-report",
      def: def(),
      inputArtifact: input,
      rows: input.rows,
      partitioned: false,
    });
    const finishedAtIso = iso(T0 + 60_000);
    const formats: Record<string, string> = {};
    for (const format of ["json", "markdown", "csv", "pdf"] as const) {
      const record = await renderReportFormat({ document, format, finishedAtIso });
      expect(record.status).toBe("generated");
      formats[format] = record.bodyText ?? record.bodyBase64 ?? "";
    }
    expect(JSON.parse(formats.json).kind).toBe("screener-report");
    expect(formats.markdown).toContain("## Opportunities");
    expect(formats.markdown).toContain("AAPL (40)");
    expect(formats.markdown).toContain("## Symbols");
    expect(formats.csv).toContain("AAPL,110,40");
    expect(formats.pdf.length).toBeGreaterThan(0);
  });

  it("runs as generic generate producing kind screener-report, through the canonical leg", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const calls: ScheduledReportInput[] = [];
    const seam: CanonicalReportStoreSeam = {
      ownerLogin: "octocat",
      store: async (input) => {
        calls.push(input);
        return {
          reportId: "rep-screen-1",
          created: true,
          fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
        };
      },
    };
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-screen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.reportsGenerated).toEqual(["screener-report"]);
    expect(result.canonical).toEqual({ "screener-report": "stored" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe("octocat");
    expect(calls[0]?.source).toBe("pipeline_generate");
    expect(calls[0]?.generationId).toMatch(
      /^pipeline-generate:yahoo-nasdaq100-quotes-enrich-analyze-generate:/,
    );
    expect((calls[0]?.body as { kind?: string }).kind).toBe("screener-report");
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]).toMatchObject({
      kind: "screener-report",
      canonical: { status: "stored", reportId: "rep-screen-1" },
    });
    expect(artifact?.reports[0]?.formats.map((f) => f.format)).toEqual([
      "json",
      "markdown",
      "csv",
      "pdf",
    ]);
    expect(artifact?.summary.canonicalStored).toBe(1);
  });

  it("runs through the generic generate.apply step (the stage Workflow Runs shows)", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const registry = new JobStepRegistry();
    registerGenerateStep(registry, {
      registry: registryWith(def()),
      analyzedStore,
      generatedStore,
      canonicalReportStore: null,
    });
    const handler = registry.resolve(GENERATE_APPLY_STEP);
    const ctx: JobStepContext = {
      jobId: JOB,
      runId: "step-run-1",
      nodePath: "",
      kind: "generate",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { generateJobId: JOB, reports: ["screener-report"] },
      input: null,
      now: iso(T0 + 60_000),
      trigger: "manual",
      runKind: "original",
    };
    const { output } = await handler(ctx);
    expect((output as { reportsGenerated: string[] }).reportsGenerated).toEqual([
      "screener-report",
    ]);
    expect((output as { status: string }).status).toBe("completed");
  });

  it("refuses by name when no persisted analyzed copy exists — and records the failed run", async () => {
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const generatedStore = new InMemoryGeneratedDatasetStore();
    await expect(
      runGenerateJob(registryWith(def()), { analyzedStore, generatedStore }, JOB, {
        runId: "gen-screen-0",
        nowMs: T0 + 60_000,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      codedError: GENERATE_JOB_CODES.inputMissing,
    });
    const recorded = await generatedStore.latest(JOB);
    expect(recorded?.run.codedError).toBe("GENERATE_INPUT_MISSING");
    expect(recorded?.reports).toEqual([]);
  });
});

describe("screener-report parity with the bespoke step (#5825)", () => {
  it("the same symbols, prices, scores, counts and opportunities as the bespoke CSV", async () => {
    const { analyzedStore } = await seededStores();
    const input = (await analyzedStore.latestUsable(ANALYZE_JOB))!;
    const document = buildReportDocument({
      kind: "screener-report",
      def: def(),
      inputArtifact: input,
      rows: input.rows,
      partitioned: false,
    });

    // The bespoke side, for the same symbol table.
    const bespoke = bespokeResult();
    const bespokeRows = parseScreenerCsv(generateScreenerCsv(bespoke));
    const bespokeHeader = bespokeRows[0]!;
    const col = (name: string) => bespokeHeader.indexOf(name);
    expect(bespokeHeader).toContain("Symbol");
    expect(bespokeHeader).toContain("Price");
    expect(bespokeHeader).toContain("Score");

    // The generic side, in the same table terms.
    const genericCsv = await renderReportFormat({
      document,
      format: "csv",
      finishedAtIso: iso(T0 + 60_000),
    });
    expect(genericCsv.status).toBe("generated");
    const genericRows = parseScreenerCsv(genericCsv.bodyText!);
    const genericHeader = genericRows[0]!;
    const gcol = (name: string) => genericHeader.indexOf(name);

    // Same symbols in the same order, same price, same score.
    expect(document.symbolsRendered).toBe(bespoke.totalScanned);
    expect(document.rows.map((r) => r.symbol)).toEqual(
      bespokeRows.slice(1).map((r) => r[col("Symbol")]),
    );
    for (const [i, row] of document.rows.entries()) {
      const b = bespokeRows[i + 1]!;
      const g = genericRows[i + 1]!;
      expect(g[gcol("symbol")]).toBe(b[col("Symbol")]);
      expect(g[gcol("last_price")]).toBe(b[col("Price")]);
      expect(g[gcol("composite_score")]).toBe(b[col("Score")]);
    }
    // Same opportunities: the top by composite is the bespoke standout.
    expect(document.inputSummary.topByComposite.map((t) => t.symbol)).toEqual(
      bespoke.opportunities.map((o) => o.symbol),
    );
    // Same title idiom as the bespoke PDF.
    expect(document.title).toMatch(/^Market screen — /);
  });
});
