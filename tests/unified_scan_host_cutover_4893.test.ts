/**
 * Issue #4893 — the unified-scan cutover: the unified opportunities
 * action dispatches through the strategy workflow host, gated.
 *
 * The unified opportunities action (runUnifiedOpportunitiesViaPipeline
 * in etradeOptionsScreen.ts) dispatched a SCAN shape through the
 * OPTIONS job identity (runOptionsScreenViaEngine) — a genuinely
 * different cutover from the NLQ scan leg (#4469), which dispatches
 * through the strategy job identity. The job-identity decision for
 * this action is the strategy job: the strategy seam's own validation
 * names a scan shape a strategy screen, the resolving steps are shared
 * between both job identities (only the identity differs), and every
 * cutover leg rides the strategy identity. This slice moves the
 * action's dispatch onto startStrategyScreenWorkflow +
 * awaitOptionsWorkflowRun when the gate holds — the pair derives from
 * the tenant broker selection through the shared derivation and the
 * residency bindings are configured — and keeps the unchanged sync
 * dispatch otherwise.
 *
 * The residency binds no scan-run store (#4453 decided-not-to), so the
 * settled result saves after settlement through the caller's own
 * store, with the pair's broker and the platform run id when the run
 * carries one (the #4469 answer, adapted: the unified envelope
 * threads a platform run id the NLQ envelope never carries). Stage
 * messages publish through the #4453 queue wiring on both paths.
 *
 * These tests prove the gate, the derivation from the tenant
 * selection, the host dispatch through the real flow (the REAL broker
 * factory over the real registry, construction-only; the fixture
 * intercepts the screener's fetches), the queue publishing, the named
 * no-store degradation inside the residency, the host-side persistence
 * after settlement (including the platform run id), the failure modes,
 * host-vs-sync result equality, and the composition (the action
 * branches on the gate and keeps the sync call). No live runs; no real
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
import type { TenantBrokerSelectionRead } from "../src/services/providerConnections";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import {
  resolveUnifiedScanHostDispatch,
  runUnifiedScanViaHost,
  unifiedScanDispatchRoute,
} from "../src/services/unifiedScanHostDispatch";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { OpportunityScanResult } from "../src/trading";
import type { ETradeOptionChain, ETradeOptionExpireDate, Env } from "../src/types";
import { resolveChainSourceForRequest } from "../src/workflows/brokerChainSourceResidency";
import {
  optionsStageStorageFromArtifacts,
  runOptionsScreenViaEngine,
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
 * The unified envelope, as runUnifiedOpportunitiesViaPipeline
 * assembles it: the scan request (explicit symbols, the template,
 * the options), the replayable request record (#103), and the
 * platform run id (#1157 E2) when the run carries one.
 */
function unifiedEnvelope(runId: string, platformRunId?: string) {
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
      ...(platformRunId ? { platformRunId } : {}),
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

describe("unified scan dispatch gate (#4893)", () => {
  it("routes host when the pair derives and the residency bindings are configured", () => {
    const decision = unifiedScanDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env: boundEnv(),
    });
    expect(decision.route).toBe("host");
  });

  it("stays on sync when no pair derives", () => {
    const decision = unifiedScanDispatchRoute({ broker: null, env: boundEnv() });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/no broker stage input derives/);
  });

  it("stays on sync when the durable store is unbound", () => {
    const env = boundEnv();
    delete (env as Record<string, unknown>).AGENT_DB;
    const decision = unifiedScanDispatchRoute({
      broker: { broker: "etrade", mode: "paper" },
      env,
    });
    expect(decision.route).toBe("sync");
    expect(decision.reason).toMatch(/residency bindings are not configured/);
  });

  it("stays on sync when the workflow binding is absent or has no create", () => {
    const noBinding = boundEnv();
    delete (noBinding as Record<string, unknown>).JOB_PIPELINE_WORKFLOW;
    expect(
      unifiedScanDispatchRoute({ broker: { broker: "etrade", mode: "paper" }, env: noBinding })
        .route,
    ).toBe("sync");
    const noCreate = boundEnv({ JOB_PIPELINE_WORKFLOW: {} });
    expect(
      unifiedScanDispatchRoute({ broker: { broker: "etrade", mode: "paper" }, env: noCreate })
        .route,
    ).toBe("sync");
  });
});

describe("unified scan host derivation (#4893)", () => {
  const okReader =
    (brokerId: string) =>
    async (): Promise<TenantBrokerSelectionRead> =>
      ({ status: "ok", brokerId }) as TenantBrokerSelectionRead;

  it("derives the pair from the tenant selection with the requested env", async () => {
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const paper = await resolveUnifiedScanHostDispatch(env, undefined, okReader("etrade"));
    expect(paper.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(paper.decision.route).toBe("host");
    const live = await resolveUnifiedScanHostDispatch(env, "PROD", okReader("etrade"));
    expect(live.broker).toEqual({ broker: "etrade", mode: "live" });
    expect(live.decision.route).toBe("host");
  });

  it("derives a non-default broker pair from the selection", async () => {
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const derived = await resolveUnifiedScanHostDispatch(env, undefined, okReader("alpaca"));
    expect(derived.broker?.broker).toBe("alpaca");
    expect(derived.broker?.mode).toMatch(/^(paper|live)$/);
    expect(derived.decision.route).toBe("host");
  });

  it("stays on sync when the selection read fails, so the sync path throws the named error", async () => {
    const env = boundEnv();
    const unconfigured = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "unconfigured", error: "no broker selected" }),
    );
    expect(unconfigured.broker).toBeNull();
    expect(unconfigured.decision.route).toBe("sync");
    const unavailable = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "store_unavailable", error: "tenant store is not bound" }),
    );
    expect(unavailable.broker).toBeNull();
    expect(unavailable.decision.route).toBe("sync");
  });

  it("stays on sync when the selection names a broker the derivation does not know", async () => {
    const env = boundEnv();
    const derived = await resolveUnifiedScanHostDispatch(env, undefined, okReader("schwab"));
    expect(derived.broker).toBeNull();
    expect(derived.decision.route).toBe("sync");
  });

  it("stays on sync when the bindings are unconfigured even though the pair derives", async () => {
    // No bindings at all — only the environment marker, so the pair
    // derives deterministically (a bare env defaults to live in the
    // platform's own environment resolution).
    const env = { ETRADE_ENVIRONMENT: "sandbox" } as Env;
    const derived = await resolveUnifiedScanHostDispatch(env, undefined, okReader("etrade"));
    expect(derived.broker).toEqual({ broker: "etrade", mode: "paper" });
    expect(derived.decision.route).toBe("sync");
  });
});

describe("unified scan through the host (#4893)", () => {
  it("dispatches through the host seam, stamps the broker pair, completes through the real flow, and publishes one boundary message per stage", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const { sent, queue } = recordingQueue();
    const deps = flowDeps(stores, runRecorder, env, { queue });
    const { broker } = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );
    expect(broker).toEqual({ broker: "etrade", mode: "paper" });
    const runId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const created: Array<{ jobId: string; trigger: string }> = [];

    const result = await runUnifiedScanViaHost({
      env,
      request: unifiedEnvelope(runId),
      runId,
      userLogin: USER,
      broker: broker!,
      scanRunStore: new InMemoryScanRunStore(),
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
          return { instanceId: "wf-4893-1" };
        },
      },
    });

    expect(created).toHaveLength(1);
    // The job-identity decision: the strategy job, as in #4469.
    expect(created[0].jobId).toBe(`strategy-screen:${runId}`);
    expect(created[0].jobId).toBe(strategyScreenJobId(runId));
    expect(created[0].trigger).toBe("manual");
    const definition = await stores.definitions.getDefinition(created[0].jobId);
    expect(definition).not.toBeNull();
    const stored = (definition?.rawConfig as { request?: unknown })?.request;
    expect(decodeBrokerStageInput(stored, "unified-cutover:1")).toEqual({
      broker: "etrade",
      mode: "paper",
    });
    const classInput = (stored as { classInput?: Record<string, unknown> })?.classInput;
    // The unified envelope travels verbatim, plus the pair.
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
    // stage artifact is the record, and the host-side save below is
    // what persists the run.
    const storage = optionsStageStorageFromArtifacts(stores.artifacts, readBack.engineRunId);
    const persist = await storage.get<{ saved: boolean; reason?: string }>(
      optionsArtifactKey(runId, "persistCanonicalResults"),
    );
    expect(persist?.saved).toBe(false);
    expect(persist?.reason).toMatch(/no scan run store bound/);
    expect(result.matrix).toBeDefined();
    expect(result.persisted).toBe(true);
    expect(result.scanRunId).toBeDefined();
  });

  it("host-side persistence after settlement: the settled run saves with the pair's broker and the platform run id, and the receipt rides the result", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const { broker } = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );
    const inner = new InMemoryScanRunStore();
    const savedOptions: Array<Record<string, unknown>> = [];
    const recording: ScanRunStore = {
      ...inner,
      save: async (result, options) => {
        savedOptions.push({ ...(options ?? {}) });
        return inner.save(result, options);
      },
    } as ScanRunStore;
    const runId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const platformRunId = crypto.randomUUID();
    const result = await runUnifiedScanViaHost({
      env,
      request: unifiedEnvelope(runId, platformRunId),
      runId,
      userLogin: USER,
      broker: broker!,
      platformRunId,
      scanRunStore: recording,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: params.trigger });
          return { instanceId: "wf-4893-2" };
        },
      },
    });
    expect(savedOptions).toHaveLength(1);
    expect(savedOptions[0].broker).toBe("etrade");
    expect(savedOptions[0].userLogin).toBe(USER);
    // The #4893 adaptation: the platform run id threads to the save,
    // exactly as the sync persist stage saves under it — the row
    // keeps the platform identity the run was dispatched with.
    expect(savedOptions[0].id).toBe(platformRunId);
    expect(result.persisted).toBe(true);
    expect(result.scanRunId).toBe(platformRunId);
    const saved = await inner.get(result.scanRunId!, { userLogin: USER });
    expect(saved).not.toBeNull();
  });

  it("host-side persistence without a platform run id saves with no id, as the sync persist stage does", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const { broker } = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );
    const inner = new InMemoryScanRunStore();
    const savedOptions: Array<Record<string, unknown>> = [];
    const recording: ScanRunStore = {
      ...inner,
      save: async (result, options) => {
        savedOptions.push({ ...(options ?? {}) });
        return inner.save(result, options);
      },
    } as ScanRunStore;
    const runId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const result = await runUnifiedScanViaHost({
      env,
      request: unifiedEnvelope(runId),
      runId,
      userLogin: USER,
      broker: broker!,
      scanRunStore: recording,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: params.trigger });
          return { instanceId: "wf-4893-3" };
        },
      },
    });
    expect(savedOptions).toHaveLength(1);
    expect("id" in savedOptions[0]).toBe(false);
    expect(result.persisted).toBe(true);
    expect(result.scanRunId).toBeDefined();
  });

  it("a failing host-side save leaves the result intact, flagged persisted:false", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const { broker } = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );
    const failing = {
      save: async (): Promise<never> => {
        throw new Error("store unavailable");
      },
    } as unknown as ScanRunStore;
    const runId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const result = await runUnifiedScanViaHost({
      env,
      request: unifiedEnvelope(runId),
      runId,
      userLogin: USER,
      broker: broker!,
      scanRunStore: failing,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: params.trigger });
          return { instanceId: "wf-4893-4" };
        },
      },
    });
    expect(result.matrix).toBeDefined();
    expect(result.persisted).toBe(false);
    expect(result.scanRunId).toBeUndefined();
  });

  it("no scan-run store bound: the result carries no receipt fields at all", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { stores, runRecorder } = fakeStores();
    const deps = flowDeps(stores, runRecorder, env);
    const { broker } = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );
    const runId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const result = await runUnifiedScanViaHost({
      env,
      request: unifiedEnvelope(runId),
      runId,
      userLogin: USER,
      broker: broker!,
      seams: {
        stores,
        runRecorder,
        startWorkflow: async (jobId, params) => {
          const journal = recordingJournal();
          await runJobPipelineWorkflowFlow(deps, journal.step, { jobId, trigger: params.trigger });
          return { instanceId: "wf-4893-5" };
        },
      },
    });
    expect(result.matrix).toBeDefined();
    expect("persisted" in result).toBe(false);
    expect(result.scanRunId).toBeUndefined();
  });

  it("a failed run throws the sync failure shape, naming the stage and reason", async () => {
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
      runUnifiedScanViaHost({
        env: boundEnv(),
        request: unifiedEnvelope("failed:1"),
        runId: "failed:1",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4893-failed" }),
          awaitOptions: { readRun: async () => failedView },
        },
      }),
    ).rejects.toThrow(/Unified options scan failed at screen: no chains for AAPL/);
  });

  it("a run that completes without a report refuses to answer from nothing, in the sync words", async () => {
    const { stores, runRecorder } = fakeStores();
    const emptyView: OptionsWorkflowRunView = {
      jobId: "strategy-screen:empty:1",
      runId: "empty:1",
      state: "completed",
      engineRunId: "engine-1",
      stages: [],
    };
    await expect(
      runUnifiedScanViaHost({
        env: boundEnv(),
        request: unifiedEnvelope("empty:1"),
        runId: "empty:1",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4893-empty" }),
          awaitOptions: { readRun: async () => emptyView },
        },
      }),
    ).rejects.toThrow(
      "Unified options scan completed without a report artifact; refusing to answer from nothing.",
    );
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
      runUnifiedScanViaHost({
        env: boundEnv(),
        request: unifiedEnvelope("running:1"),
        runId: "running:1",
        userLogin: USER,
        broker: { broker: "etrade", mode: "paper" },
        seams: {
          stores,
          runRecorder,
          startWorkflow: async () => ({ instanceId: "wf-4893-running" }),
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

  it("host-vs-sync equality: the same envelope scans identically on either dispatch, both persist, and both publish one boundary message per stage", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ AAPL: makeChain("AAPL") });
    const env = boundEnv({ ETRADE_ENVIRONMENT: "sandbox" });
    const { broker } = await resolveUnifiedScanHostDispatch(
      env,
      undefined,
      async () => ({ status: "ok", brokerId: "etrade" }),
    );

    // Sync: the unchanged in-process dispatch, scanner ports + store + queue.
    const syncRunId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const syncStorage = memoryStageStorage();
    const syncStore = new InMemoryScanRunStore();
    const { sent: syncSent, queue: syncQueue } = recordingQueue();
    const syncOutcome = await runOptionsScreenViaEngine(
      { runId: syncRunId, userLogin: USER, trigger: "manual", request: unifiedEnvelope(syncRunId) },
      {
        stages: createScannerScreenPorts({
          agents: createStrategyScreenAgents(undefined),
          storage: syncStorage,
          scanRunStore: syncStore,
        }),
        claims: memoryStageClaims(),
        queue: syncQueue,
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
    const hostRunId = `options_scanner:unified:${new Date().toISOString()}:mixed`;
    const { stores, runRecorder } = fakeStores();
    const { sent: hostSent, queue: hostQueue } = recordingQueue();
    const deps = flowDeps(stores, runRecorder, env, { queue: hostQueue });
    const hostStore = new InMemoryScanRunStore();
    const hostResult = await runUnifiedScanViaHost({
      env,
      request: unifiedEnvelope(hostRunId),
      runId: hostRunId,
      userLogin: USER,
      broker: broker!,
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
          return { instanceId: "wf-4893-6" };
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
    // Both paths publish one boundary message per stage through the
    // same queue wiring, with the same shape.
    const stageIds = (sent: unknown[]) =>
      (sent as Array<{ stageId: string }>).map((message) => message.stageId);
    expect(stageIds(syncSent)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    expect(stageIds(hostSent)).toEqual([...OPTIONS_PIPELINE_STAGES]);
    for (const message of hostSent as Array<{
      family?: string;
      userLogin: string;
      idempotencyKey: string;
      stageId: string;
    }>) {
      expect(message.family).toBe("options");
      expect(message.userLogin).toBe(USER);
      expect(message.idempotencyKey).toBe(`${hostRunId}::options::${message.stageId}`);
    }
  });
});

describe("unified-scan composition (#4893)", () => {
  it("the action derives the pair from the tenant selection, gates, and dispatches through the host, keeping the sync call", () => {
    const source = readFileSync("src/agents/routes/etradeOptionsScreen.ts", "utf8");
    expect(source).toContain("resolveUnifiedScanHostDispatch(ctx.env, ctx.requestedEnv)");
    expect(source).toContain("runUnifiedScanViaHost({");
    expect(source).toContain("runOptionsScreenViaEngine(");
    // The sync failure shape and the sync read-back stay verbatim.
    expect(source).toContain("Unified options scan failed at ${outcome.failedStage}");
    expect(source).toContain('optionsArtifactKey(runId, "shapeReport")');
  });

  it("the host dispatch module names no provider, so the neutrality census needs no new row", () => {
    const source = readFileSync("src/services/unifiedScanHostDispatch.ts", "utf8");
    for (const term of ["etrade", "e-trade", "e*trade", "alpaca", "nasdaq", "yahoo", "tasty"]) {
      expect(source.toLowerCase()).not.toContain(term);
    }
  });
});
