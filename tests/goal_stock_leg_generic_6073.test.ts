// @vitest-environment node
/**
 * Issue #6073 ([One engine] #4437 slice 6d-b) — the goal stock leg runs
 * the generic nodes. The leg resolves its symbols explicit → the ONE
 * shared externalized default (the #5515 default universe, nasdaq100)
 * → named refusal (owner rule 2026-11-22: never a symbol-less run, for
 * ANY run; no leg-local literal), then runs feed.pull → enrich.screener
 * → analyze.screener → generate.apply in-process inside goal.stockLeg
 * and maps the analyzed artifact's standouts to the ScreeningResult
 * the 6d-a assemble node consumes. The nested dispatch
 * (runGoalStockLegViaWorkflow) never runs on the engine path.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { InMemoryEnrichedDatasetStore } from "../src/data/inMemoryEnrichedDatasetAdapter";
import { InMemoryAnalyzedDatasetStore } from "../src/data/inMemoryAnalyzedDatasetAdapter";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import { InMemoryScreenerTaskStore } from "../src/data/inMemoryScreenerTaskStoreAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import {
  buildScreenerJobDefinition,
  GOAL_COMPOSITION_STEPS,
  resolveGoalStockLegSymbols,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { ScreenerTaskLedger } from "../src/services/screenerTaskLedger";
import { buildScenario } from "../src/services/goalScenarioEngine";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
import { ensureFeedPipelineJobs } from "../src/services/feedPipelineJobs";
import { ensureEnrichPipelineJobs } from "../src/services/enrichPipelineJobs";
import { ensureAnalyzePipelineJobs } from "../src/services/analyzePipelineJobs";
import { ensureGeneratePipelineJobs } from "../src/services/generatePipelineJobs";
import { ensureDeliverPipelineJobs } from "../src/services/deliverPipelineJobs";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type {
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
} from "../src/types";
import type { DataProvider, DataResult, QuoteResult } from "../src/trading";
import type { MarketDataResearchCompanyFundamentals } from "../src/types";

// The run clock: today at midnight UTC (never a fixed calendar date).
const T0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString();

const SYMBOLS = ["AAPL", "MSFT"];
const PRICES: Record<string, number> = { AAPL: 150, MSFT: 300 };
// Issue #6073 — the day move IS the momentum feature
// (computeScreeningIndicators: momentum = changePercent), so the
// screen rule flags AAPL (momentum 8 > 0.5 → BULLISH_MOMENTUM) and
// not MSFT (momentum -2 → RANGE_BOUND, score 40 < 60).
const CHANGES: Record<string, number> = { AAPL: 8, MSFT: -2 };

function quote(symbol: string): MarketDataResearchQuote {
  const price = PRICES[symbol] ?? 100;
  const changePercent = CHANGES[symbol] ?? 1;
  const change = (price * changePercent) / 100;
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
    change,
    changePercent,
    volume: 1_000_000,
    open: price - 1,
    high: price + 1,
    low: price - 2,
    previousClose: price - change,
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

function goalCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "goal-6073",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [{ shardId: "goal", symbols: [listing("AAPL"), listing("MSFT")] }],
    provider: "yahoo",
    deliver: true,
    goalScreen: {
      scenario: buildScenario({
        goalKind: "directional",
        portfolioRef: { kind: "hypothetical" },
        constraints: {},
      }),
      scenarioSource: "built",
      symbols: ["AAPL", "MSFT"],
    },
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
      void symbol;
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
      }) as DataResult<unknown>,
  };
}

interface Harness {
  control: JobPipelineControl;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  agent: ScreenerAgent;
  taskStore: InMemoryScreenerTaskStore;
  stored: unknown[];
  delivered: { payload: unknown; userLogin: string }[];
  yahooCalls: string[];
  barsCalls: string[];
  quoteCalls: string[];
  quotaCharges: { userLogin: string; runId: string }[];
  optionsLegCalls: unknown[];
  datasetStore: InMemoryFeedDatasetStore;
  enrichedStore: InMemoryEnrichedDatasetStore;
  analyzedStore: InMemoryAnalyzedDatasetStore;
  generatedStore: InMemoryGeneratedDatasetStore;
  universes: InMemoryIndexListStore;
}

async function makeHarness(opts: {
  seedUniverse?: boolean;
  omitAnalyzedDep?: boolean;
} = {}): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const datasetStore = new InMemoryFeedDatasetStore();
  const enrichedStore = new InMemoryEnrichedDatasetStore();
  const analyzedStore = new InMemoryAnalyzedDatasetStore();
  const generatedStore = new InMemoryGeneratedDatasetStore();
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const universes = new InMemoryIndexListStore();
  if (opts.seedUniverse) {
    await universes.store({
      index: "nasdaq100",
      snapshotDate: new Date(T0 - 4 * 24 * 3600_000).toISOString().slice(0, 10),
      symbols: SYMBOLS.map((symbol) => ({ symbol })),
      source: "test",
      sourceLabel: "Test (nasdaq100)",
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
  const storage = new FakeStorage();
  storage.map.set("screener:owner-login", "owner");
  const agent = new ScreenerAgent({ storage } as any, {} as any);
  const stored: unknown[] = [];
  const delivered: { payload: unknown; userLogin: string }[] = [];
  const yahooCalls: string[] = [];
  const barsCalls: string[] = [];
  const quoteCalls: string[] = [];
  const quotaCharges: { userLogin: string; runId: string }[] = [];
  const optionsLegCalls: unknown[] = [];
  const taskStore = new InMemoryScreenerTaskStore();
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
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async (payload, userLogin) => {
      delivered.push({ payload, userLogin });
    },
    goalTaskLedgerFor: () =>
      new ScreenerTaskLedger(taskStore, { newId: () => "goal-task-6073" }),
    goalQuotaCharge: async (input) => {
      quotaCharges.push({ userLogin: input.userLogin, runId: input.runId });
    },
    // Issue #6073 — the options leg stays faked: only the stock leg
    // is under test here (6d-c re-points the options leg).
    goalOptionsLeg: async (input) => {
      optionsLegCalls.push(input);
      return {
        assetClass: "options",
        providerId: "options-screen-workflow",
        result: {
          status: "matches_found",
          totalUnderlyingsScanned: 1,
          matchedCount: 1,
          contracts: [{ underlyingSymbol: "AAPL" }],
        },
      } as never;
    },
    // Issue #6073 — the analyzed-artifact reader the stock leg maps
    // from: the harness store, exactly as the host factories bind
    // createAnalyzedDatasetPorts(env) in production.
    ...(opts.omitAnalyzedDep
      ? {}
      : {
          goalStockLegAnalyzedFor: async (analyzeJobId: string) =>
            analyzedStore.latestUsable(analyzeJobId),
        }),
    // NOTE: no goalStockLeg override — the REAL leg runs.
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createPipelineStepRegistry(
      {
        registry: buildFeedJobRegistry({}),
        providerFor: (def) => fakeProvider(def.sourceId, quoteCalls),
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
        screenerDeliverOutcome: deps.deliverOutcome,
      },
      deps,
    ),
    now: () => new Date(T0),
    newRunId: () => "run-goal-6073",
  });
  await ensureFeedPipelineJobs(control, stores, {});
  await ensureEnrichPipelineJobs(control, stores, {});
  await ensureAnalyzePipelineJobs(control, stores, {});
  await ensureGeneratePipelineJobs(control, stores, {});
  await ensureDeliverPipelineJobs(control, stores, {});
  return {
    control,
    stores,
    agent,
    taskStore,
    stored,
    delivered,
    yahooCalls,
    barsCalls,
    quoteCalls,
    quotaCharges,
    optionsLegCalls,
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
    universes,
  };
}

describe("symbol resolution (#6073)", () => {
  it("explicit symbols win, normalized", () => {
    expect(resolveGoalStockLegSymbols(goalCommand())).toEqual({
      symbols: ["AAPL", "MSFT"],
    });
    expect(
      resolveGoalStockLegSymbols(
        goalCommand({ goalScreen: { ...(goalCommand().goalScreen as object), symbols: [" aapl ", "AAPL", "msft"] } as never }),
      ),
    ).toEqual({ symbols: ["AAPL", "MSFT"] });
  });

  it("no symbols resolves the shared externalized default, never a literal", () => {
    const noSymbols = goalCommand({
      shards: [{ shardId: "goal" }],
      goalScreen: { ...(goalCommand().goalScreen as object), symbols: undefined } as never,
    });
    // The #5515 default universe (config/vocabulary.json
    // defaults.universe = nasdaq100), read through its one reader.
    expect(resolveGoalStockLegSymbols(noSymbols)).toEqual({ universe: "nasdaq100" });
  });

  it("no symbols and no resolvable default refuses by name", () => {
    const noSymbols = goalCommand({
      shards: [{ shardId: "goal" }],
      goalScreen: { ...(goalCommand().goalScreen as object), symbols: undefined } as never,
    });
    expect(() => resolveGoalStockLegSymbols(noSymbols, "")).toThrow(
      /GOAL_STOCK_LEG_NO_SYMBOLS/,
    );
  });
});

describe("goal definition builder (#6073)", () => {
  it("a goal command with symbols carries the family job ids + leg params on the analyze node", () => {
    const raw = buildScreenerJobDefinition(goalCommand()) as any;
    let node = raw.root;
    const paramsByKind = new Map<string, Record<string, unknown>>();
    while (node) {
      paramsByKind.set(node.kind, node.steps?.[0]?.params ?? {});
      node = node.children?.[0];
    }
    const analyze = paramsByKind.get("analyze")!;
    expect(analyze.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(analyze.enrichJobId).toBe("yahoo-nasdaq100-quotes-enrich");
    expect(analyze.analyzeJobId).toBe("yahoo-nasdaq100-quotes-enrich-analyze");
    expect(analyze.generateJobId).toBe("yahoo-nasdaq100-quotes-enrich-analyze-generate");
    // The market spec's analyze/generate stage params, read at build
    // time — single home, no duplicated literal.
    expect(analyze.stockLegAnalyzeParams).toEqual({
      ruleSets: ["screen", "factors"],
      inputMode: "handOff",
    });
    expect(analyze.stockLegGenerateParams).toEqual({ reports: ["screener-report"] });
    // Symbols mode needs no universe anywhere.
    expect(analyze.stockLegUniverse).toBeUndefined();
    // Explicit symbols ride the goal shard row (and the flat list).
    // The command's row already carried them as listings, so the
    // builder does not duplicate them as bare strings.
    const shards = raw.root.steps[0].params.shards as { shardId: string; symbols?: unknown[] }[];
    expect(shards).toEqual([
      { shardId: "goal", symbols: [listing("AAPL"), listing("MSFT")] },
    ]);
    expect(raw.root.steps[0].params.symbols).toEqual([
      listing("AAPL"),
      listing("MSFT"),
    ]);
    // No universe param: symbols mode needs none.
    expect(paramsByKind.get("feed")!.universe).toBeUndefined();
    // The composition is untouched.
    expect(paramsByKind.get("analyze")!.goalScreen).toBeDefined();
  });

  it("a goal command with symbols only on goalScreen gains them on the row and the flat list", () => {
    // The production shape (buildGoalScreenCommand puts symbols
    // only on goalScreen.symbols; the shard row is empty): the
    // builder injects the resolved symbols as bare strings.
    const raw = buildScreenerJobDefinition(
      goalCommand({ shards: [{ shardId: "goal" }] }),
    ) as any;
    const shards = raw.root.steps[0].params.shards as {
      shardId: string;
      symbols?: unknown[];
    }[];
    expect(shards).toEqual([{ shardId: "goal", symbols: ["AAPL", "MSFT"] }]);
    expect(raw.root.steps[0].params.symbols).toEqual(["AAPL", "MSFT"]);
  });

  it("a goal command without symbols carries the default universe on the feed node", () => {
    const raw = buildScreenerJobDefinition(
      goalCommand({
        shards: [{ shardId: "goal" }],
        goalScreen: { ...(goalCommand().goalScreen as object), symbols: undefined } as never,
      }),
    ) as any;
    let node = raw.root;
    const paramsByKind = new Map<string, Record<string, unknown>>();
    while (node) {
      paramsByKind.set(node.kind, node.steps?.[0]?.params ?? {});
      node = node.children?.[0];
    }
    expect(paramsByKind.get("feed")!.universe).toBe("nasdaq100");
    expect(paramsByKind.get("feed")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("analyze")!.analyzeJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    // The leg's working copy of the resolved universe, frozen at
    // build time on the analyze node (the leg runs there, not on
    // the feed node).
    expect(paramsByKind.get("analyze")!.stockLegUniverse).toBe("nasdaq100");
  });

  it("the market definition is unchanged", () => {
    const raw = buildScreenerJobDefinition({
      jobId: "screen-6073",
      type: "run-screen",
      source: "manual",
      trigger: "manual",
      userLogin: "owner",
      role: "parent",
      shards: [{ shardId: "s0", symbols: [listing("AAPL")] }],
      provider: "yahoo",
      deliver: false,
    }) as any;
    expect(jobDefinitionSpec("screener").stages.map((s) => s.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
    ]);
    let node = raw.root;
    const paramsByKind = new Map<string, Record<string, unknown>>();
    while (node) {
      paramsByKind.set(node.kind, node.steps?.[0]?.params ?? {});
      node = node.children?.[0];
    }
    expect(paramsByKind.get("feed")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("analyze")!.analyzeJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    // A market run never carries a goal param.
    expect(paramsByKind.get("feed")!.goalScreen).toBeUndefined();
  });
});

describe("goal stock leg on generic nodes (#6073)", () => {
  it("an explicit-symbols goal run screens through the generic chain, never the nested dispatch", async () => {
    const h = await makeHarness();
    const nestedSpy = vi.spyOn(h.agent, "runGoalStockLeg");
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6073");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.quotaCharges).toHaveLength(1);
    expect(h.optionsLegCalls).toHaveLength(1);
    const tasks = await new ScreenerTaskLedger(h.taskStore).list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");

    // The nested dispatch never ran.
    expect(nestedSpy).not.toHaveBeenCalled();
    // The bespoke quote path never ran for a goal command.
    expect(h.yahooCalls).toEqual([]);
    // The generic feed fetched the explicit symbols once each.
    expect([...new Set(h.quoteCalls)].sort()).toEqual(["AAPL", "MSFT"]);

    // Every generic leg persisted its artifact.
    const feed = await h.datasetStore.latestUsable("yahoo", "quotes");
    expect(feed).toBeTruthy();
    expect(feed!.quotes.map((q) => q.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    const enriched = await h.enrichedStore.latestUsable("yahoo-nasdaq100-quotes-enrich");
    expect(enriched).toBeTruthy();
    const analyzed = await h.analyzedStore.latestUsable(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    expect(analyzed).toBeTruthy();
    expect(analyzed!.rows.map((r) => r.symbol).sort()).toEqual(["AAPL", "MSFT"]);
    // The family's own matched set: AAPL flagged (momentum 8),
    // MSFT not (momentum -2).
    expect(analyzed!.summary.standouts.map((s) => s.symbol)).toEqual(["AAPL"]);
    const generated = await h.generatedStore.latestUsable(
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
    );
    expect(generated).toBeTruthy();
    expect(generated!.reports.map((r) => r.kind)).toContain("screener-report");

    // The goal result carries the leg's hits: 1 stock hit (AAPL) +
    // 1 options hit (fake leg).
    expect(h.stored).toHaveLength(1);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      hits: { assetClass: string; symbol: string }[];
      counts: { stocksScanned: number; stocksMatched: number; hits: number };
    };
    expect(result.status).toBe("complete");
    expect(result.counts.stocksScanned).toBe(2);
    expect(result.counts.stocksMatched).toBe(1);
    expect(result.counts.hits).toBe(2);
    expect(result.hits.filter((hit) => hit.assetClass === "stocks")).toEqual([
      expect.objectContaining({ symbol: "AAPL" }),
    ]);
    expect(h.delivered).toHaveLength(1);
  });

  it("a symbol-less goal run screens the shared default universe", async () => {
    const h = await makeHarness({ seedUniverse: true });
    const nestedSpy = vi.spyOn(h.agent, "runGoalStockLeg");
    const command = goalCommand({
      jobId: "goal-6073-default",
      shards: [{ shardId: "goal" }],
      goalScreen: { ...(goalCommand().goalScreen as object), symbols: undefined } as never,
    });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6073-default");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(nestedSpy).not.toHaveBeenCalled();
    // The feed pulled the default universe's stored list.
    expect([...new Set(h.quoteCalls)].sort()).toEqual(["AAPL", "MSFT"]);
    const analyzed = await h.analyzedStore.latestUsable(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    expect(analyzed!.summary.standouts.map((s) => s.symbol)).toEqual(["AAPL"]);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      counts: { stocksScanned: number; stocksMatched: number };
    };
    expect(result.status).toBe("complete");
    expect(result.counts.stocksScanned).toBe(2);
    expect(result.counts.stocksMatched).toBe(1);
  });

  it("a leg without its analyzed reader fails as a class, never the run", async () => {
    const h = await makeHarness({ omitAnalyzedDep: true });
    const command = goalCommand({ jobId: "goal-6073-no-store" });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6073-no-store");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.stored).toHaveLength(1);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      partial?: { failedClasses: string[]; reasons: Record<string, string> };
    };
    expect(result.status).toBe("partial");
    expect(result.partial?.failedClasses).toEqual(["stocks"]);
    expect(result.partial?.reasons.stocks).toMatch(/GOAL_STOCK_LEG_NO_ANALYZED_STORE/);
    const tasks = await new ScreenerTaskLedger(h.taskStore).list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.partial).toBe(true);
  });
});
