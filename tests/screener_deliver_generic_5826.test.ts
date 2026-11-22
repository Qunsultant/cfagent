// @vitest-environment node
/**
 * Issue #5826 (#4437 slice 5) — generic deliver carries screener
 * delivery (the orchestrator sink):
 *
 * - Parity: the same serve output through the bespoke
 *   `screener.deliver` step and through generic `deliver.apply`
 *   (screener mode) produces the same output and the same
 *   orchestrator-sink calls — same payload, same login, same
 *   `workflow:<jobId>` delivery id, same goal/delivery/stage-chain
 *   threading — for market and goal runs, monolith and sharded.
 * - The generic run's deliver stage IS the generic stage: the
 *   registry that runs it does not contain `screener.deliver` at
 *   all, and the run's definition names `deliver.apply`.
 * - The bespoke deliver rules carry over: a duplicate passes
 *   through untouched, `deliver: false` skips, a sink refusal is
 *   recorded (never a failed run), an unwired sink refuses by
 *   name, a missing userLogin refuses by name — and the screener
 *   mode never consults the channel path's stores.
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
import { buildFeedJobRegistry, type FeedJobDefinition } from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import {
  buildGenerateJobRegistry,
  buildScreenerDeliveryPayload,
} from "../src/services/generateJobs";
import type { CanonicalReportStoreSeam } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import {
  DELIVER_APPLY_STEP,
  registerDeliverStep,
  type DeliverStepDeps,
} from "../src/services/deliverPipelineJobs";
import {
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
  SCREENER_ANALYSIS_STEP,
  SCREENER_DELIVER_STEP,
  SCREENER_FEED_STEP,
  SCREENER_GATHER_STEP,
  SCREENER_SERVE_STEP,
  SCREENER_STORE_STEP,
  screenerFamilyJobIds,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { JobStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type { CanonicalStoreResult } from "../src/services/scheduledReports";
import type { DataProvider,
  DataResult,
  MarketDataResearchCompanyFundamentals,
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
  NewsResult,
  QuoteResult,
} from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

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
    jobId: "screen-parity-5826",
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

function bars() {
  return [
    { timestamp: iso(T0 - 86_400_000), open: 99, high: 101, low: 98, close: 100, volume: 1_000_000 },
    { timestamp: iso(T0), open: 100, high: 102, low: 99, close: 101, volume: 1_100_000 },
  ];
}

/** Thirty rising bars for the generic side's enrich features. */
function genericBars(): MarketDataResearchHistoricalBar[] {
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

function fakeProvider(id: DataProvider["id"], quoteCalls: string[]): DataProvider {
  return {
    id,
    name: id,
    capabilities: ["quotes", "historicalBars", "fundamentals", "news"],
    isConfigured: () => true,
    getQuotesBatch: async (symbols: string[]) => {
      quoteCalls.push(...symbols);
      const wanted = new Set(symbols.map((s) => s.toUpperCase()));
      const result = ["AAPL", "MSFT", "NVDA", "AMZN"]
        .map((s) => quote(s))
        .filter((q) => wanted.has(q.symbol.toUpperCase()));
      return { providerId: id, capability: "quotes", result } as DataResult<QuoteResult[]>;
    },
    getFundamentals: async (symbol: string) =>
      ({
        providerId: id,
        capability: "fundamentals",
        result: { symbol, marketCap: 1_000_000, peTrailing: 25 } as MarketDataResearchCompanyFundamentals,
      }) as DataResult<MarketDataResearchCompanyFundamentals>,
    getHistoricalBars: async () =>
      ({
        providerId: id,
        capability: "historicalBars",
        result: genericBars(),
      }) as DataResult<MarketDataResearchHistoricalBar[]>,
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

/** The canonical seam for the generic side: one fixed row id. */
function fakeCanonicalSeam(): CanonicalReportStoreSeam {
  return {
    ownerLogin: "owner",
    store: async () => ({
      reportId: "rep-5826",
      created: true,
      fanout: { code: "ok" } as CanonicalStoreResult["fanout"],
    }),
  };
}

/** One sink call: the exact args the orchestrator sink received. */
interface SinkCall {
  payload: unknown;
  userLogin: string;
  opts?: Record<string, unknown>;
}

function makeSink() {
  const calls: SinkCall[] = [];
  const sink: ScreenerStepDeps["deliverOutcome"] = async (payload, userLogin, opts) => {
    calls.push({ payload, userLogin, ...(opts ? { opts: opts as Record<string, unknown> } : {}) });
  };
  return { calls, sink };
}

/** The serve-stage output the deliver stage consumes (hand-built, realistic). */
function serveOutputFixture() {
  return {
    result: { success: true, totalScanned: 4, matchedCount: 2 },
    payload: {
      kind: "stock",
      trigger: "manual",
      success: true,
      pdfKeys: [],
      thesis: "parity fixture",
      matchedCount: 2,
      totalScanned: 4,
      allStocks: ["AAPL", "MSFT", "NVDA", "AMZN"].map((symbol) => ({ symbol })),
    },
    stored: true,
    reportId: "rep-5826",
    userLogin: "owner",
    servedReport: {
      reportId: "rep-5826",
      formats: [{ format: "pdf", key: "pdf-key", status: "generated" }],
      servedAt: iso(T0),
    },
  };
}

function stepCtx(over: Partial<JobStepContext> = {}): JobStepContext {
  return {
    jobId: "screen-parity-5826",
    runId: "run-1",
    nodePath: "0.0.0.0.0.0",
    kind: "deliver",
    stepIndex: 0,
    item: null,
    itemIndex: null,
    items: [],
    shardKey: null,
    params: { userLogin: "owner", deliver: true, screener: true },
    input: serveOutputFixture(),
    now: iso(T0),
    trigger: "manual",
    runKind: "original",
    ...over,
  };
}

/** Swap the deliver node of a screener definition onto generic deliver. */
function genericDeliverDefinition(command: WorkflowJobCommand): unknown {
  const raw = buildScreenerJobDefinition(command) as any;
  let node = raw.root;
  while (node.children?.[0]) node = node.children[0];
  expect(node.kind).toBe("deliver");
  node.steps[0].step = DELIVER_APPLY_STEP;
  node.steps[0].params = { ...node.steps[0].params, screener: true };
  return raw;
}

/** Per-run generated ids (run/task/trace ids, artifact keys) differ between two runs of the same screen; normalize them out before comparing sink calls. */
function normalizeSinkCall(call: SinkCall): unknown {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return "<uuid>";
      if (/^stask-[0-9a-f-]{36}$/.test(value)) return "<taskId>";
      if (/^qt_[a-z0-9_]+$/.test(value)) return "<traceId>";
      if (/^screener:(csv|xlsx|pdf):[0-9a-f]+$/.test(value)) return "<artifactKey>";
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, replace(v)]),
      );
    }
    return value;
  };
  return replace(call);
}

function deliverNodeStep(definition: unknown): string {
  let node = (definition as any).root;
  while (node.children?.[0]) node = node.children[0];
  return node.steps[0].step as string;
}

interface ParityHarness {
  bespoke: { control: JobPipelineControl; runStore: InMemoryJobRunRecordStore; sink: SinkCall[] };
  generic: {
    control: JobPipelineControl;
    runStore: InMemoryJobRunRecordStore;
    sink: SinkCall[];
    sinkFn: ScreenerStepDeps["deliverOutcome"];
    generatedStore: InMemoryGeneratedDatasetStore;
    analyzedStore: InMemoryAnalyzedDatasetStore;
  };
}

async function makeParityHarness(): Promise<ParityHarness> {
  const storage = new FakeStorage();
  storage.map.set("screener:owner-login", "owner");
  const agent = new ScreenerAgent({ storage } as any, {} as any);
  const bespokeSink = makeSink();
  const genericSink = makeSink();
  const stored: unknown[] = [];
  const yahooCalls: string[] = [];
  const barsCalls: string[] = [];
  const genericQuoteCalls: string[] = [];

  const screenerDeps: ScreenerStepDeps = {
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
    // The bespoke store stage returns the stored report id, so
    // the bespoke side threads the same canonical row id the
    // generic side's canonical seam returns below.
    storeReport: async (payload) => {
      stored.push(payload);
      return "rep-5826";
    },
    deliverOutcome: bespokeSink.sink,
  };

  const makeControl = (
    steps: JobStepRegistry,
    stores: ReturnType<typeof createInMemoryJobPipelineStores>,
  ) => {
    const runStore = new InMemoryJobRunRecordStore();
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = {
      producer: messaging,
      consumer: messaging,
      publisher: messaging,
      subscriber: messaging,
    };
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: ports.publisher,
      steps,
      now: () => new Date(T0),
    });
    return { control, runStore };
  };

  const bespokeStores = createInMemoryJobPipelineStores();
  const bespoke = makeControl(createScreenerStepRegistry(screenerDeps), bespokeStores);

  // Issue #5885 (6c): the generic side runs the FULL generic
  // stack now — feed/enrich/analyze/generate/deliver over
  // in-memory dataset stores (the #4190 harness shape), so the
  // flipped definition executes end to end and its deliver
  // node reads a real generate output, not a serve fixture.
  const genericStores = createInMemoryJobPipelineStores();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const universes = new InMemoryIndexListStore();
  const shardsFor = async (jobId: string) =>
    (await genericStores.definitions.getDefinition(jobId))?.config.processing.shards ?? [];
  const deliverDeps: DeliverStepDeps = {
    registry: buildDeliverJobRegistry({}),
    generatedStore,
    deliveryStore,
    senders: {},
    shardsFor,
    screenerDeliverOutcome: genericSink.sink,
  };
  const genericSteps = createPipelineStepRegistry(
    {
      registry: buildFeedJobRegistry({}),
      providerFor: (def: FeedJobDefinition) => fakeProvider(def.sourceId, genericQuoteCalls),
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
      canonicalReportStore: fakeCanonicalSeam(),
      shardsFor,
    },
    deliverDeps,
    screenerDeps,
  );
  const generic = makeControl(genericSteps, genericStores);
  return {
    bespoke: { ...bespoke, sink: bespokeSink.calls },
    generic: { ...generic, sink: genericSink.calls, sinkFn: genericSink.sink, generatedStore, analyzedStore },
  };
}

/**
 * Issue #5885 (6c) — the hand-built six-node bespoke definition
 * the builder no longer builds (the flip re-pointed it onto the
 * generic nodes): feed → gather → analysis → store → serve →
 * deliver, bespoke steps, the command's shared params on every
 * node. The restored full-chain parity test runs it beside the
 * flipped five-node definition.
 */
function bespokeSixNodeDefinition(command: WorkflowJobCommand): unknown {
  const shardIds = (command.shards ?? []).map((shard) => shard.shardId);
  const symbols = (command.shards ?? []).flatMap((shard) => shard.symbols ?? []);
  const shardTable = (command.shards ?? []).map((shard) => ({
    shardId: shard.shardId,
    ...(shard.universe ? { universe: shard.universe } : {}),
    ...(shard.symbols ? { symbols: shard.symbols } : {}),
  }));
  const params: Record<string, unknown> = {
    userLogin: command.userLogin,
    trigger: command.trigger,
    ...(command.provider ? { provider: command.provider } : {}),
    deliver: command.deliver === true,
    symbols,
    shards: shardTable,
  };
  const kinds = ["feed", "gather", "analysis", "store", "serve", "deliver"];
  const steps = [
    SCREENER_FEED_STEP,
    SCREENER_GATHER_STEP,
    SCREENER_ANALYSIS_STEP,
    SCREENER_STORE_STEP,
    SCREENER_SERVE_STEP,
    SCREENER_DELIVER_STEP,
  ];
  let node: Record<string, unknown> | undefined;
  for (let i = kinds.length - 1; i >= 0; i--) {
    node = {
      kind: kinds[i],
      steps: [{ step: steps[i], params: { ...params } }],
      processing: { shards: [...shardIds] },
      ...(node ? { children: [node] } : {}),
    };
  }
  return { jobId: command.jobId, name: `Screener — ${command.jobId}`, root: node };
}

describe("generic deliver carries screener delivery (#5826)", () => {
  // Issue #5885 (6c) — RESTORED. The full-chain parity test was
  // MOVED here by 6b3 and is restored now that the deliver node
  // is flipped: the bespoke side runs the hand-built six-node
  // bespoke definition, the generic side the flipped five-node
  // definition, and the sink calls must match on the SHARED
  // SINK CONTRACT (same login, same workflow:<jobId> delivery
  // id, same canonical report id). The payloads are NOT
  // identical and never will be: the bespoke payload is the
  // live ScreenerRunResult (matchedCount, allStocks, quote
  // trace, pareto) and the generic payload is the delivery
  // converter output for the run's document — re-deriving the
  // live fields would be a second ranking (parallel work,
  // forbidden; the rich-field gap is #5875, owned by slice 7).
  // So the test pins the contract + that each payload is the
  // right output for its own side: the generic payload equals
  // the converter output recomputed from the persisted JSON
  // format body, and the bespoke payload is the live result.

  it("market parity, full chain: same sink contract through deliver.apply as through screener.deliver (#5885)", async () => {
    const { bespoke, generic } = await makeParityHarness();
    const command = marketCommand();
    const bespokeDefinition = bespokeSixNodeDefinition(command);
    const genericDefinition = buildScreenerJobDefinition(command);
    expect(deliverNodeStep(genericDefinition)).toBe(DELIVER_APPLY_STEP);
    expect(deliverNodeStep(bespokeDefinition)).toBe(SCREENER_DELIVER_STEP);
    await bespoke.control.defineJob(bespokeDefinition as never);
    await generic.control.defineJob(genericDefinition as never);
    const bespokeDispatch = await bespoke.control.runJob(command.jobId);
    const genericDispatch = await generic.control.runJob(command.jobId);
    const bespokeRun = await bespokeDispatch.completion!;
    const genericRun = await genericDispatch.completion!;
    expect(bespokeRun.state).toBe("completed");
    expect(genericRun.state).toBe("completed");
    expect(bespoke.sink).toHaveLength(1);
    expect(generic.sink).toHaveLength(1);
    const [bespokeCall] = bespoke.sink;
    const [genericCall] = generic.sink;
    // Shared sink contract.
    expect(genericCall.userLogin).toBe("owner");
    expect(bespokeCall.userLogin).toBe("owner");
    expect(genericCall.opts?.deliveryId).toBe(`workflow:${command.jobId}`);
    expect(bespokeCall.opts?.deliveryId).toBe(genericCall.opts?.deliveryId);
    const genericOutcome = genericCall.payload as Record<string, unknown>;
    const bespokeOutcome = bespokeCall.payload as Record<string, unknown>;
    // The canonical id rides the sink OPTS on both sides —
    // and the generic PAYLOAD too (the converter stamps it
    // in, which is what the door later stamps onto the
    // outcome). The bespoke payload is the live result and
    // never carries it — the id reaches its sink call only
    // through opts, from the serve output's reportId.
    expect(genericOutcome.canonicalReportId).toBe("rep-5826");
    expect(genericCall.opts?.canonicalReportId).toBe("rep-5826");
    expect(bespokeCall.opts?.canonicalReportId).toBe("rep-5826");
    expect(bespokeOutcome).not.toHaveProperty("canonicalReportId");
    // The generic payload IS the converter output for the run's
    // document (recomputed from the persisted JSON format body),
    // stamped with the run's own finishedAt — read off the
    // observed payload, since the engine's step clock is wall
    // time, not the harness's T0.
    const generateJobId = screenerFamilyJobIds(command.jobId).generate;
    const artifact = await generic.generatedStore.latest(generateJobId);
    const json = artifact?.reports
      .find((report) => report.kind === "screener-report")
      ?.formats.find((format) => format.format === "json");
    expect(json?.bodyText).toBeDefined();
    const document = JSON.parse(json!.bodyText!) as Parameters<
      typeof buildScreenerDeliveryPayload
    >[0]["document"];
    expect(genericOutcome).toEqual(
      buildScreenerDeliveryPayload({
        document,
        canonicalReportId: "rep-5826",
        trigger: command.trigger,
        finishedAt: genericOutcome.timestamp as string,
      }),
    );
    // The bespoke payload is the live screener result: its
    // matched count is the live ranking's count (every symbol
    // matches on this fixture's flat quotes), not the generic
    // document's — the two payloads are different shapes by
    // design, and the test pins the live shape, not a number
    // borrowed from the old hand-built serve fixture.
    expect(bespokeOutcome.matchedCount).toBe(
      (bespokeOutcome.allStocks as unknown[]).length,
    );
    expect(bespokeOutcome.allStocks).toBeDefined();
    expect(bespokeOutcome.totalScanned).toBe(4);
  });

  it("step parity, same generate output: identical sink calls for the converter payload (#5885)", async () => {
    // One generate output — the converter payload + the report
    // id — into both deliver steps. The bespoke step passes
    // the payload through unchanged (it never re-derives the
    // ranking), so the two sink calls are identical.
    const document = {
      title: "Screener report",
      summary: "4 symbols scanned.",
      inputSummary: {
        symbols: 4,
        advancers: 2,
        decliners: 1,
        flat: 1,
        meanScores: {},
        topByComposite: [
          { symbol: "AAPL", score: 0.9 },
          { symbol: "MSFT", score: 0.8 },
        ],
      },
      rows: [
        { symbol: "AAPL", lastPrice: 150, signals: { screen: "BULLISH_MOMENTUM" }, scores: {}, compositeScore: 0.9, unavailable: false },
        { symbol: "MSFT", lastPrice: 300, signals: { screen: "RANGE_BOUND" }, scores: {}, compositeScore: 0.8, unavailable: false },
      ],
      universeLabel: "nasdaq100",
      lineage: { analyzeJobId: "analyze", inputArtifactId: "art-1", inputRunId: "run-1" },
      ruleSets: ["screen"],
    };
    const payload = buildScreenerDeliveryPayload({
      document: document as never,
      canonicalReportId: "rep-5826",
      trigger: "manual",
      finishedAt: iso(T0),
    });
    // The bespoke step reads the login from its prior (the
    // serve output always carries it); the generic step reads
    // it from params. The generate output carries it here so
    // both steps see the login their own chain gives them.
    const generateOutput = { payload, reportId: "rep-5826", userLogin: "owner" };
    const bespokeSink = makeSink();
    const genericSink = makeSink();
    const bespokeRegistry = createScreenerStepRegistry({
      agentFor: () => new ScreenerAgent({ storage: new FakeStorage() } as any, {} as any) as never,
      storeReport: async () => {},
      deliverOutcome: bespokeSink.sink,
    });
    const genericRegistry = new JobStepRegistry();
    registerDeliverStep(genericRegistry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: genericSink.sink,
    });
    const bespokeOut = await bespokeRegistry.resolve(SCREENER_DELIVER_STEP)(
      stepCtx({ input: generateOutput }),
    );
    const genericOut = await genericRegistry.resolve(DELIVER_APPLY_STEP)(
      stepCtx({ input: generateOutput }),
    );
    expect(genericOut.output).toEqual(bespokeOut.output);
    expect(genericSink.calls).toHaveLength(1);
    expect(genericSink.calls[0]).toEqual(bespokeSink.calls[0]);
    expect(genericSink.calls[0]?.opts?.canonicalReportId).toBe("rep-5826");
  });

  it("duplicate limitation: the generic chain carries no duplicate, so a second delivery re-calls the sink with the same delivery id (#5885)", async () => {
    // The generate output carries no `duplicate` field, so the
    // scheduled-duplicate pass-through never fires in the
    // generic chain: delivering the same generate output twice
    // calls the sink twice with the SAME workflow:<jobId>
    // delivery id. That is wasted work, not double delivery —
    // the sink converges on the delivery id (no second tracked
    // record) — and it is pinned here until the duplicate
    // signal is threaded through generate (out of scope for
    // this slice; see the issue).
    const { generic } = await makeParityHarness();
    const command = marketCommand();
    await generic.control.defineJob(buildScreenerJobDefinition(command) as never);
    const dispatch = await generic.control.runJob(command.jobId);
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(generic.sink).toHaveLength(1);
    const first = generic.sink[0]!;
    // Deliver the same generate output a second time through
    // the step directly: the sink is called again, same id.
    const artifact = await generic.generatedStore.latest(
      screenerFamilyJobIds(command.jobId).generate,
    );
    const json = artifact?.reports
      .find((report) => report.kind === "screener-report")
      ?.formats.find((format) => format.format === "json");
    const document = JSON.parse(json!.bodyText!) as Parameters<
      typeof buildScreenerDeliveryPayload
    >[0]["document"];
    const payload = buildScreenerDeliveryPayload({
      document,
      canonicalReportId: "rep-5826",
      trigger: command.trigger,
      // The re-delivery rebuilds the payload with the first
      // delivery's own finishedAt, so the two sink payloads
      // are identical (the engine's step clock is wall time,
      // not the harness's T0).
      finishedAt: (first.payload as Record<string, unknown>).timestamp as string,
    });
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: generic.sinkFn,
    });
    await registry.resolve(DELIVER_APPLY_STEP)(
      stepCtx({ input: { payload, reportId: "rep-5826" } }),
    );
    expect(generic.sink).toHaveLength(2);
    expect(generic.sink[1]?.opts?.deliveryId).toBe(first.opts?.deliveryId);
    expect(generic.sink[1]?.payload).toEqual(first.payload);
  });

  it("step parity, market: same output and same sink args", async () => {
    // The bespoke side runs through the real agent stage; the
    // generic side through deliver.apply with the same sink.
    const bespokeSink = makeSink();
    const genericSink = makeSink();
    const bespokeRegistry = createScreenerStepRegistry({
      agentFor: () => new ScreenerAgent({ storage: new FakeStorage() } as any, {} as any) as never,
      storeReport: async () => {},
      deliverOutcome: bespokeSink.sink,
    });
    const genericRegistry = new JobStepRegistry();
    registerDeliverStep(genericRegistry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: genericSink.sink,
    });
    const bespokeHandler = bespokeRegistry.resolve(SCREENER_DELIVER_STEP);
    const genericHandler = genericRegistry.resolve(DELIVER_APPLY_STEP);

    const bespokeOut = await bespokeHandler(stepCtx());
    const genericOut = await genericHandler(stepCtx());
    // The outcome (the deliver output) is identical; the generic
    // result additionally carries the step descriptor.
    expect(genericOut.output).toEqual(bespokeOut.output);
    expect(genericSink.calls).toHaveLength(1);
    expect(genericSink.calls[0]).toEqual(bespokeSink.calls[0]);
  });

  it("step parity, goal: the goal branch threads goalScreen + canonicalReportId through both", async () => {
    const goalScreen = {
      scenario: { goalKind: "growth", direction: "long" },
      scenarioSource: "built",
      symbols: ["AAPL"],
    };
    const bespokeSink = makeSink();
    const genericSink = makeSink();
    const bespokeRegistry = createScreenerStepRegistry({
      agentFor: () => new ScreenerAgent({ storage: new FakeStorage() } as any, {} as any) as never,
      storeReport: async () => {},
      deliverOutcome: bespokeSink.sink,
    });
    const genericRegistry = new JobStepRegistry();
    registerDeliverStep(genericRegistry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: genericSink.sink,
    });
    const ctx = stepCtx({ params: { userLogin: "owner", deliver: true, goalScreen, screener: true } });
    const bespokeOut = await bespokeRegistry.resolve(SCREENER_DELIVER_STEP)(stepCtx({ params: { userLogin: "owner", deliver: true, goalScreen } }));
    const genericOut = await genericRegistry.resolve(DELIVER_APPLY_STEP)(ctx);
    expect(genericOut.output).toEqual(bespokeOut.output);
    expect(genericSink.calls[0]?.opts?.goalScreen).toEqual(goalScreen);
    expect(genericSink.calls[0]?.opts?.goalScreen).toEqual(bespokeSink.calls[0]?.opts?.goalScreen);
    expect(genericSink.calls[0]?.opts?.canonicalReportId).toBe("rep-5826");
    expect(genericSink.calls[0]?.opts?.canonicalReportId).toBe(
      bespokeSink.calls[0]?.opts?.canonicalReportId,
    );
  });

  it("deliver: false skips without calling the sink", async () => {
    const { calls, sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    const out = await registry
      .resolve(DELIVER_APPLY_STEP)
      (stepCtx({ params: { userLogin: "owner", deliver: false, screener: true } }));
    expect((out.output as any)?.delivered).toBe(false);
    expect((out.output as any)?.deliverSkipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a scheduled duplicate passes through untouched, sink never called", async () => {
    const { calls, sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    const dup = { ...serveOutputFixture(), duplicate: true };
    const out = await registry
      .resolve(DELIVER_APPLY_STEP)
      (stepCtx({ params: { userLogin: "owner", deliver: true, screener: true }, input: dup }));
    expect((out.output as any)?.delivered).toBe(false);
    expect((out.output as any)?.deliverSkipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("a sharded unit reads its own shard's serve output from the per-shard map", async () => {
    const { calls, sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    const map = { s0: serveOutputFixture(), s1: { ...serveOutputFixture(), reportId: "rep-other" } };
    const out = await registry.resolve(DELIVER_APPLY_STEP)(
      stepCtx({
        shardKey: "s0",
        params: { userLogin: "owner", deliver: true, screener: true },
        input: map,
      }),
    );
    expect((out.output as any)?.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts?.canonicalReportId).toBe("rep-5826");
  });

  it("a sink refusal is recorded, never a failed run", async () => {
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: async () => {
        throw new Error("delivery down");
      },
    });
    const out = await registry
      .resolve(DELIVER_APPLY_STEP)
      (stepCtx({ params: { userLogin: "owner", deliver: true, screener: true } }));
    expect((out.output as any)?.delivered).toBe(false);
    expect((out.output as any)?.deliverError).toContain("delivery down");
  });

  it("an unwired sink refuses by name", async () => {
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
    });
    await expect(
      registry.resolve(DELIVER_APPLY_STEP)(
        stepCtx({ params: { userLogin: "owner", deliver: true, screener: true } }),
      ),
    ).rejects.toThrow(/DELIVER_SCREENER_SINK_NOT_CONFIGURED/);
  });

  it("a missing userLogin refuses by name, like the bespoke step", async () => {
    const { sink } = makeSink();
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
      screenerDeliverOutcome: sink,
    });
    await expect(
      registry.resolve(DELIVER_APPLY_STEP)(
        stepCtx({ params: { deliver: true, screener: true } }),
      ),
    ).rejects.toThrow(/SCREENER_STEP_NO_USER/);
  });

  it("without the screener marker the step still resolves a deliver job (channel path unchanged)", async () => {
    const registry = new JobStepRegistry();
    registerDeliverStep(registry, {
      registry: buildDeliverJobRegistry({}),
      generatedStore: null,
      deliveryStore: null,
      senders: {},
    });
    await expect(
      registry.resolve(DELIVER_APPLY_STEP)(
        stepCtx({ params: { deliverJobId: "no-such-job" } }),
      ),
    ).rejects.toThrow(/DELIVER_JOB_NOT_FOUND/);
  });
});
