// @vitest-environment node
/**
 * Issue #5885 (#4437 slice 6c) — the generate→deliver payload:
 * the generate run builds the delivery payload for a
 * screener-report from the report document (the only place the
 * document, the format records and the canonical record coexist
 * without a store read), and threads the canonical report id.
 *
 * - The converter maps the document to a ScreenerRunResult-shaped
 *   payload the door already understands (screenerOutcomeFromRunResult):
 *   trigger, totalScanned, universe, summary, thesis, the
 *   top-by-composite opportunities joined with their rows — and
 *   the canonical report id, so the door can stamp it onto the
 *   outcome (the C4 path: the canonical row IS the artifact for
 *   a generic-chain run, which carries no PDF artifact key).
 * - What the document does NOT carry, the payload does NOT
 *   invent: no matchedCount (the analyzed artifact carries no
 *   matched notion — the document's own rule, #5825), no
 *   pdfKey/xlsxKey/csvKey (the generic formats are inline bodies,
 *   not artifact keys). Rich per-symbol parity is #5875, not 6c.
 * - runGenerateJob carries the payload + report id on its result
 *   (screener-report runs only); the generate step passes them
 *   through as `payload` + `reportId` on its output, which the
 *   deliver step already reads (prior.payload, prior.reportId).
 */
import { describe, expect, it } from "vitest";
import {
  buildScreenerDeliveryPayload,
  GenerateJobRegistry,
  runGenerateJob,
  type CanonicalReportStoreSeam,
  type GenerateJobDefinition,
  type GenerateReportDocument,
} from "../src/services/generateJobs";
import { buildScreenerMarketOutcome } from "../src/services/screenerPipelineJobs";
import {
  GENERATE_APPLY_STEP,
  registerGenerateStep,
} from "../src/services/generatePipelineJobs";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import type { AnalyzedDatasetStoreInput } from "../src/data/analyzedDatasetPorts";
import type { CanonicalStoreResult, ScheduledReportInput } from "../src/services/scheduledReports";
import type { DataProviderId, IndexId } from "../src/trading";
import { JobStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";

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
      size: 4,
    },
    inputArtifactId: `enriched-${runId}`,
    inputRunId: `enrich-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    ruleSets: ["screen", "factors"],
    gaps: [],
    ruleCoverage: {
      screen: { evaluated: 4, unavailable: 0 },
      factors: { evaluated: 4, unavailable: 0 },
    },
    summary: {
      symbols: 4,
      advancers: 3,
      decliners: 1,
      flat: 0,
      meanMomentum: 1.4,
      meanCompositeScore: 8.5,
      topByComposite: [
        { symbol: "AAPL", score: 40 },
        { symbol: "MSFT", score: 30 },
      ],
      bottomByComposite: [{ symbol: "AMZN", score: -20 }],
      standouts: [],
    },
    rows: [
      {
        symbol: "AAPL",
        lastPrice: 110,
        signals: { screen: "BULLISH_MOMENTUM" },
        scores: { screen: 75 },
        compositeScore: 40,
        unavailable: [],
      },
      {
        symbol: "MSFT",
        lastPrice: 210,
        signals: { screen: "RANGE_BOUND" },
        scores: { screen: 55 },
        compositeScore: 30,
        unavailable: [],
      },
      {
        symbol: "NVDA",
        lastPrice: 300,
        signals: { screen: "OVERBOUGHT" },
        scores: { screen: 90 },
        compositeScore: 5,
        unavailable: [],
      },
      {
        symbol: "AMZN",
        lastPrice: 180,
        signals: { screen: "OVERSOLD_BOUNCE" },
        scores: { screen: 20 },
        compositeScore: -20,
        unavailable: [],
      },
    ],
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 4,
      received: 4,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
    ...overrides,
  };
}

/** A screener-report document, as buildReportDocument builds it. */
function documentFixture(): GenerateReportDocument {
  return {
    kind: "screener-report",
    title: "Market screen — yahoo quotes (Nasdaq-100)",
    summary:
      "Market screen of Nasdaq-100 quotes from yahoo: 4 symbols scanned; breadth 3 up / 1 down / 0 flat; mean composite 8.5; mean momentum 1.4. Top by composite: AAPL (40), MSFT (30). Bottom by composite: AMZN (-20).",
    sourceId: "yahoo",
    dataset: "quotes",
    universeLabel: "Nasdaq-100",
    partitioned: false,
    symbolsRendered: 4,
    inputArtifactId: "analyzed-1",
    inputRunId: "analyze-1",
    inputAsOf: iso(T0),
    analyzeJobId: ANALYZE_JOB,
    enrichJobId: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    ruleSets: ["screen", "factors"],
    inputSummary: {
      symbols: 4,
      advancers: 3,
      decliners: 1,
      flat: 0,
      meanMomentum: 1.4,
      meanCompositeScore: 8.5,
      topByComposite: [
        { symbol: "AAPL", score: 40 },
        { symbol: "MSFT", score: 30 },
      ],
      bottomByComposite: [{ symbol: "AMZN", score: -20 }],
      standouts: [],
    },
    gaps: [],
    rows: analyzedInput("analyze-1", T0).rows,
  };
}

function registryWith(d: GenerateJobDefinition): GenerateJobRegistry {
  const registry = new GenerateJobRegistry();
  registry.register(d);
  return registry;
}

function fakeSeam(
  behavior: (input: ScheduledReportInput) => CanonicalStoreResult | null,
): { seam: CanonicalReportStoreSeam; calls: ScheduledReportInput[] } {
  const calls: ScheduledReportInput[] = [];
  return {
    calls,
    seam: {
      ownerLogin: "octocat",
      store: async (input) => {
        calls.push(input);
        return behavior(input);
      },
    },
  };
}

async function seededStores() {
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  await analyzedStore.store(analyzedInput("analyze-1", T0));
  return { analyzedStore, generatedStore };
}

describe("the screener delivery payload (#5885)", () => {
  it("maps the screener-report document to the door's payload shape", () => {
    const payload = buildScreenerDeliveryPayload({
      document: documentFixture(),
      canonicalReportId: "rep-5885",
      trigger: "manual",
      finishedAt: iso(T0 + 60_000),
    });
    expect(payload).toEqual({
      trigger: "manual",
      success: true,
      timestamp: iso(T0 + 60_000),
      totalScanned: 4,
      universe: "Nasdaq-100",
      summary: documentFixture().summary,
      thesis: "Market screen — yahoo quotes (Nasdaq-100)",
      opportunities: [
        { symbol: "AAPL", signal: "BULLISH_MOMENTUM", momentumScore: 40, lastPrice: 110 },
        { symbol: "MSFT", signal: "RANGE_BOUND", momentumScore: 30, lastPrice: 210 },
      ],
      canonicalReportId: "rep-5885",
    });
    // Nothing the document does not carry is invented: no
    // matched count, no artifact keys.
    expect(payload).not.toHaveProperty("matchedCount");
    expect(payload).not.toHaveProperty("pdfKey");
    expect(payload).not.toHaveProperty("xlsxKey");
    expect(payload).not.toHaveProperty("csvKey");
  });

  it("omits the canonical report id when the leg did not store a row", () => {
    const payload = buildScreenerDeliveryPayload({
      document: documentFixture(),
      canonicalReportId: null,
      trigger: "scheduled",
      finishedAt: iso(T0 + 60_000),
    });
    expect(payload).not.toHaveProperty("canonicalReportId");
    expect(payload.trigger).toBe("scheduled");
  });

  it("keeps a top symbol with no row, scored from the summary", () => {
    const doc = documentFixture();
    doc.inputSummary = {
      ...doc.inputSummary,
      topByComposite: [...doc.inputSummary.topByComposite, { symbol: "GHOST", score: 10 }],
    };
    const payload = buildScreenerDeliveryPayload({
      document: doc,
      canonicalReportId: "rep-5885",
      trigger: "manual",
      finishedAt: iso(T0 + 60_000),
    });
    const opportunities = payload.opportunities as Array<Record<string, unknown>>;
    expect(opportunities).toHaveLength(3);
    expect(opportunities[2]).toEqual({ symbol: "GHOST", momentumScore: 10 });
  });
});

describe("the generate run carries the payload + report id (#5885)", () => {
  it("a screener-report run returns both, from the stored canonical row", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = fakeSeam(() => ({
      reportId: "rep-5885",
      created: true,
      fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
    }));
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.reportId).toBe("rep-5885");
    expect(result.canonical).toEqual({ "screener-report": "stored" });
    const payload = result.deliveryPayload as Record<string, unknown>;
    expect(payload.totalScanned).toBe(4);
    expect(payload.universe).toBe("Nasdaq-100");
    expect(payload.canonicalReportId).toBe("rep-5885");
    expect(payload.trigger).toBe("manual");
    expect(payload).not.toHaveProperty("matchedCount");
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]?.canonical).toMatchObject({
      status: "stored",
      reportId: "rep-5885",
    });
  });

  it("an analysis-only run carries neither — the payload is screener-report-only", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = fakeSeam(() => ({
      reportId: "rep-1",
      created: true,
      fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
    }));
    const result = await runGenerateJob(
      registryWith(def({ reports: ["analysis"] })),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    // The canonical id still threads (first stored record) —
    // the payload does not: no screener-report was generated.
    expect(result.reportId).toBe("rep-1");
    expect(result.deliveryPayload).toBeNull();
  });

  it("a refused canonical leg still delivers a payload, without the report id", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = fakeSeam(() => null);
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.reportId).toBeNull();
    expect(result.canonical).toEqual({ "screener-report": "failed" });
    const payload = result.deliveryPayload as Record<string, unknown>;
    expect(payload.totalScanned).toBe(4);
    expect(payload).not.toHaveProperty("canonicalReportId");
  });

  it("an unwired canonical leg records not_wired and carries no report id", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.reportId).toBeNull();
    expect(result.canonical).toEqual({ "screener-report": "not_wired" });
    expect(result.deliveryPayload).not.toBeNull();
  });
});

describe("the generate step passes payload + report id through (#5885)", () => {
  function stepCtx(over: Partial<JobStepContext> = {}): JobStepContext {
    return {
      jobId: "screen-5885",
      runId: "run-1",
      nodePath: "0.0.0.0",
      kind: "generate",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: {
        userLogin: "owner",
        generateJobId: JOB,
        reports: ["screener-report"],
      },
      input: {},
      now: iso(T0),
      trigger: "manual",
      runKind: "original",
      ...over,
    };
  }

  it("a screener-report step output carries payload + reportId", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = fakeSeam(() => ({
      reportId: "rep-5885",
      created: true,
      fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
    }));
    const registry = new JobStepRegistry();
    registerGenerateStep(registry, {
      registry: registryWith(def()),
      analyzedStore,
      generatedStore,
      canonicalReportStore: seam,
    });
    const out = await registry.resolve(GENERATE_APPLY_STEP)(stepCtx());
    const output = out.output as Record<string, unknown>;
    expect(output.generateJobId).toBe(JOB);
    expect(output.reportId).toBe("rep-5885");
    const payload = output.payload as Record<string, unknown>;
    expect(payload.totalScanned).toBe(4);
    expect(payload.canonicalReportId).toBe("rep-5885");
  });

  it("an analysis step output carries neither", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const registry = new JobStepRegistry();
    registerGenerateStep(registry, {
      registry: registryWith(def({ reports: ["analysis"] })),
      analyzedStore,
      generatedStore,
      canonicalReportStore: null,
    });
    const out = await registry.resolve(GENERATE_APPLY_STEP)(
      stepCtx({ params: { userLogin: "owner", generateJobId: JOB, reports: ["analysis"] } }),
    );
    const output = out.output as Record<string, unknown>;
    expect(output).not.toHaveProperty("payload");
    expect(output).not.toHaveProperty("reportId");
  });
});

describe("the door stamps the canonical report id from the generic payload (#5885)", () => {
  it("a generic payload's outcome carries the canonical report id", () => {
    const payload = buildScreenerDeliveryPayload({
      document: documentFixture(),
      canonicalReportId: "rep-5885",
      trigger: "manual",
      finishedAt: iso(T0 + 60_000),
    });
    const outcome = buildScreenerMarketOutcome(payload, "https://app.example.test");
    expect(outcome.canonicalReportId).toBe("rep-5885");
    expect(outcome.kind).toBe("stock");
    expect(outcome.success).toBe(true);
    expect(outcome.totalScanned).toBe(4);
    expect(outcome.universe).toBe("Nasdaq-100");
    expect(outcome.pdfKeys).toEqual([]);
    expect(outcome.opportunities?.map((o) => o.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("a bespoke payload's outcome carries no canonical report id (the stamp is generic-only)", () => {
    const outcome = buildScreenerMarketOutcome(
      {
        trigger: "manual",
        success: true,
        pdfKey: "screener:pdf:abc123",
        matchedCount: 2,
        totalScanned: 4,
        opportunities: [{ symbol: "AAPL", companyName: "AAPL Inc", changePercent: 1 }],
      },
      "https://app.example.test",
    );
    expect(outcome).not.toHaveProperty("canonicalReportId");
    expect(outcome.pdfKeys).toEqual(["screener:pdf:abc123"]);
    expect(outcome.matchedCount).toBe(2);
  });
});
