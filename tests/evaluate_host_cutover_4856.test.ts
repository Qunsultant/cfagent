/**
 * Issue #4856 — the evaluate route's panel run moves onto the
 * strategy workflow host (startStrategyScreenWorkflow), gated: the
 * host only when the route's (broker, mode) pair derives from the
 * E*TRADE platform with the request's environment (the #4853
 * derivation — the same (env, overrideEnv) the ETradeService was
 * constructed with) and the residency bindings are configured;
 * otherwise the unchanged sync dispatch (runOptionsPanelViaEngine,
 * #4068). The universe descriptor rides the stored request
 * (#4857): the resolving steps rebuild live universe deps per
 * invocation through the production residency factory, so the host
 * run screens with the same universe deps the route binds today.
 *
 * What these tests defend:
 *   1. The gate: no derived pair, no AGENT_DB, or no workflow
 *      binding keeps the route on sync; a derived pair +
 *      configured bindings routes host. The requested
 *      environment decides the mode (TEST → paper, PROD →
 *      live), so the residency fetches the same environment's
 *      chains the sync dispatch would.
 *   2. The host dispatch defines the strategy job with the sync
 *      dispatch's envelope (the strategy request + riskProfile
 *      "balanced", trigger "manual", the sync run-id template),
 *      stamps the broker pair + the tenant-less universe
 *      descriptor, and completes through the real flow with the
 *      real residency factories resolving the chain source and
 *      the universe deps.
 *   3. Evaluation semantics are unchanged: the same request
 *      through the host and through sync yields the same ranked
 *      candidates, best trade, and strategy keys (the #4276 pin,
 *      extended across the dispatch move).
 *   4. Gated-out runs stay on the unchanged sync path (the host
 *      seam is never invoked; the route binds its universe deps
 *      as today), and host-path runs never call the live
 *      universe-deps builder (the descriptor travels, not the
 *      function-valued deps).
 *   5. A failed run throws naming the stage and reason; a run
 *      that completes without a report refuses to answer from
 *      nothing; an unsettled run throws the named timeout — the
 *      manual route's failure shapes (#4848).
 *
 * The fakes sit only at binding seams: the chain fixture stands in
 * for live broker chains; the workflow create call is injected (the
 * #4291/#4848 idiom — real workflow.create is never executed); the
 * stores are the in-memory job-pipeline adapters. The engine, the
 * ports, the resolving steps, and the residency factories are real.
 * Queue publishing rides the residency binding (#4851 — the
 * workflow builds its queue from env.SCREENER_EVENTS), so no queue
 * assertion lives here: the residency's queue test covers it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import type { ProviderConfigStore } from "../src/data/providerConfigPorts";
import type { ProviderCaptureStore } from "../src/data/providerCapturePorts";
import type { UniverseDepsResidencyPorts } from "../src/workflows/universeDepsResidency";
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
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { resolveUniverseDepsFromStageInput } from "../src/workflows/universeDepsResidency";
import {
  decodeBrokerStageInput,
  decodeUniverseDepsStageInput,
} from "../src/workflows/optionsStepPorts";
import {
  readOptionsWorkflowRun,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { platformChainSource, type ITradingPlatform, type StrategyRequest } from "../src/trading";
import { runOptionsPanelViaEngine } from "../src/workflows/optionsScreenEngine";
import { resolveChainSourceForRequest } from "../src/workflows/brokerChainSourceResidency";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import type { Env, ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import {
  evaluateDispatchRoute,
  executeLlmIdeasEvaluation,
  resolveEvaluateHostDispatch,
  runEvaluatePanelViaHost,
} from "../src/agents/routes/etradeOptionsEvaluate";

const USER = "evaluate_cutover_tester";

function expiryAtDte(dte: number): ETradeOptionExpireDate {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dte));
  return { year: date.getUTCFullYear(), month: date.getMonth() + 1, day: date.getDate() };
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

/** The evaluate route's strategy request, as the route builds it for a bullish question at spot 100. */
function evaluateRequest(): StrategyRequest {
  return {
    symbol: "AAPL",
    thesis: "bullish",
    targetPrice: 105,
    targetDate: targetDate(),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 100000,
    minRewardRisk: 0,
    allowedStrategies: ["all"],
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
    ETRADE_ENVIRONMENT: "sandbox",
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
 * intercepts the screener's fetches), and the REAL universe
 * factory over fake D1 provider ports with an injected listings
 * fetcher (the #4857 idiom) — so the stamped universe descriptor
 * is proven to rebuild through the production factory, not a stub.
 */
function flowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  env: Env,
  universeCalls: Array<unknown>,
): JobPipelineDeps {
  const stepDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    env,
    chainSourceFor: (userLogin, request, runId) =>
      resolveChainSourceForRequest(env, { userLogin, request, runId }),
    universeDepsFor: async (args) => {
      universeCalls.push(args.universe);
      return resolveUniverseDepsFromStageInput(env, args, {
        ports: fakeProviderPorts(),
        fetchListings: async () => LISTINGS,
      });
    },
  };
  return {
    stores,
    runRecorder,
    publisher: null,
    steps: registerOptionsWorkflowSteps(createBuiltinStepRegistry(), stepDeps),
    invocation: "workflow-shard",
  };
}

/** The listings the injected fetcher returns: the screened symbol, chain-fixtured below. */
const LISTINGS: NasdaqStockListing[] = [
  { symbol: "AAPL", companyName: "Apple Inc", exchange: "nasdaq", change: 0, changePercent: 0 },
];

/**
 * Fake D1 provider ports for the residency factory (the #4857
 * idiom): an enabled nasdaq config + a screenUniverse route naming
 * nasdaq as primary (the seeded production shape). Only the methods
 * the route bundle touches are implemented; the rest of the port
 * surfaces are unreachable from the bundle and throw if touched,
 * so a test that reaches them fails loudly instead of passing on a
 * silent stub.
 */
function fakeProviderPorts(): UniverseDepsResidencyPorts {
  const configRecord = {
    id: "nasdaq",
    adapterKind: "nasdaq",
    lifecycleState: "enabled",
    enabled: true,
    precedence: 1,
    credentialRef: null,
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const routeRecord = {
    capability: "screenUniverse",
    primaryProviderId: "nasdaq",
    gapFillProviderId: null,
    minTier: "freemium",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const unreachable = (name: string): never => {
    throw new Error(`fake provider port: ${name} is unreachable from the route bundle`);
  };
  const config = {
    bootstrapDataProviders: async () => [configRecord],
    getProviderConfig: async () => configRecord,
    listProviderConfigs: async () => [configRecord],
    listCapabilityRoutes: async () => [routeRecord],
    upsertProviderConfig: async () => unreachable("upsertProviderConfig"),
    setProviderLifecycleState: async () => unreachable("setProviderLifecycleState"),
    setProviderEnabled: async () => unreachable("setProviderEnabled"),
    clearProviderCredentialRef: async () => unreachable("clearProviderCredentialRef"),
    upsertCapabilityRoute: async () => unreachable("upsertCapabilityRoute"),
    getCapabilityRoute: async () => routeRecord,
  } as unknown as ProviderConfigStore;
  const captures = {
    recordCapture: async () => ({ id: "capture-1" }),
    recordFetchFailure: async () => ({ id: "capture-1" }),
    createFetchOutcomeRecorder: () => ({
      recordSuccess: async () => {},
      recordFailure: async () => {},
    }),
    getCaptureById: async () => null,
    listCapturesByRun: async () => [],
    listCapturesByProvider: async () => [],
  } as unknown as ProviderCaptureStore;
  return { config, captures };
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

describe("evaluate dispatch gate (#4856)", () => {
  it("routes host when the pair derives and the residency bindings are configured", () => {
    const decision = evaluateDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: boundEnv(),
    });
    expect(decision.route).toBe("host");
  });

  it("stays on sync when no pair derives", () => {
    const decision = evaluateDispatchRoute({ broker: null, env: boundEnv() });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/no broker stage input/);
  });

  it("stays on sync when the durable store is unbound", () => {
    const env = boundEnv();
    const { AGENT_DB: _dropped, ...unbound } = env as unknown as Record<string, unknown>;
    const decision = evaluateDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: unbound as unknown as Env,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/residency bindings/);
  });

  it("stays on sync when the workflow binding is absent or has no create", () => {
    const noBinding = evaluateDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: { ETRADE_ENVIRONMENT: "sandbox", AGENT_DB: {} } as unknown as Env,
    });
    expect(noBinding.route).toBe("sync");
    const noCreate = evaluateDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: {
        ETRADE_ENVIRONMENT: "sandbox",
        AGENT_DB: {},
        JOB_PIPELINE_WORKFLOW: {},
      } as unknown as Env,
    });
    expect(noCreate.route).toBe("sync");
  });

  it("resolves the per-run dispatch once: etrade with the request environment decides the mode", () => {
    const test = resolveEvaluateHostDispatch(boundEnv(), "TEST");
    expect(test.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(test.decision.route).toBe("host");
    const prod = resolveEvaluateHostDispatch(boundEnv(), "PROD");
    expect(prod.broker).toEqual({ broker: "etrade", mode: "live" });
    expect(prod.decision.route).toBe("host");
  });

  it("an unrecorded requested environment derives from the worker env, as the service was constructed", () => {
    const derived = resolveEvaluateHostDispatch(boundEnv(), undefined);
    expect(derived.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(derived.decision.route).toBe("host");
  });

  it("stays on sync when the residency bindings are unbound, even with a derived pair", () => {
    const env = { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env;
    const dispatch = resolveEvaluateHostDispatch(env, "TEST");
    expect(dispatch.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(dispatch.decision.route).toBe("sync");
  });
});

describe("evaluate panel through the host (#4856)", () => {
  it("dispatches through the host seam, stamps broker + universe, and completes through the real flow", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const universeCalls: Array<unknown> = [];
    const deps = flowDeps(stores, runRecorder, env, universeCalls);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const broker = { broker: "etrade", mode: "paper" } as const;

    const result = await runEvaluatePanelViaHost({
      env,
      request: evaluateRequest(),
      runId: "options-panel:service:AAPL:2026-11-17T00:00:00.000Z",
      userLogin: USER,
      broker,
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
          return { instanceId: "wf-4856-1" };
        },
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].jobId).toBe(
      "strategy-screen:options-panel:service:AAPL:2026-11-17T00:00:00.000Z",
    );
    expect(created[0].trigger).toBe("manual");
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    expect(definition).not.toBeNull();
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "evaluate-cutover:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    // The universe descriptor travels, tenant-less: the residency
    // rebuild defaults the tenant exactly as the route's call-site
    // bundle build does (nasdaqUniverseSeamFromSql passes no tenant).
    expect(decodeUniverseDepsStageInput(stored, "evaluate-cutover:1")).toEqual({
      provider: "nasdaq",
    });
    const classInput = (stored as { classInput?: Record<string, unknown> })?.classInput;
    expect(classInput?.strategyRequest).toMatchObject({ symbol: "AAPL", thesis: "bullish" });
    expect(classInput?.riskProfile).toBe("balanced");
    // The resolving steps rebuilt the universe deps through the
    // production factory: the stamped descriptor reached it once
    // per stage invocation, identical every time.
    expect(universeCalls).toHaveLength(OPTIONS_PIPELINE_STAGES.length);
    for (const call of universeCalls) {
      expect(call).toEqual({ provider: "nasdaq" });
    }
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, created[0].jobId);
    expect(readBack.state).toBe("completed");
    expect(readBack.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const stage of readBack.stages) {
      expect(stage.status).toBe("completed");
    }
    expect(readBack.shapeReport).toBeDefined();
    expect(result.ranked).toBeDefined();
    expect(result.snapshot.contracts).toBeDefined();
  });

  it("evaluation semantics are unchanged across the dispatch move (the #4276 pin, host vs sync)", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const chainSource = platformChainSource(fakePlatform("etrade"));
    expect(chainSource).not.toBeNull();
    const syncResult = await runOptionsPanelViaEngine(
      chainSource!,
      evaluateRequest(),
      { riskProfile: "balanced" },
      USER,
      { fetchListings: async () => LISTINGS },
    );

    const { stores, runRecorder } = fakeStores();
    const universeCalls: Array<unknown> = [];
    const deps = flowDeps(stores, runRecorder, env, universeCalls);
    const hostResult = await runEvaluatePanelViaHost({
      env,
      request: evaluateRequest(),
      runId: "options-panel:service:AAPL:2026-11-17T00:00:00.000Z",
      userLogin: USER,
      broker: { broker: "etrade", mode: "paper" },
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          return { instanceId: "wf-4856-2" };
        },
      },
    });

    expect(hostResult.bestTrade).toEqual(syncResult.bestTrade);
    expect(hostResult.ranked).toEqual(syncResult.ranked);
    expect(Object.keys(hostResult.strategies)).toEqual(Object.keys(syncResult.strategies));
    expect(hostResult.snapshot.contracts).toEqual(syncResult.snapshot.contracts);
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
      runEvaluatePanelViaHost({
        env: boundEnv(),
        request: evaluateRequest(),
        runId: "options-panel:service:AAPL:2026-11-17T00:00:00.000Z",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4856-failed" }),
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
      runEvaluatePanelViaHost({
        env: boundEnv(),
        request: evaluateRequest(),
        runId: "options-panel:service:AAPL:2026-11-17T00:00:00.000Z",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4856-empty" }),
          awaitOptions: { readRun: async () => emptyView },
        },
      }),
    ).rejects.toThrow(/completed without a report artifact/);
  });

  it("an unsettled run throws the named timeout", async () => {
    const { stores, runRecorder } = fakeStores();
    const pendingView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:pending:1",
      runId: "pending:1",
      state: "running",
      engineRunId: "engine-1",
      stages: [],
    };
    await expect(
      runEvaluatePanelViaHost({
        env: boundEnv(),
        request: evaluateRequest(),
        runId: "options-panel:service:AAPL:2026-11-17T00:00:00.000Z",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4856-pending" }),
          awaitOptions: {
            readRun: async () => pendingView,
            timeoutMs: 5,
            intervalMs: 1,
            sleep: async () => {},
          },
        },
      }),
    ).rejects.toThrow(/options_workflow_run_timeout/);
  });
});

describe("evaluate wiring (#4856)", () => {
  function routeArgs(
    env: Env,
    etrade: unknown,
    seams?: Parameters<typeof executeLlmIdeasEvaluation>[0]["hostSeams"],
  ) {
    const chain = makeChain("AAPL");
    return {
      ctx: {
        env,
        getOrm: () => ({}) as never,
        agentCtx: { storage: undefined },
        ensureTables: () => undefined as never,
        requestedEnv: "TEST" as const,
        getScreenerAgent: () => undefined as never,
      } as never,
      orm: {} as never,
      etrade: etrade as never,
      userLogin: USER,
      symbol: "AAPL",
      question: "What is the bullish outlook for AAPL?",
      cached: {
        expirations: [chain.selectedExpiry],
        chains: [chain],
        fetchedAt: Date.now(),
      } as never,
      retrievedChains: [] as ETradeOptionChain[],
      state: { retrievedExpirations: [], usedSyntheticChains: false },
      ...(seams ? { hostSeams: seams } : {}),
    };
  }

  it("the route dispatches through the host when the gate holds, and never calls the live universe-deps builder", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const universeCalls: Array<unknown> = [];
    const deps = flowDeps(stores, runRecorder, env, universeCalls);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const getUniverseDeps = vi.fn(async () => undefined);
    const etrade = { client: {}, getUniverseDeps };

    const response = await executeLlmIdeasEvaluation(
      routeArgs(env, etrade, {
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
          return { instanceId: "wf-4856-wiring" };
        },
      }),
    );

    expect(created).toHaveLength(1);
    expect(created[0].jobId).toMatch(/^strategy-screen:options-panel:service:AAPL:/);
    expect(created[0].trigger).toBe("manual");
    expect(universeCalls).toHaveLength(OPTIONS_PIPELINE_STAGES.length);
    expect(getUniverseDeps).not.toHaveBeenCalled();
    const body = (await response.json()) as {
      mode: string;
      quant: { ranked: unknown[]; candidateCount: number };
    };
    expect(body.mode).toBe("llm_evaluation_of_quant_candidates");
    expect(Array.isArray(body.quant.ranked)).toBe(true);
  });

  it("stays on sync when the residency bindings are unbound — the host seam is never invoked", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env;
    const chainSource = platformChainSource(fakePlatform("etrade"));
    const getUniverseDeps = vi.fn(async () => undefined);
    const etrade = { client: chainSource, getUniverseDeps };
    const startWorkflow = vi.fn(async () => ({ instanceId: "wf-4856-never" }));

    const response = await executeLlmIdeasEvaluation(
      routeArgs(env, etrade, { startWorkflow }),
    );

    expect(startWorkflow).not.toHaveBeenCalled();
    // The sync path binds its universe deps exactly as today.
    expect(getUniverseDeps).toHaveBeenCalledTimes(1);
    const body = (await response.json()) as {
      mode: string;
      quant: { ranked: unknown[]; candidateCount: number };
    };
    expect(body.mode).toBe("llm_evaluation_of_quant_candidates");
    expect(Array.isArray(body.quant.ranked)).toBe(true);
  });
});
