/**
 * Issue #4854 — the scheduled firer's options screens move onto the
 * strategy workflow host (startStrategyScreenWorkflow), gated: the
 * host only when the firer's (broker, mode) pair derives from the
 * platform the run executes on (E*TRADE, #4853's derivation) and the
 * residency bindings are configured, and the run carries no stored
 * snapshot input; otherwise the unchanged sync dispatch
 * (runOptionsPanelViaEngineWithAgents, #4275).
 *
 * What these tests defend:
 *   1. The gate: no derived pair, no AGENT_DB, no workflow binding,
 *      or a snapshot input keeps the firer on sync; all four hold
 *      routes host. A snapshot-input run stays on sync because the
 *      stored snapshot would have to ride the D1 job definition —
 *      the #1236 feed seam's contract is a stored-snapshot run, not
 *      a live-chain run.
 *   2. The host dispatch defines the strategy job, stamps the broker
 *      pair AND the universe descriptor ({ provider: "nasdaq" } —
 *      no tenant, so the residency rebuild defaults exactly as the
 *      firer's call-site bundle build does), runs under trigger
 *      "scheduled" with the firer's run-id template, completes
 *      through the real flow with the real residency factories
 *      resolving the chain source and the universe deps, and maps
 *      the shapeReport back to the PipelineResult the firer
 *      consumes.
 *   3. Ranking semantics are unchanged: the same request through
 *      the host and through sync yields the same pick and ranking
 *      (the #4276 semantics pin, extended across the dispatch
 *      move).
 *   4. Gated-out runs stay on the unchanged sync path (the host
 *      seam is never invoked) and equal a direct sync call.
 *   5. A failed run throws naming the stage and reason; a run that
 *      completes without a report refuses to answer from nothing;
 *      an unsettled run throws the named timeout — the manual
 *      route's failure shapes (#4848).
 *   6. The wiring: a saved-request scheduled discovery dispatches
 *      its symbols through the host when the gate holds (the
 *      decision is taken once per run, not per symbol), and stays
 *      on sync when the bindings are unbound.
 *
 * The fakes sit only at binding seams: the chain fixture stands in
 * for live broker chains; the workflow create call is injected (the
 * #4291/#4848 idiom — real workflow.create is never executed); the
 * stores are the in-memory job-pipeline adapters; the universe
 * factory is the real resolver over fake D1 provider ports with an
 * injected listings fetcher (the #4857 idiom). The engine, the
 * ports, the resolving steps, and the residency factories are real.
 * Queue publishing rides the residency binding (#4851 — the
 * workflow builds its queue from env.SCREENER_EVENTS, the same
 * binding the service's stageQueue threads from), so no queue
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
  resolveScheduledFirerHostDispatch,
  runScheduledFirerPanelViaHost,
  scheduledFirerDispatchRoute,
  ScheduledTasksService,
} from "../src/services/scheduledTasks";
import { InMemoryDiscoveryRunStore } from "../src/trading/options/discoveryRunStore";

const USER = "firer_cutover_tester";

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

describe("scheduled firer dispatch gate (#4854)", () => {
  const broker = { broker: "etrade", mode: "paper" } as const;

  it("routes host when the pair derives, the residency bindings are configured, and no snapshot input rides along", () => {
    const decision = scheduledFirerDispatchRoute({ broker, env: boundEnv() });
    expect(decision.route).toBe("host");
  });

  it("stays on sync when no pair derives", () => {
    const decision = scheduledFirerDispatchRoute({ broker: null, env: boundEnv() });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/broker/i);
  });

  it("stays on sync when the durable store is unbound", () => {
    const env = boundEnv();
    delete (env as Record<string, unknown>).AGENT_DB;
    expect(scheduledFirerDispatchRoute({ broker, env }).route).toBe("sync");
  });

  it("stays on sync when the workflow binding is absent or has no create", () => {
    const noBinding = boundEnv();
    delete (noBinding as Record<string, unknown>).JOB_PIPELINE_WORKFLOW;
    expect(scheduledFirerDispatchRoute({ broker, env: noBinding }).route).toBe("sync");
    const noCreate = boundEnv() as unknown as Record<string, unknown>;
    noCreate.JOB_PIPELINE_WORKFLOW = {};
    expect(scheduledFirerDispatchRoute({ broker, env: noCreate as unknown as Env }).route).toBe(
      "sync",
    );
  });

  it("stays on sync when a snapshot input rides along — the stored snapshot does not travel on the job definition", () => {
    const decision = scheduledFirerDispatchRoute({
      broker,
      env: boundEnv(),
      snapshotInput: { artifacts: { AAPL: "feed-1" } },
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/snapshot/i);
  });

  it("resolves the per-run dispatch once: the tenant's broker with the schedule environment", async () => {
    // Issue #5184: the scheduled firer follows the tenant's resolved broker
    // (the platform default when nothing was selected), never a literal id.
    const host = await resolveScheduledFirerHostDispatch(boundEnv(), "TEST", undefined);
    expect(host.broker).toEqual({ broker: "alpaca", mode: "paper" });
    expect(host.decision.route).toBe("host");
    const etrade = await resolveScheduledFirerHostDispatch(
      boundEnv({ TENANT_BROKER_ID: "etrade" }),
      "PROD",
      undefined,
    );
    expect(etrade.broker).toEqual({ broker: "etrade", mode: "live" });
    expect(etrade.decision.route).toBe("host");
    const snapshotted = await resolveScheduledFirerHostDispatch(boundEnv(), "TEST", {
      artifacts: { AAPL: "feed-1" },
    });
    expect(snapshotted.decision.route).toBe("sync");
    const unbound = await resolveScheduledFirerHostDispatch({} as Env, "TEST", undefined);
    expect(unbound.broker).toEqual({ broker: "alpaca", mode: "paper" });
    expect(unbound.decision.route).toBe("sync");
  });

  it("refuses a broker whose catalogue declares no option chains (#5184)", async () => {
    await expect(
      resolveScheduledFirerHostDispatch(boundEnv({ TENANT_BROKER_ID: "tastytrade" }), "TEST", undefined),
    ).rejects.toThrow(/FAILURE_BROKER_UNAVAILABLE/);
  });

  it("carries the schedule's stored run target into the dispatch context (#5189)", async () => {
    const host = await resolveScheduledFirerHostDispatch(
      boundEnv({ TENANT_BROKER_ID: "etrade" }),
      "TEST",
      undefined,
      { brokerId: "alpaca", mode: "paper", accountId: "acc-9", source: "schedule" },
    );

    expect(host.context.brokerId).toBe("alpaca");
    expect(host.context.mode).toBe("paper");
    expect(host.context.accountId).toBe("acc-9");
    expect(host.context.source).toBe("schedule");
    expect(host.broker).toEqual({ broker: "alpaca", mode: "paper" });
  });
});

describe("scheduled firer panel through the host (#4854)", () => {
  it("dispatches through the host seam, stamps broker + universe, and completes through the real flow", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const universeCalls: Array<unknown> = [];
    const deps = flowDeps(stores, runRecorder, env, universeCalls);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const broker = { broker: "etrade", mode: "paper" } as const;

    const result = await runScheduledFirerPanelViaHost({
      env,
      request: strategyRequest(),
      runId: "options-panel:scheduled:AAPL:2026-11-16T00:00:00.000Z",
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
          return { instanceId: "wf-4854-1" };
        },
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].jobId).toBe(
      "strategy-screen:options-panel:scheduled:AAPL:2026-11-16T00:00:00.000Z",
    );
    expect(created[0].trigger).toBe("scheduled");
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    expect(definition).not.toBeNull();
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "firer-cutover:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    // The universe descriptor travels, tenant-less: the residency
    // rebuild defaults the tenant exactly as the firer's call-site
    // bundle build does (scheduledUniverseDeps passes no tenant).
    expect(decodeUniverseDepsStageInput(stored, "firer-cutover:1")).toEqual({
      provider: "nasdaq",
    });
    const classInput = (stored as { classInput?: Record<string, unknown> })?.classInput;
    expect(classInput?.strategyRequest).toMatchObject({ symbol: "AAPL", thesis: "bullish" });
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
    const universeCalls: Array<unknown> = [];
    const deps = flowDeps(stores, runRecorder, env, universeCalls);
    const hostResult = await runScheduledFirerPanelViaHost({
      env,
      request: strategyRequest(),
      runId: "options-panel:scheduled:AAPL:2026-11-16T00:00:00.000Z",
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
          return { instanceId: "wf-4854-2" };
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
      runScheduledFirerPanelViaHost({
        env: boundEnv(),
        request: strategyRequest(),
        runId: "options-panel:scheduled:AAPL:2026-11-16T00:00:00.000Z",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4854-failed" }),
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
      runScheduledFirerPanelViaHost({
        env: boundEnv(),
        request: strategyRequest(),
        runId: "options-panel:scheduled:AAPL:2026-11-16T00:00:00.000Z",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4854-empty" }),
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
      runScheduledFirerPanelViaHost({
        env: boundEnv(),
        request: strategyRequest(),
        runId: "options-panel:scheduled:AAPL:2026-11-16T00:00:00.000Z",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4854-pending" }),
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

describe("scheduled firer wiring (#4854)", () => {
  function makeEnv(): Env {
    return {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
  }

  function makeOrm() {
    return {
      trades: {},
      events: { create: vi.fn() },
      messages: { create: vi.fn() },
      watchlists: { findMany: vi.fn(() => []) },
    } as any;
  }

  it("a saved-request scheduled discovery dispatches its symbols through the host when the gate holds", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = {
      ...makeEnv(),
      AGENT_DB: {},
      JOB_PIPELINE_WORKFLOW: { create: async () => ({ id: "never-created" }) },
    } as unknown as Env;
    const { stores, runRecorder } = fakeStores();
    const universeCalls: Array<unknown> = [];
    const deps = flowDeps(stores, runRecorder, env, universeCalls);
    const created: Array<{ jobId: string; trigger: string }> = [];
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-4854" });
    const service = new ScheduledTasksService(
      env,
      makeOrm(),
      USER,
      undefined,
      undefined,
      runStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
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
          return { instanceId: "wf-4854-wiring" };
        },
      },
    );

    const result = await service.autonomousStrategyDiscovery({
      requests: [strategyRequest()],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    expect(created).toHaveLength(1);
    expect(created[0].jobId).toMatch(/^strategy-screen:options-panel:scheduled:AAPL:/);
    expect(created[0].trigger).toBe("scheduled");
    expect(universeCalls).toHaveLength(OPTIONS_PIPELINE_STAGES.length);
    for (const call of universeCalls) {
      expect(call).toEqual({ provider: "nasdaq" });
    }
    const stored = await runStore.get("run-4854", { userLogin: USER });
    expect(stored!.outcomes).toHaveLength(1);
    expect(stored!.outcomes[0].status).toBe("completed");
  });

  it("stays on sync when the residency bindings are unbound — the host seam is never invoked", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = makeEnv();
    const runStore = new InMemoryDiscoveryRunStore({ idFactory: () => "run-4854-sync" });
    const startWorkflow = vi.fn(async () => ({ instanceId: "wf-4854-never" }));
    const service = new ScheduledTasksService(
      env,
      makeOrm(),
      USER,
      undefined,
      undefined,
      runStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { startWorkflow },
    );

    const result = await service.autonomousStrategyDiscovery({
      requests: [strategyRequest()],
      trigger: "scheduled",
      userLogin: USER,
      environment: "TEST",
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("completed");
    expect(startWorkflow).not.toHaveBeenCalled();
    const stored = await runStore.get("run-4854-sync", { userLogin: USER });
    expect(stored!.outcomes).toHaveLength(1);
    expect(stored!.outcomes[0].status).toBe("completed");
  });
});
