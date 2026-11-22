/**
 * Issue #4858 — the goal-leg cutover: the goal options leg dispatches
 * through the goal workflow host, gated.
 *
 * runGoalOptionsLegViaWorkflow (goalDrivenScreen.ts) ran the leg over
 * the sync dispatch. #4290 built the durable path
 * (startGoalOptionsLegWorkflow + the goal-shape rebuild), and the
 * three gaps the issue named have landed: the residency resolves the
 * chain source per invocation from the run's broker stage input
 * (#3960), universe deps travel as a stage input (#4473, #4857), and
 * binding reachability from the leg's residency is proven in code
 * (the ScreenerAgent reads AGENT_DB from its own env, and a sibling
 * agent creates workflow instances from its env). This slice routes
 * the leg through the goal seam when the gate holds — the pair
 * derives from the tenant broker selection through the shared
 * derivation, the residency bindings are configured, the composing
 * goal run's id is known, and the leg carries explicit symbols or a
 * universe descriptor — and keeps the unchanged sync dispatch
 * otherwise, retained as the gated fallback until live proof proves
 * the cutover (sync retirement is a separate follow-up, sequenced
 * after live proof).
 *
 * The host path persists the leg's job through the seam (the D1 job
 * definition — the #4274 lesson: the goal leg never persisted its
 * job, so the host path's persisted definition is what makes the
 * run addressable after dispatch), and reads the screen artifact
 * back from the residency's stage storage, so the leg returns the
 * same ScreeningResult the sync path returns. Stage messages publish
 * through the residency's queue binding, the same queue the sync
 * dispatch publishes through.
 *
 * These tests prove the gate, the derivation from the tenant
 * selection, the host dispatch (start stamping, await, read-back,
 * failure shapes), the real flow through the dispatch (explicit
 * symbols and discovery mode), host-vs-sync result equality, the
 * queue publishing, and the composition (the leg branches on the
 * gate and keeps the sync call). No live runs; no real
 * workflow.create (the injected seam, the #4291/#4450/#4468 idiom).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import type { TenantBrokerSelectionRead } from "../src/services/providerConnections";
import {
  goalLegDispatchRoute,
  resolveGoalLegHostDispatch,
  runGoalLegViaHost,
  type GoalLegHostSeams,
} from "../src/services/goalLegHostDispatch";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import type { NasdaqUniverseDeps } from "../src/trading/screenerPipeline";
import {
  optionsStageStorageFromArtifacts,
  runOptionsScreenViaEngine,
} from "../src/workflows/optionsScreenEngine";
import {
  createOptionsScreenPorts,
  optionsArtifactKey,
  type OptionsStageStorage,
} from "../src/workflows/optionsScreenPorts";
import {
  decodeBrokerStageInput,
  decodeUniverseDepsStageInput,
  type BrokerStageInput,
  type UniverseDepsStageInput,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import type { StageQueueSend } from "../src/workflows/stageQueueTransport";
import { createGoalOptionsLegDelivery } from "../src/workflows/goalOptionsLeg";
import { runGoalDrivenScreen } from "../src/services/goalDrivenScreen";
import { buildScenario } from "../src/services/goalScenarioEngine";
import {
  ScreeningProviderRegistry,
  type ScreeningProvider,
  type ScreeningResult,
} from "../src/trading/screeningProvider";

const USER = "owner@example.com";
const GOAL_RUN_ID = "goal-screen:test-key-4858";
const UNIVERSE_INPUT: UniverseDepsStageInput = { provider: "nasdaq" };

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function makeChain(symbol: string): ETradeOptionChain {
  const expiry = expiryAtDte(30);
  return {
    symbol,
    underlyingPrice: 100,
    selectedExpiry: { year: expiry.year, month: expiry.month, day: expiry.day },
    pairs: [
      {
        call: {
          symbol,
          optionType: "CALL",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.05,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

/** The listings the fake universe deps return: two symbols, both chain-fixtured. */
const LISTINGS: NasdaqStockListing[] = [
  { symbol: "AAPL", companyName: "Apple Inc", exchange: "nasdaq", change: 0, changePercent: 0 },
  { symbol: "MSFT", companyName: "Microsoft Corp", exchange: "nasdaq", change: 0, changePercent: 0 },
];

function fakeUniverseDeps(
  listings: NasdaqStockListing[] = LISTINGS,
): NasdaqUniverseDeps & { calls: number } {
  const deps = {
    calls: 0,
    fetchListings: async () => {
      deps.calls += 1;
      return listings;
    },
  };
  return deps;
}

/** The goal envelope, as runGoalOptionsLegViaWorkflow assembles it. */
function goalEnvelope(
  runId: string,
  optionsFilter: Record<string, unknown>,
  structures: string[] = ["long_call"],
) {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    provenanceTrigger: "goal",
    classInput: {
      goalPlan: { optionsFilter, structures },
    },
  };
}

function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AGENT_DB: {},
    JOB_PIPELINE_WORKFLOW: {
      create: async () => ({ id: "never-created" }),
    },
    ...extra,
  } as unknown as Env;
}

function fakeStores() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const runRecorder = jobRunRecorderFromStore(runStore);
  return { stores, runRecorder };
}

function recordingJournal() {
  const names: string[] = [];
  return {
    names,
    step: {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        names.push(name);
        return fn();
      },
    },
  };
}

/** A recording queue binding: the SCREENER_EVENTS send seam (#4453). */
function recordingQueue() {
  const sent: unknown[] = [];
  const queue: StageQueueSend = {
    send: async (body: unknown) => {
      sent.push(body);
    },
  };
  return { sent, queue };
}

/**
 * The production residency shape for the goal leg: the resolving
 * steps rebuild ports per invocation with no chain source (the
 * static test-chains fixture intercepts the screener's fetches, the
 * #4290 idiom), the injected universe factory when the run carries
 * a universe input, and the recording queue.
 */
function flowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  extra: Partial<OptionsWorkflowStepDeps> = {},
): JobPipelineDeps {
  const stepDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    chainSourceFor: () => undefined,
    // The production residency always binds the universe factory
    // (optionsStepDepsForWorkflow); a stored request carrying a
    // universe input refuses without one, even for a leg whose
    // explicit symbols never call it.
    universeDepsFor: async () => fakeUniverseDeps(),
    ...extra,
  };
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), stepDeps),
    invocation: "workflow-shard",
  };
}

/**
 * A readRun seam that runs the flow lazily on its first call, then
 * reads the run back through the real read-back — the #4290 chained
 * pattern, routed through the dispatch under test.
 */
function lazyFlowReadRun(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  extra: Partial<OptionsWorkflowStepDeps> = {},
): (jobId: string) => Promise<OptionsWorkflowRunView> {
  let ran = false;
  return async (jobId: string) => {
    if (!ran) {
      ran = true;
      const deps = flowDeps(stores, runRecorder, extra);
      const journal = recordingJournal();
      await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: "manual" });
    }
    return readOptionsWorkflowRun({ stores, runRecorder }, jobId);
  };
}

function memoryStorage(): OptionsStageStorage & { keys(): string[] } {
  const map = new Map<string, unknown>();
  return {
    put: async (key, value) => {
      map.set(key, value);
    },
    get: async (key) => map.get(key) as never,
    keys: () => [...map.keys()],
  };
}

function stockResult(symbols: string[]): Record<string, unknown> {
  return {
    totalScanned: 500,
    matchedCount: symbols.length,
    stocks: symbols.map((symbol) => ({ symbol, lastPrice: 100 })),
    scannedAt: "2026-10-22T20:00:00.000Z",
  };
}

function fakeProvider(
  id: string,
  assetClass: "stocks" | "options",
  behavior: () => unknown,
): ScreeningProvider {
  return {
    id,
    assetClasses: [assetClass],
    async screen(): Promise<ScreeningResult> {
      const result = behavior();
      return { assetClass, providerId: id, result } as ScreeningResult;
    },
  };
}

function incomeScenario() {
  return buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    constraints: {
      dteWindow: { min: 21, max: 60 },
      liquidityFloor: { minOpenInterest: 500, minVolume: 100, maxSpreadPct: 8 },
    },
  });
}

const PAPER_PAIR: BrokerStageInput = { broker: "etrade", mode: "paper" };

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
});

describe("goal-leg dispatch gate (#4858)", () => {
  it("routes to the host when the pair derives, bindings are configured, the goal run id is known, and symbols are explicit", () => {
    const decision = goalLegDispatchRoute({
      broker: PAPER_PAIR,
      env: boundEnv(),
      goalRunId: GOAL_RUN_ID,
      hasSymbols: true,
    });
    expect(decision.route).toBe("host");
  });

  it("routes to the host for a discovery-mode leg carrying a universe descriptor", () => {
    const decision = goalLegDispatchRoute({
      broker: PAPER_PAIR,
      env: boundEnv(),
      goalRunId: GOAL_RUN_ID,
      hasSymbols: false,
      universe: UNIVERSE_INPUT,
    });
    expect(decision.route).toBe("host");
  });

  it("routes to sync when no broker pair derives", () => {
    const decision = goalLegDispatchRoute({
      broker: null,
      env: boundEnv(),
      goalRunId: GOAL_RUN_ID,
      hasSymbols: true,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/broker/);
  });

  it("routes to sync when the composing goal run id is unknown", () => {
    const decision = goalLegDispatchRoute({
      broker: PAPER_PAIR,
      env: boundEnv(),
      goalRunId: null,
      hasSymbols: true,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/goal run id/);
  });

  it("routes to sync when AGENT_DB is not bound", () => {
    const decision = goalLegDispatchRoute({
      broker: PAPER_PAIR,
      env: boundEnv({ AGENT_DB: undefined }),
      goalRunId: GOAL_RUN_ID,
      hasSymbols: true,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/bindings/);
  });

  it("routes to sync when the workflow binding cannot create", () => {
    for (const workflow of [undefined, {}, { create: "not-a-function" }]) {
      const decision = goalLegDispatchRoute({
        broker: PAPER_PAIR,
        env: boundEnv({ JOB_PIPELINE_WORKFLOW: workflow }),
        goalRunId: GOAL_RUN_ID,
        hasSymbols: true,
      });
      expect(decision.route).toBe("sync");
    }
  });

  it("routes to sync for a discovery-mode leg with neither symbols nor a universe descriptor", () => {
    const decision = goalLegDispatchRoute({
      broker: PAPER_PAIR,
      env: boundEnv(),
      goalRunId: GOAL_RUN_ID,
      hasSymbols: false,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/universe/);
  });
});

describe("goal-leg host derivation (#4858)", () => {
  const gate = { goalRunId: GOAL_RUN_ID, hasSymbols: true };

  it("derives the pair from an ok selection with the platform's environment resolution", async () => {
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { decision, broker } = await resolveGoalLegHostDispatch(
      env,
      undefined,
      gate,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );
    expect(broker).toEqual(PAPER_PAIR);
    expect(decision.route).toBe("host");
  });

  it("the requested env overrides the platform resolution", async () => {
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const live = await resolveGoalLegHostDispatch(env, "PROD", gate, async () => ({
      status: "ok",
      brokerId: "etrade",
    }));
    expect(live.broker).toEqual({ broker: "etrade", mode: "live" });
    const paper = await resolveGoalLegHostDispatch(env, "TEST", gate, async () => ({
      status: "ok",
      brokerId: "etrade",
    }));
    expect(paper.broker).toEqual(PAPER_PAIR);
  });

  it("an unconfigured selection derives the existing alpaca/paper default and routes to the host (#5104)", async () => {
    // Issue #5104 (DEFAULT part of B1): no stored selection is the
    // EXISTING vocabulary default (alpaca/paper), not a sync
    // fallback. Only a genuine store failure yields no pair.
    const { decision, broker } = await resolveGoalLegHostDispatch(
      boundEnv(),
      undefined,
      gate,
      async () => ({ status: "unconfigured", error: "no selection" }),
    );
    expect(broker).toEqual({ broker: "alpaca", mode: "paper" });
    expect(decision.route).toBe("host");
  });

  it("a failed selection read yields no pair and the sync decision", async () => {
    const { decision, broker } = await resolveGoalLegHostDispatch(
      boundEnv(),
      undefined,
      gate,
      async () => ({ status: "store_unavailable", error: "store down" }),
    );
    expect(broker).toBeNull();
    expect(decision.route).toBe("sync");
  });

  it("a selection the derivation does not know yields no pair and the sync decision", async () => {
    const { decision, broker } = await resolveGoalLegHostDispatch(
      boundEnv(),
      undefined,
      gate,
      async () => ({ status: "ok", brokerId: "unknown-broker" }) as TenantBrokerSelectionRead,
    );
    expect(broker).toBeNull();
    expect(decision.route).toBe("sync");
  });
});

describe("goal-leg host dispatch (#4858)", () => {
  const RUN_ID = "goal-screen:dispatch-1:options";

  function completedView(overrides: Partial<OptionsWorkflowRunView> = {}): OptionsWorkflowRunView {
    return {
      jobId: `options-screen:${RUN_ID}`,
      runId: RUN_ID,
      state: "completed",
      engineRunId: "engine-run-1",
      stages: [],
      ...overrides,
    };
  }

  it("defines the job with the broker, universe, and goal run id stamped, creates the instance, and returns the screen result", async () => {
    const { stores, runRecorder } = fakeStores();
    const screenResult = {
      status: "complete",
      totalUnderlyingsScanned: 1,
      matchedCount: 2,
      contracts: [{ underlyingSymbol: "AAPL" }],
    };
    await optionsStageStorageFromArtifacts(stores.artifacts, "engine-run-1").put(
      optionsArtifactKey(RUN_ID, "screen"),
      { result: screenResult },
    );
    const created: Array<{ jobId: string; trigger: string }> = [];
    const seams: GoalLegHostSeams = {
      stores,
      runRecorder,
      startWorkflow: async (jobId, params) => {
        created.push({ jobId, trigger: params.trigger });
        return { instanceId: "wf-goal-1" };
      },
      awaitOptions: { readRun: async () => completedView() },
    };
    const result = await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      universe: UNIVERSE_INPUT,
      seams,
    });
    expect(result).toEqual(screenResult);
    expect(created).toEqual([{ jobId: `options-screen:${RUN_ID}`, trigger: "manual" }]);
    const definition = await stores.definitions.getDefinition(`options-screen:${RUN_ID}`);
    expect(definition).not.toBeNull();
    const rawConfig = definition?.rawConfig as { request?: unknown } | null;
    expect(decodeBrokerStageInput(rawConfig?.request, RUN_ID)).toEqual(PAPER_PAIR);
    expect(decodeUniverseDepsStageInput(rawConfig?.request, RUN_ID)).toEqual(UNIVERSE_INPUT);
    const stored = rawConfig?.request as {
      classInput?: { goalPlan?: { goalRunId?: unknown } };
    };
    expect(stored?.classInput?.goalPlan?.goalRunId).toBe(GOAL_RUN_ID);
  });

  it("a failed run throws the sync failure shape", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      runGoalLegViaHost({
        env: boundEnv(),
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        runId: RUN_ID,
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        trigger: "manual",
        broker: PAPER_PAIR,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-1" }),
          awaitOptions: {
            readRun: async () =>
              completedView({
                state: "failed",
                stages: [{ stageId: "screen", status: "failed", error: "chain fetch failed" }],
              }),
          },
        },
      }),
    ).rejects.toThrow("options leg failed at screen: chain fetch failed");
  });

  it("a run that ends without completing throws the ended-without-result error", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      runGoalLegViaHost({
        env: boundEnv(),
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        runId: RUN_ID,
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        trigger: "manual",
        broker: PAPER_PAIR,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-1" }),
          awaitOptions: { readRun: async () => completedView({ state: "cancelled" }) },
        },
      }),
    ).rejects.toThrow(`options leg run ${RUN_ID} ended cancelled without a result`);
  });

  it("a completed run without an engine run id throws the sync missing-artifact message", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      runGoalLegViaHost({
        env: boundEnv(),
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        runId: RUN_ID,
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        trigger: "manual",
        broker: PAPER_PAIR,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-1" }),
          awaitOptions: { readRun: async () => completedView({ engineRunId: null }) },
        },
      }),
    ).rejects.toThrow(`options leg completed but its screen artifact is missing for run ${RUN_ID}`);
  });

  it("a completed run without a screen artifact throws the sync missing-artifact message", async () => {
    const { stores, runRecorder } = fakeStores();
    await expect(
      runGoalLegViaHost({
        env: boundEnv(),
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        runId: RUN_ID,
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        trigger: "manual",
        broker: PAPER_PAIR,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-1" }),
          awaitOptions: { readRun: async () => completedView() },
        },
      }),
    ).rejects.toThrow(`options leg completed but its screen artifact is missing for run ${RUN_ID}`);
  });

  it("awaits with the 300s bound", async () => {
    const { stores, runRecorder } = fakeStores();
    let now = 0;
    await expect(
      runGoalLegViaHost({
        env: boundEnv(),
        request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
        runId: RUN_ID,
        goalRunId: GOAL_RUN_ID,
        userLogin: USER,
        trigger: "manual",
        broker: PAPER_PAIR,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-1" }),
          awaitOptions: {
            readRun: async () => completedView({ state: "running" }),
            sleep: async () => undefined,
            now: () => (now += 200_000),
          },
        },
      }),
    ).rejects.toThrow(/300000ms/);
  });

  it("start → flow → read-back: an explicit-symbols goal leg through the real flow, with the job persisted", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const { stores, runRecorder } = fakeStores();
    const { sent, queue } = recordingQueue();
    const result = (await runGoalLegViaHost({
      env: boundEnv(),
      request: goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] }),
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-goal-flow-1" }),
        awaitOptions: { readRun: lazyFlowReadRun(stores, runRecorder, { queue }) },
      },
    })) as {
      totalUnderlyingsScanned?: number;
      matchedCount?: number;
      contracts?: Array<{ underlyingSymbol: string }>;
    };
    expect(result.totalUnderlyingsScanned).toBe(1);
    expect(result.matchedCount).toBe(2);
    expect(result.contracts?.map((c) => c.underlyingSymbol)).toEqual(["AAPL", "AAPL"]);
    // The #4274 verification: the job definition persisted in the
    // residency's stores, addressable after dispatch.
    const definition = await stores.definitions.getDefinition(`options-screen:${RUN_ID}`);
    expect(definition).not.toBeNull();
    // Stage-boundary messages published through the residency queue.
    expect(sent.length).toBeGreaterThan(0);
  });

  it("the host result equals the sync result for the same goal request", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const request = goalEnvelope(RUN_ID, { underlyingSymbols: ["AAPL"] });
    // Sync: the engine over the caller's storage, the leg's ports.
    const syncStorage = memoryStorage();
    const syncOutcome = await runOptionsScreenViaEngine(
      { runId: RUN_ID, userLogin: USER, trigger: "manual", request },
      {
        stages: createOptionsScreenPorts({
          screener: new DynamicOptionsScreener(),
          storage: syncStorage,
          ...createGoalOptionsLegDelivery({ goalRunId: GOAL_RUN_ID }),
        }),
        claims: { has: () => false, add: () => undefined, delete: () => undefined },
        queue: null,
      },
    );
    expect(syncOutcome.outcome).toBe("completed");
    const syncScreened = await syncStorage.get<{ result: unknown }>(
      optionsArtifactKey(RUN_ID, "screen"),
    );
    // Host: the same envelope through the dispatch + the real flow.
    const { stores, runRecorder } = fakeStores();
    const hostResult = await runGoalLegViaHost({
      env: boundEnv(),
      request,
      runId: RUN_ID,
      goalRunId: GOAL_RUN_ID,
      userLogin: USER,
      trigger: "manual",
      broker: PAPER_PAIR,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async () => ({ instanceId: "wf-goal-eq-1" }),
        awaitOptions: { readRun: lazyFlowReadRun(stores, runRecorder) },
      },
    });
    // The residency's stores JSON-round-trip artifacts, so
    // `undefined`-valued keys do not survive the host path while
    // the sync path's in-memory storage keeps them. The values are
    // identical either way (a read yields `undefined`); compare
    // the JSON-visible values. `scannedAt` stamps each run's own
    // wall clock, so it is compared for shape, not equality.
    const hostVisible = JSON.parse(JSON.stringify(hostResult)) as Record<string, unknown>;
    const syncVisible = JSON.parse(JSON.stringify(syncScreened?.result)) as Record<string, unknown>;
    const { scannedAt: hostScannedAt, ...hostRest } = hostVisible;
    const { scannedAt: syncScannedAt, ...syncRest } = syncVisible;
    expect(hostRest).toEqual(syncRest);
    expect(Date.parse(String(hostScannedAt))).not.toBeNaN();
    expect(Date.parse(String(syncScannedAt))).not.toBeNaN();
  });
});

describe("goal-leg cutover composition (#4858)", () => {
  const IDEMPOTENCY_KEY = "test-key-4858";
  const NOW = new Date("2026-11-04T23:30:00.000Z");

  function registryWithThrowingOptions() {
    const registry = new ScreeningProviderRegistry();
    registry.register(fakeProvider("fake-stocks", "stocks", () => stockResult(["MSFT"])));
    registry.register(
      fakeProvider("fake-options", "options", () => {
        throw new Error("registry options screen must not be called on the pipeline path");
      }),
    );
    return registry;
  }

  it("with the host input, the leg serves through the host and the goal result equals the sync result", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const syncStorage = memoryStorage();
    const viaSync = await runGoalDrivenScreen({
      registry: registryWithThrowingOptions(),
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: USER,
      trigger: "manual",
      idempotencyKey: IDEMPOTENCY_KEY,
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage: syncStorage,
        ...createGoalOptionsLegDelivery({ goalRunId: GOAL_RUN_ID }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
    });
    expect(viaSync.status).toBe("complete");
    expect(syncStorage.keys()).toHaveLength(8);

    const { stores, runRecorder } = fakeStores();
    const hostStorage = memoryStorage();
    const viaHost = await runGoalDrivenScreen({
      registry: registryWithThrowingOptions(),
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: USER,
      trigger: "manual",
      idempotencyKey: IDEMPOTENCY_KEY,
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage: hostStorage,
        ...createGoalOptionsLegDelivery({ goalRunId: GOAL_RUN_ID }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
      goalLegHost: {
        env: boundEnv({ ETRADE_ENVIRONMENT: "sandbox" }),
        universe: UNIVERSE_INPUT,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-comp-1" }),
          awaitOptions: { readRun: lazyFlowReadRun(stores, runRecorder) },
          readSelection: async () => ({ status: "ok", brokerId: "etrade" }),
        },
      },
    });
    expect(viaHost).toEqual(viaSync);
    // The host run records over the residency's stores, not the
    // caller's storage: the caller's storage holds no artifacts.
    expect(hostStorage.keys()).toHaveLength(0);
    // The job persisted through the seam, stamped with the pair.
    const definition = await stores.definitions.getDefinition(
      `options-screen:goal-screen:${IDEMPOTENCY_KEY}:options`,
    );
    expect(definition).not.toBeNull();
    const rawConfig = definition?.rawConfig as { request?: unknown } | null;
    expect(
      decodeBrokerStageInput(rawConfig?.request, `goal-screen:${IDEMPOTENCY_KEY}:options`),
    ).toEqual(PAPER_PAIR);
  });

  it("a discovery-mode goal screen serves through the host when the universe descriptor travels", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      AAPL: makeChain("AAPL"),
      MSFT: makeChain("MSFT"),
    });
    const { stores, runRecorder } = fakeStores();
    const universeDeps = fakeUniverseDeps();
    const viaHost = await runGoalDrivenScreen({
      registry: registryWithThrowingOptions(),
      scenario: incomeScenario(),
      // Symbol-less, but carrying the visible maximum-underlyings
      // limit: the screen refuses a symbol-less filter with no cap
      // before discovery ever runs (the pre-existing guard), so a
      // discovery fixture without the cap fails for the wrong reason.
      baseOptionsFilter: { maxUnderlyings: 10 },
      now: NOW,
      userLogin: USER,
      trigger: "manual",
      idempotencyKey: IDEMPOTENCY_KEY,
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage: memoryStorage(),
        ...createGoalOptionsLegDelivery({ goalRunId: GOAL_RUN_ID }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
      goalLegHost: {
        env: boundEnv({ ETRADE_ENVIRONMENT: "sandbox" }),
        universe: UNIVERSE_INPUT,
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-goal-disc-1" }),
          awaitOptions: {
            readRun: lazyFlowReadRun(stores, runRecorder, {
              universeDepsFor: async () => universeDeps,
            }),
          },
          readSelection: async () => ({ status: "ok", brokerId: "etrade" }),
        },
      },
    });
    expect(viaHost.status).toBe("complete");
    expect(universeDeps.calls).toBeGreaterThan(0);
    expect(viaHost.counts.optionsUnderlyingsScanned).toBe(2);
    expect(viaHost.counts.optionsContractsMatched).toBe(4);
  });

  it("a gated-out run stays on the sync dispatch, unchanged", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const storage = memoryStorage();
    let created = 0;
    const viaSync = await runGoalDrivenScreen({
      registry: registryWithThrowingOptions(),
      scenario: incomeScenario(),
      symbols: ["AAPL"],
      now: NOW,
      userLogin: USER,
      trigger: "manual",
      idempotencyKey: IDEMPOTENCY_KEY,
      optionsWorkflow: {
        screener: new DynamicOptionsScreener(),
        storage,
        ...createGoalOptionsLegDelivery({ goalRunId: GOAL_RUN_ID }),
        claims: { has: () => false, add: () => undefined },
        queue: null,
      },
      goalLegHost: {
        // Unconfigured bindings: the gate resolves sync.
        env: {} as Env,
        seams: {
          startWorkflow: async () => {
            created += 1;
            return { instanceId: "never" };
          },
          readSelection: async () => ({ status: "ok", brokerId: "etrade" }),
        },
      },
    });
    expect(viaSync.status).toBe("complete");
    expect(created).toBe(0);
    expect(storage.keys()).toHaveLength(8);
  });
});
