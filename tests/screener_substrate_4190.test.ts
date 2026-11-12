// @vitest-environment node
/**
 * Issue #4190 ([One engine] #3550 S1) — the screener substrate:
 * the engine can define and dispatch a stock-screen job (six
 * nodes, 1:1 with the catalog stages) in vitest, producing a
 * screen result. The new code is called only by tests; the
 * bespoke flow still runs production screens.
 *
 * - Job-definition builder: WorkflowJobCommand -> 6-node nested
 *   chain (jobId = command.jobId; processing.shards = command
 *   shard ids; goal leg on the same six nodes).
 * - Screener step registry + composition in BOTH residencies
 *   (host + workflow) through createPipelineStepRegistry.
 * - Engine proof (J7 pattern): a screener job defined +
 *   dispatched via the engine, producing a screen result —
 *   monolith (one shard) and sharded (two shards) shapes,
 *   plus the goal leg branching like runShardFlow.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  vocabularyStageForNodeKind,
} from "../src/services/jobPipelineEngine";
import { createPipelineStepRegistry } from "../src/services/enrichPipelineJobs";
import { buildFeedJobRegistry } from "../src/services/feedJobs";
import { buildEnrichJobRegistry } from "../src/services/enrichJobs";
import { buildAnalyzeJobRegistry } from "../src/services/analyzeJobs";
import { buildGenerateJobRegistry } from "../src/services/generateJobs";
import { buildDeliverJobRegistry } from "../src/services/deliverJobs";
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
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
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
}

async function makeHarness(opts: {
  storeReport?: ScreenerStepDeps["storeReport"];
  deliverOutcome?: ScreenerStepDeps["deliverOutcome"];
  goalRunner?: ScreenerStepDeps["goalRunner"];
} = {}): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
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
    steps: createScreenerStepRegistry(deps),
    now: () => new Date(T0),
  });
  return { control, stores, runStore, storage, agent, stored, delivered, yahooCalls, barsCalls };
}

describe("job-definition builder (#4190)", () => {
  it("builds a six-node nested chain, 1:1 with the catalog stages", () => {
    const raw = buildScreenerJobDefinition(marketCommand()) as any;
    expect(raw.jobId).toBe("screen-manual-4190");
    const kinds: string[] = [];
    let node = raw.root;
    while (node) {
      kinds.push(node.kind);
      expect(node.children?.length ?? 0).toBeLessThanOrEqual(1);
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "store", "serve", "deliver"]);
    expect(raw.root.steps).toEqual([
      { step: SCREENER_FEED_STEP, params: expect.objectContaining({ userLogin: "owner" }) },
    ]);
    const stepsByKind = new Map<string, string>();
    node = raw.root;
    while (node) {
      stepsByKind.set(node.kind, node.steps?.[0]?.step);
      node = node.children?.[0];
    }
    expect(Object.fromEntries(stepsByKind)).toEqual({
      feed: SCREENER_FEED_STEP,
      enrich: SCREENER_GATHER_STEP,
      analyze: SCREENER_ANALYSIS_STEP,
      store: SCREENER_STORE_STEP,
      serve: SCREENER_SERVE_STEP,
      deliver: SCREENER_DELIVER_STEP,
    });
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

  it("is monolith with no shards, and the goal leg rides the same six nodes", () => {
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
    const command = marketCommand();
    const definition = await h.control.defineJob(buildScreenerJobDefinition(command));
    expect(definition.jobId).toBe("screen-manual-4190");

    const dispatch = await h.control.runJob("screen-manual-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");

    // The feed fetched every symbol once through the fake provider;
    // the gather fetched history for every quoted symbol.
    expect(h.yahooCalls.sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    expect(h.barsCalls.sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);

    // The store leg persisted the agent-local run and the
    // canonical row; the deliver leg delivered it once.
    const latest = h.storage.map.get("screener:latest") as any;
    expect(latest?.totalScanned).toBe(4);
    expect(latest?.success).toBe(true);
    expect(h.stored).toHaveLength(1);
    expect((h.stored[0] as any)?.totalScanned).toBe(4);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]?.userLogin).toBe("owner");
    expect((h.delivered[0]?.payload as any)?.totalScanned).toBe(4);

    // The run is on the platform run-record machinery, as the screener job.
    expect(h.runStore.listByJob("screen-manual-4190")).toHaveLength(1);
    expect(h.runStore.listByJob("screen-manual-4190")[0]?.outcome).toBe("success");
  });

  it("partitions symbols across shards with no symbol screened twice", async () => {
    const h = await makeHarness();
    const command = marketCommand({
      jobId: "screen-sharded-4190",
      shards: [
        { shardId: "s0", symbols: [listing("AAPL"), listing("NVDA")] },
        { shardId: "s1", symbols: [listing("MSFT"), listing("AMZN")] },
      ],
    });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("screen-sharded-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.yahooCalls.sort()).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
    expect(h.stored).toHaveLength(2);
    const scanned = (h.stored as any[]).map((s) => s.totalScanned).sort();
    expect(scanned).toEqual([2, 2]);
    const deliveredSymbols = (h.delivered as any[])
      .flatMap((d) => (d.payload as any).allStocks.map((s: any) => s.symbol))
      .sort();
    expect(deliveredSymbols).toEqual(["AAPL", "AMZN", "MSFT", "NVDA"]);
  });

  it("a store refusal is recorded, never a failed run (the flow's rule)", async () => {
    const h = await makeHarness({
      storeReport: async () => {
        throw new Error("canonical store down");
      },
    });
    await h.control.defineJob(buildScreenerJobDefinition(marketCommand()));
    const dispatch = await h.control.runJob("screen-manual-4190");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.delivered).toHaveLength(1);
  });

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
    expect(h.stored).toHaveLength(1);
  });

  it("the six node kinds address the six catalog stages (the #3945 1:1)", async () => {
    const h = await makeHarness();
    await h.control.defineJob(buildScreenerJobDefinition(marketCommand()));
    expect(vocabularyStageForNodeKind("feed")).toBe("feed");
    expect(vocabularyStageForNodeKind("enrich")).toBe("gather");
    expect(vocabularyStageForNodeKind("analyze")).toBe("analysis");
    expect(vocabularyStageForNodeKind("store")).toBe("store");
    expect(vocabularyStageForNodeKind("serve")).toBe("serve");
    expect(vocabularyStageForNodeKind("deliver")).toBe("deliver");
    const view = await h.control.getJob("screen-manual-4190");
    const kinds = (view?.definition.root
      ? (function walk(node: any, acc: string[]): string[] {
          acc.push(node.kind);
          for (const child of node.children ?? []) walk(child, acc);
          return acc;
        })(view.definition.root, [])
      : []);
    expect(kinds).toEqual(["feed", "enrich", "analyze", "store", "serve", "deliver"]);
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
