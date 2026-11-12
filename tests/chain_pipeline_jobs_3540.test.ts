// @vitest-environment node
/**
 * Issue #3540 (Pipeline J7) — the composed pipeline chains:
 * registry derivation, catalog + name resolution, derived J1
 * definitions, schedule registration, and the end-to-end
 * status roll-up.
 *
 * The chain is ONE J1 job per quotes lineage whose children
 * are the stage jobs' own root nodes (schedules stripped, the
 * chain root carrying the one chain schedule). The roll-up is
 * composed from the chain job's status view + the stage jobs'
 * own status views — no new persistence.
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
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { resolveJobDefinition } from "../src/services/jobPipelineConfig";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import {
  buildFeedJobRegistry as buildFeedRegistry,
  YAHOO_NASDAQ100_SENTIMENT_JOB_ID,
  YAHOO_NASDAQ100_TECHNICALS_JOB_ID,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import {
  ensureFeedPipelineJobs,
  type FeedStepDeps,
} from "../src/services/feedPipelineJobs";
import {
  createPipelineStepRegistry,
  ensureEnrichPipelineJobs,
  type EnrichStepDeps,
} from "../src/services/enrichPipelineJobs";
import {
  ensureAnalyzePipelineJobs,
  type AnalyzeStepDeps,
} from "../src/services/analyzePipelineJobs";
import {
  ensureGeneratePipelineJobs,
  type GenerateStepDeps,
} from "../src/services/generatePipelineJobs";
import {
  ensureDeliverPipelineJobs,
  type DeliverStepDeps,
} from "../src/services/deliverPipelineJobs";
import {
  buildPipelineChainRegistry,
  chainStageNodePath,
} from "../src/services/pipelineChains";
import {
  CHAIN_PIPELINE_CATALOG,
  buildAllChainPipelineJobDefinitions,
  buildChainSurfaceView,
  ensureChainPipelineJobs,
  resolvePipelineChain,
} from "../src/services/chainPipelineJobs";
import type {
  DataProvider,
  DataResult,
  NewsResult,
  QuoteResult,
} from "../src/trading/dataProviders/contract";
import type {
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
} from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];
const FEED_ID = "yahoo-nasdaq100-quotes";
const FUND_ID = "yahoo-nasdaq100-fundamentals";
const TECH_ID = YAHOO_NASDAQ100_TECHNICALS_JOB_ID;
const SENT_ID = YAHOO_NASDAQ100_SENTIMENT_JOB_ID;
const ENRICH_ID = `${FEED_ID}-enrich`;
const ANALYZE_ID = `${ENRICH_ID}-analyze`;
const GENERATE_ID = `${ANALYZE_ID}-generate`;
const DELIVER_ID = `${GENERATE_ID}-deliver`;
const CHAIN_ID = `${FEED_ID}-pipeline`;

function quote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
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
    // #3931: the technicals node pulls daily bars through the
    // historicalBars capability — 30 live bars, closes 100..129.
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
    // #3932: the sentiment node pulls headlines through the
    // news capability — one fixture headline per symbol. No AI
    // binding in this harness, so the rows persist unclassified
    // (method "unavailable") and the job still completes.
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
  stores: JobPipelineStores;
  deliveryStore: InMemoryDeliveryDatasetStore;
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
  for (const index of ["nasdaq100", "sp100"] as const) {
    await universes.store({
      index,
      snapshotDate: "2026-11-02",
      symbols: SYMBOLS.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (index table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
  }
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const feedDeps: FeedStepDeps = {
    registry: buildFeedRegistry({}),
    providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId),
    universeStore: universes,
    datasetStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
    indexRefresh: null,
  };
  const enrichDeps: EnrichStepDeps = {
    registry: buildEnrichJobRegistry({}),
    datasetStore,
    enrichedStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const analyzeDeps: AnalyzeStepDeps = {
    registry: buildAnalyzeJobRegistry({}),
    enrichedStore,
    analyzedStore,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const generateDeps: GenerateStepDeps = {
    registry: buildGenerateJobRegistry({}),
    analyzedStore,
    generatedStore,
    canonicalReportStore: null,
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const deliverDeps: DeliverStepDeps = {
    registry: buildDeliverJobRegistry({}),
    generatedStore,
    deliveryStore,
    senders: {
      slack: async () => ({ ok: true }),
      email: async () => ({ ok: true }),
      webhook: async () => ({ ok: true, target: "hooks.example.com" }),
    },
    shardsFor: async (jobId) =>
      (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [],
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(feedDeps, enrichDeps, analyzeDeps, generateDeps, deliverDeps),
    now: () => new Date(T0),
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  await ensureChainPipelineJobs(control, stores, {});
  return { control, stores, deliveryStore };
}

describe("pipeline chain registry + catalog (#3540)", () => {
  it("derives one chain per quotes lineage, with the fundamentals node from the enrich join", () => {
    const registry = buildPipelineChainRegistry({});
    expect(registry.list().map((c) => c.id)).toEqual([
      "yahoo-nasdaq100-quotes-pipeline",
      "yahoo-sp100-quotes-pipeline",
      "yahoo-sp500-quotes-pipeline",
      "yahoo-dow-quotes-pipeline",
      "yahoo-sp400-quotes-pipeline",
      "yahoo-sector-energy-quotes-pipeline",
      "yahoo-sector-materials-quotes-pipeline",
      "yahoo-sector-industrials-quotes-pipeline",
      "yahoo-sector-consumer-discretionary-quotes-pipeline",
      "yahoo-sector-consumer-staples-quotes-pipeline",
      "yahoo-sector-health-care-quotes-pipeline",
      "yahoo-sector-financials-quotes-pipeline",
      "yahoo-sector-information-technology-quotes-pipeline",
      "yahoo-sector-communication-services-quotes-pipeline",
      "yahoo-sector-utilities-quotes-pipeline",
      "yahoo-sector-real-estate-quotes-pipeline",
      "alpaca-nasdaq100-quotes-pipeline",
      "etrade-nasdaq100-quotes-pipeline",
      "public-nasdaq100-quotes-pipeline",
    ]);
    const yahoo = registry.forId(CHAIN_ID)!;
    expect(yahoo.fundamentalsJobId).toBe(FUND_ID);
    expect(yahoo.technicalsJobId).toBe(TECH_ID);
    // #3932: and the parameterized sentiment node, the same way.
    expect(yahoo.sentimentJobId).toBe(SENT_ID);
    expect(yahoo.nodes.map((n) => n.jobId)).toEqual([
      FEED_ID,
      FUND_ID,
      TECH_ID,
      SENT_ID,
      ENRICH_ID,
      ANALYZE_ID,
      GENERATE_ID,
      DELIVER_ID,
    ]);
    expect(yahoo.nodes.map((n) => n.nodePath)).toEqual([
      "",
      "0",
      "0/0",
      "0/0/0",
      "0/0/0/0",
      "0/0/0/0/0",
      "0/0/0/0/0/0",
      "0/0/0/0/0/0/0",
    ]);
    expect(chainStageNodePath(yahoo, "feed")).toBe("");
    expect(chainStageNodePath(yahoo, "enrich")).toBe("0/0/0/0");
    expect(chainStageNodePath(yahoo, "deliver")).toBe("0/0/0/0/0/0/0");
    const alpaca = registry.forId("alpaca-nasdaq100-quotes-pipeline")!;
    // #3930: every chain folds the parameterized fundamentals
    // node in — the alpaca chain's fundamentals node runs the
    // same job with the chain's universe as its input.
    expect(alpaca.fundamentalsJobId).toBe(FUND_ID);
    // #3931: and the parameterized technicals node, the same way.
    expect(alpaca.technicalsJobId).toBe(TECH_ID);
    // #3932: and the parameterized sentiment node, the same way.
    expect(alpaca.sentimentJobId).toBe(SENT_ID);
    expect(alpaca.nodes).toHaveLength(8);
    expect(alpaca.nodes.map((n) => n.jobId)).toEqual([
      "alpaca-nasdaq100-quotes",
      FUND_ID,
      TECH_ID,
      SENT_ID,
      "alpaca-nasdaq100-quotes-enrich",
      "alpaca-nasdaq100-quotes-enrich-analyze",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate",
      "alpaca-nasdaq100-quotes-enrich-analyze-generate-deliver",
    ]);
    expect(chainStageNodePath(alpaca, "deliver")).toBe("0/0/0/0/0/0/0");
    expect(registry.forStageJob(DELIVER_ID)?.id).toBe(CHAIN_ID);
    expect(registry.forFeedJob(FEED_ID)?.id).toBe(CHAIN_ID);
  });

  it("resolves names in the family idiom and refuses ambiguous/unknown names", () => {
    expect(CHAIN_PIPELINE_CATALOG).toHaveLength(19);
    expect(resolvePipelineChain(CHAIN_ID)?.jobId).toBe(CHAIN_ID);
    expect(resolvePipelineChain("yahoo nasdaq100 pipeline")?.jobId).toBe(CHAIN_ID);
    expect(resolvePipelineChain("yahoo-nasdaq100-pipeline")?.jobId).toBe(CHAIN_ID);
    expect(resolvePipelineChain("alpaca pipeline")?.jobId).toBe(
      "alpaca-nasdaq100-quotes-pipeline",
    );
    // The feed catalog's exact-unique bare "yahoo" (the Nasdaq-100
    // quotes job) inherits here, exactly as in every family.
    expect(resolvePipelineChain("yahoo pipeline")?.jobId).toBe(CHAIN_ID);
    expect(resolvePipelineChain("pipeline")).toBeNull();
    expect(resolvePipelineChain("bitcoin pipeline")).toBeNull();
  });

  it("the chain cadence knob overrides the head feed job's cadence", () => {
    const registry = buildPipelineChainRegistry({
      PIPELINE_CHAIN_YAHOO_NASDAQ100_QUOTES_PIPELINE_CADENCE_MINUTES: "15",
    });
    expect(registry.forId(CHAIN_ID)?.cadenceMinutes).toBe(15);
    expect(registry.forId("alpaca-nasdaq100-quotes-pipeline")?.cadenceMinutes).toBe(60);
  });
});

describe("pipeline chain definitions (#3540)", () => {
  it("every chain definition resolves as a valid J1 job composed of the stage jobs' own nodes", () => {
    const raws = buildAllChainPipelineJobDefinitions({});
    expect(raws).toHaveLength(19);
    for (const raw of raws) {
      const resolved = resolveJobDefinition(raw);
      expect(resolved.root.kind).toBe("feed");
      expect(resolved.config.schedule.enabled).toBe(true);
      expect(resolved.config.schedule.interval).toBe("every 60 minutes");
      // Only the root (the feed stage) carries a schedule — the
      // chain's cadence; every nested stage's own schedule is
      // stripped (the stage jobs keep theirs on their own
      // definitions).
      let node: typeof resolved.root | undefined = resolved.root.children?.[0];
      while (node) {
        expect(node.schedule).toBeUndefined();
        node = node.children?.[0];
      }
    }
    const yahoo = resolveJobDefinition(
      buildAllChainPipelineJobDefinitions({}).find(
        (r) => (r as { jobId: string }).jobId === CHAIN_ID,
      ),
    );
    // Walk the nesting: feed (root) → fundamentals → technicals
    // → sentiment → enrich → analyze → generate → deliver, each
    // the single child of the stage before it.
    const kinds: string[] = [];
    const steps: Array<string | undefined> = [];
    const params: Array<unknown> = [];
    let node: typeof yahoo.root | undefined = yahoo.root;
    while (node) {
      kinds.push(node.kind);
      steps.push(node.steps?.[0]?.step);
      params.push(node.steps?.[0]?.params);
      node = node.children?.[0];
    }
    expect(kinds).toEqual([
      "feed",
      "feed",
      "feed",
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
    ]);
    expect(steps).toEqual([
      "feed.pull",
      "feed.pull",
      "feed.pull",
      "feed.pull",
      "enrich.apply",
      "analyze.apply",
      "generate.apply",
      "deliver.apply",
    ]);
    // The nodes carry the stage jobs' own step params — derived, never forked.
    expect(params[0]).toMatchObject({ feedJobId: FEED_ID });
    expect(params[1]).toMatchObject({ feedJobId: FUND_ID });
    expect(params[2]).toMatchObject({ feedJobId: TECH_ID });
    expect(params[3]).toMatchObject({ feedJobId: SENT_ID });
    expect(params[7]).toMatchObject({ deliverJobId: DELIVER_ID });
  });

  it("ensure is idempotent and registerSchedules declares the whole plane (121)", async () => {
    const h = await makeHarness();
    const first = await h.stores.definitions.getDefinition(CHAIN_ID);
    await ensureChainPipelineJobs(h.control, h.stores, {});
    const second = await h.stores.definitions.getDefinition(CHAIN_ID);
    expect(second?.version).toBe(first?.version);
    const registrations = await h.control.registerSchedules({
      schedule: async (spec) => `reg:${spec.jobId}:${spec.nodePath}`,
    });
    // #3932: one more job on the plane — the parameterized
    // sentiment job (one definition, folded into every chain).
    // #4065 pin update: three options-chains jobs join the plane.
    expect(registrations).toHaveLength(121);
    const chainRegs = registrations.filter((r) => r.jobId.endsWith("-pipeline"));
    expect(chainRegs).toHaveLength(19);
    expect(chainRegs.every((r) => r.nodePath === "")).toBe(true);
  });
});

describe("pipeline chain status roll-up (#3540)", () => {
  it("a never-run chain answers with frontier=feed and per-stage not-run states", async () => {
    const h = await makeHarness();
    const registry = buildPipelineChainRegistry({});
    const chain = registry.forId(CHAIN_ID)!;
    const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === CHAIN_ID)!;
    const stagePipelines: Record<string, Awaited<ReturnType<JobPipelineControl["getJob"]>>> = {};
    for (const node of chain.nodes) {
      stagePipelines[node.jobId] = await h.control.getJob(node.jobId);
    }
    const view = buildChainSurfaceView({
      entry,
      chain,
      pipeline: await h.control.getJob(CHAIN_ID),
      stagePipelines,
      nowMs: T0,
    });
    expect(view.pipeline?.state).toBe("idle");
    expect(view.frontier).toBe("feed");
    expect(view.stages.map((s) => s.status)).toEqual([
      "not-run",
      "not-run",
      "not-run",
      "not-run",
      "not-run",
    ]);
    expect(view.stages.map((s) => s.jobId)).toEqual([
      FEED_ID,
      ENRICH_ID,
      ANALYZE_ID,
      GENERATE_ID,
      DELIVER_ID,
    ]);
    expect(view.nextScheduledRun).toBeNull();
  });

  it("a completed chain run rolls up to all-completed stages and no frontier", async () => {
    const h = await makeHarness();
    const dispatch = await h.control.runJob(CHAIN_ID);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    const registry = buildPipelineChainRegistry({});
    const chain = registry.forId(CHAIN_ID)!;
    const entry = CHAIN_PIPELINE_CATALOG.find((e) => e.jobId === CHAIN_ID)!;
    const stagePipelines: Record<string, Awaited<ReturnType<JobPipelineControl["getJob"]>>> = {};
    for (const node of chain.nodes) {
      stagePipelines[node.jobId] = await h.control.getJob(node.jobId);
    }
    const view = buildChainSurfaceView({
      entry,
      chain,
      pipeline: await h.control.getJob(CHAIN_ID),
      stagePipelines,
      nowMs: T0,
    });
    expect(view.pipeline?.lastRunStatus).toBe("success");
    expect(view.frontier).toBeNull();
    expect(view.stages.map((s) => s.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(view.nextScheduledRun).not.toBeNull();
    const artifact = await h.deliveryStore.latestUsable(DELIVER_ID);
    expect(artifact?.run.runId).toBe(dispatch.runId);
  });
});
