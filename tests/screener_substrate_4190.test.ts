// @vitest-environment node
/**
 * Issue #4190 ([One engine] #3550 S1) — the screener substrate:
 * the engine can define and dispatch a stock-screen job (five
 * generic nodes, 1:1 with the v2 catalog stages) in vitest,
 * producing a screen result. The new code is called only by tests; the
 * bespoke flow still runs production screens.
 *
 * - Job-definition builder: WorkflowJobCommand -> 5-node nested
 *   chain (jobId = command.jobId; processing.shards = command
 *   shard ids; goal leg on its own six-node goalScreen
 *   definition, #5873).
 * - Screener step registry + composition in BOTH residencies
 *   (host + workflow) through createPipelineStepRegistry.
 * - Engine proof (J7 pattern): a screener job defined +
 *   dispatched via the engine, producing a screen result —
 *   monolith (one shard) and sharded (two shards) shapes,
 *   plus the goal leg branching like runShardFlow.
 *   The deliver leg is flipped in 6c (#5885): the proof
 *   dispatches with deliver: true and the deliver node runs
 *   generic deliver.apply against the harness sink; the
 *   feed/enrich/analyze/generate legs and the run record are
 *   proven here alongside it.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  vocabularyStageForNodeKind,
} from "../src/services/jobPipelineEngine";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import {
  buildFeedJobRegistry,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import { ensureFeedPipelineJobs } from "../src/services/feedPipelineJobs";
import { ensureEnrichPipelineJobs } from "../src/services/enrichPipelineJobs";
import { ensureAnalyzePipelineJobs } from "../src/services/analyzePipelineJobs";
import { ensureGeneratePipelineJobs } from "../src/services/generatePipelineJobs";
import { ensureDeliverPipelineJobs } from "../src/services/deliverPipelineJobs";
import { FEED_PULL_STEP } from "../src/services/feedPipelineJobs";
import { ENRICH_SCREENER_STEP } from "../src/services/enrichPipelineJobs";
import { ANALYZE_SCREENER_STEP } from "../src/services/analyzePipelineJobs";
import { GENERATE_APPLY_STEP } from "../src/services/generatePipelineJobs";
import { DELIVER_APPLY_STEP } from "../src/services/deliverPipelineJobs";
import {
  SCREENER_ANALYSIS_STEP,
  SCREENER_DELIVER_STEP,
  SCREENER_FEED_STEP,
  SCREENER_GATHER_STEP,
  SCREENER_SERVE_STEP,
  SCREENER_STORE_STEP,
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
  ensureScreenerJob,
  screenerStepDepsForScheduledAgent,
  screenerStepDepsForWorkflow,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type {
  DataProvider,
  DataResult,
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
  NewsResult,
  QuoteResult,
} from "../src/types";

const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];
const PRICES: Record<string, number> = { AAPL: 150, MSFT: 300, NVDA: 180, AMZN: 200 };

function quote(symbol: string): MarketDataResearchQuote {
  const price = PRICES[symbol] ?? 100;
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: price - 1,
    high: price + 1,
    low: price - 2,
    previousClose: price - 1,
    timestamp: iso(T0),
  } as MarketDataResearchQuote;
}

function bars(): MarketDataResearchHistoricalBar[] {
  const out: MarketDataResearchHistoricalBar[] = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + i;
    out.push({
      provenance: "live",
      timestamp: iso(T0 - (30 - 1 - i) * 24 * 3600_000),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function listing(symbol: string) {
  return {
    symbol,
    companyName: `${symbol} Inc`,
    exchange: "NASDAQ" as const,
    change: 1,
    changePercent: 1,
  };
}

function marketCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "screen-manual-4190",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [
      { shardId: "s0", symbols: [listing("AAPL"), listing("MSFT"), listing("NVDA"), listing("AMZN")] },
    ],
    provider: "yahoo",
    deliver: true,
    ...over,
  };
}

function fakeProvider(id: DataProvider["id"], quoteCalls: string[]): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      quoteCalls.push(...symbols);
      const wanted = new Set(symbols.map((s) => s.toUpperCase()));
      const result = SYMBOLS.map((s) => quote(s)).filter((q) =>
        wanted.has(q.symbol.toUpperCase()),
      );
      return { providerId: id, capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
    getFundamentals: async (symbol: string) =>
      ({
        providerId: id,
        capability: "fundamentals",
        result: { symbol, marketCap: 1_000_000, peTrailing: 25 } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
    getHistoricalBars: async (symbol: string) => {
      const bars: MarketDataResearchHistoricalBar[] = [];
      for (let i = 0; i < 30; i++) {
        const close = 100 + i;
        bars.push({
          provenance: "live",
          timestamp: iso(T0 - (30 - 1 - i) * 24 * 3600_000),
          open: close - 0.5,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1_000_000,
        });
      }
      return {
        providerId: id,
        capability: "historicalBars",
        result: bars,
      } as DataResult<MarketDataResearchHistoricalBar[]>;
    },
    getNews: async (symbol: string) =>
      ({
        providerId: id,
        capability: "news",
        result: [
          {
            headline: `${symbol} reports quarterly results`,
            source: "Yahoo Finance",
            publishedAt: iso(T0),
            symbol,
          },
        ],
      }) as DataResult<NewsResult>,
  };
}

interface Harness {
  control: JobPipelineControl;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  runStore: InMemoryJobRunRecordStore;
  storage: FakeStorage;
  agent: ScreenerAgent;
  stored: unknown[];
  delivered: { payload: unknown; userLogin: string }[];
  yahooCalls: string[];
  barsCalls: string[];
  quoteCalls: string[];
  datasetStore: InMemoryFeedDatasetStore;
  enrichedStore: InMemoryEnrichedDatasetStore;
  analyzedStore: InMemoryAnalyzedDatasetStore;
  generatedStore: InMemoryGeneratedDatasetStore;
}

async function makeHarness(opts: {
  storeReport?: ScreenerStepDeps["storeReport"];
  deliverOutcome?: ScreenerStepDeps["deliverOutcome"];
  goalRunner?: ScreenerStepDeps["goalRunner"];
} = {}): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const universes = new InMemoryIndexListStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const storage = new FakeStorage();
  // The agent's recorded owner identity (issue #1185): persistRun
  // resolves it from storage, exactly as the csv test does —
  // production DOs carry it from their binding.
  storage.map.set("screener:owner-login", "owner");
  const agent = new ScreenerAgent({ storage } as any, {} as any);
  const stored: unknown[] = [];
  const delivered: { payload: unknown; userLogin: string }[] = [];
  const yahooCalls: string[] = [];
  const barsCalls: string[] = [];
  const quoteCalls: string[] = [];
  const shardsFor = async (jobId: string) =>
    (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [];
  const deps: ScreenerStepDeps = {
    agentFor: () => agent as never,
    quoteDepsFor: () => ({
      yahoo: {
        fetchYahooQuote: async (symbol: string) => {
          yahooCalls.push(symbol);
          return quote(symbol);
        },
      },
    }),
    historyDepsFor: () => ({
      fetchBars: async (symbol: string) => {
        barsCalls.push(symbol);
        return bars();
      },
    }),
    storeReport:
      opts.storeReport ??
      (async (payload) => {
        stored.push(payload);
      }),
    deliverOutcome:
      opts.deliverOutcome ??
      (async (payload, userLogin) => {
        delivered.push({ payload, userLogin });
      }),
    ...(opts.goalRunner ? { goalRunner: opts.goalRunner } : {}),
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(
      {
        registry: buildFeedJobRegistry({}),
        providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId, quoteCalls),
        universeStore: universes,
        datasetStore,
        shardsFor,
        indexRefresh: null,
      },
      { registry: buildEnrichJobRegistry({}), datasetStore, enrichedStore, shardsFor },
      { registry: buildAnalyzeJobRegistry({}), enrichedStore, analyzedStore, shardsFor },
      {
        registry: buildGenerateJobRegistry({}),
        analyzedStore,
        generatedStore,
        canonicalReportStore: null,
        shardsFor,
      },
      {
        registry: buildDeliverJobRegistry({}),
        generatedStore,
        deliveryStore,
        senders: {},
        shardsFor,
        // Issue #5885 (6c): the flipped deliver node runs
        // generic deliver.apply, so the harness must wire the
        // sink — without it a deliver: true dispatch throws
        // DELIVER_SCREENER_SINK_NOT_CONFIGURED and fails the
        // run (the step never falls back to the bespoke path).
        screenerDeliverOutcome: deps.deliverOutcome,
      },
      deps,
    ),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  return {
    control,
    stores,
    runStore,
    storage,
    agent,
    stored,
    delivered,
    yahooCalls,
    barsCalls,
    quoteCalls,
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
  };
}

describe("job-definition builder (#4190)", () => {
  it("builds a five-node nested chain, 1:1 with the v2 catalog stages", () => {
    const raw = buildScreenerJobDefinition(marketCommand()) as any;
    expect(raw.jobId).toBe("screen-manual-4190");
    const kinds: string[] = [];
    let node = raw.root;
    while (node) {
      kinds.push(node.kind);
      expect(node.children?.length ?? 0).toBeLessThanOrEqual(1);
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "generate", "deliver"]);
    expect(raw.root.steps).toEqual([
      { step: FEED_PULL_STEP, params: expect.objectContaining({ userLogin: "owner" }) },
    ]);
    const stepsByKind = new Map<string, string>();
    node = raw.root;
    while (node) {
      stepsByKind.set(node.kind, node.steps?.[0]?.step);
      node = node.children?.[0];
    }
    expect(Object.fromEntries(stepsByKind)).toEqual({
      feed: FEED_PULL_STEP,
      enrich: ENRICH_SCREENER_STEP,
      analyze: ANALYZE_SCREENER_STEP,
      generate: GENERATE_APPLY_STEP,
      // Issue #5885 (6c): the deliver node is flipped onto
      // generic deliver.apply — the bespoke screener.deliver
      // step no longer rides the market definition.
      deliver: DELIVER_APPLY_STEP,
    });
  });

  it("injects the per-command family job ids (provider yahoo)", () => {
    const raw = buildScreenerJobDefinition(marketCommand()) as any;
    const paramsByKind = new Map<string, Record<string, unknown>>();
    let node = raw.root;
    while (node) {
      paramsByKind.set(node.kind, node.steps?.[0]?.params);
      node = node.children?.[0];
    }
    expect(paramsByKind.get("feed")).toEqual(
      expect.objectContaining({ feedJobId: "yahoo-nasdaq100-quotes" }),
    );
    expect(paramsByKind.get("enrich")).toEqual(
      expect.objectContaining({ enrichJobId: "yahoo-nasdaq100-quotes-enrich" }),
    );
    expect(paramsByKind.get("analyze")).toEqual(
      expect.objectContaining({
        analyzeJobId: "yahoo-nasdaq100-quotes-enrich-analyze",
        ruleSets: ["screen", "factors"],
        inputMode: "handOff",
      }),
    );
    expect(paramsByKind.get("generate")).toEqual(
      expect.objectContaining({
        generateJobId: "yahoo-nasdaq100-quotes-enrich-analyze-generate",
        reports: ["screener-report"],
      }),
    );
  });

  it("carries the command shard ids as processing.shards on every node", () => {
    const raw = buildScreenerJobDefinition(
      marketCommand({
        shards: [
          { shardId: "s0", symbols: [listing("AAPL"), listing("NVDA")] },
          { shardId: "s1", symbols: [listing("MSFT"), listing("AMZN")] },
        ],
      }),
    ) as any;
    let node = raw.root;
    while (node) {
      expect(node.processing?.shards).toEqual(["s0", "s1"]);
      node = node.children?.[0];
    }
    expect(raw.root.executionMode?.shape).toBe("sharded");
  });

  it("is monolith with no shards, and the goal leg rides its own six-node goalScreen definition", () => {
    const goal = buildScreenerJobDefinition(
      marketCommand({
        jobId: "goal-4190",
        shards: [{ shardId: "s0", symbols: [listing("AAPL")] }],
        goalScreen: {
          scenario: { goalKind: "growth", direction: "long" } as any,
          scenarioSource: "built",
          symbols: ["AAPL"],
        },
      }),
    ) as any;
    let node = goal.root;
    const kinds: string[] = [];
    while (node) {
      kinds.push(node.kind);
      expect(node.steps?.[0]?.params).toEqual(
        expect.objectContaining({ goalScreen: expect.anything() }),
      );
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "store", "serve", "deliver"]);
    expect(goal.root.executionMode?.shape).toBe("monolith");
  });

  it("refuses a command without a job id by name, never a guessed id", () => {
    expect(() =>
      buildScreenerJobDefinition(marketCommand({ jobId: " " })),
    ).toThrow(/jobId/);
  });

  it("ensure defines once and reuses the stored definition", async () => {
    const h = await makeHarness();
    const first = await ensureScreenerJob(h.control, h.stores, marketCommand());
    expect(first).toBe("screen-manual-4190");
    const def1 = await h.stores.definitions.getDefinition("screen-manual-4190");
    const second = await ensureScreenerJob(h.control, h.stores, marketCommand());
    expect(second).toBe("screen-manual-4190");
    const def2 = await h.stores.definitions.getDefinition("screen-manual-4190");
    expect(def2?.version).toBe(def1?.version);
  });
});

describe("screener step registry (#4190)", () => {
  it("registers the six screener steps on the built-in registry", async () => {
    const h = await makeHarness();
    const registry = createScreenerStepRegistry({
      agentFor: () => h.agent as never,
      quoteDepsFor: () => ({
        yahoo: { fetchYahooQuote: async (s: string) => quote(s) },
      }),
      historyDepsFor: () => ({ fetchBars: async () => bars() }),
      storeReport: async () => {},
      deliverOutcome: async () => {},
    });
    for (const step of [
      SCREENER_FEED_STEP,
      SCREENER_GATHER_STEP,
      SCREENER_ANALYSIS_STEP,
      SCREENER_STORE_STEP,
      SCREENER_SERVE_STEP,
      SCREENER_DELIVER_STEP,
    ]) {
      expect(registry.has(step)).toBe(true);
    }
    expect(registry.has("noop")).toBe(true);
  });

  it("composes into the shared pipeline registry alongside the five families", async () => {
    const h = await makeHarness();
    const screenerDeps: ScreenerStepDeps = {
      agentFor: () => h.agent as never,
      quoteDepsFor: () => ({
        yahoo: { fetchYahooQuote: async (s: string) => quote(s) },
      }),
      historyDepsFor: () => ({ fetchBars: async () => bars() }),
      storeReport: async () => {},
      deliverOutcome: async () => {},
    };
    const registry = createPipelineStepRegistry(
      {
        registry: buildFeedJobRegistry({}),
        providerFor: () => undefined,
        universeStore: null,
        datasetStore: null,
      },
      { registry: buildEnrichJobRegistry({}), datasetStore: null, enrichedStore: null },
      { registry: buildAnalyzeJobRegistry({}), enrichedStore: null, analyzedStore: null },
      { registry: buildGenerateJobRegistry({}), analyzedStore: null, generatedStore: null },
      {
        registry: buildDeliverJobRegistry({}),
        generatedStore: null,
        deliveryStore: null,
        senders: {},
      },
      screenerDeps,
    );
    for (const step of [
      "feed.pull",
      "enrich.apply",
      "analyze.apply",
      "generate.apply",
      "deliver.apply",
      SCREENER_FEED_STEP,
      SCREENER_GATHER_STEP,
      SCREENER_ANALYSIS_STEP,
      SCREENER_STORE_STEP,
      SCREENER_SERVE_STEP,
      SCREENER_DELIVER_STEP,
    ]) {
      expect(registry.has(step)).toBe(true);
    }
  });

  it("without screener deps the screener steps stay unknown (named refusal)", () => {
    const registry = createPipelineStepRegistry(
      {
        registry: buildFeedJobRegistry({}),
        providerFor: () => undefined,
        universeStore: null,
        datasetStore: null,
      },
      { registry: buildEnrichJobRegistry({}), datasetStore: null, enrichedStore: null },
    );
    expect(() => registry.resolve(SCREENER_FEED_STEP)).toThrow(/Unknown job step/);
  });

  it("both residencies compose the screener steps (host + workflow)", async () => {
    const hostDeps = screenerStepDepsForScheduledAgent({ env: {} as any } as any);
    const workflowDeps = screenerStepDepsForWorkflow({} as any);
    for (const deps of [hostDeps, workflowDeps]) {
      const registry = createPipelineStepRegistry(
        {
          registry: buildFeedJobRegistry({}),
          providerFor: () => undefined,
          universeStore: null,
          datasetStore: null,
        },
        { registry: buildEnrichJobRegistry({}), datasetStore: null, enrichedStore: null },
        undefined,
        undefined,
        undefined,
        deps,
      );
      for (const step of [
        SCREENER_FEED_STEP,
        SCREENER_GATHER_STEP,
        SCREENER_ANALYSIS_STEP,
        SCREENER_STORE_STEP,
        SCREENER_SERVE_STEP,
        SCREENER_DELIVER_STEP,
      ]) {
        expect(registry.has(step)).toBe(true);
      }
    }
  });
});

describe("engine proof — market screen (#4190)", () => {
  it("defines + dispatches a screener job via the engine, producing a screen result", async () => {
    const h = await makeHarness();
    // Issue #5885 (6c): the deliver leg is flipped — the proof
    // dispatches with deliver: true (the marketCommand default)
    // and the deliver node runs generic deliver.apply against
    // the harness sink.
    const command = marketCommand();
    const definition = await h.control.defineJob(buildScreenerJobDefinition(command));
    expect(definition.jobId).toBe("screen-manual-4190");

    const dispatch = await h.control.runJob("screen-manual-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");

    // The feed fetched every symbol once through the fake provider.
    expect([...new Set(h.quoteCalls)].sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    expect(h.quoteCalls.sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);

    // Every generic leg persisted its artifact: the feed batch,
    // the enriched rows, the analyzed rows, the generated report.
    const feed = await h.datasetStore.latestUsable("yahoo", "quotes");
    expect(feed).toBeTruthy();
    expect(feed!.quotes.map((q) => q.symbol).sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    const enriched = await h.enrichedStore.latestUsable("yahoo-nasdaq100-quotes-enrich");
    expect(enriched).toBeTruthy();
    const analyzed = await h.analyzedStore.latestUsable(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    expect(analyzed).toBeTruthy();
    expect(analyzed!.rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    const generated = await h.generatedStore.latestUsable(
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
    );
    expect(generated).toBeTruthy();
    expect(generated!.reports.map((r) => r.kind)).toContain("screener-report");

    // Delivery ran through the flipped node: one sink call
    // carrying the converter payload for the run's document —
    // the generic shape (no matchedCount, no artifact keys),
    // and no canonical report id (this harness leaves the
    // canonical seam unwired).
    expect(h.delivered).toHaveLength(1);
    const delivered = h.delivered[0]?.payload as Record<string, unknown>;
    expect(h.delivered[0]?.userLogin).toBe("owner");
    expect(delivered?.success).toBe(true);
    expect(delivered?.totalScanned).toBe(4);
    expect(delivered?.universe).toBe("Nasdaq-100");
    expect(delivered).not.toHaveProperty("matchedCount");
    expect(delivered).not.toHaveProperty("canonicalReportId");

    // The run is on the platform run-record machinery, as the screener job.
    expect(h.runStore.listByJob("screen-manual-4190")).toHaveLength(1);
    expect(h.runStore.listByJob("screen-manual-4190")[0]?.outcome).toBe("success");
  });

  it("partitions symbols across shards with no symbol screened twice", async () => {
    const h = await makeHarness();
    const command = marketCommand({
      jobId: "screen-sharded-4190",
      deliver: false,
      shards: [
        { shardId: "s0", symbols: [listing("AAPL"), listing("NVDA")] },
        { shardId: "s1", symbols: [listing("MSFT"), listing("AMZN")] },
      ],
    });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("screen-sharded-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.quoteCalls.sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    expect(h.delivered).toHaveLength(0);
    const generated = await h.generatedStore.latestUsable(
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
    );
    expect(generated).toBeTruthy();
    expect(h.runStore.listByJob("screen-sharded-4190")[0]?.outcome).toBe("success");
  });

  // Issue #5884 (6b3): the store-refusal test is REMOVED — its
  // subject, the bespoke store step, leaves the chain in the
  // flip, so there is no store leg to refuse. The canonical-leg
  // refusal belongs to the generate family: its tests own the
  // generate-run failure shape (a failed generate run fails
  // the pipeline run with the same coded error).

  it("a deliver refusal is recorded, never a failed run (the flow's rule)", async () => {
    const h = await makeHarness({
      deliverOutcome: async () => {
        throw new Error("delivery down");
      },
    });
    await h.control.defineJob(buildScreenerJobDefinition(marketCommand()));
    const dispatch = await h.control.runJob("screen-manual-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.delivered).toHaveLength(0);
    // The refusal is recorded on the deliver node's output
    // (the deliver node is the chain's fifth node, path
    // 0/0/0/0) — never a failed run.
    const view = await h.control.getJob("screen-manual-4190");
    const runId = view.instance?.currentRunId;
    expect(runId).toBeTruthy();
    const deliverOutput = (await h.stores.artifacts.getArtifact(
      runId!,
      "0/0/0/0/stage-output",
    )) as Record<string, unknown>;
    expect(deliverOutput?.deliverError).toContain("delivery down");
    expect(deliverOutput?.delivered).toBe(false);
  });

  it("the five node kinds address the five catalog stages (the #3945 1:1)", async () => {
    const h = await makeHarness();
    await h.control.defineJob(buildScreenerJobDefinition(marketCommand()));
    expect(vocabularyStageForNodeKind("feed")).toBe("feed");
    expect(vocabularyStageForNodeKind("enrich")).toBe("gather");
    expect(vocabularyStageForNodeKind("analyze")).toBe("analysis");
    expect(vocabularyStageForNodeKind("generate")).toBe("analysis");
    expect(vocabularyStageForNodeKind("deliver")).toBe("deliver");
    const view = await h.control.getJob("screen-manual-4190");
    const kinds = (view?.definition.root
      ? (function walk(node: any, acc: string[]): string[] {
          acc.push(node.kind);
          for (const child of node.children ?? []) walk(child, acc);
          return acc;
        })(view.definition.root, [])
      : []);
    expect(kinds).toEqual(["feed", "enrich", "analyze", "generate", "deliver"]);
  });
});

describe("engine proof — goal leg (#4190)", () => {
  it("runs the goal runner on the same six nodes, never the market runner", async () => {
    const goalCalls: unknown[] = [];
    const h = await makeHarness({
      goalRunner: async (req: any) => {
        goalCalls.push(req);
        return {
          task: { id: "goal-task-4190" },
          executed: true,
          result: {
            scenario: req.scenario,
            success: true,
            counts: {
              stocksScanned: 1,
              stocksMatched: 1,
              optionsUnderlyingsScanned: 0,
              optionsContractsMatched: 0,
              hits: 0,
            },
            opportunities: [],
            allStocks: [],
          },
        };
      },
    });
    const command = marketCommand({
      jobId: "goal-4190",
      goalScreen: {
        scenario: { goalKind: "growth", direction: "long" } as any,
        scenarioSource: "built",
        symbols: ["AAPL"],
      },
    });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    // The goal runner ran once, with the feed-derived symbols.
    expect(goalCalls).toHaveLength(1);
    expect((goalCalls[0] as any)?.symbols).toEqual(["AAPL"]);
    // The market quote path never ran for a goal command.
    expect(h.yahooCalls).toEqual([]);
    // The goal store + deliver doors ran.
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });
});
