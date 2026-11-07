// @vitest-environment node
/**
 * Issue #3537 (Pipeline J4) — the analyze service: deterministic
 * rule sets over PERSISTED enriched artifacts (never a fetch),
 * the honesty rule (a rule set the persisted features cannot
 * support is recorded unavailable with a coded reason — never
 * a fabricated verdict), the fail-closed input rule
 * (ANALYZE_INPUT_MISSING with the failed run recorded, one run
 * one id), configuration refused by name (unknown rule set /
 * threshold), and the composite over available components only.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYZE_JOB_CODES,
  AnalyzeJobError,
  AnalyzeJobRegistry,
  buildAnalyzeJobRegistry,
  buildAnalyzeStatus,
  computeAnalysis,
  resolveAnalyzeThresholds,
  runAnalyzeJob,
  validateAnalyzeRuleSets,
  type AnalyzeJobDefinition,
} from "../src/services/analyzeJobs";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import type {
  EnrichedDatasetArtifact,
  EnrichedDatasetStoreInput,
} from "../src/data/enrichedDatasetPorts";
import type { DataProviderId, IndexId } from "../src/trading";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
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
    ruleSets: ["momentum", "range", "volume", "value"],
    cadenceMinutes: 60,
    staleAfterMinutes: 180,
    ...overrides,
  };
}

function enrichedInput(
  runId: string,
  atMs: number,
  overrides: Partial<EnrichedDatasetStoreInput> = {},
): EnrichedDatasetStoreInput {
  return {
    jobId: ENRICH_JOB,
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
    inputArtifactId: `feed-${runId}`,
    inputRunId: `feed-run-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    elements: ["momentum", "rangePosition52w", "relativeVolume", "valueZone"],
    gaps: [],
    elementCoverage: {},
    rows: [
      {
        symbol: "AAPL",
        lastPrice: 110,
        features: {
          momentum: 6,
          rangePosition52w: 0.95,
          relativeVolume: 2.5,
          valueZone: "undervalued",
        },
        unavailable: [],
      },
      {
        symbol: "MSFT",
        lastPrice: 210,
        features: { momentum: -2, rangePosition52w: 0.4, relativeVolume: 0.5 },
        unavailable: ["valueZone"],
      },
      {
        symbol: "NVDA",
        lastPrice: 300,
        features: { momentum: 0.2, analystUpsidePercent: 30 },
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
      missingSymbols: [],
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs + 1000),
    ...overrides,
  };
}

function registryWith(d: AnalyzeJobDefinition): AnalyzeJobRegistry {
  const registry = new AnalyzeJobRegistry();
  registry.register(d);
  return registry;
}

describe("the rule-set vocabulary (#3537)", () => {
  it("refuses an unknown rule set by name", () => {
    expect(() => validateAnalyzeRuleSets(["momentum", "rsi"])).toThrowError(
      expect.objectContaining({ code: ANALYZE_JOB_CODES.ruleSetUnknown }),
    );
    expect(validateAnalyzeRuleSets(["momentum", "momentum", "value"])).toEqual([
      "momentum",
      "value",
    ]);
  });

  it("refuses an unknown threshold or a non-finite value by name", () => {
    expect(() => resolveAnalyzeThresholds({ rsiPeriod: 14 })).toThrowError(
      expect.objectContaining({ code: ANALYZE_JOB_CODES.thresholdUnknown }),
    );
    expect(() =>
      resolveAnalyzeThresholds({ strongMovePercent: Number.NaN }),
    ).toThrowError(
      expect.objectContaining({ code: ANALYZE_JOB_CODES.thresholdUnknown }),
    );
    const resolved = resolveAnalyzeThresholds({ strongMovePercent: 3 });
    expect(resolved.strongMovePercent).toBe(3);
    expect(resolved.mildMovePercent).toBe(1);
  });

  it("the built-in registry carries one analyze job per enrich job", () => {
    const registry = buildAnalyzeJobRegistry({});
    const jobs = registry.list();
    expect(jobs).toHaveLength(5);
    for (const job of jobs) {
      expect(job.id).toBe(`${job.enrichJobId}-analyze`);
      expect(job.ruleSets).toEqual(["momentum", "range", "volume", "value"]);
      expect(registry.forEnrichJob(job.enrichJobId)?.id).toBe(job.id);
    }
    expect(registry.get("yahoo-nasdaq100-quotes-enrich-analyze")).toBeTruthy();
  });

  it("env knobs externalize cadence, staleness and rule sets", () => {
    const registry = buildAnalyzeJobRegistry({
      ANALYZE_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_CADENCE_MINUTES: "15",
      ANALYZE_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_RULE_SETS: "momentum,value",
    });
    const job = registry.get("yahoo-nasdaq100-quotes-enrich-analyze");
    expect(job?.cadenceMinutes).toBe(15);
    expect(job?.ruleSets).toEqual(["momentum", "value"]);
  });
});

describe("the computation (#3537)", () => {
  it("computes signals, scores and the composite from persisted features", () => {
    const out = computeAnalysis({
      inputArtifact: enrichedInput("e1", T0) as unknown as EnrichedDatasetArtifact,
      ruleSets: ["momentum", "range", "volume", "value"],
      thresholds: resolveAnalyzeThresholds(),
    });
    const [aapl, msft, nvda] = out.rows;
    expect(aapl.signals).toEqual({
      momentum: "strong_up",
      range: "near_high",
      volume: "surge",
      value: "undervalued",
    });
    expect(aapl.scores.momentum).toBe(60);
    expect(aapl.scores.range).toBe(90);
    expect(aapl.scores.volume).toBe(100);
    expect(aapl.scores.value).toBe(50);
    expect(aapl.compositeScore).toBe(75);
    expect(aapl.unavailable).toEqual([]);
    // MSFT's enrich row recorded valueZone unavailable; the
    // value rule set is unavailable for it — never fabricated.
    expect(msft.signals.value).toBeUndefined();
    expect(msft.unavailable).toEqual(["value"]);
    expect(out.gaps).toContainEqual({
      ruleSet: "value",
      reason: "element_unavailable_in_input",
      symbols: ["MSFT"],
    });
    // NVDA carries no range/volume features at all (the enrich
    // job didn't compute them): a different coded reason.
    expect(nvda.unavailable).toEqual(["range", "volume"]);
    expect(out.gaps).toContainEqual({
      ruleSet: "range",
      reason: "feature_not_in_artifact",
      symbols: ["NVDA"],
    });
    expect(out.gaps).toContainEqual({
      ruleSet: "volume",
      reason: "feature_not_in_artifact",
      symbols: ["NVDA"],
    });
    // NVDA's value comes from the fundamentals join feature.
    expect(nvda.signals.value).toBe("deep_value");
    expect(nvda.scores.value).toBe(100);
    // Composite = the mean over the components that evaluated.
    expect(nvda.compositeScore).toBe((2 + 100) / 2);
    expect(out.ruleCoverage).toEqual({
      momentum: { evaluated: 3, unavailable: 0 },
      range: { evaluated: 2, unavailable: 1 },
      volume: { evaluated: 2, unavailable: 1 },
      value: { evaluated: 2, unavailable: 1 },
    });
    expect(out.summary.symbols).toBe(3);
    expect(out.summary.advancers).toBe(2);
    expect(out.summary.decliners).toBe(1);
    expect(out.summary.topByComposite[0]).toEqual({ symbol: "AAPL", score: 75 });
  });

  it("is deterministic: identical input + configuration ⇒ identical output", () => {
    const artifact = enrichedInput("e1", T0) as unknown as EnrichedDatasetArtifact;
    const a = computeAnalysis({
      inputArtifact: artifact,
      ruleSets: ["momentum", "range", "volume", "value"],
      thresholds: resolveAnalyzeThresholds(),
    });
    const b = computeAnalysis({
      inputArtifact: artifact,
      ruleSets: ["momentum", "range", "volume", "value"],
      thresholds: resolveAnalyzeThresholds(),
    });
    expect(b).toEqual(a);
  });

  it("thresholds are configuration: a configured strong-move bar reclassifies", () => {
    const out = computeAnalysis({
      inputArtifact: enrichedInput("e1", T0) as unknown as EnrichedDatasetArtifact,
      ruleSets: ["momentum"],
      thresholds: resolveAnalyzeThresholds({ strongMovePercent: 10 }),
    });
    expect(out.rows[0].signals.momentum).toBe("up");
  });
});

describe("the run service (#3537)", () => {
  it("refuses by name when no persisted input exists — and records the failed run", async () => {
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const result = await runAnalyzeJob(
      registryWith(def()),
      { enrichedStore, analyzedStore },
      JOB,
      { nowMs: T0, runId: "analyze-run-1" },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(ANALYZE_JOB_CODES.inputMissing);
    expect(result.artifactId).toBeTruthy();
    const recorded = await analyzedStore.latest(JOB);
    expect(recorded?.run.runId).toBe("analyze-run-1");
    expect(recorded?.run.status).toBe("failed");
    expect(recorded?.run.codedError).toBe(ANALYZE_JOB_CODES.inputMissing);
    // A failed run never becomes the usable snapshot.
    expect(await analyzedStore.latestUsable(JOB)).toBeUndefined();
  });

  it("analyzes end to end and persists lineage to the enriched artifact", async () => {
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const input = await enrichedStore.store(enrichedInput("e1", T0));
    const result = await runAnalyzeJob(
      registryWith(def()),
      { enrichedStore, analyzedStore },
      JOB,
      { nowMs: T0 + 60_000, runId: "analyze-run-2" },
    );
    expect(result.status).toBe("partial"); // MSFT/NVDA gaps
    expect(result.requested).toBe(3);
    expect(result.received).toBe(3);
    expect(result.inputArtifactId).toBe(input.id);
    expect(result.inputRunId).toBe("e1");
    const artifact = await analyzedStore.latest(JOB);
    expect(artifact?.inputArtifactId).toBe(input.id);
    expect(artifact?.inputRunId).toBe("e1");
    expect(artifact?.enrichJobId).toBe(ENRICH_JOB);
    expect(artifact?.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(artifact?.rows).toHaveLength(3);
    const status = await buildAnalyzeStatus(analyzedStore, def(), T0 + 120_000);
    expect(status.state).toBe("ready");
    expect(status.snapshot?.rowsPersisted).toBe(3);
    expect(status.snapshot?.summary.symbols).toBe(3);
  });

  it("a run over a failed enrich artifact refuses — latestUsable is the input rule", async () => {
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    await enrichedStore.store(
      enrichedInput("e-bad", T0, {
        rows: [],
        run: {
          runId: "e-bad",
          trigger: "manual",
          startedAt: iso(T0),
          finishedAt: iso(T0 + 1000),
          status: "failed",
          requested: 3,
          received: 0,
          failed: 3,
          missingSymbols: [],
          codedError: "ENRICH_INPUT_MISSING",
          errorMessage: "no input",
        },
      }),
    );
    const result = await runAnalyzeJob(
      registryWith(def()),
      { enrichedStore, analyzedStore },
      JOB,
      { nowMs: T0 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(ANALYZE_JOB_CODES.inputMissing);
  });

  it("throws for an unknown job id (a caller bug, the #3530 idiom)", async () => {
    await expect(
      runAnalyzeJob(
        registryWith(def()),
        {
          enrichedStore: new InMemoryEnrichedDatasetStore(),
          analyzedStore: new InMemoryAnalyzedDatasetStore(),
        },
        "no-such-job",
      ),
    ).rejects.toThrowError(
      expect.objectContaining({ code: ANALYZE_JOB_CODES.jobNotFound }),
    );
  });

  it("a shard partition analyzes only its symbols, lineage intact", async () => {
    const enrichedStore = new InMemoryEnrichedDatasetStore();
    const analyzedStore = new InMemoryAnalyzedDatasetStore();
    const input = await enrichedStore.store(enrichedInput("e1", T0));
    const result = await runAnalyzeJob(
      registryWith(def()),
      { enrichedStore, analyzedStore },
      JOB,
      { nowMs: T0, symbols: ["AAPL", "MSFT"] },
    );
    expect(result.requested).toBe(2);
    const artifact = await analyzedStore.latest(JOB);
    expect(artifact?.rows.map((r) => r.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(artifact?.inputArtifactId).toBe(input.id);
  });

  it("status of a never-run job is the named never-run state", async () => {
    const status = await buildAnalyzeStatus(
      new InMemoryAnalyzedDatasetStore(),
      def(),
      T0,
    );
    expect(status.state).toBe("never-run");
    expect(status.snapshot).toBeNull();
    expect(status.lastRun).toBeNull();
  });
});
