// @vitest-environment node
/**
 * Issue #5493 — the feed-family definition spec + its parameter binder.
 *
 * The feed family had no spec: every feed job is defined by the catalog
 * builder, which carries `{ feedJobId }` alone, so a feed input could not be
 * declared and `feed.pull`'s `universe` input had no production carrier.
 *
 * Pins:
 *  - 5493-P01 the `feed` spec exists: one `feed.pull` stage, its axes declared
 *    through the one vocabulary (#5515), its parameters declared with the
 *    axis each one names. A spec axis that is unknown, unknown-valued or
 *    conflated refuses by name — with the vocabulary's own code.
 *  - 5493-P02 a valid axis set binds end to end: binder → spec builder →
 *    engine run, with the bound universe actually driving the pull; a run
 *    with no optional parameters pulls its job's own universe, as today.
 *  - 5493-P03 an unknown provider/dataset/universe refuses by name with the
 *    vocabulary's code; a provider that does not serve the requested dataset
 *    refuses as a pair; undeclared/missing/out-of-range parameters refuse.
 *  - 5493-P04 a data-only addition (the `setVocabulary` seam) reaches the
 *    binder and the definition route's picker with no code change.
 *  - 5493-P05 no second list: the universe options a picker receives are the
 *    vocabulary's own (sector lists included), and the spec's step is the one
 *    FEED_PULL_STEP.
 */
import { afterEach, describe, expect, it } from "vitest";
import { JOB_DEFINITION_SPECS, jobDefinitionSpec, resolveJobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import {
  AXES,
  VOCABULARY_CODES,
  axisValueIds,
  getVocabulary,
  setVocabulary,
  type Vocabulary,
} from "../src/config/vocabulary";
import { handleJobDefinitionsRoutes } from "../src/agents/routes/jobDefinitions";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { bindJobDefinitionParams } from "../src/services/jobDefinitionParamBinders";
import { buildFeedJobRegistry, type FeedJobDefinition } from "../src/services/feedJobs";
import { FEED_PULL_STEP, createFeedStepRegistry } from "../src/services/feedPipelineJobs";
import { JobPipelineControl, jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading/dataProviders/contract";
import type { MarketDataResearchQuote } from "../src/types";

const T0 = Date.parse("2026-11-21T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const NASDAQ100 = ["AAPL", "MSFT"];
const SP100 = ["XOM", "JNJ"];

afterEach(() => setVocabulary(null));

function copyOf(vocab: Vocabulary): Vocabulary {
  return {
    version: vocab.version,
    defaults: { ...vocab.defaults },
    axes: Object.fromEntries(
      Object.entries(vocab.axes).map(([axis, entries]) => [axis, entries.map((e) => ({ ...e }))]),
    ) as Vocabulary["axes"],
    conflations: vocab.conflations.map((c) => ({ ...c })),
  };
}

function quote(symbol: string): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price: 100,
    lastPrice: 100,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

function fakeProvider(id: DataProvider["id"], batchCalls: string[][] = []): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      batchCalls.push([...symbols]);
      const result = [...NASDAQ100, ...SP100]
        .filter((symbol) => symbols.map((s) => s.toUpperCase()).includes(symbol))
        .map((symbol) => quote(symbol));
      return { providerId: id, capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
  };
}

async function makeHarness(batchCalls: string[][]) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const universes = new InMemoryIndexListStore();
  for (const [index, symbols] of [
    ["nasdaq100", NASDAQ100],
    ["sp100", SP100],
  ] as const) {
    await universes.store({
      index,
      snapshotDate: "2026-11-20",
      symbols: symbols.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "test list",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 24 * 3600_000),
    });
  }
  const registry = buildFeedJobRegistry({});
  const steps = createFeedStepRegistry({
    registry,
    providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId, batchCalls),
    universeStore: universes,
    datasetStore,
  });
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date(T0),
  });
  return { control, stores, datasetStore };
}

describe("5493-P01 the feed spec declares its axes and parameters", () => {
  it("is one feed.pull stage over the one step name, with its axes resolved", () => {
    expect(Object.keys(JOB_DEFINITION_SPECS)).toContain("feed");
    const spec = jobDefinitionSpec("feed");
    expect(spec.stages.map((stage) => stage.kind)).toEqual(["feed"]);
    expect(spec.stages[0].step).toBe(FEED_PULL_STEP);
    // The declared axes are canonical vocabulary ids, not free strings.
    expect(spec.axes).toEqual({ dataset: "quotes", universe: "nasdaq100" });
    for (const axis of Object.keys(spec.axes ?? {})) {
      expect([...AXES]).toContain(axis);
    }
    const byName = new Map((spec.parameters ?? []).map((param) => [param.name, param]));
    expect([...byName.keys()]).toEqual([
      "feedJobId",
      "universe",
      "sources",
      "dataset",
      "shards",
      "minDte",
      "maxDte",
    ]);
    expect(byName.get("feedJobId")?.required).toBe(true);
    expect(byName.get("universe")?.axis).toBe("universe");
    expect(byName.get("sources")?.type).toBe("multi-select");
    expect(byName.get("sources")?.axis).toBe("provider");
    expect(byName.get("sources")?.capabilityFrom).toBe("dataset");
    expect(byName.get("dataset")?.axis).toBe("dataset");
    expect(byName.get("shards")?.type).toBe("list");
    expect(byName.get("maxDte")?.atLeast).toBe("minDte");
    // A run with no optional parameters is legal: only the job id is required.
    expect((spec.parameters ?? []).filter((param) => param.required)).toHaveLength(1);
  });

  it("refuses an unknown axis, an unknown value and a conflation by name, with the code", () => {
    const base = {
      id: "x",
      name: "X",
      version: 1,
      stages: [{ kind: "feed", step: "feed.pull" }],
    };
    expect(() => resolveJobDefinitionSpec({ ...base, axes: { notAnAxis: "x" } })).toThrow(
      /not a vocabulary axis/,
    );
    expect(() => resolveJobDefinitionSpec({ ...base, axes: { dataset: "tickTape" } })).toThrow(
      new RegExp(`${VOCABULARY_CODES.unknownValue}: .*tickTape`),
    );
    expect(() => resolveJobDefinitionSpec({ ...base, axes: { provider: "moomoo" } })).toThrow(
      new RegExp(VOCABULARY_CODES.unknownValue),
    );
    expect(() => resolveJobDefinitionSpec({ ...base, axes: { universe: "TECH" } })).toThrow(
      new RegExp(`${VOCABULARY_CODES.notAValue}: .*sector-information-technology`),
    );
    // One source per parameter: an axis plus its own options is refused.
    expect(() =>
      resolveJobDefinitionSpec({
        ...base,
        parameters: [
          { name: "u", label: "U", type: "select", axis: "universe", options: ["sp100"] },
        ],
      }),
    ).toThrow(/one source per parameter/);
    // A cross-parameter rule may not name a parameter the spec lacks.
    expect(() =>
      resolveJobDefinitionSpec({
        ...base,
        parameters: [{ name: "maxDte", label: "Max", type: "number", atLeast: "minDte" }],
      }),
    ).toThrow(/does not declare/);
  });
});

describe("5493-P02 a valid axis set resolves end to end", () => {
  it("binds, builds and runs with the bound universe driving the pull", async () => {
    const spec = jobDefinitionSpec("feed");
    const bound = bindJobDefinitionParams(
      spec,
      {
        feedJobId: "yahoo-nasdaq100-quotes",
        universe: "SP100",
        sources: ["YAHOO"],
        dataset: "quotes",
        shards: ["s1"],
        minDte: 7,
        maxDte: 30,
      },
      "owner",
    );
    // Aliases bind to their canonical ids; the set is validated, not coerced.
    expect(bound).toMatchObject({
      userLogin: "owner",
      trigger: "scheduled",
      feedJobId: "yahoo-nasdaq100-quotes",
      universe: "sp100",
      sources: ["yahoo"],
      dataset: "quotes",
      shards: ["s1"],
      minDte: 7,
      maxDte: 30,
    });

    const config = buildJobConfigFromSpec(spec, "jobdef:feed:5493", bound);
    const step = (config.root as { steps: Array<{ step: string; params: Record<string, unknown> }> })
      .steps[0];
    expect(step.step).toBe(FEED_PULL_STEP);
    expect(step.params).toMatchObject({
      feedJobId: "yahoo-nasdaq100-quotes",
      universe: "sp100",
      sources: ["yahoo"],
    });

    const batchCalls: string[][] = [];
    const h = await makeHarness(batchCalls);
    await h.control.defineJob(config);
    const dispatch = await h.control.runJob("jobdef:feed:5493", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    // The bound universe is the one pulled — S&P 100's members, not the job's default.
    const artifact = await h.datasetStore.latest("yahoo", "quotes");
    expect(artifact?.universe.kind).toBe("index");
    expect(artifact?.universe.kind === "index" ? artifact.universe.index : null).toBe("sp100");
    expect(batchCalls.at(-1)).toEqual(SP100);
  });

  it("a run with no optional parameters binds only its job id and pulls the job's own universe", async () => {
    const spec = jobDefinitionSpec("feed");
    const bound = bindJobDefinitionParams(spec, { feedJobId: "yahoo-nasdaq100-quotes" }, "owner");
    expect(bound).toEqual({
      userLogin: "owner",
      trigger: "scheduled",
      feedJobId: "yahoo-nasdaq100-quotes",
    });

    const batchCalls: string[][] = [];
    const h = await makeHarness(batchCalls);
    await h.control.defineJob(buildJobConfigFromSpec(spec, "jobdef:feed:5493-default", bound));
    const dispatch = await h.control.runJob("jobdef:feed:5493-default", { trigger: "manual" });
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const artifact = await h.datasetStore.latest("yahoo", "quotes");
    expect(artifact?.universe.kind === "index" ? artifact.universe.index : null).toBe("nasdaq100");
    expect(batchCalls.at(-1)).toEqual(NASDAQ100);
  });
});

describe("5493-P03 unknown values refuse by name with the vocabulary's code", () => {
  const spec = () => jobDefinitionSpec("feed");
  const bind = (params: Record<string, unknown>) =>
    bindJobDefinitionParams(spec(), { feedJobId: "yahoo-nasdaq100-quotes", ...params }, "owner");

  it("refuses an unknown provider, dataset and universe by name", () => {
    expect(() => bind({ sources: ["moomoo"] })).toThrow(
      new RegExp(`${VOCABULARY_CODES.unknownValue}: .*moomoo`),
    );
    expect(() => bind({ dataset: "tickTape" })).toThrow(
      new RegExp(`${VOCABULARY_CODES.unknownValue}: .*tickTape`),
    );
    expect(() => bind({ universe: "SP900" })).toThrow(
      new RegExp(`${VOCABULARY_CODES.unknownValue}: .*SP900`),
    );
    // The refusal lists the axis's known values — the registry is the list.
    expect(() => bind({ universe: "SP900" })).toThrow(/nasdaq100/);
  });

  it("refuses a conflated value with the pointer to the axis it belongs to", () => {
    expect(() => bind({ universe: "TECH" })).toThrow(
      new RegExp(`${VOCABULARY_CODES.notAValue}: .*sector-information-technology`),
    );
    expect(() => bind({ universe: "nasdaq" })).toThrow(
      new RegExp(`${VOCABULARY_CODES.notAValue}: .*provider=nasdaq`),
    );
  });

  it("refuses a source that does not serve the requested dataset, as a pair", () => {
    // The listings provider declares screenUniverse only, never quotes.
    expect(() => bind({ sources: ["nasdaq"], dataset: "quotes" })).toThrow(
      new RegExp(`provider "nasdaq" does not serve "quotes" \\(${VOCABULARY_CODES.unsupportedPair}\\)`),
    );
  });

  it("reaches the API as a 400 with the code, never a host-unavailable 503", async () => {
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions/feed/define", {
        method: "POST",
        body: JSON.stringify({
          jobId: "jobdef:feed:5493",
          params: { feedJobId: "yahoo-nasdaq100-quotes", sources: ["moomoo"] },
        }),
      }),
      new URL("https://x/api/job-definitions/feed/define"),
      "/api/job-definitions/feed/define",
      {
        defineJobFromSpec: async (specId, jobId, params) => {
          bindJobDefinitionParams(jobDefinitionSpec(specId), params, "owner");
          return { jobId, name: "Feed", version: 1, stages: 1 };
        },
      },
    );
    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain(VOCABULARY_CODES.unknownValue);
    expect(body.error).toContain("moomoo");
  });

  it("refuses undeclared, missing, malformed and out-of-range parameters", () => {
    expect(() => bind({ nope: 1 })).toThrow(/does not declare the parameter "nope"/);
    expect(() => bindJobDefinitionParams(spec(), {}, "owner")).toThrow(
      /requires the "feedJobId" parameter/,
    );
    expect(() => bind({ shards: "s1" })).toThrow(/must be an array of strings/);
    expect(() => bind({ shards: [""] })).toThrow(/array of non-empty strings/);
    expect(() => bind({ minDte: -1 })).toThrow(/below its declared minimum 0/);
    expect(() => bind({ minDte: 30, maxDte: 7 })).toThrow(/is invalid: 7 is below "minDte" \(30\)/);
  });
});

describe("5493-P04 a data-only addition reaches the binder with no code change", () => {
  it("binds a provider and a universe the vocabulary gained through the seam", async () => {
    const spec = jobDefinitionSpec("feed");
    expect(axisValueIds("provider")).not.toContain("finnhub");
    const vocab = copyOf(getVocabulary());
    vocab.axes.provider = [...vocab.axes.provider, { id: "finnhub", label: "Finnhub", kind: "pure" }];
    vocab.axes.universe = [...vocab.axes.universe, { id: "sp900", label: "S&P 900", kind: "index" }];
    setVocabulary(vocab);

    const bound = bindJobDefinitionParams(
      spec,
      { feedJobId: "yahoo-nasdaq100-quotes", sources: ["FINNHUB"], universe: "SP900" },
      "owner",
    );
    expect(bound).toMatchObject({ sources: ["finnhub"], universe: "sp900" });
  });

  it("offers the added provider in the definition route's picker", async () => {
    const vocab = copyOf(getVocabulary());
    vocab.axes.provider = [...vocab.axes.provider, { id: "finnhub", label: "Finnhub", kind: "pure" }];
    setVocabulary(vocab);
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions"),
      new URL("https://x/api/job-definitions"),
      "/api/job-definitions",
      {},
    );
    const body = (await res!.json()) as {
      definitions: Array<{ id: string; parameters?: Array<{ name: string; options?: string[] }> }>;
    };
    const feed = body.definitions.find((entry) => entry.id === "feed")!;
    const sources = feed.parameters?.find((param) => param.name === "sources")!;
    expect(sources.options).toContain("finnhub");
  });
});

describe("5493-P05 no second list", () => {
  it("serves the universe options from the vocabulary, sector lists included", async () => {
    const res = await handleJobDefinitionsRoutes(
      new Request("https://x/api/job-definitions"),
      new URL("https://x/api/job-definitions"),
      "/api/job-definitions",
      {},
    );
    const body = (await res!.json()) as {
      definitions: Array<{ id: string; parameters?: Array<{ name: string; options?: string[] }> }>;
    };
    const universe = body.definitions
      .find((entry) => entry.id === "feed")!
      .parameters?.find((param) => param.name === "universe")!;
    expect(universe.options).toEqual(axisValueIds("universe"));
    expect(universe.options).toContain("sector-energy");
    expect(universe.options).toContain("russell1000");
  });
});
