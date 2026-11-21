// @vitest-environment node
/**
 * Issue #2863 (S3, narrowed) — replay pinning, criteria stamp.
 *
 * Re-homed in #5884 (6b3): the bespoke store stage leaves the
 * chain, so the criteria stamp's home is the generated
 * screener-report document — the generic chain's canonical
 * copy. The generate step stamps the run's validated criteria
 * (its filters) onto the document when the run screened on
 * filters, so report replay reads the criteria from persisted
 * data instead of marking the criteria gap partial.
 *
 * - With filters on the request, the generated document
 *   carries criteria.
 * - Without filters on the request, the document omits
 *   criteria — a run that screened on no filters never
 *   invents criteria at generate time.
 *
 * The replay READER does not yet accept the generated
 * document shape (`buildReplayFromRecord` gates on
 * `body.allStocks`; the document carries `rows`) — that is
 * a reader gap, filed as a follow-up (see the #5884 report),
 * not a stamp gap: the reader's criteria extraction already
 * reads `body.criteria` once the gate passes, and the stamp
 * this file pins is the document side of that contract.
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
} from "../src/services/jobPipelineEngine";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import {
  buildFeedJobRegistry as buildFeedRegistry,
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
import {
  buildScreenerJobDefinition,
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

function fakeProvider(id: DataProvider["id"]): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
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
    jobId: "screen-manual-2863",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [
      { shardId: "s0", symbols: [listing("AAPL"), listing("MSFT"), listing("NVDA"), listing("AMZN")] },
    ],
    provider: "yahoo",
    // The deliver leg degrades in the flip (6c owns it); the
    // criteria stamp is a generate-leg behavior, proven with
    // deliver skipped.
    deliver: false,
    ...over,
  };
}

const GENERATE_JOB_ID = "yahoo-nasdaq100-quotes-enrich-analyze-generate";

interface Harness {
  control: JobPipelineControl;
  generatedStore: InMemoryGeneratedDatasetStore;
}

async function makeHarness(): Promise<Harness> {
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
  storage.map.set("screener:owner-login", "owner");
  const agent = new ScreenerAgent({ storage } as any, {} as any);
  const shardsFor = async (jobId: string) =>
    (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [];
  const screenerDeps: ScreenerStepDeps = {
    agentFor: () => agent as never,
    quoteDepsFor: () => ({
      yahoo: { fetchYahooQuote: async (s: string) => quote(s) },
    }),
    historyDepsFor: () => ({ fetchBars: async () => [] }),
    storeReport: async () => {},
    deliverOutcome: async () => {},
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(
      {
        registry: buildFeedRegistry({}),
        providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId),
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
        // sink — without it the run fails
        // DELIVER_SCREENER_SINK_NOT_CONFIGURED.
        screenerDeliverOutcome: screenerDeps.deliverOutcome,
      },
      screenerDeps,
    ),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  return { control, generatedStore };
}

async function dispatch(command: WorkflowJobCommand): Promise<Record<string, unknown>> {
  const h = await makeHarness();
  await h.control.defineJob(buildScreenerJobDefinition(command));
  const dispatch = await h.control.runJob(command.jobId);
  const outcome = await dispatch.completion!;
  expect(outcome.state).toBe("completed");
  const artifact = await h.generatedStore.latestUsable(GENERATE_JOB_ID);
  expect(artifact).toBeTruthy();
  const report = artifact!.reports.find((r) => r.kind === "screener-report");
  expect(report).toBeTruthy();
  const json = report!.formats.find((f) => f.format === "json");
  expect(json?.status).toBe("generated");
  expect(json?.bodyText).toBeTruthy();
  return JSON.parse(json!.bodyText!) as Record<string, unknown>;
}

const FILTERS = { sector: "ALL", minPrice: 5 };

describe("generate stage stamps criteria (#2863 S3, re-homed #5884)", () => {
  it("stamps the run request filters onto the generated document", async () => {
    const document = await dispatch(marketCommand({ filters: FILTERS as any }));
    expect(document.criteria).toEqual(FILTERS);
  });

  it("omits criteria when the request has no filters — never invents them", async () => {
    const document = await dispatch(marketCommand());
    expect("criteria" in document).toBe(false);
  });
});
