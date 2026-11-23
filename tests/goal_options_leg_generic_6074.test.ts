// @vitest-environment node
/**
 * Issue #6074 ([One engine] #4437 slice 6d-c) — the goal options leg runs
 * the options-pipeline nodes. The leg resolves its symbols explicit → the
 * ONE shared externalized default as a universe stage input (the #5515
 * default universe) → named refusal (owner rule 2026-11-22: never a
 * symbol-less run, for ANY run; no leg-local literal), then persists the
 * per-run options-screen definition and runs `options.runRoot` +
 * `options.runStage` × 8 in-process inside goal.optionsLeg, reading the
 * screen artifact back for the result the 6d-a assemble node consumes.
 * The optionsWorkflow dep call never runs on the engine path. The legacy
 * `screener.goal` step's default runner is the composition itself
 * (runGoalScreenOnEngine is retired, recorded in the deprecation ledger).
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
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import {
  buildScreenerJobDefinition,
  readGoalOptionsLegScreen,
  resolveGoalOptionsLegSymbols,
  saveGoalOptionsLegDefinition,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import type { OptionsWorkflowStepDeps } from "../src/services/optionsPipelineJobs";
import {
  optionsStageStorageFromArtifacts,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { ScreenerTaskLedger } from "../src/services/screenerTaskLedger";
import { buildScenario } from "../src/services/goalScenarioEngine";
import { buildGoalScreenPlan } from "../src/services/goalDrivenScreen";
import { defaultUniverseId } from "../src/config/defaultUniverse";
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
import type { OptionChainSource } from "../src/trading/optionChainSource";
import type { BrokerOptionChain } from "../src/types";

// The run clock: today at midnight UTC (never a fixed calendar date).
const T0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString();

// Issue #6074 — the fake chain's expiry is T0 + 30d (DTE 30 under the
// plan's default filter, inside the 1..90 window the screen uses), so
// the expiry never rots overnight.
const EXPIRY_MS = T0 + 30 * 24 * 3600_000;
const EXPIRY_DATE = new Date(EXPIRY_MS);
const EXPIRY = {
  year: EXPIRY_DATE.getUTCFullYear(),
  month: EXPIRY_DATE.getUTCMonth() + 1,
  day: EXPIRY_DATE.getUTCDate(),
};
const EXPIRY_YYMMDD = `${String(EXPIRY.year).slice(2)}${String(EXPIRY.month).padStart(2, "0")}${String(EXPIRY.day).padStart(2, "0")}`;

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

function directionalScenario() {
  // Issue #6074 — the scenario carries explicit constraints, the
  // incomeScenario pattern (#3186). Issue #6196 fixed the
  // default: buildScenario now fills a liquidity floor of
  // maxSpreadPct 15 (percent), which realistic quotes pass; the
  // explicit floor below (8%) is what the goal-leg tests use.
  // DTE 30 sits inside 21..60.
  return buildScenario({
    goalKind: "directional",
    portfolioRef: { kind: "hypothetical" },
    constraints: {
      dteWindow: { min: 21, max: 60 },
      liquidityFloor: { minOpenInterest: 500, minVolume: 100, maxSpreadPct: 8 },
    },
  });
}

function goalCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "goal-6074",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [{ shardId: "goal", symbols: [listing("AAPL"), listing("MSFT")] }],
    provider: "yahoo",
    deliver: true,
    goalScreen: {
      scenario: directionalScenario(),
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

// Issue #6074 — the fake chain source: one ATM pair per requested
// symbol at the expiry above (the #3186 goal-leg fixture shape:
// bid 1.0 / ask 1.05, OI 500, volume 100 — inside the scenario's
// explicit liquidity floor, so the pair matches instead of
// rejecting on spread/OI). Every requested symbol is served: an
// unserved symbol is a fetch error, and a fetch error makes the
// leg's screen partial (#1963).
function fakeChainSource(chainCalls: string[]): OptionChainSource {
  const chainFor = (symbol: string): BrokerOptionChain =>
    ({
      symbol,
      underlyingPrice: 100,
      selectedExpiry: EXPIRY,
      pairs: [
        {
          call: {
            symbol: `${symbol}${EXPIRY_YYMMDD}C00100000`,
            optionType: "CALL",
            strikePrice: 100,
            bid: 1.0,
            ask: 1.05,
            lastPrice: 1.02,
            volume: 100,
            openInterest: 500,
          },
          put: {
            symbol: `${symbol}${EXPIRY_YYMMDD}P00100000`,
            optionType: "PUT",
            strikePrice: 100,
            bid: 1.0,
            ask: 1.05,
            lastPrice: 1.02,
            volume: 100,
            openInterest: 500,
          },
        },
      ],
    }) as BrokerOptionChain;
  return {
    getOptionChains: async (params: { symbol?: string }) => {
      const symbol = (params?.symbol ?? "").toUpperCase();
      chainCalls.push(symbol);
      return symbol === "AAPL" || symbol === "MSFT" ? chainFor(symbol) : null;
    },
    getOptionExpireDates: async (symbol: string) => {
      void symbol;
      return [EXPIRY] as never;
    },
  } as OptionChainSource;
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
  chainCalls: string[];
  universeCalls: string[];
  quotaCharges: { userLogin: string; runId: string }[];
  datasetStore: InMemoryFeedDatasetStore;
  enrichedStore: InMemoryEnrichedDatasetStore;
  analyzedStore: InMemoryAnalyzedDatasetStore;
  generatedStore: InMemoryGeneratedDatasetStore;
  universes: InMemoryIndexListStore;
}

async function makeHarness(opts: {
  seedUniverse?: boolean;
  omitDefineDep?: boolean;
  omitScreenDep?: boolean;
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
  const chainCalls: string[] = [];
  const universeCalls: string[] = [];
  const quotaCharges: { userLogin: string; runId: string }[] = [];
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
      new ScreenerTaskLedger(taskStore, { newId: () => "goal-task-6074" }),
    goalQuotaCharge: async (input) => {
      quotaCharges.push({ userLogin: input.userLogin, runId: input.runId });
    },
    goalStockLegAnalyzedFor: async (analyzeJobId: string) =>
      analyzedStore.latestUsable(analyzeJobId),
    // Issue #6074 — the options leg's definition writer + screen
    // reader, bound from the harness stores exactly as the host
    // factories bind them from the residency's stores in production.
    // NOTE: no goalOptionsLeg override — the REAL leg runs.
    ...(opts.omitDefineDep
      ? {}
      : {
          goalOptionsLegDefineFor: async (raw: Record<string, unknown>) =>
            saveGoalOptionsLegDefinition(stores, raw),
        }),
    ...(opts.omitScreenDep
      ? {}
      : {
          goalOptionsLegScreenFor: async (legRunId: string) =>
            readGoalOptionsLegScreen(stores, legRunId),
        }),
  };
  const optionsDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    chainSourceFor: () => fakeChainSource(chainCalls),
    universeDepsFor: async () => {
      universeCalls.push("nasdaq");
      return { fetchListings: async () => [listing("AAPL")] };
    },
    queue: null,
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
      optionsDeps,
    ),
    now: () => new Date(T0),
    newRunId: () => "run-goal-6074",
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
    chainCalls,
    universeCalls,
    quotaCharges,
    datasetStore,
    enrichedStore,
    analyzedStore,
    generatedStore,
    universes,
  };
}

describe("symbol resolution (#6074)", () => {
  it("explicit symbols win, normalized", () => {
    const plan = buildGoalScreenPlan(directionalScenario(), {
      symbols: [" aapl ", "AAPL", "MSFT"],
    });
    expect(resolveGoalOptionsLegSymbols(plan)).toEqual({ symbols: ["AAPL", "MSFT"] });
  });

  it("no symbols resolves the shared externalized default, never a literal", () => {
    const plan = buildGoalScreenPlan(directionalScenario());
    expect(resolveGoalOptionsLegSymbols(plan)).toEqual({
      universe: defaultUniverseId().toLowerCase(),
    });
  });

  it("no symbols and no resolvable default refuses by name", () => {
    const plan = buildGoalScreenPlan(directionalScenario());
    expect(() => resolveGoalOptionsLegSymbols(plan, "")).toThrow(
      /GOAL_OPTIONS_LEG_NO_SYMBOLS/,
    );
  });
});

describe("goal options leg on engine nodes (#6074)", () => {
  it("an explicit-symbols goal run screens options through the nodes, never the agent method", async () => {
    const h = await makeHarness();
    const optionsSpy = vi.spyOn(h.agent, "runGoalOptionsLeg");
    const engineSpy = vi.spyOn(h.agent, "runGoalScreenOnEngine");
    const stockSpy = vi.spyOn(h.agent, "runGoalStockLeg");
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6074");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.quotaCharges).toHaveLength(1);

    // The agent methods never ran — the legs ran on engine nodes.
    expect(optionsSpy).not.toHaveBeenCalled();
    expect(engineSpy).not.toHaveBeenCalled();
    expect(stockSpy).not.toHaveBeenCalled();

    // The options chain was fetched for AAPL through the fake source.
    expect(h.chainCalls).toContain("AAPL");

    // The options-screen definition persisted for the leg run.
    const view = await h.control.getJob("goal-6074");
    const engineRunId = view.instance?.currentRunId!;
    expect(engineRunId).toBeTruthy();
    const legRunId = `goal-screen:${engineRunId}:options`;
    const optionsDef = await h.stores.definitions.getDefinition(
      `options-screen:${legRunId}`,
    );
    expect(optionsDef).not.toBeNull();
    expect(
      (optionsDef!.rawConfig as { request?: unknown }).request,
    ).toBeDefined();

    // The screen artifact is readable back under the leg's key,
    // scoped by the leg run id (the scope the resolving steps
    // write under).
    const screen = await optionsStageStorageFromArtifacts(
      h.stores.artifacts,
      legRunId,
    ).get<{ result: { matchedCount: number } }>(
      optionsArtifactKey(legRunId, "screen"),
    );
    expect(screen).toBeDefined();
    expect(screen!.result.matchedCount).toBeGreaterThanOrEqual(1);

    // The goal result carries both legs' hits.
    expect(h.stored).toHaveLength(1);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      hits: { assetClass: string; symbol: string }[];
      counts: {
        stocksScanned: number;
        stocksMatched: number;
        optionsUnderlyingsScanned: number;
        optionsContractsMatched: number;
        hits: number;
      };
    };
    expect(result.status).toBe("complete");
    expect(result.counts.optionsUnderlyingsScanned).toBe(2);
    expect(result.counts.optionsContractsMatched).toBeGreaterThanOrEqual(2);
    expect(
      result.hits.filter((hit) => hit.assetClass === "options"),
    ).toHaveLength(2);
    expect(h.delivered).toHaveLength(1);
  });

  it("a symbol-less goal run screens the shared default universe", async () => {
    const h = await makeHarness({ seedUniverse: true });
    const optionsSpy = vi.spyOn(h.agent, "runGoalOptionsLeg");
    const command = goalCommand({
      jobId: "goal-6074-default",
      shards: [{ shardId: "goal" }],
      goalScreen: { ...(goalCommand().goalScreen as object), symbols: undefined } as never,
    });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6074-default");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(optionsSpy).not.toHaveBeenCalled();
    // The leg stamped the universe input: the factory served the
    // default universe's listings and the chain was fetched for AAPL.
    // (The factory is consulted once per stage that rebuilds with
    // universe deps, so the count is ≥ 1, not exactly 1.)
    expect(h.universeCalls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(h.universeCalls)).toEqual(new Set(["nasdaq"]));
    expect(h.chainCalls).toContain("AAPL");
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      counts: { optionsUnderlyingsScanned: number; optionsContractsMatched: number };
    };
    expect(result.status).toBe("complete");
    expect(result.counts.optionsUnderlyingsScanned).toBe(1);
    expect(result.counts.optionsContractsMatched).toBeGreaterThanOrEqual(1);
  });

  it("a leg without its definition writer fails as a class, never the run", async () => {
    const h = await makeHarness({ omitDefineDep: true });
    const command = goalCommand({ jobId: "goal-6074-no-define" });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6074-no-define");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.stored).toHaveLength(1);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      partial?: { failedClasses: string[]; reasons: Record<string, string> };
    };
    expect(result.status).toBe("partial");
    expect(result.partial?.failedClasses).toEqual(["options"]);
    expect(result.partial?.reasons.options).toMatch(
      /GOAL_OPTIONS_LEG_NO_DEFINITION_STORE/,
    );
  });

  it("a leg without its screen reader fails as a class, never the run", async () => {
    const h = await makeHarness({ omitScreenDep: true });
    const command = goalCommand({ jobId: "goal-6074-no-screen" });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6074-no-screen");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.stored).toHaveLength(1);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      partial?: { failedClasses: string[]; reasons: Record<string, string> };
    };
    expect(result.status).toBe("partial");
    expect(result.partial?.failedClasses).toEqual(["options"]);
    expect(result.partial?.reasons.options).toMatch(
      /GOAL_OPTIONS_LEG_NO_ARTIFACT_STORE/,
    );
  });

  it("options not requested skips the leg", async () => {
    const h = await makeHarness();
    const optionsSpy = vi.spyOn(h.agent, "runGoalOptionsLeg");
    const command = goalCommand({
      jobId: "goal-6074-stocks-only",
      goalScreen: {
        ...(goalCommand().goalScreen as object),
        assetClasses: ["stocks"],
      } as never,
    });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6074-stocks-only");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(optionsSpy).not.toHaveBeenCalled();
    expect(h.chainCalls).toEqual([]);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as {
      status: string;
      hits: { assetClass: string }[];
    };
    expect(result.status).toBe("complete");
    expect(result.hits.every((hit) => hit.assetClass === "stocks")).toBe(true);
  });
});

describe("goal step default runner (#6074)", () => {
  it("an old-style definition runs the composition, never the legacy runner", async () => {
    const h = await makeHarness();
    const engineSpy = vi.spyOn(h.agent, "runGoalScreenOnEngine");
    const goalStageSpy = vi.spyOn(h.agent, "screenGoalStage");
    const optionsSpy = vi.spyOn(h.agent, "runGoalOptionsLeg");
    const command = goalCommand({ jobId: "goal-6074-old" });
    // Old-style definition: the analyze node is the single
    // screener.goal step (v1 shape), with only the params the old
    // node carried — goalScreen + userLogin — never the family ids
    // the v2 builder writes; the composition runner synthesizes them.
    const raw = buildScreenerJobDefinition(command) as any;
    let node = raw.root;
    while (node) {
      if (node.kind === "analyze") {
        node.steps = [
          {
            step: "screener.goal",
            params: {
              goalScreen: command.goalScreen,
              userLogin: "owner",
              trigger: "manual",
            },
          },
        ];
      }
      node = node.children?.[0];
    }
    await h.control.defineJob(raw);
    const dispatch = await h.control.runJob("goal-6074-old");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.quotaCharges).toHaveLength(1);
    expect(h.chainCalls).toContain("AAPL");
    // The legacy runner is nowhere on the path.
    expect(engineSpy).not.toHaveBeenCalled();
    expect(goalStageSpy).not.toHaveBeenCalled();
    expect(optionsSpy).not.toHaveBeenCalled();
    expect(h.stored).toHaveLength(1);
    const envelope = h.stored[0] as { result: Record<string, unknown> };
    const result = envelope.result as { status: string };
    expect(result.status).toBe("complete");
  });
});
