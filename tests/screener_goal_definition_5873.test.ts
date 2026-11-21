// @vitest-environment node
/**
 * Issue #5873 ([One engine] #4437 slice 3b) — the goal branch out
 * of the screener analyze node: the goal leg gets its own job
 * definition. A goal command builds the "goalScreen" spec (six
 * nodes, same kinds; the analyze node is the goal dispatch step
 * `screener.goal`, never the market analyze step
 * `screener.analysis`), and dispatches through it; a market
 * command builds the unchanged "screener" spec. The market
 * analyze stage is market-only — it never sees a goal run.
 */
import { describe, expect, it, vi } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { jobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import {
  SCREENER_ANALYSIS_STEP,
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import type {
  MarketDataResearchHistoricalBar,
  MarketDataResearchQuote,
} from "../src/types";

// The run clock: today at midnight UTC (never a fixed calendar date).
const T0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString();

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
    jobId: "screen-manual-5873",
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

function goalCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return marketCommand({
    jobId: "goal-5873",
    shards: [{ shardId: "goal", symbols: [listing("AAPL")] }],
    goalScreen: {
      scenario: { goalKind: "growth", direction: "long" } as any,
      scenarioSource: "built",
      symbols: ["AAPL"],
    },
    ...over,
  });
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
    storeReport: async (payload) => {
      stored.push(payload);
    },
    deliverOutcome: async (payload, userLogin) => {
      delivered.push({ payload, userLogin });
    },
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

function goalRunnerResult(req: any) {
  return {
    task: { id: "goal-task-5873" },
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
}

describe("goal definition builder (#5873)", () => {
  it("a goal command builds the goal spec: same six kinds, analyze node is screener.goal", () => {
    const spec = jobDefinitionSpec("goalScreen");
    expect(spec.stages.map((s) => s.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "store",
      "serve",
      "deliver",
    ]);
    expect(spec.stages.find((s) => s.kind === "analyze")?.step).toBe("screener.goal");

    const raw = buildScreenerJobDefinition(goalCommand()) as any;
    expect(raw.name).toBe("Goal screen — goal-5873");
    const kinds: string[] = [];
    const stepsByKind = new Map<string, string>();
    let node = raw.root;
    while (node) {
      kinds.push(node.kind);
      stepsByKind.set(node.kind, node.steps?.[0]?.step);
      expect(node.steps?.[0]?.params).toEqual(
        expect.objectContaining({ goalScreen: expect.anything() }),
      );
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "store", "serve", "deliver"]);
    expect(stepsByKind.get("analyze")).toBe("screener.goal");
    expect(raw.root.executionMode?.shape).toBe("monolith");
  });

  it("a market command builds the market spec unchanged: analyze node is screener.analysis", () => {
    const raw = buildScreenerJobDefinition(marketCommand()) as any;
    expect(raw.name).toBe("Screener — screen-manual-5873");
    const stepsByKind = new Map<string, string>();
    let node = raw.root;
    while (node) {
      stepsByKind.set(node.kind, node.steps?.[0]?.step);
      node = node.children?.[0];
    }
    expect(stepsByKind.get("analyze")).toBe(SCREENER_ANALYSIS_STEP);
  });
});

describe("goal dispatch on its own definition (#5873)", () => {
  it("a goal run executes the goal step, never the market analyze step", async () => {
    const goalCalls: unknown[] = [];
    const h = await makeHarness({
      goalRunner: async (req: any) => {
        goalCalls.push(req);
        return goalRunnerResult(req);
      },
    });
    // The goal step exists on the agent port (the dispatch target).
    expect((h.agent as any).screenGoalStage).toBeTypeOf("function");
    const analysisSpy = vi.spyOn(h.agent, "screenAnalysisStage");
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-5873");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    // The goal runner ran once, with the feed-derived symbols.
    expect(goalCalls).toHaveLength(1);
    expect((goalCalls[0] as any)?.symbols).toEqual(["AAPL"]);
    // The market analyze step never ran for a goal command.
    expect(analysisSpy).not.toHaveBeenCalled();
    // The market quote path never ran for a goal command.
    expect(h.yahooCalls).toEqual([]);
    // The goal store + deliver doors ran.
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });

  it("a market run still dispatches through the market analyze step (parity)", async () => {
    const h = await makeHarness();
    const analysisSpy = vi.spyOn(h.agent, "screenAnalysisStage");
    const command = marketCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("screen-manual-5873");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(analysisSpy).toHaveBeenCalled();
    expect(h.yahooCalls.length).toBeGreaterThan(0);
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });
});
