// @vitest-environment node
/**
 * Issue #4192 ([One engine] #3550 S2) — the screener cutover:
 * production screens dispatch through the engine, the bespoke
 * flow is unused, and the outward WorkflowCollation contract is
 * preserved. TDD red first: the dispatch function and the
 * collation composer do not exist yet.
 *
 * - Dispatch: `runScreenerScreenOnEngine` defines the per-run job,
 *   runs it on the engine with the workflow step as journal, and
 *   returns the composed collation (mesh door, NLQ port, scheduled
 *   tasks all read the same collation).
 * - Collation: `composeScreenerCollation` maps the persisted
 *   stage-output artifacts + the stage ledger onto ShardOutcomes
 *   and calls `collateShards`; the finalize tail projects the
 *   parent + per-shard legs and stores the parent canonical row,
 *   exactly like the retired flow's project-final.
 * - Q2: a screener job's definition + instance live in the D1
 *   (workflow-residency) stores; host surfaces must use a
 *   D1-backed control, never the host control.
 */
import { describe, expect, it, vi } from "vitest";
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
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import { buildFeedJobRegistry, type FeedJobDefinition } from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import { ensureFeedPipelineJobs } from "../src/services/feedPipelineJobs";
import { ensureEnrichPipelineJobs } from "../src/services/enrichPipelineJobs";
import { ensureAnalyzePipelineJobs } from "../src/services/analyzePipelineJobs";
import { ensureGeneratePipelineJobs } from "../src/services/generatePipelineJobs";
import { ensureDeliverPipelineJobs } from "../src/services/deliverPipelineJobs";
import { createScreenerStepRegistry, type ScreenerStepDeps } from "../src/services/screenerPipelineJobs";
import type { CanonicalReportStoreSeam } from "../src/services/canonicalReportLeg";
import type {
  CanonicalReportFanoutOutcome,
  CanonicalStoreResult,
} from "../src/services/scheduledReports";
import { ScreenerAgent } from "../src/agents/screener-agent";
import {
  runScreenerScreenOnEngine,
  type ScreenerEngineDispatchDeps,
} from "../src/workflows/screenerWorkflow";
import type { ParentScreenReportInput } from "../src/workflows/workflowPorts";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import { DEFAULT_PIPELINE_POLICY } from "../src/services/pipelinePolicy";
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

// Issue #5922 (6e): the generic feed step fetches through a
// DataProvider (the 4190 pattern) — quotes + bars recorded so
// the restored dispatch tests can prove every symbol was
// fetched exactly once on the generic chain.
function fakeProvider(
  id: DataProvider["id"],
  quoteCalls: string[],
  barsCalls: string[],
): DataProvider {
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
      barsCalls.push(symbol);
      return {
        providerId: id,
        capability: "historicalBars",
        result: bars(),
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

// Issue #5922 (6e): the default canonical seam stores one row
// per generate run (the production mas_reports seam, faked) —
// the collation's store evidence. A refusing seam (store
// returns null) is the generic store-refusal shape.
function storingCanonicalSeam(canonicalStored: unknown[]): CanonicalReportStoreSeam {
  return {
    ownerLogin: "owner",
    store: async (input) => {
      canonicalStored.push(input);
      return {
        reportId: "canonical-screener-report",
        created: true,
        fanout: { code: "ok" } as unknown as CanonicalReportFanoutOutcome,
      } as CanonicalStoreResult;
    },
  };
}

function marketCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "screen-cutover-4192",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    tenantId: "tenant-1",
    role: "parent",
    shards: [
      { shardId: "s0", symbols: [listing("AAPL"), listing("NVDA")] },
      { shardId: "s1", symbols: [listing("MSFT"), listing("AMZN")] },
    ],
    provider: "yahoo",
    deliver: true,
    ...over,
  };
}

/** Single-attempt policy: a throwing unit fails fast (no retry sleeps in tests). */
const SINGLE_ATTEMPT_POLICY = {
  ...DEFAULT_PIPELINE_POLICY,
  retry: {
    acquisition: { ...DEFAULT_PIPELINE_POLICY.retry.acquisition, maxAttempts: 1 },
    delivery: { ...DEFAULT_PIPELINE_POLICY.retry.delivery, maxAttempts: 1 },
    report: { ...DEFAULT_PIPELINE_POLICY.retry.report, maxAttempts: 1 },
  },
};

interface CutoverHarness {
  control: JobPipelineControl;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  runStore: InMemoryJobRunRecordStore;
  shardStore: InMemoryShardJobAdapter;
  storage: FakeStorage;
  agent: ScreenerAgent;
  stored: unknown[];
  delivered: { payload: unknown; userLogin: string }[];
  parentStored: ParentScreenReportInput[];
  yahooCalls: string[];
  barsCalls: string[];
  quoteCalls: string[];
  canonicalStored: unknown[];
}

async function makeCutoverHarness(opts: {
  storeReport?: ScreenerStepDeps["storeReport"];
  deliverOutcome?: ScreenerStepDeps["deliverOutcome"];
  goalRunner?: ScreenerStepDeps["goalRunner"];
  quoteDepsFor?: ScreenerStepDeps["quoteDepsFor"];
  canonicalReportStore?: CanonicalReportStoreSeam | null;
} = {}): Promise<CutoverHarness> {
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
  const stored: unknown[] = [];
  const delivered: { payload: unknown; userLogin: string }[] = [];
  const parentStored: ParentScreenReportInput[] = [];
  const yahooCalls: string[] = [];
  const barsCalls: string[] = [];
  const quoteCalls: string[] = [];
  const canonicalStored: unknown[] = [];
  const shardsFor = async (jobId: string) =>
    (await stores.definitions.getDefinition(jobId))?.config.processing.shards ?? [];
  const deps: ScreenerStepDeps = {
    agentFor: () => agent as never,
    quoteDepsFor:
      opts.quoteDepsFor ??
      (() => ({
        yahoo: {
          fetchYahooQuote: async (symbol: string) => {
            yahooCalls.push(symbol);
            return quote(symbol);
          },
        },
      })),
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
  // Issue #5922 (6e): the market definition runs the five
  // generic family steps, so the harness composes the shared
  // pipeline registry (the 4190 pattern) — the bespoke
  // registry alone cannot resolve feed.pull etc. The goal
  // definition still rides the bespoke screener steps in the
  // same registry.
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(
      {
        registry: buildFeedJobRegistry({}),
        providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId, quoteCalls, barsCalls),
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
        canonicalReportStore:
          opts.canonicalReportStore !== undefined
            ? opts.canonicalReportStore
            : storingCanonicalSeam(canonicalStored),
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
    policy: SINGLE_ATTEMPT_POLICY,
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  const shardStore = new InMemoryShardJobAdapter();
  return {
    control,
    stores,
    runStore,
    shardStore,
    storage,
    agent,
    stored,
    delivered,
    parentStored,
    yahooCalls,
    barsCalls,
    quoteCalls,
    canonicalStored,
  };
}

function dispatchDeps(
  h: CutoverHarness,
  over: Partial<ScreenerEngineDispatchDeps> = {},
): ScreenerEngineDispatchDeps {
  return {
    control: h.control,
    stores: h.stores,
    shardStore: h.shardStore,
    storeParentReport: async (input) => {
      h.parentStored.push(input);
      return { stored: true, reportId: "parent-report-1" };
    },
    nowMs: () => T0,
    ...over,
  };
}

const fakeStep = {
  do: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
};

describe("dispatch switch (#4192)", () => {
  // Issue #5922 (6e): restored against the generic chain —
  // the collation now reads the generic output shape, so a
  // generic-chain run collates as success with counts from
  // the delivery payload, expected counts from the command,
  // and store evidence from the canonical leg.
  it("dispatches a 2-shard market screen through the engine and returns its collation", async () => {
    const h = await makeCutoverHarness();
    const command = marketCommand();
    const c = await runScreenerScreenOnEngine(fakeStep, dispatchDeps(h), command);

    expect(c.jobId).toBe("screen-cutover-4192");
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.screenMode).toBe("deterministic");
    expect(c.qualified).toBe(false);
    expect(c.coverage).toEqual({ evaluated: 4, considered: 4, ratio: 1 });
    expect(c.shards.map((s) => s.shardId)).toEqual(["s0", "s1"]);
    for (const s of c.shards) {
      expect(s.status).toBe("completed");
      expect(s.stored).toBe(true);
      expect(s.delivered).toBe(true);
    }
    expect(c.storedShards).toEqual(["s0", "s1"]);
    expect(c.deliveredShards).toEqual(["s0", "s1"]);
    // No report keys on the generic chain: the formats are
    // inline bodies in the generated artifact, not asset keys
    // — the collation's keys are exactly the shards' keys.
    expect(c.reportKeys).toEqual(
      c.shards.map((s) => s.pdfKey).filter((k): k is string => typeof k === "string"),
    );
    expect(c.reportKeys).toEqual([]);
    expect(c.childRunIds).toHaveLength(2);
    expect(c.childRunIds?.every((id) => id.startsWith("screener:"))).toBe(true);
    expect(c.parentReport).toEqual({ stored: true, reportId: "parent-report-1" });

    // The canonical leg stored one row per shard; the deliver
    // leg delivered once per shard; every symbol was quoted
    // exactly once through the fake provider. The bespoke
    // feed stage never runs on the generic chain.
    expect(h.canonicalStored).toHaveLength(2);
    expect(h.delivered).toHaveLength(2);
    expect([...new Set(h.quoteCalls)].sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    // No bars assertion on the generic chain: the bespoke
    // history stage fetched bars per symbol, but the generic
    // feed job pulls quotes only — history is a separate feed
    // job kind, not part of the screener chain.
    expect(h.yahooCalls).toEqual([]);

    // The parent canonical row was stored once, keyed by job id.
    expect(h.parentStored).toHaveLength(1);
    expect(h.parentStored[0]?.jobId).toBe("screen-cutover-4192");
    expect(h.parentStored[0]?.collation.lifecycle).toBe("ReportGenerated");

    // The parent row is projected into the shard-job store, so
    // the mesh door / NLQ port read the collation from the rows.
    const parentRow = await h.shardStore.latestJob("tenant-1", "screen-cutover-4192", "screen-cutover-4192");
    expect(parentRow).not.toBeNull();
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").shards).toHaveLength(2);

    // The collation is written as an artifact on the run.
    const view = await h.control.getJob("screen-cutover-4192");
    const runId = view.instance?.currentRunId;
    expect(runId).toBeTruthy();
    const artifact = await h.stores.artifacts.getArtifact(runId!, "screener/collation");
    expect(artifact).toEqual(c);

    // The run is on the platform run-record machinery.
    expect(h.runStore.listByJob("screen-cutover-4192")).toHaveLength(1);
    expect(h.runStore.listByJob("screen-cutover-4192")[0]?.outcome).toBe("success");
  });

  it("a store refusal is recorded on the collation, never a failed run", async () => {
    // Issue #5922: the store leg is the generic canonical leg
    // now — a seam that refuses (returns no row) records a
    // store error per shard; the screen still completes and
    // still delivers.
    const h = await makeCutoverHarness({
      canonicalReportStore: {
        ownerLogin: "owner",
        store: async () => null,
      },
    });
    const c = await runScreenerScreenOnEngine(fakeStep, dispatchDeps(h), marketCommand());
    expect(c.lifecycle).toBe("Completed");
    expect(c.storeErrors).toEqual({
      s0: 'Canonical report leg failed for "screener-report" (no canonical copy stored).',
      s1: 'Canonical report leg failed for "screener-report" (no canonical copy stored).',
    });
    expect(c.storedShards).toEqual([]);
    expect(h.delivered).toHaveLength(2);
  });

  it("deliver=false skips delivery on the collation", async () => {
    const h = await makeCutoverHarness();
    const c = await runScreenerScreenOnEngine(
      fakeStep,
      dispatchDeps(h),
      marketCommand({ deliver: false }),
    );
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.deliveredShards).toEqual([]);
    expect(h.delivered).toHaveLength(0);
    expect(c.storedShards).toEqual(["s0", "s1"]);
  });

  it("a shard role refuses by name — no child workflows are created by the engine dispatch", async () => {
    const h = await makeCutoverHarness();
    const shard = {
      ...marketCommand(),
      role: "shard" as const,
      parentJobId: "screen-cutover-4192",
      shard: { shardId: "s0", symbols: [listing("AAPL")] },
      jobId: "screen-cutover-4192:shard:s0",
    };
    await expect(
      runScreenerScreenOnEngine(fakeStep, dispatchDeps(h), shard),
    ).rejects.toThrow(/SCREENER_SHARD_ROLE_RETIRED/);
    expect(await h.stores.definitions.getDefinition("screen-cutover-4192:shard:s0")).toBeNull();
  });
});

describe("goal-leg dispatch (#4192)", () => {
  it("runs the goal runner on the same six nodes, never the market runner", async () => {
    const goalCalls: unknown[] = [];
    const h = await makeCutoverHarness({
      goalRunner: async (req: any) => {
        goalCalls.push(req);
        return {
          task: { id: "goal-task-4192" },
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
      jobId: "goal-4192",
      // Goal parents are monolith (S1 pin: "is monolith with
      // no shards") — the goal runner runs once per unit, so a
      // multi-shard goal command would run it per shard.
      shards: [{ shardId: "s0", symbols: [listing("AAPL")] }],
      goalScreen: {
        scenario: { goalKind: "growth", direction: "long" } as any,
        scenarioSource: "built",
        symbols: ["AAPL"],
      },
    });
    const c = await runScreenerScreenOnEngine(fakeStep, dispatchDeps(h), command);
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(goalCalls).toHaveLength(1);
    expect((goalCalls[0] as any)?.symbols).toEqual(["AAPL"]);
    expect(h.yahooCalls).toEqual([]);
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
    // Goal parents link by report id, never by screener:<timestamp>.
    expect(c.childRunIds).toEqual([]);
    expect(h.parentStored).toHaveLength(1);
    expect(h.parentStored[0]?.goalScreen).toBe(true);
  });

  it("the default goal runner is the engine method, never the direct runGoalScreen (#4279)", async () => {
    const h = await makeCutoverHarness();
    const engineSpy = vi.spyOn(h.agent, "runGoalScreenOnEngine").mockResolvedValue({
      task: { id: "goal-task-4279" },
      executed: true,
      result: {
        scenario: { goalKind: "growth", direction: "long" },
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
    } as never);
    const directSpy = vi.spyOn(h.agent, "runGoalScreen").mockResolvedValue({
      task: { id: "goal-task-direct" },
      executed: true,
    } as never);
    const command = marketCommand({
      jobId: "goal-4279",
      shards: [{ shardId: "s0", symbols: [listing("AAPL")] }],
      goalScreen: {
        scenario: { goalKind: "growth", direction: "long" } as any,
        scenarioSource: "built",
        symbols: ["AAPL"],
      },
    });
    const c = await runScreenerScreenOnEngine(fakeStep, dispatchDeps(h), command);
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(engineSpy).toHaveBeenCalledTimes(1);
    expect(directSpy).not.toHaveBeenCalled();
    expect(h.stored).toHaveLength(1);
  });
});

describe("control-plane addressing from host surfaces — Q2 (#4192)", () => {
  it("a D1-defined screener job is invisible to the host control and addressable on the D1-backed control", async () => {
    const h = await makeCutoverHarness();
    // The dispatch defines the job on THIS control's stores
    // (the D1 residency in production). A second control over
    // DIFFERENT stores (the host residency) must not see it.
    const { buildScreenerJobDefinition, ensureScreenerJob } = await import(
      "../src/services/screenerPipelineJobs"
    );
    const { vocabularyStageNodePath } = await import("../src/services/jobPipelineEngine");
    const { createInMemoryJobPipelineStores: freshStores } = await import(
      "../src/data/inMemoryJobPipelineAdapter"
    );
    const hostStores = freshStores();
    const hostControl = new JobPipelineControl({
      stores: hostStores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createScreenerStepRegistry({
        agentFor: () => h.agent as never,
        storeReport: async () => {},
        deliverOutcome: async () => {},
      }),
      now: () => new Date(T0),
    });
    await ensureScreenerJob(h.control, h.stores, marketCommand());
    // The engine's refusal carries the code on the error, not
    // in the message ("No job defined with id ...").
    await expect(hostControl.getJob("screen-cutover-4192")).rejects.toMatchObject({
      code: "job_not_found",
    });
    // The D1-backed control (same stores as the dispatch) sees
    // the definition and resolves the vocabulary stage to its node.
    const view = await h.control.getJob("screen-cutover-4192");
    expect(view.definition.jobId).toBe("screen-cutover-4192");
    expect(vocabularyStageNodePath(view.definition, "feed")).toBe("");
    expect(vocabularyStageNodePath(view.definition, "deliver")).toBe("0/0/0/0");
    expect(buildScreenerJobDefinition).toBeDefined();
  });
});

describe("ND head — adapter gate before dispatch, Q4 (#4192)", () => {
  it("an invalid interpretation refuses the dispatch: Failed collation, zero shards started, audit carries the reasons", async () => {
    const h = await makeCutoverHarness();
    const audits: unknown[] = [];
    const interpreted: unknown[] = [];
    const command = marketCommand({
      screenMode: "non-deterministic",
      screenIntent: "cheap growth stocks",
    });
    const c = await runScreenerScreenOnEngine(
      fakeStep,
      dispatchDeps(h, {
        ndModeEnabled: true,
        intentInterpreter: {
          interpret: async (req: any) => {
            interpreted.push(req);
            return { filters: { invented: true } };
          },
        },
        auditInterpretation: async (record) => {
          audits.push(record);
        },
      }),
      command,
    );
    expect(interpreted).toHaveLength(1);
    expect(c.lifecycle).toBe("Failed");
    expect(c.shards.every((s) => s.status === "failed")).toBe(true);
    expect(c.screenMode).toBe("non-deterministic");
    // Zero shards started: no job was ever defined.
    expect(await h.stores.definitions.getDefinition("screen-cutover-4192")).toBeNull();
    expect(h.yahooCalls).toEqual([]);
    // The refusal still lands a visible record: the audit
    // carries the reasons and the parent row is projected.
    expect(audits).toHaveLength(1);
    expect((audits[0] as any)?.validation?.ok).toBe(false);
    // The refusal lands two visible rows: the announce row
    // (submitted, keyed by job id) and the failed parent leg
    // (the projector keys failed legs `leg:<stepId>`, and a
    // failed leg's resultJson carries only the detail — never
    // a collation). The collation itself is the dispatch
    // return, already asserted Failed above.
    const parentRow = await h.shardStore.latestJob("tenant-1", "screen-cutover-4192", "screen-cutover-4192");
    expect(parentRow).not.toBeNull();
    expect(parentRow?.status).toBe("submitted");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").jobId).toBe("screen-cutover-4192");
    const failedRow = await h.shardStore.latestJob("tenant-1", "screen-cutover-4192", "leg:parent");
    expect(failedRow).not.toBeNull();
    expect(failedRow?.status).toBe("failed");
    expect(JSON.parse(failedRow?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/2 shards/);
    expect(h.parentStored).toHaveLength(1);
  });

  it("a closed ND gate refuses before interpreting (direct starts cannot bypass the flag)", async () => {
    const h = await makeCutoverHarness();
    const interpreted: unknown[] = [];
    await expect(
      runScreenerScreenOnEngine(
        fakeStep,
        dispatchDeps(h, {
          ndModeEnabled: false,
          intentInterpreter: {
            interpret: async (req: any) => {
              interpreted.push(req);
              return { filters: {} };
            },
          },
          auditInterpretation: async () => {},
        }),
        marketCommand({ screenMode: "non-deterministic", screenIntent: "cheap growth stocks" }),
      ),
    ).rejects.toThrow(/SCREENER_ND_MODE gate is closed/);
    expect(interpreted).toHaveLength(0);
    expect(await h.stores.definitions.getDefinition("screen-cutover-4192")).toBeNull();
  });

  // Issue #5884 (6b3): "a valid interpretation dispatches
  // with the merged filters" MOVED to 6e (#5922) with the
  // dispatch tests — it asserts the collation lifecycle
  // ReportGenerated over a generic-chain run, which the
  // collation cannot read until 6e teaches it the generic
  // shape. 6e restores it against the generic outputs
  // (lifecycle ReportGenerated, screenMode
  // non-deterministic, every symbol quoted once).
});

import { composeScreenerCollation, projectScreenerAnnounce } from "../src/workflows/screenerCollation";
import { buildScreenerJobDefinition, ensureScreenerJob } from "../src/services/screenerPipelineJobs";
import { vocabularyStageNodePath } from "../src/services/jobPipelineEngine";
import type { JobRunOutcome } from "../src/services/jobPipelineEngine";

/** A minimal deliver-stage output for one shard, as the engine persists it. */
function deliverOutput(shardId: string, over: Record<string, unknown> = {}) {
  return {
    timestamp: iso(T0),
    shardId,
    symbols: ["AAPL"],
    universe: [{ symbol: "AAPL", companyName: "AAPL Inc", exchange: "NASDAQ" }],
    expectedCount: 1,
    quoteTrace: { total: 1, fetched: 1, failed: 0, byProvider: { yahoo: 1 } },
    technicalsBySymbol: {},
    technicalsCoverage: { total: 1, withTechnicals: 0, withFallback: 0, withPersisted: 0 },
    persistedSentiment: {},
    screenResult: {
      totalScanned: 1,
      matchedCount: 1,
      filterSummary: "1 of 1 matched",
      rejections: {},
      matches: [],
      rejected: [],
      matched: [],
    },
    allStocks: [],
    opportunities: [],
    stored: true,
    reportId: `report-${shardId}`,
    result: {
      pdfKey: `pdf-${shardId}`,
      xlsxKey: `xlsx-${shardId}`,
      csvKey: `csv-${shardId}`,
    },
    servedReport: {
      reportId: `report-${shardId}`,
      formats: [
        { format: "pdf", key: `pdf-${shardId}`, status: "served" },
        { format: "xlsx", key: `xlsx-${shardId}`, status: "served" },
        { format: "csv", key: `csv-${shardId}`, status: "served" },
      ],
      servedAt: iso(T0),
    },
    delivered: true,
    ...over,
  };
}

async function seedComposedRun(
  h: CutoverHarness,
  opts: {
    jobId?: string;
    runId?: string;
    shards?: { shardId: string; output?: Record<string, unknown> | null; ledger?: { stage: string; status: string; error?: string }[] }[];
    command?: WorkflowJobCommand;
  } = {},
) {
  const jobId = opts.jobId ?? "screen-cutover-4192";
  const runId = opts.runId ?? "run-seeded-4192";
  const command = opts.command ?? marketCommand({ jobId });
  await ensureScreenerJob(h.control, h.stores, command);
  const definition = await h.stores.definitions.getDefinition(jobId);
  if (!definition) throw new Error("definition missing after ensure");
  // Persist the per-shard deliver outputs as the deliver node's
  // composed stage-output map, exactly as the engine writes it.
  const composed: Record<string, unknown> = {};
  for (const shard of opts.shards ?? []) {
    if (shard.output) composed[shard.shardId] = shard.output;
  }
  await h.stores.artifacts.putArtifact(
    runId,
    `${vocabularyStageNodePath(definition, "deliver")}/stage-output`,
    composed,
  );
  // Persist the stage ledger the engine keeps on the instance.
  const units = (opts.shards ?? []).flatMap((shard) =>
    (shard.ledger ?? []).map((entry) => ({
      stage: `job:${vocabularyStageNodePath(definition, entry.stage as never)}`,
      unitId: shard.shardId,
      status: entry.status as never,
      attempt: 1,
      ...(entry.error ? { error: entry.error } : {}),
      updatedAt: iso(T0),
    })),
  );
  await h.stores.instances.saveInstance({
    jobId,
    state: "failed",
    desiredState: "none",
    currentRunId: runId,
    runStartedAt: iso(T0),
    runTrigger: "manual",
    checkpoint: null,
    stageCheckpoint: { runId, units },
    stageDesired: null,
    lastError: null,
    updatedAt: iso(T0),
  });
  return { jobId, runId, command };
}

function collationDeps(
  h: CutoverHarness,
  over: Partial<Parameters<typeof composeScreenerCollation>[0]> = {},
): Parameters<typeof composeScreenerCollation>[0] {
  return {
    control: h.control,
    stores: h.stores,
    shardStore: h.shardStore,
    storeParentReport: async (input) => {
      h.parentStored.push(input);
      return { stored: true, reportId: "parent-report-1" };
    },
    nowMs: () => T0,
    ...over,
  };
}

describe("collation composer — failed-shard mapping (#4192)", () => {
  it("one completed shard + one failed shard collates as a qualified partial", async () => {
    const h = await makeCutoverHarness();
    const { command, runId } = await seedComposedRun(h, {
      shards: [
        { shardId: "s0", output: deliverOutput("s0"), ledger: [{ stage: "deliver", status: "completed" }] },
        {
          shardId: "s1",
          output: null,
          ledger: [{ stage: "feed", status: "failed", error: "provider down" }],
        },
      ],
    });
    const outcome: JobRunOutcome = {
      jobId: "screen-cutover-4192",
      runId,
      state: "failed",
      error: "provider down",
      artifactKeys: [],
    };
    const c = await composeScreenerCollation(collationDeps(h), command, runId, outcome);
    // collateShards sets ReportGenerated when a parent report
    // exists (the flow's own lifecycle) — Completed only when
    // no parent report was stored. The seed stores one.
    expect(c.lifecycle).toBe("ReportGenerated");
    expect(c.qualified).toBe(true);
    expect(c.shards.find((s) => s.shardId === "s0")?.status).toBe("completed");
    expect(c.shards.find((s) => s.shardId === "s1")?.status).toBe("failed");
    expect(c.shards.find((s) => s.shardId === "s1")?.error).toBe("provider down");
    expect(c.storedShards).toEqual(["s0"]);
    expect(c.deliveredShards).toEqual(["s0"]);
    expect(c.parentReport).toEqual({ stored: true, reportId: "parent-report-1" });
    const parentRow = await h.shardStore.latestJob("tenant-1", "screen-cutover-4192", "screen-cutover-4192");
    // The projected row carries the collation itself — its
    // lifecycle is ReportGenerated here, same as the
    // collation above (a parent report was stored).
    expect(JSON.parse(parentRow?.resultJson ?? "{}").lifecycle).toBe("ReportGenerated");
  });

  it("a timed_out ledger entry maps to timed_out, never completed", async () => {
    const h = await makeCutoverHarness();
    const { command, runId } = await seedComposedRun(h, {
      shards: [
        {
          shardId: "s0",
          output: null,
          ledger: [{ stage: "feed", status: "timed_out", error: "deadline exceeded" }],
        },
        {
          shardId: "s1",
          output: null,
          ledger: [{ stage: "feed", status: "timed_out", error: "deadline exceeded" }],
        },
      ],
    });
    const c = await composeScreenerCollation(collationDeps(h), command, runId, {
      jobId: "screen-cutover-4192",
      runId,
      state: "timed_out",
      error: "deadline exceeded",
      artifactKeys: [],
    });
    expect(c.lifecycle).toBe("Failed");
    expect(c.shards.every((s) => s.status === "timed_out")).toBe(true);
  });

  it("a duplicate feed output fails the shard with the suppression message", async () => {
    const h = await makeCutoverHarness();
    const { command, runId } = await seedComposedRun(h, {
      shards: [
        {
          shardId: "s0",
          output: deliverOutput("s0", { duplicate: true, dupResult: { status: "duplicate" } }),
          ledger: [{ stage: "deliver", status: "completed" }],
        },
        { shardId: "s1", output: deliverOutput("s1"), ledger: [{ stage: "deliver", status: "completed" }] },
      ],
    });
    const c = await composeScreenerCollation(collationDeps(h), command, runId, {
      jobId: "screen-cutover-4192",
      runId,
      state: "completed",
      artifactKeys: [],
    });
    expect(c.shards.find((s) => s.shardId === "s0")?.status).toBe("failed");
    expect(c.shards.find((s) => s.shardId === "s0")?.error).toMatch(/suppression/i);
    expect(c.shards.find((s) => s.shardId === "s1")?.status).toBe("completed");
    expect(c.qualified).toBe(true);
  });

  it("a shard with no artifact anywhere fails as never-ran, never invented completed", async () => {
    const h = await makeCutoverHarness();
    const { command, runId } = await seedComposedRun(h, {
      shards: [
        { shardId: "s0", output: deliverOutput("s0"), ledger: [{ stage: "deliver", status: "completed" }] },
        { shardId: "s1", output: null, ledger: [] },
      ],
    });
    const c = await composeScreenerCollation(collationDeps(h), command, runId, {
      jobId: "screen-cutover-4192",
      runId,
      state: "failed",
      error: "node failed",
      artifactKeys: [],
    });
    expect(c.shards.find((s) => s.shardId === "s1")?.status).toBe("failed");
    expect(c.shards.find((s) => s.shardId === "s1")?.error).toMatch(/never ran/i);
  });

  it("a goal leg that failed collates failed; a partial goal leg collates completed", async () => {
    const h = await makeCutoverHarness();
    const failedGoal = deliverOutput("s0", {
      goalResult: { status: "failed", message: "goal task errored" },
      stored: false,
    });
    const { command, runId } = await seedComposedRun(h, {
      jobId: "goal-4192",
      command: marketCommand({
        jobId: "goal-4192",
        goalScreen: {
          scenario: { goalKind: "growth", direction: "long" } as any,
          scenarioSource: "built",
          symbols: ["AAPL"],
        },
      }),
      shards: [{ shardId: "s0", output: failedGoal, ledger: [{ stage: "deliver", status: "completed" }] }],
    });
    const c = await composeScreenerCollation(collationDeps(h), command, runId, {
      jobId: "goal-4192",
      runId,
      state: "completed",
      artifactKeys: [],
    });
    expect(c.shards[0]?.status).toBe("failed");
    expect(c.shards[0]?.error).toMatch(/Goal screen failed/);
    expect(c.lifecycle).toBe("Failed");

    const h2 = await makeCutoverHarness();
    const partialGoal = deliverOutput("s0", {
      goalResult: { status: "partial", message: "two legs priced, one skipped" },
    });
    const seeded = await seedComposedRun(h2, {
      jobId: "goal-4192",
      command: marketCommand({
        jobId: "goal-4192",
        goalScreen: {
          scenario: { goalKind: "growth", direction: "long" } as any,
          scenarioSource: "built",
          symbols: ["AAPL"],
        },
      }),
      shards: [{ shardId: "s0", output: partialGoal, ledger: [{ stage: "deliver", status: "completed" }] }],
    });
    const c2 = await composeScreenerCollation(collationDeps(h2), seeded.command, seeded.runId, {
      jobId: "goal-4192",
      runId: seeded.runId,
      state: "completed",
      artifactKeys: [],
    });
    expect(c2.shards[0]?.status).toBe("completed");
    expect(c2.lifecycle).toBe("ReportGenerated");
  });

  it("a failed engine run still projects the parent row and stores the parent canonical row", async () => {
    const h = await makeCutoverHarness();
    const { command, runId } = await seedComposedRun(h, {
      shards: [
        {
          shardId: "s0",
          output: null,
          ledger: [{ stage: "feed", status: "failed", error: "provider down" }],
        },
        {
          shardId: "s1",
          output: null,
          ledger: [{ stage: "feed", status: "failed", error: "provider down" }],
        },
      ],
    });
    const c = await composeScreenerCollation(collationDeps(h), command, runId, {
      jobId: "screen-cutover-4192",
      runId,
      state: "failed",
      error: "provider down",
      artifactKeys: [],
    });
    expect(c.lifecycle).toBe("Failed");
    expect(h.parentStored).toHaveLength(1);
    expect(h.parentStored[0]?.collation.lifecycle).toBe("Failed");
    // The failed parent leg is projected under the projector's
    // failed-leg key `leg:parent` (never under the job id),
    // and its resultJson carries only the detail.
    const parentRow = await h.shardStore.latestJob("tenant-1", "screen-cutover-4192", "leg:parent");
    expect(parentRow).not.toBeNull();
    expect(parentRow?.status).toBe("failed");
    expect(JSON.parse(parentRow?.resultJson ?? "{}").detail).toMatch(/Workflow Failed: 0\/2 shards/);
  });
});

describe("announce projection (#4192)", () => {
  it("projects the submitted parent row before the run settles, so the parent is visible from the start", async () => {
    const h = await makeCutoverHarness();
    await ensureScreenerJob(h.control, h.stores, marketCommand());
    await projectScreenerAnnounce(
      { shardStore: h.shardStore, nowMs: () => T0 },
      marketCommand(),
    );
    const row = await h.shardStore.latestJob("tenant-1", "screen-cutover-4192", "screen-cutover-4192");
    expect(row).not.toBeNull();
    // A submitted leg's resultJson carries only the job id
    // and detail (never a collation) — the row's status is
    // the submitted signal.
    expect(row?.status).toBe("submitted");
    const parsed = JSON.parse(row?.resultJson ?? "{}");
    expect(parsed.jobId).toBe("screen-cutover-4192");
    expect(typeof parsed.detail).toBe("string");
  });
});

// Issue #5884 (6b3): the "dispatch failure shape" test —
// "a provider outage on one shard fails the run fast and
// the collation fails every shard honestly" — MOVED to 6e
// (#5922) with the dispatch tests. It asserts the collation
// lifecycle Failed + per-shard errors over a generic-chain
// run, which the collation cannot read until 6e teaches it
// the generic shape. 6e restores it against the generic
// outputs (feed-stage outage named by symbol on the failing
// shard, the other shard failed "never reached analysis",
// parent row stored once). (Kept as a comment, not an empty
// describe: vitest fails a suite with no tests.)

describe("definition builder (#4192)", () => {
  it("builds the five-node nested chain with per-node shard partitioning", () => {
    const definition = buildScreenerJobDefinition(marketCommand());
    expect(definition.jobId).toBe("screen-cutover-4192");
    const kinds: string[] = [];
    let node: any = definition.root;
    while (node) {
      kinds.push(node.kind);
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "generate", "deliver"]);
    // The params ride the steps, not the nodes (the bespoke
    // "stages carry no params" shape is gone with the flip:
    // the generic nodes carry the family job ids and their
    // per-family params, per #4365-P05).
    const paramsByKind = new Map<string, unknown>();
    node = definition.root;
    while (node) {
      paramsByKind.set(node.kind, node.steps?.[0]?.params);
      node = node.children?.[0];
    }
    expect(paramsByKind.get("feed")).toEqual(
      // No universe here: the 4192 command carries explicit
      // symbols shards, which name no universe (6b0).
      expect.objectContaining({ feedJobId: "yahoo-nasdaq100-quotes" }),
    );
    expect(paramsByKind.get("analyze")).toEqual(
      expect.objectContaining({ ruleSets: ["screen", "factors"], inputMode: "handOff" }),
    );
    expect(paramsByKind.get("generate")).toEqual(
      expect.objectContaining({ reports: ["screener-report"] }),
    );
  });
});
