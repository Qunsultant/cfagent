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
import { ANALYZE_SCREENER_STEP } from "../src/services/analyzePipelineJobs";
import {
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
  GOAL_COMPOSITION_STEPS,
  type ScreenerStepDeps,
} from "../src/services/screenerPipelineJobs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { ScreenerTaskLedger } from "../src/services/screenerTaskLedger";
import { InMemoryScreenerTaskStore } from "../src/data/inMemoryScreenerTaskStoreAdapter";
import { buildScenario } from "../src/services/goalScenarioEngine";
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
      // A real scenario (buildScenario) — see
      // tests/goal_composition_nodes_6072.test.ts: the old literal
      // was never a valid ScenarioDefinition, and the composition
      // runs the real plan builder.
      scenario: buildScenario({
        goalKind: "directional",
        portfolioRef: { kind: "hypothetical" },
        constraints: {},
      }),
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
  taskStore: InMemoryScreenerTaskStore;
  stored: unknown[];
  delivered: { payload: unknown; userLogin: string }[];
  yahooCalls: string[];
  barsCalls: string[];
  quotaCharges: { userLogin: string; runId: string }[];
  stockLegCalls: unknown[];
  optionsLegCalls: unknown[];
}

async function makeHarness(opts: {
  quotaCharge?: ScreenerStepDeps["goalQuotaCharge"];
  stockLeg?: ScreenerStepDeps["goalStockLeg"];
  optionsLeg?: ScreenerStepDeps["goalOptionsLeg"];
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
  const taskStore = new InMemoryScreenerTaskStore();
  const stored: unknown[] = [];
  const delivered: { payload: unknown; userLogin: string }[] = [];
  const yahooCalls: string[] = [];
  const barsCalls: string[] = [];
  const quotaCharges: { userLogin: string; runId: string }[] = [];
  const stockLegCalls: unknown[] = [];
  const optionsLegCalls: unknown[] = [];
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
    // Issue #6072 — the goal run executes the composition, so the
    // harness injects the composition deps (the injected goalRunner
    // the old test used is never called: the analyze node has no
    // screener.goal step anymore).
    goalTaskLedgerFor: () => new ScreenerTaskLedger(taskStore, { newId: () => "goal-task-5873" }),
    goalQuotaCharge:
      opts.quotaCharge ??
      (async (input) => {
        quotaCharges.push({ userLogin: input.userLogin, runId: input.runId });
      }),
    goalStockLeg:
      opts.stockLeg ??
      (async (input) => {
        stockLegCalls.push(input);
        return {
          assetClass: "stocks",
          providerId: "stock-screen-workflow",
          result: {
            status: "matches_found",
            totalScanned: 1,
            totalScreened: 1,
            matchedCount: 1,
            filterApplied: {},
            filterSummary: "",
            stocks: [{ symbol: "AAPL" }],
            scannedAt: iso(T0),
          },
        } as never;
      }),
    goalOptionsLeg:
      opts.optionsLeg ??
      (async (input) => {
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
      }),
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createScreenerStepRegistry(deps),
    now: () => new Date(T0),
    newRunId: () => "run-goal-5873",
  });
  return {
    control,
    stores,
    runStore,
    storage,
    agent,
    taskStore,
    stored,
    delivered,
    yahooCalls,
    barsCalls,
    quotaCharges,
    stockLegCalls,
    optionsLegCalls,
  };
}

describe("goal definition builder (#5873)", () => {
  it("a goal command builds the goal spec: same six kinds, analyze node is the goal composition", () => {
    const spec = jobDefinitionSpec("goalScreen");
    expect(spec.stages.map((s) => s.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "store",
      "serve",
      "deliver",
    ]);
    // Issue #6072 — the analyze stage runs the composition; its
    // legacy single `step` stays screener.goal for old stored
    // definitions.
    expect(spec.stages.find((s) => s.kind === "analyze")?.step).toBe("screener.goal");
    expect(spec.stages.find((s) => s.kind === "analyze")?.steps).toEqual(
      GOAL_COMPOSITION_STEPS,
    );

    const raw = buildScreenerJobDefinition(goalCommand()) as any;
    expect(raw.name).toBe("Goal screen — goal-5873");
    const kinds: string[] = [];
    const stepsByKind = new Map<string, string[]>();
    let node = raw.root;
    while (node) {
      kinds.push(node.kind);
      stepsByKind.set(
        node.kind,
        (node.steps ?? []).map((s: any) => s.step),
      );
      expect(node.steps?.[0]?.params).toEqual(
        expect.objectContaining({ goalScreen: expect.anything() }),
      );
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "store", "serve", "deliver"]);
    expect(stepsByKind.get("analyze")).toEqual(GOAL_COMPOSITION_STEPS);
    expect(raw.root.executionMode?.shape).toBe("monolith");

    // Issue #6073 — the goal definition carries the family job
    // ids + the leg kit on the analyze node (the stock leg runs
    // the generic chain); symbols mode needs no universe.
    const paramsByKind = new Map<string, Record<string, unknown>>();
    let n = raw.root;
    while (n) {
      paramsByKind.set(n.kind, n.steps?.[0]?.params ?? {});
      n = n.children?.[0];
    }
    expect(paramsByKind.get("feed")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("feed")!.universe).toBeUndefined();
    expect(paramsByKind.get("analyze")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("analyze")!.enrichJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich",
    );
    expect(paramsByKind.get("analyze")!.analyzeJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
    expect(paramsByKind.get("analyze")!.generateJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze-generate",
    );
    expect(paramsByKind.get("analyze")!.stockLegAnalyzeParams).toEqual({
      ruleSets: ["screen", "factors"],
      inputMode: "handOff",
    });
    expect(paramsByKind.get("analyze")!.stockLegGenerateParams).toEqual({
      reports: ["screener-report"],
    });
    expect(paramsByKind.get("analyze")!.stockLegUniverse).toBeUndefined();
  });

  it("a symbol-less goal command carries the shared default universe on the feed node (#6073)", () => {
    const base = goalCommand();
    const raw = buildScreenerJobDefinition(
      goalCommand({
        shards: [{ shardId: "goal" }],
        goalScreen: { ...(base.goalScreen as object), symbols: undefined } as never,
      }),
    ) as any;
    const paramsByKind = new Map<string, Record<string, unknown>>();
    let n = raw.root;
    while (n) {
      paramsByKind.set(n.kind, n.steps?.[0]?.params ?? {});
      n = n.children?.[0];
    }
    expect(paramsByKind.get("feed")!.universe).toBe("nasdaq100");
    expect(paramsByKind.get("feed")!.feedJobId).toBe("yahoo-nasdaq100-quotes");
    expect(paramsByKind.get("analyze")!.stockLegUniverse).toBe("nasdaq100");
    expect(paramsByKind.get("analyze")!.analyzeJobId).toBe(
      "yahoo-nasdaq100-quotes-enrich-analyze",
    );
  });

  it("a market command builds the flipped market spec: five generic nodes, analyze node is analyze.screener", () => {
    const raw = buildScreenerJobDefinition(marketCommand()) as any;
    expect(raw.name).toBe("Screener — screen-manual-5873");
    const kinds: string[] = [];
    const stepsByKind = new Map<string, string>();
    let node = raw.root;
    while (node) {
      kinds.push(node.kind);
      stepsByKind.set(node.kind, node.steps?.[0]?.step);
      node = node.children?.[0];
    }
    // The 6b3 flip #5884: the market spec is v2, five generic
    // nodes — the goal branch (3b) pinned the market spec
    // unchanged, and the flip is the change that un-pins it.
    expect(kinds).toEqual(["feed", "enrich", "analyze", "generate", "deliver"]);
    expect(stepsByKind.get("analyze")).toBe(ANALYZE_SCREENER_STEP);
  });
});

describe("goal dispatch on its own definition (#5873)", () => {
  it("a goal run executes the goal composition, never the market analyze step", async () => {
    const h = await makeHarness();
    // The goal step exists on the agent port (the dispatch target for
    // old stored definitions) but the composition never calls it.
    expect((h.agent as any).screenGoalStage).toBeTypeOf("function");
    const goalStageSpy = vi.spyOn(h.agent, "screenGoalStage");
    const analysisSpy = vi.spyOn(h.agent, "screenAnalysisStage");
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-5873");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    // The composition ran: quota once, both legs once, ledger completed.
    expect(h.quotaCharges).toHaveLength(1);
    expect(h.stockLegCalls).toHaveLength(1);
    expect(h.optionsLegCalls).toHaveLength(1);
    const tasks = await new ScreenerTaskLedger(h.taskStore).list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
    // The old goal dispatch never ran for a goal command.
    expect(goalStageSpy).not.toHaveBeenCalled();
    // The market analyze step never ran for a goal command.
    expect(analysisSpy).not.toHaveBeenCalled();
    // The market quote path never ran for a goal command.
    expect(h.yahooCalls).toEqual([]);
    // The goal store + deliver doors ran.
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });

  // Issue #5884 (6b3): "a market run still dispatches
  // through the market analyze step (parity)" is REMOVED —
  // the market run no longer dispatches through the bespoke
  // screenAnalysisStage at all. The market-dispatch parity
  // now lives in the flip's engine proof,
  // tests/screener_substrate_4190.test.ts (full generic chain,
  // monolith + sharded, artifacts + run record), and the
  // goal-side parity stays here: the goal run executes the
  // goal step, never the market analyze step.
});
