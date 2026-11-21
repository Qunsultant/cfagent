// @vitest-environment node
/**
 * Issue #5494 (G7 of the #5272 programme) — a feed's provider+dataset is
 * resolved through ONE capability lookup built on the #5515 vocabulary.
 *
 * Before this slice the capture-wired feed factory selected a provider by
 * hand (`switch (def.sourceId)`), the dataset was a free string on the job
 * definition, and the batch-quotes requirement was a duck-typed method read.
 * Nothing could answer "does provider X serve dataset Y", so an unservable
 * pair was indistinguishable from an unwired host — and the honest answer
 * (refuse by name) had no data behind it.
 *
 * The pins below freeze the four things the issue asked for:
 *
 *   P01–P02  every provider/dataset pair the engine serves today resolves
 *            identically through the matrix (the pre-change set).
 *   P03      an unservable pair refuses with the coded message, naming BOTH
 *            axes — and no provider is substituted (never broker-for-broker,
 *            #5515).
 *   P04      a matrix entry added through the seam resolves (and builds)
 *            with no code change: providers × datasets is DATA.
 *   P05      the batch contract is matrix data, not a duck-typed method read.
 *   P06      the feed step refuses an unservable pair with the coded message.
 *   P07      an invalid matrix is refused on read and the previous registry
 *            stays in force (the #5880/#5515 validation idiom).
 *   P08      the matrix agrees with the provider contract vocabulary.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  VOCABULARY_CODES,
  getVocabulary,
  providerDatasetMatrix,
  resolveProviderDataset,
  setVocabulary,
  type Vocabulary,
} from "../src/config/vocabulary";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import { createCaptureWiredFeedProvider } from "../src/services/feedProviderWiring";
import {
  FEED_PIPELINE_CATALOG,
  FEED_PULL_STEP,
  createFeedStepRegistry,
} from "../src/services/feedPipelineJobs";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryProviderCaptureAdapter } from "../src/data/inMemoryProviderCaptureAdapter";
import {
  DATA_PROVIDER_CAPABILITIES,
  DATA_PROVIDER_IDS,
} from "../src/trading/dataProviders/contract";
import type { Env } from "../src/types";

afterEach(() => setVocabulary(null));

/** Deep-enough copy so a test can mutate the matrix without touching the live one. */
function copyOf(vocab: Vocabulary): Vocabulary {
  return {
    version: vocab.version,
    defaults: { ...vocab.defaults },
    axes: Object.fromEntries(
      Object.entries(vocab.axes).map(([axis, entries]) => [axis, entries.map((e) => ({ ...e }))]),
    ) as Vocabulary["axes"],
    conflations: vocab.conflations.map((c) => ({ ...c })),
    providerDatasets: vocab.providerDatasets.map((p) => ({ ...p })),
  };
}

/** The capture deps every feed adapter needs; the pair resolution is what is under test. */
function captureDeps() {
  return {
    env: {} as Env,
    capturePort: new InMemoryProviderCaptureAdapter(),
    blobStorage: { put: async () => {}, get: async () => undefined } as never,
  };
}

function feedDef(overrides: Partial<FeedJobDefinition>): FeedJobDefinition {
  return {
    id: "test-job",
    sourceId: "yahoo",
    dataset: "quotes",
    elements: ["quotes"],
    universe: { kind: "index", index: "nasdaq100", label: "Nasdaq-100" },
    cadenceMinutes: 60,
    staleAfterMinutes: 120,
    ...overrides,
  };
}

/** The pairs the pre-#5494 factory served (its switch's four branches × jobs). */
const SERVED_TODAY: Array<{ provider: string; dataset: string; capability: string }> = [
  { provider: "yahoo", dataset: "quotes", capability: "quotes" },
  { provider: "yahoo", dataset: "fundamentals", capability: "fundamentals" },
  { provider: "yahoo", dataset: "technicals", capability: "historicalBars" },
  { provider: "yahoo", dataset: "sentiment", capability: "news" },
  { provider: "etrade", dataset: "quotes", capability: "quotes" },
  { provider: "etrade", dataset: "options-chains", capability: "optionsChains" },
  { provider: "alpaca", dataset: "quotes", capability: "quotes" },
  { provider: "alpaca", dataset: "options-chains", capability: "optionsChains" },
  { provider: "public", dataset: "quotes", capability: "quotes" },
  { provider: "public", dataset: "options-chains", capability: "optionsChains" },
  // The listings provider's dataset is the stored universe job (#3535).
  { provider: "nasdaq", dataset: "universe", capability: "screenUniverse" },
];

describe("#5494 feed provider × dataset matrix", () => {
  it("P01 every registered feed job's pair resolves, and the capability is one the job declares", () => {
    const jobs = buildFeedJobRegistry({}).list();
    expect(jobs.length).toBeGreaterThan(10);
    for (const job of jobs) {
      const resolved = resolveProviderDataset(job.sourceId, job.dataset);
      expect(resolved.ok, `${job.id}: ${job.sourceId}×${job.dataset}`).toBe(true);
      if (!resolved.ok) continue;
      expect(job.elements, `${job.id} elements`).toContain(resolved.value.capability);
    }
    // The catalog's universe job is served too (the stored index list refresh).
    const universe = FEED_PIPELINE_CATALOG.find((e) => e.dataset === "universe")!;
    expect(resolveProviderDataset(universe.sourceId, universe.dataset)).toMatchObject({
      ok: true,
      value: { provider: "nasdaq", dataset: "screenUniverse", capability: "screenUniverse" },
    });
  });

  it("P02 every pair the engine serves today resolves identically (no behaviour change)", () => {
    for (const pair of SERVED_TODAY) {
      const resolved = resolveProviderDataset(pair.provider, pair.dataset);
      expect(resolved.ok, `${pair.provider}×${pair.dataset}`).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.value).toMatchObject({
        provider: pair.provider,
        capability: pair.capability,
      });
      // The store key is the DECLARED spelling, never the canonicalised one:
      // an artifact written under "technicals" is read under "technicals".
      expect(resolved.value.declaredDataset).toBe(pair.dataset);
    }
    // And the wiring still builds exactly the provider it built before.
    const capture = captureDeps();
    for (const pair of SERVED_TODAY) {
      if (pair.provider === "nasdaq") continue; // no capture-wired pull provider
      const provider = createCaptureWiredFeedProvider(
        feedDef({ sourceId: pair.provider as never, dataset: pair.dataset }),
        { ...capture, userLogin: "svc-test" },
      );
      expect(provider?.id, `${pair.provider}×${pair.dataset}`).toBe(pair.provider);
    }
    // A pair the matrix serves but this residency cannot construct (the
    // listings provider's stored-universe dataset) stays a named gap: the
    // factory returns undefined, never another provider.
    expect(
      createCaptureWiredFeedProvider(feedDef({ sourceId: "nasdaq", dataset: "universe" }), capture),
    ).toBeUndefined();
  });

  it("P03 an unservable pair refuses by name — code, both axes, and no substitute provider", () => {
    const cases: Array<[string, string]> = [
      ["nasdaq", "quotes"],
      ["etrade", "fundamentals"],
      ["yahoo", "optionsChains"],
      ["alpaca", "screenUniverse"],
    ];
    for (const [provider, dataset] of cases) {
      const resolved = resolveProviderDataset(provider, dataset);
      expect(resolved.ok, `${provider}×${dataset}`).toBe(false);
      if (resolved.ok) continue;
      expect(resolved.code).toBe(VOCABULARY_CODES.unsupportedPair);
      expect(resolved.message, "names the provider axis").toContain(provider);
      expect(resolved.message, "names the dataset axis").toContain(dataset);
      expect(resolved.message, "states the no-substitution rule").toMatch(/no substitute|never/i);
    }
    // An unknown value on either axis is not a pair refusal: it names the axis.
    const unknownProvider = resolveProviderDataset("finnhub", "quotes");
    expect(unknownProvider).toMatchObject({ ok: false, code: VOCABULARY_CODES.unknownValue });
    const unknownDataset = resolveProviderDataset("yahoo", "filings");
    expect(unknownDataset).toMatchObject({ ok: false, code: VOCABULARY_CODES.unknownValue });

    // The wiring refuses the pair too — it never falls back to another
    // provider that happens to serve the dataset (never broker-for-broker).
    const capture = captureDeps();
    expect(
      createCaptureWiredFeedProvider(feedDef({ sourceId: "nasdaq", dataset: "quotes" }), capture),
    ).toBeUndefined();
    expect(
      createCaptureWiredFeedProvider(feedDef({ sourceId: "yahoo", dataset: "options-chains" }), {
        ...capture,
        userLogin: "svc-test",
      }),
    ).toBeUndefined();
  });

  it("P04 data, not code: a matrix entry added through the seam resolves and builds", () => {
    const vocab = copyOf(getVocabulary());
    expect(resolveProviderDataset("yahoo", "filings").ok).toBe(false);
    vocab.axes.dataset = [
      ...vocab.axes.dataset,
      { id: "filings", label: "Filings", capability: "fundamentals" },
    ];
    vocab.providerDatasets = [
      ...vocab.providerDatasets,
      { provider: "yahoo", dataset: "filings", capability: "fundamentals", batch: false },
    ];
    setVocabulary(vocab);
    expect(resolveProviderDataset("yahoo", "filings")).toMatchObject({
      ok: true,
      value: { provider: "yahoo", dataset: "filings", capability: "fundamentals", batch: false },
    });
    // ... and the capture-wired factory builds it with no code change.
    const provider = createCaptureWiredFeedProvider(
      feedDef({ dataset: "filings", elements: ["fundamentals"] }),
      captureDeps(),
    );
    expect(provider?.id).toBe("yahoo");
  });

  it("P05 the batch contract is matrix data: quotes is batch, every other dataset is not", () => {
    for (const pair of providerDatasetMatrix()) {
      expect(pair.batch, `${pair.provider}×${pair.dataset}`).toBe(pair.dataset === "quotes");
    }
    // A dataset the matrix marks non-batch refuses through the runner's
    // capability check even when the adapter happens to carry the method.
    expect(resolveProviderDataset("yahoo", "fundamentals")).toMatchObject({
      ok: true,
      value: { batch: false },
    });
  });

  it("P06 the feed step refuses an unservable pair with the coded message, not a generic one", async () => {
    const { FeedJobRegistry } = await import("../src/services/feedJobs");
    const registry = new FeedJobRegistry();
    registry.register(feedDef({ id: "nasdaq-quotes", sourceId: "nasdaq", dataset: "quotes" }));
    const steps = createFeedStepRegistry({
      registry,
      providerFor: () => undefined,
      universeStore: new InMemoryIndexListStore(),
      datasetStore: new InMemoryFeedDatasetStore(),
    });
    await expect(
      steps.resolve(FEED_PULL_STEP)({
        jobId: "nasdaq-quotes",
        runId: "run-1",
        nodePath: "",
        kind: "feed",
        stepIndex: 0,
        item: null,
        itemIndex: null,
        items: [],
        shardKey: null,
        params: { feedJobId: "nasdaq-quotes" },
        input: null,
        now: "2026-11-21T00:00:00.000Z",
        trigger: "manual",
        runKind: "original",
      }),
    ).rejects.toThrow(
      new RegExp(`${VOCABULARY_CODES.unsupportedPair}.*nasdaq.*quotes|${VOCABULARY_CODES.unsupportedPair}`),
    );
  });

  it("P07 an invalid matrix is refused on read, and the previous registry stays in force", () => {
    const unknownProvider = copyOf(getVocabulary());
    unknownProvider.providerDatasets = [
      ...unknownProvider.providerDatasets,
      { provider: "finnhub", dataset: "quotes", capability: "quotes", batch: true },
    ];
    expect(() => setVocabulary(unknownProvider)).toThrow(/finnhub/);

    const duplicate = copyOf(getVocabulary());
    duplicate.providerDatasets = [
      ...duplicate.providerDatasets,
      { provider: "yahoo", dataset: "quotes", capability: "quotes", batch: true },
    ];
    expect(() => setVocabulary(duplicate)).toThrow(/twice|duplicate/i);

    const unknownDataset = copyOf(getVocabulary());
    unknownDataset.providerDatasets = [
      ...unknownDataset.providerDatasets,
      { provider: "yahoo", dataset: "filings", capability: "fundamentals", batch: false },
    ];
    expect(() => setVocabulary(unknownDataset)).toThrow(/filings/);

    expect(resolveProviderDataset("yahoo", "quotes").ok).toBe(true);
  });

  it("P08 the matrix agrees with the provider contract vocabulary", () => {
    for (const pair of providerDatasetMatrix()) {
      expect(DATA_PROVIDER_IDS as readonly string[]).toContain(pair.provider);
      expect(DATA_PROVIDER_CAPABILITIES as readonly string[]).toContain(pair.capability);
    }
  });
});
