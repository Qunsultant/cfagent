// @vitest-environment node
/**
 * Issue #3538 (Pipeline J5) — the generate service: deterministic
 * renders of PERSISTED analyzed artifacts (never a fetch), in
 * every configured report kind and format; the honesty rules
 * (a missing analyzed copy refuses by name GENERATE_INPUT_MISSING
 * with the failed run recorded; an unknown report kind / format
 * is refused by name; a rendered body over the cap is recorded
 * failed, never truncated); and the canonical leg (mas_reports
 * through the host-bound seam): stored / deduped where wired,
 * not_wired with its coded reason where no host wired it,
 * failed-with-reason when the seam refuses — and an unwired or
 * failed canonical leg NEVER fails a run whose generated
 * results persisted.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATE_GAP_CODES,
  GENERATE_JOB_CODES,
  GenerateJobError,
  GenerateJobRegistry,
  buildGenerateJobRegistry,
  buildGenerateStatus,
  runGenerateJob,
  validateGenerateFormats,
  validateGenerateReportKinds,
  type CanonicalReportStoreSeam,
  type GenerateJobDefinition,
} from "../src/services/generateJobs";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import type { AnalyzedDatasetStoreInput } from "../src/data/analyzedDatasetPorts";
import type { CanonicalStoreResult, ScheduledReportInput } from "../src/services/scheduledReports";
import type { DataProviderId, IndexId } from "../src/trading";

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
    reports: ["analysis"],
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
      size: 3,
    },
    inputArtifactId: `enriched-${runId}`,
    inputRunId: `enrich-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    ruleSets: ["momentum", "range"],
    gaps: [
      { ruleSet: "value", reason: "element_unavailable_in_input", symbols: ["MSFT"] },
    ],
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

describe("the report / format vocabulary (#3538)", () => {
  it("refuses an unknown report kind by name", () => {
    expect(() => validateGenerateReportKinds(["analysis", "teaser"])).toThrowError(
      expect.objectContaining({ code: GENERATE_JOB_CODES.reportUnknown }),
    );
    expect(validateGenerateReportKinds(["analysis"])).toEqual(["analysis"]);
  });

  it("refuses an unknown format by name", () => {
    expect(() => validateGenerateFormats(["json", "docx"])).toThrowError(
      expect.objectContaining({ code: GENERATE_JOB_CODES.formatUnknown }),
    );
    expect(validateGenerateFormats(["json", "pdf"])).toEqual(["json", "pdf"]);
  });

  it("the built-in registry carries one generate job per analyze job", () => {
    const registry = buildGenerateJobRegistry({});
    expect(registry.list().map((j) => j.id)).toEqual([
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
      "yahoo-sp100-quotes-enrich-analyze-generate",
      "yahoo-sp500-quotes-enrich-analyze-generate",
      "yahoo-dow-quotes-enrich-analyze-generate",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate",
      "etrade-nasdaq100-quotes-enrich-analyze-generate",
      "public-nasdaq100-quotes-enrich-analyze-generate",
    ]);
    expect(registry.forAnalyzeJob(ANALYZE_JOB)?.id).toBe(JOB);
    expect(registry.get(JOB)).toMatchObject({
      reports: ["analysis"],
      formats: ["json", "markdown", "csv", "pdf"],
      cadenceMinutes: 60,
      staleAfterMinutes: 180,
    });
  });

  it("env knobs externalize cadence, reports and formats", () => {
    const registry = buildGenerateJobRegistry({
      GENERATE_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_CADENCE_MINUTES: "15",
      GENERATE_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_FORMATS: "json, markdown",
    });
    expect(registry.get(JOB)).toMatchObject({
      cadenceMinutes: 15,
      formats: ["json", "markdown"],
    });
  });
});

describe("the run service (#3538)", () => {
  it("refuses by name when no persisted analyzed copy exists — and records the failed run", async () => {
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const generatedStore = new InMemoryGeneratedDatasetStore();
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-1", nowMs: T0 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(GENERATE_JOB_CODES.inputMissing);
    expect(result.artifactId).toBeTruthy();
    const recorded = await generatedStore.latest(JOB);
    expect(recorded?.run.runId).toBe("gen-1");
    expect(recorded?.run.codedError).toBe(GENERATE_JOB_CODES.inputMissing);
    expect(await generatedStore.latestUsable(JOB)).toBeUndefined();
  });

  it("generates end to end: all four formats render and persist with lineage", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(4);
    expect(result.received).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.inputRunId).toBe("analyze-1");
    expect(result.reportsGenerated).toEqual(["analysis"]);
    expect(result.canonical).toEqual({ analysis: "not_wired" });

    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.run.runId).toBe("gen-1");
    expect(artifact?.inputRunId).toBe("analyze-1");
    expect(artifact?.summary).toEqual({
      reportsGenerated: 1,
      formatsGenerated: 4,
      formatsFailed: 0,
      canonicalStored: 0,
      canonicalNotWired: 1,
    });
    const report = artifact!.reports[0]!;
    expect(report.formats.map((f) => f.format)).toEqual(["json", "markdown", "csv", "pdf"]);
    expect(report.formats.every((f) => f.status === "generated")).toBe(true);
    expect(report.canonical).toEqual({
      status: "not_wired",
      reportId: null,
      fanoutCode: null,
      reason: GENERATE_GAP_CODES.canonicalNotWired,
    });
    // The json body parses back to the report document, lineage intact,
    // and the analyze stage's gaps ride verbatim (never recomputed).
    const json = report.formats.find((f) => f.format === "json")!;
    const document = JSON.parse(json.bodyText!) as any;
    expect(document.kind).toBe("analysis");
    expect(document.inputRunId).toBe("analyze-1");
    expect(document.rows.map((r: any) => r.symbol)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(document.gaps).toEqual([
      { ruleSet: "value", reason: "element_unavailable_in_input", symbols: ["MSFT"] },
    ]);
    expect(document.inputSummary.meanCompositeScore).toBe(8.5);
    // The pdf body is the binary render (base64), not text.
    const pdf = report.formats.find((f) => f.format === "pdf")!;
    expect(pdf.bodyText).toBeNull();
    expect(pdf.bodyBase64).toBeTruthy();
    expect(Buffer.from(pdf.bodyBase64!, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("is deterministic: identical input + configuration + clock ⇒ identical bodies", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const deps = { analyzedStore, generatedStore };
    const first = await runGenerateJob(registryWith(def()), deps, JOB, { runId: "gen-1", nowMs: T0 + 60_000 });
    const second = await runGenerateJob(registryWith(def()), deps, JOB, { runId: "gen-2", nowMs: T0 + 60_000 });
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    const runs = await generatedStore.listRuns(JOB, 2);
    const bodies = runs.map((a) =>
      Object.fromEntries(
        a.reports[0]!.formats.map((f) => [f.format, f.bodyText ?? f.bodyBase64]),
      ),
    );
    expect(bodies[0]).toEqual(bodies[1]);
  });

  it("a run over a failed analyze artifact refuses — latestUsable is the input rule", async () => {
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const generatedStore = new InMemoryGeneratedDatasetStore();
    await analyzedStore.store(
      analyzedInput("analyze-bad", T0, {
        rows: [],
        run: {
          runId: "analyze-bad",
          trigger: "manual",
          startedAt: iso(T0),
          finishedAt: iso(T0 + 1000),
          status: "failed",
          requested: 3,
          received: 0,
          failed: 3,
          codedError: "ANALYZE_INPUT_MISSING",
          errorMessage: "no usable input",
        },
      }),
    );
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(GENERATE_JOB_CODES.inputMissing);
  });

  it("throws for an unknown job id (a caller bug, the #3530 idiom)", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    await expect(
      runGenerateJob(
        registryWith(def()),
        { analyzedStore, generatedStore },
        "nope-generate",
        {},
      ),
    ).rejects.toThrowError(GenerateJobError);
  });

  it("a shard partition generates only its symbols, lineage intact", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-shard", nowMs: T0 + 60_000, symbols: ["AAPL", "NVDA"] },
    );
    expect(result.status).toBe("completed");
    const artifact = await generatedStore.latestUsable(JOB);
    const json = artifact!.reports[0]!.formats.find((f) => f.format === "json")!;
    const document = JSON.parse(json.bodyText!) as any;
    expect(document.partitioned).toBe(true);
    expect(document.rows.map((r: any) => r.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(document.inputRunId).toBe("analyze-1");
  });

  it("configuration narrows the run: formats override renders only those", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000, formats: ["csv"] },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(1);
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]?.formats.map((f) => f.format)).toEqual(["csv"]);
    expect(artifact?.formatsRequested).toEqual(["csv"]);
  });
});

describe("the canonical leg (#3538)", () => {
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

  it("stored where a host wired the seam — with the deterministic generation id", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam, calls } = fakeSeam(() => ({
      reportId: "rep-1",
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
    expect(result.canonical).toEqual({ analysis: "stored" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userLogin).toBe("octocat");
    expect(calls[0]?.source).toBe("pipeline_generate");
    expect(calls[0]?.generationId).toMatch(/^pipeline-generate:yahoo-nasdaq100-quotes-enrich-analyze-generate:/);
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]?.canonical).toMatchObject({
      status: "stored",
      reportId: "rep-1",
    });
    expect(artifact?.summary.canonicalStored).toBe(1);
  });

  it("a re-run over the same persisted input dedupes on the seam's idempotency", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = fakeSeam(() => ({
      reportId: "rep-1",
      created: false,
      fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
    }));
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-2", nowMs: T0 + 120_000 },
    );
    expect(result.canonical).toEqual({ analysis: "deduped" });
  });

  it("a seam refusal is recorded failed with its reason — and never fails the run", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const { seam } = fakeSeam(() => null);
    const result = await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore, canonicalReportStore: seam },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.canonical).toEqual({ analysis: "failed" });
    const artifact = await generatedStore.latestUsable(JOB);
    expect(artifact?.reports[0]?.canonical.reason).toBe(
      GENERATE_GAP_CODES.canonicalStoreRefused,
    );
  });

  it("status of a never-run job is the named never-run state; after a run it carries the snapshot", async () => {
    const { analyzedStore, generatedStore } = await seededStores();
    const never = await buildGenerateStatus(generatedStore, def(), T0);
    expect(never.state).toBe("never-run");
    expect(never.snapshot).toBeNull();
    await runGenerateJob(
      registryWith(def()),
      { analyzedStore, generatedStore },
      JOB,
      { runId: "gen-1", nowMs: T0 + 60_000 },
    );
    const status = await buildGenerateStatus(generatedStore, def(), T0 + 120_000);
    expect(status.state).toBe("ready");
    expect(status.snapshot?.reportsPersisted).toBe(1);
    expect(status.snapshot?.formatsPersisted).toBe(4);
    expect(status.snapshot?.inputRunId).toBe("analyze-1");
    expect(status.snapshot?.reports[0]).toMatchObject({
      kind: "analysis",
      formatsGenerated: ["json", "markdown", "csv", "pdf"],
      formatsFailed: [],
      canonicalStatus: "not_wired",
    });
  });
});
