/**
 * Issue #4469 — the NLQ scan-leg cutover: the opportunity scan
 * dispatches through the strategy workflow host, gated.
 *
 * The scan leg (runOpportunityScan in nlqOptionsStrategy.ts) dispatched
 * in-process through runStrategyScreenViaEngine with a scan-run store,
 * a stage queue, and a broker provenance stamp. The residency binds no
 * scan-run store (#4453 decided-not-to: the family is DO-resident, and
 * the persist stage degrades by name) and resolves its chain source
 * from the #3960 (broker, mode) stage input. This slice moves the leg's
 * dispatch onto startStrategyScreenWorkflow + awaitOptionsWorkflowRun
 * when the gate holds — the pair derives from the run's broker stamp
 * (the #4468 derivation, reused) and the residency bindings are
 * configured — and keeps the unchanged sync dispatch otherwise.
 *
 * These tests prove the gate, the host dispatch through the real flow
 * (the REAL broker factory over the real registry, construction-only;
 * the fixture intercepts the screener's fetches), the queue publishing
 * through the #4453 wiring, the named no-store degradation inside the
 * residency, the host-side persistence after settlement (the scan run
 * still persists — in the caller's own store, where every reader reads
 * it — with the pair's broker), the failure modes, host-vs-sync result
 * equality, and the composition (the action branches on the gate; both
 * production hosts thread the env). No live runs; no real
 * workflow.create (the injected seam, the #4291/#4450/#4468 idiom).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryScanRunStore } from "../src/data/inMemoryScanRunAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import type { ScanRunStore } from "../src/data/scanRunPorts";
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
import { discoveryBrokerStageInput } from "../src/services/discoveryService";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import {
  nlqScanDispatchRoute,
  runNlqScanViaHost,
  runOptionsStrategyAction,
} from "../src/agents/nlqOptionsStrategy";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OpportunityScanResult } from "../src/trading";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import { resolveChainSourceForRequest } from "../src/workflows/brokerChainSourceResidency";
import {
  optionsStageStorageFromArtifacts,
  runStrategyScreenViaEngine,
  strategyScreenJobId,
} from "../src/workflows/optionsScreenEngine";
import { optionsArtifactKey } from "../src/workflows/optionsScreenPorts";
import { decodeBrokerStageInput } from "../src/workflows/optionsStepPorts";
import { memoryStageClaims, memoryStageStorage } from "../src/workflows/optionsScreenWorkflow";
import {
  readOptionsWorkflowRun,
  type OptionsWorkflowRunView,
} from "../src/workflows/optionsWorkflowHost";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { OPTIONS_PIPELINE_STAGES } from "../src/workflows/stageRuntimeIds";
import type { StageQueueSend } from "../src/workflows/stageQueueTransport";
import {
  createScannerScreenPorts,
  createStrategyScreenAgents,
} from "../src/workflows/strategyScreenPorts";

const USER = "tester";

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
 * The production residency shape: the resolving steps rebuild ports
 * per invocation with the REAL broker factory over the real
 * platform registry (construction only, no I/O — the fixture
 * intercepts the screener's fetches). No scan-run store: the #4453
 * decided-not-to — the persist stage degrades by name.
 */
function flowDeps(
  stores: JobPipelineStores,
  runRecorder: JobRunRecorder,
  env: Env,
  extra: Partial<OptionsWorkflowStepDeps> = {},
): JobPipelineDeps {
  const stepDeps: OptionsWorkflowStepDeps = {
    definitions: stores.definitions,
    artifacts: stores.artifacts,
    env,
    chainSourceFor: (userLogin, request, runId) =>
      resolveChainSourceForRequest(env, { userLogin, request, runId }),
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
 * The NLQ scan envelope, as runOpportunityScan assembles it: the scan
 * request (explicit symbols, the validated template, the options),
 * the replayable request record, and the broker provenance stamp
 * (#3327) — a string, or absent when the caller stamps none.
 */
function scanEnvelope(runId: string, broker?: unknown) {
  return {
    assetClass: "options",
    runIdentity: { runId },
    trigger: "manual",
    classInput: {
      scan: {
        symbols: ["AAPL"],
        template: {
          thesis: "bullish",
          targetDate: targetDate(),
          expectedIvDirection: "unchanged",
          maxPlannedLoss: 5_000,
          minRewardRisk: 0.1,
          allowedStrategies: ["long_call"],
          minDte: 14,
          maxDte: 60,
          contractLimit: 500,
          candidateLimit: 10,
          maxStrikesPerSide: 12,
          maxIronCondors: 100,
          maxQuoteAgeSeconds: 60,
          eventPolicy: "warn",
        },
        options: { riskProfile: "balanced", eventCalendarBySymbol: {} },
      },
      requestRecord: { symbols: ["AAPL"], riskProfile: "balanced" },
      ...(broker !== undefined ? { broker } : {}),
    },
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

describe("scan dispatch gate (#4469)", () => {
  it("routes host when the pair derives and the residency bindings are configured", () => {
    const env = boundEnv();
    const broker = discoveryBrokerStageInput("etrade", env, undefined);
    const decision = nlqScanDispatchRoute({ broker, env });
    expect(decision.route).toBe("host");
  });

  it("stays on sync when no env is threaded", () => {
    const decision = nlqScanDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: undefined,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/no env/i);
  });

  it("stays on sync when no pair derives", () => {
    const decision = nlqScanDispatchRoute({ broker: null, env: boundEnv() });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/no broker stage input/i);
  });

  it("stays on sync when the durable store is unbound", () => {
    const env = boundEnv();
    delete (env as Record<string, unknown>).AGENT_DB;
    const decision = nlqScanDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/bindings are not configured/i);
  });

  it("stays on sync when the workflow binding is absent or has no create", () => {
    const noBinding = boundEnv();
    delete (noBinding as Record<string, unknown>).JOB_PIPELINE_WORKFLOW;
    expect(
      nlqScanDispatchRoute({ broker: { broker: "etrade", mode: "paper" }, env: noBinding }).route,
    ).toBe("sync");
    const noCreate = boundEnv();
    (noCreate as unknown as Record<string, unknown>).JOB_PIPELINE_WORKFLOW = {};
    expect(
      nlqScanDispatchRoute({ broker: { broker: "etrade", mode: "paper" }, env: noCreate }).route,
    ).toBe("sync");
  });
});

describe("scan leg through the host (#4469)", () => {
  it("dispatches through the host seam, stamps the broker pair, completes through the real flow, and publishes one boundary message per stage", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const { sent, queue } = recordingQueue();
    const deps = flowDeps(stores, runRecorder, env, { queue });
    const broker = discoveryBrokerStageInput("etrade", env, undefined);
    expect(broker).toEqual({ broker: "etrade", mode: "paper" });
    const runId = `nlq-scan:${crypto.randomUUID()}`;
    const created: Array<{ jobId: string; trigger: string }> = [];

    const result = await runNlqScanViaHost({
      env,
      request: scanEnvelope(runId),
      runId,
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
          return { instanceId: "wf-4469-1" };
        },
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].jobId).toBe(`strategy-screen:${runId}`);
    expect(created[0].trigger).toBe("manual");
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    expect(definition).not.toBeNull();
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "scan-cutover:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    const classInput = (stored as { classInput?: Record<string, unknown> })?.classInput;
    // The scan envelope travels verbatim, plus the pair.
    expect(classInput?.scan).toMatchObject({ symbols: ["AAPL"] });
    expect(classInput?.requestRecord).toMatchObject({ symbols: ["AAPL"] });
    // The scan leg is symbol-scoped: no universe input travels.
    expect(classInput && "universeDeps" in classInput).toBe(false);
    const readBack = await readOptionsWorkflowRun({ stores, runRecorder }, created[0].jobId);
    expect(readBack.state).toBe("completed");
    expect(readBack.stages.map((stage) => stage.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const stage of readBack.stages) {
      expect(stage.status).toBe("completed");
    }
    expect(readBack.shapeReport).toBeDefined();
    // One boundary message per stage, through the #4453 queue wiring.
    const messages = sent as Array<{
      runId: string;
      family?: string;
      stageId: string;
      artifactKeys: string[];
      userLogin: string;
      idempotencyKey: string;
    }>;
    expect(messages.map((message) => message.stageId)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const message of messages) {
      expect(message.runId).toBe(runId);
      expect(message.family).toBe("options");
      expect(message.userLogin).toBe(USER);
      expect(message.artifactKeys.length).toBeGreaterThan(0);
      expect(message.idempotencyKey).toBe(`${runId}::options::${message.stageId}`);
    }
    // The residency's persist stage degrades by name (#4453): the
    // stage artifact is the record, and no receipt fields ride.
    const storage = optionsStageStorageFromArtifacts(stores.artifacts, readBack.engineRunId);
    const persist = await storage.get<{ saved: boolean; reason?: string }>(
      optionsArtifactKey(runId, "persistCanonicalResults"),
    );
    expect(persist?.saved).toBe(false);
    expect(persist?.reason).toMatch(/no scan run store bound/);
    expect(result.matrix).toBeDefined();
    expect("persisted" in result).toBe(false);
    expect(result.scanRunId).toBeUndefined();
  });

  it("the stored descriptor replaces the provenance stamp: the stamp names the broker, the pair names the chains", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    // The envelope carries the #3327 string stamp; the seam stamps the
    // descriptor over it, so the resolving step decodes a pair, never
    // a string (a string would refuse as stage_request_unrecognized).
    const broker = discoveryBrokerStageInput("alpaca", env, undefined);
    expect(broker?.broker).toBe("alpaca");
    const runId = `nlq-scan:${crypto.randomUUID()}`;
    const created: string[] = [];
    await runNlqScanViaHost({
      env,
      request: scanEnvelope(runId, "alpaca"),
      runId,
      userLogin: USER,
      broker: broker!,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          created.push(jobId);
          const journal = recordingJournal();
          const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          expect(outcome.state).toBe("completed");
          return { instanceId: "wf-4469-2" };
        },
      },
    });
    expect(created).toHaveLength(1);
    const definition = await stores.definitions.getDefinition(created[0]);
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "scan-cutover:2")).toEqual(broker);
  });

  it("host-vs-sync equality: the same envelope scans identically on either dispatch, and both persist", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const broker = discoveryBrokerStageInput("etrade", env, undefined)!;

    // Sync: the unchanged in-process dispatch, scanner ports + store.
    const syncRunId = `nlq-scan:${crypto.randomUUID()}`;
    const syncStorage = memoryStageStorage();
    const syncStore = new InMemoryScanRunStore();
    const syncOutcome = await runStrategyScreenViaEngine(
      { runId: syncRunId, userLogin: USER, trigger: "manual", request: scanEnvelope(syncRunId) },
      {
        stages: createScannerScreenPorts({
          agents: createStrategyScreenAgents(undefined),
          storage: syncStorage,
          scanRunStore: syncStore,
        }),
        claims: memoryStageClaims(),
        queue: null,
      },
    );
    expect(syncOutcome.outcome).toBe("completed");
    const syncResult = await syncStorage.get<
      OpportunityScanResult & { scanRunId?: string; persisted?: boolean }
    >(optionsArtifactKey(syncRunId, "shapeReport"));
    expect(syncResult).toBeDefined();
    expect(syncResult?.persisted).toBe(true);
    expect(syncResult?.scanRunId).toBeDefined();

    // Host: the same envelope through the seam + flow + host-side save.
    const hostRunId = `nlq-scan:${crypto.randomUUID()}`;
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const hostStore = new InMemoryScanRunStore();
    const hostResult = await runNlqScanViaHost({
      env,
      request: scanEnvelope(hostRunId),
      runId: hostRunId,
      userLogin: USER,
      broker,
      scanRunStore: hostStore,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          const outcome = await runJobPipelineWorkflowFlow(deps, journal.step, {
            jobId,
            trigger: params.trigger,
          });
          expect(outcome.state).toBe("completed");
          return { instanceId: "wf-4469-3" };
        },
      },
    });
    expect(hostResult.persisted).toBe(true);
    expect(hostResult.scanRunId).toBeDefined();
    // The scan content is identical across the dispatch move; only
    // the minted receipt ids differ, the wall-clock stamp differs
    // per run, and the durable path's artifact serialization drops
    // undefined-valued keys the in-memory path keeps (a semantic
    // no-op: absent reads exactly as undefined).
    const normalize = (value: Record<string, unknown>) => {
      const { scanRunId: _id, persisted: _persisted, generatedAt: _at, ...rest } = value;
      return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
    };
    expect(normalize(hostResult as unknown as Record<string, unknown>)).toEqual(
      normalize(syncResult as unknown as Record<string, unknown>),
    );
    // Both runs persisted exactly one row each, scoped to the login.
    expect((await syncStore.list({ userLogin: USER })).length).toBe(1);
    expect((await hostStore.list({ userLogin: USER })).length).toBe(1);
  });

  it("host-side persistence after settlement: the settled run saves with the pair's broker and the receipt rides the result", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const broker = discoveryBrokerStageInput("etrade", env, undefined)!;
    const inner = new InMemoryScanRunStore();
    const savedOptions: Array<Record<string, unknown>> = [];
    const recording: ScanRunStore = {
      ...inner,
      save: async (result, options) => {
        savedOptions.push({ ...(options ?? {}) });
        return inner.save(result, options);
      },
    } as ScanRunStore;
    const runId = `nlq-scan:${crypto.randomUUID()}`;
    const result = await runNlqScanViaHost({
      env,
      request: scanEnvelope(runId),
      runId,
      userLogin: USER,
      broker,
      scanRunStore: recording,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: params.trigger });
          return { instanceId: "wf-4469-4" };
        },
      },
    });
    expect(savedOptions).toHaveLength(1);
    expect(savedOptions[0].broker).toBe("etrade");
    expect(savedOptions[0].userLogin).toBe(USER);
    expect(result.persisted).toBe(true);
    expect(result.scanRunId).toBeDefined();
    // The row is scoped to the saving login: the visibility rule
    // shows it only to a caller reading as that login.
    const saved = await inner.get(result.scanRunId!, { userLogin: USER });
    expect(saved).not.toBeNull();
  });

  it("a failing host-side save leaves the result intact, flagged persisted:false", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const broker = discoveryBrokerStageInput("etrade", env, undefined)!;
    const failing = {
      save: async (): Promise<never> => {
        throw new Error("store unavailable");
      },
    } as unknown as ScanRunStore;
    const runId = `nlq-scan:${crypto.randomUUID()}`;
    const result = await runNlqScanViaHost({
      env,
      request: scanEnvelope(runId),
      runId,
      userLogin: USER,
      broker,
      scanRunStore: failing,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: params.trigger });
          return { instanceId: "wf-4469-5" };
        },
      },
    });
    expect(result.matrix).toBeDefined();
    expect(result.persisted).toBe(false);
    expect(result.scanRunId).toBeUndefined();
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
      runNlqScanViaHost({
        env: boundEnv(),
        request: scanEnvelope("failed:1"),
        runId: "failed:1",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4469-failed" }),
          awaitOptions: { readRun: async () => failedView },
        },
      }),
    ).rejects.toThrow(/Options opportunity scan failed at screen: no chains for AAPL/);
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
      runNlqScanViaHost({
        env: boundEnv(),
        request: scanEnvelope("empty:1"),
        runId: "empty:1",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4469-empty" }),
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
      runNlqScanViaHost({
        env: boundEnv(),
        request: scanEnvelope("running:1"),
        runId: "running:1",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4469-running" }),
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

describe("gated-out scan runs stay on sync (#4469)", () => {
  it("with an unbound env the action stays on sync and matches the no-env run", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL"), MSFT: makeChain("MSFT") });
    const filters = {
      request: {
        thesis: "bullish",
        targetDate: targetDate(),
        expectedIvDirection: "unchanged",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
        minDte: 14,
        maxDte: 60,
        contractLimit: 500,
        candidateLimit: 10,
        maxStrikesPerSide: 12,
        maxIronCondors: 100,
        maxQuoteAgeSeconds: 60,
        eventPolicy: "warn",
      },
      riskProfile: "balanced",
      strategyFilter: {},
      thesisInferred: false,
      targetPriceInferred: false,
      scope: { kind: "symbols", symbols: ["AAPL", "MSFT"] },
    } as never;
    const fakeEtrade = () => ({
      client: new DynamicOptionsScreener(undefined),
      fetchQuoteRemote: async () => ({ lastPrice: 100 }),
      getWatchlists: async () => [],
      screenMarketsAsync: async () => ({ stocks: [] }),
    });
    const runAction = async (deps: Record<string, unknown>) => {
      const saved: unknown[] = [];
      const scanRunStore = {
        save: async (result: unknown) => {
          saved.push(result);
          return { id: "scan-1" };
        },
      };
      const res = await runOptionsStrategyAction(fakeEtrade() as never, "options_opportunities", filters, {
        userLogin: USER,
        scanRunStore: scanRunStore as never,
        ...deps,
      } as never);
      return { res, saved };
    };
    const withoutEnv = await runAction({});
    // An env with no residency bindings gates the leg onto the same
    // sync dispatch: the envelope, the rows, and the persisted row
    // are identical to the run with no env at all.
    const withUnboundEnv = await runAction({ env: {} as Env });
    expect(withUnboundEnv.res.status).toBe(withoutEnv.res.status);
    expect(withUnboundEnv.res.summary).toBe(withoutEnv.res.summary);
    expect(withUnboundEnv.res.rows).toEqual(withoutEnv.res.rows);
    // The persisted rows match except the per-run wall-clock stamp.
    const stripStamp = (rows: unknown[]) =>
      rows.map((row) => {
        const { generatedAt: _at, ...rest } = row as Record<string, unknown>;
        return rest;
      });
    expect(stripStamp(withUnboundEnv.saved)).toEqual(stripStamp(withoutEnv.saved));
  });
});

describe("scan-leg composition (#4469)", () => {
  it("runOpportunityScan derives the pair, gates, and dispatches through the host, keeping the sync call", () => {
    const source = readFileSync("src/agents/nlqOptionsStrategy.ts", "utf8");
    expect(source).toContain("discoveryBrokerStageInput(deps?.broker ?? defaultBrokerId()");
    expect(source).toContain("nlqScanDispatchRoute({");
    expect(source).toContain("runNlqScanViaHost({");
    expect(source).toContain("runStrategyScreenViaEngine(");
  });

  it("both production hosts thread the worker env into the strategy deps", () => {
    const execution = readFileSync("src/agents/nlq/execution.ts", "utf8");
    expect(execution).toContain("Issue #4469");
    const door = readFileSync("src/agents/orchestrator/meshOptionsStrategyDoor.ts", "utf8");
    expect(door).toContain("Issue #4469");
  });
});
