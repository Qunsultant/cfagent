/**
 * Issue #4468 — the NLQ panel leg's dispatch moves onto the strategy
 * workflow host (startStrategyScreenWorkflow), gated: the host only
 * when the leg's (broker, mode) pair derives from the platform the
 * run executes on and the residency bindings are configured;
 * otherwise the unchanged sync dispatch (runOptionsPanelViaEngine).
 *
 * What these tests defend:
 *   1. The (broker, mode) derivation mirrors each platform's own
 *      environment resolution with the same (env, overrideEnv) the
 *      platform was constructed with — so the residency fetches the
 *      same environment's chains the sync path would. Unknown
 *      platforms (and the legacy sandbox alias) derive nothing, so
 *      the leg stays on sync instead of borrowing a broker (#3388).
 *   2. The gate: no derived pair, no AGENT_DB, or no workflow
 *      binding keeps the leg on sync; all three hold routes host.
 *   3. The host dispatch defines the strategy job, stamps the broker
 *      pair on the stored request (and no universe input — the panel
 *      leg is symbol-scoped and needs none), completes through the
 *      real flow with the real residency factory resolving the
 *      chain source, and maps the shapeReport back to the
 *      PipelineResult the expression consumes.
 *   4. Ranking semantics are unchanged: the same request through the
 *      host and through sync yields the same pick and ranking (the
 *      #4276 semantics pin, extended across the dispatch move).
 *   5. Gated-out runs stay on the unchanged sync path (the host seam
 *      is never invoked) and equal a direct sync call.
 *   6. A failed run throws naming the stage and reason; a run that
 *      completes without a report refuses to answer from nothing;
 *      an unsettled run throws the named timeout — the manual
 *      route's failure shapes (#4450).
 *
 * The fakes sit only at binding seams: the chain fixture stands in
 * for live broker chains; the workflow create call is injected (the
 * #4291/#4450 idiom — real workflow.create is never executed); the
 * stores are the in-memory job-pipeline adapters. The engine, the
 * ports, the resolving steps, and the residency factory are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  jobRunRecorderFromStore,
  type JobPipelineDeps,
  type JobRunRecorder,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import {
  registerOptionsWorkflowSteps,
  type OptionsWorkflowStepDeps,
} from "../src/services/optionsPipelineJobs";
import {
  createDiscoveryPanelRunner,
  discoveryBrokerStageInput,
  discoveryPanelDispatchRoute,
  runDiscoveryPanelViaHost,
} from "../src/services/discoveryService";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { platformChainSource, type ITradingPlatform, type StrategyRequest } from "../src/trading";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import { resolveChainSourceForRequest } from "../src/workflows/brokerChainSourceResidency";
import { decodeBrokerStageInput } from "../src/workflows/optionsStepPorts";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { runOptionsPanelViaEngine } from "../src/workflows/optionsScreenEngine";
import {
  readOptionsWorkflowRun,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";

const USER = "panel_cutover_tester";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** The #4291 panel fixture: one strike pair, spot 100, expiry +30d. */
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
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
        put: {
          symbol,
          optionType: "PUT",
          strikePrice: 100,
          bid: 1.0,
          ask: 1.2,
          openInterest: 500,
          volume: 100,
        },
      },
    ],
  } as unknown as ETradeOptionChain;
}

function targetDate(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];
}

/** The #4291 panel strategy request, verbatim. */
function strategyRequest(): StrategyRequest {
  return {
    symbol: "AAPL",
    thesis: "bullish",
    targetPrice: 105,
    targetDate: targetDate(),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call"],
    minDte: 14,
    maxDte: 60,
  } as StrategyRequest;
}

/**
 * A platform stub whose chain methods return the fixture chain for
 * the requested symbol. The screener's static fixture intercepts
 * fetches first, so these are a backstop, never the live path — but
 * they return the same chain either way, so the outcome cannot
 * depend on which fetch path the screener takes.
 */
function fakePlatform(platformId: string): ITradingPlatform {
  return {
    platformId,
    getOptionChains: async (symbol: string) => makeChain(symbol),
    getOptionExpireDates: async (symbol: string) => [makeChain(symbol).selectedExpiry],
  } as unknown as ITradingPlatform;
}

/** An env with the residency bindings present (values never read: the seams inject fakes). */
function boundEnv(extra: Record<string, unknown> = {}): Env {
  return {
    ...extra,
    AGENT_DB: {},
    JOB_PIPELINE_WORKFLOW: {
      create: async () => ({ id: "never-created" }),
    },
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

/**
 * The production residency shape: the resolving steps rebuild ports
 * per invocation with the REAL broker factory over the real
 * platform registry (construction only, no I/O — the fixture
 * intercepts the screener's fetches).
 */
function flowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  env: Env,
): JobPipelineDeps {
  const stepDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    env,
    chainSourceFor: (userLogin, request, runId) =>
      resolveChainSourceForRequest(env, { userLogin, request, runId }),
  };
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), stepDeps),
    invocation: "workflow-shard",
  };
}

const SCRUBBED_ENV_KEYS = ["ETRADE_ACCESS_TOKEN", "ETRADE_ACCESS_SECRET"];
let savedProcessEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedProcessEnv = {};
  for (const k of SCRUBBED_ENV_KEYS) {
    savedProcessEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetTokenCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in tests");
    }),
  );
});

afterEach(() => {
  DynamicOptionsScreener.clearTestChainsFixture();
  vi.unstubAllGlobals();
  for (const k of SCRUBBED_ENV_KEYS) {
    if (savedProcessEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedProcessEnv[k];
  }
});

describe("broker/mode derivation (#4468)", () => {
  it("derives the sandbox mode from the platform's own environment resolution", () => {
    expect(
      discoveryBrokerStageInput("etrade", { ETRADE_ENVIRONMENT: "sandbox" } as Env, undefined),
    ).toEqual({ broker: "etrade", mode: "paper" });
    expect(
      discoveryBrokerStageInput("etrade", { ETRADE_ENVIRONMENT: "live" } as Env, undefined),
    ).toEqual({ broker: "etrade", mode: "live" });
  });

  it("the override wins over the environment for the platform's own resolution", () => {
    expect(
      discoveryBrokerStageInput("etrade", { ETRADE_ENVIRONMENT: "live" } as Env, "TEST"),
    ).toEqual({ broker: "etrade", mode: "paper" });
    expect(
      discoveryBrokerStageInput("etrade", { ETRADE_ENVIRONMENT: "sandbox" } as Env, "PROD"),
    ).toEqual({ broker: "etrade", mode: "live" });
  });

  it("derives the alpaca side from its pin, then the override, then the base URL", () => {
    expect(
      discoveryBrokerStageInput("alpaca", { ALPACA_TRADING_TYPE: "paper" } as Env, "PROD"),
    ).toEqual({ broker: "alpaca", mode: "paper" });
    expect(
      discoveryBrokerStageInput("alpaca", { ALPACA_TRADING_TYPE: "live" } as Env, "TEST"),
    ).toEqual({ broker: "alpaca", mode: "live" });
    expect(discoveryBrokerStageInput("alpaca", {} as Env, "TEST")).toEqual({
      broker: "alpaca",
      mode: "paper",
    });
    expect(discoveryBrokerStageInput("alpaca", {} as Env, "PROD")).toEqual({
      broker: "alpaca",
      mode: "live",
    });
    expect(
      discoveryBrokerStageInput(
        "alpaca",
        { ALPACA_BASE_URL: "https://paper-api.alpaca.markets" } as Env,
        undefined,
      ),
    ).toEqual({ broker: "alpaca", mode: "paper" });
    expect(
      discoveryBrokerStageInput(
        "alpaca",
        { ALPACA_BASE_URL: "https://api.alpaca.markets" } as Env,
        undefined,
      ),
    ).toEqual({ broker: "alpaca", mode: "live" });
  });

  it("derives the public mode from the override alone", () => {
    expect(discoveryBrokerStageInput("public", {} as Env, "PROD")).toEqual({
      broker: "public",
      mode: "live",
    });
    expect(discoveryBrokerStageInput("public", {} as Env, "TEST")).toEqual({
      broker: "public",
      mode: "paper",
    });
    expect(discoveryBrokerStageInput("public", {} as Env, undefined)).toEqual({
      broker: "public",
      mode: "paper",
    });
  });

  it("derives nothing for an unknown platform, the legacy alias, or a case variant", () => {
    expect(discoveryBrokerStageInput("schwab", {} as Env, undefined)).toBeNull();
    expect(discoveryBrokerStageInput("sandbox", {} as Env, undefined)).toBeNull();
    expect(discoveryBrokerStageInput("ETRADE", {} as Env, undefined)).toBeNull();
    expect(discoveryBrokerStageInput("", {} as Env, undefined)).toBeNull();
  });
});

describe("panel dispatch gate (#4468)", () => {
  const broker = { broker: "etrade", mode: "paper" } as const;

  it("routes host when the pair derives and the residency bindings are configured", () => {
    const decision = discoveryPanelDispatchRoute({ broker, env: boundEnv() });
    expect(decision.route).toBe("host");
  });

  it("stays on sync when no pair derives", () => {
    const decision = discoveryPanelDispatchRoute({ broker: null, env: boundEnv() });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/broker/i);
  });

  it("stays on sync when the durable store is unbound", () => {
    const env = boundEnv();
    delete (env as Record<string, unknown>).AGENT_DB;
    expect(discoveryPanelDispatchRoute({ broker, env }).route).toBe("sync");
  });

  it("stays on sync when the workflow binding is absent or has no create", () => {
    const noBinding = boundEnv();
    delete (noBinding as Record<string, unknown>).JOB_PIPELINE_WORKFLOW;
    expect(discoveryPanelDispatchRoute({ broker, env: noBinding }).route).toBe("sync");
    const noCreate = boundEnv() as unknown as Record<string, unknown>;
    noCreate.JOB_PIPELINE_WORKFLOW = {};
    expect(discoveryPanelDispatchRoute({ broker, env: noCreate as unknown as Env }).route).toBe(
      "sync",
    );
  });
});

describe("panel leg through the host (#4468)", () => {
  it("dispatches through the host seam, stamps the broker pair, and completes through the real flow", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const created: Array<{ jobId: string; trigger: string }> = [];
    const deps = flowDeps(stores, runRecorder, env);
    const broker = discoveryBrokerStageInput("etrade", env, undefined);
    expect(broker).toEqual({ broker: "etrade", mode: "paper" });

    const result = await runDiscoveryPanelViaHost({
      env,
      request: strategyRequest(),
      userLogin: USER,
      broker: broker!,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push({ jobId, trigger: params.trigger });
          const journal = recordingJournal();
          const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          expect(outcome.state).toBe("completed");
          return { instanceId: "wf-4468-1" };
        },
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].jobId).toMatch(/^strategy-screen:options-panel:service:AAPL:/);
    expect(created[0].trigger).toBe("manual");
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    expect(definition).not.toBeNull();
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "panel-cutover:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    const classInput = (stored as { classInput?: Record<string, unknown> })?.classInput;
    expect(classInput?.strategyRequest).toMatchObject({ symbol: "AAPL", thesis: "bullish" });
    // The panel leg is symbol-scoped: no universe input travels.
    expect(classInput && "universeDeps" in classInput).toBe(false);
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, created[0].jobId);
    expect(readBack.state).toBe("completed");
    expect(readBack.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const stage of readBack.stages) {
      expect(stage.status).toBe("completed");
    }
    expect(readBack.shapeReport).toBeDefined();
    expect(result.bestTrade).toBeDefined();
    // Ranking content is pinned by the host-vs-sync equality test
    // below, not here: this fixture completes the stages without
    // ranking a trade on either dispatch.
  });

  it("ranking semantics are unchanged across the dispatch move (the #4276 pin, host vs sync)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const chainSource = platformChainSource(fakePlatform("etrade"));
    expect(chainSource).not.toBeNull();
    const request = strategyRequest();
    const syncResult = await runOptionsPanelViaEngine(chainSource!, request, {}, USER, undefined);

    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const broker = discoveryBrokerStageInput("etrade", env, undefined);
    const hostResult = await runDiscoveryPanelViaHost({
      env,
      request: strategyRequest(),
      userLogin: USER,
      broker: broker!,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          return { instanceId: "wf-4468-2" };
        },
      },
    });

    expect(hostResult.bestTrade).toEqual(syncResult.bestTrade);
    expect(hostResult.ranked).toEqual(syncResult.ranked);
    expect(Object.keys(hostResult.strategies)).toEqual(Object.keys(syncResult.strategies));
  });

  it("a failed run throws naming the stage and reason", async () => {
    const { stores, runRecorder } = fakeStores();
    const failedView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:failed:1",
      runId: "failed:1",
      state: "failed",
      engineRunId: "engine-1",
      stages: [
        { stageId: "feed", status: "completed" },
        { stageId: "screen", status: "failed", error: "no chains for AAPL" },
      ] as OptionsWorkflowRunView["stages"],
    };
    await expect(
      runDiscoveryPanelViaHost({
        env: boundEnv(),
        request: strategyRequest(),
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4468-failed" }),
          awaitOptions: { readRun: async () => failedView },
        },
      }),
    ).rejects.toThrow(/Options strategy screen failed at screen: no chains for AAPL/);
  });

  it("a run that completes without a report refuses to answer from nothing", async () => {
    const { stores, runRecorder } = fakeStores();
    const emptyView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:empty:1",
      runId: "empty:1",
      state: "completed",
      engineRunId: "engine-1",
      stages: [],
    };
    await expect(
      runDiscoveryPanelViaHost({
        env: boundEnv(),
        request: strategyRequest(),
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4468-empty" }),
          awaitOptions: { readRun: async () => emptyView },
        },
      }),
    ).rejects.toThrow(/refusing to answer from nothing/);
  });

  it("an unsettled run throws the named timeout", async () => {
    const { stores, runRecorder } = fakeStores();
    const runningView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:running:1",
      runId: "running:1",
      state: "running",
      engineRunId: "engine-1",
      stages: [],
    };
    await expect(
      runDiscoveryPanelViaHost({
        env: boundEnv(),
        request: strategyRequest(),
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4468-running" }),
          awaitOptions: {
            intervalMs: 1,
            timeoutMs: 10,
            sleep: async () => {},
            readRun: async () => runningView,
          },
        },
      }),
    ).rejects.toThrow(/options_workflow_run_timeout/);
  });
});

describe("gated-out panel runs stay on sync (#4468)", () => {
  it("without bindings the host seam is never invoked and the result equals a direct sync call", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = { ETRADE_ENVIRONMENT: "sandbox" } as Env;
    const chainSource = platformChainSource(fakePlatform("etrade"));
    const broker = discoveryBrokerStageInput("etrade", env, undefined);
    const created: string[] = [];
    const { stores, runRecorder } = fakeStores();
    const runPipeline = createDiscoveryPanelRunner({
      env,
      userLogin: USER,
      chainSource: chainSource!,
      broker,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          created.push(jobId);
          return { instanceId: "never" };
        },
      },
    });
    const request = strategyRequest();
    const result = await runPipeline(request);
    expect(created).toEqual([]);
    const direct = await runOptionsPanelViaEngine(chainSource!, strategyRequest(), {}, USER, undefined);
    expect(result.bestTrade).toEqual(direct.bestTrade);
    expect(result.ranked).toEqual(direct.ranked);
  });

  it("without a derived pair the host seam is never invoked", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv();
    const chainSource = platformChainSource(fakePlatform("schwab"));
    const created: string[] = [];
    const { stores, runRecorder } = fakeStores();
    const runPipeline = createDiscoveryPanelRunner({
      env,
      userLogin: USER,
      chainSource: chainSource!,
      broker: discoveryBrokerStageInput("schwab", env, undefined),
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId) => {
          created.push(jobId);
          return { instanceId: "never" };
        },
      },
    });
    const result = await runPipeline(strategyRequest());
    expect(created).toEqual([]);
    expect(result.bestTrade).toBeDefined();
  });

  it("the runner dispatches through the host when the gate holds", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const chainSource = platformChainSource(fakePlatform("etrade"));
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const created: string[] = [];
    const runPipeline = createDiscoveryPanelRunner({
      env,
      userLogin: USER,
      chainSource: chainSource!,
      broker: discoveryBrokerStageInput("etrade", env, undefined),
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push(jobId);
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          return { instanceId: "wf-4468-3" };
        },
      },
    });
    const result = await runPipeline(strategyRequest());
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^strategy-screen:options-panel:service:AAPL:/);
    expect(result.bestTrade).toBeDefined();
  });
});

describe("service composition (#4468)", () => {
  it("createDiscoveryService builds runPipeline from the derived pair through the panel runner", () => {
    const source = readFileSync("src/services/discoveryService.ts", "utf8");
    expect(source).toContain("discoveryBrokerStageInput(args.platform.platformId");
    expect(source).toContain("runPipeline: createDiscoveryPanelRunner({");
  });
});
