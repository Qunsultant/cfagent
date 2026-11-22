// @vitest-environment node
/**
 * Issue #6072 (#4437 slice 6d-a) — the goal-run composition as engine nodes.
 *
 * The goal run's composition (quota + plan + ledger claim/complete + leg dispatch +
 * assembly + artifact tail) moves out of `runGoalScreenOnEngine` (screener-agent.ts)
 * and onto the goal definition's analyze node as a multi-step sequence
 * (goal.quota → goal.plan → goal.ledgerClaim → goal.stockLeg → goal.optionsLeg →
 * goal.assemble → goal.ledgerComplete → goal.artifacts). The ledger is D1-resident
 * (a ScreenerTaskStore over the `agent_screener_task_entries` table), so a workflow
 * eviction replay finds and adopts the record instead of losing it.
 *
 * TDD red first: the composition steps, the D1 task store, and the spec change do
 * not exist yet.
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
  GOAL_COMPOSITION_STEPS,
  buildScreenerJobDefinition,
  createScreenerStepRegistry,
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
import type { ScreeningResult } from "../src/trading";

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

function goalCommand(over: Partial<WorkflowJobCommand> = {}): WorkflowJobCommand {
  return {
    jobId: "goal-6072",
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    userLogin: "owner",
    role: "parent",
    shards: [{ shardId: "s0", symbols: [listing("AAPL")] }],
    provider: "yahoo",
    deliver: true,
    goalScreen: {
      // A real scenario (buildScenario): the old tests' literal
      // ({goalKind: "growth", direction: "long"}) was never a valid
      // ScenarioDefinition — "growth" is not a GoalKind and "long"
      // is not an Outlook — and only survived because the injected
      // fake runner never called buildGoalScreenPlan. The composition
      // runs the real plan builder, so the fixture must be real:
      // directional growth, bullish outlook.
      scenario: buildScenario({
        goalKind: "directional",
        portfolioRef: { kind: "hypothetical" },
        constraints: {},
      }),
      scenarioSource: "built",
      symbols: ["AAPL"],
    },
    ...over,
  };
}

function stockLegResult(): ScreeningResult {
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
    } as never,
  };
}

function optionsLegResult(): ScreeningResult {
  return {
    assetClass: "options",
    providerId: "options-screen-workflow",
    result: {
      status: "matches_found",
      totalUnderlyingsScanned: 1,
      matchedCount: 1,
      contracts: [{ underlyingSymbol: "AAPL" }],
    } as never,
  };
}

interface CompositionHarness {
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
} = {}): Promise<CompositionHarness> {
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
    goalTaskLedgerFor: () => new ScreenerTaskLedger(taskStore, { newId: () => "goal-task-6072" }),
    goalQuotaCharge:
      opts.quotaCharge ??
      (async (input) => {
        quotaCharges.push({ userLogin: input.userLogin, runId: input.runId });
      }),
    goalStockLeg:
      opts.stockLeg ??
      (async (input) => {
        stockLegCalls.push(input);
        return stockLegResult();
      }),
    goalOptionsLeg:
      opts.optionsLeg ??
      (async (input) => {
        optionsLegCalls.push(input);
        return optionsLegResult();
      }),
  };
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps: createScreenerStepRegistry(deps),
    now: () => new Date(T0),
    // The engine mints run ids (run:<ts>-<n>); pin one so the quota
    // run id and the ledger idempotency key are assertable.
    newRunId: () => "run-goal-6072",
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

describe("goal definition builder (#6072)", () => {
  it("a goal command builds the composition steps on the analyze node", () => {
    const spec = jobDefinitionSpec("goalScreen");
    expect(spec.stages.map((s) => s.kind)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "store",
      "serve",
      "deliver",
    ]);
    expect(spec.stages.find((s) => s.kind === "analyze")?.steps).toEqual(
      GOAL_COMPOSITION_STEPS,
    );

    const raw = buildScreenerJobDefinition(goalCommand()) as any;
    expect(raw.name).toBe("Goal screen — goal-6072");
    const kinds: string[] = [];
    const stepsByKind = new Map<string, string[]>();
    let node = raw.root;
    while (node) {
      kinds.push(node.kind);
      stepsByKind.set(node.kind, (node.steps ?? []).map((s: any) => s.step));
      node = node.children?.[0];
    }
    expect(kinds).toEqual(["feed", "enrich", "analyze", "store", "serve", "deliver"]);
    expect(stepsByKind.get("analyze")).toEqual(GOAL_COMPOSITION_STEPS);
    expect(raw.root.executionMode?.shape).toBe("monolith");
  });
});

describe("goal composition nodes (#6072)", () => {
  it("a goal run executes the composition, never runGoalScreenOnEngine", async () => {
    const h = await makeHarness();
    const engineSpy = vi.spyOn(h.agent, "runGoalScreenOnEngine");
    const goalStageSpy = vi.spyOn(h.agent, "screenGoalStage");
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6072");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    // The composition ran: quota once, both legs once, ledger completed.
    expect(h.quotaCharges).toHaveLength(1);
    expect(h.quotaCharges[0]?.runId).toBe("goalScreen:run-goal-6072");
    expect(h.stockLegCalls).toHaveLength(1);
    expect(h.optionsLegCalls).toHaveLength(1);
    const tasks = await new ScreenerTaskLedger(h.taskStore).list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.evaluation?.verdict).toBe("pass");
    // The old function is nowhere on the path.
    expect(engineSpy).not.toHaveBeenCalled();
    expect(goalStageSpy).not.toHaveBeenCalled();
    // The market quote path never ran for a goal command.
    expect(h.yahooCalls).toEqual([]);
    // The goal store + deliver doors ran.
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });

  it("a quota refusal fails named before any ledger record exists", async () => {
    const h = await makeHarness({
      quotaCharge: async () => {
        throw new Error("quota exceeded for goalScreen");
      },
    });
    const command = goalCommand({ jobId: "goal-6072-quota" });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6072-quota");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("failed");
    expect(h.stockLegCalls).toHaveLength(0);
    expect(h.optionsLegCalls).toHaveLength(0);
    const tasks = await new ScreenerTaskLedger(h.taskStore).list(10);
    expect(tasks).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });

  it("a terminal duplicate returns executed:false and dispatches no legs", async () => {
    const h = await makeHarness();
    // Pre-seed a TERMINAL record for this run key (a duplicate delivery).
    const ledger = new ScreenerTaskLedger(h.taskStore, { newId: () => "goal-task-6072" });
    const created = await ledger.create({
      trigger: "manual",
      universe: "goal:directional",
      sector: "bullish",
      userLogin: "owner",
      idempotencyKey: "run-goal-6072",
    });
    await ledger.claim(created.task.id);
    await ledger.start(created.task.id);
    await ledger.complete(created.task.id, {
      runTimestamp: iso(T0),
      totalScanned: 1,
      matchedCount: 1,
      opportunitiesCount: 1,
      partial: false,
      evaluation: {
        verdict: "pass",
        evaluatedAt: iso(T0),
        checks: [],
      },
    });
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6072");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.quotaCharges).toHaveLength(1);
    expect(h.stockLegCalls).toHaveLength(0);
    expect(h.optionsLegCalls).toHaveLength(0);
    // Still exactly one record: the duplicate did not create a second.
    const tasks = await ledger.list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
  });

  it("a failed leg becomes a failed class, never a failed run", async () => {
    const h = await makeHarness({
      optionsLeg: async (input) => {
        h.optionsLegCalls.push(input);
        throw new Error("options leg fetch failed");
      },
    });
    const command = goalCommand({ jobId: "goal-6072-partial" });
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6072-partial");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.stockLegCalls).toHaveLength(1);
    const tasks = await new ScreenerTaskLedger(h.taskStore).list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.partial).toBe(true);
  });

  it("an active record left by an evicted run is adopted, not duplicated", async () => {
    const h = await makeHarness();
    // The eviction left a RUNNING record for this run id (claimed +
    // started, never completed): the replay's claim step adopts it
    // through the legal transitions instead of creating a second
    // record — the D1 ledger is the run's journal across the
    // eviction, so the resumed run yields a result.
    const ledger = new ScreenerTaskLedger(h.taskStore, { newId: () => "goal-task-6072" });
    const created = await ledger.create({
      trigger: "manual",
      universe: "goal:directional",
      sector: "bullish",
      userLogin: "owner",
      idempotencyKey: "run-goal-6072",
    });
    await ledger.claim(created.task.id);
    await ledger.start(created.task.id);
    const command = goalCommand();
    await h.control.defineJob(buildScreenerJobDefinition(command));
    const dispatch = await h.control.runJob("goal-6072");
    const outcome = await dispatch.completion!;
    expect(outcome.state).toBe("completed");
    expect(h.quotaCharges).toHaveLength(1);
    expect(h.stockLegCalls).toHaveLength(1);
    expect(h.optionsLegCalls).toHaveLength(1);
    // Still exactly one record: the replay adopted it, then
    // completed it — no duplicate, no lost ledger.
    const tasks = await ledger.list(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("goal-task-6072");
    expect(tasks[0]?.status).toBe("completed");
    expect(tasks[0]?.evaluation?.verdict).toBe("pass");
    expect(h.stored).toHaveLength(1);
    expect(h.delivered).toHaveLength(1);
  });
});
